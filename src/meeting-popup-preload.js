const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    log: (level, ...args) =>
        ipcRenderer.send('app-log', { level, args, context: { source: 'meeting-popup' } }),
    minimize: () => ipcRenderer.invoke('meeting-popup:minimize'),
    confirmRecording: () => ipcRenderer.invoke('meeting-popup:confirm-recording'),
    declineRecording: () => ipcRenderer.invoke('meeting-popup:decline-recording'),
    endRecording: () => ipcRenderer.invoke('meeting-popup:end-recording'),
    onRecordingStarted: (callback) =>
        ipcRenderer.on('meeting-popup:recording-started', (_event) => callback()),
    onRecordingEnded: (callback) =>
        ipcRenderer.on('meeting-popup:recording-ended', (_event) => callback()),
    onLogo: (callback) =>
        ipcRenderer.on('meeting-popup:logo', (_event, payload) => callback(payload)),
});
