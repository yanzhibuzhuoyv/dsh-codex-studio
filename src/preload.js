'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const EVENT_CHANNEL = 'studio:event';

function subscribeToStudioEvents(callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('A callback function is required.');
  }
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(EVENT_CHANNEL, listener);
  return () => ipcRenderer.removeListener(EVENT_CHANNEL, listener);
}

contextBridge.exposeInMainWorld('dshStudio', {
  selectWorkspace: () => ipcRenderer.invoke('workspace:pick'),
  getSession: () => ipcRenderer.invoke('session:get'),
  newSession: () => ipcRenderer.invoke('session:new'),
  startRun: (payload) => ipcRenderer.invoke('run:start', payload),
  stopRun: () => ipcRenderer.invoke('run:stop'),
  onStudioEvent: (callback) => subscribeToStudioEvents(callback)
});
