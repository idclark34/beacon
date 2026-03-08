'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { execFile }  = require('child_process');
const https         = require('https');
const os            = require('os');
const fs            = require('fs');
const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');

const DB              = require('./services/database');
const GitMonitor      = require('./services/git-monitor');
const FileWatcher     = require('./services/file-watcher');
const ActivityTracker = require('./services/activity-tracker');
const { AICharacter } = require('./services/ai-character');
const AppTracker      = require('./services/app-tracker');
const InterestManager = require('./services/interest-manager');
const FeedFetcher     = require('./services/feed-fetcher');
const DepMonitor           = require('./services/dep-monitor');
const SecretScanner        = require('./services/secret-scanner');
const SpendTracker         = require('./services/spend-tracker');
const CodeQualityScanner   = require('./services/code-quality-scanner');
const PromptWatcher        = require('./services/prompt-watcher');
const CheckInEngine        = require('./services/check-in-engine');

// ── State ──────────────────────────────────────────────────────────────────

let mainWindow = null;
let settingsWindow = null;
let tray = null;
let db, gitMonitor, fileWatcher, activityTracker, aiCharacter, appTracker;
let interestManager, feedFetcher, depMonitor, secretScanner, spendTracker, codeQualityScanner, promptWatcher;
let engine = null;
let activeProjectId = null;
let brainstormHistory = [];   // { role, content }[]   — ephemeral brainstorm session
let brainstormProjectId = null; // project the current history belongs to

// ── Window ─────────────────────────────────────────────────────────────────

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: 420,
    height: 280,
    x: width - 440,   // 420px wide + 20px right margin
    y: height - 300,  // 280px tall + 20px bottom margin
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
  // 16x16 "A" monogram icon drawn with nativeImage (no external file needed)
  const size = 16;
  const ICON_ROWS = [
    '0000000000000000',
    '0000011110000000',  // peak
    '0000011110000000',
    '0000110011000000',
    '0000110011000000',
    '0001100001100000',
    '0001111111100000',  // crossbar
    '0001111111100000',
    '0001100001100000',
    '0011000000110000',
    '0011000000110000',
    '0110000000011000',
    '0110000000011000',
    '0000000000000000',
    '0000000000000000',
    '0000000000000000',
  ];
  const canvas = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (ICON_ROWS[y][x] !== '1') continue;
      const i = (y * size + x) * 4;
      canvas[i]     = 74;   // R  (#4ade80 green)
      canvas[i + 1] = 222;  // G
      canvas[i + 2] = 128;  // B
      canvas[i + 3] = 255;  // A
    }
  }
  const icon = nativeImage.createFromBuffer(canvas, { width: size, height: size });
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('Outpost is watching 👀');

  const menu = Menu.buildFromTemplate([
    { label: 'Check in now', click: () => engine.triggerCheckIn() },
    { label: 'Look at me', click: () => engine.triggerVisualObservation() },
    { label: 'Comment on music', click: () => {
      const music = appTracker.getCurrentMusic();
      if (!music) { console.log('[Tray] No music detected'); return; }
      const projectId = activeProjectId;
      engine._triggerMusicComment(projectId, music);
    }},
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
  appTracker.onClaudeSessionEnd = async (sessionMinutes, projectName, sessionStartMs) => {
    await engine?.onClaudeSessionEnd(sessionMinutes, projectName, sessionStartMs);
  };
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

  fileWatcher.onHotFile = async (projectId, relativePath, absolutePath, saveCount) => {
    await engine?.onHotFile(projectId, relativePath, absolutePath, saveCount);
  };

  gitMonitor.onSignificantEvent = async (projectId, commitCount, changedFiles = []) => {
    console.log(`[Main] ${commitCount} new commits on project ${projectId}`);
    if (projectId === activeProjectId) {
      await engine?.onCommits(projectId, changedFiles);
    }
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
    if (projectId === activeProjectId) engine?.triggerDepAlert(projectId, issues);
  };

  secretScanner = new SecretScanner();
  for (const project of db.getProjects()) {
    if (project.repo_path) secretScanner.watchProject(project.id, project.repo_path);
  }
  secretScanner.onSecretsFound = (projectId, findings, commitHash) => {
    // 1hr cooldown — still urgent, just don't spam on rapid commits
    const last = db.getState('last_secret_alert_time');
    if (last && Date.now() - new Date(last) < 60 * 60 * 1000) return;
    engine?.triggerSecretAlert(projectId, findings, commitHash);
  };

  spendTracker = new SpendTracker(db);
  spendTracker.onThresholdAlert = (pct, spent, budget) =>
    engine?.triggerSpendAlert('threshold', { pct, spent, budget });
  spendTracker.onHighBurnRate = (dailyRate, projected, budget) =>
    engine?.triggerSpendAlert('burn_rate', { dailyRate, projected, budget });
  spendTracker.onLowUsage = (pct, spent, budget) =>
    engine?.triggerSpendAlert('low_usage', { pct, spent, budget });
  spendTracker.start();

  codeQualityScanner = new CodeQualityScanner();
  for (const project of db.getProjects()) {
    if (project.repo_path) codeQualityScanner.watchProject(project.id, project.repo_path);
  }
  codeQualityScanner.onFindingsFound = (projectId, findings) => {
    if (projectId !== activeProjectId) return;
    const last = db.getState('last_code_quality_alert');
    if (last && (Date.now() - new Date(last)) < 4 * 60 * 60 * 1000) return;
    engine?.onCodeQualityFindings(projectId, findings);
  };

  // ── Prompt watcher — reads Claude Code JSONL sessions ─────────────────────
  promptWatcher = new PromptWatcher();
  for (const project of db.getProjects()) {
    if (project.repo_path) promptWatcher.watchProject(project.id, project.repo_path);
  }
  promptWatcher.onPromptComplete = async (projectId, repoPath, promptText) => {
    await engine?.onPromptComplete(projectId, repoPath, promptText);
  };
}

// ── Camera frame capture ────────────────────────────────────────────────────

/**
 * Ask the renderer to capture a webcam frame and return it as base64 JPEG.
 * Resolves null if the window isn't ready, camera is denied, or times out.
 */
function captureFrame() {
  if (!mainWindow) return Promise.resolve(null);
  return new Promise((resolve) => {
    function onFrame(_, frameData) {
      clearTimeout(timeout);
      ipcMain.removeListener('frame-captured', onFrame);
      resolve(frameData || null);
    }
    const timeout = setTimeout(() => {
      ipcMain.removeListener('frame-captured', onFrame);
      resolve(null);
    }, 5000);
    ipcMain.on('frame-captured', onFrame);
    mainWindow.webContents.send('capture-frame');
  });
}

// ── Voice / TTS ─────────────────────────────────────────────────────────────

const ELEVENLABS_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb'; // George
const TMP_SPEECH_FILE     = path.join(os.tmpdir(), 'alfred-speech.mp3');

let currentSpeech  = null; // afplay / say process
let currentRequest = null; // in-flight ElevenLabs https request

function _stripMarkdown(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`[^`]+`/g, '')
    .replace(/[_~]/g, '')
    .trim();
}

function _speakFallback(clean) {
  currentSpeech = execFile('say', ['-v', 'Daniel', '-r', '165', clean], () => {
    currentSpeech = null;
    mainWindow?.webContents.send('speaking-end');
  });
}

function speak(text) {
  if (!text) return;
  stopSpeaking();
  const clean = _stripMarkdown(text);
  if (!clean) return;

  mainWindow?.webContents.send('speaking-start');

  if (!process.env.ELEVENLABS_API_KEY) {
    _speakFallback(clean);
    return;
  }

  const body = JSON.stringify({
    text: clean,
    model_id: 'eleven_turbo_v2_5',
    voice_settings: { stability: 0.5, similarity_boost: 0.75 },
  });

  const req = https.request({
    hostname: 'api.elevenlabs.io',
    path:     `/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
    method:   'POST',
    headers: {
      'xi-api-key':     process.env.ELEVENLABS_API_KEY,
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, (res) => {
    currentRequest = null;
    if (res.statusCode !== 200) {
      let errBody = '';
      res.on('data', d => { errBody += d; });
      res.on('end', () => console.error(`[Voice] ElevenLabs ${res.statusCode}:`, errBody));
      _speakFallback(clean);
      return;
    }
    const file = fs.createWriteStream(TMP_SPEECH_FILE);
    res.pipe(file);
    file.on('finish', () => {
      file.close();
      currentSpeech = execFile('afplay', [TMP_SPEECH_FILE], () => {
        currentSpeech = null;
        mainWindow?.webContents.send('speaking-end');
      });
    });
  });

  req.on('error', (err) => {
    console.error('[Voice] ElevenLabs error:', err.message, '— falling back to say');
    currentRequest = null;
    _speakFallback(clean);
  });

  req.write(body);
  req.end();
  currentRequest = req;
}

function stopSpeaking() {
  const wasSpeaking = !!(currentRequest || currentSpeech);
  if (currentRequest) { currentRequest.destroy(); currentRequest = null; }
  if (currentSpeech)  { currentSpeech.kill('SIGTERM'); currentSpeech = null; }
  if (wasSpeaking) mainWindow?.webContents.send('speaking-end');
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
      codeQualityScanner.watchProject(project.id, repo_path);
      promptWatcher.watchProject(project.id, repo_path);
    }
    activeProjectId = project.id;
    db.setState('active_project_id', project.id);
    // Resize to popup dimensions after onboarding completes
    mainWindow?.setSize(420, 280);
    return project;
  });

  ipcMain.handle('trigger-check-in', () => engine.triggerCheckIn());

  ipcMain.handle('send-message', async (_, userMessage) => {
    if (!mainWindow || !activeProjectId) return;
    mainWindow.webContents.send('reply-start');
    try {
      const history = db.getConversations(activeProjectId, 12); // oldest-first
      const project = db.getProject(activeProjectId);
      db.saveConversation(activeProjectId, userMessage, 'user');
      const reply = await aiCharacter.respond({
        userMessage,
        projectId: activeProjectId,
        conversationHistory: history,
        repoPath: project?.repo_path || null,
        onChunk: (chunk) => mainWindow?.webContents.send('reply-chunk', chunk),
      });
      db.saveConversation(activeProjectId, reply, 'character');
      mainWindow?.webContents.send('reply-complete', reply);
      if (await shouldSpeak()) speak(reply);
    } catch (err) {
      console.error('[Main] Reply error:', err.message);
      mainWindow?.webContents.send('reply-complete', '');
    }
  });

  ipcMain.handle('send-brainstorm', async (_, userMessage) => {
    if (!mainWindow) return;
    if (activeProjectId !== brainstormProjectId) {
      brainstormHistory = [];
      brainstormProjectId = activeProjectId;
    }
    mainWindow.webContents.send('reply-start');
    try {
      const bsProject = activeProjectId ? db.getProject(activeProjectId) : null;
      const architectureContext = [
        'services/ai-character.js  — generator layer: all generate*() methods live here, each encapsulates its own system prompt',
        'services/check-in-engine.js — dispatch layer: decides WHEN to fire each observation; calls every generate*() method from ai-character.js',
        'main.js                    — orchestration: app lifecycle, IPC handlers, routes events to CheckInEngine',
        'renderer/app.js            — UI: renders Alfred\'s messages, handles chat/brainstorm state',
        'preload.js                 — IPC bridge between main and renderer',
        '',
        'Electron IPC pattern: a function defined once in main.js may appear in multiple files without being duplicated.',
        '  - main.js defines it (e.g. function showWindow())',
        '  - main.js registers it as an IPC handler (ipcMain.handle)',
        '  - preload.js bridges it to the renderer (ipcRenderer.invoke)',
        '  - services receive it via dependency injection (constructor args)',
        'Seeing a name in 3 files does NOT mean it lives in 3 places. Check for "function X()" to find the single definition.',
      ].join('\n');
      let fullResponse = '';
      await aiCharacter.respondBrainstorm({
        userMessage,
        conversationHistory: brainstormHistory.slice(-12),
        repoPath: bsProject?.repo_path || null,
        architectureContext,
        onChunk: (chunk) => { fullResponse += chunk; },
      });
      const planReady = fullResponse.includes('[PLAN_READY]');
      const clean = fullResponse.replace(/\s*\[PLAN_READY\]\s*/g, '').trim();
      brainstormHistory.push({ role: 'user', content: userMessage });
      brainstormHistory.push({ role: 'assistant', content: clean });
      mainWindow?.webContents.send('reply-chunk', clean);
      mainWindow?.webContents.send('reply-complete', clean);
      if (planReady) {
        mainWindow?.webContents.send('check-in-action', { actionId: 'plan-ready', label: 'Looks good →' });
      }
    } catch (err) {
      console.error('[Main] Brainstorm error:', err.message);
      mainWindow?.webContents.send('reply-complete', '');
    }
  });

  ipcMain.handle('clear-brainstorm', () => { brainstormHistory = []; brainstormProjectId = null; });

  ipcMain.handle('show-window', () => showWindow());
  ipcMain.handle('hide-window', () => { stopSpeaking(); hideWindow(); });

  // ── Interests & feeds ────────────────────────────────────────────────────
  ipcMain.handle('get-interests', () => interestManager.getEffective(activeProjectId));
  ipcMain.handle('set-interests', (_, topics) => interestManager.setManual(topics));
  ipcMain.handle('get-feed-urls', () => {
    const raw = db.getState('rss_feeds');
    try { return raw ? JSON.parse(raw) : []; } catch { return []; }
  });
  ipcMain.handle('add-feed-url', (_, url) => {
    const raw = db.getState('rss_feeds');
    let existing;
    try { existing = raw ? JSON.parse(raw) : []; } catch { existing = []; }
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

  ipcMain.handle('trigger-action', async (_, actionId) => {
    await engine.handleAction(actionId);
  });

  ipcMain.handle('apply-code-quality-proposal', async (_, { projectId, approvedFiles }) => {
    await engine.applyCodeQualityProposal({ projectId, approvedFiles });
  });
}

// ── App lifecycle ──────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  await initServices();

  engine = new CheckInEngine({
    db,
    aiCharacter,
    appTracker,
    activityTracker,
    gitMonitor,
    getWindow:          () => mainWindow,
    getActiveProjectId: () => activeProjectId,
    showWindow,
    speak,
    stopSpeaking,
    shouldSpeak,
    captureFrame,
  });

  setupIPC();
  createWindow();
  createTray();
  engine.start();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});

app.on('before-quit', () => {
  engine?.stop();
  activityTracker?.stop();
  appTracker?.stop();
  gitMonitor?.stopAll();
  fileWatcher?.stopAll();
  feedFetcher?.stop();
  depMonitor?.stopAll();
  secretScanner?.stopAll();
  codeQualityScanner?.stopAll();
  promptWatcher?.stopAll();
  spendTracker?.stop();
  settingsWindow?.close();
  stopSpeaking();
});
