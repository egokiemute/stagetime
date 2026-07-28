// Pure renderer: stores whatever snapshot arrives and ticks locally from it.
// Never mutates state, never sends anything back (rule 3.2 / 3.3).

let state = DEFAULT_STATE;

const clockEl = document.getElementById('clock');
const labelEl = document.getElementById('label');
const messageEl = document.getElementById('message');
const progressFillEl = document.getElementById('progressFill');
const blackoutEl = document.getElementById('blackout');
const nextUpEl = document.getElementById('nextUp');

window.api.onState((next) => {
  state = next;
});

function repaint() {
  const now = Date.now();
  const { ms } = readout(state, now);
  const currentTone = tone(state, ms);

  const isTimeUp = currentTone === 'over';
  clockEl.classList.toggle('time-up', isTimeUp);
  clockEl.textContent = isTimeUp ? 'Time Up' : state.showClock ? formatTime(ms) : '';
  labelEl.textContent = state.label || '';

  if (state.message) {
    messageEl.textContent = state.message;
    messageEl.classList.toggle('flash', !!state.flash);
  } else {
    messageEl.textContent = '';
    messageEl.classList.remove('flash');
  }

  progressFillEl.style.width = `${progress(state, ms) * 100}%`;

  const showNext = state.showNextUp && state.nextLabel && !state.message && currentTone !== 'over';
  nextUpEl.textContent = showNext ? `Next up: ${state.nextLabel}` : '';

  document.body.classList.remove('tone-normal', 'tone-warn', 'tone-danger', 'tone-critical', 'tone-over');
  document.body.classList.add(`tone-${currentTone}`);

  blackoutEl.classList.toggle('on', !!state.blackout);
}

setInterval(repaint, 100);
repaint();
