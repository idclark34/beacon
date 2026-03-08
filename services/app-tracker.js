'use strict';

const path = require('path');
const { exec } = require('child_process');

const POLL_INTERVAL_MS = 15 * 1000; // 15 seconds

// System daemons that aren't useful context
const IGNORED_APPS = new Set([
  'SystemUIServer', 'Dock', 'loginwindow', 'WindowServer',
  'universalaccessd', 'Notification Center', 'Control Center',
  'Spotlight', 'Alfred', 'Raycast',
]);

const DISTRACTION_DOMAINS = new Set([
  'youtube.com', 'reddit.com', 'twitter.com', 'x.com',
  'linkedin.com',
]);

class AppTracker {
  constructor() {
    this.currentApp = null;
    this.currentUrl = null;
    this.currentDomain = null;
    this._lastSafariDomain = null;
    this._lastSafariSeenAt = null;
    this.sessionApps = new Map(); // app → total seconds active
    this.domainTime = new Map();  // domain → total seconds active
    this._intervalId = null;
    this._lastPollTime = null;
    // Claude Code session
    this.claudeActive = false;
    this.claudeProjectPath = null;
    this.claudeProjectName = null;
    this.claudeSessionStart = null;
    this.onClaudeSessionEnd = null;
    // Music detection
    this.currentMusic = null; // { title, source, detectedAt }
  }

  start() {
    this._poll();
    this._pollClaude();
    this._pollMusic();
    this._intervalId = setInterval(() => {
      this._poll();
      this._pollClaude();
      this._pollMusic();
    }, POLL_INTERVAL_MS);
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
          // Credit domain time if we were on a distraction site
          if (this.currentDomain && DISTRACTION_DOMAINS.has(this.currentDomain)) {
            this.domainTime.set(
              this.currentDomain,
              (this.domainTime.get(this.currentDomain) || 0) + elapsed
            );
          }
        }

        if (!this.sessionApps.has(app)) this.sessionApps.set(app, 0);
        this.currentApp = app;
        this._lastPollTime = now;

        // If Safari is frontmost, grab the current URL
        if (app === 'Safari') {
          exec(
            `osascript -e 'tell application "Safari" to return URL of current tab of front window'`,
            (urlErr, urlOut) => {
              if (urlErr) { this.currentUrl = null; this.currentDomain = null; return; }
              const url = urlOut.trim();
              this.currentUrl = url || null;
              try {
                this.currentDomain = url ? new URL(url).hostname.replace(/^www\./, '') : null;
              } catch {
                this.currentDomain = null;
              }
              if (this.currentDomain) {
                this._lastSafariDomain = this.currentDomain;
                this._lastSafariSeenAt = Date.now();
              }
            }
          );
        }
      }
    );
  }

  getCurrentApp() {
    return this.currentApp;
  }

  getCurrentUrl() {
    return this.currentUrl;
  }

  // Returns the current domain, or the last Safari domain seen within 5 minutes
  getCurrentDomain() {
    if (this.currentDomain) return this.currentDomain;
    const STALE_MS = 5 * 60 * 1000;
    if (this._lastSafariDomain && this._lastSafariSeenAt && (Date.now() - this._lastSafariSeenAt) < STALE_MS) {
      return this._lastSafariDomain;
    }
    return null;
  }

  // Minutes spent on a specific domain this session
  getDomainMinutes(domain) {
    return Math.round((this.domainTime.get(domain) || 0) / 60);
  }

  // Returns the active distraction domain + minutes if over threshold, else null
  getActiveDistraction(thresholdMinutes = 20) {
    const domain = this.getCurrentDomain();
    if (!domain || !DISTRACTION_DOMAINS.has(domain)) return null;
    const minutes = this.getDomainMinutes(domain);
    if (minutes < thresholdMinutes) return null;
    return { domain, minutes };
  }

  _pollClaude() {
    exec('pgrep -x claude', (err, stdout) => {
      const pid = stdout?.trim().split('\n')[0];
      if (err || !pid) {
        if (this.claudeActive && this.claudeSessionStart) {
          const sessionMinutes = Math.round((Date.now() - this.claudeSessionStart) / 60000);
          const projectName = this.claudeProjectName;
          const sessionStartMs = this.claudeSessionStart;
          this.claudeActive = false; this.claudeProjectPath = null;
          this.claudeProjectName = null; this.claudeSessionStart = null;
          if (sessionMinutes >= 20 && this.onClaudeSessionEnd) {
            this.onClaudeSessionEnd(sessionMinutes, projectName, sessionStartMs);
          }
        } else {
          this.claudeActive = false; this.claudeProjectPath = null;
          this.claudeProjectName = null; this.claudeSessionStart = null;
        }
        return;
      }
      exec(
        `lsof -a -p ${pid} -d cwd -Fn 2>/dev/null | grep '^n' | cut -c2-`,
        (err2, cwdOut) => {
          const projectPath = cwdOut?.trim() || null;
          const projectName = projectPath ? path.basename(projectPath) : null;
          if (!this.claudeActive) this.claudeSessionStart = Date.now();
          this.claudeActive = true;
          this.claudeProjectPath = projectPath;
          this.claudeProjectName = projectName;
        }
      );
    });
  }

  // Returns current Claude Code session info, or null if not running
  getClaudeSession() {
    if (!this.claudeActive) return null;
    const minutes = this.claudeSessionStart
      ? Math.round((Date.now() - this.claudeSessionStart) / 60000)
      : 0;
    return {
      active: true,
      projectPath: this.claudeProjectPath,
      projectName: this.claudeProjectName,
      minutes,
    };
  }

  _pollMusic() {
    const script = `
      tell application "Safari"
        repeat with w in windows
          repeat with t in tabs of w
            set u to URL of t
            if u contains "youtube.com/watch" or u contains "music.youtube.com" then
              return (name of t) & "|||" & u
            end if
          end repeat
        end repeat
        return ""
      end tell
    `;
    exec(`osascript -e '${script}'`, (err, stdout) => {
      if (err) return;
      const raw = stdout.trim();
      if (!raw) { this.currentMusic = null; return; }
      const [tabTitle, url] = raw.split('|||');
      if (!url) { this.currentMusic = null; return; }
      const source = url.includes('music.youtube.com') ? 'YouTube Music' : 'YouTube';
      const title = tabTitle
        .replace(/ - YouTube Music$/, '')
        .replace(/ - YouTube$/, '')
        .trim();
      if (!title) { this.currentMusic = null; return; }
      // Only update detectedAt if track changed
      if (!this.currentMusic || this.currentMusic.title !== title) {
        this.currentMusic = { title, source, detectedAt: Date.now() };
      }
    });
  }

  getCurrentMusic() { return this.currentMusic; }

  // Returns top N apps sorted by time spent, filtered to > 1 minute
  getSessionSummary(topN = 5) {
    return [...this.sessionApps.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([app, seconds]) => ({ app, minutes: Math.round(seconds / 60) }))
      .filter(({ minutes }) => minutes > 0);
  }
}

module.exports.DISTRACTION_DOMAINS = DISTRACTION_DOMAINS;

module.exports = AppTracker;
