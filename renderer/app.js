'use strict';

const $ = id => document.getElementById(id);

// ── State ──────────────────────────────────────────────────────────────────

let isStreaming = false;

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

function showPopup(project) {
  $('onboarding').classList.add('hidden');
  $('popup').classList.remove('hidden');
  $('popup-project').textContent = project?.name || '';
}

// ── Streaming helpers ──────────────────────────────────────────────────────

function startStream() {
  isStreaming = true;
  $('popup-text').textContent = '';
  $('popup-cursor').classList.remove('hidden');
  $('popup-avatar').classList.add('pulsing');
  $('popup-reply-area').classList.add('hidden');
  $('popup-reply').value = '';
}

function appendChunk(text) {
  $('popup-text').textContent += text;
}

function endStream() {
  isStreaming = false;
  $('popup-cursor').classList.add('hidden');
  $('popup-avatar').classList.remove('pulsing');
  // Show reply field after message appears
  $('popup-reply-area').classList.remove('hidden');
  $('popup-reply').focus();
}

// ── IPC Listeners ──────────────────────────────────────────────────────────

function setupIPCListeners() {
  // Check-in: character initiates
  window.api.onCheckIn(({ type, text }) => {
    if (type === 'start') {
      startStream();
      window.api.showWindow();
    } else if (type === 'chunk') {
      appendChunk(text);
    } else if (type === 'complete') {
      endStream();
    }
  });

  // Reply response (after user types something)
  window.api.onMessageChunk(text => appendChunk(text));
  window.api.onMessageComplete(() => endStream());
  window.api.onMessageError(err => {
    $('popup-text').textContent = err;
    endStream();
  });
}

// ── Event Listeners ────────────────────────────────────────────────────────

function setupListeners() {
  // Onboarding submit
  $('ob-submit').addEventListener('click', handleSetup);
  $('ob-path').addEventListener('keydown', e => { if (e.key === 'Enter') handleSetup(); });
  $('ob-name').addEventListener('keydown', e => { if (e.key === 'Enter') $('ob-path').focus(); });

  // Dismiss popup
  $('popup-dismiss').addEventListener('click', () => {
    window.api.hideWindow();
  });

  // Reply input: Enter sends, Escape dismisses
  $('popup-reply').addEventListener('keydown', async e => {
    if (e.key === 'Escape') {
      window.api.hideWindow();
    } else if (e.key === 'Enter') {
      const text = $('popup-reply').value.trim();
      if (!text || isStreaming) return;
      $('popup-reply').value = '';
      startStream();
      await window.api.sendMessage(text);
    }
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
    // Trigger an immediate first check-in
    await window.api.triggerCheckIn();
  } catch (err) {
    $('ob-submit').textContent = 'Error — try again';
    $('ob-submit').disabled = false;
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────

init().catch(console.error);
