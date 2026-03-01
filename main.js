'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');

const DB              = require('./services/database');
const GitMonitor      = require('./services/git-monitor');
const FileWatcher     = require('./services/file-watcher');
const ActivityTracker = require('./services/activity-tracker');
const AICharacter     = require('./services/ai-character');
const AppTracker      = require('./services/app-tracker');
const InterestManager = require('./services/interest-manager');
const FeedFetcher     = require('./services/feed-fetcher');

// ── State ──────────────────────────────────────────────────────────────────

let mainWindow = null;
let tray = null;
let db, gitMonitor, fileWatcher, activityTracker, aiCharacter, appTracker;
let interestManager, feedFetcher;
let activeProjectId = null;
let checkInTimerId  = null;

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

  gitMonitor.onSignificantEvent = (projectId, commitCount) => {
    console.log(`[Main] ${commitCount} new commits on project ${projectId}`);
    if (projectId === activeProjectId) scheduleCheckIn(1500);
  };

  activityTracker.start();

  interestManager = new InterestManager(db);
  feedFetcher = new FeedFetcher();
  feedFetcher.start(db, interestManager, () => activeProjectId);
}

// ── Check-in ───────────────────────────────────────────────────────────────

const CHECK_POLL_MS         = 5 * 60 * 1000;  // poll every 5 min
const ACTIVE_THRESHOLD_MIN  = 30;             // 30 min of activity since last check-in
const IDLE_GATE_MIN         = 3;              // wait for 3 min idle before popping up

function startCheckInTimer() {
  checkInTimerId = setInterval(async () => {
    if (!activeProjectId || !mainWindow) return;

    // Weekly recap — fires once per week if there's data
    if (await maybeShowWeeklyRecap()) return;

    // High-relevance intel drop — fires when idle + high-score items waiting
    if (await maybeShowIntelDrop()) return;

    // First-session intro — fires once after 10 active minutes
    if (await maybeShowIntroCheckIn()) return;

    // Regular check-in
    const lastCheckIn   = db.getState('last_checkin_time');
    const since         = lastCheckIn ? new Date(lastCheckIn) : new Date(0);
    const activeMinutes = db.getActiveMinutesSince(activeProjectId, since);

    if (activeMinutes >= ACTIVE_THRESHOLD_MIN) {
      const recentlyActive = activityTracker.isRecentlyActive(activeProjectId, IDLE_GATE_MIN);
      if (!recentlyActive) await triggerCheckIn();
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

function scheduleCheckIn(delayMs = 0) {
  setTimeout(triggerCheckIn, delayMs);
}

async function triggerCheckIn() {
  if (!mainWindow || !activeProjectId) return;

  db.setState('last_checkin_time', new Date().toISOString());
  showWindow();
  mainWindow.webContents.send('check-in-start');

  try {
    const message = await aiCharacter.generateCheckIn({
      projectId: activeProjectId,
      onChunk: (chunk) => mainWindow?.webContents.send('check-in-chunk', chunk),
    });
    db.saveConversation(activeProjectId, message, 'character');
    mainWindow?.webContents.send('check-in-complete', message);
  } catch (err) {
    console.error('[Main] Check-in error:', err.message);
    mainWindow?.webContents.send('check-in-complete', "Hey — how's it going?");
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
      const reply = await aiCharacter.respond({
        userMessage,
        projectId: activeProjectId,
        conversationHistory: history,
        onChunk: (chunk) => mainWindow?.webContents.send('reply-chunk', chunk),
      });
      db.saveConversation(activeProjectId, userMessage, 'user');
      db.saveConversation(activeProjectId, reply, 'character');
      mainWindow?.webContents.send('reply-complete', reply);
    } catch (err) {
      console.error('[Main] Reply error:', err.message);
      mainWindow?.webContents.send('reply-complete', '');
    }
  });

  ipcMain.handle('show-window', () => showWindow());
  ipcMain.handle('hide-window', () => hideWindow());

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
});
