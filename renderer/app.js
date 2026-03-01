'use strict';

// ── State ──────────────────────────────────────────────────────────────────

let activeProjectId = null;
let isStreaming = false;
let streamingMsgEl = null;
let activityRefreshInterval = null;

// ── Elements ───────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const els = {
  onboarding: $('onboarding'),
  chatView: $('chat-view'),
  projectLabel: $('project-label'),
  avatar: $('avatar'),
  messages: $('messages'),
  emptyState: $('empty-state'),
  activityPill: $('activity-pill'),
  messageInput: $('message-input'),
  sendBtn: $('send-btn'),
  // Onboarding
  projectName: $('project-name'),
  repoPath: $('repo-path'),
  firstGoal: $('first-goal'),
  setupBtn: $('setup-btn'),
  // Goal modal
  goalModal: $('goal-modal'),
  goalList: $('goal-list'),
  newGoalInput: $('new-goal-input'),
  addGoalBtn: $('add-goal-btn'),
  closeGoalModal: $('close-goal-modal'),
  goalBtn: $('goal-btn'),
  // Project modal
  addProjectModal: $('add-project-modal'),
  newProjName: $('new-proj-name'),
  newProjPath: $('new-proj-path'),
  saveProjectBtn: $('save-project-btn'),
  closeProjectModal: $('close-project-modal'),
  projectBtn: $('project-btn'),
  // Window controls
  btnMinimize: $('btn-minimize'),
  btnClose: $('btn-close'),
};

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  const projects = await window.api.getProjects();
  activeProjectId = await window.api.getActiveProjectId();

  if (projects.length === 0) {
    showView('onboarding');
  } else {
    showView('chat');
    await loadChat();
  }

  setupEventListeners();
  setupIPCListeners();
  startActivityRefresh();
}

// ── Views ──────────────────────────────────────────────────────────────────

function showView(view) {
  if (view === 'onboarding') {
    els.onboarding.classList.add('active');
    els.chatView.classList.remove('active');
  } else {
    els.chatView.classList.add('active');
    els.onboarding.classList.remove('active');
  }
}

async function loadChat() {
  const projects = await window.api.getProjects();

  if (activeProjectId) {
    const project = projects.find(p => p.id === activeProjectId) || projects[0];
    if (project) {
      els.projectLabel.textContent = project.name;
      activeProjectId = project.id;
    }
  } else if (projects.length > 0) {
    activeProjectId = projects[0].id;
    els.projectLabel.textContent = projects[0].name;
    await window.api.setActiveProject(activeProjectId);
  }

  await loadConversations();
  await refreshActivity();
}

// ── Conversations ──────────────────────────────────────────────────────────

async function loadConversations() {
  const convos = await window.api.getConversations(50);
  els.messages.innerHTML = '';

  if (convos.length === 0) {
    els.messages.appendChild(els.emptyState);
    els.emptyState.style.display = 'flex';
    return;
  }

  els.emptyState.style.display = 'none';
  for (const msg of convos) {
    appendMessage(msg.message, msg.sender, msg.timestamp, false);
  }
  scrollToBottom();
}

function appendMessage(text, sender, timestamp, animate = true) {
  if (els.emptyState.parentElement === els.messages) {
    els.messages.removeChild(els.emptyState);
  }

  const el = document.createElement('div');
  el.className = `msg ${sender}`;
  if (!animate) el.style.animation = 'none';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = text;

  const time = document.createElement('div');
  time.className = 'msg-time';
  time.textContent = formatTime(timestamp || new Date().toISOString());

  el.appendChild(bubble);
  el.appendChild(time);
  els.messages.appendChild(el);
  return el;
}

function startStreamingMessage(sender) {
  if (els.emptyState.parentElement === els.messages) {
    els.messages.removeChild(els.emptyState);
  }

  const el = document.createElement('div');
  el.className = `msg ${sender}`;

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.innerHTML = '<span class="streaming-cursor"></span>';

  el.appendChild(bubble);
  els.messages.appendChild(el);
  scrollToBottom();
  return { el, bubble };
}

function appendChunkToStream(bubble, text) {
  // Remove cursor, add text, re-add cursor
  const cursor = bubble.querySelector('.streaming-cursor');
  if (cursor) cursor.remove();

  bubble.appendChild(document.createTextNode(text));

  const newCursor = document.createElement('span');
  newCursor.className = 'streaming-cursor';
  bubble.appendChild(newCursor);
  scrollToBottom();
}

function finalizeStream(bubble, fullText, timestamp) {
  const cursor = bubble.querySelector('.streaming-cursor');
  if (cursor) cursor.remove();

  // Add time
  const time = document.createElement('div');
  time.className = 'msg-time';
  time.textContent = formatTime(timestamp || new Date().toISOString());
  bubble.parentElement.appendChild(time);
}

// ── Activity ───────────────────────────────────────────────────────────────

async function refreshActivity() {
  try {
    const summary = await window.api.getActivitySummary();
    if (summary && summary.summary && summary.summary !== 'No recent activity') {
      els.activityPill.textContent = summary.summary;
      els.activityPill.title = `Project: ${summary.project}`;
    } else {
      els.activityPill.textContent = 'watching…';
    }
  } catch {
    // ignore
  }
}

function startActivityRefresh() {
  activityRefreshInterval = setInterval(refreshActivity, 60_000); // every minute
}

// ── Goals ──────────────────────────────────────────────────────────────────

async function loadGoals() {
  const goals = await window.api.getGoals();
  els.goalList.innerHTML = '';

  if (goals.length === 0) {
    els.goalList.innerHTML = '<div class="goal-item" style="color:var(--text-dim);border:none;padding:8px 0;">No goals yet.</div>';
    return;
  }

  for (const goal of goals) {
    const item = document.createElement('div');
    item.className = 'goal-item';
    item.textContent = goal.goal_text;
    els.goalList.appendChild(item);
  }
}

async function addGoal() {
  const text = els.newGoalInput.value.trim();
  if (!text) return;
  await window.api.addGoal(text);
  els.newGoalInput.value = '';
  await loadGoals();
}

// ── Send message ───────────────────────────────────────────────────────────

async function sendMessage() {
  const text = els.messageInput.value.trim();
  if (!text || isStreaming) return;

  els.messageInput.value = '';
  els.messageInput.style.height = 'auto';
  isStreaming = true;
  els.sendBtn.disabled = true;
  els.avatar.classList.add('pulsing');

  // Show user message immediately
  appendMessage(text, 'user', new Date().toISOString());
  scrollToBottom();

  // Start streaming the character response
  const { el, bubble } = startStreamingMessage('character');
  streamingMsgEl = { el, bubble };

  await window.api.sendMessage(text);
}

// ── IPC Listeners ──────────────────────────────────────────────────────────

function setupIPCListeners() {
  window.api.onMessageChunk((text) => {
    if (streamingMsgEl) {
      appendChunkToStream(streamingMsgEl.bubble, text);
    }
  });

  window.api.onMessageComplete((fullMessage) => {
    if (streamingMsgEl) {
      finalizeStream(streamingMsgEl.bubble, fullMessage);
      streamingMsgEl = null;
    }
    isStreaming = false;
    els.sendBtn.disabled = false;
    els.avatar.classList.remove('pulsing');
    scrollToBottom();
    refreshActivity();
  });

  window.api.onMessageError((errText) => {
    if (streamingMsgEl) {
      streamingMsgEl.bubble.innerHTML = '';
      streamingMsgEl.bubble.style.color = '#f87171';
      streamingMsgEl.bubble.textContent = errText;
      streamingMsgEl = null;
    }
    isStreaming = false;
    els.sendBtn.disabled = false;
    els.avatar.classList.remove('pulsing');
  });

  window.api.onCheckIn(({ type, text, message }) => {
    if (type === 'start') {
      els.avatar.classList.add('pulsing');
      const { el, bubble } = startStreamingMessage('character');
      streamingMsgEl = { el, bubble };
      // Show chat view if we're still on onboarding (shouldn't happen)
      showView('chat');
    } else if (type === 'chunk' && streamingMsgEl) {
      appendChunkToStream(streamingMsgEl.bubble, text);
    } else if (type === 'complete') {
      if (streamingMsgEl) {
        finalizeStream(streamingMsgEl.bubble, message);
        streamingMsgEl = null;
      }
      els.avatar.classList.remove('pulsing');
      scrollToBottom();
    }
  });
}

// ── Event Listeners ────────────────────────────────────────────────────────

function setupEventListeners() {
  // Window controls
  els.btnMinimize.addEventListener('click', () => window.api.minimizeWindow());
  els.btnClose.addEventListener('click', () => window.api.closeWindow());

  // Onboarding submit
  els.setupBtn.addEventListener('click', handleSetup);
  els.projectName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') els.repoPath.focus();
  });
  els.repoPath.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') els.firstGoal.focus();
  });
  els.firstGoal.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSetup();
  });

  // Message input
  els.messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  els.messageInput.addEventListener('input', () => {
    // Auto-grow
    els.messageInput.style.height = 'auto';
    els.messageInput.style.height = Math.min(els.messageInput.scrollHeight, 90) + 'px';
  });
  els.sendBtn.addEventListener('click', sendMessage);

  // Goals
  els.goalBtn.addEventListener('click', async () => {
    await loadGoals();
    els.goalModal.classList.add('open');
    els.newGoalInput.focus();
  });
  els.closeGoalModal.addEventListener('click', () => els.goalModal.classList.remove('open'));
  els.addGoalBtn.addEventListener('click', addGoal);
  els.newGoalInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addGoal();
  });
  els.goalModal.addEventListener('click', (e) => {
    if (e.target === els.goalModal) els.goalModal.classList.remove('open');
  });

  // Add project modal
  els.projectBtn.addEventListener('click', () => {
    els.addProjectModal.style.display = 'flex';
    els.newProjName.focus();
  });
  els.closeProjectModal.addEventListener('click', () => {
    els.addProjectModal.style.display = 'none';
  });
  els.saveProjectBtn.addEventListener('click', handleAddProject);
  els.newProjPath.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAddProject();
  });
}

async function handleSetup() {
  const name = els.projectName.value.trim();
  if (!name) {
    els.projectName.focus();
    return;
  }

  els.setupBtn.disabled = true;
  els.setupBtn.textContent = 'Setting up…';

  try {
    const project = await window.api.addProject({
      name,
      repo_path: els.repoPath.value.trim() || null,
    });

    activeProjectId = project.id;

    if (els.firstGoal.value.trim()) {
      await window.api.addGoal(els.firstGoal.value.trim());
    }

    els.projectLabel.textContent = project.name;
    showView('chat');
    await loadConversations();
    await refreshActivity();
  } catch (err) {
    console.error('Setup error:', err);
    els.setupBtn.textContent = 'Error — try again';
    els.setupBtn.disabled = false;
  }
}

async function handleAddProject() {
  const name = els.newProjName.value.trim();
  if (!name) { els.newProjName.focus(); return; }

  const project = await window.api.addProject({
    name,
    repo_path: els.newProjPath.value.trim() || null,
  });

  els.addProjectModal.style.display = 'none';
  els.newProjName.value = '';
  els.newProjPath.value = '';

  // Switch to new project
  activeProjectId = project.id;
  await window.api.setActiveProject(project.id);
  els.projectLabel.textContent = project.name;
  await loadConversations();
}

// ── Helpers ────────────────────────────────────────────────────────────────

function scrollToBottom() {
  requestAnimationFrame(() => {
    els.messages.scrollTop = els.messages.scrollHeight;
  });
}

function formatTime(isoStr) {
  try {
    const d = new Date(isoStr);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────

init().catch(console.error);
