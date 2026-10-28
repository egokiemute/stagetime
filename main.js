const { app, BrowserWindow, ipcMain, screen, powerSaveBlocker, globalShortcut, nativeTheme, shell } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const remote = require('./remote');

let controlWin = null;
let displayWin = null;
let displayScreenIndex = null; // null until the operator picks a screen
let powerSaveId = null;

function getDisplays() {
  return screen.getAllDisplays();
}

// On macOS the window is transparent with a native sidebar material behind
// it; the renderer opts into that layout via window.api.platform.
const isMac = process.platform === 'darwin';

function createControlWindow() {
  controlWin = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'Stage Timer',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: isMac ? '#00000000' : '#1C1C1E',
    ...(isMac ? { vibrancy: 'sidebar', visualEffectState: 'active' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  controlWin.loadFile('control.html');
  // The phone-control toggle lives in this window, so it can't outlive it.
  controlWin.on('closed', () => {
    controlWin = null;
    remote.stop();
  });
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

remote.init({
  onCommand: (cmd) => {
    if (controlWin) controlWin.webContents.send('remote-command', cmd);
  },
  onStatus: (count) => {
    if (controlWin) controlWin.webContents.send('remote-status', count);
  }
});

app.whenReady().then(() => {
  // The UI is dark-only (it runs in a dim booth), so keep native materials
  // and form controls dark even when the Mac is in light mode.
  nativeTheme.themeSource = 'dark';
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

// The macOS build is unsigned, and Squirrel.Mac refuses to install an
// unsigned update — so a Mac only announces the release (with its notes) and
// links to the download. Windows and Linux download in the background and
// wait for an explicit "Restart & update".
const RELEASES_URL = 'https://github.com/egokiemute/stagetime/releases';
const canAutoInstall = !isMac;
autoUpdater.autoDownload = canAutoInstall;

// Kept here as well as sent, because the launch-time check can finish before
// the control window has loaded and registered its listener.
let updateState = null;

function releaseNotesText(notes) {
  if (!notes) return '';
  if (Array.isArray(notes)) return notes.map((n) => n.note || '').join('\n');
  return String(notes);
}

function setUpdateState(stage, info) {
  updateState = {
    stage, // 'downloading' | 'ready' | 'available'
    version: info.version,
    notes: releaseNotesText(info.releaseNotes),
    canInstall: canAutoInstall
  };
  if (controlWin) controlWin.webContents.send('update-state', updateState);
}

autoUpdater.on('update-available', (info) => {
  setUpdateState(canAutoInstall ? 'downloading' : 'available', info);
});

autoUpdater.on('update-downloaded', (info) => setUpdateState('ready', info));

ipcMain.handle('get-update-state', () => updateState);

ipcMain.on('open-update-page', () => {
  if (updateState) shell.openExternal(`${RELEASES_URL}/tag/v${updateState.version}`);
});

ipcMain.on('install-update', () => {
  if (updateState && updateState.stage === 'ready') autoUpdater.quitAndInstall();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  remote.stop();
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

ipcMain.handle('remote-start', async () => {
  try {
    return await remote.start();
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('remote-stop', () => remote.stop());

ipcMain.on('remote-state', (_event, state) => remote.broadcast(state));
