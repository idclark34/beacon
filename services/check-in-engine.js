'use strict';

const path      = require('path');
const fs        = require('fs');
const { CODING_APPS, QUOTES } = require('./ai-character');
const CheckInTriggers         = require('./check-in-triggers');

// ── Constants ──────────────────────────────────────────────────────────────

const CHECK_POLL_MS        = 5 * 60 * 1000;
const ACTIVE_THRESHOLD_MIN = 30;
const IDLE_GATE_MIN        = 3;

const BAD_COMMIT_RE = /^(fix|fixes|fixed|bug fix|bugfix|hotfix|quick fix|wip|update|updates|updated|changes|changed|misc|stuff|work|progress|save|commit|test|testing|temp|tmp|asdf|asd|lol|ok|done|final|cleanup|refactor|minor|small|patch|tweak|tweaks|more|other|stuff|various|some fixes?|more fixes?|minor fixes?|small fixes?|quick fixes?)\.?$/i;

const SAFE_BRANCHES = new Set(['main', 'master', 'develop', 'dev', 'staging', 'production', 'release', 'HEAD']);
const BAD_BRANCH_RE = /(?:^|[-_/])(final|wip|temp|tmp|test|testing|fix|fixes|new|old|asdf|lol|work|misc|stuff|backup|copy|untitled|v\d+)(?:[-_/]|$)/i;

const CODE_EXTS = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs']);
const JS_EXTS   = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs']);
const TEST_FILE_RE = /(?:\.test\.|\.spec\.|__tests__|[/\\]tests?[/\\])/i;

// ── CheckInEngine — "when to say it" ──────────────────────────────────────
//
// Scheduling, gating and cooldown logic. All AI calls live in CheckInTriggers
// (_trigger* methods). _maybeShow* methods here only decide whether to fire,
// then delegate to the corresponding _trigger*.

class CheckInEngine extends CheckInTriggers {
  /**
   * @param {object} deps
   * @param {object}   deps.db
   * @param {object}   deps.aiCharacter
   * @param {object}   deps.appTracker
   * @param {object}   deps.activityTracker
   * @param {object}   deps.gitMonitor
   * @param {function} deps.getWindow
   * @param {function} deps.getActiveProjectId
   * @param {function} deps.showWindow
   * @param {function} deps.speak
   * @param {function} deps.stopSpeaking
   * @param {function} deps.shouldSpeak
   * @param {function} deps.captureFrame
   */
  constructor(deps) {
    super();
    this.db              = deps.db;
    this.ai              = deps.aiCharacter;
    this.appTracker      = deps.appTracker;
    this.activityTracker = deps.activityTracker;
    this.gitMonitor      = deps.gitMonitor;
    this._getWindow      = deps.getWindow;
    this._getProjectId   = deps.getActiveProjectId;
    this._showWindow     = deps.showWindow;
    this._speak          = deps.speak;
    this._stopSpeaking   = deps.stopSpeaking;
    this._shouldSpeak    = deps.shouldSpeak;
    this._captureFrame   = deps.captureFrame;

    this._timerId               = null;
    this._lastCodingAppSeen     = Date.now();
    this._recentlyObservedFiles = new Map();
    this._pendingCodeFix        = null;
    this._pendingRevert         = null;
    this._ticking               = false;
    this._speaking              = false;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start() {
    this._timerId = setInterval(() => this._tick(), CHECK_POLL_MS);
  }

  stop() {
    if (this._timerId) clearInterval(this._timerId);
    this._timerId = null;
  }

  // ── Public event hooks (wired up in main.js) ──────────────────────────────

  async onCommits(projectId, changedFiles = []) {
    await this._maybeShowTestGap(projectId, changedFiles);
    const project = this.db.getProject(projectId);
    if (project?.repo_path) {
      const last = this.db.getState('last_refactor_alert');
      if (!last || Date.now() - new Date(last) > 24 * 60 * 60 * 1000) {
        const dupe = await this._findRefactorOpportunity(project.repo_path, changedFiles);
        if (dupe) {
          this.db.setState('last_refactor_alert', new Date().toISOString());
          await this._triggerRefactorOpportunity(dupe);
          return;
        }
      }
    }
    this._scheduleCheckIn(1500);
  }

  async onHotFile(projectId, relativePath, absolutePath, saveCount) {
    if (projectId !== this._getProjectId() || !this._getWindow()) return;
    const last = this._recentlyObservedFiles.get(relativePath);
    if (last && Date.now() - last < 2 * 60 * 60 * 1000) return;
    this._recentlyObservedFiles.set(relativePath, Date.now());

    const obs = this._analyzeFile(absolutePath, relativePath, saveCount);

    if (obs?.type === 'thrashing') {
      await this._triggerThrashingObservation(relativePath, saveCount);
      return;
    }
    if (obs?.type === 'complexity') {
      await this._triggerComplexityWarning(relativePath, obs);
      return;
    }
    if (obs?.type === 'code_smell') {
      await this._triggerCodeSmellPattern(relativePath, obs.smell);
      return;
    }
    if (obs?.type === 'test_gap') {
      await this._triggerTestGapPerFile(relativePath, saveCount, obs.hasTestFile);
      return;
    }

    let content;
    try {
      const raw   = fs.readFileSync(absolutePath, 'utf8');
      const lines = raw.split('\n');
      content     = lines.slice(0, 120).join('\n');
      if (lines.length > 120) content += `\n... (${lines.length - 120} more lines)`;
    } catch { return; }
    await this._triggerFileObservation(relativePath, content, saveCount);
  }

  async onCodeQualityFindings(projectId, findings) {
    await this._triggerCodeQualityObservation(projectId, findings);
  }

  async onPromptComplete(projectId, repoPath, promptText) {
    try {
      const existing = JSON.parse(this.db.getState('recent_claude_prompts') || '[]');
      existing.unshift({ text: promptText.slice(0, 200), ts: new Date().toISOString() });
      this.db.setState('recent_claude_prompts', JSON.stringify(existing.slice(0, 6)));
    } catch {}

    if (projectId !== this._getProjectId() || !this._getWindow()) return;
    const last = this.db.getState('last_vibe_narration_time');
    if (last && (Date.now() - new Date(last)) < 8 * 60 * 1000) return;
    const diff = await this.ai._executeDiff(repoPath, 3);
    if (!diff || diff.startsWith('Error') || diff.trim() === 'STAT:\n\nDIFF:') return;
    this.db.setState('last_vibe_narration_time', new Date().toISOString());
    await this._triggerVibeNarration(projectId, promptText, diff);
  }

  async onClaudeSessionEnd(sessionMinutes, projectName, sessionStartMs) {
    const projectId = this._getProjectId();
    if (!this._getWindow() || !projectId) return;
    this.db.setState('last_claude_session_end_time', new Date().toISOString());
    const sessionStart  = new Date(sessionStartMs);
    const commitsDuring = this.db.getCommitCountSince(projectId, sessionStart);
    const activity      = this.db.getRecentActivity(projectId, Math.ceil(sessionMinutes / 60) + 1);
    const filesSaved    = activity.filter(
      a => a.event_type === 'file_save' && new Date(a.timestamp) >= sessionStart
    ).length;
    await this._triggerVibeWrapUp(sessionMinutes, projectName, commitsDuring, filesSaved);
  }

  // ── Timer tick ─────────────────────────────────────────────────────────────

  async _tick() {
    if (this._ticking) return;
    this._ticking = true;
    try {
      const projectId = this._getProjectId();
      if (!projectId || !this._getWindow()) return;

      if (await this._maybeShowInactivityReturn())    return;
      if (await this._maybeShowWeeklyRecap())         return;
      if (await this._maybeShowBrowserDistraction())  return;
      if (await this._maybeCommentOnMusic())          return;
      if (await this._maybeShowClaudeSessionComment()) return;
      if (await this._maybeShowUncommittedDrift())    return;
      if (await this._maybeShowCommitRoast())         return;
      if (await this._maybeShowBranchRoast())         return;
      if (await this._maybeShowDistractionReturn())   return;
      if (await this._maybeShowProjectSwitchWarning()) return;
      if (await this._maybeShowIntelDrop())           return;
      if (await this._maybeShowIntroCheckIn())        return;
      if (await this._maybeShowQuote())               return;

      const lastCheckIn   = this.db.getState('last_checkin_time');
      const since         = lastCheckIn ? new Date(lastCheckIn) : new Date(0);
      const activeMinutes = this.db.getActiveMinutesSince(projectId, since);

      if (activeMinutes >= ACTIVE_THRESHOLD_MIN) {
        const recentlyActive = this.activityTracker.isRecentlyActive(projectId, IDLE_GATE_MIN);
        if (!recentlyActive) {
          if (await this._maybeShowProgressNarrative()) return;
          await this.triggerCheckIn();
        }
      }
    } finally {
      this._ticking = false;
    }
  }

  _scheduleCheckIn(delayMs = 0) {
    setTimeout(() => this.triggerCheckIn(), delayMs);
  }

  _send(channel, ...args) {
    this._getWindow()?.webContents.send(channel, ...args);
  }

  // ── _maybeShow* — gating layer ────────────────────────────────────────────

  async _maybeShowIntroCheckIn() {
    const projectId = this._getProjectId();
    if (this.db.getState('intro_shown')) return false;
    const activeMinutes = this.db.getActiveMinutesSince(projectId, new Date(0));
    if (activeMinutes < 10) return false;

    this.db.setState('intro_shown', 'true');
    this.db.setState('last_checkin_time', new Date().toISOString());
    await this._triggerIntroCheckIn(projectId);
    return true;
  }

  async _maybeShowWeeklyRecap() {
    const projectId = this._getProjectId();
    const lastRecap = this.db.getState('last_recap_date');
    if (lastRecap) {
      const daysSince = (Date.now() - new Date(lastRecap)) / (1000 * 60 * 60 * 24);
      if (daysSince < 7) return false;
    }
    const weekSummary = this.db.getMultiDaySummary(projectId, 7);
    if (weekSummary.totalCommits === 0 && weekSummary.activeHours === 0) return false;

    this.db.setState('last_recap_date', new Date().toISOString());
    this.db.setState('last_checkin_time', new Date().toISOString());
    await this._triggerWeeklyRecap(projectId);
    return true;
  }

  async _maybeShowIntelDrop() {
    const projectId = this._getProjectId();
    const lastDrop  = this.db.getState('last_intel_drop_time');
    if (lastDrop && (Date.now() - new Date(lastDrop)) < 2 * 60 * 60 * 1000) return false;

    const items = this.db.getUnsurfacedFeedItems(7, 3);
    if (!items.length) return false;

    const isIdle = !this.activityTracker.isRecentlyActive(projectId, 3);
    if (!isIdle) return false;

    this.db.setState('last_intel_drop_time', new Date().toISOString());
    this.db.markFeedItemsSurfaced(items.map(i => i.id));
    await this._triggerIntelDrop(projectId, items);
    return true;
  }

  async _maybeShowInactivityReturn() {
    const lastActivity = this.db.getLastActivityTime();
    if (!lastActivity) return false;

    const now        = Date.now();
    const hoursSince = (now - new Date(lastActivity)) / (1000 * 60 * 60);
    if (hoursSince < 72) return false;

    const lastAlert = this.db.getState('last_inactivity_alert');
    if (lastAlert && new Date(lastAlert) > new Date(lastActivity)) return false;

    const daysSince = Math.floor(hoursSince / 24);
    this.db.setState('last_inactivity_alert', new Date().toISOString());
    await this._triggerInactivityReturn(daysSince);
    return true;
  }

  async _maybeShowBranchRoast() {
    const projectId = this._getProjectId();
    if (!projectId) return false;

    const branch = await this.gitMonitor.getCurrentBranch(projectId);
    if (!branch || !this._isBadBranchName(branch)) return false;

    const lastRoasted = this.db.getState('last_branch_roast');
    if (lastRoasted === branch) return false;

    const lastTime = this.db.getState('last_branch_roast_time');
    if (lastTime && (Date.now() - new Date(lastTime)) < 24 * 60 * 60 * 1000) return false;

    this.db.setState('last_branch_roast', branch);
    this.db.setState('last_branch_roast_time', new Date().toISOString());
    await this._triggerBranchRoast(projectId, branch);
    return true;
  }

  async _maybeShowCommitRoast() {
    const projectId = this._getProjectId();
    if (!projectId) return false;

    const lastRoastedTime = this.db.getState('last_commit_roast_time');
    if (lastRoastedTime && (Date.now() - new Date(lastRoastedTime)) < 4 * 60 * 60 * 1000) return false;

    const summary    = this.db.getActivitySummary(projectId, 2);
    const badMessage = this._findBadCommitMessage(summary?.subjects);
    if (!badMessage) return false;

    const lastRoasted = this.db.getState('last_commit_roast_message');
    if (lastRoasted === badMessage) return false;

    this.db.setState('last_commit_roast_message', badMessage);
    this.db.setState('last_commit_roast_time', new Date().toISOString());
    await this._triggerCommitRoast(projectId, badMessage);
    return true;
  }

  async _maybeShowClaudeSessionComment() {
    const projectId = this._getProjectId();
    if (!this.appTracker || !projectId) return false;
    const session = this.appTracker.getClaudeSession();
    if (!session || session.minutes < 30) return false;

    // Don't comment when Claude is working ON the active project — that's just work.
    const project = this.db.getProject(projectId);
    if (project?.repo_path && session.projectPath &&
        session.projectPath.startsWith(project.repo_path)) return false;

    const sessionKey = String(this.appTracker.claudeSessionStart);
    if (this.db.getState('last_claude_session_key') === sessionKey) return false;

    this.db.setState('last_claude_session_key', sessionKey);
    await this._triggerClaudeSessionComment(projectId, session);
    return true;
  }

  async _maybeShowBrowserDistraction() {
    const projectId = this._getProjectId();
    if (!this.appTracker) return false;
    const distraction = this.appTracker.getActiveDistraction(20);
    if (!distraction) return false;

    const last = this.db.getState('last_browser_distraction_alert');
    if (last && (Date.now() - new Date(last)) < 2 * 60 * 60 * 1000) return false;

    this.db.setState('last_browser_distraction_alert', new Date().toISOString());
    await this._triggerBrowserDistraction(projectId, distraction);
    return true;
  }

  async _maybeCommentOnMusic() {
    if (!this.appTracker) return false;
    const music = this.appTracker.getCurrentMusic();
    if (!music) return false;
    if (Date.now() - music.detectedAt < 5 * 60 * 1000) return false;

    const last = this.db.getState('last_music_comment');
    if (last && (Date.now() - new Date(last)) < 3 * 60 * 60 * 1000) return false;

    const lastDistraction = this.db.getState('last_browser_distraction_alert');
    if (lastDistraction && (Date.now() - new Date(lastDistraction)) < 2 * 60 * 60 * 1000) return false;

    if (Math.random() < 0.5) return false;

    const projectId = this._getProjectId();
    this.db.setState('last_music_comment', new Date().toISOString());
    await this._triggerMusicComment(projectId, music);
    return true;
  }

  async _maybeShowDistractionReturn() {
    if (!this.appTracker) return false;
    const currentApp = this.appTracker.getCurrentApp();
    if (!currentApp) return false;

    if (CODING_APPS.has(currentApp)) {
      const now        = Date.now();
      const gapMinutes = (now - this._lastCodingAppSeen) / 60000;
      this._lastCodingAppSeen = now;

      if (gapMinutes >= 360) {
        const lastAlert = this.db.getState('last_building_return_alert');
        if (lastAlert && (now - new Date(lastAlert)) < 6 * 60 * 60 * 1000) return false;
        this.db.setState('last_building_return_alert', new Date().toISOString());
        await this._triggerBuildingReturn(Math.round(gapMinutes / 60), currentApp);
        return true;
      }

      if (gapMinutes >= 60) {
        const lastAlert = this.db.getState('last_distraction_alert');
        if (lastAlert && (now - new Date(lastAlert)) < 2 * 60 * 60 * 1000) return false;
        if (Math.random() < 0.35) return false;
        await this._triggerDistractionReturn(Math.round(gapMinutes));
        this.db.setState('last_distraction_alert', new Date().toISOString());
        return true;
      }
    }
    return false;
  }

  async _maybeShowProjectSwitchWarning() {
    const now       = Date.now();
    const lastAlert = this.db.getState('last_project_switch_alert');
    if (lastAlert && (now - new Date(lastAlert)) < 4 * 60 * 60 * 1000) return false;

    const recentIds = this.db.getActiveProjectIds(4);
    if (recentIds.length >= 3) {
      const names = recentIds.map(id => this.db.getProject(id)?.name || `Project ${id}`);
      this.db.setState('last_project_switch_alert', new Date().toISOString());
      await this._triggerProjectSwitchWarning('session', names, null);
      return true;
    }

    const pattern  = this.db.getMultiProjectPattern(7);
    const noCommit = pattern.filter(p => p.commit_events === 0);
    if (noCommit.length >= 3 && noCommit.some(p => p.active_days >= 3)) {
      const daySpan = Math.max(...noCommit.map(p => p.active_days));
      const names   = noCommit.map(p => this.db.getProject(p.project_id)?.name || `Project ${p.project_id}`);
      this.db.setState('last_project_switch_alert', new Date().toISOString());
      await this._triggerProjectSwitchWarning('pattern', names, daySpan);
      return true;
    }
    return false;
  }

  async _maybeShowQuote() {
    const projectId = this._getProjectId();
    const today     = new Date().toISOString().split('T')[0];
    if (this.db.getState('last_quote_date') === today) return false;
    if (this.activityTracker.isRecentlyActive(projectId, 10)) return false;

    const lastIdx = parseInt(this.db.getState('last_quote_index') || '-1', 10);
    let idx = Math.floor(Math.random() * QUOTES.length);
    if (idx === lastIdx && QUOTES.length > 1) idx = (idx + 1) % QUOTES.length;

    this.db.setState('last_quote_date', today);
    this.db.setState('last_quote_index', String(idx));
    await this._triggerQuote(QUOTES[idx]);
    return true;
  }

  async _maybeShowProgressNarrative() {
    const projectId    = this._getProjectId();
    const lastProgress = this.db.getState('last_progress_date');
    if (lastProgress) {
      const daysSince = (Date.now() - new Date(lastProgress)) / (1000 * 60 * 60 * 24);
      if (daysSince < 3) return false;
    }
    const lastCheckIn = this.db.getState('last_checkin_time');
    const since       = lastCheckIn ? new Date(lastCheckIn) : new Date(0);
    if (this.db.getActiveMinutesSince(projectId, since) < 90) return false;

    this.db.setState('last_progress_date', new Date().toISOString());
    await this._triggerProgressNarrative();
    return true;
  }

  async _maybeShowUncommittedDrift() {
    const projectId = this._getProjectId();
    if (!this.appTracker || !projectId) return false;
    const session = this.appTracker.getClaudeSession();
    if (!session || session.minutes < 45) return false;

    const last = this.db.getState('last_uncommitted_drift_alert');
    if (last && (Date.now() - new Date(last)) < 2 * 60 * 60 * 1000) return false;

    const sessionStart = new Date(this.appTracker.claudeSessionStart);
    if (this.db.getCommitCountSince(projectId, sessionStart) > 0) return false;

    const activity  = this.db.getRecentActivity(projectId, Math.ceil(session.minutes / 60) + 1);
    const saveCount = activity.filter(
      a => a.event_type === 'file_save' && new Date(a.timestamp) >= sessionStart
    ).length;
    if (saveCount <= 20) return false;

    this.db.setState('last_uncommitted_drift_alert', new Date().toISOString());
    await this._triggerUncommittedDrift(projectId, {
      sessionMinutes: session.minutes,
      saveCount,
      projectName: session.projectName || 'unknown',
    });
    return true;
  }

  async _maybeShowTestGap(projectId, changedFiles = []) {
    if (!changedFiles.length) return;

    const claudeRecent = this.appTracker.getClaudeSession() ||
      (() => {
        const t = this.db.getState('last_claude_session_end_time');
        return t && Date.now() - new Date(t) < 30 * 60 * 1000;
      })();
    if (!claudeRecent) return;

    const last = this.db.getState('last_test_gap_alert');
    if (last && (Date.now() - new Date(last)) < 24 * 60 * 60 * 1000) return;

    const testFiles = changedFiles.filter(f => TEST_FILE_RE.test(f));
    const nonTest   = changedFiles.filter(f => !TEST_FILE_RE.test(f));
    if (testFiles.length > 0 || nonTest.length < 3) return;

    this.db.setState('last_test_gap_alert', new Date().toISOString());
    const project = this.db.getProject(projectId);
    await this._triggerTestGap(projectId, {
      nonTestCount: nonTest.length,
      projectName:  project?.name || 'unknown',
    });
  }

  // ── File analysis ─────────────────────────────────────────────────────────

  _analyzeFile(absolutePath, relativePath, saveCount) {
    const ext = path.extname(absolutePath).toLowerCase();
    if (!CODE_EXTS.has(ext)) return null;
    if (saveCount >= 8) return { type: 'thrashing' };

    let lines;
    try { lines = fs.readFileSync(absolutePath, 'utf8').split('\n'); }
    catch { return null; }

    const lineCount = lines.length;

    if (JS_EXTS.has(ext)) {
      const { longestFnLines, longestFnName } = this._analyzeLongestFunction(lines);
      if (lineCount > 300 || longestFnLines > 80) {
        return { type: 'complexity', lineCount, longestFnLines, longestFnName };
      }
      const smell = this._detectCodeSmell(lines);
      if (smell) return { type: 'code_smell', smell };
    }

    if (saveCount >= 6) {
      const hasTestFile = this._findTestFile(absolutePath);
      if (!hasTestFile) return { type: 'test_gap', hasTestFile: false };
    }

    return null;
  }

  _analyzeLongestFunction(lines) {
    const FN_RE = /(?:(?:async\s+)?function\s+(\w+)\s*\(|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?function)/;
    let maxLines = 0, maxName = null, fnStart = -1, fnName = '', depth = 0;

    for (let i = 0; i < lines.length; i++) {
      if (fnStart === -1) {
        const m = FN_RE.exec(lines[i]);
        if (m) { fnName = m[1] || m[2] || m[3] || 'anonymous'; fnStart = i; depth = 0; }
      }
      if (fnStart !== -1) {
        depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
        if (depth <= 0 && i > fnStart) {
          const len = i - fnStart;
          if (len > maxLines) { maxLines = len; maxName = fnName; }
          fnStart = -1;
        }
      }
    }
    return { longestFnLines: maxLines, longestFnName: maxName };
  }

  _detectCodeSmell(lines) {
    const src = lines.join('\n');

    const paramMatch = src.match(/(?:async\s+)?function\s+(\w+)\s*\(([^)]{70,})\)/);
    if (paramMatch) {
      const count = (paramMatch[2].match(/,/g) || []).length + 1;
      if (count >= 6) return `${paramMatch[1]} takes ${count} parameters`;
    }

    const elseIfs = (src.match(/\belse\s+if\s*\(/g) || []).length;
    if (elseIfs >= 4) return `${elseIfs + 1}-branch if/else chain`;

    const maxIndent = lines.reduce((max, l) => {
      const indent = (l.match(/^(\s+)/) || ['', ''])[1].length;
      return l.includes('=>') && indent > max ? indent : max;
    }, 0);
    if (maxIndent >= 16) return `callback nesting ${Math.floor(maxIndent / 4)} levels deep`;

    return null;
  }

  _findTestFile(absolutePath) {
    const dir  = path.dirname(absolutePath);
    const base = path.basename(absolutePath, path.extname(absolutePath));
    const ext  = path.extname(absolutePath);
    return [
      path.join(dir, `${base}.test${ext}`),
      path.join(dir, `${base}.spec${ext}`),
      path.join(dir, '__tests__', `${base}${ext}`),
    ].some(p => { try { return fs.existsSync(p); } catch { return false; } });
  }

  // ── Commit / branch helpers ───────────────────────────────────────────────

  _findBadCommitMessage(subjects) {
    return (subjects || []).find(s => BAD_COMMIT_RE.test(s.trim()));
  }

  _isBadBranchName(branch) {
    if (!branch || SAFE_BRANCHES.has(branch.toLowerCase())) return false;
    const parts = branch.split(/[-_/]/);
    if (parts.length > 1 && new Set(parts).size < parts.length) return true;
    if (/final/i.test(branch)) return true;
    return BAD_BRANCH_RE.test(branch);
  }
}

module.exports = CheckInEngine;
