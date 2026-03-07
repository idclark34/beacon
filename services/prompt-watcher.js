'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// How long (ms) to wait after the last JSONL change before firing.
// Gives Claude time to finish its response and write all tool calls.
const SETTLE_MS = 40_000;

class PromptWatcher {
  constructor() {
    // projectId → { watcher, debounceTimer, lastPromptText, jsonlMtimes }
    this.projects = new Map();
    // Called with (projectId, repoPath, promptText) after Claude settles
    this.onPromptComplete = null;
  }

  // Convert an absolute repo path to the encoded dir name Claude Code uses.
  // e.g. /Users/ian/foo  →  -Users-ian-foo
  static encodeRepoPath(repoPath) {
    return repoPath.replace(/\//g, '-');
  }

  static claudeDir(repoPath) {
    return path.join(os.homedir(), '.claude', 'projects', PromptWatcher.encodeRepoPath(repoPath));
  }

  watchProject(projectId, repoPath) {
    if (this.projects.has(projectId)) return;

    const dir = PromptWatcher.claudeDir(repoPath);
    if (!fs.existsSync(dir)) return;

    // Use fs.watch on the directory — lightweight, no extra deps
    let fsWatcher;
    try {
      fsWatcher = fs.watch(dir, { persistent: false }, (eventType, filename) => {
        if (!filename || !filename.endsWith('.jsonl')) return;
        const fullPath = path.join(dir, filename);
        this._scheduleRead(projectId, repoPath, fullPath);
      });
    } catch (err) {
      console.warn(`[PromptWatcher] Could not watch ${dir}:`, err.message);
      return;
    }

    this.projects.set(projectId, {
      watcher: fsWatcher,
      debounceTimer: null,
      lastPromptText: null,
      repoPath,
    });

    console.log(`[PromptWatcher] Watching Claude Code sessions for project ${projectId}`);
  }

  _scheduleRead(projectId, repoPath, jsonlPath) {
    const state = this.projects.get(projectId);
    if (!state) return;

    // Reset debounce on every JSONL change
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      this._readLatestPrompt(projectId, repoPath, jsonlPath);
    }, SETTLE_MS);
  }

  _readLatestPrompt(projectId, repoPath, jsonlPath) {
    const state = this.projects.get(projectId);
    if (!state) return;

    let content;
    try { content = fs.readFileSync(jsonlPath, 'utf8'); } catch { return; }

    const lines = content.trim().split('\n').filter(l => l.trim());

    // Walk backwards to find the most recent user prompt (role: user, type: user)
    let latestPrompt = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry;
      try { entry = JSON.parse(lines[i]); } catch { continue; }

      if (entry.type !== 'user') continue;
      const msg = entry.message;
      if (!msg || msg.role !== 'user') continue;

      // Content can be a string or an array of blocks
      const raw = msg.content;
      let text = '';
      if (typeof raw === 'string') {
        text = raw;
      } else if (Array.isArray(raw)) {
        text = raw.filter(b => b.type === 'text').map(b => b.text).join(' ');
      }
      text = text.trim();

      // Skip very short or tool-result-only messages
      if (text.length < 8) continue;
      // Skip internal Claude Code system-ish messages
      if (text.startsWith('<') || text.startsWith('{')) continue;

      latestPrompt = { text, timestamp: entry.timestamp };
      break;
    }

    if (!latestPrompt) return;
    // Don't fire twice for the same prompt
    if (latestPrompt.text === state.lastPromptText) return;

    state.lastPromptText = latestPrompt.text;
    this.onPromptComplete?.(projectId, repoPath, latestPrompt.text);
  }

  stopProject(projectId) {
    const state = this.projects.get(projectId);
    if (!state) return;
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    try { state.watcher.close(); } catch {}
    this.projects.delete(projectId);
  }

  stopAll() {
    for (const [id] of this.projects) this.stopProject(id);
  }
}

module.exports = PromptWatcher;
