# AGENTS.md

Clip Merger is a Windows Electron + ffmpeg desktop app: a DaVinci-like multi-clip
timeline editor (Media/Transitions/Sounds/Effects bins, MAIN/ALT/SOUND lanes, camera
effects, markers, undo/redo, images, freeze frames, mic recording) with a
lossless-first export pipeline.

## Run & test
- `npm start` — launch the app (Electron).
- `npm test` — run the whole unit suite (`node --test`, all `test/*.test.js`).
- Focused run: `node --test test/<name>.test.js`.
- No lint or build script exists. `test-e2e.js` only runs if Playwright is installed.

## Where the code lives
- `electron/main.js` — window, IPC handlers, settings, thumbnail/preview caches.
- `electron/preload.js` — the only renderer↔main bridge (`contextBridge` → `window.api`).
- `electron/ffmpeg/` — `probe.js`, `encoders.js`, `export.js` (the export pipeline).
- `renderer/app.js` — UI, timeline editing, preview/playback, project save/load.
- `renderer/timeline-ops.js`, `renderer/mic-model.js`, `renderer/mic-wav.js` — pure logic.
- `test/*.test.js` — node:test suites covering the pure modules.

## Rules (easy to break)
- Keep pure math in `timeline-ops.js` / `mic-model.js`, and add a test for every new function.
- `renderer/app.js` and `electron/ffmpeg/export.js` must agree: preview timing, camera
  effects, and still/freeze handling mirror the export plan — change both together.
- Export must never overwrite a source clip: keep the `sourceConflict` check in the
  renderer and the guard inside `exportProject`.
- The renderer has no Node access (`contextIsolation: true`). Add capabilities as
  `preload.js` IPC handlers, never by enabling `nodeIntegration`.
- Keep the CSP in `index.html`; don't add remote scripts or styles.

## Verify a change
- `npm test` passes with no failures and no new skipped tests.
- For a focused change, `node --test test/<name>.test.js`.
- Launch (`npm start`) and exercise the touched path by hand; for export or
  still/freeze/mic changes, render a short clip and confirm the output plays.
