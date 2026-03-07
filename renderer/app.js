'use strict';

const $ = id => document.getElementById(id);

// ── Alfred ASCII character ───────────────────────────────────────────────────

const ALFRED_FRAMES = {
  normal: [
    `  .-.
 (o.o)
  \\-/
 /|=|\\
  | |`,
    `  .-.
 (-.-)
  \\-/
 /|=|\\
  | |`,
  ],
  roast: [
    `  .-.
 (^.-)
  \\-/
 /|=|\\
  | |`,
    `  .-.
 (-.^)
  \\-/
 /|=|\\
  | |`,
  ],
  alert: [
    `  /!\\
 (O.O)
  \\=/
 /|!|\\
  | |`,
    `  !!!
 (O.O)
  \\=/
 /|!|\\
  | |`,
  ],
  watching: [
    `  .-.
 (>.>)
  \\-/
 /|=|\\
  | |`,
    `  .-.
 (.>>)
  \\-/
 /|=|\\
  | |`,
  ],
  welcome: [
    `  .-.
 (^.^)
  \\u/
 /|=|\\
  | |`,
    `  .-.
 (^ ^)
  \\u/
 /|=|\\
  | |`,
  ],
};

const ALFRED_TIMING = { normal: 700, roast: 480, alert: 280, watching: 580, welcome: 750 };

let alfredInterval = null;
let alfredFrameIdx = 0;

function startAlfred(mood = 'normal') {
  stopAlfred();
  const frames = ALFRED_FRAMES[mood] || ALFRED_FRAMES.normal;
  const el = $('alfred-art');
  el.dataset.mood = mood in ALFRED_FRAMES ? mood : 'normal';
  el.classList.remove('idle');
  el.style.opacity = '';
  alfredFrameIdx = 0;
  el.textContent = frames[0];
  alfredInterval = setInterval(() => {
    alfredFrameIdx = (alfredFrameIdx + 1) % frames.length;
    el.textContent = frames[alfredFrameIdx];
  }, ALFRED_TIMING[mood] || 600);
}

function stopAlfred() {
  if (alfredInterval) { clearInterval(alfredInterval); alfredInterval = null; }
}

function idleAlfred() {
  stopAlfred();
  const el = $('alfred-art');
  el.textContent = ALFRED_FRAMES.normal[1]; // eyes closed / resting
  el.classList.add('idle');
}

// ── Typewriter queue ────────────────────────────────────────────────────────

let typeQueue = [];
let typeRunning = false;
let chatEnabled = false;
let replyPending = false;
let currentProposal = null;
let brainstormMode = false;
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

function startStream(mood = 'normal') {
  $('popup-text').textContent = '';
  typeQueue = [];
  typeRunning = false;
  $('popup-cursor').classList.remove('hidden');
  $('app').classList.add('streaming');
  startAlfred(mood);

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
    idleAlfred();
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
  startAlfred('normal');
}

function endReply() {
  const wait = () => {
    if (typeQueue.length > 0 || typeRunning) { requestAnimationFrame(wait); return; }
    $('popup-cursor').classList.add('hidden');
    $('app').classList.remove('streaming');
    idleAlfred();
    replyPending = false;
    if (brainstormMode) {
      // Stay open — re-enable chat for next brainstorm exchange
      chatEnabled = true;
      const ci = $('chat-input');
      ci.disabled = false;
      ci.value = '';
      ci.focus();
      $('popup').classList.add('chatting');
    } else {
      setTimeout(() => dismissWithAnimation(), 1500);
    }
  };
  requestAnimationFrame(wait);
}

// ── Brainstorm mode ─────────────────────────────────────────────────────────

function enterBrainstorm() {
  brainstormMode = true;
  $('popup').classList.add('brainstorm');
  $('chat-input').placeholder = 'thinking with Alfred…';
}

function exitBrainstorm() {
  brainstormMode = false;
  $('popup').classList.remove('brainstorm');
  $('chat-input').placeholder = 'say something…';
  window.api.clearBrainstorm();
  dismissWithAnimation();
}

// ── Code quality proposal ───────────────────────────────────────────────────

function showProposal(proposal) {
  currentProposal = proposal;
  $('alfred-section').classList.add('hidden');
  $('popup-message').classList.add('hidden');
  $('action-wrap').classList.add('hidden');

  const filesEl = $('proposal-files');
  filesEl.innerHTML = '';

  for (const file of proposal.files) {
    // Show last 2 path segments to keep it readable in the narrow window
    const shortPath = file.relPath.replace(/^(?:.*\/)?([^/]+\/[^/]+)$/, '$1');
    const el = document.createElement('div');
    el.className = 'proposal-file';
    const removalsHtml = file.removals.slice(0, 4)
      .map(r => `<div class="proposal-removal">${escapeHtml(r.text)}</div>`)
      .join('');
    const moreHtml = file.removals.length > 4
      ? `<div class="proposal-removal-more">+${file.removals.length - 4} more</div>`
      : '';
    el.innerHTML = `
      <label class="proposal-file-header">
        <input type="checkbox" class="proposal-checkbox"
               data-path="${escapeHtml(file.relPath)}" data-type="${escapeHtml(file.type)}" checked />
        <span class="proposal-file-name" title="${escapeHtml(file.relPath)}">${escapeHtml(shortPath)}</span>
        <span class="proposal-badge">${file.removals.length}</span>
      </label>
      <div class="proposal-removals">${removalsHtml}${moreHtml}</div>`;
    filesEl.appendChild(el);
  }

  $('proposal-apply').disabled = false;
  $('proposal-apply').textContent = 'Apply selected';
  $('proposal-wrap').classList.remove('hidden');
}

function hideProposal() {
  currentProposal = null;
  $('proposal-wrap').classList.add('hidden');
  $('alfred-section').classList.remove('hidden');
  $('popup-message').classList.remove('hidden');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
  window.api.onCaptureFrame(async () => {
    const frame = await captureCamera();
    window.api.sendFrame(frame);
  });

  window.api.onWindowShow(() => {
    const app = $('app');
    app.classList.remove('exiting');
    app.classList.add('entering');
    app.addEventListener('animationend', () => {
      app.classList.remove('entering');
    }, { once: true });
    // Show a resting Alfred immediately on window show (mood overridden when stream starts)
    const el = $('alfred-art');
    if (!el.textContent) {
      el.textContent = ALFRED_FRAMES.normal[0];
      el.dataset.mood = 'normal';
    }
  });

  window.api.onCheckInAction(({ actionId, label }) => {
    const wrap = $('action-wrap');
    const btn  = $('action-btn');
    wrap.classList.remove('hidden');
    btn.textContent = label;
    btn.disabled = false;
    btn.dataset.actionId = actionId;
  });

  window.api.onActionResult(({ message }) => {
    const btn = $('action-btn');
    btn.textContent = message;
    setTimeout(() => $('action-wrap').classList.add('hidden'), 4000);
  });

  window.api.onCodeQualityProposal((proposal) => {
    showProposal(proposal);
  });

  window.api.onCheckIn(({ type, text, mood }) => {
    if (type === 'start') {
      // Reset chat state before each fresh check-in
      chatEnabled = false; replyPending = false;
      if (brainstormMode) {
        brainstormMode = false;
        $('popup').classList.remove('brainstorm');
        $('chat-input').placeholder = 'say something…';
        window.api.clearBrainstorm();
      }
      $('chat-input').value = ''; $('chat-input').disabled = false;
      $('chat-area').classList.remove('visible');
      $('popup').classList.remove('chatting');
      $('action-wrap').classList.add('hidden');
      if (currentProposal) hideProposal();
      startStream(mood || 'normal');
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
  // Action button (code quality fix)
  $('action-btn').addEventListener('click', () => {
    const btn = $('action-btn');
    const actionId = btn.dataset.actionId;
    btn.disabled = true;
    btn.textContent = 'Working…';
    window.api.triggerAction(actionId);
  });

  // Proposal panel
  $('proposal-apply').addEventListener('click', async () => {
    if (!currentProposal) return;
    const checked = $('proposal-files').querySelectorAll('.proposal-checkbox:checked');
    const approvedFiles = Array.from(checked).map(cb => ({
      relPath: cb.dataset.path,
      type:    cb.dataset.type,
    }));
    $('proposal-apply').disabled = true;
    $('proposal-apply').textContent = 'Applying…';
    await window.api.applyCodeQualityProposal({ projectId: currentProposal.projectId, approvedFiles });
    hideProposal();
  });

  $('proposal-skip').addEventListener('click', () => hideProposal());

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
      else if (brainstormMode) { exitBrainstorm(); }
      else { ci.blur(); dismissWithAnimation(); }
    } else {
      if (brainstormMode) exitBrainstorm();
      else dismissWithAnimation();
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
    if (!text || replyPending) return;

    // /brainstorm <idea> — enter brainstorm mode from the chat input
    if ((text.startsWith('/brainstorm ') || text.startsWith('/b ')) && chatEnabled) {
      const idea = text.replace(/^\/(?:brainstorm|b)\s+/, '').trim();
      if (!idea) return;
      chatInput.value = '';
      enterBrainstorm();
      replyPending = true; chatEnabled = false; chatInput.disabled = true;
      $('popup').classList.remove('chatting');
      try { await window.api.sendBrainstorm(idea); }
      catch { exitBrainstorm(); }
      return;
    }

    if (!chatEnabled) return;
    replyPending = true; chatEnabled = false; chatInput.disabled = true;
    $('popup').classList.remove('chatting');
    try {
      if (brainstormMode) await window.api.sendBrainstorm(text);
      else await window.api.sendMessage(text);
    } catch {
      if (brainstormMode) exitBrainstorm();
      else dismissWithAnimation();
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
    await window.api.triggerCheckIn();
  } catch (err) {
    $('ob-submit').textContent = 'Error — try again';
    $('ob-submit').disabled = false;
  }
}

// ── Camera ─────────────────────────────────────────────────────────────────

async function captureCamera() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    const video = document.createElement('video');
    video.srcObject = stream;
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = reject;
      setTimeout(reject, 5000);
    });
    await video.play();
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    canvas.getContext('2d').drawImage(video, 0, 0, 640, 480);
    return canvas.toDataURL('image/jpeg', 0.7).split(',')[1]; // base64 only
  } catch {
    return null; // camera unavailable or denied — degrade gracefully
  } finally {
    stream?.getTracks().forEach(t => t.stop()); // release camera immediately
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────

init().catch(console.error);
