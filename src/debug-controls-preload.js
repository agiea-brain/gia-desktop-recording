const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    getState: () => ipcRenderer.invoke('debug-controls:get-state'),
    togglePause: () => ipcRenderer.invoke('debug-controls:toggle-pause'),
    stop: () => ipcRenderer.invoke('debug-controls:stop'),
    onState: (callback) => ipcRenderer.on('debug-controls:state', (_event, next) => callback(next)),
});
