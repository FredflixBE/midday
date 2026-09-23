# Midday Desktop App

A Tauri shell around the web dashboard: the window loads the dashboard URL, and the
Rust side adds a tray icon, a global shortcut with a search window, deep links and
native downloads. The dashboard detects the shell through `@midday/desktop-client`.

There is no auto-updater. You build the app yourself and install the result.

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

## Building for the self-hosted dashboard

```bash
cd apps/desktop
MIDDAY_APP_URL=https://midday.fredflix.be bun run tauri:build
```

The bundle lands in `src-tauri/target/release/bundle/` (a `.dmg` and a `.app`).
Drag the `.app` into Applications.

The build is not signed or notarised. On first launch macOS refuses to open it;
right-click the app, choose **Open**, and confirm. After that it opens normally.
Rebuild and reinstall the same way to update.
