const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { pathToFileURL } = require('url');

contextBridge.exposeInMainWorld('api', {
  toFileUrl: (p) => pathToFileURL(p).href,
  getPathForFile: (f) => {
    try { return webUtils.getPathForFile(f); } catch (_) { return f.path || ''; }
  },
  init: (cfg) => ipcRenderer.invoke('app:init', cfg),
  settingsSet: (data) => ipcRenderer.invoke('settings:set', data),
  libraryGet: () => ipcRenderer.invoke('library:get'),
  librarySet: (payload) => ipcRenderer.invoke('library:set', payload),
  openMedia: (opts) => ipcRenderer.invoke('dialog:openMedia', opts || {}),
  saveOutputDialog: (name) => ipcRenderer.invoke('dialog:saveOutput', name),
  chooseDir: () => ipcRenderer.invoke('dialog:chooseDir'),
  probe: (payload) => ipcRenderer.invoke('project:probe', payload),
  getKeyframes: (payload) => ipcRenderer.invoke('project:keyframes', payload),
  waveform: (payload) => ipcRenderer.invoke('audio:waveform', payload),
  micSave: (payload) => ipcRenderer.invoke('mic:save', payload),
  scanBase: (payload) => ipcRenderer.invoke('base:scan', payload),
  unwatch: (dir) => ipcRenderer.invoke('base:unwatch', dir),
  listDir: (payload) => ipcRenderer.invoke('base:list', payload),
  thumbnail: (payload) => ipcRenderer.invoke('base:thumbnail', payload),
  preview: (payload) => ipcRenderer.invoke('preview:get', payload),
  onPreviewDone: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on('preview:done', handler);
    return () => ipcRenderer.removeListener('preview:done', handler);
  },
  onBaseChanged: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('base:changed', handler);
    return () => ipcRenderer.removeListener('base:changed', handler);
  },
  onScanProgress: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on('scan:progress', handler);
    return () => ipcRenderer.removeListener('scan:progress', handler);
  },
  saveProject: (payload) => ipcRenderer.invoke('project:save', payload),
  loadProject: () => ipcRenderer.invoke('project:load'),
  saveProjectAs: (data) => ipcRenderer.invoke('project:saveAs', data),
  closeConfirm: (ok) => ipcRenderer.invoke('app:close-confirm', ok),
  onRequestClose: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('app:request-close', handler);
    return () => ipcRenderer.removeListener('app:request-close', handler);
  },
  runExport: (payload) => ipcRenderer.invoke('export:run', payload),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  purgeUsedMedia: (payload) => ipcRenderer.invoke('media:purge', payload),
  reveal: (file) => ipcRenderer.invoke('shell:reveal', file),
  onExportProgress: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on('export:progress', handler);
    return () => ipcRenderer.removeListener('export:progress', handler);
  },
});
