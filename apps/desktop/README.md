# Midday Desktop App

A Tauri shell around the web dashboard: the window loads the dashboard URL, and the
Rust side adds a tray icon, a global shortcut with a search window, deep links and
native downloads. The dashboard detects the shell through `@midday/desktop-client`.

There is no auto-updater. You build the app yourself and install the result.

## Which dashboard it opens

The URL is baked in at build time from `MIDDAY_APP_URL` (default
`http://localhost:3001`). A runtime `MIDDAY_APP_URL` overrides it for local testing.

The host must also be listed under `remote.urls` in
`src-tauri/capabilities/default.json`, otherwise the page loads but the tray,
global shortcut and download IPC do not work. `localhost:3001` and
`https://midday.fredflix.be` are listed; add your own host there if it differs.

The deep-link scheme is `midday` (`midday-dev` for the dev config). The dashboard's
`NEXT_PUBLIC_DESKTOP_SCHEME` must match the build you install.

## Prerequisites

- Rust and the Tauri CLI prerequisites for macOS: https://tauri.app/start/prerequisites/
- Xcode command line tools

## Development

```bash
# Loads http://localhost:3001 with the "Midday Dev" identifier and midday-dev scheme
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
