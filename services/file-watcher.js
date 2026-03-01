'use strict';

const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs');

// Extensions to watch (skip binaries, git internals, node_modules, etc.)
const WATCH_EXTENSIONS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.html', '.css', '.scss', '.less', '.sass',
  '.json', '.yaml', '.yml', '.toml', '.env',
  '.md', '.txt', '.sh', '.bash', '.zsh',
  '.sql', '.graphql', '.proto',
  '.c', '.cpp', '.h', '.hpp',
]);

const IGNORE_PATTERNS = [
  /node_modules/,
  /\.git/,
  /dist\//,
  /build\//,
  /\.next\//,
  /\.nuxt\//,
  /__pycache__/,
  /\.pytest_cache/,
  /\.venv/,
  /venv\//,
  /\.DS_Store/,
];

class FileWatcher {
  constructor(database) {
    this.db = database;
    this.watchers = new Map(); // projectId → chokidar watcher
    this.recentSaves = new Map(); // projectId → count in current window
    this.activeProjectId = null;
    this.onProjectSwitch = null; // callback(projectId)
  }

  watchDirectory(projectId, dirPath) {
    if (this.watchers.has(projectId)) {
      this.stopWatching(projectId);
    }

    if (!fs.existsSync(dirPath)) {
      console.warn(`[FileWatcher] Directory does not exist: ${dirPath}`);
      return;
    }

    const watcher = chokidar.watch(dirPath, {
      ignored: (filePath) => {
        const basename = path.basename(filePath);
        if (basename.startsWith('.') && basename !== '.env') return true;
        if (IGNORE_PATTERNS.some(p => p.test(filePath))) return true;
        const ext = path.extname(filePath).toLowerCase();
        // Allow directories (ext = '') or known extensions
        if (ext && !WATCH_EXTENSIONS.has(ext)) return true;
        return false;
      },
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    watcher.on('change', (filePath) => {
      this._handleFileSave(projectId, filePath);
    });

    watcher.on('add', (filePath) => {
      this._handleFileSave(projectId, filePath);
    });

    watcher.on('error', (err) => {
      console.error(`[FileWatcher] Error watching ${dirPath}:`, err.message);
    });

    this.watchers.set(projectId, watcher);
    this.recentSaves.set(projectId, 0);
    console.log(`[FileWatcher] Watching directory for project ${projectId}: ${dirPath}`);
  }

  stopWatching(projectId) {
    const watcher = this.watchers.get(projectId);
    if (watcher) {
      watcher.close();
      this.watchers.delete(projectId);
      this.recentSaves.delete(projectId);
    }
  }

  stopAll() {
    for (const [projectId] of this.watchers) {
      this.stopWatching(projectId);
    }
  }

  _handleFileSave(projectId, filePath) {
    const relativePath = path.relative(
      this._getWatchedPath(projectId),
      filePath
    );

    // Log a file_save event (just extension and relative path — no content)
    const ext = path.extname(filePath);
    this.db.logActivity(projectId, 'file_save', {
      ext,
      path: relativePath.replace(/\\/g, '/'),
    });

    // Track saves per window for activity detection
    const current = this.recentSaves.get(projectId) || 0;
    this.recentSaves.set(projectId, current + 1);

    // If this is a different project than the currently active one, notify
    if (this.activeProjectId !== projectId) {
      this.activeProjectId = projectId;
      if (this.onProjectSwitch) {
        this.onProjectSwitch(projectId);
      }
    }
  }

  _getWatchedPath(projectId) {
    // Best effort — returns empty string if unknown
    const project = this.db.getProject(projectId);
    return project?.repo_path || '';
  }

  /**
   * Returns the number of file saves for a project since the last call,
   * then resets the counter.
   */
  drainSaveCount(projectId) {
    const count = this.recentSaves.get(projectId) || 0;
    this.recentSaves.set(projectId, 0);
    return count;
  }

  getActiveProjectId() {
    return this.activeProjectId;
  }
}

module.exports = FileWatcher;
