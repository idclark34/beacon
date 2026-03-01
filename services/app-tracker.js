'use strict';

const { exec } = require('child_process');

const POLL_INTERVAL_MS = 15 * 1000; // 15 seconds

// System daemons that aren't useful context
const IGNORED_APPS = new Set([
  'SystemUIServer', 'Dock', 'loginwindow', 'WindowServer',
  'universalaccessd', 'Notification Center', 'Control Center',
  'Spotlight', 'Alfred', 'Raycast',
]);

class AppTracker {
  constructor() {
    this.currentApp = null;
    this.sessionApps = new Map(); // app → total seconds active
    this._intervalId = null;
    this._lastPollTime = null;
  }

  start() {
    this._poll();
    this._intervalId = setInterval(() => this._poll(), POLL_INTERVAL_MS);
    console.log('[AppTracker] Started');
  }

  stop() {
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  _poll() {
    exec(
      `osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`,
      (err, stdout) => {
        if (err) return;
        const app = stdout.trim();
        if (!app || IGNORED_APPS.has(app)) return;

        const now = Date.now();

        // Credit elapsed time to whatever was active before this poll
        if (this._lastPollTime && this.currentApp) {
          const elapsed = (now - this._lastPollTime) / 1000;
          this.sessionApps.set(
            this.currentApp,
            (this.sessionApps.get(this.currentApp) || 0) + elapsed
          );
        }

        if (!this.sessionApps.has(app)) this.sessionApps.set(app, 0);
        this.currentApp = app;
        this._lastPollTime = now;
      }
    );
  }

  getCurrentApp() {
    return this.currentApp;
  }

  // Returns top N apps sorted by time spent, filtered to > 1 minute
  getSessionSummary(topN = 5) {
    return [...this.sessionApps.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([app, seconds]) => ({ app, minutes: Math.round(seconds / 60) }))
      .filter(({ minutes }) => minutes > 0);
  }
}

module.exports = AppTracker;
