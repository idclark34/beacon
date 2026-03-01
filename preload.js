'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ── Projects ──────────────────────────────────────────────────────────────
  getProjects: () => ipcRenderer.invoke('get-projects'),
  addProject: (data) => ipcRenderer.invoke('add-project', data),
  setActiveProject: (id) => ipcRenderer.invoke('set-active-project', id),
  getActiveProjectId: () => ipcRenderer.invoke('get-active-project-id'),

  // ── Conversations ─────────────────────────────────────────────────────────
  getConversations: (limit) => ipcRenderer.invoke('get-conversations', limit),
  sendMessage: (text) => ipcRenderer.invoke('send-message', text),

  // ── Goals ─────────────────────────────────────────────────────────────────
  addGoal: (text) => ipcRenderer.invoke('add-goal', text),
  getGoals: () => ipcRenderer.invoke('get-goals'),

  // ── Activity ─────────────────────────────────────────────────────────────
  getActivitySummary: () => ipcRenderer.invoke('get-activity-summary'),

  // ── Window controls ───────────────────────────────────────────────────────
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  closeWindow: () => ipcRenderer.invoke('close-window'),
  startDrag: () => ipcRenderer.send('start-drag'),

  // ── Streaming ─────────────────────────────────────────────────────────────
  onMessageChunk: (cb) => {
    ipcRenderer.on('message-chunk', (_, text) => cb(text));
  },
  onMessageComplete: (cb) => {
    ipcRenderer.on('message-complete', (_, msg) => cb(msg));
  },
  onMessageError: (cb) => {
    ipcRenderer.on('message-error', (_, err) => cb(err));
  },

  // ── Check-in events ───────────────────────────────────────────────────────
  onCheckIn: (cb) => {
    ipcRenderer.on('check-in-start', () => cb({ type: 'start' }));
    ipcRenderer.on('check-in-chunk', (_, text) => cb({ type: 'chunk', text }));
    ipcRenderer.on('check-in-complete', (_, msg) => cb({ type: 'complete', message: msg }));
  },

  // ── Cleanup ───────────────────────────────────────────────────────────────
  removeListener: (channel) => ipcRenderer.removeAllListeners(channel),
});
