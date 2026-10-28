// The control window owns the state object and sends whole snapshots to
// main, which forwards them to the stage window (rule 3.2). Only send on
// change, never on every tick.

const PERSIST_KEY = 'stagetimer.settings';

function loadPersisted() {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function savePersisted() {
  const {
    mode, durationMs, clockTarget, clockTargetTouched, timerTouched,
    label, warnSec, dangerSec, showClock, showNextUp
  } = state;
  localStorage.setItem(
    PERSIST_KEY,
    JSON.stringify({
      mode, durationMs, clockTarget, clockTargetTouched, timerTouched,
      label, warnSec, dangerSec, showClock, showNextUp
    })
  );
}

const state = { ...DEFAULT_STATE, ...loadPersisted() };
state.status = 'idle';
state.endsAt = null;
state.startedAt = null;
state.frozenMs = state.mode === 'duration' ? state.durationMs : DEFAULT_STATE.frozenMs;
state.totalMs = Math.max(1, state.frozenMs);
// Until the operator explicitly sets a "Start at" target, default it to a
// live current time rather than the frozen fallback in DEFAULT_STATE.
if (!state.clockTargetTouched) {
  state.clockTarget = currentHHMMSS();
}
// DEFAULT_STATE.program is a nested object — the spread above only shallow-copies
// the reference, so without this, mutating state.program.items would corrupt the
// shared module-level default.
state.program = { ...DEFAULT_STATE.program, items: [] };

// The stage window is a dumb renderer and never needs the program item array
// (rule 3.2) — it only gets the two strings the program layer derives: label
// and nextLabel, which are already top-level state fields.
function toDisplayState(state) {
  const { program, ...rest } = state;
  return rest;
}

// Phones get the full state, program included — they show and edit the
// segment list. Main only fans it out while phone control is on.
function push() {
  savePersisted();
  window.api.send('state', toDisplayState(state));
  window.api.sendRemoteState(state);
}

// --- transport -------------------------------------------------------

function armedDuration() {
  if (state.mode === 'duration') return state.durationMs;
  if (state.mode === 'clock') return Math.max(0, nextClockTarget(state.clockTarget) - Date.now());
  return 0;
}

function start() {
  const now = Date.now();

  if (state.mode === 'countup') {
    state.startedAt = state.status === 'paused' ? now - state.frozenMs : now;
    state.status = 'running';
    push();
    return;
  }

  const ms = state.status === 'paused' ? state.frozenMs : armedDuration();
  if (state.status !== 'paused') state.totalMs = Math.max(1, ms);
  state.endsAt = now + ms;
  state.status = 'running';
  push();
}

function pause() {
  state.frozenMs = readout(state).ms; // freeze the derived value
  state.status = 'paused';
  push();
}

function toggleTransport() {
  if (state.status === 'running') pause();
  else withDisplayReady(start);
}

function reset() {
  state.status = 'idle';
  state.endsAt = null;
  state.startedAt = null;
  const ms = state.mode === 'countup' ? 0 : armedDuration();
  state.frozenMs = ms;
  state.totalMs = Math.max(1, ms);
  push();
}

function nudge(deltaMs) {
  if (state.mode === 'countup') return;
  state.timerTouched = true;
  if (state.status === 'running') {
    state.endsAt += deltaMs;
  } else {
    state.frozenMs = Math.max(0, state.frozenMs + deltaMs);
    state.totalMs = Math.max(1, state.frozenMs);
    if (state.mode === 'duration') state.durationMs = state.frozenMs;
  }
  push();
}

// --- modes -------------------------------------------------------

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  durationPresets.style.display = mode === 'duration' ? 'grid' : 'none';
  durationField.style.display = mode === 'duration' ? 'block' : 'none';
  clockField.style.display = mode === 'clock' ? 'block' : 'none';
  // Switching into "At" mode without ever having set a target should show
  // right now, not whatever moment the app happened to launch.
  if (mode === 'clock' && !state.clockTargetTouched) {
    state.clockTarget = currentHHMMSS();
    clockField.value = state.clockTarget;
  }
  if (state.status === 'idle') reset();
  else push();
}

function setPresetMinutes(min) {
  state.mode = 'duration';
  state.timerTouched = true;
  state.durationMs = min * 60000;
  durationField.value = formatTime(state.durationMs);
  if (state.status !== 'running') {
    state.frozenMs = state.durationMs;
    state.totalMs = state.durationMs;
  }
  push();
}

function setDurationMs(ms) {
  state.timerTouched = true;
  state.durationMs = ms;
  if (state.status !== 'running') {
    state.frozenMs = ms;
    state.totalMs = Math.max(1, ms);
  }
  durationField.value = formatTime(ms);
  push();
}

// --- DOM wiring -------------------------------------------------------

// Set before anything paints: on macOS the window is transparent so the
// sidebar can show the native vibrancy material (see main.js).
if (window.api.platform === 'darwin') document.documentElement.classList.add('vibrant');

const hero = document.getElementById('hero');
const heroLabel = document.getElementById('heroLabel');
const heroProgress = document.getElementById('heroProgress');
const previewClock = document.getElementById('previewClock');
const previewStatus = document.getElementById('previewStatus');
const liveDot = document.getElementById('liveDot');

// --- updates -------------------------------------------------------

const updateBanner = document.getElementById('updateBanner');
const updateBannerText = document.getElementById('updateBannerText');
const whatsNewBtn = document.getElementById('whatsNewBtn');
const installUpdateBtn = document.getElementById('installUpdateBtn');
const updateDialog = document.getElementById('updateDialog');
const updateDialogTitle = document.getElementById('updateDialogTitle');
const updateDialogSub = document.getElementById('updateDialogSub');
const updateNotes = document.getElementById('updateNotes');
const updateLaterBtn = document.getElementById('updateLaterBtn');
const updateActionBtn = document.getElementById('updateActionBtn');

const UPDATE_SEEN_KEY = 'stagetimer.updateSeen';
let currentUpdate = null;

// Release notes arrive as HTML from GitHub. Rebuild them from a short list of
// formatting tags, copying text only — never inject the HTML itself.
const NOTE_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'P', 'UL', 'OL', 'LI', 'STRONG', 'B', 'EM', 'I', 'CODE', 'BR']);

function copySafeNodes(src, dest) {
  src.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      dest.appendChild(document.createTextNode(node.textContent));
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (NOTE_TAGS.has(node.tagName)) {
        const el = document.createElement(node.tagName.toLowerCase());
        copySafeNodes(node, el);
        dest.appendChild(el);
      } else {
        copySafeNodes(node, dest); // unwrap links, divs and anything else
      }
    }
  });
}

function renderReleaseNotes(notes) {
  updateNotes.innerHTML = '';
  updateNotes.classList.toggle('plain', !/<[a-z]/i.test(notes));
  if (!notes.trim()) {
    updateNotes.textContent = 'No release notes were published for this version.';
  } else if (updateNotes.classList.contains('plain')) {
    updateNotes.textContent = notes;
  } else {
    copySafeNodes(new DOMParser().parseFromString(notes, 'text/html').body, updateNotes);
  }
}

function updateActionLabel(u) {
  if (u.stage === 'ready') return 'Restart & update';
  if (u.stage === 'available') return 'Download';
  return 'Downloading…';
}

function showUpdate(u) {
  if (!u) return;
  currentUpdate = u;
  updateBanner.style.display = 'flex';
  updateBannerText.textContent =
    u.stage === 'ready' ? `v${u.version} ready` : u.stage === 'available' ? `v${u.version} available` : `Downloading v${u.version}…`;
  installUpdateBtn.style.display = u.stage === 'downloading' ? 'none' : '';
  installUpdateBtn.textContent = updateActionLabel(u);

  updateDialogTitle.textContent = `What’s new in Stage Timer ${u.version}`;
  updateDialogSub.textContent =
    u.stage === 'ready'
      ? 'The update is downloaded. It installs when you restart — nothing changes until you choose to.'
      : u.stage === 'available'
        ? 'Download the new version and install it over this one. Your saved programs are kept.'
        : 'The update is downloading in the background. You can keep working.';
  updateActionBtn.textContent = updateActionLabel(u);
  updateActionBtn.disabled = u.stage === 'downloading';
  renderReleaseNotes(u.notes || '');

  // Pop the notes up once per version, and only while nothing is running —
  // never cover the controls mid-service. The banner stays either way.
  let seen = null;
  try {
    seen = localStorage.getItem(UPDATE_SEEN_KEY);
  } catch {
    // storage unavailable — fall through and show it
  }
  const quiet = state.status === 'idle' && state.program.activeIndex < 0;
  if (u.stage !== 'downloading' && seen !== u.version && quiet && !document.querySelector('dialog[open]')) {
    try {
      localStorage.setItem(UPDATE_SEEN_KEY, u.version);
    } catch {
      // storage unavailable — it'll just show again next launch
    }
    updateDialog.showModal();
  }
}

// Installing only ever happens on an explicit click — never automatically —
// since this app runs live during a service and a forced restart mid-timer
// would be a real incident.
function runUpdateAction() {
  if (!currentUpdate) return;
  if (currentUpdate.stage === 'ready') window.api.installUpdate();
  else if (currentUpdate.stage === 'available') window.api.openUpdatePage();
}

window.api.onUpdateState(showUpdate);
window.api.getUpdateState().then(showUpdate);
whatsNewBtn.addEventListener('click', () => updateDialog.showModal());
installUpdateBtn.addEventListener('click', runUpdateAction);
updateActionBtn.addEventListener('click', () => {
  updateDialog.close();
  runUpdateAction();
});
updateLaterBtn.addEventListener('click', () => updateDialog.close());

const durationPresets = document.getElementById('durationPresets');
const durationField = document.getElementById('durationField');
const clockField = document.getElementById('clockField');

const transportBtn = document.getElementById('transportBtn');
const resetBtn = document.getElementById('resetBtn');

const messagePresets = document.getElementById('messagePresets');
const customMessage = document.getElementById('customMessage');
const clearMessageBtn = document.getElementById('clearMessageBtn');
const flashCheckbox = document.getElementById('flashCheckbox');

const labelField = document.getElementById('labelField');
const blackoutBtn = document.getElementById('blackoutBtn');
const moveScreenBtn = document.getElementById('moveScreenBtn');
const showDisplayBtn = document.getElementById('showDisplayBtn');
const hideDisplayBtn = document.getElementById('hideDisplayBtn');

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    state.timerTouched = true;
    setMode(tab.dataset.mode);
  });
});

durationPresets.querySelectorAll('button').forEach((btn) => {
  btn.addEventListener('click', () => setPresetMinutes(Number(btn.dataset.min)));
});

durationField.addEventListener('change', () => {
  const ms = parseDurationText(durationField.value);
  if (ms === null) {
    durationField.value = formatTime(state.durationMs);
    return;
  }
  setDurationMs(ms);
});

clockField.value = state.clockTarget;
clockField.addEventListener('change', () => {
  const val = clockField.value.trim();
  if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(val)) {
    clockField.value = state.clockTarget;
    return;
  }
  state.clockTarget = val;
  state.clockTargetTouched = true;
  state.timerTouched = true;
  if (state.status !== 'running') reset();
  else push();
});

transportBtn.addEventListener('click', toggleTransport);
resetBtn.addEventListener('click', reset);

document.querySelectorAll('.nudge-row button').forEach((btn) => {
  btn.addEventListener('click', () => nudge(Number(btn.dataset.nudge)));
});

messagePresets.querySelectorAll('button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const msg = btn.dataset.msg;
    state.message = state.message === msg ? '' : msg;
    customMessage.value = '';
    updateMessageButtons();
    push();
  });
});

function updateMessageButtons() {
  messagePresets.querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('active', state.message === btn.dataset.msg);
  });
}

customMessage.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && customMessage.value.trim()) {
    sendMessage(customMessage.value.trim());
  }
});

function sendMessage(text) {
  state.message = text;
  updateMessageButtons();
  push();
}

function clearMessage() {
  state.message = '';
  customMessage.value = '';
  updateMessageButtons();
  push();
}

clearMessageBtn.addEventListener('click', clearMessage);

flashCheckbox.addEventListener('change', () => {
  state.flash = flashCheckbox.checked;
  push();
});

labelField.value = state.label;
labelField.addEventListener('input', () => {
  state.label = labelField.value;
  push();
});

function setBlackout(on) {
  state.blackout = on;
  blackoutBtn.textContent = on ? 'Blackout on' : 'Blackout';
  blackoutBtn.classList.toggle('on', on);
  push();
}

blackoutBtn.addEventListener('click', () => setBlackout(!state.blackout));

moveScreenBtn.addEventListener('click', () => window.api.nextScreen());
hideDisplayBtn.addEventListener('click', () => window.api.hideDisplay());

// --- screen picker -------------------------------------------------------
// The stage window never appears until the operator explicitly chooses a
// screen for it — this is what runs the first time Start (or Send to
// screen, or Next) is pressed in a session.

const screenPickerDialog = document.getElementById('screenPickerDialog');
const screenPickerList = document.getElementById('screenPickerList');
const screenPickerCancelBtn = document.getElementById('screenPickerCancelBtn');

async function openScreenPicker(afterPick) {
  const screens = await window.api.listScreens();
  screenPickerList.innerHTML = '';
  screens.forEach((s) => {
    const btn = document.createElement('button');
    const bits = [`Display ${s.index + 1} — ${s.width}×${s.height}`];
    if (s.isPrimary) bits.push('(built-in)');
    if (s.isCurrent) bits.push('— this screen');
    btn.textContent = bits.join(' ');
    if (s.isCurrent) btn.classList.add('screen-picker-current');
    btn.addEventListener('click', async () => {
      await window.api.openDisplayOnScreen(s.index);
      screenPickerDialog.close();
      if (afterPick) afterPick();
    });
    screenPickerList.appendChild(btn);
  });
  screenPickerDialog.showModal();
}

screenPickerCancelBtn.addEventListener('click', () => screenPickerDialog.close());

async function withDisplayReady(action) {
  const has = await window.api.hasDisplay();
  if (has) action();
  else openScreenPicker(action);
}

function sendToScreen() {
  withDisplayReady(() => window.api.showDisplay());
}

showDisplayBtn.addEventListener('click', sendToScreen);

window.api.onScreensChanged((count) => {
  moveScreenBtn.disabled = count <= 1;
});
window.api.screenCount().then((count) => {
  moveScreenBtn.disabled = count <= 1;
});

// --- phone control -------------------------------------------------------
// Commands arrive already filtered to a known type by remote.js; arguments
// are still checked here, since this is where they touch state. Start and
// Next run directly rather than through withDisplayReady, so a phone never
// pops the screen picker up on the operator's laptop.

const MODES = ['duration', 'clock', 'countup'];
const HOUR_MS = 3600000;

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function handleRemoteCommand(cmd) {
  switch (cmd.type) {
    case 'toggle':
      if (state.status === 'running') pause();
      else start();
      break;
    case 'reset':
      reset();
      break;
    case 'nudge':
      if (isFiniteNumber(cmd.ms) && Math.abs(cmd.ms) <= HOUR_MS) nudge(cmd.ms);
      break;
    case 'setDuration':
      if (isFiniteNumber(cmd.ms) && cmd.ms > 0 && cmd.ms <= 24 * HOUR_MS) {
        if (state.mode !== 'duration') setMode('duration');
        setDurationMs(Math.round(cmd.ms));
      }
      break;
    case 'setMode':
      if (MODES.includes(cmd.mode)) {
        state.timerTouched = true;
        setMode(cmd.mode);
      }
      break;
    case 'next':
      advance(1);
      break;
    case 'previous':
      previousItem();
      break;
    case 'jump':
      if (Number.isInteger(cmd.index)) jumpTo(cmd.index);
      break;
    case 'editProgram':
      applyProgramEdits(cmd.items);
      break;
    case 'message':
      if (typeof cmd.text === 'string' && cmd.text.trim()) sendMessage(cmd.text.trim().slice(0, 200));
      break;
    case 'clearMessage':
      clearMessage();
      break;
    default:
      break;
  }
}

window.api.onRemoteCommand(handleRemoteCommand);

const remoteCheckbox = document.getElementById('remoteCheckbox');
const remotePanel = document.getElementById('remotePanel');
const remoteQr = document.getElementById('remoteQr');
const remoteUrl = document.getElementById('remoteUrl');
const remotePin = document.getElementById('remotePin');
const remoteStatus = document.getElementById('remoteStatus');
const remoteError = document.getElementById('remoteError');

// Deliberately not persisted: phone control is off on every launch.
remoteCheckbox.addEventListener('change', async () => {
  remoteError.textContent = '';
  if (!remoteCheckbox.checked) {
    await window.api.remoteStop();
    remotePanel.style.display = 'none';
    return;
  }
  const result = await window.api.remoteStart();
  if (result.error) {
    remoteCheckbox.checked = false;
    remoteError.textContent = result.error;
    return;
  }
  remoteQr.src = result.qrDataUrl;
  remoteUrl.textContent = result.url;
  remotePin.textContent = result.pin;
  remotePanel.style.display = 'flex';
  push(); // give the server a snapshot to hand the first phone
});

window.api.onRemoteStatus((count) => {
  remoteStatus.textContent =
    count === 0 ? 'No phones connected' : `${count} phone${count === 1 ? '' : 's'} connected`;
  remoteStatus.classList.toggle('connected', count > 0);
});

// --- keyboard, ignored while typing in an input or with a dialog open -------------------------------------------------------

document.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (document.querySelector('dialog[open]')) return;

  switch (e.code) {
    case 'Space':
      e.preventDefault();
      toggleTransport();
      break;
    case 'KeyR':
      reset();
      break;
    case 'KeyB':
      setBlackout(!state.blackout);
      break;
    case 'ArrowUp':
      e.preventDefault();
      nudge(60000);
      break;
    case 'ArrowDown':
      e.preventDefault();
      nudge(-60000);
      break;
    case 'ArrowLeft':
      e.preventDefault();
      nudge(-15000);
      break;
    case 'ArrowRight':
      e.preventDefault();
      nudge(15000);
      break;
    case 'Escape':
      clearMessage();
      break;
    case 'KeyS':
      sendToScreen();
      break;
    case 'KeyH':
      window.api.hideDisplay();
      break;
    case 'KeyN':
      withDisplayReady(() => advance(1));
      break;
    case 'KeyP':
      previousItem();
      break;
    default:
      if (/^Digit[1-9]$/.test(e.code)) {
        jumpTo(Number(e.code.slice(5)) - 1);
      }
      break;
  }
});

// --- local preview repaint -------------------------------------------------------

function repaint() {
  const idleUntouched = state.status === 'idle' && !state.timerTouched;
  const { ms } = readout(state);
  previewClock.textContent = idleUntouched
    ? currentHHMMSS()
    : tone(state, ms) === 'over' ? 'Time Up' : formatTime(ms);

  const running = state.status === 'running';
  // The hero tints with the same tone scale the stage uses; idle stays neutral.
  hero.dataset.tone = state.status === 'idle' ? 'idle' : tone(state, ms);
  heroProgress.style.transform = `scaleX(${state.status === 'idle' ? 0 : progress(state, ms)})`;
  heroLabel.textContent = state.label || '';
  transportBtn.classList.toggle('is-running', running);
  liveDot.classList.toggle('live', running);
  previewStatus.classList.toggle('live', running);

  if (idleUntouched) {
    previewStatus.textContent = 'Current time — nothing set yet';
  } else if (state.status === 'idle') {
    previewStatus.textContent = 'Idle';
  } else {
    const endsLabel =
      state.mode === 'countup'
        ? ''
        : ` · ends ${clockNow(new Date(running ? state.endsAt : Date.now() + state.frozenMs))}`;
    previewStatus.textContent = `${running ? 'Running' : 'Paused'}${endsLabel}`;
  }

  transportBtn.textContent = running ? 'Pause' : state.status === 'paused' ? 'Resume' : 'Start';

  checkAutoAdvance();
  repaintProgram();
}

setInterval(repaint, 200);

// initial UI sync
setMode(state.mode);
durationField.value = formatTime(state.durationMs);
updateMessageButtons();
repaint();
push();
initProgram();
