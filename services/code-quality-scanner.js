'use strict';

const path     = require('path');
const { execFile } = require('child_process');
const chokidar = require('chokidar');

// Added lines in diffs that match these are TODO debt
const TODO_RE = /^\+\s*(?:\/\/|#|\/\*)\s*(TODO|FIXME|HACK|XXX)\b/i;

// Added lines that are console.* calls (not in comments)
const CONSOLE_RE = /^\+[^/]*\bconsole\.(log|warn|error|debug|info)\s*\(/;

// Files to skip entirely
const SKIP_EXTENSIONS = new Set([
  '.md', '.lock', '.txt', '.json', '.yaml', '.yml',
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg',
  '.woff', '.woff2', '.map',
]);
const SKIP_FILENAMES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);

// Test files — skip console.log checks here (intentional in tests)
const TEST_FILE_RE = /(?:\.test\.|\.spec\.|__tests__|[/\\]tests?[/\\])/i;

// Minimum counts to bother Alfred
const TODO_THRESHOLD    = 3;
const CONSOLE_THRESHOLD = 3;

class CodeQualityScanner {
  constructor() {
    this.watchers        = new Map(); // projectId → chokidar watcher
    this.lastScannedHash = new Map(); // projectId → git hash string
    this.onFindingsFound = null;      // (projectId, findings) => void
  }

  watchProject(projectId, repoPath) {
    const watchPath = path.join(repoPath, '.git', 'COMMIT_EDITMSG');

    const watcher = chokidar.watch(watchPath, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });

    watcher.on('change', () => this._check(projectId, repoPath));
    this.watchers.set(projectId, watcher);
  }

  async _check(projectId, repoPath) {
    const hash = await this._getHeadHash(repoPath);
    if (!hash) return;
    if (this.lastScannedHash.get(projectId) === hash) return;
    this.lastScannedHash.set(projectId, hash);

    console.log(`[CodeQualityScanner] Scanning commit ${hash.slice(0, 7)} for project ${projectId}`);
    const diff = await this._getDiff(repoPath, hash);
    if (!diff) return;

    const findings = this._scanDiff(diff);
    if (findings.length > 0 && this.onFindingsFound) {
      console.log(`[CodeQualityScanner] ${findings.map(f => `${f.count} ${f.type}`).join(', ')} in ${hash.slice(0, 7)}`);
      this.onFindingsFound(projectId, findings);
    }
  }

  _getHeadHash(repoPath) {
    return new Promise(resolve => {
      execFile('git', ['rev-parse', 'HEAD'], { cwd: repoPath, timeout: 5000 }, (err, stdout) => {
        resolve(err ? null : stdout.trim());
      });
    });
  }

  _getDiff(repoPath, hash) {
    return new Promise(resolve => {
      execFile(
        'git', ['show', '-p', '--no-color', hash],
        { cwd: repoPath, timeout: 15000, maxBuffer: 5 * 1024 * 1024 },
        (err, stdout) => resolve(err ? null : stdout)
      );
    });
  }

  _scanDiff(diff) {
    let currentFile = null;
    let isTestFile  = false;

    const todos    = []; // { file, text }
    const consoleLogs = []; // { file, text }

    for (const line of diff.split('\n')) {
      // Track current file
      if (line.startsWith('+++ b/')) {
        currentFile = line.slice(6);
        const basename = path.basename(currentFile);
        const ext = path.extname(currentFile).toLowerCase();
        isTestFile = TEST_FILE_RE.test(currentFile);
        if (SKIP_FILENAMES.has(basename) || SKIP_EXTENSIONS.has(ext)) {
          currentFile = null; // skip this file entirely
        }
        continue;
      }

      if (!currentFile) continue;
      if (!line.startsWith('+') || line.startsWith('+++')) continue;

      // TODO / FIXME / HACK
      if (TODO_RE.test(line)) {
        todos.push({ file: currentFile, text: line.slice(1).trim().slice(0, 80) });
      }

      // console.* — skip test files
      if (!isTestFile && CONSOLE_RE.test(line)) {
        consoleLogs.push({ file: currentFile, text: line.slice(1).trim().slice(0, 80) });
      }
    }

    const findings = [];

    if (todos.length >= TODO_THRESHOLD) {
      findings.push({
        type: 'todo',
        count: todos.length,
        examples: todos.slice(0, 3),
      });
    }

    if (consoleLogs.length >= CONSOLE_THRESHOLD) {
      findings.push({
        type: 'console_log',
        count: consoleLogs.length,
        examples: consoleLogs.slice(0, 3),
      });
    }

    return findings;
  }

  stopWatching(projectId) {
    this.watchers.get(projectId)?.close();
    this.watchers.delete(projectId);
  }

  stopAll() {
    for (const projectId of this.watchers.keys()) {
      this.stopWatching(projectId);
    }
  }
}

module.exports = CodeQualityScanner;
