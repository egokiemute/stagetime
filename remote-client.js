// Phone remote. Loaded after shared.js, so readout/tone/formatTime and the
// rest of the time maths are the same code the laptop runs. The laptop owns
// state: this page only renders snapshots and sends commands back.

const TOKEN_KEY = 'stagetimer.remoteToken';

let token = null;
let events = null;
let state = null;
let skewMs = 0; // laptop clock minus phone clock

function now() {
  return Date.now() + skewMs;
}

function readToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeToken(value) {
  try {
    if (value) sessionStorage.setItem(TOKEN_KEY, value);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // private mode — the token just won't survive a reload
  }
}

// --- DOM -------------------------------------------------------

const $ = (id) => document.getElementById(id);

const pinScreen = $('pinScreen');
const pinInput = $('pinInput');
const pinSubmitBtn = $('pinSubmitBtn');
const pinError = $('pinError');
const mainScreen = $('mainScreen');

const connDot = $('connDot');
const connLabel = $('connLabel');
const programTitle = $('programTitle');
const labelText = $('labelText');
const clockText = $('clockText');
const statusText = $('statusText');
const messageText = $('messageText');

const toggleBtn = $('toggleBtn');
const resetBtn = $('resetBtn');
const durationInput = $('durationInput');
const setDurationBtn = $('setDurationBtn');
const programList = $('programList');
const prevBtn = $('prevBtn');
const nextBtn = $('nextBtn');
const editBtn = $('editBtn');
const customMessage = $('customMessage');
const sendMessageBtn = $('sendMessageBtn');
const clearMessageBtn = $('clearMessageBtn');

const editSheet = $('editSheet');
const editList = $('editList');
const editAddBtn = $('editAddBtn');
const editSummary = $('editSummary');
const editCancelBtn = $('editCancelBtn');
const editApplyBtn = $('editApplyBtn');

// --- connection -------------------------------------------------------

function showPin(message) {
  if (events) events.close();
  events = null;
  token = null;
  state = null;
  writeToken(null);
  editSheet.hidden = true;
  mainScreen.hidden = true;
  pinScreen.hidden = false;
  pinError.textContent = message || '';
  pinInput.value = '';
}

function setConnected(ok) {
  connDot.classList.toggle('ok', ok);
  connLabel.textContent = ok ? 'Connected' : 'Reconnecting…';
}

function connect() {
  pinScreen.hidden = true;
  mainScreen.hidden = false;
  events = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  events.onopen = () => setConnected(true);
  events.onmessage = (e) => {
    const data = JSON.parse(e.data);
    skewMs = data.serverNow - Date.now();
    state = data.state;
    setConnected(true);
    render();
  };
  // Sent by the laptop when the operator switches phone control off.
  events.addEventListener('closed', () => showPin('Phone control was turned off.'));
  events.onerror = () => {
    // CLOSED means the server refused us (token no longer valid); otherwise
    // the browser is already retrying on its own.
    if (events && events.readyState === EventSource.CLOSED) showPin('Disconnected — enter the PIN again.');
    else setConnected(false);
  };
}

async function login() {
  const pin = pinInput.value.trim();
  if (!/^\d{4}$/.test(pin)) {
    pinError.textContent = 'The PIN is 4 digits.';
    return;
  }
  pinSubmitBtn.disabled = true;
  try {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      pinError.textContent = body.error || 'Could not connect.';
      return;
    }
    token = body.token;
    writeToken(token);
    pinError.textContent = '';
    connect();
  } catch {
    pinError.textContent = 'Could not reach the laptop.';
  } finally {
    pinSubmitBtn.disabled = false;
  }
}

async function send(cmd) {
  if (!token) return;
  try {
    const res = await fetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-remote-token': token },
      body: JSON.stringify(cmd)
    });
    if (res.status === 401) showPin('Disconnected — enter the PIN again.');
  } catch {
    setConnected(false);
  }
}

pinSubmitBtn.addEventListener('click', login);
pinInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') login();
});

// --- render -------------------------------------------------------

// Mirrors repaint() in control.js, so the phone reads exactly like the laptop.
function renderClock() {
  if (!state) return;
  const t = now();
  const idleUntouched = state.status === 'idle' && !state.timerTouched;
  const { ms } = readout(state, t);
  const currentTone = idleUntouched ? 'normal' : tone(state, ms);
  clockText.textContent = idleUntouched
    ? currentHHMMSS(new Date(t))
    : currentTone === 'over' ? 'Time Up' : formatTime(ms);
  clockText.className = `clock tone-${currentTone}`;

  const running = state.status === 'running';
  statusText.classList.toggle('live', running);
  if (idleUntouched) {
    statusText.textContent = 'Current time — nothing set yet';
  } else if (state.status === 'idle') {
    statusText.textContent = 'Idle';
  } else {
    const endsLabel =
      state.mode === 'countup'
        ? ''
        : ` · ends ${clockNow(new Date(running ? state.endsAt : t + state.frozenMs))}`;
    statusText.textContent = `${running ? 'Running' : 'Paused'}${endsLabel}`;
  }
  toggleBtn.textContent = running ? 'Pause' : state.status === 'paused' ? 'Resume' : 'Start';
}

function renderProgramList() {
  const p = state.program;
  programList.innerHTML = '';
  p.items.forEach((it, i) => {
    const row = document.createElement('button');
    row.className = 'program-row';
    if (i === p.activeIndex) row.classList.add('current');

    const marker = document.createElement('span');
    marker.className = 'marker';
    marker.textContent = it.skipped ? '⏭' : i === p.activeIndex ? '▶' : it.actualEndedAt ? '✓' : '';

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = it.name;

    const nums = document.createElement('span');
    nums.className = 'nums';
    nums.textContent = `${Math.round(it.plannedMs / 60000)}m`;

    row.append(marker, name, nums);
    row.addEventListener('click', () => {
      if (i === p.activeIndex) return;
      if (window.confirm(`Jump to "${it.name}"?`)) send({ type: 'jump', index: i });
    });
    programList.appendChild(row);
  });
  prevBtn.disabled = p.activeIndex <= 0;
  nextBtn.disabled = !p.items.length;
}

function render() {
  if (!state) return;
  programTitle.textContent = state.program.name || '';
  labelText.textContent = state.label || '';
  messageText.textContent = state.message ? `On stage: “${state.message}”` : '';
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.mode === state.mode);
  });
  document.querySelectorAll('#messagePresets button').forEach((btn) => {
    btn.classList.toggle('active', state.message === btn.dataset.msg);
  });
  renderProgramList();
  renderClock();
}

setInterval(renderClock, 200);

// --- controls -------------------------------------------------------

toggleBtn.addEventListener('click', () => send({ type: 'toggle' }));
resetBtn.addEventListener('click', () => send({ type: 'reset' }));

document.querySelectorAll('[data-nudge]').forEach((btn) => {
  btn.addEventListener('click', () => send({ type: 'nudge', ms: Number(btn.dataset.nudge) }));
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => send({ type: 'setMode', mode: tab.dataset.mode }));
});

function submitDuration() {
  const ms = parseDurationText(durationInput.value);
  if (!ms) return;
  send({ type: 'setDuration', ms });
  durationInput.value = '';
  durationInput.blur();
}

setDurationBtn.addEventListener('click', submitDuration);
durationInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitDuration();
});

prevBtn.addEventListener('click', () => send({ type: 'previous' }));
nextBtn.addEventListener('click', () => send({ type: 'next' }));

document.querySelectorAll('#messagePresets button').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (state && state.message === btn.dataset.msg) send({ type: 'clearMessage' });
    else send({ type: 'message', text: btn.dataset.msg });
  });
});

function submitMessage() {
  const text = customMessage.value.trim();
  if (!text) return;
  send({ type: 'message', text });
  customMessage.value = '';
  customMessage.blur();
}

sendMessageBtn.addEventListener('click', submitMessage);
customMessage.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitMessage();
});
clearMessageBtn.addEventListener('click', () => send({ type: 'clearMessage' }));

// --- edit sheet -------------------------------------------------------
// Same rules as the laptop's Edit dialog: started segments can be renamed and
// retimed, but only upcoming ones can be removed or moved.

let editDraft = [];
let editLocked = 0;

function smallButton(label, enabled, onClick) {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.disabled = !enabled;
  btn.addEventListener('click', onClick);
  return btn;
}

function moveDraftItem(from, to) {
  const [item] = editDraft.splice(from, 1);
  editDraft.splice(to, 0, item);
  renderEditList();
}

function renderEditList() {
  editList.innerHTML = '';
  editDraft.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'edit-row';
    if (i < editLocked) row.classList.add('edit-row-locked');

    const nameInput = document.createElement('input');
    nameInput.className = 'field';
    nameInput.type = 'text';
    nameInput.maxLength = 80;
    nameInput.value = item.name;
    nameInput.addEventListener('input', () => {
      item.name = nameInput.value;
    });

    const durInput = document.createElement('input');
    durInput.className = 'field';
    durInput.type = 'text';
    durInput.inputMode = 'decimal';
    durInput.value = formatTime(item.plannedMs);
    durInput.addEventListener('change', () => {
      const ms = parseDurationText(durInput.value);
      if (ms) item.plannedMs = ms;
      durInput.value = formatTime(item.plannedMs);
      updateEditSummary();
    });

    const movable = i >= editLocked;
    const actions = document.createElement('div');
    actions.className = 'edit-row-actions';
    actions.append(
      smallButton('↑ Up', movable && i - 1 >= editLocked, () => moveDraftItem(i, i - 1)),
      smallButton('↓ Down', movable && i + 1 < editDraft.length, () => moveDraftItem(i, i + 1)),
      smallButton('Remove', movable, () => {
        editDraft.splice(i, 1);
        renderEditList();
      })
    );

    row.append(nameInput, durInput, actions);
    editList.appendChild(row);
  });
  updateEditSummary();
}

function updateEditSummary() {
  const totalMin = Math.round(editDraft.reduce((s, it) => s + it.plannedMs, 0) / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const total = h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
  editSummary.textContent = editDraft.length ? `${editDraft.length} segments · ${total} total` : 'No segments';
}

editBtn.addEventListener('click', () => {
  if (!state) return;
  const p = state.program;
  editLocked = p.activeIndex < 0 ? 0 : Math.min(p.activeIndex + 1, p.items.length);
  editDraft = p.items.map((it) => ({ id: it.id, name: it.name, plannedMs: it.plannedMs }));
  renderEditList();
  editSheet.hidden = false;
});

editAddBtn.addEventListener('click', () => {
  editDraft.push({ id: null, name: 'New segment', plannedMs: 5 * 60000 });
  renderEditList();
});

editCancelBtn.addEventListener('click', () => {
  editSheet.hidden = true;
});

editApplyBtn.addEventListener('click', () => {
  send({ type: 'editProgram', items: editDraft });
  editSheet.hidden = true;
});

// --- boot -------------------------------------------------------

token = readToken();
if (token) connect();
