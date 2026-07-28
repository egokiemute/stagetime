const { app, BrowserWindow, ipcMain, screen, powerSaveBlocker, globalShortcut } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

let controlWin = null;
let displayWin = null;
let displayScreenIndex = null; // null until the operator picks a screen
let powerSaveId = null;

function getDisplays() {
  return screen.getAllDisplays();
}

function createControlWindow() {
  controlWin = new BrowserWindow({
    width: 1200,
    height: 760,
    title: 'Stage Timer',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0E0E11',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  controlWin.loadFile('control.html');
  controlWin.on('closed', () => { controlWin = null; });
}

// The stage window only ever appears once the operator explicitly chooses a
// screen for it — never automatically on launch. That's what stops it from
// covering the desktop on a single-monitor setup before anyone's touched
// Start.
// Always borderless and always-on-top, covering the entire chosen screen —
// no titlebar, no dock/menu-bar gap, nothing of the desktop showing through.
// Safe to do unconditionally (even on a single-monitor setup) because
// Cmd/Ctrl+Shift+H is a global shortcut that hides it regardless of focus.
function openDisplayOnScreen(index) {
  const displays = getDisplays();
  const target = displays[index];
  if (!target) return false;

  if (!displayWin) {
    displayWin = new BrowserWindow({
      x: target.bounds.x,
      y: target.bounds.y,
      width: target.bounds.width,
      height: target.bounds.height,
      frame: false,
      backgroundColor: '#000000',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false
      }
    });
    displayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    displayWin.loadFile('display.html');
    displayWin.on('closed', () => {
      displayWin = null;
      displayScreenIndex = null;
    });
  }

  displayScreenIndex = index;
  displayWin.setBounds(target.bounds);
  displayWin.setAlwaysOnTop(true, 'screen-saver');
  displayWin.show();
  return true;
}

// Native fullscreen creates its own Space and behaves badly on a secondary
// monitor, so screen placement always goes through setBounds instead.
function moveDisplayToScreen(index) {
  const displays = getDisplays();
  const target = displays[index];
  if (!displayWin || !target) return;
  displayScreenIndex = index;
  displayWin.setBounds(target.bounds);
  displayWin.setAlwaysOnTop(true, 'screen-saver');
}

function notifyScreens() {
  if (controlWin) controlWin.webContents.send('screens-changed', getDisplays().length);
}

app.whenReady().then(() => {
  createControlWindow();
  powerSaveId = powerSaveBlocker.start('prevent-display-sleep');

  screen.on('display-added', notifyScreens);
  screen.on('display-metrics-changed', notifyScreens);
  // Projector cable pulled: fall back to the primary screen rather than
  // pointing the stage window at a display index that no longer exists.
  screen.on('display-removed', () => {
    if (!displayWin) return;
    const displays = getDisplays();
    if (displayScreenIndex === null || !displays[displayScreenIndex]) {
      moveDisplayToScreen(0);
    }
    notifyScreens();
  });

  // Escape hatch: if the operator picks the wrong screen (their own, on a
  // multi-display setup), the stage window becomes borderless + always-on-top
  // + visible on every workspace, so it can't be closed or clicked past. A
  // global shortcut fires regardless of which window has focus — including
  // when the stage window has stolen all interaction.
  globalShortcut.register('CommandOrControl+Shift+H', () => {
    if (displayWin) displayWin.hide();
  });

  // Checked once per launch only, and never installed without an explicit
  // click — this app runs live during a service, and a forced restart
  // mid-timer would be a real incident. See 'install-update' below.
  if (app.isPackaged) {
    autoUpdater.checkForUpdates().catch(() => {});
  }
});

autoUpdater.on('update-downloaded', (info) => {
  if (controlWin) controlWin.webContents.send('update-ready', info.version);
});

ipcMain.on('install-update', () => {
  autoUpdater.quitAndInstall();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (powerSaveId !== null && powerSaveBlocker.isStarted(powerSaveId)) {
    powerSaveBlocker.stop(powerSaveId);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createControlWindow();
  }
});

ipcMain.on('state', (_event, state) => {
  if (displayWin) displayWin.webContents.send('state', state);
});

ipcMain.handle('list-screens', () => {
  const displays = getDisplays();
  const primary = screen.getPrimaryDisplay();
  const current = controlWin ? screen.getDisplayMatching(controlWin.getBounds()) : null;
  return displays.map((d, i) => ({
    index: i,
    width: d.bounds.width,
    height: d.bounds.height,
    isPrimary: d.id === primary.id,
    isCurrent: current ? d.id === current.id : false
  }));
});

ipcMain.handle('open-display-on-screen', (_event, index) => openDisplayOnScreen(index));

ipcMain.handle('has-display', () => !!displayWin);

ipcMain.handle('next-screen', () => {
  if (displayScreenIndex === null) return null;
  const displays = getDisplays();
  if (displays.length === 0) return displayScreenIndex;
  const nextIndex = (displayScreenIndex + 1) % displays.length;
  moveDisplayToScreen(nextIndex);
  return nextIndex;
});

ipcMain.handle('toggle-display', () => {
  if (!displayWin) return false;
  if (displayWin.isVisible()) {
    displayWin.hide();
    return false;
  }
  displayWin.show();
  return true;
});

ipcMain.handle('show-display', () => {
  if (!displayWin) return false;
  displayWin.show();
  return true;
});

ipcMain.handle('hide-display', () => {
  if (!displayWin) return false;
  displayWin.hide();
  return true;
});

ipcMain.handle('screen-count', () => getDisplays().length);
