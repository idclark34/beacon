'use strict';

const $ = id => document.getElementById(id);

// ── Typewriter queue ────────────────────────────────────────────────────────

let typeQueue = [];
let typeRunning = false;
let chatEnabled = false;
let replyPending = false;
const CHARS_PER_FRAME = 40;

function drainTypeQueue() {
  if (typeQueue.length === 0) { typeRunning = false; return; }
  const chunk = typeQueue.splice(0, CHARS_PER_FRAME).join('');
  $('popup-text').textContent += chunk;
  requestAnimationFrame(drainTypeQueue);
}

function enqueue(text) {
  typeQueue.push(...text.split(''));
  if (!typeRunning) {
    typeRunning = true;
    requestAnimationFrame(drainTypeQueue);
  }
}

// ── Animation helpers ───────────────────────────────────────────────────────

function dismissWithAnimation() {
  // Stop any running countdown so its animationend doesn't double-fire
  const bar = $('countdown-bar');
  bar.classList.remove('draining');

  const app = $('app');
  app.classList.remove('entering');
  app.classList.add('exiting');
  app.addEventListener('animationend', () => {
    app.classList.remove('exiting');
    window.api.hideWindow();
  }, { once: true });
}

function startCountdown() {
  const bar = $('countdown-bar');
  void bar.offsetWidth; // force reflow so animation restarts cleanly
  bar.classList.add('draining');
  bar.addEventListener('animationend', () => {
    dismissWithAnimation();
  }, { once: true });
}

// ── Streaming helpers ───────────────────────────────────────────────────────

function startStream() {
  $('popup-text').textContent = '';
  typeQueue = [];
  typeRunning = false;
  $('popup-cursor').classList.remove('hidden');
  $('app').classList.add('streaming');

  // Reset countdown bar (remove class to kill any running animation)
  const bar = $('countdown-bar');
  bar.classList.remove('draining');
  bar.style.opacity = '0';
}

function appendChunk(text) {
  enqueue(text);
}

function endStream() {
  // Wait for typewriter queue to drain before closing out
  const waitForQueue = () => {
    if (typeQueue.length > 0 || typeRunning) {
      requestAnimationFrame(waitForQueue);
      return;
    }
    $('popup-cursor').classList.add('hidden');
    $('app').classList.remove('streaming');
    showChatInput();
    startCountdown();
  };
  requestAnimationFrame(waitForQueue);
}

// ── Chat / reply helpers ────────────────────────────────────────────────────

function showChatInput() {
  chatEnabled = true;
  $('chat-area').classList.add('visible');
}

function startReplyStream() {
  $('chat-area').classList.remove('visible');
  $('chat-input').disabled = true;
  $('countdown-bar').classList.remove('draining');
  $('popup-text').textContent = '';
  typeQueue = []; typeRunning = false;
  $('popup-cursor').classList.remove('hidden');
  $('app').classList.add('streaming');
}

function endReply() {
  const wait = () => {
    if (typeQueue.length > 0 || typeRunning) { requestAnimationFrame(wait); return; }
    $('popup-cursor').classList.add('hidden');
    $('app').classList.remove('streaming');
    replyPending = false;
    setTimeout(() => dismissWithAnimation(), 1500);
  };
  requestAnimationFrame(wait);
}

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  const projects = await window.api.getProjects();

  if (projects.length === 0) {
    showOnboarding();
  } else {
    const activeId = await window.api.getActiveProjectId();
    const project = projects.find(p => p.id === activeId) || projects[0];
    showPopup(project);
  }

  setupListeners();
  setupIPCListeners();
}

// ── Views ──────────────────────────────────────────────────────────────────

function showOnboarding() {
  $('onboarding').classList.remove('hidden');
  $('popup').classList.add('hidden');
  $('ob-name').focus();
}

function showPopup() {
  $('onboarding').classList.add('hidden');
  $('popup').classList.remove('hidden');
}

// ── IPC Listeners ──────────────────────────────────────────────────────────

function setupIPCListeners() {
  // Entry animation — triggered by main just before showInactive()
  window.api.onWindowShow(() => {
    const app = $('app');
    app.classList.remove('exiting');
    app.classList.add('entering');
    app.addEventListener('animationend', () => {
      app.classList.remove('entering');
    }, { once: true });
  });

  window.api.onCheckIn(({ type, text }) => {
    if (type === 'start') {
      // Reset chat state before each fresh check-in
      chatEnabled = false; replyPending = false;
      $('chat-input').value = ''; $('chat-input').disabled = false;
      $('chat-area').classList.remove('visible');
      $('popup').classList.remove('chatting');
      startStream();
    } else if (type === 'chunk') {
      appendChunk(text);
    } else if (type === 'complete') {
      endStream();
    }
  });

  window.api.onReply(({ type, text }) => {
    if (type === 'start')       startReplyStream();
    else if (type === 'chunk')  appendChunk(text);
    else if (type === 'complete') endReply();
  });
}

// ── Event Listeners ────────────────────────────────────────────────────────

function setupListeners() {
  // Onboarding submit
  $('ob-submit').addEventListener('click', handleSetup);
  $('ob-path').addEventListener('keydown', e => { if (e.key === 'Enter') handleSetup(); });
  $('ob-name').addEventListener('keydown', e => { if (e.key === 'Enter') $('ob-path').focus(); });

  // Dismiss popup on × or Escape
  $('popup-dismiss').addEventListener('click', () => dismissWithAnimation());
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if ($('popup').classList.contains('hidden')) return;
    const ci = $('chat-input');
    if (document.activeElement === ci) {
      if (ci.value.length > 0) { ci.value = ''; }
      else { ci.blur(); dismissWithAnimation(); }
    } else {
      dismissWithAnimation();
    }
  });

  // Resume countdown when window loses focus (user switches apps mid-chat)
  window.addEventListener('blur', () => {
    $('popup').classList.remove('chatting');
    $('chat-input').blur();
  });

  // Chat input
  const chatInput = $('chat-input');
  chatInput.addEventListener('focus', () => $('popup').classList.add('chatting'));
  chatInput.addEventListener('blur',  () => $('popup').classList.remove('chatting'));
  chatInput.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const text = chatInput.value.trim();
    if (!text || replyPending || !chatEnabled) return;
    replyPending = true; chatEnabled = false; chatInput.disabled = true;
    $('popup').classList.remove('chatting');
    try { await window.api.sendMessage(text); }
    catch { dismissWithAnimation(); }
  });
}

async function handleSetup() {
  const name = $('ob-name').value.trim();
  if (!name) { $('ob-name').focus(); return; }

  $('ob-submit').disabled = true;
  $('ob-submit').textContent = 'Setting up...';

  try {
    const project = await window.api.addProject({
      name,
      repo_path: $('ob-path').value.trim() || null,
    });
    showPopup(project);
    await window.api.triggerCheckIn();
  } catch (err) {
    $('ob-submit').textContent = 'Error — try again';
    $('ob-submit').disabled = false;
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────

init().catch(console.error);
