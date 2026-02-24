# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Gia is an Electron desktop app (macOS) for meeting recording using the Recall.ai Desktop SDK. It detects active meetings, records with user confirmation, provides live transcription, and generates AI-powered summaries.

## Commands

```bash
npm start                # Run dev app (starts Express server + Electron concurrently)
npm run start:electron   # Electron app only (electron-forge start)
npm run start:server     # Express server only (node ./src/server.js)
npm run package          # Package app (electron-forge package)
npm run make             # Build distributable DMG
```

No test framework or linter is configured. Manual testing via `npm start` with `DEBUG=true` env var to enable debug controls.

## Architecture

### Process Model

Electron three-process architecture:

- **Main process** (`src/main.js`) — Tray menu, Recall SDK lifecycle, meeting detection, recording orchestration, Auth0 OAuth PKCE flow, window management, permission handling
- **Renderer process** (`src/renderer.js`) — Meeting list UI, note editing, recording state display
- **Preload bridge** (`src/preload.js`) — Exposes `window.electronAPI` and `window.sdkLoggerBridge` via `contextBridge`

The app runs as a **tray-only app** (no dock icon on macOS). Windows are spawned for specific flows: meeting popup, onboarding, debug controls.

### IPC Pattern

All renderer↔main communication goes through `ipcMain.handle` / `ipcRenderer.invoke` (async, Promise-based). Namespaced by concern:

- `auth:*` — Login, logout, token checks
- `onboarding:*` — Permission requests, onboarding flow control
- `meeting-popup:*` — Recording confirm/decline/end
- `debug-controls:*` — State inspection, pause/stop
- Top-level — `saveMeetingsData`, `loadMeetingsData`, `deleteMeeting`, `generateMeetingSummary`, `startManualRecording`, `stopManualRecording`

Main→renderer events broadcast via `webContents.send` with preload listeners (`onTranscriptUpdated`, `onRecordingCompleted`, `onSummaryUpdate`, etc.).

### Adding a new IPC handler

1. Add `ipcMain.handle("namespace:action", handler)` in `src/main.js`
2. Add wrapper in `src/preload.js` under `electronAPI`
3. Call from renderer via `window.electronAPI.namespace.action()`

### Express Server (`src/server.js`)

Local server on port 13373 that proxies upload token requests to the Recall.ai API. The main process calls this to get tokens before starting a recording.

### Two Critical Backend Interactions

1. **Upload token** — On recording start, the app fetches an upload token from the Express server (which proxies to Recall.ai). This token is passed to `RecallAiSdk.startRecording()`.
2. **Meeting URL registration** — `registerCurrentMeetingUrlIfNeeded()` sends the meeting URL to the Gia backend (`api.registerMeetingUrl`). The meeting URL typically isn't available at `meeting-detected` time — it arrives via `meeting-updated` events (fired when meeting metadata like title/URL becomes known). The function is called at least once after detection and on subsequent `meeting-updated` events. It is throttled (15s) and deduped internally to avoid spamming the API.

### Key Utilities

- `src/utils/auth.js` — Auth0 OAuth PKCE with loopback callback server (port 47823), token storage at `~/.config/Gia/auth.tokens.json`
- `src/utils/api.js` — Backend API client (base: `https://api.myagiea.com`) for upload tokens, meeting URL registration, user profiles
- `src/utils/logger.js` — Dual logging: local file (`gia.log`) + remote Logfire. W3C trace context support
- `src/utils/load-env.js` — Smart `.env` discovery across dev/packaged contexts

### Recall SDK Integration

Recording flow: meeting-detected event → popup for user confirmation → auth check → upload token from server → `startRecording(windowId, uploadToken)` → realtime transcript/video events → recording-ended → state reset.

Key SDK events: `meeting-detected` (meeting found), `meeting-updated` (URL/title becomes known), `meeting-closed` (meeting ends), `sdk-state-change`, `recording-ended`, `permission-status`, `transcript.data`, `participant_events.join`, `video_separate_png.data`.

### State Management

Global mutable variables in main process (no state library). `setCaptureState({recording, paused})` is the central state updater that also refreshes the tray menu. Renderer uses in-memory arrays persisted to `~/.config/Gia/meetings.json` via IPC.

### Data Storage

All in `~/.config/Gia/`:
- `meetings.json` — Meeting data
- `auth.tokens.json` — OAuth tokens (mode 0600)
- `onboarding.json` — Onboarding completion flags

## Build & Packaging

Electron Forge with Webpack bundler. The `@recallai/desktop-sdk` native module is externalized (not bundled into ASAR). macOS code signing controlled via `GIA_MAC_SIGN=1` and `GIA_MAC_NOTARIZE=1` env vars. See `forge.config.js` for full config.

## Auto-Updates

Configured via `update-electron-app` in `src/main.js` (`setupAutoUpdates()`). Only active when the app is packaged and on macOS. Uses the **Electron Public Update Service** (`update.electronjs.org`) which reads from GitHub Releases on `agiea-brain/gia-desktop-recording`.

To ship an update: bump version in `package.json` → `npm run make` → create a GitHub Release with the built ZIP artifact. The update service picks it up automatically. No `publish` config is set in `forge.config.js`, so the GitHub Release step is manual.

## Environment Variables

Required:
- `RECALLAI_API_URL` — Recall.ai region base URL
- `RECALLAI_API_KEY` — Recall.ai API key

Optional:
- `OPENROUTER_KEY` — AI summaries via OpenRouter
- `DEBUG=true` — Enables debug tray menu items
- `GIA_MAC_SIGN=1` — Enable macOS code signing
- Auth0 vars have defaults (`AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_AUDIENCE`, etc.)
