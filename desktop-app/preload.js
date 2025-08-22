/**
 * preload.js
 *
 * This script runs in a privileged context before the renderer process is loaded.
 * It uses the contextBridge to securely expose Node.js/Electron APIs to the
 * renderer process, which is running in a sandboxed environment.
 */
const { contextBridge, ipcRenderer } = require('electron');

// Expose a controlled API to the renderer process.
// We are creating a 'window.electronAPI' object in the renderer's context.
contextBridge.exposeInMainWorld('electronAPI', {
  // Expose the 'on' method of ipcRenderer, but only for the 'ws-message' channel.
  // This is more secure than exposing ipcRenderer directly.
  onWsMessage: (callback) => ipcRenderer.on('ws-message', (event, ...args) => callback(...args)),

  // Also expose the connection status channel
  onConnectionStatusChanged: (callback) => ipcRenderer.on('connection-status-changed', (event, ...args) => callback(...args))
});
