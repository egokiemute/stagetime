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
  // Nothing configured yet — show a live current-time clock instead of a
  // frozen countdown placeholder, so the screen is still meaningful if it's
  // sent up before the operator has set anything.
  const idleUntouched = state.status === 'idle' && !state.timerTouched;

  const { ms } = readout(state, now);
  const currentTone = idleUntouched ? 'normal' : tone(state, ms);

  const isTimeUp = !idleUntouched && currentTone === 'over';
  clockEl.classList.toggle('time-up', isTimeUp);
  clockEl.textContent = !state.showClock
    ? ''
    : idleUntouched
      ? currentHHMMSS(new Date(now))
      : isTimeUp
        ? 'Time Up'
        : formatTime(ms);
  labelEl.textContent = state.label || '';

  if (state.message) {
    messageEl.textContent = state.message;
    messageEl.classList.toggle('flash', !!state.flash);
  } else {
    messageEl.textContent = '';
    messageEl.classList.remove('flash');
  }

  progressFillEl.style.width = `${idleUntouched ? 0 : progress(state, ms) * 100}%`;

  const showNext = state.showNextUp && state.nextLabel && !state.message && currentTone !== 'over';
  nextUpEl.textContent = showNext ? `Next up: ${state.nextLabel}` : '';

  document.body.classList.remove('tone-normal', 'tone-warn', 'tone-danger', 'tone-critical', 'tone-over');
  document.body.classList.add(`tone-${currentTone}`);

  blackoutEl.classList.toggle('on', !!state.blackout);
}

setInterval(repaint, 100);
repaint();
