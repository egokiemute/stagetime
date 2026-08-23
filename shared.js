// Loaded via a plain <script> tag in BOTH windows. Declarations here are
// module-scope globals shared across every classic <script> in the document,
// so this is the single source of truth for state shape and time maths.

const DEFAULT_STATE = {
  mode: 'duration',        // 'duration' | 'clock' | 'countup'
  status: 'idle',          // 'idle' | 'running' | 'paused'
  durationMs: 300000,      // configured length
  clockTarget: '09:00',    // HH:MM[:SS] 24h, for 'clock' mode — inert fallback, see control.js
  clockTargetTouched: false, // true once the operator has manually set clockTarget
  timerTouched: false,      // true once any duration/mode/program has been configured —
                             // while false and idle, both windows show a live current-time clock
  endsAt: null,            // epoch ms — the source of truth while running
  startedAt: null,         // epoch ms — count-up mode
  frozenMs: 300000,        // held value while idle or paused
  totalMs: 300000,         // denominator for the progress bar
  label: '',               // 'Worship', 'Sermon' — shown above the clock
  message: '',              // 'Please wrap up'
  flash: false,
  blackout: false,
  showClock: true,
  warnSec: 120,            // amber threshold
  dangerSec: 30,           // red threshold
  program: {
    name: '',
    items: [],
    activeIndex: -1,        // -1 = program loaded but not started
    autoStartOnAdvance: true,
    startedAt: null         // epoch ms the whole service began
  },
  nextLabel: '',             // name of the upcoming segment — sent to the stage window
  showNextUp: true           // whether the stage window shows the "Next up" line
};

function readout(state, now = Date.now()) {
  if (state.mode === 'countup') {
    const ms = state.status === 'running' ? now - state.startedAt : state.frozenMs;
    return { ms, over: false };
  }
  const ms = state.status === 'running' ? state.endsAt - now : state.frozenMs;
  return { ms, over: ms < 0 };
}

function tone(state, ms) {
  if (state.mode === 'countup') return 'normal';
  if (ms <= 0) return 'over';
  const total = state.totalMs || 0;
  if (ms <= total * 0.10) return 'critical'; // last 10% — true red
  if (ms <= total * 0.20) return 'danger';   // last 20% — coral
  const sec = ms / 1000;
  if (sec <= state.warnSec) return 'warn';
  return 'normal';
}

// Round up while counting down (4.6s reads "5"), round down once past zero,
// so the display never double-jumps at the zero crossing.
function formatTime(ms) {
  const over = ms < 0;
  const absMs = Math.abs(ms);
  const totalSec = over ? Math.floor(absMs / 1000) : Math.ceil(absMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  const body = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  return over ? `−${body}` : body;
}

function clockNow(date = new Date()) {
  let h = date.getHours();
  const m = date.getMinutes();
  const suffix = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')} ${suffix}`;
}

// Next epoch ms for a "HH:MM" or "HH:MM:SS" 24h wall-clock target. If the
// target already slipped by more than ~6 hours, roll to tomorrow; otherwise
// keep it today so the operator sees overrun rather than a target that
// jumped a day ahead.
function nextClockTarget(hhmmss, now = new Date()) {
  const [hh, mm, ss = 0] = hhmmss.split(':').map(Number);
  const target = new Date(now);
  target.setHours(hh, mm, ss, 0);
  const diff = now.getTime() - target.getTime();
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  if (diff > SIX_HOURS) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime();
}

// "HH:MM:SS" for the current moment — used to default the "Start at" field
// to a live-looking current time rather than a frozen placeholder whenever
// the operator hasn't set a target themselves yet.
function currentHHMMSS(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function progress(state, ms) {
  if (state.mode === 'countup') return 0;
  const total = state.totalMs || 1;
  const elapsed = total - ms;
  return Math.min(1, Math.max(0, elapsed / total));
}
