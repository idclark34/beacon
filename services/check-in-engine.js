'use strict';

const path      = require('path');
const fs        = require('fs');
const { execFile } = require('child_process');
const { CODING_APPS, QUOTES } = require('./ai-character');

// ── Constants ──────────────────────────────────────────────────────────────

const CHECK_POLL_MS        = 5 * 60 * 1000;
const ACTIVE_THRESHOLD_MIN = 30;
const IDLE_GATE_MIN        = 3;

const BAD_COMMIT_RE = /^(fix|fixes|fixed|bug fix|bugfix|hotfix|quick fix|wip|update|updates|updated|changes|changed|misc|stuff|work|progress|save|commit|test|testing|temp|tmp|asdf|asd|lol|ok|done|final|cleanup|refactor|minor|small|patch|tweak|tweaks|more|other|stuff|various|some fixes?|more fixes?|minor fixes?|small fixes?|quick fixes?)\.?$/i;

const SAFE_BRANCHES = new Set(['main', 'master', 'develop', 'dev', 'staging', 'production', 'release', 'HEAD']);
const BAD_BRANCH_RE = /(?:^|[-_/])(final|wip|temp|tmp|test|testing|fix|fixes|new|old|asdf|lol|work|misc|stuff|backup|copy|untitled|v\d+)(?:[-_/]|$)/i;

const CODE_EXTS    = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.py', '.rb', '.go', '.rs']);
const JS_EXTS      = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs']);
const TEST_FILE_RE = /(?:\.test\.|\.spec\.|__tests__|[/\\]tests?[/\\])/i;

const QUALITY_PATTERNS = {
  console_log: /^\s*console\.(log|warn|error|debug|info)\s*\(/,
  todo:        /^\s*(\/\/|#)\s*(TODO|FIXME|HACK|XXX)\b/i,
};

// ── CheckInEngine ──────────────────────────────────────────────────────────

class CheckInEngine {
  /**
   * @param {object} deps
   * @param {object}   deps.db
   * @param {object}   deps.aiCharacter
   * @param {object}   deps.appTracker
   * @param {object}   deps.activityTracker
   * @param {object}   deps.gitMonitor
   * @param {function} deps.getWindow           — () => BrowserWindow|null
   * @param {function} deps.getActiveProjectId  — () => number|null
   * @param {function} deps.showWindow
   * @param {function} deps.speak               — (text) => void
   * @param {function} deps.stopSpeaking        — () => void
   * @param {function} deps.shouldSpeak         — () => Promise<boolean>
   * @param {function} deps.captureFrame        — () => Promise<string|null>
   */
  constructor(deps) {
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
    this._recentlyObservedFiles = new Map(); // relativePath → last observation timestamp
    this._pendingCodeFix        = null;      // { projectId, findings }
    this._pendingRevert         = null;      // { repoPath, files }
    this._ticking               = false;     // concurrency lock for _tick
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

  /** Called by gitMonitor.onSignificantEvent */
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

  /** Called by fileWatcher.onHotFile */
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
      const raw = fs.readFileSync(absolutePath, 'utf8');
      const lines = raw.split('\n');
      content = lines.slice(0, 120).join('\n');
      if (lines.length > 120) content += `\n... (${lines.length - 120} more lines)`;
    } catch { return; }
    await this._triggerFileObservation(relativePath, content, saveCount);
  }

  /** Called by codeQualityScanner.onFindingsFound */
  async onCodeQualityFindings(projectId, findings) {
    await this._triggerCodeQualityObservation(projectId, findings);
  }

  /** Called by promptWatcher.onPromptComplete */
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

  /** Called by appTracker.onClaudeSessionEnd */
  async onClaudeSessionEnd(sessionMinutes, projectName, sessionStartMs) {
    const projectId = this._getProjectId();
    if (!this._getWindow() || !projectId) return;
    this.db.setState('last_claude_session_end_time', new Date().toISOString());
    const sessionStart    = new Date(sessionStartMs);
    const commitsDuring   = this.db.getCommitCountSince(projectId, sessionStart);
    const activity        = this.db.getRecentActivity(projectId, Math.ceil(sessionMinutes / 60) + 1);
    const filesSaved      = activity.filter(
      a => a.event_type === 'file_save' && new Date(a.timestamp) >= sessionStart
    ).length;
    await this._triggerVibeWrapUp(sessionMinutes, projectName, commitsDuring, filesSaved);
  }

  /** Called by setupIPC trigger-action handler */
  async handleAction(actionId) {
    if (actionId === 'fix-code-quality' && this._pendingCodeFix) {
      const fix = this._pendingCodeFix;
      this._pendingCodeFix = null;
      await this._proposeCodeQualityFix(fix);
    }
    if (actionId === 'revert-code-quality' && this._pendingRevert) {
      const rv = this._pendingRevert;
      this._pendingRevert = null;
      // Check for uncommitted changes in target files beyond what Outpost removed
      execFile('git', ['status', '--porcelain', ...rv.files], { cwd: rv.repoPath, timeout: 5000 }, (statusErr, statusOut) => {
        const dirtyLines = (statusOut || '').trim().split('\n').filter(Boolean);
        const hasExtraChanges = dirtyLines.some(l => !l.startsWith(' D') && !l.startsWith('D '));
        if (hasExtraChanges && !statusErr) {
          this._send('action-result', { message: 'Warning: files have other uncommitted changes — revert skipped to avoid data loss. Use git manually.' });
          return;
        }
        execFile('git', ['checkout', '--', ...rv.files], { cwd: rv.repoPath, timeout: 10000 }, (err) => {
          const msg = err
            ? `Revert failed: ${err.message.slice(0, 60)}`
            : `Reverted ${rv.files.length} file${rv.files.length !== 1 ? 's' : ''}.`;
          this._send('action-result', { message: msg });
        });
      });
    }
    if (actionId === 'plan-ready') {
      this._send('action-result', { message: 'Noted. Keep building.' });
    }
  }

  /** Called by setupIPC apply-code-quality-proposal handler */
  async applyCodeQualityProposal({ projectId, approvedFiles }) {
    const project = this.db.getProject(projectId);
    if (!project?.repo_path) return;

    const repoPath = project.repo_path;
    let totalRemoved = 0;
    const modifiedPaths = [];

    for (const { relPath, type } of approvedFiles) {
      const pattern = QUALITY_PATTERNS[type] ?? QUALITY_PATTERNS.todo;
      const removed = this._removeMatchingLines(path.join(repoPath, relPath), pattern);
      if (removed > 0) { totalRemoved += removed; modifiedPaths.push(relPath); }
    }

    const msg = totalRemoved > 0
      ? `Removed ${totalRemoved} line${totalRemoved !== 1 ? 's' : ''} across ${modifiedPaths.length} file${modifiedPaths.length !== 1 ? 's' : ''}.`
      : 'Nothing to clean.';
    console.log(`[CheckInEngine] Code quality fix: ${msg}`);
    this._send('action-result', { message: msg });

    if (modifiedPaths.length > 0) {
      this._pendingRevert = { repoPath, files: modifiedPaths };
      this._send('check-in-action', { actionId: 'revert-code-quality', label: 'Undo →' });
    }
  }

  // ── Timer tick ────────────────────────────────────────────────────────────

  async _tick() {
    if (this._ticking) return;
    this._ticking = true;
    try {
      const projectId = this._getProjectId();
      if (!projectId || !this._getWindow()) return;

      if (await this._maybeShowInactivityReturn()) return;
      if (await this._maybeShowWeeklyRecap()) return;
      if (await this._maybeShowBrowserDistraction()) return;
      if (await this._maybeCommentOnMusic()) return;
      if (await this._maybeShowClaudeSessionComment()) return;
      if (await this._maybeShowUncommittedDrift()) return;
      if (await this._maybeShowCommitRoast()) return;
      if (await this._maybeShowBranchRoast()) return;
      if (await this._maybeShowDistractionReturn()) return;
      if (await this._maybeShowProjectSwitchWarning()) return;
      if (await this._maybeShowIntelDrop()) return;
      if (await this._maybeShowIntroCheckIn()) return;
      if (await this._maybeShowQuote()) return;

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

  // ── IPC helper ────────────────────────────────────────────────────────────

  _send(channel, ...args) {
    this._getWindow()?.webContents.send(channel, ...args);
  }

  // ── maybeShow* ────────────────────────────────────────────────────────────

  async _maybeShowIntroCheckIn() {
    const projectId = this._getProjectId();
    if (this.db.getState('intro_shown')) return false;
    const activeMinutes = this.db.getActiveMinutesSince(projectId, new Date(0));
    if (activeMinutes < 10) return false;

    this.db.setState('intro_shown', 'true');
    this.db.setState('last_checkin_time', new Date().toISOString());
    this._showWindow();
    this._send('check-in-start', 'welcome');
    try {
      const message = await this.ai.generateIntroCheckIn({
        projectId,
        onChunk: (chunk) => this._send('check-in-chunk', chunk),
      });
      this.db.saveConversation(projectId, message, 'character');
      this._send('check-in-complete', message);
    } catch (err) {
      console.error('[CheckInEngine] Intro check-in error:', err.message);
      this._send('check-in-complete', "Hey, I'm here.");
    }
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
    this._showWindow();
    this._send('check-in-start', 'normal');
    try {
      const message = await this.ai.generateWeeklyRecap({
        projectId,
        onChunk: (chunk) => this._send('check-in-chunk', chunk),
      });
      this.db.saveConversation(projectId, message, 'character');
      this._send('check-in-complete', message);
    } catch (err) {
      console.error('[CheckInEngine] Weekly recap error:', err.message);
      this._send('check-in-complete', '');
    }
    return true;
  }

  async _maybeShowIntelDrop() {
    const projectId = this._getProjectId();
    const lastDrop = this.db.getState('last_intel_drop_time');
    if (lastDrop && (Date.now() - new Date(lastDrop)) < 2 * 60 * 60 * 1000) return false;

    const items = this.db.getUnsurfacedFeedItems(7, 3);
    if (!items.length) return false;

    const isIdle = !this.activityTracker.isRecentlyActive(projectId, 3);
    if (!isIdle) return false;

    this.db.setState('last_intel_drop_time', new Date().toISOString());
    this.db.markFeedItemsSurfaced(items.map(i => i.id));
    this._showWindow();
    this._send('check-in-start', 'watching');
    try {
      const message = await this.ai.generateIntelDrop({
        items,
        onChunk: (chunk) => this._send('check-in-chunk', chunk),
      });
      this.db.saveConversation(projectId, message, 'character');
      this._send('check-in-complete', message);
    } catch (err) {
      console.error('[CheckInEngine] Intel drop error:', err.message);
      this._send('check-in-complete', '');
    }
    return true;
  }

  async _maybeShowInactivityReturn() {
    const lastActivity = this.db.getLastActivityTime();
    if (!lastActivity) return false;

    const now = Date.now();
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
    this._showWindow();
    this._send('check-in-start', 'roast');
    try {
      const message = await this.ai.generateBranchRoast({
        branch,
        onChunk: (chunk) => this._send('check-in-chunk', chunk),
      });
      this.db.saveConversation(projectId, message, 'character');
      this._send('check-in-complete', message);
    } catch (err) {
      console.error('[CheckInEngine] Branch roast error:', err.message);
      this._send('check-in-complete', '');
    }
    return true;
  }

  async _maybeShowCommitRoast() {
    const projectId = this._getProjectId();
    if (!projectId) return false;

    const lastRoasted     = this.db.getState('last_commit_roast_message');
    const lastRoastedTime = this.db.getState('last_commit_roast_time');
    if (lastRoastedTime && (Date.now() - new Date(lastRoastedTime)) < 4 * 60 * 60 * 1000) return false;

    const summary    = this.db.getActivitySummary(projectId, 2);
    const badMessage = this._findBadCommitMessage(summary?.subjects);
    if (!badMessage) return false;
    if (lastRoasted === badMessage) return false;

    this.db.setState('last_commit_roast_message', badMessage);
    this.db.setState('last_commit_roast_time', new Date().toISOString());
    this._showWindow();
    this._send('check-in-start', 'roast');
    try {
      const message = await this.ai.generateCommitRoast({
        message: badMessage,
        onChunk: (chunk) => this._send('check-in-chunk', chunk),
      });
      this.db.saveConversation(projectId, message, 'character');
      this._send('check-in-complete', message);
    } catch (err) {
      console.error('[CheckInEngine] Commit roast error:', err.message);
      this._send('check-in-complete', '');
    }
    return true;
  }

  async _maybeShowClaudeSessionComment() {
    const projectId = this._getProjectId();
    if (!this.appTracker || !projectId) return false;
    const session = this.appTracker.getClaudeSession();
    if (!session || session.minutes < 30) return false;

    const sessionKey = String(this.appTracker.claudeSessionStart);
    if (this.db.getState('last_claude_session_key') === sessionKey) return false;

    this.db.setState('last_claude_session_key', sessionKey);
    this._showWindow();
    this._send('check-in-start', 'watching');
    try {
      const message = await this.ai.generateClaudeSessionComment({
        projectName: session.projectName || 'unknown',
        minutes: session.minutes,
        onChunk: (chunk) => this._send('check-in-chunk', chunk),
      });
      this.db.saveConversation(projectId, message, 'character');
      this._send('check-in-complete', message);
    } catch (err) {
      console.error('[CheckInEngine] Claude session comment error:', err.message);
      this._send('check-in-complete', '');
    }
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
    this._showWindow();
    this._send('check-in-start', 'watching');
    try {
      const message = await this.ai.generateBrowserDistraction({
        domain: distraction.domain,
        minutes: distraction.minutes,
        onChunk: (chunk) => this._send('check-in-chunk', chunk),
      });
      if (projectId) this.db.saveConversation(projectId, message, 'character');
      this._send('check-in-complete', message);
    } catch (err) {
      console.error('[CheckInEngine] Browser distraction error:', err.message);
      this._send('check-in-complete', '');
    }
    return true;
  }

  async _maybeCommentOnMusic() {
    if (!this.appTracker) return false;
    const music = this.appTracker.getCurrentMusic();
    if (!music) return false;

    // Only after track has been playing 5+ minutes
    if (Date.now() - music.detectedAt < 5 * 60 * 1000) return false;

    // Rate limit: 3 hours between music comments
    const last = this.db.getState('last_music_comment');
    if (last && (Date.now() - new Date(last)) < 3 * 60 * 60 * 1000) return false;

    // Don't pile on if browser distraction just fired
    const lastDistraction = this.db.getState('last_browser_distraction_alert');
    if (lastDistraction && (Date.now() - new Date(lastDistraction)) < 2 * 60 * 60 * 1000) return false;

    // Random skip ~50% to feel organic
    if (Math.random() < 0.5) return false;

    const projectId = this._getProjectId();
    this.db.setState('last_music_comment', new Date().toISOString());
    this._showWindow();
    this._send('check-in-start', 'watching');
    try {
      const message = await this.ai.generateMusicComment({
        title: music.title,
        source: music.source,
        onChunk: (chunk) => this._send('check-in-chunk', chunk),
      });
      if (projectId) this.db.saveConversation(projectId, message, 'character');
      this._send('check-in-complete', message);
    } catch (err) {
      console.error('[CheckInEngine] Music comment error:', err.message);
      this._send('check-in-complete', '');
    }
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
        // 6+ hours away — this is a real session return, not a distraction blip
        const lastAlert = this.db.getState('last_building_return_alert');
        if (lastAlert && (now - new Date(lastAlert)) < 6 * 60 * 60 * 1000) return false;
        this.db.setState('last_building_return_alert', new Date().toISOString());
        await this._triggerBuildingReturn(Math.round(gapMinutes / 60), currentApp);
        return true;
      }

      if (gapMinutes >= 60) {
        const lastAlert = this.db.getState('last_distraction_alert');
        if (lastAlert && (now - new Date(lastAlert)) < 2 * 60 * 60 * 1000) return false;

        if (Math.random() < 0.35) return false; // randomly skip, let tick continue

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
    const today = new Date().toISOString().split('T')[0];
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
    const projectId   = this._getProjectId();
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
    this._showWindow();
    this._send('check-in-start', 'watching');
    try {
      const message = await this.ai.generateUncommittedDrift({
        sessionMinutes: session.minutes,
        saveCount,
        projectName: session.projectName || 'unknown',
        onChunk: (chunk) => this._send('check-in-chunk', chunk),
      });
      this.db.saveConversation(projectId, message, 'character');
      this._send('check-in-complete', message);
    } catch (err) {
      console.error('[CheckInEngine] Uncommitted drift error:', err.message);
      this._send('check-in-complete', '');
    }
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
    this._showWindow();
    this._send('check-in-start', 'watching');
    try {
      const message = await this.ai.generateTestGapObservation({
        newFileCount: nonTest.length,
        projectName: project?.name || 'unknown',
        onChunk: (chunk) => this._send('check-in-chunk', chunk),
      });
      this.db.saveConversation(projectId, message, 'character');
      this._send('check-in-complete', message);
    } catch (err) {
      console.error('[CheckInEngine] Test gap error:', err.message);
      this._send('check-in-complete', '');
    }
  }

  // ── trigger* ──────────────────────────────────────────────────────────────

  async triggerCheckIn() {
    const projectId = this._getProjectId();
    if (!this._getWindow() || !projectId) return;

    this._stopSpeaking();
    this.db.setState('last_checkin_time', new Date().toISOString());
    this._showWindow();
    this._send('check-in-start', 'normal');

    const camRaw      = this.db.getState('camera_settings');
    const camSettings = camRaw ? (() => { try { return JSON.parse(camRaw); } catch { return {}; } })() : {};
    const camEnabled  = camSettings.enabled !== false;
    const camAfterHour = camSettings.afterHour ?? null;
    const currentHour  = new Date().getHours();
    const withinWindow = camAfterHour === null || currentHour >= camAfterHour;
    const imageBase64  = (camEnabled && withinWindow) ? await this._captureFrame().catch(() => null) : null;

    const emit = (chunk) => this._send('check-in-chunk', chunk);
    try {
      const project = this.db.getProject(projectId);
      const message = await this.ai.generateCheckIn({
        projectId,
        repoPath: project?.repo_path || null,
        imageBase64,
        onChunk: emit,
      });
      if (!message) {
        console.warn('[CheckInEngine] generateCheckIn returned empty — using fallback');
        emit("I'm here, Ian. Something got in the way of the words.");
      }
      const final = message || "I'm here, Ian. Something got in the way of the words.";
      this.db.saveConversation(projectId, final, 'character');
      this._send('check-in-complete', final);
      if (await this._shouldSpeak()) this._speak(final);
    } catch (err) {
      console.error('[CheckInEngine] Check-in error:', err.message, err.stack);
      const fallback = "I seem to have lost my train of thought. I'll try again shortly.";
      emit(fallback);
      this._send('check-in-complete', fallback);
    }
  }

  async _triggerSecretAlert(projectId, findings, commitHash) {
    if (!this._getWindow()) return;
    this.db.setState('last_secret_alert_time', new Date().toISOString());
    this._showWindow();
    this._send('check-in-start', 'alert');
    try {
      const message = await this.ai.generateSecretAlert({
        findings, commitHash,
        onChunk: (chunk) => this._send('check-in-chunk', chunk),
      });
      this.db.saveConversation(projectId, message, 'character');
      this._send('check-in-complete', message);
    } catch (err) {
      console.error('[CheckInEngine] Secret alert error:', err.message);
      this._send('check-in-complete', '');
    }
  }

  async _triggerDepAlert(projectId, issues) {
    if (!this._getWindow()) return;
    this.db.setState('last_dep_alert_time', new Date().toISOString());
    this._showWindow();
    this._send('check-in-start', 'alert');
    try {
      const message = await this.ai.generateDepAlert({
        issues,
        onChunk: (chunk) => this._send('check-in-chunk', chunk),
      });
      this.db.saveConversation(projectId, message, 'character');
      this._send('check-in-complete', message);
    } catch (err) {
      console.error('[CheckInEngine] Dep alert error:', err.message);
      this._send('check-in-complete', '');
    }
  }

  async _triggerSpendAlert(type, data) {
    const projectId = this._getProjectId();
    if (!this._getWindow()) return;
    this._showWindow();
    this._send('check-in-start', 'alert');
    try {
      const message = await this.ai.generateSpendAlert({
        type,
        percentUsed:      data.pct      || 0,
        totalSpent:       data.spent    || 0,
        budget:           data.budget   || 0,
        dailyRate:        data.dailyRate || 0,
        projectedMonthly: data.projected || 0,
        onChunk: (chunk) => this._send('check-in-chunk', chunk),
      });
      if (projectId) this.db.saveConversation(projectId, message, 'character');
      this._send('check-in-complete', message);
    } catch (err) {
      console.error('[CheckInEngine] Spend alert error:', err.message);
      this._send('check-in-complete', '');
    }
  }

  async _triggerDistractionReturn(distractionMinutes) {
    const projectId = this._getProjectId();
    if (!this._getWindow() || !projectId) return;
    this._showWindow();
    this._send('check-in-start', 'normal');
    try {
      const message = await this.ai.generateDistractionReturn({
        distractionMinutes,
        onChunk: (chunk) => this._send('check-in-chunk', chunk),

  async _triggerBuildingReturn(hoursAway, app) {
    const projectId = this._getProjectId();
    if (!this._getWindow() || !projectId) return;
    this.db.setState('last_checkin_time', new Date().toISOString());
    this._showWindow();
    this._send('check-in-start', 'welcome');
    const project = this.db.getProject(projectId);
    let lastCommit = null;
    if (project?.repo_path) {
      try {
        const { execSync } = require('child_process');
        lastCommit = execSync('git log --oneline -1', { cwd: project.repo_path, timeout: 3000 }).toString().trim();
      } catch {}
    }
    try {
      const message = await this.ai.generateBuildingReturn({
        app, hoursAway,
        projectName: project?.name || null,
        lastCommit,
        onChunk: (chunk) => this._send('check-in-chunk', chunk),
      });
      this.db.saveConversation(projectId, message, 'character');
      this._send('check-in-complete', message);
      if (await this._shouldSpeak()) this._speak(message);
    } catch (err) {
      console.error('[CheckInEngine] Building return error:', err.message);
      this._send('check-in-complete', '');
    }
  }

      });
      this.db.saveConversation(projectId, message, 'character');
      this._send('check-in-complete', message);
    } catch (err) {
      console.error('[CheckInEngine] Distraction return error:', err.message);
      this._send('check-in-complete', '');
    }
  }

  async _triggerInactivityReturn(daysSince) {
    const projectId = this._getProjectId();
    if (!this._getWindow() || !projectId) return;
    this.db.setState('last_checkin_time', new Date().toISOString());
    this._showWindow();
    this._send('check-in-start', 'welcome');
    try {
      const message = await this.ai.generateInactivityReturn({
        daysSince, projectId,
        onChunk: (chunk) => this._send('check-in-chunk', chunk),
      });
      this.db.saveConversation(projectId, message, 'character');
      this._send('check-in-complete', message);
      setTimeout(() => this._maybeShowProgressNarrative(), 60000);
    } catch (err) {
      console.error('[CheckInEngine] Inactivity return error:', err.message);
      this._send('check-in-complete', '');
    }
  }

  async _triggerProjectSwitchWarning(type, names, daySpan) {
    const projectId = this._getProjectId();
    if (!this._getWindow() || !projectId) return;
    this._showWindow();
    this._send('check-in-start', 'roast');
    try {
      const message = await this.ai.generateProjectSwitchWarning({
        type, projectNames: names, daySpan,
        onChunk: (chunk) => this._send('check-in-chunk', chunk),
      });
      this.db.saveConversation(projectId, message, 'character');
      this._send('check-in-complete', message);
    } catch (err) {
      console.error('[CheckInEngine] Project switch warning error:', err.message);
      this._send('check-in-complete', '');
    }
  }

  async _triggerQuote(quote) {
    const projectId = this._getProjectId();
    if (!this._getWindow() || !projectId) return;
    this._showWindow();
    this._send('check-in-start', 'normal');
    try {
      const message = await this.ai.generateQuote({
        quote,
        onChunk: (chunk) => this._send('check-in-chunk', chunk),
      });
      this.db.saveConversation(projectId, message, 'character');
      this._send('check-in-complete', message);
    } catch (err) {
      console.error('[CheckInEngine] Quote error:', err.message);
      this._send('check-in-complete', '');
    }
  }

  async _triggerProgressNarrative() {
    const projectId = this._getProjectId();
    if (!this._getWindow() || !projectId) return;
    this.db.setState('last_progress_date', new Date().toISOString());
    this._showWindow();
    this._send('check-in-start', 'normal');
    try {
      const message = await this.ai.generateProgressNarrative({
        projectId,
        onChunk: (chunk) => this._send('check-in-chunk', chunk),
      });
      this.db.saveConversation(projectId, message, 'character');
      this._send('check-in-complete', message);
    } catch (err) {
      console.error('[CheckInEngine] Progress narrative error:', err.message);
      this._send('check-in-complete', '');
    }
  }

  async _triggerVibeNarration(projectId, promptText, diff) {
    if (!this._getWindow()) return;
    const project = this.db.getProject(projectId);
    this._stopSpeaking();
    this._showWindow();
    this._send('check-in-start', 'watching');
    try {
      const message = await this.ai.generateVibeNarration({
        promptText, diff,
        projectName: project?.name || 'unknown',
        onChunk: (chunk) => this._send('check-in-chunk', chunk),
      });
      this.db.saveConversation(projectId, message, 'character');
      this._send('check-in-complete', message);
      if (await this._shouldSpeak()) this._speak(message);
    } catch (err) {
      console.error('[CheckInEngine] Vibe narration error:', err.message);
      this._send('check-in-complete', '');
    }
  }

  async _triggerVibeWrapUp(sessionMinutes, projectName, commitsDuring, filesSaved) {
    const projectId = this._getProjectId();
    if (!this._getWindow() || !projectId) return;
    this._stopSpeaking();
    this._showWindow();
    this._send('check-in-start', 'watching');
    try {
      const message = await this.ai.generateVibeWrapUp({
        sessionMinutes, commitsDuring, filesSaved,
        projectName: projectName || 'unknown',
        onChunk: (chunk) => this._send('check-in-chunk', chunk),
      });
      this.db.saveConversation(projectId, message, 'character');
      this._send('check-in-complete', message);
      if (await this._shouldSpeak()) this._speak(message);
    } catch (err) {
      console.error('[CheckInEngine] Vibe wrap-up error:', err.message);
      this._send('check-in-complete', '');
    }
  }

  async _triggerCodeQualityObservation(projectId, findings) {
    if (!this._getWindow()) return;
    this.db.setState('last_code_quality_alert', new Date().toISOString());
    const project = this.db.getProject(projectId);
    this._showWindow();
    this._send('check-in-start', 'watching');
    try {
      const message = await this.ai.generateCodeQualityObservation({
        findings,
        projectName: project?.name || 'unknown',
        onChunk: (chunk) => this._send('check-in-chunk', chunk),
      });
      this.db.saveConversation(projectId, message, 'character');
      this._send('check-in-complete', message);
      this._pendingCodeFix = { projectId, findings };
      this._send('check-in-action', { actionId: 'fix-code-quality', label: 'Review changes →' });
      if (await this._shouldSpeak()) this._speak(message);
    } catch (err) {
      console.error('[CheckInEngine] Code quality observation error:', err.message);
      this._send('check-in-complete', '');
    }
  }

  async _triggerThrashingObservation(filePath, saveCount) {
    const projectId = this._getProjectId();
    if (!this._getWindow() || !projectId) return;
    this._showWindow();
    this._send('check-in-start', 'watching');
    try {
      const message = await this.ai.generateThrashingObservation({
        filePath, saveCount, windowMinutes: 2,
        onChunk: (chunk) => this._send('check-in-chunk', chunk),
      });
      this.db.saveConversation(projectId, message, 'character');
      this._send('check-in-complete', message);
      if (await this._shouldSpeak()) this._speak(message);
    } catch (err) {
      console.error('[CheckInEngine] Thrashing observation error:', err.message);
      this._send('check-in-complete', '');
    }
  }

  async _triggerComplexityWarning(filePath, { lineCount, longestFnLines, longestFnName }) {
    const projectId = this._getProjectId();
    if (!this._getWindow() || !projectId) return;
    this._showWindow();
    this._send('check-in-start', 'watching');
    try {
      const message = await this.ai.generateComplexityWarning({
        filePath, lineCount, longestFnLines, longestFnName,
        onChunk: (chunk) => this._send('check-in-chunk', chunk),
      });
      this.db.saveConversation(projectId, message, 'character');
      this._send('check-in-complete', message);
      if (await this._shouldSpeak()) this._speak(message);
    } catch (err) {
      console.error('[CheckInEngine] Complexity warning error:', err.message);
      this._send('check-in-complete', '');
    }
  }

  async _triggerRefactorOpportunity({ functionName, fileCount, files }) {
    const projectId = this._getProjectId();
    if (!this._getWindow() || !projectId) return;
    this._showWindow();
    this._send('check-in-start', 'watching');
    try {
      const message = await this.ai.generateRefactorOpportunity({
        functionName, fileCount, files,
        onChunk: (chunk) => this._send('check-in-chunk', chunk),
      });
      this.db.saveConversation(projectId, message, 'character');
      this._send('check-in-complete', message);
      if (await this._shouldSpeak()) this._speak(message);
    } catch (err) {
      console.error('[CheckInEngine] Refactor opportunity error:', err.message);
      this._send('check-in-complete', '');
    }
  }

  async _triggerTestGapPerFile(filePath, saveCount, hasTestFile) {
    const projectId = this._getProjectId();
    if (!this._getWindow() || !projectId) return;
    this._showWindow();
    this._send('check-in-start', 'watching');
    try {
      const message = await this.ai.generateTestGapPerFile({
        filePath, saveCount, hasTestFile,
        onChunk: (chunk) => this._send('check-in-chunk', chunk),
      });
      this.db.saveConversation(projectId, message, 'character');
      this._send('check-in-complete', message);
      if (await this._shouldSpeak()) this._speak(message);
    } catch (err) {
      console.error('[CheckInEngine] Test gap per-file error:', err.message);
      this._send('check-in-complete', '');
    }
  }

  async _triggerCodeSmellPattern(filePath, smell) {
    const projectId = this._getProjectId();
    if (!this._getWindow() || !projectId) return;
    this._showWindow();
    this._send('check-in-start', 'watching');
    try {
      const message = await this.ai.generateCodeSmellPattern({
        filePath, smell,
        onChunk: (chunk) => this._send('check-in-chunk', chunk),
      });
      this.db.saveConversation(projectId, message, 'character');
      this._send('check-in-complete', message);
      if (await this._shouldSpeak()) this._speak(message);
    } catch (err) {
      console.error('[CheckInEngine] Code smell error:', err.message);
      this._send('check-in-complete', '');
    }
  }

  async _triggerFileObservation(filePath, content, saveCount) {
    const projectId = this._getProjectId();
    if (!this._getWindow() || !projectId) return;
    this._stopSpeaking();
    this._showWindow();
    this._send('check-in-start', 'watching');
    try {
      const message = await this.ai.generateFileObservation({
        filePath, content, saveCount,
        onChunk: (chunk) => this._send('check-in-chunk', chunk),
      });
      this.db.saveConversation(projectId, message, 'character');
      this._send('check-in-complete', message);
      if (await this._shouldSpeak()) this._speak(message);
    } catch (err) {
      console.error('[CheckInEngine] File observation error:', err.message);
      this._send('check-in-complete', '');
    }
  }

  // Public wrappers for service callbacks that need them
  triggerSecretAlert(projectId, findings, commitHash) {
    return this._triggerSecretAlert(projectId, findings, commitHash);
  }
  triggerDepAlert(projectId, issues) {
    return this._triggerDepAlert(projectId, issues);
  }
  triggerSpendAlert(type, data) {
    return this._triggerSpendAlert(type, data);
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

  async _findRefactorOpportunity(repoPath, changedFiles) {
    const jsFiles = changedFiles.filter(f => JS_EXTS.has(path.extname(f).toLowerCase()) && !TEST_FILE_RE.test(f));
    for (const relPath of jsFiles.slice(0, 4)) {
      let src;
      try { src = await fs.promises.readFile(path.join(repoPath, relPath), 'utf8'); } catch { continue; }

      const names = [...src.matchAll(/(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g)]
        .map(m => m[1]).filter(n => n.length >= 4);

      for (const name of names.slice(0, 6)) {
        const files = await new Promise(resolve => {
          execFile('git', ['grep', '-l', `\\b${name}\\b`, '--', ...['*.js', '*.ts', '*.jsx', '*.tsx']],
            { cwd: repoPath, timeout: 5000 },
            (err, stdout) => resolve((stdout || '').trim().split('\n').filter(Boolean)));
        });
        const nonTest = files.filter(f => !TEST_FILE_RE.test(f));
        if (nonTest.length >= 3) return { functionName: name, fileCount: nonTest.length, files: nonTest };
      }
    }
    return null;
  }

  // ── Code quality helpers ──────────────────────────────────────────────────

  async _proposeCodeQualityFix({ projectId, findings }) {
    const project = this.db.getProject(projectId);
    if (!project?.repo_path) return;

    const repoPath      = project.repo_path;
    const proposalFiles = [];

    for (const finding of findings) {
      const { pattern, files } = await this._findFilesToFix(repoPath, finding.type);
      for (const relPath of files) {
        const removals = this._collectRemovals(path.join(repoPath, relPath), pattern);
        if (removals.length > 0) proposalFiles.push({ relPath, type: finding.type, removals });
      }
    }

    if (proposalFiles.length === 0) {
      this._send('action-result', { message: 'Nothing to clean.' });
      return;
    }
    this._send('code-quality-proposal', { projectId, files: proposalFiles });
  }

  _findFilesToFix(repoPath, type) {
    return new Promise(resolve => {
      const pattern  = QUALITY_PATTERNS[type] ?? QUALITY_PATTERNS.todo;
      const grepExpr = type === 'console_log'
        ? 'console\\.(log|warn|error|debug|info)'
        : '(TODO|FIXME|HACK|XXX)';

      execFile('git', ['grep', '-l', '-E', grepExpr,
        '--', '*.js', '*.ts', '*.jsx', '*.tsx', '*.mjs', '*.cjs',
      ], { cwd: repoPath, timeout: 10000 }, (err, stdout) => {
        const files = (stdout || '').trim().split('\n').filter(Boolean)
          .filter(f => !TEST_FILE_RE.test(f));
        resolve({ pattern, files });
      });
    });
  }

  _collectRemovals(absPath, pattern) {
    try {
      return fs.readFileSync(absPath, 'utf8').split('\n').reduce((acc, text, i) => {
        if (pattern.test(text)) acc.push({ line: i + 1, text: text.trim().slice(0, 100) });
        return acc;
      }, []);
    } catch { return []; }
  }

  _removeMatchingLines(absPath, pattern) {
    try {
      const stat = fs.statSync(absPath);
      if (stat.size > 500_000) return 0; // skip large files
      const lines    = fs.readFileSync(absPath, 'utf8').split('\n');
      const filtered = lines.filter(l => !pattern.test(l));
      const removed  = lines.length - filtered.length;
      if (removed > 0) fs.writeFileSync(absPath, filtered.join('\n'), 'utf8');
      return removed;
    } catch { return 0; }
  }

  // ── Commit/branch helpers ─────────────────────────────────────────────────

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
