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
    mode, durationMs, clockTarget, clockTargetTouched, label, warnSec, dangerSec, showClock, showNextUp
  } = state;
  localStorage.setItem(
    PERSIST_KEY,
    JSON.stringify({
      mode, durationMs, clockTarget, clockTargetTouched, label, warnSec, dangerSec, showClock, showNextUp
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

function push() {
  savePersisted();
  window.api.send('state', toDisplayState(state));
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
  state.durationMs = min * 60000;
  durationField.value = formatTime(state.durationMs);
  if (state.status !== 'running') {
    state.frozenMs = state.durationMs;
    state.totalMs = state.durationMs;
  }
  push();
}

function parseDurationText(text) {
  const t = text.trim();
  if (!t) return null;
  const parts = t.split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n)) || parts.length > 3) return null;
  let totalSec;
  if (parts.length === 1) totalSec = parts[0] * 60;
  else if (parts.length === 2) totalSec = parts[0] * 60 + parts[1];
  else totalSec = parts[0] * 3600 + parts[1] * 60 + parts[2];
  return Math.max(0, totalSec * 1000);
}

// --- DOM wiring -------------------------------------------------------

const previewClock = document.getElementById('previewClock');
const previewStatus = document.getElementById('previewStatus');
const liveDot = document.getElementById('liveDot');

const updateBanner = document.getElementById('updateBanner');
const updateBannerText = document.getElementById('updateBannerText');
const installUpdateBtn = document.getElementById('installUpdateBtn');

window.api.onUpdateReady((version) => {
  updateBannerText.textContent = `Update v${version} ready —`;
  updateBanner.style.display = 'flex';
});

// Only ever fires on this explicit click — never automatically — since this
// app runs live during a service and a forced restart mid-timer would be a
// real incident.
installUpdateBtn.addEventListener('click', () => window.api.installUpdate());

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
  tab.addEventListener('click', () => setMode(tab.dataset.mode));
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
  state.durationMs = ms;
  if (state.status !== 'running') {
    state.frozenMs = ms;
    state.totalMs = Math.max(1, ms);
  }
  durationField.value = formatTime(ms);
  push();
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
    state.message = customMessage.value.trim();
    updateMessageButtons();
    push();
  }
});

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

// --- keyboard, ignored while typing in an input -------------------------------------------------------

document.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;

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
  const { ms } = readout(state);
  previewClock.textContent = tone(state, ms) === 'over' ? 'Time Up' : formatTime(ms);

  const running = state.status === 'running';
  liveDot.classList.toggle('live', running);
  previewStatus.classList.toggle('live', running);

  if (state.status === 'idle') {
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
