'use strict';

const path           = require('path');
const fs             = require('fs');
const { execFile }   = require('child_process');

// Constants shared with or needed only by the trigger layer
const TEST_FILE_RE = /(?:\.test\.|\.spec\.|__tests__|[/\\]tests?[/\\])/i;
const JS_EXTS      = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs']);

const QUALITY_PATTERNS = {
  console_log: /^\s*console\.(log|warn|error|debug|info)\s*\(/,
  todo:        /^\s*(\/\/|#)\s*(TODO|FIXME|HACK|XXX)\b/i,
};

/**
 * CheckInTriggers — the "what to say" layer.
 *
 * Every method here drives one Alfred observation: show the window, stream the
 * AI response, send check-in-complete, optionally speak. No scheduling, no
 * gating, no cooldown decisions live here.
 *
 * CheckInEngine extends this class. All `this.*` dependencies (db, ai,
 * _getWindow, _speak, etc.) are wired in CheckInEngine's constructor.
 */
class CheckInTriggers {

  // ── Speaking guard ─────────────────────────────────────────────────────────

  _startCheckIn(mood) {
    if (this._speaking) {
      console.log('[guard] blocked — Alfred already speaking');
      return false;
    }
    this._speaking = true;
    this._showWindow();
    this._send('check-in-start', mood);
    return true;
  }

  _finishCheckIn() {
    this._speaking = false;
  }

  // ── Public API (called from main.js / IPC handlers) ───────────────────────

  async triggerCheckIn() {
    const projectId = this._getProjectId();
    if (!this._getWindow() || !projectId) return;

    this._stopSpeaking();
    this.db.setState('last_checkin_time', new Date().toISOString());
    if (!this._startCheckIn('normal')) return;

    const camRaw      = this.db.getState('camera_settings');
    const camSettings = camRaw ? (() => { try { return JSON.parse(camRaw); } catch { return {}; } })() : {};
    const camEnabled   = camSettings.enabled !== false;
    const camAfterHour = camSettings.afterHour ?? null;
    const withinWindow = camAfterHour === null || new Date().getHours() >= camAfterHour;
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
    } finally {
      this._finishCheckIn();
    }
  }

  /** Public wrappers so main.js service callbacks can call engine.triggerXxx() */
  triggerSecretAlert(projectId, findings, commitHash) {
    return this._triggerSecretAlert(projectId, findings, commitHash);
  }
  triggerDepAlert(projectId, issues) {
    return this._triggerDepAlert(projectId, issues);
  }
  triggerSpendAlert(type, data) {
    return this._triggerSpendAlert(type, data);
  }

  async handleAction(actionId) {
    if (actionId === 'fix-code-quality' && this._pendingCodeFix) {
      const fix = this._pendingCodeFix;
      this._pendingCodeFix = null;
      await this._proposeCodeQualityFix(fix);
    }
    if (actionId === 'revert-code-quality' && this._pendingRevert) {
      const rv = this._pendingRevert;
      this._pendingRevert = null;
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

  // ── Triggers for periodic _maybeShow* checks ──────────────────────────────

  async _triggerIntroCheckIn(projectId) {
    if (!this._startCheckIn('welcome')) return;
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
    } finally {
      this._finishCheckIn();
    }
  }

  async _triggerWeeklyRecap(projectId) {
    if (!this._startCheckIn('normal')) return;
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
    } finally {
      this._finishCheckIn();
    }
  }

  async _triggerIntelDrop(projectId, items) {
    if (!this._startCheckIn('watching')) return;
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
    } finally {
      this._finishCheckIn();
    }
  }

  async _triggerBranchRoast(projectId, branch) {
    if (!this._startCheckIn('roast')) return;
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
    } finally {
      this._finishCheckIn();
    }
  }

  async _triggerCommitRoast(projectId, badMessage) {
    if (!this._startCheckIn('roast')) return;
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
    } finally {
      this._finishCheckIn();
    }
  }

  async _triggerClaudeSessionComment(projectId, session) {
    if (!this._startCheckIn('watching')) return;
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
    } finally {
      this._finishCheckIn();
    }
  }

  async _triggerBrowserDistraction(projectId, distraction) {
    if (!this._startCheckIn('watching')) return;
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
    } finally {
      this._finishCheckIn();
    }
  }

  async _triggerUncommittedDrift(projectId, { sessionMinutes, saveCount, projectName }) {
    if (!this._startCheckIn('watching')) return;
    try {
      const message = await this.ai.generateUncommittedDrift({
        sessionMinutes, saveCount, projectName,
        onChunk: (chunk) => this._send('check-in-chunk', chunk),
      });
      this.db.saveConversation(projectId, message, 'character');
      this._send('check-in-complete', message);
    } catch (err) {
      console.error('[CheckInEngine] Uncommitted drift error:', err.message);
      this._send('check-in-complete', '');
    } finally {
      this._finishCheckIn();
    }
  }

  async _triggerTestGap(projectId, { nonTestCount, projectName }) {
    if (!this._startCheckIn('watching')) return;
    try {
      const message = await this.ai.generateTestGapObservation({
        newFileCount: nonTestCount, projectName,
        onChunk: (chunk) => this._send('check-in-chunk', chunk),
      });
      this.db.saveConversation(projectId, message, 'character');
      this._send('check-in-complete', message);
    } catch (err) {
      console.error('[CheckInEngine] Test gap error:', err.message);
      this._send('check-in-complete', '');
    } finally {
      this._finishCheckIn();
    }
  }

  // ── Triggers called by external service callbacks ─────────────────────────

  async _triggerSecretAlert(projectId, findings, commitHash) {
    if (!this._getWindow()) return;
    this.db.setState('last_secret_alert_time', new Date().toISOString());
    if (!this._startCheckIn('alert')) return;
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
    } finally {
      this._finishCheckIn();
    }
  }

  async _triggerDepAlert(projectId, issues) {
    if (!this._getWindow()) return;
    this.db.setState('last_dep_alert_time', new Date().toISOString());
    if (!this._startCheckIn('alert')) return;
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
    } finally {
      this._finishCheckIn();
    }
  }

  async _triggerSpendAlert(type, data) {
    const projectId = this._getProjectId();
    if (!this._getWindow()) return;
    if (!this._startCheckIn('alert')) return;
    try {
      const message = await this.ai.generateSpendAlert({
        type,
        percentUsed:      data.pct       || 0,
        totalSpent:       data.spent     || 0,
        budget:           data.budget    || 0,
        dailyRate:        data.dailyRate || 0,
        projectedMonthly: data.projected || 0,
        onChunk: (chunk) => this._send('check-in-chunk', chunk),
      });
      if (projectId) this.db.saveConversation(projectId, message, 'character');
      this._send('check-in-complete', message);
    } catch (err) {
      console.error('[CheckInEngine] Spend alert error:', err.message);
      this._send('check-in-complete', '');
    } finally {
      this._finishCheckIn();
    }
  }

  async _triggerMusicComment(projectId, music) {
    if (!this._getWindow()) return;
    if (!this._startCheckIn('watching')) return;
    try {
      const message = await this.ai.generateMusicComment({
        title:  music.title,
        source: music.source,
        onChunk: (chunk) => this._send('check-in-chunk', chunk),
      });
      if (projectId) this.db.saveConversation(projectId, message, 'character');
      this._send('check-in-complete', message);
    } catch (err) {
      console.error('[CheckInEngine] Music comment error:', err.message);
      this._send('check-in-complete', '');
    } finally {
      this._finishCheckIn();
    }
  }

  async _triggerDistractionReturn(distractionMinutes) {
    const projectId = this._getProjectId();
    if (!this._getWindow() || !projectId) return;
    if (!this._startCheckIn('normal')) return;
    try {
      const message = await this.ai.generateDistractionReturn({
        distractionMinutes,
        onChunk: (chunk) => this._send('check-in-chunk', chunk),
      });
      this.db.saveConversation(projectId, message, 'character');
      this._send('check-in-complete', message);
    } catch (err) {
      console.error('[CheckInEngine] Distraction return error:', err.message);
      this._send('check-in-complete', '');
    } finally {
      this._finishCheckIn();
    }
  }

  async _triggerBuildingReturn(hoursAway, app) {
    const projectId = this._getProjectId();
    if (!this._getWindow() || !projectId) return;
    this.db.setState('last_checkin_time', new Date().toISOString());
    if (!this._startCheckIn('welcome')) return;
    const project = this.db.getProject(projectId);
    const lastCommit = project?.repo_path
      ? await new Promise(resolve => {
          execFile('git', ['log', '--oneline', '-1'], { cwd: project.repo_path, timeout: 3000 },
            (err, stdout) => resolve(err ? null : stdout.trim()));
        })
      : null;
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
    } finally {
      this._finishCheckIn();
    }
  }

  async _triggerInactivityReturn(daysSince) {
    const projectId = this._getProjectId();
    if (!this._getWindow() || !projectId) return;
    this.db.setState('last_checkin_time', new Date().toISOString());
    if (!this._startCheckIn('welcome')) return;
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
    } finally {
      this._finishCheckIn();
    }
  }

  async _triggerProjectSwitchWarning(type, names, daySpan) {
    const projectId = this._getProjectId();
    if (!this._getWindow() || !projectId) return;
    if (!this._startCheckIn('roast')) return;
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
    } finally {
      this._finishCheckIn();
    }
  }

  async _triggerQuote(quote) {
    const projectId = this._getProjectId();
    if (!this._getWindow() || !projectId) return;
    if (!this._startCheckIn('normal')) return;
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
    } finally {
      this._finishCheckIn();
    }
  }

  async _triggerProgressNarrative() {
    const projectId = this._getProjectId();
    if (!this._getWindow() || !projectId) return;
    this.db.setState('last_progress_date', new Date().toISOString());
    if (!this._startCheckIn('normal')) return;
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
    } finally {
      this._finishCheckIn();
    }
  }

  async _triggerVibeNarration(projectId, promptText, diff) {
    if (!this._getWindow()) return;
    const project = this.db.getProject(projectId);
    this._stopSpeaking();
    if (!this._startCheckIn('watching')) return;
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
    } finally {
      this._finishCheckIn();
    }
  }

  async _triggerVibeWrapUp(sessionMinutes, projectName, commitsDuring, filesSaved) {
    const projectId = this._getProjectId();
    if (!this._getWindow() || !projectId) return;
    this._stopSpeaking();
    if (!this._startCheckIn('watching')) return;
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
    } finally {
      this._finishCheckIn();
    }
  }

  async _triggerCodeQualityObservation(projectId, findings) {
    if (!this._getWindow()) return;
    this.db.setState('last_code_quality_alert', new Date().toISOString());
    const project = this.db.getProject(projectId);
    if (!this._startCheckIn('watching')) return;
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
    } finally {
      this._finishCheckIn();
    }
  }

  async _triggerThrashingObservation(filePath, saveCount) {
    const projectId = this._getProjectId();
    if (!this._getWindow() || !projectId) return;
    if (!this._startCheckIn('watching')) return;
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
    } finally {
      this._finishCheckIn();
    }
  }

  async _triggerComplexityWarning(filePath, { lineCount, longestFnLines, longestFnName }) {
    const projectId = this._getProjectId();
    if (!this._getWindow() || !projectId) return;
    if (!this._startCheckIn('watching')) return;
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
    } finally {
      this._finishCheckIn();
    }
  }

  async _triggerRefactorOpportunity({ functionName, fileCount, files }) {
    const projectId = this._getProjectId();
    if (!this._getWindow() || !projectId) return;
    if (!this._startCheckIn('watching')) return;
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
    } finally {
      this._finishCheckIn();
    }
  }

  async _triggerTestGapPerFile(filePath, saveCount, hasTestFile) {
    const projectId = this._getProjectId();
    if (!this._getWindow() || !projectId) return;
    if (!this._startCheckIn('watching')) return;
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
    } finally {
      this._finishCheckIn();
    }
  }

  async _triggerCodeSmellPattern(filePath, smell) {
    const projectId = this._getProjectId();
    if (!this._getWindow() || !projectId) return;
    if (!this._startCheckIn('watching')) return;
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
    } finally {
      this._finishCheckIn();
    }
  }

  async _triggerFileObservation(filePath, content, saveCount) {
    const projectId = this._getProjectId();
    if (!this._getWindow() || !projectId) return;
    this._stopSpeaking();
    if (!this._startCheckIn('watching')) return;
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
    } finally {
      this._finishCheckIn();
    }
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
      if (stat.size > 500_000) return 0;
      const lines    = fs.readFileSync(absPath, 'utf8').split('\n');
      const filtered = lines.filter(l => !pattern.test(l));
      const removed  = lines.length - filtered.length;
      if (removed > 0) fs.writeFileSync(absPath, filtered.join('\n'), 'utf8');
      return removed;
    } catch { return 0; }
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
}

module.exports = CheckInTriggers;
