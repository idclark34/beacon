'use strict';

const fs        = require('fs');
const path      = require('path');
const { execFile } = require('child_process');
const chokidar  = require('chokidar');

const RATE_LIMIT_MS       = 60 * 60 * 1000;  // 1 hour between checks
const DEBOUNCE_MS         = 2000;
const STARTUP_DELAY_MS    = 10 * 1000;
const MAJOR_VERSION_GAP   = 2;

class DepMonitor {
  constructor() {
    this.watchers       = new Map();  // projectId → chokidar watcher
    this.debounceTimers = new Map();  // projectId → timer
    this.lastChecked    = new Map();  // projectId → Date
    this.onIssuesFound  = null;       // (projectId, issues) => void
  }

  watchProject(projectId, repoPath) {
    const pkgPath = path.join(repoPath, 'package.json');
    if (!fs.existsSync(pkgPath)) return;

    // Startup check after 10s delay
    setTimeout(() => this._maybeCheck(projectId, repoPath), STARTUP_DELAY_MS);

    const watcher = chokidar.watch(pkgPath, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });

    watcher.on('change', () => {
      clearTimeout(this.debounceTimers.get(projectId));
      this.debounceTimers.set(
        projectId,
        setTimeout(() => this._maybeCheck(projectId, repoPath), DEBOUNCE_MS)
      );
    });

    this.watchers.set(projectId, watcher);
  }

  _maybeCheck(projectId, repoPath) {
    const last = this.lastChecked.get(projectId);
    if (last && Date.now() - last < RATE_LIMIT_MS) return;

    this.lastChecked.set(projectId, Date.now());
    this._check(projectId, repoPath);
  }

  async _check(projectId, repoPath) {
    console.log(`[DepMonitor] Checking deps for project ${projectId}`);
    const issues = [];

    const auditData = await this._runNpm(['audit', '--json'], repoPath);
    if (auditData) {
      const vulns = auditData.vulnerabilities || {};
      for (const [name, info] of Object.entries(vulns)) {
        const sev = info.severity;
        if (sev === 'high' || sev === 'critical') {
          const via = info.via || [];
          const detail = via.find(v => typeof v === 'object' && v.title);
          const title = detail?.title || `${sev} vulnerability`;
          const fixVersion = info.fixAvailable?.version || null;
          const version = info.nodes?.[0]?.split('@').pop() || '';
          issues.push({
            type: 'vulnerability',
            package: name,
            version,
            severity: sev,
            title,
            fixVersion,
          });
        }
      }
    }

    const outdatedData = await this._runNpm(['outdated', '--json'], repoPath);
    if (outdatedData) {
      for (const [name, info] of Object.entries(outdatedData)) {
        const current = parseInt(info.current, 10);
        const latest  = parseInt(info.latest, 10);
        if (!isNaN(current) && !isNaN(latest) && latest - current >= MAJOR_VERSION_GAP) {
          issues.push({
            type: 'outdated',
            package: name,
            current: info.current,
            latest: info.latest,
            majorsBehind: latest - current,
          });
        }
      }
    }

    if (issues.length > 0 && this.onIssuesFound) {
      this.onIssuesFound(projectId, issues);
    }
  }

  _runNpm(args, cwd) {
    return new Promise((resolve) => {
      execFile('npm', args, { cwd, timeout: 30000 }, (err, stdout) => {
        // npm outdated exits non-zero when packages are outdated — ignore err, parse stdout
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve(null);
        }
      });
    });
  }

  stopWatching(projectId) {
    clearTimeout(this.debounceTimers.get(projectId));
    this.debounceTimers.delete(projectId);
    this.watchers.get(projectId)?.close();
    this.watchers.delete(projectId);
  }

  stopAll() {
    for (const projectId of this.watchers.keys()) {
      this.stopWatching(projectId);
    }
  }
}

module.exports = DepMonitor;
