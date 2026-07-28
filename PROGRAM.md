# Stage Timer — Run of Service

Build plan for the program feature: paste the service order management sends,
and step through it one segment at a time.

Companion to `BUILD.md`. Everything there still applies — this adds a layer on
top of the existing timer, and does not change how the timer itself works.

---

## 1. The workflow this serves

Management sends the media team something like this, usually on WhatsApp:

```
Opening prayer:      20mins
Praise:      15mins
Worship:    30mins
Testimonies:    20mins
Sermon:  60mins
Offering: 30mins
Closing prayer:  10mins
```

The operator should be able to paste that text, get a working program, press
Start once, and then drive the whole service with a single key between segments.

Three things this must also do, because they are the real reason a program
feature earns its place:

1. **Show where the service actually is against the plan.** Not just "5:00 left"
   but "we are 12 minutes over, we will finish at 12:22."
2. **Never hide overrun.** When a segment hits zero it holds in overrun. It does
   not quietly advance and reset the clock — that is exactly the information the
   pastor and the platform need.
3. **Send something back.** At the end, produce planned-versus-actual so the team
   can reply to management with what really happened.

### Success criteria

- [ ] Pasting the block above produces seven correct segments in under five seconds
- [ ] The parser also handles `Praise - 15 min`, `3. Sermon — 1hr`, and `9:00am Opening prayer`
- [ ] One key advances to the next segment and starts it
- [ ] A segment that runs over holds in overrun until the operator advances
- [ ] The control window always shows current drift and projected finish time
- [ ] The stage screen shows the current segment name and what is coming next
- [ ] Closing and reopening the app restores the loaded program
- [ ] The post-service report is one click and pastes cleanly into WhatsApp

---

## 2. The design decision that matters

**Segments run sequentially, not on a fixed schedule.**

A segment starts when the operator advances to it, not at a planned wall-clock
time. This is the only model that survives contact with a real service, where
testimonies run long and the preacher is the preacher.

The planned durations are therefore a **budget, not a schedule**. The app's job
is not to force the service back onto a timetable — it is to make the cost of
every overrun immediately visible, so a human can decide what to cut.

That decision drives three features:

- **Drift** — running total of actual minus planned, shown at all times
- **Projected finish** — now, plus what remains, in wall-clock terms
- **Anchors** — an optional hard time on any segment (`Sermon must start by
  11:15`), which raises a warning when the projection slips past it

An always-on countdown to a fixed service end time is a separate thing and is
already covered by the existing **Start at** mode. Do not conflate them.

---

## 3. Data model

Add to the state in `shared.js`:

```js
program: {
  name: '',              // 'Sunday First Service'
  items: [],             // ordered, see below
  activeIndex: -1,       // -1 = program loaded but not started
  autoStartOnAdvance: true,
  startedAt: null        // epoch ms the whole service began
}
```

Each item:

```js
{
  id: 'itm_3',
  name: 'Sermon',
  plannedMs: 3600000,
  actualStartedAt: null,   // epoch ms, set on advance
  actualEndedAt: null,     // epoch ms, set when the next advance happens
  autoAdvance: false,      // true only for things like a pre-service countdown
  flexible: false,         // may be trimmed when recovering time
  anchorAt: null,          // 'HH:MM' — must not start later than this
  note: ''                 // optional, operator's own note, never shown on stage
}
```

### How it connects to the existing timer

The program does not replace the timer. Advancing to a segment simply configures
the timer that is already there:

```js
function loadItem(i) {
  const item = state.program.items[i];
  state.program.activeIndex = i;
  state.mode = 'duration';
  state.durationMs = item.plannedMs;
  state.label = item.name;          // the stage label field already exists
  state.nextLabel = nextItemName(i);
  reset();
}
```

`endsAt`, `frozenMs`, `readout()`, and everything in section 3 of `BUILD.md` are
untouched. The program is a layer that decides *what* the timer is counting; the
timer keeps deciding *how*.

### What the stage window receives

Nothing new except two strings: `label` and `nextLabel`. Do not send the item
array to the stage window. It stays a dumb renderer, as designed.

---

## 4. The parser

This is the feature. If pasting takes longer than typing, nobody will use it.

Put it in a new `program.js`, loaded by the control window only.

### Shape A — name and duration

```
Opening prayer:      20mins
Praise - 15 min
3. Worship — 30
Sermon ....... 1hr
Offering  30 mins
```

Algorithm per line:

1. Skip blanks and lines with no digits (headers like `SUNDAY SERVICE`).
2. Strip leading bullets and numbering: `^[\s\-\*•]*(\d+[\.\)])?\s*`
3. Find the duration at the **end** of the line, and take everything before it as
   the name. Anchoring at the end avoids tripping on numbers inside names like
   `2 Corinthians reading`.
4. Trim trailing separators from the name: `[\s:\-–—.]+$`

Duration grammar to accept:

| Input | Milliseconds |
| --- | --- |
| `20`, `20m`, `20 min`, `20mins`, `20 minutes` | 20 min |
| `1hr`, `1 hour`, `1h` | 60 min |
| `1hr 30`, `1h30m`, `1 hour 30 mins` | 90 min |
| `1:30` | 90 min |
| `90s`, `90 sec` | 90 sec |

Bare numbers mean minutes. That is what church programs mean, and guessing
seconds would be wrong every time.

### Shape B — a timetable with clock times

```
9:00am   Opening prayer
9:20     Praise
9:35     Worship
10:05    Testimonies
11:05    Closing
```

Detect this when most lines *start* with a clock time. Then:

- Duration of each item = next item's time minus this item's time
- Set `anchorAt` on each item to its stated time
- The last line, if it has no successor, becomes the service end anchor rather
  than a segment — flag it in the preview and let the operator decide

### Import UI

A paste box with a **live preview table** underneath: parsed name, parsed
duration, and the running total. Anything the parser could not read shows as a
row flagged `Could not read` with the raw line in an editable field, rather than
being silently dropped.

Under the preview: `7 segments · 3h 05m total · ends 12:05 if started now.`
Seeing the total is often the moment someone notices the program does not fit
in the slot.

---

## 5. Projection maths

Put these in `program.js`. Recompute on every control-window repaint.

```js
plannedTotal   = Σ items.plannedMs
plannedToHere  = Σ plannedMs of items 0..activeIndex
actualToHere   = Σ (actualEndedAt − actualStartedAt) for completed items
               + elapsed of the current item
drift          = actualToHere − plannedToHere        // positive = running late
remainingPlan  = Σ plannedMs of items after activeIndex
projectedEnd   = Date.now() + max(0, currentRemaining) + remainingPlan
```

Present drift in words, not just a number:

| Drift | Shown |
| --- | --- |
| within ±60s | `On time` |
| positive | `12 min over · finishing 12:22` |
| negative | `4 min ahead · finishing 11:56` |

Colour it with the same three-step scale as the timer, so drift reads at a
glance: neutral under 5 minutes, amber to 15, coral beyond.

### Anchor warnings

For each item with `anchorAt`, compute its projected start. If that is later than
the anchor, show the item row in amber with `starts 8 min late`. Warn, never
auto-correct. The operator decides what gets cut.

### Recovering time

When drift is positive and at least one upcoming item is `flexible`, offer a
single button: **Recover 12 min**. It reduces the `plannedMs` of remaining
flexible items proportionally, with a floor of one minute each, and shows the
result in the list before committing. Never touch the item that is running, and
never touch inflexible ones.

Default `flexible: true` for names matching praise, worship, offering,
announcements, testimonies. Everything else defaults false. The operator can
toggle any of them.

---

## 6. Advancing

```js
function advance(delta = 1) {
  const p = state.program;
  const cur = p.items[p.activeIndex];
  if (cur) cur.actualEndedAt = Date.now();

  const next = p.activeIndex + delta;
  if (next >= p.items.length) return endService();

  loadItem(next);
  p.items[next].actualStartedAt = Date.now();
  if (p.autoStartOnAdvance) start();
  push();
}
```

### Rules

- **A segment at zero holds in overrun.** It does not advance itself. The only
  exception is an item with `autoAdvance: true`, which is for pre-service
  countdowns rolling into the opening.
- **Advance auto-starts the next segment** by default. During a live service the
  operator wants one key, not two. Make it a setting for people who prefer a
  cue-then-fire rhythm.
- **Going back is allowed** and clears the actuals of the segment you return to,
  so the report stays truthful.
- **Jumping is allowed.** Clicking any row in the list jumps to it and marks the
  skipped items `skipped`, which the report then shows honestly.

### Keyboard

Add to the existing map in the control window:

| Key | Action |
| --- | --- |
| N or → → | Next segment |
| P | Previous segment |
| 1–9 | Jump to that segment |

Do not overload Space. It stays start/pause for the current segment, because
that is muscle memory by the third Sunday.

---

## 7. Control window UI

The program becomes a third column, or a left rail if the window is narrow.

```
┌─────────────────────────────────────────────────────────────┐
│  ● Stage Timer            Sunday First Service              │
├─────────────────────────────────────────────────────────────┤
│                      12:04                                  │
│              Sermon · Running · ends 11:47                   │
│         ▸ 12 min over · service ends 12:22                  │
├──────────────────────────┬──────────────────────────────────┤
│ RUN OF SERVICE           │ TIMER / TRANSPORT / MESSAGE      │
│                          │ (everything from BUILD.md)       │
│  ✓ Opening prayer 20│23  │                                  │
│  ✓ Praise         15│18  │                                  │
│  ✓ Worship        30│34  │                                  │
│  ✓ Testimonies    20│29  │                                  │
│ ▶ Sermon          60│47  │                                  │
│    Offering       30     │                                  │
│    Closing prayer 10     │                                  │
│                          │                                  │
│ [◀ Previous]  [Next ▶]   │                                  │
│ [Paste program] [Save]   │                                  │
└──────────────────────────┴──────────────────────────────────┘
```

Row anatomy: a state marker, the name, then `planned│actual` in tabular
figures. Completed rows show both and colour the actual by whether it beat the
budget. The running row shows its live elapsed. Upcoming rows show planned only.

The two numbers side by side are the whole point of the panel. Do not replace
them with a progress bar — the operator needs the specific minutes to have a
conversation with the pastor.

The active row is marked and pinned in view. Colour alone is not enough for a
dim booth, so use the marker as well.

---

## 8. Saved programs

- Store in `localStorage` under `stagetimer.programs`, keyed by name.
- A dropdown of saved programs: `Sunday First Service`, `Sunday Second Service`,
  `Wednesday Bible Study`, `Vigil`.
- Loading a program resets all actuals. Never carry last week's numbers forward.
- The last-used program reloads on launch, unstarted.
- **Export and import as JSON**, so one machine's programs move to the backup
  laptop without retyping.

---

## 9. Post-service report

One button, **Copy report**, producing plain text sized for WhatsApp:

```
Sunday First Service — 26 July
Started 9:02 · Ended 12:22 · 12 min over

Opening prayer     20 → 23   (+3)
Praise             15 → 18   (+3)
Worship            30 → 34   (+4)
Testimonies        20 → 29   (+9)
Sermon             60 → 71   (+11)
Offering           30 → 18   (−12)
Closing prayer     10 → 10

Planned 3h 05m · Actual 3h 20m
```

This closes the loop with management and is the cheapest feature here to build.
It is also the one that will get the app adopted, because it turns the media
team from people who watch the clock into people with data about it.

---

## 10. Build order

| Phase | Deliverable | Test |
| --- | --- | --- |
| 1 | `program.js` parser + unit tests on the seven-line block and three other shapes | Parser returns correct ms for every case in section 4 |
| 2 | Program state, `loadItem`, `advance`, persistence | Can step through a program with buttons |
| 3 | The list panel, active row, click to jump | Panel matches state after every action |
| 4 | Paste dialog with live preview and unreadable-line editing | Paste to running program in under 5 seconds |
| 5 | Drift, projected finish, anchor warnings | Numbers match hand calculation on a rehearsed run |
| 6 | Stage window `Next up:` line | Reads clearly from the back of the hall |
| 7 | Saved programs, JSON export | Program survives a restart |
| 8 | Report | Pastes cleanly into WhatsApp |
| 9 | Recover time | Trims only flexible upcoming items, floor respected |

Phases 1 to 4 are the feature. Everything after is what makes it get used every
Sunday. Ship 1 to 4, run one live service on it, then decide the order of the rest
based on what actually annoyed the operator.

---

## 11. Stage window changes

Deliberately minimal. The congregation is not the audience for the program.

- Add a `Next up: Offering` line beneath the message bar, in the same muted grey
  as the label, at roughly a third the message size.
- Hide it when there is no next segment, when a message is showing, or when the
  current segment is in overrun. In overrun the screen has exactly one job.
- Add a **Show next up** toggle in the control window. Some teams put this screen
  where the congregation can see it, and `Next up: Offering` is not always
  something you want announced ten minutes early.

---

## 12. Out of scope

- Auto-advancing through the whole service unattended
- Syncing the program from a Google Sheet or Planning Center
- Assigning segments to people, or any kind of rota
- Multiple concurrent programs
- Rich text or images in segment names

The first two are reasonable later. The rest are a different product.
