'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');

const DB           = require('./services/database');
const GitMonitor   = require('./services/git-monitor');
const FileWatcher  = require('./services/file-watcher');
const ActivityTracker = require('./services/activity-tracker');
const AICharacter  = require('./services/ai-character');

// ── State ──────────────────────────────────────────────────────────────────

let mainWindow = null;
let tray = null;
let db, gitMonitor, fileWatcher, activityTracker, aiCharacter;
let activeProjectId = null;
let checkInTimerId  = null;

// ── Window ─────────────────────────────────────────────────────────────────

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: 320,
    height: 180,      // compact — just the popup card
    x: width - 340,
    y: height - 200,
    alwaysOnTop: true,
    frame: false,
    transparent: true,
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
  tray.setToolTip('Outpost Companion');

  const menu = Menu.buildFromTemplate([
    { label: 'Check in now', click: () => triggerCheckIn() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => triggerCheckIn());
}

// ── Services ───────────────────────────────────────────────────────────────

async function initServices() {
  db           = new DB();
  db.initialize();
  aiCharacter  = new AICharacter(db);
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
}

// ── Check-in ───────────────────────────────────────────────────────────────

const CHECK_POLL_MS         = 5 * 60 * 1000;  // poll every 5 min
const ACTIVE_THRESHOLD_MIN  = 120;             // 2h of activity since last check-in
const IDLE_GATE_MIN         = 5;               // wait for 5 min idle before popping up

function startCheckInTimer() {
  checkInTimerId = setInterval(async () => {
    if (!activeProjectId || !mainWindow) return;

    const lastCheckIn   = db.getState('last_checkin_time');
    const since         = lastCheckIn ? new Date(lastCheckIn) : new Date(0);
    const activeMinutes = db.getActiveMinutesSince(activeProjectId, since);

    if (activeMinutes >= ACTIVE_THRESHOLD_MIN) {
      const recentlyActive = activityTracker.isRecentlyActive(activeProjectId, IDLE_GATE_MIN);
      if (!recentlyActive) await triggerCheckIn();
    }
  }, CHECK_POLL_MS);
}

function scheduleCheckIn(delayMs = 0) {
  setTimeout(triggerCheckIn, delayMs);
}

async function triggerCheckIn() {
  if (!mainWindow || !activeProjectId) return;

  db.setState('last_checkin_time', new Date().toISOString());
  mainWindow.webContents.send('check-in-start');
  showWindow();

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
    mainWindow?.setSize(320, 180);
    return project;
  });

  ipcMain.handle('trigger-check-in', () => triggerCheckIn());

  ipcMain.handle('send-message', async (_, text) => {
    if (!text?.trim() || !activeProjectId) return;
    db.saveConversation(activeProjectId, text, 'user');

    const history = db.getConversations(activeProjectId, 6);
    try {
      const response = await aiCharacter.respond({
        userMessage: text,
        projectId: activeProjectId,
        conversationHistory: history,
        onChunk: (chunk) => mainWindow?.webContents.send('message-chunk', chunk),
      });
      db.saveConversation(activeProjectId, response, 'character');
      mainWindow?.webContents.send('message-complete', response);
    } catch (err) {
      mainWindow?.webContents.send('message-error', err.message);
    }
  });

  ipcMain.handle('show-window', () => showWindow());
  ipcMain.handle('hide-window', () => hideWindow());
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
  gitMonitor?.stopAll();
  fileWatcher?.stopAll();
});
