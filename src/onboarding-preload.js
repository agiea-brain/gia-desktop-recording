const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    log: (level, ...args) =>
        ipcRenderer.send('app-log', { level, args, context: { source: 'onboarding-popup' } }),
    close: () => ipcRenderer.invoke('onboarding:close'),
    minimize: () => ipcRenderer.invoke('onboarding:minimize'),
    resize: (size) => ipcRenderer.invoke('onboarding:resize', size),
    login: () => ipcRenderer.invoke('onboarding:login'),
    requestPermission: (step) => ipcRenderer.invoke('onboarding:request-permission', step),
    checkPermission: (step) => ipcRenderer.invoke('onboarding:check-permission', step),
    openSettings: (permission) => ipcRenderer.invoke('onboarding:open-settings', permission),
    complete: (opts = {}) => ipcRenderer.invoke('onboarding:complete', opts),
    getStarted: () => ipcRenderer.invoke('onboarding:get-started'),
    openExternal: (url) => shell.openExternal(url),
    onLogo: (callback) => ipcRenderer.on('onboarding:logo', (_event, payload) => callback(payload)),
    onInit: (callback) => ipcRenderer.on('onboarding:init', (_event, payload) => callback(payload)),
    onPermissionStatus: (callback) =>
        ipcRenderer.on('onboarding:permission-status', (_event, payload) => callback(payload)),
});
