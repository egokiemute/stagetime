# Stage Timer

A two-window countdown timer for church services: a **Control** window for
the operator's Mac, and a **Stage** window that shows a giant countdown on a
projector or second screen. See [build.md](build.md) for the full design
spec and [PROGRAM.md](PROGRAM.md) for the run-of-service feature.

## Install

Grab the latest build for your system from the
[Releases page](https://github.com/egokiemute/stagetime/releases).

### macOS

1. Download `Stage Timer-<version>.dmg`.
2. Open it and drag **Stage Timer** into Applications.
3. First launch only — the app is unsigned (no paid Apple Developer
   certificate), so Gatekeeper will block it. Either:
   - Right-click the app in Applications → **Open** → confirm in the dialog, or
   - Run once in Terminal: `xattr -cr "/Applications/Stage Timer.app"`

   After that first unlock, it opens normally like any other app.

### Windows

1. Download `Stage Timer Setup <version>.exe`.
2. Run it. The app is unsigned, so Windows SmartScreen will show a warning —
   click **More info** → **Run anyway**.
3. Follow the installer; it creates a Start Menu shortcut.

### Linux

Two formats are published:

- **AppImage** (recommended — supports in-app auto-update):
  ```
  chmod +x "Stage Timer-<version>.AppImage"
  ./"Stage Timer-<version>.AppImage"
  ```
- **.deb** (Debian/Ubuntu):
  ```
  sudo dpkg -i stagetimer_<version>_amd64.deb
  ```
  Note: `.deb` installs do **not** auto-update — reinstall manually for each
  new version, or switch to the AppImage.

## Updates

Packaged builds check GitHub Releases once on launch. If a new version is
available, a small banner appears in the Control window title bar —
clicking **Restart & update** installs it. It never restarts on its own,
so an update landing mid-service won't interrupt anything running.

## Running from source

Requires [Node.js](https://nodejs.org).

```
git clone https://github.com/egokiemute/stagetime.git
cd stagetime
npm install
npm start
```

No bundler or build step — `npm start` runs the app directly from source.

## Building installers yourself

```
npm run dist      # unpacked app for your current OS, in dist/
npm run dmg       # macOS installer (dmg + zip)
npm run release   # build and publish to GitHub Releases (needs a GH_TOKEN)
```

Official releases are built automatically for macOS, Windows, and Linux by
[.github/workflows/release.yml](.github/workflows/release.yml) whenever a
tag matching `vX.Y.Z` is pushed:

```
# bump "version" in package.json first
git commit -am "vX.Y.Z"
git tag vX.Y.Z
git push origin main --tags
```

## Keyboard shortcuts

All shortcuts work in the Control window (ignored while typing in a text
field), except the last one, which works everywhere:

| Key | Action |
| --- | --- |
| Space | Start / pause the current timer |
| R | Reset |
| ↑ / ↓ | ±1 minute |
| ← / → | ±15 seconds |
| B | Blackout the stage screen |
| S | Send stage window to a screen (asks the first time) |
| H | Close/hide the stage window |
| Esc | Clear the message bar |
| N | Next segment (run-of-service) |
| P | Previous segment (run-of-service) |
| 1–9 | Jump to that segment |
| Cmd/Ctrl+Shift+H | **Global** — hides the stage window from anywhere, even if it's covering your whole screen |

## License

MIT — see [LICENSE](LICENSE).
