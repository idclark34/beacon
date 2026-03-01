'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { app, BrowserWindow, ipcMain, screen, shell } = require('electron');

const DB = require('./services/database');
const GitMonitor = require('./services/git-monitor');
const FileWatcher = require('./services/file-watcher');
const ActivityTracker = require('./services/activity-tracker');
const AICharacter = require('./services/ai-character');

// ── State ──────────────────────────────────────────────────────────────────

let mainWindow = null;
let db, gitMonitor, fileWatcher, activityTracker, aiCharacter;
let activeProjectId = null;
let checkInTimerId = null;

// ── Window ─────────────────────────────────────────────────────────────────

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: 340,
    height: 520,
    x: Math.max(0, width - 360),
    y: Math.max(0, height - 540),
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    resizable: true,
    minWidth: 280,
    minHeight: 300,
    skipTaskbar: false,
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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── Services init ──────────────────────────────────────────────────────────

async function initServices() {
  db = new DB();
  db.initialize();

  aiCharacter = new AICharacter(db);
  gitMonitor = new GitMonitor(db);
  fileWatcher = new FileWatcher(db);
  activityTracker = new ActivityTracker(db, fileWatcher);

  // Restore active project
  const savedProjectId = db.getState('active_project_id');
  if (savedProjectId) {
    activeProjectId = parseInt(savedProjectId, 10);
  }

  // Watch all existing projects
  const projects = db.getProjects();
  for (const project of projects) {
    if (project.repo_path) {
      fileWatcher.watchDirectory(project.id, project.repo_path);
      gitMonitor.watchRepo(project.id, project.repo_path);
    }
  }

  // Auto-set active project from file activity
  fileWatcher.onProjectSwitch = (projectId) => {
    if (activeProjectId !== projectId) {
      activeProjectId = projectId;
      db.setState('active_project_id', projectId);
      mainWindow?.webContents.send('project-switched', projectId);
    }
  };

  // Trigger check-in on significant git event
  gitMonitor.onSignificantEvent = (projectId, commitCount) => {
    console.log(`[Main] Significant git event: ${commitCount} commits for project ${projectId}`);
    if (projectId === activeProjectId) {
      scheduleCheckIn(2000); // 2 sec delay so UI is ready
    }
  };

  activityTracker.start();
}

// ── Check-in logic ─────────────────────────────────────────────────────────

const CHECK_IN_INTERVAL_MS = 5 * 60 * 1000;   // check every 5 min
const ACTIVE_THRESHOLD_MINUTES = 120;           // 2 hours of activity triggers check-in
const IDLE_BEFORE_CHECKIN_MINUTES = 5;          // wait for 5min idle before interrupting

function startCheckInTimer() {
  checkInTimerId = setInterval(async () => {
    if (!activeProjectId || !mainWindow) return;

    const lastCheckIn = db.getState('last_checkin_time');
    const lastCheckInDate = lastCheckIn ? new Date(lastCheckIn) : new Date(0);
    const activeMinutesSinceLastCheckIn = db.getActiveMinutesSince(
      activeProjectId,
      lastCheckInDate
    );

    // Check: enough active time has elapsed since last check-in
    if (activeMinutesSinceLastCheckIn >= ACTIVE_THRESHOLD_MINUTES) {
      // Check: currently idle (haven't had file saves in the last 5 min)
      const recentlySaved = activityTracker.isRecentlyActive(
        activeProjectId,
        IDLE_BEFORE_CHECKIN_MINUTES
      );
      if (!recentlySaved) {
        await triggerCheckIn();
      }
    }
  }, CHECK_IN_INTERVAL_MS);
}

function scheduleCheckIn(delayMs = 0) {
  setTimeout(triggerCheckIn, delayMs);
}

async function triggerCheckIn() {
  if (!mainWindow || !activeProjectId) return;

  console.log('[Main] Triggering check-in for project', activeProjectId);
  db.setState('last_checkin_time', new Date().toISOString());

  mainWindow.webContents.send('check-in-start');

  try {
    let fullMessage = '';
    const projectId = activeProjectId;

    const convHistory = db.getConversations(projectId, 6);
    fullMessage = await aiCharacter.generateCheckIn({
      projectId,
      onChunk: (chunk) => {
        mainWindow?.webContents.send('check-in-chunk', chunk);
      },
    });

    // Persist to DB
    db.saveConversation(projectId, fullMessage, 'character');
    mainWindow?.webContents.send('check-in-complete', fullMessage);
  } catch (err) {
    console.error('[Main] Check-in error:', err.message);
    mainWindow?.webContents.send('check-in-complete', "Hey, checking in — how's it going?");
  }
}

// ── IPC handlers ───────────────────────────────────────────────────────────

function setupIPC() {
  // Projects
  ipcMain.handle('get-projects', () => db.getProjects());

  ipcMain.handle('add-project', async (_, { name, repo_path }) => {
    const project = db.addProject({ name, repo_path });
    if (repo_path) {
      fileWatcher.watchDirectory(project.id, repo_path);
      gitMonitor.watchRepo(project.id, repo_path);
    }
    if (!activeProjectId) {
      activeProjectId = project.id;
      db.setState('active_project_id', project.id);
    }
    return project;
  });

  ipcMain.handle('set-active-project', (_, id) => {
    activeProjectId = id;
    db.setState('active_project_id', id);
    return id;
  });

  ipcMain.handle('get-active-project-id', () => activeProjectId);

  // Conversations
  ipcMain.handle('get-conversations', (_, limit = 50) => {
    if (!activeProjectId) return [];
    return db.getConversations(activeProjectId, limit);
  });

  ipcMain.handle('send-message', async (_, text) => {
    if (!text?.trim()) return null;
    if (!activeProjectId) {
      mainWindow?.webContents.send('message-error', 'No active project set. Add a project first!');
      return null;
    }

    const projectId = activeProjectId;

    // Save user message
    db.saveConversation(projectId, text, 'user');

    // Get recent history for context
    const history = db.getConversations(projectId, 12);

    let fullResponse = '';

    try {
      fullResponse = await aiCharacter.respond({
        userMessage: text,
        projectId,
        conversationHistory: history,
        onChunk: (chunk) => {
          mainWindow?.webContents.send('message-chunk', chunk);
        },
      });

      // Save character response
      db.saveConversation(projectId, fullResponse, 'character');
      mainWindow?.webContents.send('message-complete', fullResponse);
    } catch (err) {
      console.error('[Main] Message error:', err.message);
      const errMsg = err.message.includes('ANTHROPIC_API_KEY')
        ? 'API key not set — add it to your .env file.'
        : `Error: ${err.message}`;
      mainWindow?.webContents.send('message-error', errMsg);
    }

    return fullResponse;
  });

  // Goals
  ipcMain.handle('add-goal', (_, text) => {
    if (!activeProjectId || !text?.trim()) return null;
    db.addGoal(activeProjectId, text);
    return db.getActiveGoals(activeProjectId);
  });

  ipcMain.handle('get-goals', () => {
    if (!activeProjectId) return [];
    return db.getActiveGoals(activeProjectId);
  });

  // Activity
  ipcMain.handle('get-activity-summary', () => {
    if (!activeProjectId) return null;
    return db.getActivitySummary(activeProjectId, 24);
  });

  // Window controls
  ipcMain.handle('minimize-window', () => {
    mainWindow?.minimize();
  });

  ipcMain.handle('close-window', () => {
    mainWindow?.hide();
  });
}

// ── App lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  await initServices();
  setupIPC();
  createWindow();
  startCheckInTimer();
});

app.on('window-all-closed', () => {
  // Keep running in background on macOS
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
  else mainWindow.show();
});

app.on('before-quit', () => {
  if (checkInTimerId) clearInterval(checkInTimerId);
  activityTracker?.stop();
  gitMonitor?.stopAll();
  fileWatcher?.stopAll();
});
