const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('glyphterm', {
  init: () => ipcRenderer.invoke('app:init'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  openSettingsFile: () => ipcRenderer.send('app:openSettingsFile'),
  newWindow: () => ipcRenderer.send('app:newWindow'),
  closeWindow: () => ipcRenderer.send('win:close'),
  openExternal: (url) => ipcRenderer.send('app:openExternal', url),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (text) => ipcRenderer.send('clipboard:write', text),

  createPty: (opts) => ipcRenderer.invoke('pty:create', opts),
  write: (id, data) => ipcRenderer.send('pty:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
  kill: (id) => ipcRenderer.send('pty:kill', id),
  setTitle: (id, title) => ipcRenderer.send('pty:title', id, title),

  getCommands: () => ipcRenderer.invoke('commands:get'),
  onCommandsChanged: (cb) => ipcRenderer.on('commands:changed', (_e, snap) => cb(snap)),
  addHistory: (entry) => ipcRenderer.send('history:add', entry),
  deleteHistory: (ids) => ipcRenderer.send('history:delete', ids),
  clearHistory: () => ipcRenderer.send('history:clear'),
  saveSet: (set) => ipcRenderer.send('set:save', set),
  deleteSet: (id) => ipcRenderer.send('set:delete', id),
  // Extension bridge for the optional Pro package (channels are namespaced "ext:").
  ext: {
    invoke: (channel, ...args) => ipcRenderer.invoke('ext:' + channel, ...args),
    send: (channel, ...args) => ipcRenderer.send('ext:' + channel, ...args),
  },
  onData: (cb) => ipcRenderer.on('pty:data', (_e, id, data) => cb(id, data)),
  onExit: (cb) => ipcRenderer.on('pty:exit', (_e, id, code) => cb(id, code)),
});
