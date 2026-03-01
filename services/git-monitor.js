'use strict';

const { simpleGit } = require('simple-git');

const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const SIGNIFICANT_COMMIT_THRESHOLD = 5;

class GitMonitor {
  constructor(database) {
    this.db = database;
    this.watchers = new Map(); // projectId → { git, lastChecked, intervalId }
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

    this.watchers.set(projectId, { git, lastChecked, intervalId });
    console.log(`[GitMonitor] Watching repo for project ${projectId}: ${repoPath}`);
  }

  stopWatching(projectId) {
    const watcher = this.watchers.get(projectId);
    if (watcher) {
      clearInterval(watcher.intervalId);
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

      // Get commits since last check
      const sinceISO = since.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
      const log = await git.log({ '--since': sinceISO });

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

      const metadata = {
        count: commitCount,
        changedFiles: [...changedFiles].slice(0, 20), // cap for privacy/storage
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
   * Manually trigger a scan right now for a project.
   */
  async scanNow(projectId) {
    const watcher = this.watchers.get(projectId);
    if (!watcher) return;
    await this._scanRepo(projectId, watcher.git, watcher.lastChecked);
    watcher.lastChecked = new Date();
  }
}

module.exports = GitMonitor;
