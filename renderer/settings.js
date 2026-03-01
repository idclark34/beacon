'use strict';

const $ = id => document.getElementById(id);

let saveTimeout = null;

function showSaved() {
  const el = $('saved');
  el.classList.add('visible');
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => el.classList.remove('visible'), 1800);
}

async function load() {
  const [cam, voice] = await Promise.all([
    window.api.getCameraSettings(),
    window.api.getVoiceSettings(),
  ]);

  $('camera-enabled').checked    = cam.enabled !== false;
  $('camera-after-hour').value   = cam.afterHour != null ? String(cam.afterHour) : '';
  $('voice-enabled').checked     = voice.enabled === true;
  $('voice-auto-detect').checked = voice.autoDetect !== false;

  updateCameraSelectState();
  updateVoiceState();
  refreshHeadphoneStatus();
}

function updateCameraSelectState() {
  $('camera-after-hour').disabled = !$('camera-enabled').checked;
}

function updateVoiceState() {
  $('voice-auto-detect').disabled = !$('voice-enabled').checked;
}

async function saveCam() {
  const enabled    = $('camera-enabled').checked;
  const afterHourVal = $('camera-after-hour').value;
  const afterHour  = afterHourVal === '' ? null : parseInt(afterHourVal, 10);
  await window.api.setCameraSettings({ enabled, afterHour });
  showSaved();
}

async function saveVoice() {
  const enabled    = $('voice-enabled').checked;
  const autoDetect = $('voice-auto-detect').checked;
  await window.api.setVoiceSettings({ enabled, autoDetect });
  showSaved();
}

async function refreshHeadphoneStatus() {
  if (!$('voice-enabled').checked || !$('voice-auto-detect').checked) {
    $('headphone-status').textContent = '';
    return;
  }
  $('headphone-status').textContent = 'checking…';
  const result = await window.api.checkHeadphones();
  if (result === null) {
    $('headphone-status').textContent = 'switchaudio-osx not installed — voice fires regardless';
  } else {
    $('headphone-status').textContent = result
      ? 'Headphones detected — voice active'
      : 'No headphones detected — voice will wait';
  }
}

function setupListeners() {
  $('close-btn').addEventListener('click', () => window.api.closeSettings());

  $('camera-enabled').addEventListener('change', () => {
    updateCameraSelectState();
    saveCam();
  });
  $('camera-after-hour').addEventListener('change', () => saveCam());

  $('voice-enabled').addEventListener('change', () => {
    updateVoiceState();
    saveVoice();
    refreshHeadphoneStatus();
  });
  $('voice-auto-detect').addEventListener('change', () => {
    saveVoice();
    refreshHeadphoneStatus();
  });
}

load().then(setupListeners).catch(console.error);
