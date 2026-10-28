// Run-of-service layer on top of the existing timer. Loaded by the control
// window only — the stage window never sees this file or the item array
// (rule 3.2; the program decides *what* the timer counts, not *how*).
//
// Script order in control.html is shared.js, program.js, control.js: this
// file only *defines* functions/DOM refs at load time, so it's safe to
// reference control.js's globals (state, push, reset, start) from inside
// those functions — they exist by the time anything here actually runs.
// control.js calls initProgram() as the very last thing it does.

// --- duration grammar -------------------------------------------------------

function parseDurationToken(rawToken) {
  const token = rawToken.trim();
  if (!token) return null;

  const colon = token.match(/^(\d+)\s*:\s*(\d+)$/);
  if (colon) return (Number(colon[1]) * 60 + Number(colon[2])) * 60000;

  const hourPlusBare = token.match(/^(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\s+(\d+(?:\.\d+)?)$/i);
  if (hourPlusBare) {
    return Math.round(parseFloat(hourPlusBare[1]) * 3600000 + parseFloat(hourPlusBare[2]) * 60000);
  }

  const UNIT_RE = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/gi;
  let match;
  let totalMs = 0;
  let matched = false;
  while ((match = UNIT_RE.exec(token))) {
    matched = true;
    const n = parseFloat(match[1]);
    const unit = match[2][0].toLowerCase();
    if (unit === 'h') totalMs += n * 3600000;
    else if (unit === 'm') totalMs += n * 60000;
    else totalMs += n * 1000;
  }
  if (matched) return Math.round(totalMs);

  const bare = token.match(/^(\d+(?:\.\d+)?)$/);
  if (bare) return Math.round(parseFloat(bare[1]) * 60000);

  return null;
}

// Trying most-specific patterns first avoids "1hr" being mis-caught by the
// bare-number fallback, and anchoring every pattern at $ avoids tripping on
// numbers inside names like "2 Corinthians reading".
const TRAILING_DURATION_PATTERNS = [
  /(\d+\s*:\s*\d+)\s*$/,
  /(\d+(?:\.\d+)?\s*(?:hours?|hrs?|h)\s+\d+(?:\.\d+)?)\s*$/i,
  /(\d+(?:\.\d+)?\s*(?:hours?|hrs?|h)(?:\s*\d+(?:\.\d+)?\s*(?:minutes?|mins?|m))?)\s*$/i,
  /(\d+(?:\.\d+)?\s*(?:minutes?|mins?|m))\s*$/i,
  /(\d+(?:\.\d+)?\s*(?:seconds?|secs?|s))\s*$/i,
  /(\d+(?:\.\d+)?)\s*$/
];

function splitNameAndDuration(line) {
  for (const pattern of TRAILING_DURATION_PATTERNS) {
    const m = line.match(pattern);
    if (m && m.index !== undefined) {
      const durationMs = parseDurationToken(m[1]);
      const name = line.slice(0, m.index).replace(/[\s:\-–—.]+$/, '').trim();
      if (durationMs !== null && name) return { name, durationMs };
    }
  }
  return null;
}

const FLEXIBLE_NAME_RE = /praise|worship|offering|announcement|testimon/i;

// Saved programs carry ids from earlier sessions, so a bare per-launch counter
// would hand out ids that already exist in a loaded program.
let itemCounter = 0;
function nextItemId() {
  itemCounter += 1;
  return 'itm_' + Date.now().toString(36) + '_' + itemCounter;
}

function makeItem(name, plannedMs, extra) {
  return Object.assign(
    {
      id: nextItemId(),
      name,
      plannedMs,
      actualStartedAt: null,
      actualEndedAt: null,
      autoAdvance: false,
      flexible: FLEXIBLE_NAME_RE.test(name),
      anchorAt: null,
      note: '',
      skipped: false
    },
    extra
  );
}

// --- shape A: name + duration -------------------------------------------------------

function parseLine(rawLine) {
  const trimmed = rawLine.trim();
  if (!trimmed) return null; // blank, skip entirely
  if (!/\d/.test(trimmed)) return null; // header line, skip entirely

  const stripped = trimmed.replace(/^[\s\-*•]*(\d+[.)])?\s*/, '');
  const result = splitNameAndDuration(stripped);
  if (!result) return { unreadable: true, raw: rawLine };
  return { unreadable: false, name: result.name, durationMs: result.durationMs, raw: rawLine };
}

function buildDurationItems(lines) {
  const items = [];
  const unreadable = [];
  lines.forEach((rawLine) => {
    const parsed = parseLine(rawLine);
    if (parsed === null) return;
    if (parsed.unreadable) {
      unreadable.push(parsed);
      return;
    }
    items.push(makeItem(parsed.name, parsed.durationMs));
  });
  return { items, unreadable };
}

// --- shape B: timetable -------------------------------------------------------

const CLOCK_LEAD_RE = /^\s*(\d{1,2}):(\d{2})\s*(am|pm)?\b/i;

function to24Hour(hh, mm, ampm) {
  let h = Number(hh);
  const m = Number(mm);
  if (ampm) {
    const isPM = ampm.toLowerCase() === 'pm';
    if (h === 12) h = isPM ? 12 : 0;
    else if (isPM) h += 12;
  }
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function clockMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function detectShape(lines) {
  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
  if (!nonEmpty.length) return 'durations';
  const clockCount = nonEmpty.filter((l) => CLOCK_LEAD_RE.test(l)).length;
  return clockCount > nonEmpty.length / 2 ? 'timetable' : 'durations';
}

function parseTimetableLines(lines) {
  const rows = [];
  lines.forEach((rawLine) => {
    const trimmed = rawLine.trim();
    if (!trimmed) return;
    const m = trimmed.match(CLOCK_LEAD_RE);
    if (!m) {
      rows.push({ unreadable: true, raw: rawLine });
      return;
    }
    const anchorAt = to24Hour(m[1], m[2], m[3]);
    const name = trimmed.slice(m[0].length).replace(/^[\s:\-–—.]+/, '').trim();
    if (!name) {
      rows.push({ unreadable: true, raw: rawLine });
      return;
    }
    rows.push({ unreadable: false, raw: rawLine, name, anchorAt, minutes: clockMinutes(anchorAt) });
  });
  return rows;
}

function buildTimetableItems(rows) {
  const items = [];
  const unreadable = rows.filter((r) => r.unreadable);
  const valid = rows.filter((r) => !r.unreadable);
  let serviceEndAnchor = null;

  for (let i = 0; i < valid.length; i++) {
    const cur = valid[i];
    const next = valid[i + 1];
    if (!next) {
      serviceEndAnchor = { name: cur.name, anchorAt: cur.anchorAt, raw: cur.raw };
      break;
    }
    const diffMin = next.minutes - cur.minutes;
    if (diffMin <= 0) {
      unreadable.push({ unreadable: true, raw: cur.raw });
      continue;
    }
    items.push(makeItem(cur.name, diffMin * 60000, { anchorAt: cur.anchorAt }));
  }

  return { items, unreadable, serviceEndAnchor };
}

// --- top-level parse -------------------------------------------------------

function parseProgram(text) {
  const lines = text.split('\n');
  const shape = detectShape(lines);

  let items;
  let unreadable;
  let serviceEndAnchor = null;

  if (shape === 'timetable') {
    ({ items, unreadable, serviceEndAnchor } = buildTimetableItems(parseTimetableLines(lines)));
  } else {
    ({ items, unreadable } = buildDurationItems(lines));
  }

  const totalMs = items.reduce((s, it) => s + it.plannedMs, 0);
  return { shape, items, unreadable, serviceEndAnchor, totalMs };
}

// --- navigation -------------------------------------------------------

function nextItemName(i) {
  const item = state.program.items[i + 1];
  return item ? item.name : '';
}

function loadItem(i) {
  const item = state.program.items[i];
  if (!item) return;
  state.program.activeIndex = i;
  state.mode = 'duration';
  state.timerTouched = true;
  state.durationMs = item.plannedMs;
  state.label = item.name;
  state.nextLabel = nextItemName(i);
  reset();
}

function advance(delta = 1) {
  const p = state.program;
  if (!p.items.length) return;
  if (!p.startedAt) p.startedAt = Date.now();

  const cur = p.items[p.activeIndex];
  if (cur) cur.actualEndedAt = Date.now();

  const next = p.activeIndex + delta;
  if (next < 0) return;
  if (next >= p.items.length) {
    endService();
    return;
  }

  if (delta > 1) {
    for (let k = p.activeIndex + 1; k < next; k++) p.items[k].skipped = true;
  }

  loadItem(next);
  p.items[next].actualStartedAt = Date.now();
  p.items[next].skipped = false;
  if (p.autoStartOnAdvance) start();
  push();
}

function previousItem() {
  const p = state.program;
  if (p.activeIndex <= 0) return;
  const target = p.activeIndex - 1;
  const item = p.items[target];
  item.actualStartedAt = null;
  item.actualEndedAt = null;
  item.skipped = false;
  loadItem(target);
  item.actualStartedAt = Date.now();
  if (p.autoStartOnAdvance) start();
  push();
}

function jumpTo(i) {
  const p = state.program;
  const item = p.items[i];
  if (!item || i === p.activeIndex) return;
  if (!p.startedAt) p.startedAt = Date.now();

  const cur = p.items[p.activeIndex];
  if (cur) cur.actualEndedAt = Date.now();

  if (i > p.activeIndex) {
    for (let k = Math.max(p.activeIndex + 1, 0); k < i; k++) p.items[k].skipped = true;
  } else {
    for (let k = i + 1; k <= p.activeIndex; k++) {
      p.items[k].skipped = false;
      p.items[k].actualStartedAt = null;
      p.items[k].actualEndedAt = null;
    }
  }

  loadItem(i);
  item.actualStartedAt = Date.now();
  item.skipped = false;
  if (p.autoStartOnAdvance) start();
  push();
}

function endService() {
  const p = state.program;
  const cur = p.items[p.activeIndex];
  if (cur) cur.actualEndedAt = Date.now();
  p.activeIndex = p.items.length;
  state.status = 'idle';
  state.label = '';
  state.nextLabel = '';
  push();
}

// The only automatic advance the spec allows: pre-service countdowns rolling
// into the opening. Every other segment holds in overrun until the operator
// acts.
function checkAutoAdvance() {
  const p = state.program;
  const cur = p.items[p.activeIndex];
  if (!cur || !cur.autoAdvance || state.status !== 'running') return;
  if (readout(state).ms <= 0) advance();
}

// --- projection maths -------------------------------------------------------

function computeProjection(now = Date.now()) {
  const p = state.program;
  if (!p.items.length || p.activeIndex < 0 || p.activeIndex >= p.items.length) return null;

  const plannedToHere = p.items.slice(0, p.activeIndex + 1).reduce((s, it) => s + it.plannedMs, 0);
  const plannedTotal = p.items.reduce((s, it) => s + it.plannedMs, 0);

  let actualToHere = 0;
  for (let i = 0; i < p.activeIndex; i++) {
    const it = p.items[i];
    if (it.actualStartedAt && it.actualEndedAt) actualToHere += it.actualEndedAt - it.actualStartedAt;
  }
  const cur = p.items[p.activeIndex];
  const { ms } = readout(state, now);
  // Exact identity, holds through overrun too: endsAt = actualStartedAt + plannedMs,
  // so elapsed = plannedMs - remaining, and a negative "remaining" just adds
  // the overrun back in.
  actualToHere += cur.plannedMs - ms;

  const drift = actualToHere - plannedToHere;
  const remainingPlan = p.items.slice(p.activeIndex + 1).reduce((s, it) => s + it.plannedMs, 0);
  const projectedEnd = now + Math.max(0, ms) + remainingPlan;

  return { plannedTotal, plannedToHere, actualToHere, drift, remainingPlan, projectedEnd };
}

function formatDrift(proj) {
  if (Math.abs(proj.drift) <= 60000) return 'On time';
  const mins = Math.round(Math.abs(proj.drift) / 60000);
  const endStr = clockNow(new Date(proj.projectedEnd));
  return proj.drift > 0 ? `${mins} min over · finishing ${endStr}` : `${mins} min ahead · finishing ${endStr}`;
}

function driftTone(drift) {
  const absMin = Math.abs(drift) / 60000;
  if (absMin < 5) return 'normal';
  if (absMin < 15) return 'warn';
  return 'danger';
}

function projectedStartOf(j, now = Date.now()) {
  const p = state.program;
  const cur = p.items[p.activeIndex];
  const currentRemaining = cur ? Math.max(0, readout(state, now).ms) : 0;
  let acc = now + currentRemaining;
  for (let k = p.activeIndex + 1; k < j; k++) acc += p.items[k].plannedMs;
  return acc;
}

function anchorWarning(i, now = Date.now()) {
  const item = state.program.items[i];
  if (!item || !item.anchorAt || i <= state.program.activeIndex) return null;
  const projectedStart = projectedStartOf(i, now);
  const anchorMs = nextClockTarget(item.anchorAt, new Date(now));
  const lateMs = projectedStart - anchorMs;
  return lateMs > 60000 ? `starts ${Math.round(lateMs / 60000)} min late` : null;
}

// --- recover time -------------------------------------------------------

let recoverPreviewActive = false;

function recoverableMinutes() {
  const proj = computeProjection();
  if (!proj || proj.drift <= 60000) return 0;
  const flexibleUpcoming = state.program.items.slice(state.program.activeIndex + 1).filter((it) => it.flexible);
  if (!flexibleUpcoming.length) return 0;
  return Math.round(proj.drift / 60000);
}

function computeRecoverPreview() {
  const proj = computeProjection();
  const p = state.program;
  const flexibleUpcoming = p.items.slice(p.activeIndex + 1).filter((it) => it.flexible);
  const totalFlexMs = flexibleUpcoming.reduce((s, it) => s + it.plannedMs, 0);
  if (!proj || proj.drift <= 60000 || !totalFlexMs) return null;

  const perItem = new Map();
  flexibleUpcoming.forEach((it) => {
    const share = it.plannedMs / totalFlexMs;
    const maxCut = Math.max(0, it.plannedMs - 60000); // never trim below a 1-minute floor
    const cut = Math.min(Math.round(proj.drift * share), maxCut);
    perItem.set(it.id, { newPlannedMs: it.plannedMs - cut, cut });
  });
  return { perItem };
}

function applyRecoverTime() {
  const preview = computeRecoverPreview();
  if (!preview) return;
  state.program.items.forEach((it) => {
    const change = preview.perItem.get(it.id);
    if (change) it.plannedMs = change.newPlannedMs;
  });
  push();
}

// --- editing -------------------------------------------------------

const MAX_ITEM_MS = 24 * 3600000;

// Items before and including the running one are history (or on stage right
// now): they can be renamed and retimed, but never removed or reordered.
function lockedCount() {
  const p = state.program;
  return p.activeIndex < 0 ? 0 : Math.min(p.activeIndex + 1, p.items.length);
}

// Accepts drafts from the edit dialog and from phones, so treat every field
// as untrusted.
function sanitizeDraft(draftItems) {
  if (!Array.isArray(draftItems) || draftItems.length > 200) return null;
  const out = [];
  for (const d of draftItems) {
    if (!d || typeof d !== 'object') return null;
    const plannedMs = Math.round(Number(d.plannedMs));
    if (!Number.isFinite(plannedMs)) return null;
    out.push({
      id: typeof d.id === 'string' ? d.id : null,
      name: String(d.name ?? '').trim().slice(0, 80) || 'Untitled',
      plannedMs: Math.min(MAX_ITEM_MS, Math.max(1000, plannedMs))
    });
  }
  return out;
}

function applyProgramEdits(draftItems) {
  const clean = sanitizeDraft(draftItems);
  if (!clean) return false;
  const p = state.program;
  const locked = lockedCount();
  for (let k = 0; k < locked; k++) {
    if (!clean[k] || clean[k].id !== p.items[k].id) return false;
  }

  const byId = new Map(p.items.map((it) => [it.id, it]));
  const seen = new Set();
  const items = clean.map((d) => {
    const existing = d.id && !seen.has(d.id) ? byId.get(d.id) : null;
    if (d.id) seen.add(d.id);
    if (existing) return { ...existing, name: d.name, plannedMs: d.plannedMs };
    return makeItem(d.name, d.plannedMs);
  });

  const wasEnded = p.activeIndex >= p.items.length;
  const active = p.activeIndex >= 0 && !wasEnded ? p.items[p.activeIndex] : null;
  p.items = items;
  if (wasEnded) p.activeIndex = items.length;

  if (active) {
    const updated = items[p.activeIndex];
    const delta = updated.plannedMs - active.plannedMs;
    state.label = updated.name;
    state.nextLabel = nextItemName(p.activeIndex);
    // Retiming the running segment shifts its clock rather than restarting it.
    if (delta && state.mode === 'duration') {
      state.durationMs = updated.plannedMs;
      state.totalMs = Math.max(1, state.totalMs + delta);
      if (state.status === 'running') state.endsAt += delta;
      else state.frozenMs = Math.max(0, state.frozenMs + delta);
    }
  }

  programDirty = true;
  push();
  return true;
}

// --- saved programs + export/import -------------------------------------------------------

const PROGRAMS_KEY = 'stagetimer.programs';
const LAST_PROGRAM_KEY = 'stagetimer.lastProgram';

// True while the loaded program differs from its saved copy (or was never saved).
let programDirty = false;

function loadSavedPrograms() {
  try {
    return JSON.parse(localStorage.getItem(PROGRAMS_KEY)) || {};
  } catch {
    return {};
  }
}

function stripActuals(it) {
  return {
    id: it.id,
    name: it.name,
    plannedMs: it.plannedMs,
    autoAdvance: it.autoAdvance,
    flexible: it.flexible,
    anchorAt: it.anchorAt,
    note: it.note
  };
}

function writeSavedPrograms(all) {
  localStorage.setItem(PROGRAMS_KEY, JSON.stringify(all));
}

function saveProgramAs(name) {
  if (!name) return;
  const all = loadSavedPrograms();
  all[name] = { name, items: state.program.items.map(stripActuals) };
  writeSavedPrograms(all);
  localStorage.setItem(LAST_PROGRAM_KEY, name);
  state.program.name = name;
  programDirty = false;
  push();
  populateSavedProgramsSelect();
}

function renameSavedProgram(oldName, newName) {
  const all = loadSavedPrograms();
  if (!all[oldName] || !newName || all[newName]) return false;
  const renamed = {};
  Object.keys(all).forEach((key) => {
    if (key === oldName) renamed[newName] = { ...all[oldName], name: newName };
    else renamed[key] = all[key];
  });
  writeSavedPrograms(renamed);
  if (localStorage.getItem(LAST_PROGRAM_KEY) === oldName) localStorage.setItem(LAST_PROGRAM_KEY, newName);
  if (state.program.name === oldName) {
    state.program.name = newName;
    push();
  }
  populateSavedProgramsSelect();
  return true;
}

// The loaded program stays loaded — it just no longer has a saved copy.
function deleteSavedProgram(name) {
  const all = loadSavedPrograms();
  if (!all[name]) return;
  delete all[name];
  writeSavedPrograms(all);
  if (localStorage.getItem(LAST_PROGRAM_KEY) === name) localStorage.removeItem(LAST_PROGRAM_KEY);
  if (state.program.name === name) programDirty = true;
  populateSavedProgramsSelect();
}

function loadProgramByName(name) {
  const tpl = loadSavedPrograms()[name];
  if (!tpl) return;
  state.program = {
    name: tpl.name,
    items: tpl.items.map((it) => ({ ...it, actualStartedAt: null, actualEndedAt: null, skipped: false })),
    activeIndex: -1,
    autoStartOnAdvance: state.program.autoStartOnAdvance,
    startedAt: null
  };
  state.label = '';
  state.nextLabel = '';
  localStorage.setItem(LAST_PROGRAM_KEY, name);
  programDirty = false;
  push();
}

// A pasted program is a new program, so it starts unnamed — otherwise Save
// would quietly overwrite whatever saved program was loaded before.
function setItemsFromParsed(items) {
  state.program = {
    name: '',
    items,
    activeIndex: -1,
    autoStartOnAdvance: state.program.autoStartOnAdvance,
    startedAt: null
  };
  state.label = '';
  state.nextLabel = '';
  programDirty = true;
  push();
}

function exportPrograms() {
  const blob = new Blob([JSON.stringify(loadSavedPrograms(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'stagetimer-programs.json';
  a.click();
  URL.revokeObjectURL(url);
}

function importPrograms(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const incoming = JSON.parse(reader.result);
      const all = loadSavedPrograms();
      Object.assign(all, incoming);
      writeSavedPrograms(all);
      populateSavedProgramsSelect();
    } catch {
      // malformed file — ignore rather than corrupt existing saved programs
    }
  };
  reader.readAsText(file);
}

// --- report -------------------------------------------------------

function formatHoursMin(totalMin) {
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

function buildReport(now = Date.now()) {
  const p = state.program;
  const dateStr = new Date(p.startedAt || now).toLocaleDateString('en-US', { day: 'numeric', month: 'long' });
  const startedStr = p.startedAt ? clockNow(new Date(p.startedAt)) : '—';
  const endedStr = clockNow(new Date(now));
  const proj = computeProjection(now);
  const driftLabel = proj ? formatDrift(proj) : '';
  const driftHeadline = driftLabel && driftLabel !== 'On time' ? driftLabel.split(' · ')[0] : driftLabel;

  const nameWidth = Math.max(...p.items.map((it) => it.name.length), 10) + 2;
  const lines = p.items.map((it) => {
    const plannedMin = Math.round(it.plannedMs / 60000);
    if (it.skipped) return `${it.name.padEnd(nameWidth)}skipped`;
    if (!it.actualStartedAt) return `${it.name.padEnd(nameWidth)}not reached`;
    const actualMin = Math.round(((it.actualEndedAt || now) - it.actualStartedAt) / 60000);
    const diff = actualMin - plannedMin;
    const diffStr = diff === 0 ? '' : `   (${diff > 0 ? '+' : ''}${diff})`;
    return `${it.name.padEnd(nameWidth)}${plannedMin} → ${actualMin}${diffStr}`;
  });

  const plannedTotalMin = Math.round(p.items.reduce((s, it) => s + it.plannedMs, 0) / 60000);
  const actualTotalMin = Math.round(
    p.items.reduce((s, it) => s + (it.actualStartedAt ? (it.actualEndedAt || now) - it.actualStartedAt : 0), 0) /
      60000
  );

  return [
    `${p.name || 'Service'} — ${dateStr}`,
    `Started ${startedStr} · Ended ${endedStr}${driftHeadline ? ' · ' + driftHeadline : ''}`,
    '',
    ...lines,
    '',
    `Planned ${formatHoursMin(plannedTotalMin)} · Actual ${formatHoursMin(actualTotalMin)}`
  ].join('\n');
}

// --- DOM: rail + preview -------------------------------------------------------

const railProgramName = document.getElementById('programName');
const titlebarProgramName = document.getElementById('titlebarProgramName');
const programListEl = document.getElementById('programList');
const prevItemBtn = document.getElementById('prevItemBtn');
const nextItemBtn = document.getElementById('nextItemBtn');
const pasteProgramBtn = document.getElementById('pasteProgramBtn');
const saveProgramBtn = document.getElementById('saveProgramBtn');
const savedProgramsSelect = document.getElementById('savedProgramsSelect');
const exportProgramBtn = document.getElementById('exportProgramBtn');
const importProgramBtn = document.getElementById('importProgramBtn');
const importProgramInput = document.getElementById('importProgramInput');
const copyReportBtn = document.getElementById('copyReportBtn');
const recoverRow = document.getElementById('recoverRow');
const recoverBtn = document.getElementById('recoverBtn');
const showNextUpCheckbox = document.getElementById('showNextUpCheckbox');
const previewDrift = document.getElementById('previewDrift');

function updateRecoverButton() {
  const mins = recoverableMinutes();
  if (mins <= 0) {
    recoverRow.style.display = 'none';
    recoverPreviewActive = false;
    return;
  }
  recoverRow.style.display = 'flex';
  recoverBtn.textContent = recoverPreviewActive ? `Confirm recover ${mins} min` : `Recover ${mins} min`;
}

function renderProgramPanel() {
  const p = state.program;
  const baseName = p.name || (p.items.length ? 'Untitled program' : 'No program loaded');
  railProgramName.textContent = programDirty && p.items.length ? `${baseName} • unsaved` : baseName;
  titlebarProgramName.textContent = p.name || '';

  const preview = recoverPreviewActive ? computeRecoverPreview() : null;

  programListEl.innerHTML = '';
  p.items.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'program-row';
    if (i === p.activeIndex) row.classList.add('active');

    const marker = document.createElement('span');
    marker.className = 'program-row-marker';
    marker.textContent = it.skipped ? '⏭' : i === p.activeIndex ? '▶' : it.actualEndedAt ? '✓' : '';

    const name = document.createElement('span');
    name.className = 'program-row-name';
    name.textContent = it.name;

    const nums = document.createElement('span');
    nums.className = 'program-row-nums';
    const plannedMin = Math.round(it.plannedMs / 60000);
    if (it.actualStartedAt && it.actualEndedAt) {
      const actualMin = Math.round((it.actualEndedAt - it.actualStartedAt) / 60000);
      nums.textContent = `${plannedMin}│${actualMin}`;
      nums.classList.add(actualMin > plannedMin ? 'over' : 'under');
    } else if (i === p.activeIndex) {
      const { ms } = readout(state);
      nums.textContent = `${plannedMin}│${Math.round((it.plannedMs - ms) / 60000)}`;
    } else if (preview && preview.perItem.has(it.id)) {
      nums.textContent = `${plannedMin} → ${Math.round(preview.perItem.get(it.id).newPlannedMs / 60000)}`;
      nums.classList.add('recover-preview');
    } else {
      nums.textContent = `${plannedMin}`;
    }

    const warning = anchorWarning(i);
    if (warning) {
      row.classList.add('anchor-late');
      row.title = warning;
    }

    row.append(marker, name, nums);
    row.addEventListener('click', () => jumpTo(i));
    programListEl.appendChild(row);
  });

  prevItemBtn.disabled = p.activeIndex <= 0;
  saveProgramBtn.disabled = !p.items.length;
  manageSaveAsBtn.disabled = !p.items.length;
  nextItemBtn.disabled = !p.items.length;
  copyReportBtn.disabled = !p.items.some((it) => it.actualStartedAt);

  updateRecoverButton();
}

function repaintProgram() {
  const proj = computeProjection();
  if (!proj) {
    previewDrift.textContent = '';
    previewDrift.className = 'preview-drift';
  } else {
    const label = formatDrift(proj);
    previewDrift.textContent = label === 'On time' ? '▸ On time' : `▸ ${label}`;
    previewDrift.className = `preview-drift drift-${driftTone(proj.drift)}`;
  }
  renderProgramPanel();
}

// --- DOM: paste dialog -------------------------------------------------------

const pasteDialog = document.getElementById('pasteDialog');
const pasteInput = document.getElementById('pasteInput');
const pastePreview = document.getElementById('pastePreview');
const pasteSummary = document.getElementById('pasteSummary');
const pasteCancelBtn = document.getElementById('pasteCancelBtn');
const pasteApplyBtn = document.getElementById('pasteApplyBtn');

let currentParseResult = null;

function buildItemRow(item) {
  const row = document.createElement('div');
  row.className = 'paste-row';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = item.name;
  nameInput.addEventListener('input', () => {
    item.name = nameInput.value;
    updatePasteSummary();
  });

  const durInput = document.createElement('input');
  durInput.type = 'text';
  durInput.value = formatTime(item.plannedMs);
  durInput.addEventListener('change', () => {
    const ms = parseDurationText(durInput.value);
    if (ms !== null) item.plannedMs = ms;
    durInput.value = formatTime(item.plannedMs);
    updatePasteSummary();
  });

  row.append(nameInput, durInput);
  return row;
}

function buildUnreadableRow(entry) {
  const row = document.createElement('div');
  row.className = 'paste-row paste-row-unreadable';

  const badge = document.createElement('span');
  badge.className = 'paste-badge';
  badge.textContent = 'Could not read';

  const rawInput = document.createElement('input');
  rawInput.type = 'text';
  rawInput.value = entry.raw;
  rawInput.addEventListener('change', () => {
    const reparsed = parseLine(rawInput.value);
    if (reparsed && !reparsed.unreadable) {
      const item = makeItem(reparsed.name, reparsed.durationMs);
      currentParseResult.items.push(item);
      currentParseResult.unreadable = currentParseResult.unreadable.filter((x) => x !== entry);
      row.replaceWith(buildItemRow(item));
      updatePasteSummary();
    } else {
      entry.raw = rawInput.value;
    }
  });

  row.append(badge, rawInput);
  return row;
}

function renderPastePreview() {
  const text = pasteInput.value;
  currentParseResult = text.trim()
    ? parseProgram(text)
    : { items: [], unreadable: [], totalMs: 0, serviceEndAnchor: null, shape: 'durations' };

  pastePreview.innerHTML = '';
  currentParseResult.items.forEach((item) => pastePreview.appendChild(buildItemRow(item)));
  currentParseResult.unreadable.forEach((entry) => pastePreview.appendChild(buildUnreadableRow(entry)));

  if (currentParseResult.serviceEndAnchor) {
    const row = document.createElement('div');
    row.className = 'paste-row paste-row-anchor';
    row.textContent =
      `${currentParseResult.serviceEndAnchor.name} at ${currentParseResult.serviceEndAnchor.anchorAt}` +
      ' — treated as the service end time, not a segment';
    pastePreview.appendChild(row);
  }

  updatePasteSummary();
}

function updatePasteSummary() {
  if (!currentParseResult || !currentParseResult.items.length) {
    pasteSummary.textContent = '';
    pasteApplyBtn.disabled = true;
    return;
  }
  const totalMs = currentParseResult.items.reduce((s, it) => s + it.plannedMs, 0);
  const endsStr = clockNow(new Date(Date.now() + totalMs));
  pasteSummary.textContent =
    `${currentParseResult.items.length} segments · ${formatHoursMin(Math.round(totalMs / 60000))} total` +
    ` · ends ${endsStr} if started now.`;
  pasteApplyBtn.disabled = false;
}

// --- DOM: edit dialog -------------------------------------------------------

const editProgramBtn = document.getElementById('editProgramBtn');
const editDialog = document.getElementById('editDialog');
const editList = document.getElementById('editList');
const editAddBtn = document.getElementById('editAddBtn');
const editSummary = document.getElementById('editSummary');
const editCancelBtn = document.getElementById('editCancelBtn');
const editApplyBtn = document.getElementById('editApplyBtn');

// Nothing touches state.program until Apply — the dialog edits this copy.
let editDraft = [];

function iconButton(label, title, enabled, onClick) {
  const btn = document.createElement('button');
  btn.className = 'icon-btn';
  btn.textContent = label;
  btn.title = title;
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
  const locked = lockedCount();
  editList.innerHTML = '';
  editDraft.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'paste-row edit-row';
    if (i < locked) row.classList.add('edit-row-locked');

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = item.name;
    nameInput.maxLength = 80;
    nameInput.addEventListener('input', () => {
      item.name = nameInput.value;
    });

    const durInput = document.createElement('input');
    durInput.type = 'text';
    durInput.value = formatTime(item.plannedMs);
    durInput.addEventListener('change', () => {
      const ms = parseDurationText(durInput.value);
      if (ms !== null && ms > 0) item.plannedMs = ms;
      durInput.value = formatTime(item.plannedMs);
      updateEditSummary();
    });

    const movable = i >= locked;
    row.append(
      nameInput,
      durInput,
      iconButton('↑', 'Move up', movable && i - 1 >= locked, () => moveDraftItem(i, i - 1)),
      iconButton('↓', 'Move down', movable && i + 1 < editDraft.length, () => moveDraftItem(i, i + 1)),
      iconButton('×', movable ? 'Remove' : 'Already started — can’t remove', movable, () => {
        editDraft.splice(i, 1);
        renderEditList();
      })
    );
    editList.appendChild(row);
  });
  updateEditSummary();
}

function updateEditSummary() {
  const totalMs = editDraft.reduce((s, it) => s + it.plannedMs, 0);
  editSummary.textContent = editDraft.length
    ? `${editDraft.length} segments · ${formatHoursMin(Math.round(totalMs / 60000))} total`
    : 'No segments';
}

editProgramBtn.addEventListener('click', () => {
  editDraft = state.program.items.map((it) => ({ id: it.id, name: it.name, plannedMs: it.plannedMs }));
  renderEditList();
  editDialog.showModal();
});

editAddBtn.addEventListener('click', () => {
  editDraft.push({ id: null, name: 'New segment', plannedMs: 5 * 60000 });
  renderEditList();
  const inputs = editList.querySelectorAll('.edit-row:last-child input');
  if (inputs[0]) {
    inputs[0].focus();
    inputs[0].select();
  }
});

editCancelBtn.addEventListener('click', () => editDialog.close());

editApplyBtn.addEventListener('click', () => {
  applyProgramEdits(editDraft);
  editDialog.close();
});

// --- DOM: name dialog -------------------------------------------------------
// Electron doesn't implement window.prompt(), so naming goes through this.

const nameDialog = document.getElementById('nameDialog');
const nameDialogTitle = document.getElementById('nameDialogTitle');
const nameDialogInput = document.getElementById('nameDialogInput');
const nameDialogError = document.getElementById('nameDialogError');
const nameDialogOkBtn = document.getElementById('nameDialogOkBtn');
const nameDialogCancelBtn = document.getElementById('nameDialogCancelBtn');

let nameDialogPending = null;

// Resolves with the trimmed name, or null if cancelled. `validate` returns an
// error string to keep the dialog open, or '' to accept.
function askName(title, initial, validate) {
  nameDialogTitle.textContent = title;
  nameDialogInput.value = initial || '';
  nameDialogError.textContent = '';
  return new Promise((resolve) => {
    nameDialogPending = { resolve, validate };
    nameDialog.showModal();
    nameDialogInput.select();
  });
}

function settleNameDialog(value) {
  const pending = nameDialogPending;
  nameDialogPending = null;
  if (nameDialog.open) nameDialog.close();
  if (pending) pending.resolve(value);
}

function submitNameDialog() {
  const name = nameDialogInput.value.trim();
  if (!name || !nameDialogPending) return;
  const error = nameDialogPending.validate ? nameDialogPending.validate(name) : '';
  if (error) {
    nameDialogError.textContent = error;
    return;
  }
  settleNameDialog(name);
}

nameDialogOkBtn.addEventListener('click', submitNameDialog);
nameDialogCancelBtn.addEventListener('click', () => settleNameDialog(null));
nameDialogInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitNameDialog();
});
// Escape closes a <dialog> natively — treat it as Cancel.
nameDialog.addEventListener('close', () => settleNameDialog(null));

// Saving under a name that's already taken replaces it, but only after the
// operator has been told once.
function askSaveName(initial) {
  let warnedFor = null;
  return askName('Save program as', initial, (name) => {
    if (loadSavedPrograms()[name] && name !== state.program.name && warnedFor !== name) {
      warnedFor = name;
      return `"${name}" already exists — press OK again to replace it.`;
    }
    return '';
  });
}

async function saveCurrentAsNew() {
  if (!state.program.items.length) return false;
  const name = await askSaveName(state.program.name ? `${state.program.name} copy` : '');
  if (!name) return false;
  saveProgramAs(name);
  return true;
}

// --- DOM: manage dialog -------------------------------------------------------

const manageProgramsBtn = document.getElementById('manageProgramsBtn');
const manageDialog = document.getElementById('manageDialog');
const manageList = document.getElementById('manageList');
const manageSaveAsBtn = document.getElementById('manageSaveAsBtn');
const manageCloseBtn = document.getElementById('manageCloseBtn');

function renderManageList() {
  const all = loadSavedPrograms();
  const names = Object.keys(all).sort();
  manageList.innerHTML = '';
  if (!names.length) {
    manageList.textContent = 'No saved programs yet.';
    return;
  }
  names.forEach((name) => {
    const row = document.createElement('div');
    row.className = 'manage-row';

    const label = document.createElement('span');
    label.className = 'manage-row-name';
    const count = (all[name].items || []).length;
    label.textContent = `${name} · ${count} segments${name === state.program.name ? ' (loaded)' : ''}`;

    const loadBtn = document.createElement('button');
    loadBtn.textContent = 'Load';
    loadBtn.addEventListener('click', () => {
      loadProgramByName(name);
      manageDialog.close();
    });

    const renameBtn = document.createElement('button');
    renameBtn.textContent = 'Rename';
    renameBtn.addEventListener('click', async () => {
      const newName = await askName('Rename program', name, (candidate) =>
        candidate !== name && loadSavedPrograms()[candidate] ? `"${candidate}" already exists.` : ''
      );
      if (newName && newName !== name) renameSavedProgram(name, newName);
      renderManageList();
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => {
      if (!deleteBtn.classList.contains('on')) {
        deleteBtn.textContent = 'Confirm delete';
        deleteBtn.classList.add('on');
        return;
      }
      deleteSavedProgram(name);
      renderManageList();
    });

    row.append(label, loadBtn, renameBtn, deleteBtn);
    manageList.appendChild(row);
  });
}

manageProgramsBtn.addEventListener('click', () => {
  renderManageList();
  manageDialog.showModal();
});

manageSaveAsBtn.addEventListener('click', async () => {
  if (await saveCurrentAsNew()) renderManageList();
});

manageCloseBtn.addEventListener('click', () => manageDialog.close());

// --- wiring -------------------------------------------------------

function populateSavedProgramsSelect() {
  const all = loadSavedPrograms();
  savedProgramsSelect.innerHTML = '<option value="">Saved programs…</option>';
  Object.keys(all)
    .sort()
    .forEach((name) => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      savedProgramsSelect.appendChild(opt);
    });
}

pasteInput.addEventListener('input', renderPastePreview);

pasteProgramBtn.addEventListener('click', () => {
  pasteInput.value = '';
  renderPastePreview();
  pasteDialog.showModal();
});

pasteCancelBtn.addEventListener('click', () => pasteDialog.close());

pasteApplyBtn.addEventListener('click', () => {
  if (!currentParseResult || !currentParseResult.items.length) return;
  setItemsFromParsed(currentParseResult.items);
  pasteDialog.close();
});

savedProgramsSelect.addEventListener('change', () => {
  if (savedProgramsSelect.value) loadProgramByName(savedProgramsSelect.value);
  savedProgramsSelect.value = '';
});

function flashSaved() {
  saveProgramBtn.textContent = 'Saved ✓';
  setTimeout(() => {
    saveProgramBtn.textContent = 'Save';
  }, 1500);
}

// A program that already has a name is updated in place; only an unnamed one
// asks for a name.
saveProgramBtn.addEventListener('click', async () => {
  if (!state.program.items.length) return;
  if (state.program.name) {
    saveProgramAs(state.program.name);
    flashSaved();
    return;
  }
  const name = await askSaveName('');
  if (!name) return;
  saveProgramAs(name);
  flashSaved();
});

exportProgramBtn.addEventListener('click', exportPrograms);
importProgramBtn.addEventListener('click', () => importProgramInput.click());
importProgramInput.addEventListener('change', () => {
  const file = importProgramInput.files[0];
  if (file) importPrograms(file);
  importProgramInput.value = '';
});

copyReportBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(buildReport());
});

showNextUpCheckbox.addEventListener('change', () => {
  state.showNextUp = showNextUpCheckbox.checked;
  push();
});

recoverBtn.addEventListener('click', () => {
  if (recoverPreviewActive) {
    applyRecoverTime();
    recoverPreviewActive = false;
  } else {
    recoverPreviewActive = true;
  }
  renderProgramPanel();
});

prevItemBtn.addEventListener('click', () => previousItem());
// Next also functions as a de facto Start for an operator who loads a
// program and jumps straight to stepping through it — gate it the same way.
nextItemBtn.addEventListener('click', () => withDisplayReady(() => advance(1)));

function initProgram() {
  showNextUpCheckbox.checked = state.showNextUp;
  populateSavedProgramsSelect();

  const lastName = localStorage.getItem(LAST_PROGRAM_KEY);
  if (lastName && loadSavedPrograms()[lastName]) {
    loadProgramByName(lastName);
  }

  renderProgramPanel();
}
