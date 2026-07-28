const { contextBridge, ipcRenderer } = require('electron');

// The only window↔Electron surface. Deliberately narrow: state relay,
// screen-change notifications, and the two stage-window controls.
contextBridge.exposeInMainWorld('api', {
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
  onUpdateReady: (callback) => {
    ipcRenderer.on('update-ready', (_event, version) => callback(version));
  },
  installUpdate: () => ipcRenderer.send('install-update')
});
