const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    log: (level, ...args) =>
        ipcRenderer.send('app-log', {
            level,
            args,
            context: { source: 'recording-saved-toast' },
        }),
    dismiss: () => ipcRenderer.invoke('recording-saved-toast:dismiss'),
    onLogo: (callback) =>
        ipcRenderer.on('recording-saved-toast:logo', (_event, payload) => callback(payload)),
});