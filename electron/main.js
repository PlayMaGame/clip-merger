const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { detectEncoders, run, runRaw } = require('./ffmpeg/encoders');
const { probe, keyframes } = require('./ffmpeg/probe');
const { exportProject, cancelExport } = require('./ffmpeg/export');
const { createExportGuard } = require('./export-guard');
const { buildPlan, applyPlan } = require('./purge-media');
const { writeFileAtomic } = require('./fs-atomic');
const { MEDIA_EXT, AUDIO_EXT, MEDIA_EXT_LIST, AUDIO_EXT_LIST } = require('./media-types');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_FFMPEG = 'ffmpeg';
const DEFAULT_FFPROBE = 'ffprobe';

let win = null;
let allowClose = false;   // set once the renderer has cleared the unsaved-changes prompt
let closePending = false; // a prompt is already showing; ignore repeat close requests
let cachedEncoders = null;
const exportGuard = createExportGuard();
let thumbCache = new Map();      // thumbnail key -> cached file path (session cache)
const thumbInflight = new Map(); // thumbnail key -> in-flight promise (coalesce duplicates)
const baseWatchers = new Map();
const previewCache = new Map();  // preview key -> proxy file path (session cache)
const previewInflight = new Map(); // preview key -> in-flight promise (coalesce duplicates)

/* Concurrency limiter: keeps heavy ffmpeg work from saturating the CPU. */
function createLimiter(maxConcurrent) {
  let active = 0;
  const queue = [];
  const pump = () => {
    if (active >= maxConcurrent || queue.length === 0) return;
    active += 1;
    const job = queue.shift();
    Promise.resolve().then(job.fn).then(
      (v) => { active -= 1; job.resolve(v); pump(); },
      (e) => { active -= 1; job.reject(e); pump(); },
    );
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
}
// Shared, CPU-friendly throttle for ffprobe/ffmpeg work (scan probes, add-to-timeline
// probes, waveforms). Heavy thumbnail extraction gets its own smaller limiter.
const WORK_CONCURRENCY = 4;
const workLimiter = createLimiter(WORK_CONCURRENCY);
const THUMB_CONCURRENCY = 3;
const thumbLimiter = createLimiter(THUMB_CONCURRENCY);
// Preview-proxy encodes are heavy disk/GPU work but low priority; run one at a time
// so a background build never competes with scrubbing or playback.
const previewLimiter = createLimiter(1);

/* ---- persistent thumbnail cache (disk) ----
   Keyed by path + mtime + size (+ requested width), so a folder re-open or an app
   restart serves JPEGs from disk instead of re-decoding every clip. Swept on boot. */
const THUMB_DIR_MAX_FILES = 5000;
const THUMB_DIR_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
function thumbDir() { return path.join(app.getPath('userData'), 'thumbs'); }
function thumbKeyFor(file, mtimeMs, size, maxW) {
  const hash = crypto.createHash('sha1').update(`${file}|${mtimeMs}|${size}|${maxW}`).digest('hex');
  return hash + '.jpg';
}
function sweepThumbCache() {
  const dir = thumbDir();
  let entries = [];
  try {
    entries = fs.readdirSync(dir).map((name) => {
      const p = path.join(dir, name);
      try { return { p, mtimeMs: fs.statSync(p).mtimeMs }; } catch (_) { return null; }
    }).filter(Boolean);
  } catch (_) { try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {} }
  const now = Date.now();
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const stale = [];
  for (let i = 0; i < entries.length; i++) {
    if (now - entries[i].mtimeMs > THUMB_DIR_MAX_AGE_MS) stale.push(entries[i].p);
  }
  if (entries.length - stale.length > THUMB_DIR_MAX_FILES) {
    const keepFrom = entries.length - THUMB_DIR_MAX_FILES;
    for (let i = 0; i < keepFrom; i++) {
      if (!stale.includes(entries[i].p)) stale.push(entries[i].p);
    }
  }
  for (const p of stale) { try { fs.rmSync(p, { force: true }); } catch (_) {} }
}

/* ---- persistent preview-proxy cache (disk) ----
   A tiny all-keyframe copy of each clip (fit inside 420x720, original fps, audio
   kept) so the timeline shuttle seeks in ~1 frame instead of decoding up to a few
   hundred long-GOP frames. Built lazily when a clip lands on the timeline, keyed
   by path + mtime + size, swept on boot. Exports always use the originals. */
const PREVIEW_DIR_MAX_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB
const PREVIEW_DIR_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const PREVIEW_MAX_W = 420;
const PREVIEW_MAX_H = 720;
function previewDir() { return path.join(app.getPath('userData'), 'previews'); }
function previewKeyFor(file, mtimeMs, size) {
  const hash = crypto.createHash('sha1')
    .update(`${file}|${mtimeMs}|${size}|pv1|${PREVIEW_MAX_W}x${PREVIEW_MAX_H}|ai`).digest('hex');
  return hash + '.mp4';
}
function sweepPreviewCache() {
  const dir = previewDir();
  let entries = [];
  try {
    entries = fs.readdirSync(dir).map((name) => {
      const p = path.join(dir, name);
      try { const st = fs.statSync(p); return { p, mtimeMs: st.mtimeMs, size: st.size }; } catch (_) { return null; }
    }).filter(Boolean);
  } catch (_) { try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {} }
  const now = Date.now();
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
  const stale = new Set();
  let total = 0;
  for (const e of entries) total += e.size;
  for (const e of entries) {
    if (now - e.mtimeMs > PREVIEW_DIR_MAX_AGE_MS) { stale.add(e.p); total -= e.size; }
  }
  for (const e of entries) {
    if (total <= PREVIEW_DIR_MAX_BYTES) break;
    if (!stale.has(e.p)) { stale.add(e.p); total -= e.size; }
  }
  for (const p of stale) { try { fs.rmSync(p, { force: true }); } catch (_) {} }
}

// Order encoder candidates fastest-first, reusing the session's detected list.
function previewEncoderChoices() {
  const list = (cachedEncoders && cachedEncoders.encoders) || [];
  const preferred = (cachedEncoders && cachedEncoders.preferred) || 'libx264';
  const ordered = [];
  const byId = new Map(list.map((c) => [c.id, c]));
  if (byId.has(preferred)) ordered.push(byId.get(preferred));
  for (const c of list) if (c.id !== preferred) ordered.push(c);
  if (!ordered.length) ordered.push({ id: 'libx264' });
  return ordered;
}
// Preview-quality quantizer — deliberately independent of the export settings so
// exports keep their own quality; the copy just needs to be small and sharp enough.
function previewEncoderOpts(id) {
  if (id === 'h264_amf') return ['-quality', 'balanced', '-rc', 'cqp', '-qp_i', '24', '-qp_p', '24'];
  if (id === 'h264_nvenc') return ['-preset', 'p4', '-rc', 'constqp', '-qp', '24'];
  return ['-preset', 'ultrafast', '-crf', '24'];
}
function previewEncodeArgs(file, out, id) {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-threads', '2', '-filter_threads', '1',
    '-i', file,
    '-map', '0:v:0', '-map', '0:a?',
    '-vf', `scale=${PREVIEW_MAX_W}:${PREVIEW_MAX_H}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
    '-c:v', id, ...previewEncoderOpts(id),
    '-g', '1', '-bf', '0', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart',
    '-f', 'mp4',
    out,
  ];
}
// A copy is only useful if it really is all-intra (a hardware encoder may ignore
// -g 1). Compare keyframe count against the expected frame count.
async function verifyAllIntra(ffprobePath, file) {
  try {
    const p = await probe(ffprobePath, file);
    const expected = Math.max(1, Math.round((p.duration || 0) * (p.fps || 0)));
    const kfs = await keyframes(ffprobePath, file);
    return kfs.length >= expected * 0.9;
  } catch (_) { return false; }
}
async function buildPreviewCopy(ffmpegPath, ffprobePath, file, key) {
  const dir = previewDir();
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, key);
  const tmp = out.replace(/\.mp4$/, '.tmp' + process.pid + Date.now().toString(36) + '.mp4');
  try {
    const choices = previewEncoderChoices();
    let ok = false;
    for (const enc of choices) {
      const r = await run(ffmpegPath || DEFAULT_FFMPEG, previewEncodeArgs(file, tmp, enc.id));
      if (r.code !== 0 || !fs.existsSync(tmp)) continue;
      if (await verifyAllIntra(ffprobePath || DEFAULT_FFPROBE, tmp)) { ok = true; break; }
      try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    }
    if (!ok) return { ok: false, error: 'preview encode failed', key };
    fs.renameSync(tmp, out);
    previewCache.set(key, out);
    return { ok: true, file: out, key };
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    return { ok: false, error: String(e), key };
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#14161a',
    title: 'Clip Merger',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(ROOT, 'renderer', 'index.html')).catch((e) => console.error('LOAD_ERR', e));
  // Defer closing to the renderer so it can offer to save unsaved work. It
  // replies via 'app:close-confirm'; we then destroy (bypasses this handler).
  win.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    if (closePending) return;
    closePending = true;
    try { win.webContents.send('app:request-close'); }
    catch (_) { allowClose = true; win.destroy(); }
  });
}

app.whenReady().then(() => { sweepThumbCache(); sweepPreviewCache(); createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

/* ---------------- persisted user preferences ---------------- */
// Kept in the app's userData folder, independent of localStorage and of any
// project file, so folder/encoder preferences always survive a restart.
function settingsStorePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function readSettingsStore() {
  try {
    const raw = fs.readFileSync(settingsStorePath(), 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : null;
  } catch (_) { return null; }
}
function writeSettingsStore(data) {
  try {
    fs.mkdirSync(path.dirname(settingsStorePath()), { recursive: true });
    fs.writeFileSync(settingsStorePath(), JSON.stringify(data || {}, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('SETTINGS_SAVE_ERR', e);
    return false;
  }
}
ipcMain.handle('settings:set', async (_e, data) => writeSettingsStore(data));

ipcMain.handle('app:init', async (_e, cfg) => {
  const ffmpegPath = (cfg && cfg.ffmpegPath) || DEFAULT_FFMPEG;
  const ffprobePath = (cfg && cfg.ffprobePath) || DEFAULT_FFPROBE;
  if (!cachedEncoders || cachedEncoders.ffmpegPath !== ffmpegPath) {
    const saved = readSettingsStore() || {};
    const probe = (saved.width && saved.height) ? `${saved.width}x${saved.height}` : '1080x1920';
    const e = await detectEncoders(ffmpegPath, probe);
    cachedEncoders = { ...e, ffmpegPath };
  }
  return {
    encoders: cachedEncoders.encoders,
    preferred: cachedEncoders.preferred,
    mediaExt: MEDIA_EXT_LIST,
    audioExt: AUDIO_EXT_LIST,
    saved: readSettingsStore(),
    defaults: {
      ffmpegPath,
      ffprobePath,
      clipsDir: path.join(ROOT, 'clips'),
      baseDir: path.join(ROOT, 'clips'),
      soundsDir: path.join(ROOT, 'sounds'),
      transitionDir: path.join(ROOT, 'transitions'),
      outputDir: path.join(ROOT, 'output'),
      width: 1080,
      height: 1920,
      fps: 60,
      normalizeAudio: false,
      autoSave: false,
      autoSaveMinutes: 5,
    },
  };
});

ipcMain.handle('dialog:openMedia', async (_e, opts) => {
  const filters = opts && opts.audio
    ? [{ name: 'Audio', extensions: AUDIO_EXT_LIST }]
    : [{ name: 'Video', extensions: MEDIA_EXT_LIST }];
  const res = await dialog.showOpenDialog(win, {
    title: opts && opts.audio ? 'Add soundboard audio' : 'Add clips',
    properties: ['openFile', 'multiSelections'],
    filters: [...filters, { name: 'All files', extensions: ['*'] }],
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle('dialog:saveOutput', async (_e, defName) => {
  const res = await dialog.showSaveDialog(win, {
    title: 'Export merged video',
    defaultPath: defName || 'merged.mp4',
    filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
  });
  return res.canceled ? null : res.filePath;
});

ipcMain.handle('dialog:chooseDir', async (_e) => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('project:probe', async (_e, { ffprobePath, files }) => {
  // Probe in bounded parallel batches — order preserved by the map.
  const out = await Promise.all(files.map(async (f) => {
    try {
      const info = await workLimiter(() => probe(ffprobePath || DEFAULT_FFPROBE, f));
      info.name = path.basename(f);
      return info;
    } catch (e) {
      return { path: f, name: path.basename(f), error: String(e) };
    }
  }));
  return out;
});

ipcMain.handle('project:keyframes', async (_e, { ffprobePath, file }) => {
  try {
    return { path: file, times: await keyframes(ffprobePath || DEFAULT_FFPROBE, file) };
  } catch (e) {
    return { path: file, error: String(e) };
  }
});

ipcMain.handle('audio:waveform', async (_e, { ffmpegPath, file, srcStart, srcEnd, points }) => {
  try {
    const ss = srcStart || 0;
    const se = srcEnd != null ? srcEnd : Number.MAX_SAFE_INTEGER;
    const dur = Math.min(600, Math.max(0.2, se - ss));
    const n = Math.max(24, Math.min(4096, points || 180));
    const ar = Math.max(120, Math.min(1200, Math.round((n * 8) / dur)));
    const r = await workLimiter(() => runRaw(ffmpegPath || DEFAULT_FFMPEG, [
      '-hide_banner', '-loglevel', 'error', '-ss', ss.toFixed(3), '-t', dur.toFixed(3),
      '-i', file, '-map', '0:a:0', '-ac', '1', '-ar', String(ar), '-vn', '-f', 'f32le', '-',
    ]));
    if (r.code !== 0) return { ok: false, error: r.err.slice(-400) || 'waveform failed' };
    const buf = r.buf;
    const floats = Math.floor(buf.length / 4);
    const peaks = new Array(n).fill(0);
    if (floats > 0) {
      for (let i = 0; i < floats; i++) {
        const v = buf.readFloatLE(i * 4);
        const a = Math.abs(v);
        const b = Math.floor((i / floats) * n);
        if (a > peaks[b]) peaks[b] = a;
      }
      // scale to unit
      let m = 0;
      for (const p of peaks) if (p > m) m = p;
      if (m > 0) for (let i = 0; i < n; i++) peaks[i] = peaks[i] / m;
    }
    return { ok: true, peaks, dur };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('project:save', async (_e, { file, data }) => {
  try {
    writeFileAtomic(file, JSON.stringify(data, null, 2));
    return { ok: true };
  } catch (e) {
    console.error('PROJECT_SAVE_ERR', e);
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});

ipcMain.handle('project:load', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: 'Open project',
    filters: [{ name: 'Clip Merger project', extensions: ['json', 'llc'] }],
    properties: ['openFile'],
  });
  if (res.canceled) return null;
  const file = res.filePaths[0];
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { file, data };
  } catch (e) {
    return { error: 'Not a valid Clip Merger project: ' + String(e && e.message ? e.message : e) };
  }
});

ipcMain.handle('project:saveAs', async (_e, data) => {
  const res = await dialog.showSaveDialog(win, {
    title: 'Save project',
    defaultPath: 'project.json',
    filters: [{ name: 'Clip Merger project', extensions: ['json'] }],
  });
  if (res.canceled) return null;
  try {
    writeFileAtomic(res.filePath, JSON.stringify(data, null, 2));
    return { ok: true, file: res.filePath };
  } catch (e) {
    console.error('PROJECT_SAVE_ERR', e);
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});

// The renderer answered the close prompt: destroy the window (bypassing the
// 'close' handler) only when it is safe to lose the current document.
ipcMain.handle('app:close-confirm', async (_e, ok) => {
  if (!ok) {
    closePending = false;
    return;
  }
  // If a render is in flight, cancel it and let its finally block remove the
  // work dir before the window (and app) goes away.
  if (exportGuard.exporting) await exportGuard.cancelAndWait(cancelExport);
  closePending = false;
  allowClose = true;
  if (win && !win.isDestroyed()) win.destroy();
});

ipcMain.handle('export:run', async (e, { ffmpegPath, ffprobePath, project, outputFile }) => {
  const workDir = path.join(app.getPath('temp'),
    'clipmerger_' + Date.now() + '_' + Math.floor(Math.random() * 1e6));
  const send = (p) => { try { e.sender.send('export:progress', p); } catch (_) {} };
  // A failed/cancelled run can leave a truncated file that looks like a result;
  // only clean it up when we created it (not something that pre-existed).
  const existed = !!(outputFile && fs.existsSync(outputFile));
  try {
    const run = exportGuard.begin(exportProject({
      ffmpegPath: ffmpegPath || DEFAULT_FFMPEG,
      ffprobePath: ffprobePath || DEFAULT_FFPROBE,
      project, outputFile, workDir, onEvent: send,
    }));
    const out = await run;
    return { ok: true, outputFile: out };
  } catch (err) {
    if (!existed && outputFile) { try { fs.rmSync(outputFile, { force: true }); } catch (_) {} }
    return { ok: false, error: String(err && err.message ? err.message : err) };
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) {}
  }
});

ipcMain.handle('export:cancel', async () => cancelExport());

ipcMain.handle('shell:reveal', async (_e, file) => {
  if (file && fs.existsSync(file)) shell.showItemInFolder(file);
});

/* ---------------- purge used media ----------------
   Moves source Media files that are referenced by any saved project into
   <outputDir>/Purged (flat) and repoints every affected save at the new
   location, so the projects keep working after the move. Nothing is deleted.
   The planning/moving logic lives in purge-media.js (unit-testable). */
ipcMain.handle('media:purge', async (_e, opts) => {
  const dryRun = !(opts && opts.dryRun === false);
  const extSet = new Set();
  for (const e of [...((opts && opts.mediaExt) || []), ...((opts && opts.audioExt) || [])]) {
    extSet.add('.' + String(e).replace(/^\./, '').toLowerCase());
  }
  if (!extSet.size) { for (const e of MEDIA_EXT) extSet.add(e); for (const e of AUDIO_EXT) extSet.add(e); }

  const plan = buildPlan({
    outputDir: opts && opts.outputDir,
    baseDir: opts && opts.baseDir,
    extSet,
  });
  if (!plan.ok) return plan;

  if (dryRun) {
    return {
      ok: true, dryRun: true, purgeDir: plan.purgeDir, refs: plan.refs,
      files: plan.files, totalSize: plan.totalSize, projects: plan.projects.map((p) => p.file),
    };
  }
  const res = applyPlan(plan);
  return { ok: true, dryRun: false, purgeDir: plan.purgeDir, ...res };
});

/* ---------------- clip base ---------------- */

async function walkDir(dir, depth, out, maxDepth, maxFiles, extSet) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const ent of entries) {
    if (out.length >= maxFiles) break;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (depth < maxDepth) await walkDir(full, depth + 1, out, maxDepth, maxFiles, extSet);
    } else if (extSet.has(path.extname(ent.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

const baseWatchTimers = new Map(); // watched dir -> debounce timer

function scheduleBaseChange(dir) {
  clearTimeout(baseWatchTimers.get(dir));
  baseWatchTimers.set(dir, setTimeout(() => {
    baseWatchTimers.delete(dir);
    if (win && !win.isDestroyed()) win.webContents.send('base:changed', dir);
  }, 400));
}

function stopWatch(dir) {
  const w = baseWatchers.get(dir);
  if (w) {
    try { w.close(); } catch (_) {}
    baseWatchers.delete(dir);
  }
  clearTimeout(baseWatchTimers.get(dir));
  baseWatchTimers.delete(dir);
}

function ensureWatch(dir) {
  if (!dir || baseWatchers.has(dir) || !fs.existsSync(dir)) return;
  try {
    const watcher = fs.watch(dir, { recursive: true }, () => scheduleBaseChange(dir));
    // ReadDirectoryChangesW can overflow its buffer and emit 'error' — re-scan
    // so nothing is silently lost (the renderer re-probes anyway).
    watcher.on('error', () => scheduleBaseChange(dir));
    baseWatchers.set(dir, watcher);
  } catch (_) { /* ignore */ }
}

// Close a bin's watcher when its root folder changes (keeps OS handles bounded).
ipcMain.handle('base:unwatch', async (_e, dir) => { stopWatch(dir); return true; });

// Cheap, non-recursive directory listing: subfolders + files, no ffprobe.
// Powers the bin breadcrumb so opening a folder only reads that one level.
ipcMain.handle('base:list', async (_e, { dir }) => {
  const out = { dir, dirs: [], files: [] };
  // Keep child paths in the same separator style the caller used, so a forward-
  // slash root (e.g. typed into Settings) navigates without mismatched paths.
  const asPosix = String(dir).includes('/') && !String(dir).includes('\\');
  const shape = (p) => (asPosix ? p.split(path.sep).join('/') : p);
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = shape(path.join(dir, ent.name));
      if (ent.isDirectory()) out.dirs.push({ name: ent.name, path: full });
      else if (ent.isFile()) out.files.push({ name: ent.name, path: full });
    }
  } catch (_) { /* missing / unreadable folder */ }
  out.dirs.sort((a, b) => a.name.localeCompare(b.name));
  out.files.sort((a, b) => a.name.localeCompare(b.name));
  return out;
});

ipcMain.handle('base:scan', async (e, { ffprobePath, dir, mode, depth, watch }) => {
  const extSet = mode === 'audio' ? AUDIO_EXT : MEDIA_EXT;
  // `depth` 0 = this folder only (breadcrumb navigation); the default keeps the
  // legacy recursive scan for callers that don't pass it.
  const maxDepth = Number.isFinite(depth) ? Math.max(0, depth) : 3;
  const files = fs.existsSync(dir) ? await walkDir(dir, 0, [], maxDepth, 600, extSet) : [];
  const send = (p) => { try { e.sender.send('scan:progress', p); } catch (_) {} };
  const total = files.length;
  send({ dir, done: 0, total });
  // Probe in bounded parallel batches; progress still ticks as each settles.
  let done2 = 0;
  const settled = await Promise.all(files.map((f) =>
    workLimiter(async () => {
      let item = null;
      try {
        const info = await probe(ffprobePath || DEFAULT_FFPROBE, f);
        info.name = path.basename(f);
        item = info;
      } catch (_) { /* skip unreadable */ }
      done2 += 1;
      if (done2 % 5 === 0 || done2 === total) send({ dir, done: done2, total });
      return item;
    })
  ));
  const items = settled.filter(Boolean);
  items.sort((a, b) => a.name.localeCompare(b.name));
  if (watch) ensureWatch(dir);
  return { dir, mode: mode || 'video', items };
});

ipcMain.handle('base:thumbnail', async (_e, { ffmpegPath, file, maxW }) => {
  try {
    const st = fs.statSync(file);
    const w = Math.max(64, Math.min(640, maxW || 320));
    const key = thumbKeyFor(file, st.mtimeMs, st.size, w);
    const cachedPath = thumbCache.get(key);
    if (cachedPath && fs.existsSync(cachedPath)) return { ok: true, file: cachedPath, key };
    // Single-flight: identical requests share one generation instead of re-decoding.
    if (thumbInflight.has(key)) return thumbInflight.get(key);
    const p = thumbLimiter(async () => {
      if (thumbCache.has(key)) {
        const c = thumbCache.get(key);
        if (c && fs.existsSync(c)) return { ok: true, file: c, key };
        thumbCache.delete(key);
      }
      const dir = thumbDir();
      fs.mkdirSync(dir, { recursive: true });
      const out = path.join(dir, key);
      const tmp = out + '.tmp' + process.pid + Date.now().toString(36);
      const baseArgs = [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-threads', '1', '-filter_threads', '1',
        '-ss', '0.2', '-i', file,
        '-frames:v', '1', '-an', '-vf', `scale=${w}:-2`, '-q:v', '4', tmp,
      ];
      // Try hardware decode first; ffmpeg does NOT fall back to software inside a
      // single run, so re-run without -hwaccel when a HW decode fails for a file.
      let r = await run(ffmpegPath || DEFAULT_FFMPEG, ['-hwaccel', 'auto', ...baseArgs]);
      if (r.code !== 0) {
        r = await run(ffmpegPath || DEFAULT_FFMPEG, baseArgs);
      }
      if (r.code !== 0) {
        try { fs.rmSync(tmp, { force: true }); } catch (_) {}
        return { ok: false, error: r.err.slice(-500) || 'thumbnail failed' };
      }
      // Write-rename keeps a partial decode from ever being served.
      try {
        fs.renameSync(tmp, out);
      } catch (_) {
        try { fs.rmSync(tmp, { force: true }); } catch (_) {}
        if (!fs.existsSync(out)) return { ok: false, error: 'thumbnail write failed' };
      }
      thumbCache.set(key, out);
      if (thumbCache.size > 2000) {
        const keys = thumbCache.keys();
        thumbCache.delete(keys.next().value);
      }
      return { ok: true, file: out, key };
    });
    thumbInflight.set(key, p);
    p.finally(() => thumbInflight.delete(key)).catch(() => {});
    return p;
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

ipcMain.handle('preview:get', async (_e, { ffmpegPath, ffprobePath, file }) => {
  try {
    if (!file || !MEDIA_EXT.has(path.extname(file).toLowerCase())) return { ok: false, error: 'not media' };
    const st = fs.statSync(file);
    const key = previewKeyFor(file, st.mtimeMs, st.size);
    const disk = path.join(previewDir(), key);
    if (fs.existsSync(disk)) { previewCache.set(key, disk); return { ok: true, ready: true, file: disk, original: file, key }; }
    const cached = previewCache.get(key);
    if (cached && fs.existsSync(cached)) return { ok: true, ready: true, file: cached, original: file, key };
    // Single-flight: identical requests share one background build.
    if (previewInflight.has(key)) return { ok: true, ready: false, file: null, original: file, key };
    const p = previewLimiter(() => buildPreviewCopy(ffmpegPath, ffprobePath, file, key));
    previewInflight.set(key, p);
    p.then((res) => {
      if (res && res.ok && win && !win.isDestroyed()) {
        try { win.webContents.send('preview:done', { original: file, file: res.file, key }); } catch (_) {}
      }
    }).catch(() => {}).finally(() => previewInflight.delete(key));
    return { ok: true, ready: false, file: null, original: file, key };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});
