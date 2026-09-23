# Midday Desktop App

A Tauri shell around the web dashboard: the window loads the dashboard URL, and the
Rust side adds a tray icon, a global shortcut with a search window, deep links and
native downloads. The dashboard detects the shell through `@midday/desktop-client`.

## Download

**https://github.com/FredflixBE/midday/releases/latest**: a universal `.dmg` for
macOS (Apple Silicon and Intel) and a `-setup.exe` for Windows. That link points
at the newest desktop build for as long as desktop releases are this repo's only
releases.

Neither installer is signed yet. On macOS the first launch is blocked: open
System Settings → Privacy & Security and click **Open Anyway**. On Windows,
SmartScreen says *Windows protected your PC*: click **More info** → **Run anyway**.

There is no auto-updater yet (FF-1695): download the new release and install it
over the old one.

## Releases

`.github/workflows/desktop-release.yml` builds both installers and publishes a
GitHub Release tagged `desktop-v<version>`. It runs when a push to `main` changes
`apps/desktop/**`, or by hand (Actions → Desktop release → Run workflow). A
dashboard change never starts it: the shell loads the live dashboard, so new
features reach desktop users through the ordinary deploy. A pull request touching
`apps/desktop/**`, or a manual run from any branch but `main`, builds both
installers as run artifacts without releasing. Markdown changes under
`apps/desktop/`, like this README, never start a run.

The version is `major.minor` from `src-tauri/Cargo.toml`, with the workflow's run
number as the patch (`0.5.<n>`). Bump `major.minor` there by hand; every release
is higher than the last without a version-bump commit.

## Which dashboard it opens

The URL is baked in at build time from `MIDDAY_APP_URL` (default
`http://localhost:3001`). A runtime `MIDDAY_APP_URL` overrides it for local testing.

The host must also be listed under `remote.urls` in
`src-tauri/capabilities/default.json`, otherwise the page loads but the window,
event and save-file IPC do not work. Only `https://midday.fredflix.be` is listed;
add your own host there if it differs. `localhost:3001` is trusted only by dev
builds, through `capabilities/dev.json`, which `tauri.dev.conf.json` enables.
The two files must grant the same permissions; a unit test checks it.

Files: the page may open and write only a path the user picked in a save dialog.
It has no upload plugin, no global-shortcut API and no other file commands; the
global shortcut and deep links are handled in Rust. `core:default` still lets it
use Tauri's core window, event, path, menu and tray APIs. The capabilities cover
macOS, Windows and Linux.

The deep-link scheme is `hq` (`hq-dev` for the dev config). The dashboard's
`NEXT_PUBLIC_DESKTOP_SCHEME` must match the build you install.

## Prerequisites

- Rust and the Tauri CLI prerequisites for macOS: https://tauri.app/start/prerequisites/
- Xcode command line tools

## Development

```bash
# Loads http://localhost:3001 as "Midday Dev" (be.fredflix.hq.dev) with the hq-dev scheme
bun run tauri:dev
```

## Building it yourself

```bash
cd apps/desktop
MIDDAY_APP_URL=https://midday.fredflix.be bun run tauri:build
```

The bundle lands in `src-tauri/target/release/bundle/` (a `.dmg` and a `.app`).
Drag the `.app` into Applications. It is ad-hoc signed, so macOS asks once, as
above. Without `MIDDAY_APP_URL` the build opens `http://localhost:3001`.

If the `.dmg` step fails with `hdiutil: couldn't unmount … Resource busy`, a
Finder window is holding the half-built image; run the build again.
