'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { execFile }  = require('child_process');
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');

const DB              = require('./services/database');
const GitMonitor      = require('./services/git-monitor');
const FileWatcher     = require('./services/file-watcher');
const ActivityTracker = require('./services/activity-tracker');
const { AICharacter, CODING_APPS, QUOTES } = require('./services/ai-character');
const AppTracker      = require('./services/app-tracker');
const InterestManager = require('./services/interest-manager');
const FeedFetcher     = require('./services/feed-fetcher');
const DepMonitor      = require('./services/dep-monitor');
const SecretScanner   = require('./services/secret-scanner');
const SpendTracker    = require('./services/spend-tracker');

// ── State ──────────────────────────────────────────────────────────────────

let mainWindow = null;
let settingsWindow = null;
let tray = null;
let db, gitMonitor, fileWatcher, activityTracker, aiCharacter, appTracker;
let interestManager, feedFetcher, depMonitor, secretScanner, spendTracker;
let activeProjectId = null;
let checkInTimerId  = null;
let lastCodingAppSeen = Date.now(); // tracks last time a coding app was focused
const recentlyObservedFiles = new Map(); // relativePath → last observation timestamp (ms)

// ── Window ─────────────────────────────────────────────────────────────────

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: 320,
    height: 260,      // compact — just the popup card
    x: width - 340,
    y: height - 200,
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    vibrancy: 'under-window',
    visualEffectState: 'active',
    resizable: false,
    show: false,      // hidden until there's something to say
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setAlwaysOnTop(true, 'floating');

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // First-run: if no projects, show the onboarding form immediately
  mainWindow.webContents.on('did-finish-load', async () => {
    const projects = db.getProjects();
    if (projects.length === 0) {
      mainWindow.setSize(320, 280);
      mainWindow.show();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function showWindow() {
  if (!mainWindow) return;
  mainWindow.webContents.send('window-show'); // trigger entry animation before paint
  mainWindow.showInactive(); // don't steal focus
}

function hideWindow() {
  mainWindow?.hide();
}

// ── Settings window ─────────────────────────────────────────────────────────

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 320,
    height: 380,
    resizable: false,
    frame: false,
    transparent: true,
    vibrancy: 'under-window',
    visualEffectState: 'active',
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// ── Tray ───────────────────────────────────────────────────────────────────

function createTray() {
  // 16x16 green dot icon drawn with nativeImage (no external file needed)
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - size / 2, dy = y - size / 2;
      const inside = dx * dx + dy * dy <= (size / 2 - 1) * (size / 2 - 1);
      const i = (y * size + x) * 4;
      canvas[i]     = inside ? 74  : 0;   // R
      canvas[i + 1] = inside ? 222 : 0;   // G
      canvas[i + 2] = inside ? 128 : 0;   // B
      canvas[i + 3] = inside ? 255 : 0;   // A
    }
  }
  const icon = nativeImage.createFromBuffer(canvas, { width: size, height: size });
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('Outpost is watching 👀');

  const menu = Menu.buildFromTemplate([
    { label: 'Check in now', click: () => triggerCheckIn() },
    { label: 'Scan git now', click: async () => {
      for (const [projectId] of gitMonitor.watchers) {
        await gitMonitor.scanNow(projectId);
      }
    }},
    { type: 'separator' },
    { label: 'Settings', click: () => openSettings() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => tray.popUpContextMenu());
}

// ── Services ───────────────────────────────────────────────────────────────

async function initServices() {
  db           = new DB();
  db.initialize();
  appTracker   = new AppTracker();
  appTracker.start();
  aiCharacter  = new AICharacter(db, appTracker);
  gitMonitor   = new GitMonitor(db);
  fileWatcher  = new FileWatcher(db);
  activityTracker = new ActivityTracker(db, fileWatcher);

  const savedId = db.getState('active_project_id');
  if (savedId) activeProjectId = parseInt(savedId, 10);

  for (const project of db.getProjects()) {
    if (project.repo_path) {
      fileWatcher.watchDirectory(project.id, project.repo_path);
      gitMonitor.watchRepo(project.id, project.repo_path);
    }
  }

  fileWatcher.onProjectSwitch = (projectId) => {
    if (activeProjectId !== projectId) {
      activeProjectId = projectId;
      db.setState('active_project_id', projectId);
    }
  };

  const fs = require('fs');
  fileWatcher.onHotFile = async (projectId, relativePath, absolutePath, saveCount) => {
    if (projectId !== activeProjectId || !mainWindow) return;
    // 2-hour cooldown per file
    const last = recentlyObservedFiles.get(relativePath);
    if (last && Date.now() - last < 2 * 60 * 60 * 1000) return;
    // Read content, cap at 120 lines
    let content;
    try {
      const raw = fs.readFileSync(absolutePath, 'utf8');
      const lines = raw.split('\n');
      content = lines.slice(0, 120).join('\n');
      if (lines.length > 120) content += `\n... (${lines.length - 120} more lines)`;
    } catch { return; }
    recentlyObservedFiles.set(relativePath, Date.now());
    await triggerFileObservation(relativePath, content, saveCount);
  };

  gitMonitor.onSignificantEvent = (projectId, commitCount) => {
    console.log(`[Main] ${commitCount} new commits on project ${projectId}`);
    if (projectId === activeProjectId) scheduleCheckIn(1500);
  };

  activityTracker.start();

  interestManager = new InterestManager(db);
  feedFetcher = new FeedFetcher();
  feedFetcher.start(db, interestManager, () => activeProjectId);

  depMonitor = new DepMonitor();
  for (const project of db.getProjects()) {
    if (project.repo_path) depMonitor.watchProject(project.id, project.repo_path);
  }
  depMonitor.onIssuesFound = (projectId, issues) => {
    const last = db.getState('last_dep_alert_time');
    if (last && Date.now() - new Date(last) < 24 * 60 * 60 * 1000) return;
    if (projectId === activeProjectId) triggerDepAlert(projectId, issues);
  };

  secretScanner = new SecretScanner();
  for (const project of db.getProjects()) {
    if (project.repo_path) secretScanner.watchProject(project.id, project.repo_path);
  }
  secretScanner.onSecretsFound = (projectId, findings, commitHash) => {
    // 1hr cooldown — still urgent, just don't spam on rapid commits
    const last = db.getState('last_secret_alert_time');
    if (last && Date.now() - new Date(last) < 60 * 60 * 1000) return;
    triggerSecretAlert(projectId, findings, commitHash);
  };

  spendTracker = new SpendTracker(db);
  spendTracker.onThresholdAlert = (pct, spent, budget) =>
    triggerSpendAlert('threshold', { pct, spent, budget });
  spendTracker.onHighBurnRate = (dailyRate, projected, budget) =>
    triggerSpendAlert('burn_rate', { dailyRate, projected, budget });
  spendTracker.onLowUsage = (pct, spent, budget) =>
    triggerSpendAlert('low_usage', { pct, spent, budget });
  spendTracker.start();
}

// ── Check-in ───────────────────────────────────────────────────────────────

const CHECK_POLL_MS         = 5 * 60 * 1000;  // poll every 5 min
const ACTIVE_THRESHOLD_MIN  = 30;             // 30 min of activity since last check-in
const IDLE_GATE_MIN         = 3;              // wait for 3 min idle before popping up

function startCheckInTimer() {
  checkInTimerId = setInterval(async () => {
    if (!activeProjectId || !mainWindow) return;

    if (await maybeShowInactivityReturn()) return;    // highest priority — 3-day absence
    if (await maybeShowWeeklyRecap()) return;
    if (await maybeShowDistractionReturn()) return;   // 1hr distraction, 35% silent
    if (await maybeShowProjectSwitchWarning()) return;
    if (await maybeShowIntelDrop()) return;
    if (await maybeShowIntroCheckIn()) return;
    if (await maybeShowQuote()) return;

    // Regular check-in
    const lastCheckIn   = db.getState('last_checkin_time');
    const since         = lastCheckIn ? new Date(lastCheckIn) : new Date(0);
    const activeMinutes = db.getActiveMinutesSince(activeProjectId, since);

    if (activeMinutes >= ACTIVE_THRESHOLD_MIN) {
      const recentlyActive = activityTracker.isRecentlyActive(activeProjectId, IDLE_GATE_MIN);
      if (!recentlyActive) {
        if (await maybeShowProgressNarrative()) return;
        await triggerCheckIn();
      }
    }
  }, CHECK_POLL_MS);
}

async function maybeShowIntroCheckIn() {
  if (db.getState('intro_shown')) return false;
  const activeMinutes = db.getActiveMinutesSince(activeProjectId, new Date(0));
  if (activeMinutes < 10) return false;

  db.setState('intro_shown', 'true');
  db.setState('last_checkin_time', new Date().toISOString());
  showWindow();
  mainWindow.webContents.send('check-in-start');
  try {
    const message = await aiCharacter.generateIntroCheckIn({
      projectId: activeProjectId,
      onChunk: (chunk) => mainWindow?.webContents.send('check-in-chunk', chunk),
    });
    db.saveConversation(activeProjectId, message, 'character');
    mainWindow?.webContents.send('check-in-complete', message);
  } catch (err) {
    console.error('[Main] Intro check-in error:', err.message);
    mainWindow?.webContents.send('check-in-complete', "Hey, I'm here.");
  }
  return true;
}

async function maybeShowWeeklyRecap() {
  const lastRecap = db.getState('last_recap_date');
  if (lastRecap) {
    const daysSince = (Date.now() - new Date(lastRecap)) / (1000 * 60 * 60 * 24);
    if (daysSince < 7) return false;
  }
  const weekSummary = db.getMultiDaySummary(activeProjectId, 7);
  if (weekSummary.totalCommits === 0 && weekSummary.activeHours === 0) return false;

  db.setState('last_recap_date', new Date().toISOString());
  db.setState('last_checkin_time', new Date().toISOString());
  showWindow();
  mainWindow.webContents.send('check-in-start');
  try {
    const message = await aiCharacter.generateWeeklyRecap({
      projectId: activeProjectId,
      onChunk: (chunk) => mainWindow?.webContents.send('check-in-chunk', chunk),
    });
    db.saveConversation(activeProjectId, message, 'character');
    mainWindow?.webContents.send('check-in-complete', message);
  } catch (err) {
    console.error('[Main] Weekly recap error:', err.message);
    mainWindow?.webContents.send('check-in-complete', '');
  }
  return true;
}

async function maybeShowIntelDrop() {
  const lastDrop = db.getState('last_intel_drop_time');
  if (lastDrop && (Date.now() - new Date(lastDrop)) < 2 * 60 * 60 * 1000) return false;

  const items = db.getUnsurfacedFeedItems(7, 3);  // score >= 7 only
  if (!items.length) return false;

  const isIdle = !activityTracker.isRecentlyActive(activeProjectId, 3);
  if (!isIdle) return false;

  db.setState('last_intel_drop_time', new Date().toISOString());
  db.markFeedItemsSurfaced(items.map(i => i.id));
  showWindow();
  mainWindow.webContents.send('check-in-start');
  try {
    const message = await aiCharacter.generateIntelDrop({
      items,
      onChunk: (chunk) => mainWindow?.webContents.send('check-in-chunk', chunk),
    });
    db.saveConversation(activeProjectId, message, 'character');
    mainWindow?.webContents.send('check-in-complete', message);
  } catch (err) {
    console.error('[Main] Intel drop error:', err.message);
    mainWindow?.webContents.send('check-in-complete', '');
  }
  return true;
}

async function maybeShowInactivityReturn() {
  const lastActivity = db.getLastActivityTime();
  if (!lastActivity) return false;

  const now = Date.now();
  const hoursSince = (now - new Date(lastActivity)) / (1000 * 60 * 60);
  if (hoursSince < 72) return false;

  // Skip if we already fired for this absence
  const lastAlert = db.getState('last_inactivity_alert');
  if (lastAlert && new Date(lastAlert) > new Date(lastActivity)) return false;

  const daysSince = Math.floor(hoursSince / 24);
  db.setState('last_inactivity_alert', new Date().toISOString());
  await triggerInactivityReturn(daysSince);
  return true;
}

async function maybeShowDistractionReturn() {
  if (!appTracker) return false;
  const currentApp = appTracker.getCurrentApp();
  if (!currentApp) return false;

  if (CODING_APPS.has(currentApp)) {
    const now = Date.now();
    const gapMinutes = (now - lastCodingAppSeen) / 60000;
    lastCodingAppSeen = now; // always update when confirmed in coding app

    if (gapMinutes >= 60) {
      const lastAlert = db.getState('last_distraction_alert');
      if (lastAlert && (now - new Date(lastAlert)) < 2 * 60 * 60 * 1000) return false;

      // 35% chance: intentional silence — the silence IS the response
      if (Math.random() < 0.35) {
        db.setState('last_distraction_alert', new Date().toISOString());
        return true;
      }

      await triggerDistractionReturn(Math.round(gapMinutes));
      db.setState('last_distraction_alert', new Date().toISOString());
      return true;
    }
  }
  // Not in coding app — don't update lastCodingAppSeen
  return false;
}

async function maybeShowProjectSwitchWarning() {
  const now = Date.now();
  const lastAlert = db.getState('last_project_switch_alert');
  if (lastAlert && (now - new Date(lastAlert)) < 4 * 60 * 60 * 1000) return false;

  // Session check: 3+ distinct projects in last 4 hours
  const recentIds = db.getActiveProjectIds(4);
  if (recentIds.length >= 3) {
    const names = recentIds.map(id => db.getProject(id)?.name || `Project ${id}`);
    db.setState('last_project_switch_alert', new Date().toISOString());
    await triggerProjectSwitchWarning('session', names, null);
    return true;
  }

  // Pattern check: 3+ projects over 7 days with 0 commits
  const pattern = db.getMultiProjectPattern(7);
  const noCommit = pattern.filter(p => p.commit_events === 0);
  if (noCommit.length >= 3 && noCommit.some(p => p.active_days >= 3)) {
    const daySpan = Math.max(...noCommit.map(p => p.active_days));
    const names = noCommit.map(p => db.getProject(p.project_id)?.name || `Project ${p.project_id}`);
    db.setState('last_project_switch_alert', new Date().toISOString());
    await triggerProjectSwitchWarning('pattern', names, daySpan);
    return true;
  }

  return false;
}

async function maybeShowQuote() {
  const today = new Date().toISOString().split('T')[0];
  if (db.getState('last_quote_date') === today) return false;

  // Only fire when idle (no file activity in last 10 min)
  if (activityTracker.isRecentlyActive(activeProjectId, 10)) return false;

  // Pick a quote, avoiding the most recently used index
  const lastIdx = parseInt(db.getState('last_quote_index') || '-1', 10);
  let idx = Math.floor(Math.random() * QUOTES.length);
  if (idx === lastIdx && QUOTES.length > 1) idx = (idx + 1) % QUOTES.length;

  db.setState('last_quote_date', today);
  db.setState('last_quote_index', String(idx));
  await triggerQuote(QUOTES[idx]);
  return true;
}

async function maybeShowProgressNarrative() {
  const lastProgress = db.getState('last_progress_date');
  if (lastProgress) {
    const daysSince = (Date.now() - new Date(lastProgress)) / (1000 * 60 * 60 * 24);
    if (daysSince < 3) return false;
  }

  // Only fire if session has been long (90+ active minutes since last check-in)
  const lastCheckIn = db.getState('last_checkin_time');
  const since = lastCheckIn ? new Date(lastCheckIn) : new Date(0);
  if (db.getActiveMinutesSince(activeProjectId, since) < 90) return false;

  db.setState('last_progress_date', new Date().toISOString());
  await triggerProgressNarrative();
  return true;
}

function scheduleCheckIn(delayMs = 0) {
  setTimeout(triggerCheckIn, delayMs);
}

/**
 * Ask the renderer to capture a webcam frame and return it as base64 JPEG.
 * Resolves null if the window isn't ready, camera is denied, or times out.
 */
function captureFrame() {
  if (!mainWindow) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 5000);
    ipcMain.once('frame-captured', (_, frameData) => {
      clearTimeout(timeout);
      resolve(frameData || null);
    });
    mainWindow.webContents.send('capture-frame');
  });
}

// ── Voice / TTS ─────────────────────────────────────────────────────────────

let currentSpeech = null;

function speak(text) {
  if (!text) return;
  if (currentSpeech) {
    currentSpeech.kill('SIGTERM');
    currentSpeech = null;
  }
  // Strip markdown formatting before handing to say
  const clean = text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`[^`]+`/g, '')
    .replace(/[_~]/g, '')
    .trim();
  if (!clean) return;
  currentSpeech = execFile('say', ['-v', 'Daniel', '-r', '165', clean], () => {
    currentSpeech = null;
  });
}

function stopSpeaking() {
  if (currentSpeech) {
    currentSpeech.kill('SIGTERM');
    currentSpeech = null;
  }
}

/**
 * Returns true if headphones are the current output device.
 * Uses switchaudio-osx if installed (fast). Returns null if not installed.
 */
function detectHeadphones() {
  return new Promise((resolve) => {
    execFile('SwitchAudioSource', ['-c', '-t', 'output'], { timeout: 2000 }, (err, stdout) => {
      if (err || !stdout) { resolve(null); return; } // not installed
      const name = stdout.trim().toLowerCase();
      const keywords = ['airpod', 'headphone', 'headset', 'earpod', 'beats', 'bose', 'sony', 'jabra', 'sennheiser', 'wh-', 'ath-'];
      resolve(keywords.some(kw => name.includes(kw)));
    });
  });
}

/**
 * Returns true if Alfred should speak right now.
 * Checks voice_settings, and optionally queries the current audio output device.
 */
async function shouldSpeak() {
  const raw = db.getState('voice_settings');
  let s;
  try { s = raw ? JSON.parse(raw) : {}; } catch { s = {}; }
  if (s.enabled !== true) return false;

  if (s.autoDetect !== false) {
    const headphones = await detectHeadphones();
    if (headphones === null) return true;  // switchaudio-osx not installed — trust the toggle
    return headphones;
  }

  return true; // autoDetect off, manual toggle is the gate
}

async function triggerCheckIn() {
  if (!mainWindow || !activeProjectId) return;

  stopSpeaking();
  db.setState('last_checkin_time', new Date().toISOString());
  showWindow();
  mainWindow.webContents.send('check-in-start');

  const camRaw = db.getState('camera_settings');
  const camSettings = camRaw ? (() => { try { return JSON.parse(camRaw); } catch { return {}; } })() : {};
  const camEnabled = camSettings.enabled !== false;
  const camAfterHour = camSettings.afterHour ?? null;
  const currentHour = new Date().getHours();
  const withinWindow = camAfterHour === null || currentHour >= camAfterHour;
  const imageBase64 = (camEnabled && withinWindow) ? await captureFrame().catch(() => null) : null;

  try {
    const message = await aiCharacter.generateCheckIn({
      projectId: activeProjectId,
      imageBase64,
      onChunk: (chunk) => mainWindow?.webContents.send('check-in-chunk', chunk),
    });
    db.saveConversation(activeProjectId, message, 'character');
    mainWindow?.webContents.send('check-in-complete', message);
    if (await shouldSpeak()) speak(message);
  } catch (err) {
    console.error('[Main] Check-in error:', err.message);
    mainWindow?.webContents.send('check-in-complete', "Hey — how's it going?");
  }
}

async function triggerSecretAlert(projectId, findings, commitHash) {
  if (!mainWindow) return;
  db.setState('last_secret_alert_time', new Date().toISOString());
  showWindow();
  mainWindow.webContents.send('check-in-start');
  try {
    const message = await aiCharacter.generateSecretAlert({
      findings,
      commitHash,
      onChunk: (chunk) => mainWindow?.webContents.send('check-in-chunk', chunk),
    });
    db.saveConversation(projectId, message, 'character');
    mainWindow?.webContents.send('check-in-complete', message);
  } catch (err) {
    console.error('[Main] Secret alert error:', err.message);
    mainWindow?.webContents.send('check-in-complete', '');
  }
}

async function triggerDepAlert(projectId, issues) {
  if (!mainWindow) return;
  db.setState('last_dep_alert_time', new Date().toISOString());
  showWindow();
  mainWindow.webContents.send('check-in-start');
  try {
    const message = await aiCharacter.generateDepAlert({
      issues,
      onChunk: (chunk) => mainWindow?.webContents.send('check-in-chunk', chunk),
    });
    db.saveConversation(projectId, message, 'character');
    mainWindow?.webContents.send('check-in-complete', message);
  } catch (err) {
    console.error('[Main] Dep alert error:', err.message);
    mainWindow?.webContents.send('check-in-complete', '');
  }
}

async function triggerSpendAlert(type, data) {
  if (!mainWindow) return;
  showWindow();
  mainWindow.webContents.send('check-in-start');
  try {
    const message = await aiCharacter.generateSpendAlert({
      type,
      percentUsed:       data.pct       || 0,
      totalSpent:        data.spent      || 0,
      budget:            data.budget     || 0,
      dailyRate:         data.dailyRate  || 0,
      projectedMonthly:  data.projected  || 0,
      onChunk: (chunk) => mainWindow?.webContents.send('check-in-chunk', chunk),
    });
    if (activeProjectId) db.saveConversation(activeProjectId, message, 'character');
    mainWindow?.webContents.send('check-in-complete', message);
  } catch (err) {
    console.error('[Main] Spend alert error:', err.message);
    mainWindow?.webContents.send('check-in-complete', '');
  }
}

async function triggerDistractionReturn(distractionMinutes) {
  if (!mainWindow || !activeProjectId) return;
  showWindow();
  mainWindow.webContents.send('check-in-start');
  try {
    const message = await aiCharacter.generateDistractionReturn({
      distractionMinutes,
      onChunk: (chunk) => mainWindow?.webContents.send('check-in-chunk', chunk),
    });
    db.saveConversation(activeProjectId, message, 'character');
    mainWindow?.webContents.send('check-in-complete', message);
  } catch (err) {
    console.error('[Main] Distraction return error:', err.message);
    mainWindow?.webContents.send('check-in-complete', '');
  }
}

async function triggerInactivityReturn(daysSince) {
  if (!mainWindow || !activeProjectId) return;
  db.setState('last_checkin_time', new Date().toISOString());
  showWindow();
  mainWindow.webContents.send('check-in-start');
  try {
    const message = await aiCharacter.generateInactivityReturn({
      daysSince,
      projectId: activeProjectId,
      onChunk: (chunk) => mainWindow?.webContents.send('check-in-chunk', chunk),
    });
    db.saveConversation(activeProjectId, message, 'character');
    mainWindow?.webContents.send('check-in-complete', message);
    // Optionally follow up with a progress narrative after user has had time to read
    setTimeout(() => maybeShowProgressNarrative(), 60000);
  } catch (err) {
    console.error('[Main] Inactivity return error:', err.message);
    mainWindow?.webContents.send('check-in-complete', '');
  }
}

async function triggerProjectSwitchWarning(type, names, daySpan) {
  if (!mainWindow || !activeProjectId) return;
  showWindow();
  mainWindow.webContents.send('check-in-start');
  try {
    const message = await aiCharacter.generateProjectSwitchWarning({
      type,
      projectNames: names,
      daySpan,
      onChunk: (chunk) => mainWindow?.webContents.send('check-in-chunk', chunk),
    });
    db.saveConversation(activeProjectId, message, 'character');
    mainWindow?.webContents.send('check-in-complete', message);
  } catch (err) {
    console.error('[Main] Project switch warning error:', err.message);
    mainWindow?.webContents.send('check-in-complete', '');
  }
}

async function triggerQuote(quote) {
  if (!mainWindow || !activeProjectId) return;
  showWindow();
  mainWindow.webContents.send('check-in-start');
  try {
    const message = await aiCharacter.generateQuote({
      quote,
      onChunk: (chunk) => mainWindow?.webContents.send('check-in-chunk', chunk),
    });
    db.saveConversation(activeProjectId, message, 'character');
    mainWindow?.webContents.send('check-in-complete', message);
  } catch (err) {
    console.error('[Main] Quote error:', err.message);
    mainWindow?.webContents.send('check-in-complete', '');
  }
}

async function triggerFileObservation(filePath, content, saveCount) {
  if (!mainWindow || !activeProjectId) return;
  stopSpeaking();
  showWindow();
  mainWindow.webContents.send('check-in-start');
  try {
    const message = await aiCharacter.generateFileObservation({
      filePath,
      content,
      saveCount,
      onChunk: (chunk) => mainWindow?.webContents.send('check-in-chunk', chunk),
    });
    db.saveConversation(activeProjectId, message, 'character');
    mainWindow?.webContents.send('check-in-complete', message);
    if (await shouldSpeak()) speak(message);
  } catch (err) {
    console.error('[Main] File observation error:', err.message);
    mainWindow?.webContents.send('check-in-complete', '');
  }
}

async function triggerProgressNarrative() {
  if (!mainWindow || !activeProjectId) return;
  db.setState('last_progress_date', new Date().toISOString());
  showWindow();
  mainWindow.webContents.send('check-in-start');
  try {
    const message = await aiCharacter.generateProgressNarrative({
      projectId: activeProjectId,
      onChunk: (chunk) => mainWindow?.webContents.send('check-in-chunk', chunk),
    });
    db.saveConversation(activeProjectId, message, 'character');
    mainWindow?.webContents.send('check-in-complete', message);
  } catch (err) {
    console.error('[Main] Progress narrative error:', err.message);
    mainWindow?.webContents.send('check-in-complete', '');
  }
}

// ── IPC ────────────────────────────────────────────────────────────────────

function setupIPC() {
  ipcMain.handle('get-projects',        () => db.getProjects());
  ipcMain.handle('get-active-project-id', () => activeProjectId);

  ipcMain.handle('add-project', async (_, { name, repo_path }) => {
    const project = db.addProject({ name, repo_path });
    if (repo_path) {
      fileWatcher.watchDirectory(project.id, repo_path);
      gitMonitor.watchRepo(project.id, repo_path);
      depMonitor.watchProject(project.id, repo_path);
      secretScanner.watchProject(project.id, repo_path);
    }
    activeProjectId = project.id;
    db.setState('active_project_id', project.id);
    // Resize to popup height after onboarding completes
    mainWindow?.setSize(320, 260);
    return project;
  });

  ipcMain.handle('trigger-check-in', () => triggerCheckIn());

  ipcMain.handle('send-message', async (_, userMessage) => {
    if (!mainWindow || !activeProjectId) return;
    mainWindow.webContents.send('reply-start');
    try {
      const history = db.getConversations(activeProjectId, 12); // oldest-first
      const project = db.getProject(activeProjectId);
      const reply = await aiCharacter.respond({
        userMessage,
        projectId: activeProjectId,
        conversationHistory: history,
        repoPath: project?.repo_path || null,
        onChunk: (chunk) => mainWindow?.webContents.send('reply-chunk', chunk),
      });
      db.saveConversation(activeProjectId, userMessage, 'user');
      db.saveConversation(activeProjectId, reply, 'character');
      mainWindow?.webContents.send('reply-complete', reply);
      if (await shouldSpeak()) speak(reply);
    } catch (err) {
      console.error('[Main] Reply error:', err.message);
      mainWindow?.webContents.send('reply-complete', '');
    }
  });

  ipcMain.handle('show-window', () => showWindow());
  ipcMain.handle('hide-window', () => { stopSpeaking(); hideWindow(); });

  // ── Interests & feeds ────────────────────────────────────────────────────
  ipcMain.handle('get-interests', () => interestManager.getEffective(activeProjectId));
  ipcMain.handle('set-interests', (_, topics) => interestManager.setManual(topics));
  ipcMain.handle('get-feed-urls', () => {
    const raw = db.getState('rss_feeds');
    return raw ? JSON.parse(raw) : [];
  });
  ipcMain.handle('add-feed-url', (_, url) => {
    const raw = db.getState('rss_feeds');
    const existing = raw ? JSON.parse(raw) : [];
    if (!existing.includes(url)) {
      existing.push(url);
      db.setState('rss_feeds', JSON.stringify(existing));
    }
    return existing;
  });

  // ── Camera settings ────────────────────────────────────────────────────────
  ipcMain.handle('get-camera-settings', () => {
    const raw = db.getState('camera_settings');
    try { return raw ? JSON.parse(raw) : { enabled: true, afterHour: null }; }
    catch { return { enabled: true, afterHour: null }; }
  });

  ipcMain.handle('set-camera-settings', (_, settings) => {
    db.setState('camera_settings', JSON.stringify(settings));
  });

  ipcMain.handle('close-settings', () => {
    settingsWindow?.close();
  });

  // ── Voice settings ─────────────────────────────────────────────────────────
  ipcMain.handle('get-voice-settings', () => {
    const raw = db.getState('voice_settings');
    try { return raw ? JSON.parse(raw) : { enabled: false, autoDetect: true }; }
    catch { return { enabled: false, autoDetect: true }; }
  });

  ipcMain.handle('set-voice-settings', (_, settings) => {
    db.setState('voice_settings', JSON.stringify(settings));
  });

  ipcMain.handle('check-headphones', async () => {
    return await detectHeadphones();
  });
}

// ── App lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  await initServices();
  setupIPC();
  createWindow();
  createTray();
  startCheckInTimer();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});

app.on('before-quit', () => {
  if (checkInTimerId) clearInterval(checkInTimerId);
  activityTracker?.stop();
  appTracker?.stop();
  gitMonitor?.stopAll();
  fileWatcher?.stopAll();
  feedFetcher?.stop();
  depMonitor?.stopAll();
  secretScanner?.stopAll();
  spendTracker?.stop();
  settingsWindow?.close();
  stopSpeaking();
});
