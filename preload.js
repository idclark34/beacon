'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ── Projects ──────────────────────────────────────────────────────────────
  getProjects:      ()     => ipcRenderer.invoke('get-projects'),
  addProject:       (data) => ipcRenderer.invoke('add-project', data),
  getActiveProjectId: ()   => ipcRenderer.invoke('get-active-project-id'),

  // ── Check-in (triggered by main process) ─────────────────────────────────
  triggerCheckIn: () => ipcRenderer.invoke('trigger-check-in'),

  // ── Window ────────────────────────────────────────────────────────────────
  showWindow: () => ipcRenderer.invoke('show-window'),
  hideWindow: () => ipcRenderer.invoke('hide-window'),

  // ── Window events from main ───────────────────────────────────────────────
  onWindowShow: (cb) => ipcRenderer.on('window-show', (_, ...args) => cb(...args)),

  // ── Streaming events from main ────────────────────────────────────────────
  onCheckIn: (cb) => {
    ipcRenderer.on('check-in-start',    ()         => cb({ type: 'start' }));
    ipcRenderer.on('check-in-chunk',    (_, text)  => cb({ type: 'chunk', text }));
    ipcRenderer.on('check-in-complete', (_, msg)   => cb({ type: 'complete', message: msg }));
  },

  // ── User reply (one-exchange chat) ────────────────────────────────────────
  sendMessage: (text) => ipcRenderer.invoke('send-message', text),
  onReply: (cb) => {
    ipcRenderer.on('reply-start',    ()        => cb({ type: 'start' }));
    ipcRenderer.on('reply-chunk',    (_, text) => cb({ type: 'chunk', text }));
    ipcRenderer.on('reply-complete', (_, msg)  => cb({ type: 'complete', message: msg }));
  },

  // ── Camera frame exchange ─────────────────────────────────────────────────
  onCaptureFrame: (cb) => ipcRenderer.on('capture-frame', () => cb()),
  sendFrame:      (b64) => ipcRenderer.send('frame-captured', b64),

  // ── Settings ──────────────────────────────────────────────────────────────
  getCameraSettings: ()       => ipcRenderer.invoke('get-camera-settings'),
  setCameraSettings: (s)      => ipcRenderer.invoke('set-camera-settings', s),
  getVoiceSettings:  ()       => ipcRenderer.invoke('get-voice-settings'),
  setVoiceSettings:  (s)      => ipcRenderer.invoke('set-voice-settings', s),
  checkHeadphones:   ()       => ipcRenderer.invoke('check-headphones'),
  closeSettings:     ()       => ipcRenderer.invoke('close-settings'),

  // ── Interests & feed sources ──────────────────────────────────────────────
  getInterests: ()         => ipcRenderer.invoke('get-interests'),
  setInterests: (topics)   => ipcRenderer.invoke('set-interests', topics),
  getFeedUrls:  ()         => ipcRenderer.invoke('get-feed-urls'),
  addFeedUrl:   (url)      => ipcRenderer.invoke('add-feed-url', url),
});
