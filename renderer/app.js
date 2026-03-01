'use strict';

const $ = id => document.getElementById(id);

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
  $('popup-text').textContent = '';
  $('popup-cursor').classList.remove('hidden');
  $('popup-avatar').classList.add('pulsing');
}

function appendChunk(text) {
  $('popup-text').textContent += text;
}

function endStream() {
  $('popup-cursor').classList.add('hidden');
  $('popup-avatar').classList.remove('pulsing');
}

// ── IPC Listeners ──────────────────────────────────────────────────────────

function setupIPCListeners() {
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
}

// ── Event Listeners ────────────────────────────────────────────────────────

function setupListeners() {
  // Onboarding submit
  $('ob-submit').addEventListener('click', handleSetup);
  $('ob-path').addEventListener('keydown', e => { if (e.key === 'Enter') handleSetup(); });
  $('ob-name').addEventListener('keydown', e => { if (e.key === 'Enter') $('ob-path').focus(); });

  // Dismiss popup on × or Escape
  $('popup-dismiss').addEventListener('click', () => window.api.hideWindow());
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') window.api.hideWindow();
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
