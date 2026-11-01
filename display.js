// Pure renderer: stores whatever snapshot arrives and ticks locally from it.
// Never mutates state, never sends anything back (rule 3.2 / 3.3).

let state = DEFAULT_STATE;

const clockEl = document.getElementById('clock');
const labelEl = document.getElementById('label');
const messageEl = document.getElementById('message');
const messageTextEl = document.getElementById('messageText');
const progressFillEl = document.getElementById('progressFill');
const blackoutEl = document.getElementById('blackout');
const nextUpEl = document.getElementById('nextUp');

window.api.onState((next) => {
  state = next;
});

// Largest size that fits the screen, so "Time is up" fills it and a long
// message still fits. Layout is expensive, so only run this when the text or
// the screen changes.
function fitMessage() {
  if (!messageEl.classList.contains('on')) return;
  const maxHeight = window.innerHeight * 0.86;
  let low = 16;
  let high = window.innerHeight * 0.7;
  while (high - low > 1) {
    const size = (low + high) / 2;
    messageTextEl.style.fontSize = `${size}px`;
    const fits = messageTextEl.offsetHeight <= maxHeight && messageTextEl.scrollWidth <= messageTextEl.clientWidth;
    if (fits) low = size;
    else high = size;
  }
  messageTextEl.style.fontSize = `${low}px`;
}

window.addEventListener('resize', fitMessage);

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

  // Checks the time itself as well, so the speaker's screen clears on time
  // even if the control window's update is late.
  const message = state.message && now < state.messageUntil ? state.message : '';
  messageEl.classList.toggle('on', !!message);
  messageTextEl.classList.toggle('flash', !!message && !!state.flash);
  if (messageTextEl.textContent !== message) {
    messageTextEl.textContent = message;
    fitMessage();
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
