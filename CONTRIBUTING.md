# Contributing to HueFL

Thanks for helping! Bug reports and ideas go to [Issues](https://github.com/iuklaw/huefl/issues); for code, open a pull request. This page covers building from source and how the app is put together.

## Building from source

### Dependencies

Ubuntu / Debian:

```bash
sudo apt install build-essential curl wget file pkg-config libssl-dev \
  libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev \
  libpulse-dev libpipewire-0.3-dev libclang-dev
```

Fedora: `webkit2gtk4.1-devel openssl-devel libappindicator-gtk3-devel librsvg2-devel pulseaudio-libs-devel pipewire-devel clang-devel`.
Arch: `base-devel webkit2gtk-4.1 openssl libappindicator-gtk3 librsvg libpulse pipewire clang`.

Plus [Rust](https://rustup.rs) (stable) and Node.js 20+ with npm.

`libpulse-dev` is for music sync and `libpipewire-0.3-dev` + `libclang-dev` for screen sync on Wayland. They're Cargo features (`sync-audio`, `sync-screen-wayland`, on by default); `--no-default-features` builds without them.

Packaging HueFL for a distribution, the AUR or Flatpak? Leave out the `self-update` feature (on by default): the app then doesn't look for new versions and says in **Options -> About** that updates come from the package manager. A Flatpak never updates itself, whatever it was built with.

### Run and build

```bash
npm install
npm run tauri dev      # development, with hot reload
npm run tauri build    # .deb and AppImage in src-tauri/target/release/bundle/
```

The first run compiles the Rust dependencies, which takes a few minutes.

### Tests

```bash
npm test                         # TypeScript (vitest)
npx tsc --noEmit                 # type check
cd src-tauri && cargo test --lib # Rust
cargo clippy --all-targets
```

Some Rust tests talk to real hardware - your bridge, your speakers, your screen - so they're marked `#[ignore]` and run by hand, e.g.:

```bash
cd src-tauri
cargo test --lib live_overview -- --ignored --nocapture       # sync checklist for your bridge
cargo test --lib live_capture -- --ignored --nocapture        # 2 s of system audio
cargo test --lib live_screen -- --ignored --nocapture         # 1 s of the screen (X11)
cargo test --lib live_discover -- --ignored --nocapture       # bridges on your network (mDNS)
cargo test --lib live_portal -- --ignored --nocapture         # screen via the portal (Wayland)
cargo test --lib live_stream_screen -- --ignored --nocapture  # 5 s screen -> lights
```

## How it's built

```
src/                     React UI (TypeScript)
  core/                  state outside React: app (bridge, rooms), sync, schedules, updates, …
  hue/                   bridge API: discovery, pairing, resources, event stream, schedules
  components/, views/    UI; components/ui/ is shadcn/ui (npx shadcn add …)
  lib/                   pure helpers: colors, presets, sun, time zones
  locales/en.json        all texts - shared by TypeScript and Rust
src-tauri/src/           Rust
  hue.rs                 HTTPS to the bridge with certificate pinning, event stream, discovery
  tray.rs, window.rs     tray icon and menu, window show / hide
  sync/                  light sync engine: entertainment/ (REST, DTLS, packets),
                         audio/ (capture, analysis), screen/ (X11, Wayland portal, zones),
                         effects, smoothing, readiness, manager
  logs.rs, report.rs     log file, bug reports
  updates.rs, daily.rs   updater, color of the day
```

A few things that shape the design:

- **Anything that must work from the tray lives in Rust.** WebKitGTK suspends JavaScript in a hidden window, so the tray menu, the light sync engine (audio, screen, DTLS at 50 Hz) and the log are Rust; the UI sends commands and listens to events.
- **The bridge certificate can't be verified the usual way** (its CN is the bridge id, there's no SAN, Signify's root isn't published). HueFL pins it on first use (TOFU), like SSH.
- **The bridge rate-limits commands** (~10/s per light, ~1/s per group). `CommandQueue` keeps only the latest state per resource; the UI updates optimistically and the event stream (`/eventstream/clip/v2`) brings the truth.
- **Schedules run on the bridge** (API v1 schedules and rules), so they work with the computer off. HueFL's entries are named with an `HF·` prefix.
- **Logic that can be pure is pure and tested** - packet encoding, audio analysis, screen zones, schedules, sun times, palettes.

### Translations

Texts are in `src/locales/en.json`. To add a language, create `src/locales/<code>.json` with the same keys and register it in `catalogs` in `src/i18n.ts`. Plurals use `Intl.PluralRules` (`.one`, `.few`, `.many`, `.other`).

### Logs

`~/.local/state/huefl/huefl.log` (JSON lines, rotated at 1 MB), shown in **Options -> Logs**. Never log secrets: the TypeScript logger redacts key fields, and bug reports strip the bridge keys by value.
