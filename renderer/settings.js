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
  const settings = await window.api.getCameraSettings();
  $('camera-enabled').checked   = settings.enabled !== false;
  $('camera-after-hour').value  = settings.afterHour != null ? String(settings.afterHour) : '';
  updateSelectState();
}

function updateSelectState() {
  $('camera-after-hour').disabled = !$('camera-enabled').checked;
}

async function save() {
  const enabled    = $('camera-enabled').checked;
  const afterHourVal = $('camera-after-hour').value;
  const afterHour  = afterHourVal === '' ? null : parseInt(afterHourVal, 10);
  await window.api.setCameraSettings({ enabled, afterHour });
  showSaved();
}

function setupListeners() {
  $('close-btn').addEventListener('click', () => window.api.closeSettings());

  $('camera-enabled').addEventListener('change', () => {
    updateSelectState();
    save();
  });

  $('camera-after-hour').addEventListener('change', () => save());
}

load().then(setupListeners).catch(console.error);
