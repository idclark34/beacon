'use strict';

const path     = require('path');
const { execFile } = require('child_process');
const chokidar = require('chokidar');

// Patterns ordered by severity — first match wins per line
const SECRET_PATTERNS = [
  { name: 'Private Key',       regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: 'AWS Access Key',    regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'AWS Secret Key',    regex: /aws_secret(?:_access)?_key\s*[=:]\s*["']?([A-Za-z0-9/+=]{40})/i },
  { name: 'Anthropic API Key', regex: /(sk-ant-[A-Za-z0-9\-_]{20,})/ },
  { name: 'OpenAI API Key',    regex: /\b(sk-[A-Za-z0-9]{32,})\b/ },
  { name: 'GitHub Token',      regex: /\b(gh[pousr]_[A-Za-z0-9]{36})\b/ },
  { name: 'GitHub PAT',        regex: /\b(github_pat_[A-Za-z0-9_]{40,})\b/ },
  { name: 'Stripe Live Key',   regex: /\b(sk_live_[A-Za-z0-9]{24,})\b/ },
  { name: 'Generic API Key',   regex: /(?:api_?key|apikey)\s*[=:]\s*["']?([A-Za-z0-9\-_]{20,})/i },
  { name: 'Generic Secret',    regex: /\bsecret(?:_key)?\s*[=:]\s*["']?([A-Za-z0-9\-_]{20,})/i },
  { name: 'Generic Password',  regex: /\b(?:password|passwd|pwd)\s*[=:]\s*["']?([^\s"'<]{10,})/i },
  { name: 'Bearer Token',      regex: /\bBearer\s+([A-Za-z0-9\-._~+/]{20,}=*)/ },
];

// Files whose content is expected to contain placeholder/example values
const SKIP_FILENAMES = new Set(['.env.example', '.env.sample', 'package-lock.json', 'yarn.lock']);
const SKIP_EXTENSIONS = new Set(['.md', '.lock', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2']);

// Regex for values that are obviously placeholder text, not real secrets
const PLACEHOLDER_RE = /^(?:your[-_]?|example[-_]?|placeholder|xxx+|yyy+|zzz+|changeme|replace[-_]?me|todo|<[^>]+>|\.\.\.)/i;

class SecretScanner {
  constructor() {
    this.watchers        = new Map();  // projectId → chokidar watcher
    this.lastScannedHash = new Map();  // projectId → git hash string
    this.onSecretsFound  = null;       // (projectId, findings, shortHash) => void
  }

  watchProject(projectId, repoPath) {
    // Watch COMMIT_EDITMSG — git writes this file on every commit
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

    console.log(`[SecretScanner] Scanning commit ${hash.slice(0, 7)} for project ${projectId}`);
    const diff = await this._getDiff(repoPath, hash);
    if (!diff) return;

    const findings = this._scanDiff(diff);
    if (findings.length > 0 && this.onSecretsFound) {
      console.log(`[SecretScanner] ${findings.length} potential secret(s) in ${hash.slice(0, 7)}`);
      this.onSecretsFound(projectId, findings, hash.slice(0, 7));
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
    const findings = [];
    let currentFile = null;

    for (const line of diff.split('\n')) {
      // Track current file from diff header
      if (line.startsWith('+++ b/')) {
        currentFile = line.slice(6);
        continue;
      }

      // Only scan added lines; skip file-header lines
      if (!line.startsWith('+') || line.startsWith('+++')) continue;

      // Skip files we expect to contain placeholders or binary data
      if (currentFile) {
        const basename = path.basename(currentFile);
        const ext = path.extname(currentFile).toLowerCase();
        if (SKIP_FILENAMES.has(basename) || SKIP_EXTENSIONS.has(ext)) continue;
      }

      const content = line.slice(1); // strip leading "+"

      for (const { name, regex } of SECRET_PATTERNS) {
        const match = regex.exec(content);
        if (!match) continue;

        // Prefer a capture group (the actual value) over the full match
        const value = (match[1] || match[0]).trim();
        if (value.length < 8) continue;
        if (PLACEHOLDER_RE.test(value)) continue;

        findings.push({
          pattern: name,
          file: currentFile || 'unknown',
          preview: value.slice(0, 8) + '...',
        });
        break; // one finding per line is enough
      }
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

module.exports = SecretScanner;
