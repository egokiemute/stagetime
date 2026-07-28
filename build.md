# Stage Timer — Build Specification
 
Build a macOS desktop app that displays a countdown timer on a projector or
second screen during a church service, controlled from a separate window on the
operator's Mac.
 
This document is the complete instruction set. Follow it top to bottom.
 
---
 
## 1. What is being built
 
Two windows, one app:
 
| Window | Lives on | Purpose |
| --- | --- | --- |
| Control | Operator's Mac | Sets the timer, runs transport, sends messages |
| Stage | Projector / second screen | Giant countdown the congregation and platform see |
 
The operator never shows the control window to the room. The stage window never
shows chrome, a cursor, or a menu bar.
 
### Success criteria
 
The build is done when all of these are true:
 
- [ ] Launching the app opens both windows; the stage window is on the external screen automatically
- [ ] A 45-minute countdown is still accurate to within one second at the end
- [ ] Control and stage never show different numbers
- [ ] The Mac does not sleep or dim while the app is open
- [ ] The stage window stays visible above other apps, including full-screen ones
- [ ] Overrun is visible from the back of a hall without squinting
- [ ] Unplugging and replugging the projector does not crash the app
- [ ] Space, R, and the arrow keys drive the timer without touching the mouse
---
 
## 2. Stack
 
- **Electron** — needed for real multi-monitor placement, always-on-top, and
  sleep prevention. A browser tab cannot do any of these reliably.
- **Vanilla HTML / CSS / JS** — no bundler, no framework, no build step.
  The app is one timer and a message bar. React plus Vite would add a toolchain
  for no gain here, and `npm start` running instantly matters when you are
  debugging fifteen minutes before service.
- **No runtime dependencies.** Nothing to install on a church machine, nothing
  to break when the WiFi is down.
If the app later grows a remote phone controller, add `express` and `ws` at that
point. Not before.
 
---
 
## 3. Non-negotiable design rules
 
These three rules cause most of the bugs in homemade timers. Follow them exactly.
 
### 3.1 Never decrement a counter on an interval
 
Do not write `remaining -= 1000` inside `setInterval`. Timer callbacks are late,
and the lateness accumulates. Over 45 minutes this drifts by several seconds,
and the two windows drift away from each other independently.
 
Instead: store an **absolute target timestamp** (`endsAt`), and derive the
remaining time on every tick:
 
```js
const remaining = endsAt - Date.now();
```
 
The interval now only controls how often you repaint. It cannot affect accuracy.
 
### 3.2 One owner of state
 
The control window owns the state object. It sends a **whole snapshot** to the
main process, which forwards it to the stage window. Snapshots are sent only
when something changes — not every tick.
 
The stage window is a pure renderer. It never mutates state and never sends
anything back.
 
### 3.3 Both windows tick locally
 
Because both windows hold the same `endsAt` timestamp, each runs its own repaint
interval and computes its own number. They cannot disagree, and there is no
per-second IPC traffic.
 
---
 
## 4. File layout
 
```
stagetimer/
├── package.json
├── main.js          Electron main process
├── preload.js       contextBridge — the only window↔Electron surface
├── shared.js        State shape + time maths. Loaded by BOTH windows.
├── control.html
├── control.css
├── control.js
├── display.html
├── display.css
└── display.js
```
 
`shared.js` is loaded with a plain `<script>` tag in both windows, so its
functions are global in each renderer. This is deliberate — it keeps one copy of
the time maths without introducing a module bundler.
 
---
 
## 5. State model
 
Define this in `shared.js`:
 
```js
const DEFAULT_STATE = {
  mode: 'duration',        // 'duration' | 'clock' | 'countup'
  status: 'idle',          // 'idle' | 'running' | 'paused'
  durationMs: 300000,      // configured length
  clockTarget: '09:00',    // HH:MM 24h, for 'clock' mode
  endsAt: null,            // epoch ms — the source of truth while running
  startedAt: null,         // epoch ms — count-up mode
  frozenMs: 300000,        // held value while idle or paused
  totalMs: 300000,         // denominator for the progress bar
  label: '',               // 'Worship', 'Sermon' — shown above the clock
  message: '',             // 'Please wrap up'
  flash: false,
  blackout: false,
  showClock: true,
  warnSec: 120,            // amber threshold
  dangerSec: 30            // red threshold
};
```
 
### Derived values — also in `shared.js`
 
| Function | Returns |
| --- | --- |
| `readout(state, now)` | `{ ms, over }` — remaining (or elapsed, in count-up) |
| `tone(state, ms)` | `'normal'` \| `'warn'` \| `'danger'` \| `'over'` |
| `formatTime(ms)` | `5:00`, `1:02:30`, `−0:47` |
| `clockNow(date)` | `9:04 AM` |
| `nextClockTarget(hhmm)` | epoch ms of the next `HH:MM` |
| `progress(state, ms)` | `0`–`1` for the bar |
 
`readout` is the whole trick:
 
```js
function readout(state, now = Date.now()) {
  if (state.mode === 'countup') {
    const ms = state.status === 'running' ? now - state.startedAt : state.frozenMs;
    return { ms, over: false };
  }
  const ms = state.status === 'running' ? state.endsAt - now : state.frozenMs;
  return { ms, over: ms < 0 };
}
```
 
### Two details that are easy to get wrong
 
**Rounding.** Round *up* when counting down (4.6s should read `5`, not `4`), but
round *down* when counting overrun upward. Otherwise the display jumps a second
at the zero crossing.
 
**Clock targets in the past.** If `09:00` has already gone by, do not jump 24
hours ahead — the operator wants overrun. Only roll to tomorrow if the target
slipped by more than about six hours.
 
---
 
## 6. Build it in this order
 
Each phase should run and be testable before you start the next one.
 
### Phase 1 — Shell
 
1. `npm init`, install `electron` and `electron-builder` as dev dependencies.
2. `main.js`: create the control window (940×720, `titleBarStyle: 'hiddenInset'`,
   dark `backgroundColor`).
3. `preload.js` with `contextIsolation: true` and `nodeIntegration: false`.
   Expose exactly: `send`, `onState`, `onScreensChanged`, `nextScreen`,
   `toggleDisplay`, `screenCount`. Nothing else.
**Test:** `npm start` opens one dark window.
 
### Phase 2 — Timer core
 
1. Write `shared.js` in full.
2. Build the control window's transport: Start, Pause, Resume, Reset.
3. Repaint a local preview every 200ms.
Transport logic:
 
```js
function start() {
  const now = Date.now();
  const ms = state.status === 'paused' ? state.frozenMs : armedDuration();
  if (state.status !== 'paused') state.totalMs = Math.max(1, ms);
  state.endsAt = now + ms;
  state.status = 'running';
  push();
}
 
function pause() {
  state.frozenMs = readout(state).ms;   // freeze the derived value
  state.status = 'paused';
  push();
}
```
 
Pausing works by converting the timestamp back into a duration. Resuming
converts it forward again. There is no third representation to keep in sync.
 
**Test:** the preview counts down accurately, pauses, resumes, and goes negative.
 
### Phase 3 — Stage window
 
1. In `main.js`, read `screen.getAllDisplays()`. Put the stage window on index 1
   if it exists, otherwise index 0.
2. If there are two or more screens: `frame: false` and
   `setAlwaysOnTop(true, 'screen-saver')`.
   If there is only one: keep the frame so the operator can drag it.
3. `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`.
4. Relay state: `ipcMain.on('state', ...)` → `displayWin.webContents.send('state', ...)`.
5. `display.js` stores the snapshot and repaints every 100ms from `readout`.
Use `setBounds(display.bounds)` rather than native macOS fullscreen. Native
fullscreen creates its own Space and behaves badly on a secondary monitor.
 
**Test:** both windows show the same number. Disagreement here means you broke
rule 3.3.
 
### Phase 4 — Stage typography
 
This is the part that determines whether the app is usable, so give it real
attention.
 
- Background `#000000`, digits `#FFFFFF`.
- `font-size: min(26vw, 60vh)` — fills the screen at any projector aspect ratio.
- `font-variant-numeric: tabular-nums` — **required**, or the digits shift width
  every second and the whole clock jitters.
- `cursor: none` on the body.
- Weight 600. Thin display faces disappear at distance in a dark room.
- Colour thresholds: white → amber `#FFC24B` at 2 min → coral `#FF6B4A` at 30s.
- **Overrun inverts the field**: deep red background `#7A0F12`, white digits,
  slow 2.4s breathe between `#7A0F12` and `#A5161A`. Breathe, do not strobe —
  a strobing wall behind the platform wrecks the room and is a genuine risk for
  photosensitive people in the congregation.
- Honour `prefers-reduced-motion` by dropping the breathe and the flash.
**Test:** stand at the far end of a room and read it.
 
### Phase 5 — Modes
 
- **Length** — plain countdown from `durationMs`. Presets: 1, 3, 5, 10, 15, 20,
  30, 45 minutes, plus a text field parsing `5`, `5:30`, `90`, `1:02:30`.
- **Start at** — countdown to a wall-clock time via `nextClockTarget`. This is
  the important one for pre-service countdowns: it stays honest even if the
  operator opens the app late.
- **Count up** — elapsed from `startedAt`.
**Test:** set "start at" to two minutes from now; confirm it lands on zero at
exactly that wall-clock time.
 
### Phase 6 — Messages to the platform
 
- Six one-tap presets: `5 minutes left`, `Please wrap up`, `Time is up`,
  `Go to altar call`, `Take a seat`, `Hold for offering`.
- A custom field that sends on Enter.
- Tapping an active preset again clears it, so it toggles.
- A **Flash it** checkbox: 1s `steps(1, end)` opacity pulse on the message only,
  never on the digits.
- A **screen label** field (`Worship`, `Sermon`) shown small and uppercase above
  the clock.
### Phase 7 — Service-day hardening
 
Everything here exists because of something that goes wrong in a real service.
 
| Feature | Why |
| --- | --- |
| `powerSaveBlocker.start('prevent-display-sleep')` | The Mac dimming mid-sermon |
| Stop the blocker on `will-quit` | Leaving the machine unable to sleep afterwards |
| **Move to next screen** button | The stage window opened on the wrong monitor |
| `screen.on('display-removed')` → fall back to index 0 | Projector cable pulled |
| **Blackout** button | Instantly kill the screen without losing the running timer |
| ±1 min and ±15s nudges | The preacher needs more time and it is now, not later |
| Persist settings to `localStorage` | Not re-entering the same 5:00 every Sunday |
| Show the end wall-clock time in the control window | The operator wants "ends 9:47" |
 
Keyboard, on the control window only, ignored while typing in an input:
 
| Key | Action |
| --- | --- |
| Space | Start / pause |
| R | Reset |
| B | Blackout |
| ↑ / ↓ | ±1 minute |
| ← / → | ±15 seconds |
| Esc | Clear message |
 
### Phase 8 — Package
 
```json
"build": {
  "appId": "plus.tbh.stagetimer",
  "mac": { "target": ["dmg", "zip"], "identity": null }
}
```
 
- `npm run dist` → unpacked `.app`
- `npm run dmg` → installable disk image
Unsigned builds need right-click → Open on first launch, or
`xattr -cr "Stage Timer.app"`. Sign with an Apple Developer ID before handing it
to other campuses.
 
---
 
## 7. Control window design brief
 
It is a console, not a landing page. Dark charcoal `#0E0E11`, panels `#17171C`,
hairline separators, small uppercase eyebrow labels over each group.
 
One signal colour — jade `#2FB682` — and it may only ever mean *running*: the
Start button, the live dot in the title bar, focus rings. Nothing decorative uses
it, so the operator can read the app's state from across the booth in peripheral
vision.
 
Layout, two columns:
 
```
┌──────────────────────────────────────────┐
│  ● Stage Timer                           │
├──────────────────────────────────────────┤
│              5:00                        │  large preview
│         Running · ends 9:47              │
├────────────────────┬─────────────────────┤
│ TIMER              │ MESSAGE             │
│ [Length][At][Up]   │ [presets ×6]        │
│ [1][3][5][10]...   │ [custom field]      │
│ [05:00]            │ [Clear] [Flash it]  │
├────────────────────┼─────────────────────┤
│ TRANSPORT          │ SCREEN LABEL        │
│ [ Start ][Reset]   │ [Worship…]          │
│ [−1m][−15s][+15s]  ├─────────────────────┤
│                    │ STAGE SCREEN        │
│                    │ [Blackout][Move]... │
└────────────────────┴─────────────────────┘
```
 
Copy rules: sentence case, plain verbs, name things by what the operator sees.
"Move to next screen", not "Cycle display index". The button that says
*Blackout* turns into *Blackout on* — same word through the whole state change.
 
---
 
## 8. Deliberately out of scope
 
Do not build these unless asked:
 
- Sound cues — the church already has an audio desk
- Multiple simultaneous timers
- Cloud sync or accounts
- A schedule or run-of-service editor
- Windows and Linux builds
## 9. Known upgrade paths
 
- **Phone controller.** Run `express` + `ws` inside the Electron main process,
  serve a stripped control page on the LAN, and broadcast the same state
  snapshots over the socket. `shared.js` is reused untouched. Roughly 60 lines.
  Build this when the booth is far from the projector machine.
- **OBS / ProPresenter.** Point a browser source at a local HTTP route serving
  `display.html`. Same renderer, different host.
 