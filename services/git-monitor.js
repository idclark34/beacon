'use strict';

const path     = require('path');
const fs       = require('fs');
const chokidar = require('chokidar');
const { simpleGit } = require('simple-git');

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes (fallback)
const SIGNIFICANT_COMMIT_THRESHOLD = 1;

class GitMonitor {
  constructor(database) {
    this.db = database;
    this.watchers  = new Map(); // projectId → { git, lastChecked, intervalId, fsWatcher }
    this.onSignificantEvent = null; // callback(projectId, commitCount)
  }

  /**
   * Start monitoring a git repo for a project.
   * Polls every 30 minutes and stores commit/file metadata in the DB.
   */
  watchRepo(projectId, repoPath) {
    if (this.watchers.has(projectId)) {
      this.stopWatching(projectId);
    }

    const git = simpleGit(repoPath);
    const lastChecked = new Date();

    // Initial scan
    this._scanRepo(projectId, git, lastChecked);

    const intervalId = setInterval(() => {
      const watcher = this.watchers.get(projectId);
      if (!watcher) return;
      this._scanRepo(projectId, watcher.git, watcher.lastChecked);
      watcher.lastChecked = new Date();
    }, POLL_INTERVAL_MS);

    // Watch COMMIT_EDITMSG for instant detection on every commit/push
    let fsWatcher = null;
    const commitMsgPath = path.join(repoPath, '.git', 'COMMIT_EDITMSG');
    if (fs.existsSync(path.dirname(commitMsgPath))) {
      fsWatcher = chokidar.watch(commitMsgPath, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 300 } });
      fsWatcher.on('change', () => {
        const w = this.watchers.get(projectId);
        if (!w) return;
        this._scanRepo(projectId, w.git, w.lastChecked);
        w.lastChecked = new Date();
      });
    }

    this.watchers.set(projectId, { git, lastChecked, intervalId, fsWatcher });
    console.log(`[GitMonitor] Watching repo for project ${projectId}: ${repoPath}`);
  }

  stopWatching(projectId) {
    const watcher = this.watchers.get(projectId);
    if (watcher) {
      clearInterval(watcher.intervalId);
      watcher.fsWatcher?.close();
      this.watchers.delete(projectId);
    }
  }

  stopAll() {
    for (const [projectId] of this.watchers) {
      this.stopWatching(projectId);
    }
  }

  async _scanRepo(projectId, git, since) {
    try {
      const isRepo = await git.checkIsRepo();
      if (!isRepo) {
        console.warn(`[GitMonitor] Project ${projectId}: not a git repo`);
        return;
      }

      // Get commits since last check — use Unix timestamp to avoid timezone issues
      const sinceUnix = Math.floor(since.getTime() / 1000);
      const log = await git.log({ '--since': String(sinceUnix) });
      console.log(`[GitMonitor] Project ${projectId}: scanning since ${since.toISOString()}, found ${log.all.length} commits`);

      if (!log.all.length) return;

      const commitCount = log.all.length;

      // Collect file paths changed (privacy: no commit messages stored)
      const changedFiles = new Set();
      for (const commit of log.all) {
        try {
          const diff = await git.show([
            '--stat',
            '--format=',
            commit.hash,
          ]);
          const lines = diff.split('\n');
          for (const line of lines) {
            const match = line.match(/^\s+(.+?)\s+\|/);
            if (match) {
              const filePath = match[1].trim();
              // Store path without leading repo root (relative only)
              changedFiles.add(filePath);
            }
          }
        } catch {
          // Some commits may not have diffs (merges, etc.)
        }
      }

      const subjects = log.all
        .map(c => (c.message || '').split('\n')[0].trim().slice(0, 80))
        .filter(s => s.length > 0);

      const metadata = {
        count: commitCount,
        changedFiles: [...changedFiles].slice(0, 20), // cap for privacy/storage
        subjects,
      };

      this.db.logActivity(projectId, 'commit', metadata);
      console.log(`[GitMonitor] Project ${projectId}: ${commitCount} new commit(s)`);

      // Notify if significant event
      if (commitCount >= SIGNIFICANT_COMMIT_THRESHOLD && this.onSignificantEvent) {
        this.onSignificantEvent(projectId, commitCount);
      }
    } catch (err) {
      console.error(`[GitMonitor] Error scanning repo for project ${projectId}:`, err.message);
    }
  }

  /**
   * Returns the current branch name for a project, or null.
   */
  async getCurrentBranch(projectId) {
    const watcher = this.watchers.get(projectId);
    if (!watcher) return null;
    try {
      const branch = await watcher.git.revparse(['--abbrev-ref', 'HEAD']);
      return branch.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Manually trigger a scan right now for a project.
   */
  async scanNow(projectId, hoursBack = 2) {
    const watcher = this.watchers.get(projectId);
    if (!watcher) return;
    const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
    await this._scanRepo(projectId, watcher.git, since);
    watcher.lastChecked = new Date();
  }
}

module.exports = GitMonitor;
