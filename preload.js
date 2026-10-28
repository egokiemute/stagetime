const { contextBridge, ipcRenderer } = require('electron');

// The only window↔Electron surface. Deliberately narrow: state relay,
// screen-change notifications, the stage-window controls, and phone control.
contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  send: (channel, data) => ipcRenderer.send(channel, data),
  onState: (callback) => {
    ipcRenderer.on('state', (_event, state) => callback(state));
  },
  onScreensChanged: (callback) => {
    ipcRenderer.on('screens-changed', (_event, count) => callback(count));
  },
  nextScreen: () => ipcRenderer.invoke('next-screen'),
  toggleDisplay: () => ipcRenderer.invoke('toggle-display'),
  showDisplay: () => ipcRenderer.invoke('show-display'),
  hideDisplay: () => ipcRenderer.invoke('hide-display'),
  screenCount: () => ipcRenderer.invoke('screen-count'),
  listScreens: () => ipcRenderer.invoke('list-screens'),
  openDisplayOnScreen: (index) => ipcRenderer.invoke('open-display-on-screen', index),
  hasDisplay: () => ipcRenderer.invoke('has-display'),
  onUpdateState: (callback) => {
    ipcRenderer.on('update-state', (_event, update) => callback(update));
  },
  getUpdateState: () => ipcRenderer.invoke('get-update-state'),
  installUpdate: () => ipcRenderer.send('install-update'),
  openUpdatePage: () => ipcRenderer.send('open-update-page'),
  remoteStart: () => ipcRenderer.invoke('remote-start'),
  remoteStop: () => ipcRenderer.invoke('remote-stop'),
  sendRemoteState: (state) => ipcRenderer.send('remote-state', state),
  onRemoteCommand: (callback) => {
    ipcRenderer.on('remote-command', (_event, cmd) => callback(cmd));
  },
  onRemoteStatus: (callback) => {
    ipcRenderer.on('remote-status', (_event, count) => callback(count));
  }
});
