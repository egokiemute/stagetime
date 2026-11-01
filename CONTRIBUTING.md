# Contributing to Stage Timer

Thanks for helping out. Stage Timer runs live during church services and other
events, where a crash or a wrong number happens in front of a full room. Please
keep that in mind: reliability comes before new features.

## Ways to contribute

- **Report a bug.** Open a [GitHub issue](https://github.com/egokiemute/stagetime/issues)
  with your app version, your operating system, your screen setup (one monitor or
  a projector), the steps to reproduce it, and what you expected to happen.
- **Suggest a feature.** Open an issue describing the problem it solves during a
  service. Please do this before building anything large, so you don't spend time
  on something that may not fit.
- **Send a fix or improvement.** Small fixes can go straight to a pull request.

**Security problems:** if you find one, especially in phone control, don't post
the details in a public issue. Open an issue asking for a private way to share it.

## Getting set up

You need [Node.js](https://nodejs.org) 20 and Git. CI builds with Node 20.

```
git clone https://github.com/egokiemute/stagetime.git
cd stagetime
npm install
npm start
```

There is no bundler or build step: `npm start` runs the app directly from source.
After changing a window's HTML, CSS or JavaScript, press Cmd/Ctrl+R in that window
to reload it. After changing `main.js`, `remote.js` or `preload.js`, restart the app.

If the app crashes on launch from a VS Code terminal with
`Cannot read properties of undefined (reading 'getVersion')`, VS Code has set
`ELECTRON_RUN_AS_NODE`. Clear it for that run:

```
env -u ELECTRON_RUN_AS_NODE npm start
```

## How the code is organised

| File | What it does |
| --- | --- |
| `main.js` | Electron main process: windows, screens, auto-updates |
| `preload.js` | The only bridge between the windows and Electron. Keep it narrow |
| `shared.js` | State shape and time maths, used by every window and the phone page |
| `control.html`, `control.css`, `control.js` | The operator's control window. Owns the state |
| `program.js` | Run of service: parsing, segments, drift, saved programs, reports |
| `display.html`, `display.css`, `display.js` | The stage screen |
| `remote.js` | The local network server for phone control |
| `remote.html`, `remote.css`, `remote-client.js` | The page phones load |

For the reasoning behind the design, read [build.md](build.md) and
[PROGRAM.md](PROGRAM.md). They are the original build plans, so where they differ
from the code, the code is correct.

## Rules that protect a live service

Pull requests that break these will be asked to change.

1. **Never count down by subtracting on an interval.** Store an absolute time
   (`endsAt`) and work out what's left from `Date.now()`. Intervals only repaint.
2. **The control window is the only owner of state.** It sends whole snapshots when
   something changes. The stage window only draws what it receives and never sends
   anything back. Phones send commands, and the control window applies them.
3. **Never restart or interrupt on its own.** Updates install only when the operator
   clicks, and nothing may cover the controls while a service is running.
4. **Never hide overrun.** A segment at zero stays in overrun until the operator
   moves on.
5. **No strobing on the stage screen.** Flashing large areas is a real risk for
   photosensitive people in the room.
6. **Treat everything from a phone as untrusted.** Check the arguments of every
   command. New commands must be added to the allow-list in `remote.js`, and phone
   control must stay off by default and protected by the PIN.
7. **Never inject HTML from outside the app.** Use `textContent`, as the existing
   code does.

## Code style

There is no linter or formatter, so match the code around your change:

- Plain JavaScript with no framework, 2-space indents, semicolons and single quotes.
- Comments explain why something is done, not what the code does.
- Avoid new dependencies. If you need one, explain why in the pull request. If you
  add a new file the app needs at runtime, also add it to `build.files` in
  `package.json`, or it will be missing from the installers.
- Keep the look consistent with the colour variables at the top of `control.css`.

## Testing your change

The project has no automated test suite yet, so please test by hand and say what
you tried in your pull request.

1. Check the syntax of each script you changed: `node --check control.js`
2. Run `npm start` and go through the feature you touched.
3. If your change affects the timer or the stage screen, also check:
   - Start, pause, reset and nudge, then let a timer run past zero.
   - The stage window on a second screen if you have one, and on a single screen
     using Cmd/Ctrl+Shift+H to hide it.
   - Stepping through a pasted program with Next, Previous and a jump.
4. If your change affects phone control, test it on a real phone on the same Wi-Fi.
5. If your change touches packaging, run `npm run dist` and open the built app.

## Sending a pull request

1. Fork the repository and create a branch from `main`, such as `fix-overrun-label`.
2. Keep each pull request to one change. It's easier to review and safer to release.
3. Write commit messages that say what changed, starting with a verb, such as
   `Show the connected screen on the Send to screen button`.
4. Update `README.md` if you changed how something is used, including keyboard
   shortcuts.
5. In the pull request, explain what changed and why, list what you tested and on
   which operating system, and add a screenshot for anything visual.

Please don't change the version number, `release-notes.md` or the release tags.
The maintainer handles those when publishing a release.

## Releases

Pushing a `vX.Y.Z` tag makes GitHub Actions build the installers for macOS, Windows
and Linux, then publish them with `release-notes.md` as the release text. Installed
apps show that text in their "What's new" dialog, so it's written for the people
running the app, not for developers.

## License

Stage Timer is [MIT licensed](LICENSE). By submitting a contribution, you agree that
it is released under the same license.
