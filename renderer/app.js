const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const PAD = 56; // px for the left track label column
const MIN_LEN = 0.05;
const SNAP_PX = 10;
const PREROLL = 20; // fixed seconds of pre-roll runway left of 0:00 (editing-only)
// Free forward runway: the playhead can wander up to this far past the content
// (and past 0:00 on an empty timeline). Single constant — bump it for more room.
const PLAY_TAIL = 180;
// Distance bands: pale tints on the timeline so you can tell "how far in" you are.
const TIME_WARN = 60;   // from here: pale orange
const TIME_DANGER = 120; // from here: pale red

const BIN_KEYS = ['media', 'transitions', 'sounds'];
const BIN_MODE = { media: 'media', transitions: 'video', sounds: 'audio' };

// Built-in camera effects (the Effects panel; drag onto a MAIN/ALT lane).
const EFFECT_DEFS = [
  { defId: 'zoom-in', name: 'Zoom In', type: 'zoom', to: { z: 1.4, cx: 0.5, cy: 0.5 } },
  { defId: 'zoom-out', name: 'Zoom Out', type: 'zoom', from: { z: 1.4, cx: 0.5, cy: 0.5 }, to: { z: 1, cx: 0.5, cy: 0.5 } },
  { defId: 'shake', name: 'Shake', type: 'shake', amp: 0.04, freq: 20, decay: true, axes: 'both' },
];
const EFFECT_DUR_DEFAULT = 3; // seconds a freshly dropped effect spans
const STILL_DEFAULT = 3;     // seconds an image/freeze starts at; can be trimmed longer
const STILL_MAX = 3600;      // virtual source ceiling for still trim handles
const FREEZE_LEN = 3;        // seconds a freeze frame inserts

const state = {
  timeline: [],   // [{ id, path, name, start, srcStart, srcEnd, duration, mute, ...meta }]
  soundboard: [], // [{ id, path, name, duration, srcStart, srcEnd, endTime, startTime, volume }]
  hybrid: [],     // CLIPS2 lane: items are clip-like (kind:'clip', start) or sound-like (kind:'sound', startTime)
  markers: [],    // [{ id, time, label }]
  // Camera effects (adjustment layers): { id, type, name, lane, start, dur,
  // from:{z,cx,cy}, to:{z,cx,cy}, ease, bg }. They overlay a video lane and warp
  // the visible output during their span.
  effects: [],
  ratings: new Map(), // normalized path / effect:<id> -> 1..5 stars
  bins: {
    media: { root: '', cwd: '', crumbs: [], dirs: [], items: [], selected: new Set(), cache: new Map(), loading: false, epoch: 0 },
    transitions: { root: '', cwd: '', crumbs: [], dirs: [], items: [], selected: new Set(), cache: new Map(), loading: false, epoch: 0 },
    sounds: { root: '', cwd: '', crumbs: [], dirs: [], items: [], selected: new Set(), cache: new Map(), loading: false, epoch: 0 },
  },
  selectedIds: new Set(),     // selected timeline clip ids (Ctrl/Cmd+click to add)
  selectedSbs: new Set(),     // selected soundboard ids
  selectedHyb: new Set(),     // selected CLIPS2 lane ids
  selectedEff: new Set(),     // selected effect ids
  selectedMarkers: new Set(), // selected marker ids
  selectedGaps: [],           // selected empty spans on the Clips track [{ start, end }]
  nav: { dir: 0, timer: null, mode: null, raf: 0 }, // A/D hold-to-play walk state
  effectPose: 'to',   // which pose the preview scroll/drag edits: 'from'|'to'
  showEffects: true,  // FX visibility toggle (hide bands to reach clips behind)
  playhead: 0,
  pps: 90,
  playing: false,
  snap: true,
  encoders: [],
  mediaExt: [],
  audioExt: [],
  imageExt: [],
  settings: {
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    outputDir: '',
    baseDir: '',
    transitionDir: '',
    soundsDir: '',
    width: 1080,
    height: 1920,
    fps: 60,
    encoder: 'libx264',
    normalizeAudio: false,
    autoSave: false,
    autoSaveMinutes: 5,
  },
  projectFile: null,
  exporting: false,
  // Viewer surface: 'program' = the timeline output; 'media' = a single bin
  // clip previewed with its own transport. `split` shows both side by side.
  viewer: { mode: 'program', split: false, mediaPath: null },
};

const keyCache = new Map();
const thumbCache = new Map();
const waveCache = new Map();
const binObservers = { media: null, transitions: null, sounds: null };

// Bounded FIFO cache insert — each cache stays within `cap` entries so long
// sessions don't creep in memory.
function cappedSet(map, key, value, cap) {
  map.set(key, value);
  if (map.size > cap) map.delete(map.keys().next().value);
}

// Drag-and-drop of bin tiles: a mid-drag renderBin() rebuild detaches the tile
// being dragged (Chromium then cancels the drag), so rebuilds are deferred while
// a bin drag is active. pendingDrag lets the drop position show an accurate
// length ghost without reading dataTransfer back.
let binDragActive = false;
const pendingBinRender = new Set();
let pendingDrag = null; // { kind, items } while a bin tile drag is in flight

// Transparent native drag image so Chromium draws nothing at the cursor — the
// visible feedback is our own: a floating tile clone off the timeline, and the
// name chip above the ghost on the timeline.
let emptyDragImg = null;
function emptyDragImage() {
  if (!emptyDragImg) {
    emptyDragImg = document.createElement('canvas');
    emptyDragImg.width = 1; emptyDragImg.height = 1;
    emptyDragImg.style.cssText = 'position:fixed;top:-1000px;left:-1000px;pointer-events:none;';
    document.body.appendChild(emptyDragImg);
  }
  return emptyDragImg;
}
// Chip text: the name for one item, a count for a multi-drag. null for paste.
function dragChipLabel() {
  if (!pendingDrag || pendingDrag.paste) return null;
  const items = pendingDrag.items || [];
  if (!items.length) return null;
  return items.length > 1 ? `${items.length} items` : (items[0].name || 'item');
}
// Floating clone of the source tile, shown while the pointer is off the timeline.
let dragCardEl = null, dragGrabDX = 0, dragGrabDY = 0;
function buildDragCard(card, e, count) {
  removeDragCard();
  const r = card.getBoundingClientRect();
  dragGrabDX = e.clientX - r.left; // keep the exact grab point under the cursor
  dragGrabDY = e.clientY - r.top;
  dragCardEl = card.cloneNode(true);
  dragCardEl.classList.add('drag-card-float');
  dragCardEl.draggable = false;
  dragCardEl.style.width = r.width + 'px';
  if (count > 1) {
    const badge = document.createElement('div');
    badge.className = 'drag-card-badge';
    badge.textContent = count;
    dragCardEl.appendChild(badge);
  }
  document.body.appendChild(dragCardEl);
  moveDragCard(e);
}
function moveDragCard(e) {
  if (!dragCardEl) return;
  dragCardEl.style.left = (e.clientX - dragGrabDX) + 'px';
  dragCardEl.style.top = (e.clientY - dragGrabDY) + 'px';
}
function showDragCard() { if (dragCardEl) dragCardEl.style.display = ''; }
function hideDragCard() { if (dragCardEl) dragCardEl.style.display = 'none'; }
function removeDragCard() { if (dragCardEl) { dragCardEl.remove(); dragCardEl = null; } }

// Clipboard for Ctrl+C/X/V. Items are deep clones tagged with `_kind`
// ('clip' | 'sound') so a paste can be routed to the lane under the pointer.
let clipboard = { items: [] };
let pastePending = null; // { items } while a paste awaits a placement click

let idSeq = 1;
const newId = () => 'c' + Date.now().toString(36) + (idSeq++).toString(36);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[m]));
}

function fmt(sec) {
  if (!isFinite(sec)) sec = 0;
  const sign = sec < -1e-9 ? '-' : '';
  sec = Math.abs(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = s.toFixed(3).padStart(6, '0');
  return sign + (h > 0 ? `${h}:` : '') + `${String(m).padStart(2, '0')}:${ss}`;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Timeline coordinate mapping. Everything is shifted right by the fixed
// pre-roll runway, so time -PREROLL sits at the far left edge of the content.
const timeToX = (t) => PAD + (t + PREROLL) * state.pps; // ruler / markers / playhead / guide (in #tl-inner)
const laneX = (t) => (t + PREROLL) * state.pps;         // clips / sounds / gaps (in .tl-track-body)

/* ---------------- model helpers ---------------- */
const speedOf = (item) => item.speed || 1;
function durOf(item) { return (item.srcEnd - item.srcStart) / speedOf(item); }
function sndDur(s) {
  if (s.srcEnd != null) return Math.max(0, s.srcEnd - (s.srcStart || 0));
  return s.endTime != null ? s.endTime : (s.duration || 0);
}
function totalDuration() {
  let m = 0;
  for (const it of state.timeline) m = Math.max(m, (it.start || 0) + durOf(it));
  for (const s of state.soundboard) m = Math.max(m, (s.startTime || 0) + sndDur(s));
  for (const h of state.hybrid) m = Math.max(m, hybStartOf(h) + hybDurOf(h));
  return m;
}
// Upper playhead bound: content end plus the free forward runway.
function playheadMax() { return Math.max(totalDuration(), 0) + PLAY_TAIL; }

// A clip counts as "edited" when any per-clip override differs from its default
// (framing, speed, mute — and the upcoming volume). Painted as a small dot so
// you can see at a glance which cuts differ from the source.
function isClipEdited(item) {
  if (!item) return false;
  if (item.fit && item.fit !== 'blur') return true;
  if (Math.abs(speedOf(item) - 1) > 1e-6) return true;
  if (item.mute) return true;
  if (item.volume != null && Math.abs(item.volume) > 0.01) return true;
  return false;
}

// Linear timeline gain → dB (legacy projects stored a linear multiplier).
const linToDb = (lin) => 20 * Math.log10(Math.max(lin, 1e-6));

// Human labels for the tiny "morph info" strip drawn on top of a cut.
function editTags(item) {
  const t = [];
  const sp = speedOf(item);
  if (Math.abs(sp - 1) > 1e-6) t.push(`${sp}×`);
  const v = item.volume || 0;
  if (Math.abs(v) > 0.01) t.push(`${v > 0 ? '+' : ''}${v} dB`);
  if (item.fit && item.fit !== 'blur') t.push('frame');
  return t;
}
function getOverlapIds() {
  const ids = new Set();
  const markSmaller = (a, b, dur) => {
    if (dur(a) <= dur(b)) ids.add(a.id); else ids.add(b.id);
  };
  for (const [a, b] of TimelineOps.findOverlaps(state.timeline, (it) => it.start || 0, durOf)) markSmaller(a, b, durOf);
  for (const [a, b] of TimelineOps.findOverlaps(state.hybrid.filter((h) => h.kind !== 'sound'), (it) => it.start || 0, durOf)) markSmaller(a, b, durOf);
  for (const [a, b] of TimelineOps.findOverlaps(state.hybrid.filter((h) => h.kind === 'sound'), hybStartOf, hybDurOf)) markSmaller(a, b, hybDurOf);
  for (const [a, b] of TimelineOps.findOverlaps(state.soundboard, (s) => s.startTime || 0, sndDur)) markSmaller(a, b, sndDur);
  return ids;
}

function sortTrack() { state.timeline.sort((a, b) => (a.start || 0) - (b.start || 0)); }
function arrangeTrack() {
  sortTrack();
  if (!state.timeline.length) return;
  let prevEnd = (state.timeline[0].start || 0) + durOf(state.timeline[0]);
  for (let i = 1; i < state.timeline.length; i++) {
    const it = state.timeline[i];
    if ((it.start || 0) < prevEnd) it.start = prevEnd;
    prevEnd = (it.start || 0) + durOf(it);
  }
}
function sortHybridClips() {
  const clips = state.hybrid.filter((h) => h.kind !== 'sound');
  clips.sort((a, b) => (a.start || 0) - (b.start || 0));
  const sounds = state.hybrid.filter((h) => h.kind === 'sound');
  sounds.sort((a, b) => hybStartOf(a) - hybStartOf(b));
  state.hybrid = [...sounds, ...clips];
}
function arrangeHybridClips() {
  const clips = state.hybrid.filter((h) => h.kind !== 'sound').sort((a, b) => (a.start || 0) - (b.start || 0));
  if (!clips.length) return;
  let prevEnd = (clips[0].start || 0) + durOf(clips[0]);
  for (let i = 1; i < clips.length; i++) {
    const it = clips[i];
    if ((it.start || 0) < prevEnd) it.start = prevEnd;
    prevEnd = (it.start || 0) + durOf(it);
  }
}

// Priority-resolved visible video plan (MAIN beats ALT). Each entry is a
// continuous visible span of one source clip: { item, lane, start, end, srcStart, srcEnd }.
function videoSegments() {
  return TimelineOps.visibleSegments(
    state.timeline,
    state.hybrid.filter((h) => h.kind !== 'sound'),
  );
}

// Which segment is on screen at time t (null inside a no-footage gap).
function segmentAt(t) {
  const segs = videoSegments();
  for (let i = 0; i < segs.length; i++) {
    if (t >= segs[i].start - 1e-6 && t < segs[i].end - 1e-6) return { index: i, seg: segs[i] };
  }
  return null;
}

function visibleVideoAt(t) {
  const hit = segmentAt(t);
  if (!hit) return null;
  const s = hit.seg;
  return { index: hit.index, item: s.item, seg: s, lane: s.lane, local: t - s.start };
}
function indexOfId(id) { return state.timeline.findIndex((c) => c.id === id); }

function setStatus(msg) { $('#status-msg').textContent = msg; }
function setProgress(ratio) {
  $('#progress-fill').style.width = Math.max(0, Math.min(1, ratio)) * 100 + '%';
  updateEta(ratio);
}

// "≈ M:SS left" estimated from elapsed wall time + current ratio.
function updateEta(ratio) {
  const el = $('#progress-eta');
  if (!el) return;
  if (ratio == null || ratio < 0.02 || ratio >= 0.999 || !exportStartT) { el.textContent = ''; return; }
  const elapsed = (Date.now() - exportStartT) / 1000;
  const eta = Math.max(0, (elapsed / ratio) * (1 - ratio));
  const s = Math.round(eta);
  el.textContent = `≈ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} left`;
}
function showEta(ratio) { updateEta(ratio); }

/* ---------------- layout: portrait (bins on top) / landscape (bins on the sides) ---------------- */
const LAYOUT_KEY = 'cm_layout';
function currentLayout() {
  return localStorage.getItem(LAYOUT_KEY) === 'landscape' ? 'landscape' : 'portrait';
}
function applyLayout(mode) {
  $('#main').classList.toggle('layout-landscape', mode === 'landscape');
  document.querySelectorAll('#layout-toggle .seg-btn').forEach((b) => {
    b.classList.toggle('on', b.dataset.layout === mode);
  });
  applyBinSizes();
}
function setLayout(mode) {
  localStorage.setItem(LAYOUT_KEY, mode === 'landscape' ? 'landscape' : 'portrait');
  applyLayout(mode);
  updateScrollbar();
}

/* ---------------- resizable bins (horizontal widths only) ----------------
   Drag the vertical dividers between bins to widen one and squeeze the others.
   Widths persist per layout (portrait / landscape) in localStorage. */
const BIN_SIZES_KEY = 'cm_binsizes';
let binSizes = {
  portrait: { mediaW: 0, transW: 0, soundW: 0 },
  landscape: { leftW: 260, rightW: 260 },
};
let binSplitDrag = null;

function isLandscapeLayout() { const m = $('#main'); return !!(m && m.classList.contains('layout-landscape')); }
function binEl(key) { return document.querySelector(`.bin[data-bin="${key}"]`); }

function loadBinSizes() {
  try {
    const raw = localStorage.getItem(BIN_SIZES_KEY);
    if (!raw) return;
    const o = JSON.parse(raw);
    if (o && o.portrait && o.landscape) {
      binSizes.portrait = { mediaW: o.portrait.mediaW || 0, transW: o.portrait.transW || 0, soundW: o.portrait.soundW || 0 };
      binSizes.landscape = { leftW: o.landscape.leftW || 260, rightW: o.landscape.rightW || 260 };
    }
  } catch (_) {}
}
function saveBinSizes() { try { localStorage.setItem(BIN_SIZES_KEY, JSON.stringify(binSizes)); } catch (_) {} }

function ensureBinSplitters() {
  const main = $('#main');
  if (!main) return [];
  let wrap = document.getElementById('bin-splitters');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'bin-splitters';
    main.appendChild(wrap);
  }
  while (wrap.children.length < 3) {
    const s = document.createElement('div');
    s.className = 'bin-splitter';
    s.dataset.i = String(wrap.children.length);
    s.addEventListener('pointerdown', onBinSplitDown);
    wrap.appendChild(s);
  }
  return [...wrap.children];
}

function onBinSplitDown(e) {
  e.preventDefault();
  const main = $('#main');
  if (!main) return;
  const mr = main.getBoundingClientRect();
  binSplitDrag = {
    i: Number(e.currentTarget.dataset.i), land: isLandscapeLayout(), left: mr.left, width: mr.width,
    mediaW0: binSizes.portrait.mediaW, transW0: binSizes.portrait.transW, soundW0: binSizes.portrait.soundW,
  };
  e.currentTarget.classList.add('dragging');
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
  window.addEventListener('pointermove', onBinSplitMove);
  window.addEventListener('pointerup', onBinSplitUp, { once: true });
}

function onBinSplitMove(e) {
  const d = binSplitDrag;
  if (!d) return;
  const x = e.clientX - d.left;
  const W = d.width;
  if (d.land) {
    if (d.i === 0) binSizes.landscape.leftW = Math.round(clamp(x, 120, Math.max(140, W - binSizes.landscape.rightW - 160)));
    else binSizes.landscape.rightW = Math.round(clamp(W - x, 120, Math.max(140, W - binSizes.landscape.leftW - 160)));
    applyBinSizes();
    return;
  }
  const mediaW = d.mediaW0;
  if (d.i === 0) {
    binSizes.portrait.mediaW = Math.round(clamp(x, 110, Math.max(130, W - 260)));
  } else if (d.i === 1) {
    // Divider between Transitions and Sounds: they squeeze each other.
    const newTrans = Math.round(clamp(x - mediaW, 90, Math.max(100, W - mediaW - 180)));
    const delta = newTrans - d.transW0;
    const newSound = Math.round(clamp(d.soundW0 - delta, 90, Math.max(100, W - mediaW - newTrans - 100)));
    binSizes.portrait.transW = newTrans;
    binSizes.portrait.soundW = newSound;
  } else {
    binSizes.portrait.soundW = Math.round(clamp(x - mediaW - d.transW0, 90, Math.max(100, W - mediaW - d.transW0 - 100)));
  }
  applyBinSizes();
}

function onBinSplitUp() {
  const sp = document.querySelector('.bin-splitter.dragging');
  if (sp) sp.classList.remove('dragging');
  window.removeEventListener('pointermove', onBinSplitMove);
  binSplitDrag = null;
  saveBinSizes();
}

function positionBinSplitters() {
  const main = $('#main');
  if (!main) return;
  const splitters = ensureBinSplitters();
  if (!splitters.length) return;
  const media = binEl('media'), trans = binEl('transitions'), sound = binEl('sounds'), eff = binEl('effects');
  if (!media || !trans || !sound || !eff) return;
  const mr = main.getBoundingClientRect();
  const rm = media.getBoundingClientRect();
  const rt = trans.getBoundingClientRect();
  const rs = sound.getBoundingClientRect();
  const re = eff.getBoundingClientRect();
  const top = rm.top - mr.top;
  const h = rm.height;
  const place = (el, x) => {
    el.style.display = '';
    el.style.left = (x - 3) + 'px';
    el.style.top = top + 'px';
    el.style.height = h + 'px';
  };
  if (isLandscapeLayout()) {
    place(splitters[0], rm.right - mr.left);
    place(splitters[1], re.left - mr.left);
    splitters[2].style.display = 'none';
  } else {
    place(splitters[0], rm.right - mr.left);
    place(splitters[1], rt.right - mr.left);
    place(splitters[2], rs.right - mr.left);
  }
}

function applyBinSizes() {
  const main = $('#main');
  if (!main) return;
  const W = main.clientWidth || 1200;
  if (isLandscapeLayout()) {
    const leftW = Math.round(clamp(binSizes.landscape.leftW || 260, 120, Math.max(140, W - 200)));
    const rightW = Math.round(clamp(binSizes.landscape.rightW || 260, 120, Math.max(140, W - leftW - 160)));
    binSizes.landscape.leftW = leftW;
    binSizes.landscape.rightW = rightW;
    main.style.gridTemplateColumns = `${leftW}px minmax(0,1fr) ${rightW}px`;
    for (const k of ['media', 'transitions', 'sounds', 'effects']) {
      const el = binEl(k);
      if (el) el.style.flex = '';
    }
  } else {
    const mediaW = Math.round(clamp(binSizes.portrait.mediaW || W * 0.34, 110, Math.max(130, W - 260)));
    const rest = Math.max(120, W - mediaW);
    const transW = Math.round(clamp(binSizes.portrait.transW || rest / 3, 90, Math.max(100, rest - 180)));
    const soundW = Math.round(clamp(binSizes.portrait.soundW || rest / 3, 90, Math.max(100, rest - transW - 100)));
    binSizes.portrait.mediaW = mediaW;
    binSizes.portrait.transW = transW;
    binSizes.portrait.soundW = soundW;
    main.style.gridTemplateColumns = `${mediaW}px minmax(0,1fr)`;
    const setFlex = (key, v) => {
      const el = binEl(key);
      if (!el) return;
      el.style.flex = el.classList.contains('collapsed') ? '' : v;
    };
    setFlex('media', '');
    setFlex('transitions', `0 0 ${transW}px`);
    setFlex('sounds', `0 0 ${soundW}px`);
    setFlex('effects', '1 1 0');
  }
  positionBinSplitters();
}

/* ---------------- persistence of settings ---------------- */
const SETTINGS_KEY = 'cm_settings';
const PERSISTED_SETTING_KEYS = [
  'ffmpegPath', 'ffprobePath', 'outputDir', 'baseDir', 'transitionDir',
  'soundsDir', 'width', 'height', 'fps', 'encoder', 'normalizeAudio',
  'autoSave', 'autoSaveMinutes',
];

function loadSavedSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : null;
  } catch (_) { return null; }
}

function persistSettings() {
  try {
    const out = {};
    for (const k of PERSISTED_SETTING_KEYS) out[k] = state.settings[k];
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(out));
    if (api.settingsSet) api.settingsSet(out);
  } catch (_) { /* storage unavailable */ }
}

/* ---------------- bootstrap ---------------- */
async function init() {
  loadBinSizes();
  applyLayout(currentLayout());
  try { state.viewer.split = localStorage.getItem('cm_viewer_split') === '1'; } catch (_) {}
  const info = await api.init({});
  state.encoders = info.encoders || [];
  state.mediaExt = info.mediaExt || [];
  state.audioExt = info.audioExt || [];
  state.imageExt = info.imageExt || [];
  Object.assign(state.settings, info.defaults || {});

  // Restore last-used settings (paths, folders, output, encoder, …) over defaults.
  // The main-process store wins; localStorage is kept as a legacy fallback.
  const saved = (info && info.saved) || loadSavedSettings();
  const hadSavedEncoder = !!(saved && saved.encoder);
  if (saved) Object.assign(state.settings, saved);

  // Only fall back to the auto-detected encoder when the user hasn't picked one.
  if (info.preferred && !hadSavedEncoder) state.settings.encoder = info.preferred;
  if (state.encoders.length && !state.encoders.some((e) => e.id === state.settings.encoder)) {
    state.settings.encoder = info.preferred || state.encoders[0].id;
  }

  const enc = state.encoders.find((e) => e.id === state.settings.encoder);
  $('#encoder-label').textContent = enc ? `Encoder: ${enc.label}` : '';

  await loadLibrary();
  renderAll();
  wireEvents();
  wireHotkeys();
  updateViewerClasses();
  refreshAllBins();
  showStartView();
  persistSettings();
  setStatus('Ready');
}

function renderAll() {
  renderTimeline();
  updateToolbar();
}

/* ---------------- keyframes ---------------- */
// Keyframe lookups resolve asynchronously all around the same time; coalesce
// the repaint so N fetches don't rebuild the timeline N times.
let kfPaintTimer = null;
const kfInflight = new Map();
function scheduleKfPaint() {
  if (kfPaintTimer) return;
  kfPaintTimer = setTimeout(() => { kfPaintTimer = null; renderTimeline(); }, 50);
}

async function getKeyframesAsync(path) {
  if (keyCache.has(path)) return keyCache.get(path);
  if (kfInflight.has(path)) return kfInflight.get(path);
  const p = (async () => {
    const res = await api.getKeyframes({ ffprobePath: state.settings.ffprobePath, file: path });
    const times = res && !res.error ? res.times : [];
    cappedSet(keyCache, path, times, 500);
    kfInflight.delete(path);
    scheduleKfPaint();
    return times;
  })();
  kfInflight.set(path, p);
  return p;
}

/* ---------------- waveform ---------------- */
async function getWaveform(item) {
  const key = `${item.path}|${item.srcStart || 0}|${item.srcEnd != null ? item.srcEnd : (item.endTime != null ? item.endTime : item.duration)}`;
  if (waveCache.has(key)) return waveCache.get(key);
  const res = await api.waveform({
    ffmpegPath: state.settings.ffmpegPath,
    file: item.path,
    srcStart: item.srcStart || 0,
    srcEnd: item.srcEnd != null ? item.srcEnd : (item.endTime != null ? item.endTime : item.duration),
    points: 180,
  });
  const peaks = res && res.ok ? res.peaks : null;
  cappedSet(waveCache, key, peaks, 300);
  return peaks;
}

/* ---------------- bins ---------------- */
function binDir(key) {
  return key === 'media' ? state.settings.baseDir
    : key === 'transitions' ? state.settings.transitionDir
    : state.settings.soundsDir;
}

function pathBase(p) {
  if (!p) return '';
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p);
}

// Breadcrumb trail from the bin root down to `dir` (both absolute paths).
function crumbsFor(root, dir) {
  if (!dir) return [];
  const norm = (s) => String(s || '').replace(/[\\/]+$/, '');
  const r = norm(root);
  const d = norm(dir);
  const within = r && (d === r || d.startsWith(r + '\\') || d.startsWith(r + '/'));
  if (!within) return [{ name: pathBase(d) || d, path: dir }];
  const sep = d.includes('\\') ? '\\' : '/';
  const out = [{ name: pathBase(r) || r, path: root }];
  if (d === r) return out;
  let acc = r;
  for (const seg of d.slice(r.length + 1).split(/[\\/]/).filter(Boolean)) {
    acc += sep + seg;
    out.push({ name: seg, path: acc });
  }
  return out;
}

// Load one folder into a bin: a cheap subfolder listing, then probe (or reuse a
// cached scan of) THAT folder's media only. Folders you never open are never
// scanned, so opening a bin stays fast.
async function loadBinFolder(key, dir, watch) {
  const bin = state.bins[key];
  bin.root = binDir(key);
  bin.cwd = dir || '';
  bin.dir = bin.cwd;
  bin.crumbs = crumbsFor(bin.root, bin.cwd);
  bin.dirs = [];
  const epoch = ++bin.epoch;
  if (!dir) { bin.items = []; bin.loading = false; renderBin(key); return; }

  const cached = bin.cache.get(dir);
  bin.items = cached || [];
  bin.loading = !cached;
  renderBin(key);

  let listing = null;
  try { listing = await api.listDir({ dir }); } catch (_) {}
  if (bin.epoch !== epoch) return;
  bin.dirs = (listing && listing.dirs) || [];
  if (cached) { renderBin(key); return; }

  let items = [];
  try {
    const res = await api.scanBase({ dir, mode: BIN_MODE[key], depth: 0, watch: !!watch });
    items = (res && res.items) || [];
  } catch (_) { items = []; }
  if (bin.epoch !== epoch) return;
  cappedSet(bin.cache, dir, items, 60);
  bin.items = items;
  bin.loading = false;
  renderBin(key);
}

async function refreshBin(key) {
  const bin = state.bins[key];
  bin.root = binDir(key);
  bin.cache.clear();
  await loadBinFolder(key, bin.root, true);
}

function refreshAllBins() { BIN_KEYS.forEach((k) => refreshBin(k)); }

// Re-scan whatever folders are currently open (used by the file watcher).
function refreshLoadedBins() {
  keyCache.clear(); // a watched file may have been replaced in place
  for (const key of BIN_KEYS) {
    const bin = state.bins[key];
    if (!bin.cwd) continue;
    bin.cache.clear();
    loadBinFolder(key, bin.cwd);
  }
}

function selectedBinItems(key) {
  const b = state.bins[key];
  return b.items.filter((x) => b.selected.has(x.path));
}

// Leading '!' characters mark a clip's importance: ! = 1 star, !! = 2, etc.
function starsOf(name) {
  const m = /^!+/.exec(name || '');
  return m ? m[0].length : 0;
}

/* ---------------- favorites / shared context menu ---------------- */
function libKey(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}
function effectLibKey(defId) { return libKey('effect:' + defId); }
function ratingOf(key) { return state.ratings.get(libKey(key)) || 0; }
function ratingForItem(item) { return ratingOf(item.path); }

async function loadLibrary() {
  try {
    const res = await api.libraryGet();
    if (res && res.ok && res.ratings) state.ratings = new Map(Object.entries(res.ratings));
  } catch (_) { /* ratings are optional */ }
}

async function setRating(key, stars) {
  const k = libKey(key);
  const prev = state.ratings.get(k) || 0;
  if (stars > 0) state.ratings.set(k, stars);
  else state.ratings.delete(k);
  try {
    const res = await api.librarySet({ key: k, stars });
    if (!res || !res.ok) throw new Error((res && res.error) || 'rating save failed');
    if (res.ratings) state.ratings = new Map(Object.entries(res.ratings));
    return true;
  } catch (err) {
    if (prev > 0) state.ratings.set(k, prev);
    else state.ratings.delete(k);
    toast('Could not save favorite', { danger: true });
    console.error('LIBRARY_SAVE_ERR', err);
    return false;
  }
}

function closeContextMenu() {
  const el = $('#ctx-menu');
  if (!el) return;
  el.classList.add('hidden');
  el.innerHTML = '';
}

function openContextMenu(opts) {
  const el = $('#ctx-menu');
  if (!el) return;
  el.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'ctx-title';
  head.textContent = opts.title || '';
  el.appendChild(head);

  const row = document.createElement('div');
  row.className = 'ctx-stars';
  for (let i = 1; i <= 5; i++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctx-star' + (i <= (opts.rating || 0) ? ' on' : '');
    b.textContent = '★';
    b.title = `${i} star${i === 1 ? '' : 's'}`;
    b.setAttribute('aria-label', b.title);
    b.addEventListener('click', () => { closeContextMenu(); opts.onRate(i); });
    row.appendChild(b);
  }
  el.appendChild(row);

  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'ctx-item';
  clear.textContent = 'Clear rating';
  clear.disabled = !opts.rating;
  clear.addEventListener('click', () => { closeContextMenu(); opts.onRate(0); });
  el.appendChild(clear);

  if (opts.onReveal) {
    const sep = document.createElement('div');
    sep.className = 'ctx-sep';
    el.appendChild(sep);
    const rev = document.createElement('button');
    rev.type = 'button';
    rev.className = 'ctx-item';
    rev.textContent = 'Reveal in folder';
    rev.addEventListener('click', () => { closeContextMenu(); opts.onReveal(); });
    el.appendChild(rev);
  }

  el.classList.remove('hidden');
  el.style.left = '0px';
  el.style.top = '0px';
  const r = el.getBoundingClientRect();
  const x = Math.max(4, Math.min(opts.x || 0, window.innerWidth - r.width - 6));
  const y = Math.max(4, Math.min(opts.y || 0, window.innerHeight - r.height - 6));
  el.style.left = x + 'px';
  el.style.top = y + 'px';
}

function paintBinSelection(key) {
  const bin = state.bins[key];
  const section = $(`.bin[data-bin="${key}"]`);
  $$('.base-item', section).forEach((el) => {
    el.classList.toggle('selected', bin.selected.has(el.dataset.path));
  });
}

function renderBin(key) {
  if (binDragActive) { pendingBinRender.add(key); return; }
  const bin = state.bins[key];
  const section = $(`.bin[data-bin="${key}"]`);
  if (!section) return;
  const list = $('[data-role="list"]', section);
  const crumbsEl = $('[data-role="crumbs"]', section);
  const sub = $('[data-role="sub"]', section);
  if (binObservers[key]) { binObservers[key].disconnect(); binObservers[key] = null; }
  const root = bin.root || bin.dir || '';
  const crumbs = bin.crumbs || [];
  const dirs = (bin.dirs || []).slice();
  if (key === 'media') {
    // The user's IMAGES folder is their stills library — pin it to the top.
    dirs.sort((a, b) => {
      const ai = String(a.name).toUpperCase() === 'IMAGES' ? 0 : 1;
      const bi = String(b.name).toUpperCase() === 'IMAGES' ? 0 : 1;
      return ai - bi || String(a.name).localeCompare(String(b.name));
    });
  }

  // Breadcrumb trail
  if (crumbsEl) {
    crumbsEl.innerHTML = '';
    crumbsEl.classList.toggle('hidden', !root);
  }
  if (root && crumbsEl) {
    const idx = crumbs.findIndex((c) => c.path === bin.cwd);
    const up = document.createElement('button');
    up.type = 'button';
    up.className = 'crumb-up';
    up.title = 'Up one folder';
    up.disabled = idx <= 0;
    const upIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    upIcon.setAttribute('class', 'icon');
    upIcon.setAttribute('aria-hidden', 'true');
    const upUse = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    upUse.setAttribute('href', '#i-chev-up');
    upIcon.appendChild(upUse);
    up.appendChild(upIcon);
    up.addEventListener('click', () => { if (idx > 0) loadBinFolder(key, crumbs[idx - 1].path); });
    crumbsEl.appendChild(up);
    crumbs.forEach((c, i) => {
      if (i) {
        const s = document.createElement('span');
        s.className = 'crumb-sep'; s.textContent = '/';
        crumbsEl.appendChild(s);
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'crumb' + (i === crumbs.length - 1 ? ' current' : '');
      btn.textContent = c.name;
      btn.title = c.path;
      btn.addEventListener('click', () => { if (c.path !== bin.cwd) loadBinFolder(key, c.path); });
      crumbsEl.appendChild(btn);
    });
  }

  list.innerHTML = '';
  if (!root) {
    if (sub) sub.textContent = 'no folder';
    list.innerHTML = '<div class="bin-empty">Choose a folder with 📁</div>';
    return;
  }
  if (bin.loading) {
    if (sub) sub.textContent = 'scanning…';
    list.innerHTML = '<div class="bin-empty">⏳ Loading…</div>';
    return;
  }
  if (sub) sub.textContent = String(bin.items.length);

  // Subfolders first, as full-width rows.
  for (const d of dirs) {
    const row = document.createElement('div');
    row.className = 'bin-folder';
    row.innerHTML = '<span class="folder-ico"><svg class="icon" aria-hidden="true"><use href="#i-folder"></use></svg></span><span class="folder-name"></span>';
    $('.folder-name', row).textContent = d.name;
    row.title = d.path + '  (double-click to open)';
    row.addEventListener('dblclick', () => loadBinFolder(key, d.path));
    list.appendChild(row);
  }

  if (!bin.items.length && !dirs.length) {
    const empty = document.createElement('div');
    empty.className = 'bin-empty';
    empty.textContent = 'This folder is empty';
    list.appendChild(empty);
    return;
  }

  // Favorites first (most stars at the top), then legacy !-prefixed names, then name.
  const items = bin.items.slice().sort((a, b) => {
    const dr = ratingForItem(b) - ratingForItem(a);
    if (dr) return dr;
    const ds = starsOf(b.name) - starsOf(a.name);
    if (ds) return ds;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
  for (const item of items) renderBinCard(key, item, list);
}

function renderBinCard(key, item, list) {
  const bin = state.bins[key];
  const card = document.createElement('div');
  card.className = 'base-item' + (key === 'sounds' ? ' sound' : '')
    + (bin.selected.has(item.path) ? ' selected' : '');
  card.dataset.path = item.path;
  card.draggable = true;
  const meta = document.createElement('div');
  meta.className = 'bmeta';
  meta.innerHTML = `
    <div class="bname"></div>
    <div class="bdur">${fmt(item.duration || 0)}</div>`;
  $('.bname', meta).textContent = item.name;
  $('.bname', meta).title = item.name;
  if (key !== 'sounds') {
    const wrap = document.createElement('div');
    wrap.className = 'bthumb';
    const img = document.createElement('img');
    img.className = 'thumb placeholder';
    img.draggable = false; // the tile card is the drag source — not the thumb (file: URLs would native-drag the file)
    wrap.append(img);
    const n = starsOf(item.name);
    const rating = ratingForItem(item);
    if (rating || n) {
      const st = document.createElement('div');
      st.className = 'bstars';
      st.textContent = '★'.repeat(rating || Math.min(n, 5)); // cap so many ! can't overflow the small cards
      wrap.append(st);
    }
    card.append(wrap, meta);
    observeThumb(key, item, img);
  } else {
    // Sounds: compact row (name + duration) — no media thumbnail window.
    const icon = document.createElement('span');
    icon.className = 'sound-ico';
    icon.textContent = '♪';
    const rating = ratingForItem(item);
    if (rating) {
      const st = document.createElement('span');
      st.className = 'bmeta-stars';
      st.textContent = '★'.repeat(rating);
      meta.appendChild(st);
    }
    card.append(icon, meta);
  }

  card.addEventListener('click', (e) => {
    e.stopPropagation();
    // Ctrl/Cmd+click toggles membership; a plain click selects just this tile.
    if (e.ctrlKey || e.metaKey) {
      if (bin.selected.has(item.path)) bin.selected.delete(item.path);
      else bin.selected.add(item.path);
      paintBinSelection(key);
      return;
    }
    bin.selected = new Set([item.path]);
    paintBinSelection(key);
    if (key === 'sounds') { startInlineSound(item, card); return; }
    if (key === 'media') enterMediaPreview(item);
    else startInlinePreview(item, card); // transitions: quick loop right on the tile
  });
  card.addEventListener('dblclick', () => {
    if (key === 'sounds') {
      const s = baseSoundFromItem(item);
      s.origin = 'sounds';
      addSoundItems([s], totalDuration());
    } else {
      const c = baseItemToTimeline(item);
      c.origin = key;
      addTimelineItems([c], totalDuration());
    }
  });
  card.addEventListener('dragstart', (e) => {
    const dragSet = bin.selected.has(item.path) ? selectedBinItems(key) : [item];
    const payload = JSON.stringify({ kind: key, items: dragSet });
    e.dataTransfer.setData('application/x-clipmerger', payload);
    e.dataTransfer.setData('text/plain', payload); // robust fallback for the drop read-back
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setDragImage(emptyDragImage(), 0, 0);
    buildDragCard(card, e, dragSet.length);
    binDragActive = true;
    pendingDrag = { kind: key, items: dragSet };
  });
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    bin.selected = new Set([item.path]);
    paintBinSelection(key);
    openContextMenu({
      x: e.clientX,
      y: e.clientY,
      title: item.name,
      rating: ratingForItem(item),
      onRate: async (n) => { await setRating(item.path, n); renderBin(key); },
      onReveal: () => api.reveal(item.path),
    });
  });
  list.appendChild(card);
}

/* ---- inline tile preview (Transitions): audible, plays once, stops on pointer leave ---- */
let inlinePreview = null;
function onInlinePreviewLeave() { stopInlinePreview(); }
function startInlinePreview(item, card) {
  const host = card.querySelector('.bthumb') || card;
  stopInlineSound();
  stopInlinePreview();
  let el = document.getElementById('bin-preview-video');
  if (!el) {
    el = document.createElement('video');
    el.id = 'bin-preview-video';
    el.className = 'bin-preview-video';
    el.playsInline = true;
  }
  el.muted = false; // click is a user gesture → audio is allowed to start
  el.loop = false;  // single playthrough; clicking again replays
  el.removeAttribute('src');
  el.src = api.toFileUrl(item.path);
  host.appendChild(el);
  try { el.currentTime = 0; } catch (_) {}
  el.play().catch(() => {});
  inlinePreview = { el, card };
  card.addEventListener('pointerleave', onInlinePreviewLeave, { once: true });
}
function stopInlinePreview() {
  if (!inlinePreview) return;
  const { el, card } = inlinePreview;
  inlinePreview = null;
  card.removeEventListener('pointerleave', onInlinePreviewLeave);
  try { el.pause(); } catch (_) {}
  el.removeAttribute('src');
  if (el.parentNode) el.parentNode.removeChild(el);
}

/* ---- inline tile preview (Sounds): audible, stops when the cursor leaves ---- */
let inlineSound = null;
function onInlineSoundLeave() { stopInlineSound(); }
function startInlineSound(item, card) {
  stopInlinePreview();
  stopInlineSound();
  const el = document.createElement('audio');
  el.preload = 'auto';
  el.src = api.toFileUrl(item.path);
  const rack = document.getElementById('sound-audio-rack') || document.body;
  rack.appendChild(el);
  try { el.currentTime = 0; } catch (_) {}
  el.play().catch(() => {});
  inlineSound = { el, card };
  card.addEventListener('pointerleave', onInlineSoundLeave, { once: true });
}
function stopInlineSound() {
  if (!inlineSound) return;
  const { el, card } = inlineSound;
  inlineSound = null;
  card.removeEventListener('pointerleave', onInlineSoundLeave);
  try { el.pause(); } catch (_) {}
  el.removeAttribute('src');
  if (el.parentNode) el.parentNode.removeChild(el);
}

// Only request a thumbnail once the tile is actually on screen (keeps CPU/IO low).
function observeThumb(key, item, img) {
  let obs = binObservers[key];
  if (!obs) {
    obs = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const el = en.target;
        obs.unobserve(el);
        if (el._thumbItem) loadThumb(el._thumbItem, el);
      }
    }, { root: null, rootMargin: '300px' });
    binObservers[key] = obs;
  }
  img._thumbItem = item;
  obs.observe(img);
}

async function loadThumb(item, img) {
  if (thumbCache.has(item.path)) {
    img.src = thumbCache.get(item.path);
    img.classList.remove('placeholder');
    return;
  }
  // Disk-backed thumbnails: the main process returns a cache file path; serve it
  // as a file: URL (kept in a small per-session map to avoid repeat IPC).
  try {
    const res = await api.thumbnail({ ffmpegPath: state.settings.ffmpegPath, file: item.path, maxW: 240 });
    if (res && res.ok) {
      const url = res.file ? api.toFileUrl(res.file) : res.data; // disk path now; base64 legacy fallback
      if (url) cappedSet(thumbCache, item.path, url, 500);
      if (url) img.src = url;
      img.classList.remove('placeholder');
    }
  } catch (_) {}
}

/* ---------------- item factories ---------------- */
function isImageItem(item) {
  if (!item) return false;
  if (item.image || item.kind === 'image') return true;
  const m = /\.([a-z0-9]+)$/i.exec(item.path || item.name || '');
  return !!(m && state.imageExt.includes(m[1].toLowerCase()));
}

function baseItemToTimeline(item) {
  const image = isImageItem(item);
  const duration = image ? STILL_DEFAULT : item.duration;
  return {
    id: newId(), path: item.path, name: item.name, duration,
    start: 0, srcStart: 0, srcEnd: duration,
    kind: image ? 'image' : 'video', still: image || undefined,
    mute: image ? true : false, speed: 1,
    fit: 'blur', // whole frame + blurred background is the default framing
    volume: 0,   // per-clip audio gain in dB
    width: item.width, height: item.height, fps: item.fps, vcodec: item.vcodec,
    acodec: image ? null : item.acodec, audioSampleRate: image ? 0 : item.audioSampleRate,
    audioChannels: image ? 0 : item.audioChannels, hasAudio: image ? false : item.hasAudio,
  };
}
function baseSoundFromItem(item) {
  const s = {
    id: newId(), path: item.path, name: item.name, duration: item.duration,
    srcStart: undefined, srcEnd: undefined, endTime: item.duration, startTime: 0, volume: 0,
  };
  // Robustness: if ffprobe didn't report a duration the sound would get a
  // zero-length region and never be audible — read it from the media element.
  if (!(item.duration > 0)) {
    try {
      const probe = new Audio();
      probe.preload = 'metadata';
      probe.addEventListener('loadedmetadata', () => {
        if (isFinite(probe.duration) && probe.duration > 0) {
          s.duration = probe.duration;
          s.endTime = probe.duration;
          if (typeof renderTimeline === 'function') renderTimeline();
        }
      }, { once: true });
      probe.src = api.toFileUrl(item.path);
    } catch (_) {}
  }
  return s;
}

const hybStartOf = (h) => (h.kind === 'sound' ? (h.startTime || 0) : (h.start || 0));
const hybDurOf = (h) => (h.kind === 'sound' ? sndDur(h) : durOf(h));
function setHybStart(h, t) { if (h.kind === 'sound') h.startTime = t; else h.start = t; }
function baseHybClip(item) { const c = baseItemToTimeline(item); c.kind = c.kind === 'image' ? 'image' : 'clip'; return c; }
function baseHybSound(item) { const s = baseSoundFromItem(item); s.kind = 'sound'; return s; }

function addHybridItems(items, t) {
  if (!items.length) return;
  noteEditing();
  snapshot();
  const L = items.reduce((n, h) => n + hybDurOf(h), 0);
  const start = Math.max(-PREROLL, TimelineOps.resolveInsertTime(state, t, 'alt'));
  TimelineOps.rippleOpen(state, start, L, 'alt'); // ALT only: nothing else moves
  let st = start;
  for (const h of items) { setHybStart(h, st); st += hybDurOf(h); }
  state.hybrid.push(...items);
  arrangeHybridClips();
  clearSelection();
  items.forEach((h) => state.selectedHyb.add(h.id)); // only the newly added items stay selected
  commit(`Add ${items.length} to ALT`);
  renderTimeline();
  warmPreviewProxies();
}

function addTimelineItems(items, t) {
  if (!items.length) return;
  noteEditing();
  snapshot();
  const L = items.reduce((n, it) => n + durOf(it), 0);
  const start = Math.max(-PREROLL, TimelineOps.resolveInsertTime(state, t, 'main'));
  TimelineOps.rippleOpen(state, start, L, 'all'); // MAIN insert pushes every lane + markers
  let cur = start;
  for (const it of items) { it.start = cur; cur += durOf(it); }
  state.timeline.push(...items);
  arrangeTrack();
  clearSelection();
  items.forEach((it) => state.selectedIds.add(it.id)); // only the newly added items stay selected
  commit(`Add ${items.length} clip(s)`);
  renderAll();
  warmPreviewProxies();
}
function addSoundItems(items, t) {
  if (!items.length) return;
  noteEditing();
  snapshot();
  const L = items.reduce((n, s) => n + sndDur(s), 0);
  const start = Math.max(-PREROLL, TimelineOps.resolveInsertTime(state, t, 'sound'));
  TimelineOps.rippleOpen(state, start, L, 'sound'); // SOUND only: nothing else moves
  let st = start;
  for (const s of items) { s.startTime = st; st += sndDur(s); }
  state.soundboard.push(...items);
  clearSelection();
  items.forEach((s) => state.selectedSbs.add(s.id)); // only the newly added sounds stay selected
  commit(`Add ${items.length} sound(s)`);
  renderTimeline();
}

/* ---------------- snapping ---------------- */
function snapPts(excludeId) {
  const pts = [-PREROLL, 0, state.playhead];
  for (const it of state.timeline) {
    if (it.id !== excludeId) pts.push(it.start || 0, (it.start || 0) + durOf(it));
  }
  for (const s of state.soundboard) {
    if (s.id !== excludeId) {
      const t0 = s.startTime || 0;
      pts.push(t0, t0 + sndDur(s));
    }
  }
  for (const h of state.hybrid) {
    if (h.id !== excludeId) {
      const t0 = hybStartOf(h);
      pts.push(t0, t0 + hybDurOf(h));
    }
  }
  for (const mk of state.markers) pts.push(mk.time || 0);
  for (const e of state.effects) {
    if (e.id === excludeId) continue;
    pts.push(e.start || 0, (e.start || 0) + Math.max(0, e.dur || 0));
  }
  return pts;
}
function nearest(pt, pts, tol) {
  let best = null, bd = tol;
  for (const p of pts) {
    const d = Math.abs(p - pt);
    if (d <= bd) { bd = d; best = p; }
  }
  return best;
}
function snapTol() { return SNAP_PX / state.pps; }
function snapMove(start, dur, excludeId) {
  if (!state.snap) return { start, guide: null };
  const tol = snapTol();
  const pts = snapPts(excludeId);
  const a = nearest(start, pts, tol);
  const b = nearest(start + dur, pts, tol);
  if (a != null && (b == null || Math.abs(a - start) <= Math.abs(b - (start + dur)))) return { start: a, guide: a };
  if (b != null) return { start: b - dur, guide: b };
  return { start, guide: null };
}
function snapTrim(v, excludeId, extraPts) {
  if (!state.snap) return { v, guide: null };
  const tol = snapTol();
  const pts = snapPts(excludeId);
  if (extraPts && extraPts.length) pts.push(...extraPts);
  const n = nearest(v, pts, tol);
  return n != null ? { v: n, guide: n } : { v, guide: null };
}
function snapDrop(t) {
  if (!state.snap) return t;
  const n = nearest(t, snapPts(null), snapTol());
  return n != null ? n : t;
}

function showGuide(x) {
  const g = $('#snap-guide');
  g.classList.remove('hidden');
  g.style.left = timeToX(Math.max(-PREROLL, x)) + 'px';
}
function hideGuide() { $('#snap-guide').classList.add('hidden'); }

/* ---------------- timeline rendering ---------------- */
function renderTimeline() {
  const total = totalDuration();
  state.playhead = Math.max(-PREROLL, Math.min(playheadMax(), state.playhead));

  const scroll = $('#tl-scroll');
  // Trailing runway: enough empty timeline after the last clip that the pinned
  // marker can slide the view all the way to the end from ANY position (even
  // when the tracker sits right at 00:00). Without it the view clamps ~one
  // viewport short of the end. The free PLAY_TAIL runway lets the playhead roam
  // past the content (that space also makes the distance bands reachable).
  const trail = Math.max(160, scroll.clientWidth + 8);
  const W = Math.max(scroll.clientWidth, PAD + (total + PREROLL + PLAY_TAIL) * state.pps + trail);
  $('#tl-inner').style.width = W + 'px';

  renderRuler(W, total);
  renderMarkers();
  renderVideoLane();
  renderHybridLane();
  renderAudioLane();
  renderPreroll();
  renderRunwayBands(W);
  updatePlayhead();
  updateTimeReadout();
  updateScrollbar();

  const overlapIds = getOverlapIds();
  if (overlapIds.size > 0) {
    $('#status-msg').textContent = `⚠ ${overlapIds.size} overlapping item${overlapIds.size > 1 ? 's' : ''} — resolve before export`;
    $('#btn-export').disabled = true;
  } else {
    $('#btn-export').disabled = false;
  }

  $('#btn-del').disabled = !anySelected();
  $('#btn-split').disabled = !state.timeline.length && !state.soundboard.length && !state.hybrid.length;
  updateToolbar();
}

// The fixed pre-roll band left of 0:00 and the 0:00 boundary line.
function renderPreroll() {
  const band = $('#tl-preroll');
  if (band) {
    band.style.left = timeToX(-PREROLL) + 'px';
    band.style.width = Math.max(0, PREROLL * state.pps) + 'px';
  }
  const zero = $('#tl-zero');
  if (zero) zero.style.left = timeToX(0) + 'px';
}

// Distance bands: pale tints over the lanes and the ruler strip once the time
// crosses 1:00 (amber) and 2:00 (red) — you can always tell how far in / how
// far you've roamed into the free runway. Painted on absolute time, so they
// also show on an empty timeline while you scroll the PLAY_TAIL space.
function renderRunwayBands(W) {
  const xW = timeToX(TIME_WARN);
  const xD = timeToX(TIME_DANGER);
  const laneTop = $('#tl-track-video') ? $('#tl-track-video').offsetTop : 0;
  const warn = $('#tl-band-warn');
  const danger = $('#tl-band-danger');
  if (warn) {
    if (xW < W) {
      warn.style.left = xW + 'px';
      warn.style.width = Math.max(0, xD - xW) + 'px';
      warn.style.top = laneTop + 'px';
    } else { warn.style.left = '0px'; warn.style.width = '0px'; }
  }
  if (danger) {
    if (xD < W) {
      danger.style.left = xD + 'px';
      danger.style.width = Math.max(0, W - xD) + 'px';
      danger.style.top = laneTop + 'px';
    } else { danger.style.left = '0px'; danger.style.width = '0px'; }
  }
  // Ruler strip: fresh children each render (renderRuler clears #tl-ruler).
  const ruler = $('#tl-ruler');
  if (!ruler) return;
  const mkBand = (cls, left, width) => {
    const d = document.createElement('div');
    d.className = 'tl-band ' + cls;
    d.setAttribute('aria-hidden', 'true');
    d.style.left = left + 'px';
    d.style.width = Math.max(0, width) + 'px';
    ruler.prepend(d); // before ticks so labels paint above the tint
  };
  if (xW < W) mkBand('warn', xW, xD - xW);
  if (xD < W) mkBand('danger', xD, W - xD);
}

function renderRuler(W, total) {
  const ruler = $('#tl-ruler');
  ruler.innerHTML = '';
  ruler.style.width = W + 'px';
  const candidates = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800];
  let step = candidates[0];
  for (const c of candidates) {
    if (c * state.pps >= 64) { step = c; break; }
  }
  const minor = step / 5 >= state.pps * 0.016 ? step / 5 : step;
  const start = Math.floor((-PREROLL) / minor) * minor;
  for (let t = start; t <= total + 1e-6; t += minor) {
    const major = Math.abs(t - Math.round(t / step) * step) < 1e-6;
    const el = document.createElement('div');
    el.className = 'ruler-tick' + (major ? '' : ' min') + (Math.abs(t) < 1e-6 ? ' zero' : '');
    el.style.left = timeToX(t) + 'px';
    if (major) el.textContent = fmt(t);
    ruler.appendChild(el);
  }
}

function sortMarkers() { state.markers.sort((a, b) => (a.time || 0) - (b.time || 0)); }

function renderMarkers() {
  // Markers live on the ruler itself. renderRuler() clears the ruler before
  // this runs, so just drop any previous markers without touching the ticks.
  const ruler = $('#tl-ruler');
  ruler.querySelectorAll('.marker').forEach((el) => el.remove());
  sortMarkers();
  for (const m of state.markers) {
    const el = document.createElement('div');
    el.className = 'marker' + (state.selectedMarkers.has(m.id) ? ' selected' : '');
    el.style.left = timeToX(m.time || 0) + 'px';
    el.title = `${m.label || 'marker'} @ ${fmt(m.time || 0)}`;
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (e.button !== 0) return;
      if (e.ctrlKey || e.metaKey) selectMarker(m.id, true);
      else if (!state.selectedMarkers.has(m.id)) selectMarker(m.id, false);
      snapshot();
      startMarkerDrag(m, e);
      e.preventDefault();
    });
    ruler.appendChild(el);
  }
}

// Shared timeline-item bottom label: the leading icon (video / transition glyph
// or the ♪ note for sounds) and — for visual clips — the duration. The name and
// morphing tags live in the Title Bar above it; this strip just anchors the icon.
function makeLabel({ iconId, dur }) {
  const label = document.createElement('div');
  label.className = 'label';
  const icn = document.createElement('span');
  icn.className = 'icn';
  if (iconId) icn.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${iconId}"/></svg>`;
  else icn.textContent = '♪';
  label.append(icn);
  if (dur != null) {
    const d = document.createElement('span');
    d.className = 'dur';
    d.textContent = dur;
    label.appendChild(d);
  }
  return label;
}

// Title Bar: the shadowed top quarter of an item showing its title plus morph
// tags. Non-interactive — the whole item is the drag handle. Tags auto-hide on
// narrow items so the name always wins the space.
const TITLE_TAGS_MIN_PX = 120;
function makeTitlebar({ name, tags, px }) {
  const bar = document.createElement('div');
  bar.className = 'titlebar';
  const ttl = document.createElement('span');
  ttl.className = 'ttl';
  ttl.textContent = name || '';
  bar.appendChild(ttl);
  if (tags && tags.length && (px == null || px >= TITLE_TAGS_MIN_PX)) {
    const meta = document.createElement('span');
    meta.className = 'tmeta';
    meta.textContent = tags.join(' · ');
    bar.appendChild(meta);
  }
  return bar;
}

function renderVideoLane() {
  const body = $('#tl-video-body');
  body.innerHTML = '';
  if (!state.timeline.length) return;
  const overlapIds = getOverlapIds();
  state.timeline.forEach((item) => {
    const start = item.start || 0;
    const dur = durOf(item);
    const still = TimelineOps.isStill(item);
    const block = document.createElement('div');
    block.className = 'tclip'
      + (still ? (item.kind === 'freeze' ? ' freeze' : ' image') : '')
      + (item.origin === 'transitions' ? ' transition' : '')
      + (state.selectedIds.has(item.id) ? ' selected' : '')
      + (overlapIds.has(item.id) ? ' overlap' : '')
      + ((drag && drag.type === 'move' && drag.itemId === item.id) ? ' dragging' : '');
    block.style.left = laneX(start) + 'px';
    block.style.width = Math.max(6, dur * state.pps) + 'px';

    block.appendChild(makeLabel({
      iconId: item.kind === 'freeze' ? 'i-freeze' : (isImageItem(item) ? 'i-image' : (item.origin === 'transitions' ? 'i-transition' : 'i-video')),
      dur: fmt(dur),
    }));
    if (item.hasAudio && !drag) renderWaveform(block, item);
    if (item.mute) {
      const mb = document.createElement('div');
      mb.className = 'mute-badge';
      mb.textContent = '🔇';
      block.appendChild(mb);
    }
    block.appendChild(makeTitlebar({
      name: item.name,
      tags: editTags(item),
      px: dur * state.pps,
    }));

    if (!still) {
      const kfs = keyCache.get(item.path);
      if (kfs) {
        for (const k of kfs) {
          if (k >= item.srcStart && k <= item.srcEnd) {
            const mk = document.createElement('div');
            mk.className = 'key';
            mk.style.left = ((k - item.srcStart) * state.pps) + 'px';
            block.appendChild(mk);
          }
        }
      } else {
        getKeyframesAsync(item.path);
      }
    }

    const el = document.createElement('div');
    el.className = 'edge l';
    el.addEventListener('pointerdown', (e) => { e.stopPropagation(); startTrimDrag(item, 'l', e); });
    block.appendChild(el);
    const er = document.createElement('div');
    er.className = 'edge r';
    er.addEventListener('pointerdown', (e) => { e.stopPropagation(); startTrimDrag(item, 'r', e); });
    block.appendChild(er);

    block.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      if (isDoubleDown('c' + item.id)) { selectClip(item.id, false); deleteSelection(); e.preventDefault(); return; }
      if (e.ctrlKey || e.metaKey) { selectClip(item.id, true); e.preventDefault(); return; }
      if (!state.selectedIds.has(item.id)) selectClip(item.id, false);
      snapshot();
      startMoveDrag(item, e);
      e.preventDefault();
    });
    body.appendChild(block);
  });
  renderClipGaps(body);
  renderEffects(body, 'clips');
}
// CLIPS2 hybrid lane: clip-like items (video) and sound-like items share one row.
function renderHybridLane() {
  const body = $('#tl-hybrid-body');
  body.innerHTML = '';
  if (!state.hybrid.length) return;
  const overlapIds = getOverlapIds();
  state.hybrid.forEach((h) => {
    const block = document.createElement('div');
    const kind = h.kind === 'sound' ? 'sound' : 'clip';
    const still = TimelineOps.isStill(h);
    let cls = kind === 'sound' ? 'tsb' : 'tclip hyb';
    if (still) cls += h.kind === 'freeze' ? ' freeze' : ' image';
    if (kind !== 'sound' && h.origin === 'transitions') cls += ' transition';
    if (state.selectedHyb.has(h.id)) cls += ' selected';
    if (overlapIds.has(h.id)) cls += ' overlap';
    block.className = cls;
    block.style.left = laneX(hybStartOf(h)) + 'px';
    block.style.width = Math.max(6, hybDurOf(h) * state.pps) + 'px';

    block.appendChild(makeLabel(kind === 'sound'
      ? { dur: fmt(hybDurOf(h)) }
      : { iconId: h.kind === 'freeze' ? 'i-freeze' : (isImageItem(h) ? 'i-image' : (h.origin === 'transitions' ? 'i-transition' : 'i-video')), dur: fmt(hybDurOf(h)) }));

    if (kind === 'sound') {
      renderWaveform(block, h);
      const el = document.createElement('div');
      el.className = 'edge l';
      el.addEventListener('pointerdown', (e) => { e.stopPropagation(); startHybSoundTrimDrag(h, 'l', e); });
      block.appendChild(el);
      const er = document.createElement('div');
      er.className = 'edge r';
      er.addEventListener('pointerdown', (e) => { e.stopPropagation(); startHybSoundTrimDrag(h, 'r', e); });
      block.appendChild(er);
    } else {
      if (h.hasAudio && !drag) renderWaveform(block, h);
      if (h.mute) {
        const mb = document.createElement('div');
        mb.className = 'mute-badge';
        mb.textContent = '🔇';
        block.appendChild(mb);
      }
      const el = document.createElement('div');
      el.className = 'edge l';
      el.addEventListener('pointerdown', (e) => { e.stopPropagation(); startHybTrimDrag(h, 'l', e); });
      block.appendChild(el);
      const er = document.createElement('div');
      er.className = 'edge r';
      er.addEventListener('pointerdown', (e) => { e.stopPropagation(); startHybTrimDrag(h, 'r', e); });
      block.appendChild(er);

      if (!still) {
        const kfs = keyCache.get(h.path);
        if (kfs) {
          for (const k of kfs) {
            if (k >= h.srcStart && k <= h.srcEnd) {
              const mk = document.createElement('div');
              mk.className = 'key';
              mk.style.left = ((k - (h.srcStart || 0)) * state.pps) + 'px';
              block.appendChild(mk);
            }
          }
        } else {
          getKeyframesAsync(h.path);
        }
      }
    }

    const soundTags = h.volume && Math.abs(h.volume) > 0.01 ? [`${h.volume > 0 ? '+' : ''}${h.volume} dB`] : [];
    block.appendChild(makeTitlebar({
      name: h.name,
      tags: kind === 'sound' ? soundTags : editTags(h),
      px: hybDurOf(h) * state.pps,
    }));

    block.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      if (isDoubleDown('h' + h.id)) { selectHyb(h.id, false); deleteSelection(); e.preventDefault(); return; }
      if (e.ctrlKey || e.metaKey) { selectHyb(h.id, true); e.preventDefault(); return; }
      if (!state.selectedHyb.has(h.id)) selectHyb(h.id, false);
      snapshot();
      startHybMoveDrag(h, e);
      e.preventDefault();
    });
    body.appendChild(block);
  });
  renderHybridGaps(body);
  renderEffects(body, 'hybrid');
}

// Empty spans between consecutive clips (plus a leading 0 → first-clip span),
// rendered as selectable, deletable gaps.
function renderClipGaps(body) {
  const clips = [...state.timeline].sort((a, b) => (a.start || 0) - (b.start || 0));
  if (!clips.length) return;
  const gaps = [];
  const firstStart = clips[0].start || 0;
  if (firstStart > 1e-6) gaps.push({ start: 0, end: firstStart, lane: 'main' });
  for (let i = 1; i < clips.length; i++) {
    const prevEnd = (clips[i - 1].start || 0) + durOf(clips[i - 1]);
    const curStart = clips[i].start || 0;
    if (curStart > prevEnd + 1e-6) gaps.push({ start: prevEnd, end: curStart, lane: 'main' });
  }
  for (const g of gaps) {
    const el = document.createElement('div');
    const selected = state.selectedGaps.some((s) => s.lane === g.lane && Math.abs(s.start - g.start) < 1e-6 && Math.abs(s.end - g.end) < 1e-6);
    el.className = 'tgap' + (selected ? ' selected' : '');
    el.style.left = laneX(g.start) + 'px';
    el.style.width = Math.max(2, (g.end - g.start) * state.pps) + 'px';
    el.title = `Gap ${fmt(g.end - g.start)} — click to select, double-click to close`;
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (e.button !== 0) return;
      if (isDoubleDown('g' + g.lane + g.start + g.end)) { closeGaps([g]); e.preventDefault(); return; }
      selectGap(g, e.ctrlKey || e.metaKey);
      e.preventDefault();
    });
    body.appendChild(el);
  }
}

function renderHybridGaps(body) {
  const clips = state.hybrid.filter((h) => h.kind !== 'sound').sort((a, b) => (a.start || 0) - (b.start || 0));
  if (!clips.length) return;
  const gaps = [];
  const firstStart = clips[0].start || 0;
  if (firstStart > 1e-6) gaps.push({ start: 0, end: firstStart, lane: 'alt' });
  for (let i = 1; i < clips.length; i++) {
    const prevEnd = (clips[i - 1].start || 0) + durOf(clips[i - 1]);
    const curStart = clips[i].start || 0;
    if (curStart > prevEnd + 1e-6) gaps.push({ start: prevEnd, end: curStart, lane: 'alt' });
  }
  for (const g of gaps) {
    const el = document.createElement('div');
    const selected = state.selectedGaps.some((s) => s.lane === g.lane && Math.abs(s.start - g.start) < 1e-6 && Math.abs(s.end - g.end) < 1e-6);
    el.className = 'tgap' + (selected ? ' selected' : '');
    el.style.left = laneX(g.start) + 'px';
    el.style.width = Math.max(2, (g.end - g.start) * state.pps) + 'px';
    el.title = `Gap ${fmt(g.end - g.start)} — click to select, double-click to close`;
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (e.button !== 0) return;
      if (isDoubleDown('g' + g.lane + g.start + g.end)) { closeGaps([g]); e.preventDefault(); return; }
      selectGap(g, e.ctrlKey || e.metaKey);
      e.preventDefault();
    });
    body.appendChild(el);
  }
}

function renderAudioLane() {
  const body = $('#tl-audio-body');
  body.innerHTML = '';
  if (!state.soundboard.length) return;
  const overlapIds = getOverlapIds();
  state.soundboard.forEach((s) => {
    const w = Math.max(6, sndDur(s) * state.pps);
    const block = document.createElement('div');
    block.className = 'tsb' + (state.selectedSbs.has(s.id) ? ' selected' : '') + (overlapIds.has(s.id) ? ' overlap' : '');
    block.style.left = laneX(s.startTime || 0) + 'px';
    block.style.width = w + 'px';

    block.appendChild(makeLabel({ dur: fmt(sndDur(s)) }));

    const sv = s.volume || 0;
    block.appendChild(makeTitlebar({
      name: s.name,
      tags: Math.abs(sv) > 0.01 ? [`${sv > 0 ? '+' : ''}${sv} dB`] : [],
      px: sndDur(s) * state.pps,
    }));

    const er = document.createElement('div');
    er.className = 'edge r';
    er.addEventListener('pointerdown', (e) => { e.stopPropagation(); startSbTrimDrag(s, e); });
    block.appendChild(er);

    block.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      if (isDoubleDown('s' + s.id)) { selectSb(s.id, false); deleteSelection(); e.preventDefault(); return; }
      if (e.ctrlKey || e.metaKey) { selectSb(s.id, true); e.preventDefault(); return; }
      if (!state.selectedSbs.has(s.id)) selectSb(s.id, false);
      snapshot();
      startSbMoveDrag(s, e);
      e.preventDefault();
    });

    body.appendChild(block);
    renderWaveform(block, s);
  });
}

async function renderWaveform(block, item) {
  const peaks = await getWaveform(item);
  if (!peaks || !peaks.length) return;
  const wv = document.createElement('div');
  wv.className = 'wv';
  for (const p of peaks) {
    const bar = document.createElement('i');
    bar.style.height = Math.max(6, Math.round(p * 100)) + '%';
    wv.appendChild(bar);
  }
  block.appendChild(wv);
}

function updatePlayhead() {
  $('#tl-playhead').style.left = timeToX(state.playhead) + 'px';
}
function updateTimeReadout() {
  const el = $('#tl-time');
  el.textContent = `${fmt(state.playhead)} / ${fmt(totalDuration())}`;
  // Mirror the distance bands on the time readout so "how far in" is visible
  // without moving your eyes off the numbers.
  el.classList.toggle('warn', state.playhead >= TIME_WARN && state.playhead < TIME_DANGER);
  el.classList.toggle('danger', state.playhead >= TIME_DANGER);
  updateFreezeButton();
}

/* ---------------- custom timeline scrollbar ---------------- */
function updateScrollbar() {
  const sc = $('#tl-scroll');
  if (!sc) return;
  const cw = sc.scrollWidth;
  const vw = sc.clientWidth;
  const canScroll = cw > vw + 1;
  const ratio = canScroll ? sc.scrollLeft / (cw - vw) : 0.5;
  const bar = $('#tl-scrub');
  if (bar) {
    bar.classList.toggle('noscroll', !canScroll);
    bar.setAttribute('aria-valuenow', String(Math.round(Math.max(0, Math.min(ratio, 1)) * 100)));
  }
}

/* ---------------- drag machinery ---------------- */
let drag = null;
let scrubTexX = 0; // shuttle bar hatch offset — only advances while the shuttle is dragged

// Double-click detection via pointerdown, not the native `dblclick`: the item
// pointerdown handlers call preventDefault() (which suppresses click/dblclick)
// and the first click re-renders the lane (replacing the node), so a real
// `dblclick` can never form. Timing the two pointerdowns ourselves is immune to
// both. Key is per-item (lane + id) so two different items never pair.
let lastDown = { key: null, t: 0 };
function isDoubleDown(key) {
  const now = performance.now();
  const hit = lastDown.key === key && (now - lastDown.t) < 320;
  lastDown = { key, t: now };
  return hit;
}

function setTexX(barEl, px) {
  if (barEl) barEl.style.setProperty('--pad-tex-x', px + 'px');
}

function timeAtClientX(e) {
  const sc = $('#tl-scroll');
  const r = sc.getBoundingClientRect();
  return (e.clientX - r.left + sc.scrollLeft - PAD) / state.pps - PREROLL;
}

// Which lane a pointer Y overlaps: 'clips' | 'hybrid' | 'sounds'.
function laneAt(clientY) {
  const sc = $('#tl-scroll');
  const r = sc.getBoundingClientRect();
  const y = clientY - r.top + sc.scrollTop;
  const lanes = [
    ['clips', $('#tl-track-video')],
    ['hybrid', $('#tl-track-hybrid')],
    ['sounds', $('#tl-track-audio')],
  ];
  for (const [key, el] of lanes) {
    if (el && y >= el.offsetTop && y <= el.offsetTop + el.offsetHeight) return key;
  }
  return 'clips';
}

/* ---------------- cross-track moves ---------------- */
function laneArr(lane) { return lane === 'clips' ? state.timeline : lane === 'sounds' ? state.soundboard : state.hybrid; }
function laneSel(lane) { return lane === 'clips' ? state.selectedIds : lane === 'sounds' ? state.selectedSbs : state.selectedHyb; }
function laneTrackEl(lane) {
  return lane === 'clips' ? $('#tl-track-video') : lane === 'sounds' ? $('#tl-track-audio') : $('#tl-track-hybrid');
}
// Highlight the lane the pointer is over while an item is being dragged.
function setDropTargetLane(lane) {
  for (const l of ['clips', 'hybrid', 'sounds']) {
    const el = laneTrackEl(l);
    if (el) el.classList.toggle('drop-target', l === lane);
  }
}
function clearDropTargetLane() {
  for (const l of ['clips', 'hybrid', 'sounds']) {
    const el = laneTrackEl(l);
    if (el) el.classList.remove('drop-target');
  }
}
// Move an item between lane arrays, toggling `kind` for ALT and carrying the
// start field (clip uses `start`, sound uses `startTime`). Selection follows.
function migrateItemToLane(item, fromLane, toLane) {
  const from = laneArr(fromLane), to = laneArr(toLane);
  const i = from.indexOf(item);
  if (i >= 0) from.splice(i, 1);
  const fromSel = laneSel(fromLane), toSel = laneSel(toLane);
  const wasSel = fromSel.delete(item.id);
  if (toLane === 'hybrid') {
    item.kind = fromLane === 'sounds' ? 'sound'
      : (item.kind === 'image' || item.kind === 'freeze' ? item.kind : 'clip');
  } else if (item.kind !== 'image' && item.kind !== 'freeze') {
    delete item.kind;
  }
  to.push(item);
  if (wasSel) toSel.add(item.id);
}
// Only a lone item may change lanes (groups stay put).
function canCrossTrack(d) {
  if (!d || (d.type !== 'move' && d.type !== 'sbmove' && d.type !== 'hybmove')) return false;
  return !d.group || d.group.length <= 1;
}
// The single item a move-drag is carrying (across the three move types).
function draggedItem(d) {
  if (d.type === 'move') return state.timeline.find((c) => c.id === d.itemId);
  if (d.type === 'sbmove') return state.soundboard.find((x) => x.id === d.id);
  return state.hybrid.find((x) => x.id === d.id);
}
function draggedKind(d) {
  if (d.type === 'move') return 'clip';
  if (d.type === 'sbmove') return 'sound';
  const it = draggedItem(d);
  return it && it.kind === 'sound' ? 'sound' : 'clip';
}
// Retarget an in-flight move drag after its item changed lanes. The three move
// types key the item differently (move/clip → itemId, the others → id) and only
// hybmove carries no group, so normalize both here.
function retargetDrag(d, toLane) {
  d.type = toLane === 'clips' ? 'move' : toLane === 'sounds' ? 'sbmove' : 'hybmove';
  if (d.type === 'hybmove') {
    d.id = d._movedId; delete d.itemId; delete d.group;
  } else if (d.type === 'sbmove') {
    d.id = d._movedId; d.group = [{ id: d._movedId, start: 0 }]; d.wasMulti = false; delete d.itemId;
  } else {
    d.itemId = d._movedId; d.group = [{ id: d._movedId, start: 0 }]; d.wasMulti = false; delete d.id;
  }
  delete d._movedId;
  d.lane = toLane;
}
// If the pointer has entered a compatible lane, migrate the dragged item there.
function maybeCrossTrack(e) {
  if (!drag || !canCrossTrack(drag)) return false;
  const lane = laneAt(e.clientY);
  if (lane === drag.lane || !TimelineOps.laneAccepts(lane, draggedKind(drag))) return false;
  const item = draggedItem(drag);
  if (!item) return false;
  drag._movedId = item.id;
  migrateItemToLane(item, drag.lane, lane);
  retargetDrag(drag, lane);
  renderTimeline(); // repaint every lane so the source lane drops the item
  return true;
}
// Per-move hook: highlight the hovered lane and migrate the dragged item into it
// when it's a valid target (only after the drag has actually started).
function trackCrossLane(e) {
  if (!drag) return;
  const started = drag.type === 'hybmove' || drag.started;
  const lane = laneAt(e.clientY);
  const ok = started && canCrossTrack(drag) && TimelineOps.laneAccepts(lane, draggedKind(drag));
  setDropTargetLane(ok ? lane : null);
  if (ok && lane !== drag.lane) maybeCrossTrack(e);
}

function hideSelBox() { const b = $('#sel-box'); if (b) b.style.display = 'none'; }

// Marshal a marquee selection: items in [tMin,tMax] whose lane is covered.
function marqueeSelect(tMin, tMax, laneKeys, add) {
  if (!add) clearSelection();
  if (laneKeys.includes('clips')) {
    for (const it of state.timeline) {
      if ((it.start || 0) < tMax && (it.start || 0) + durOf(it) > tMin) state.selectedIds.add(it.id);
    }
  }
  if (laneKeys.includes('hybrid')) {
    for (const h of state.hybrid) {
      if (hybStartOf(h) < tMax && hybStartOf(h) + hybDurOf(h) > tMin) state.selectedHyb.add(h.id);
    }
  }
  if (laneKeys.includes('sounds')) {
    for (const s of state.soundboard) {
      if ((s.startTime || 0) < tMax && (s.startTime || 0) + sndDur(s) > tMin) state.selectedSbs.add(s.id);
    }
  }
  for (const m of state.markers) {
    if ((m.time || 0) >= tMin && (m.time || 0) <= tMax) state.selectedMarkers.add(m.id);
  }
  renderTimeline();
}

function startMoveDrag(item, e) {
  // If the grabbed clip is part of a multi-selection, drag the whole group.
  const group = state.selectedIds.has(item.id) ? clipSelection() : [item];
  drag = {
    type: 'move', itemId: item.id, lane: 'clips',
    grabOff: (timeAtClientX(e) || 0) - (item.start || 0),
    downX: e.clientX, started: false,
    // A click (no drag) on an item that is part of a multi-selection collapses
    // the selection down to just that item.
    wasMulti: group.length > 1 && state.selectedIds.has(item.id),
    group: group.map((it) => ({ id: it.id, start: it.start || 0 })),
  };
  e.preventDefault();
}

function startTrimDrag(item, edge, e) {
  drag = {
    type: 'trim', itemId: item.id, edge,
    startSize: edge === 'l' ? item.srcStart : item.srcEnd,
    downT: timeAtClientX(e),
  };
  e.preventDefault();
}

function startSbMoveDrag(s, e) {
  const group = state.selectedSbs.has(s.id) ? soundSelection() : [s];
  drag = {
    type: 'sbmove', id: s.id, lane: 'sounds',
    grabOff: (timeAtClientX(e) || 0) - (s.startTime || 0),
    downX: e.clientX, started: false,
    wasMulti: group.length > 1 && state.selectedSbs.has(s.id),
    group: group.map((x) => ({ id: x.id, start: x.startTime || 0 })),
  };
  e.preventDefault();
}

// Shift every member of a selection by the same delta (grabbed item lands on
// targetStart); clamped so no member is pushed left of the pre-roll edge.
function moveGroup(group, grabbedId, targetStart, find, field) {
  const g0 = group.find((x) => x.id === grabbedId);
  if (!g0) return;
  const minStart = Math.min(...group.map((x) => x.start));
  const delta = Math.max(targetStart - g0.start, -PREROLL - minStart);
  for (const x of group) {
    const it = find(x.id);
    if (it) it[field] = x.start + delta;
  }
}

function startSbTrimDrag(s, e) {
  drag = {
    type: 'sbtrim', id: s.id,
    startEnd: s.srcEnd != null ? s.srcEnd : (s.endTime != null ? s.endTime : s.duration),
    downT: timeAtClientX(e),
  };
  e.preventDefault();
}

function startMarkerDrag(m, e) {
  drag = { type: 'marker', id: m.id };
  e.preventDefault();
}

function startHybMoveDrag(h, e) {
  drag = { type: 'hybmove', id: h.id, lane: 'hybrid', grabOff: (timeAtClientX(e) || 0) - hybStartOf(h) };
  e.preventDefault();
}

function startHybTrimDrag(h, edge, e) {
  drag = {
    type: 'hybtrim', id: h.id, edge,
    startSize: edge === 'l'
      ? (h.srcStart != null ? h.srcStart : (h.inPoint || 0))
      : (h.srcEnd != null ? h.srcEnd : (h.endTime != null ? h.endTime : h.duration)),
    downT: timeAtClientX(e),
  };
  e.preventDefault();
}

function startHybSoundTrimDrag(h, edge, e) {
  drag = {
    type: 'hybsoundtrim', id: h.id, edge,
    startSize: edge === 'l'
      ? (h.srcStart || 0)
      : (h.srcEnd != null ? h.srcEnd : (h.endTime != null ? h.endTime : h.duration)),
    downT: timeAtClientX(e),
  };
  e.preventDefault();
}

function startPan(e) {
  drag = { type: 'pan', lastX: e.clientX };
  $('#tl-scroll').classList.add('active-pan');
  e.preventDefault();
}

function onDragMove(e) {
  if (pastePending) { updatePasteGhost(e); return; }
  if (!drag) return;
  if (drag.type === 'move' || drag.type === 'sbmove' || drag.type === 'hybmove') trackCrossLane(e);
  if (drag.type === 'move') {
    if (!drag.started) {
      if (Math.abs(e.clientX - drag.downX) < 4) return;
      drag.started = true;
    }
    const item = state.timeline.find((c) => c.id === drag.itemId);
    if (!item) return;
    const raw = Math.max(-PREROLL, timeAtClientX(e) - drag.grabOff);
    const snap = snapMove(raw, durOf(item), item.id);
    moveGroup(drag.group, drag.itemId, snap.start, (id) => state.timeline.find((c) => c.id === id), 'start');
    if (snap.guide != null) showGuide(snap.guide); else hideGuide();
    renderTimeline();
  } else if (drag.type === 'trim') {
    const item = state.timeline.find((c) => c.id === drag.itemId);
    if (!item) return;
    const dt = timeAtClientX(e) - drag.downT;
    const kfs = keyCache.get(item.path) || [];
    if (drag.edge === 'l') {
      let ns = drag.startSize + dt;
      ns = Math.max(0, Math.min(ns, item.srcEnd - MIN_LEN));
      const snap = snapTrim(ns, item.id, kfs);
      item.srcStart = snap.v;
      if (snap.guide != null) showGuide(snap.guide); else hideGuide();
    } else {
      let ne = drag.startSize + dt;
      const maxSrc = TimelineOps.isStill(item) ? STILL_MAX : item.duration;
      ne = Math.max(item.srcStart + MIN_LEN, Math.min(ne, maxSrc));
      const snap = snapTrim(ne, item.id, kfs);
      item.srcEnd = snap.v;
      if (snap.guide != null) showGuide(snap.guide); else hideGuide();
    }
    renderTimeline();
  } else if (drag.type === 'sbmove') {
    if (!drag.started) {
      if (Math.abs(e.clientX - drag.downX) < 3) return;
      drag.started = true;
    }
    const s = state.soundboard.find((x) => x.id === drag.id);
    if (!s) return;
    const raw = timeAtClientX(e) - drag.grabOff;
    const snap = snapMove(raw, sndDur(s), s.id);
    moveGroup(drag.group, drag.id, snap.start, (id) => state.soundboard.find((x) => x.id === id), 'startTime');
    if (snap.guide != null) showGuide(snap.guide); else hideGuide();
    renderAudioLane();
  } else if (drag.type === 'sbtrim') {
    const s = state.soundboard.find((x) => x.id === drag.id);
    if (!s) return;
    const dt = timeAtClientX(e) - drag.downT;
    if (s.srcEnd != null) {
      let ne = drag.startEnd + dt;
      ne = clamp(ne, (s.srcStart || 0) + MIN_LEN, s.duration);
      const snap = snapTrim(ne, s.id, []);
      s.srcEnd = snap.v;
      if (snap.guide != null) showGuide(snap.guide); else hideGuide();
    } else {
      let ne = drag.startEnd + dt;
      ne = clamp(ne, MIN_LEN, s.duration);
      const snap = snapTrim(ne, s.id, []);
      s.endTime = snap.v;
      if (snap.guide != null) showGuide(snap.guide); else hideGuide();
    }
    renderAudioLane();
  } else if (drag.type === 'hybmove') {
    const h = state.hybrid.find((x) => x.id === drag.id);
    if (!h) return;
    const raw = Math.max(-PREROLL, timeAtClientX(e) - drag.grabOff);
    const snap = snapMove(raw, hybDurOf(h), h.id);
    setHybStart(h, snap.start);
    if (snap.guide != null) showGuide(snap.guide); else hideGuide();
    renderHybridLane();
  } else if (drag.type === 'hybtrim') {
    const h = state.hybrid.find((x) => x.id === drag.id);
    if (!h) return;
    const dt = timeAtClientX(e) - drag.downT;
    const kfs = keyCache.get(h.path) || [];
    if (drag.edge === 'l') {
      let ns = drag.startSize + dt;
      ns = Math.max(0, Math.min(ns, (h.srcEnd != null ? h.srcEnd : h.duration) - MIN_LEN));
      const snap = snapTrim(ns, h.id, kfs);
      h.srcStart = snap.v;
      if (snap.guide != null) showGuide(snap.guide); else hideGuide();
    } else {
      let ne = drag.startSize + dt;
      const maxSrc = TimelineOps.isStill(h) ? STILL_MAX : h.duration;
      ne = clamp(ne, (h.srcStart != null ? h.srcStart : 0) + MIN_LEN, maxSrc);
      const snap = snapTrim(ne, h.id, kfs);
      if (h.endTime != null) h.endTime = snap.v; else h.srcEnd = snap.v;
      if (snap.guide != null) showGuide(snap.guide); else hideGuide();
    }
    renderHybridLane();
  } else if (drag.type === 'hybsoundtrim') {
    const h = state.hybrid.find((x) => x.id === drag.id);
    if (!h || h.kind !== 'sound') return;
    const dt = timeAtClientX(e) - drag.downT;
    if (h.srcEnd != null) {
      if (drag.edge === 'l') {
        let ns = drag.startSize + dt;
        ns = Math.max(0, Math.min(ns, h.srcEnd - MIN_LEN));
        h.srcStart = ns;
      } else {
        let ne = drag.startSize + dt;
        ne = clamp(ne, (h.srcStart || 0) + MIN_LEN, h.duration);
        h.srcEnd = ne;
      }
    } else {
      if (drag.edge === 'l') {
        let ns = drag.startSize + dt;
        ns = Math.max(0, Math.min(ns, (h.endTime || h.duration) - MIN_LEN));
        h.startTime = Math.max(-PREROLL, h.startTime + (ns - drag.startSize));
        h.endTime = ns;
      } else {
        let ne = drag.startSize + dt;
        ne = clamp(ne, MIN_LEN, h.duration);
        h.endTime = ne;
      }
    }
    renderHybridLane();
  } else if (drag.type === 'effmove') {
    const e2 = state.effects.find((x) => x.id === drag.id);
    if (!e2) return;
    const raw = Math.max(-PREROLL, drag.start0 + (timeAtClientX(e) - drag.downT));
    const snap = snapMove(raw, e2.dur || 0, e2.id);
    e2.start = snap.start;
    if (snap.guide != null) showGuide(snap.guide); else hideGuide();
    sortEffects();
    renderTimeline();
  } else if (drag.type === 'efftrim') {
    const e2 = state.effects.find((x) => x.id === drag.id);
    if (!e2) return;
    const dt = timeAtClientX(e) - drag.downT;
    if (drag.edge === 'l') {
      const ns = clamp(drag.start0 + dt, -PREROLL, drag.start0 + drag.dur0 - 0.1);
      const snap = snapTrim(ns, e2.id, null);
      e2.dur = Math.max(0.1, (drag.start0 + drag.dur0) - snap.v);
      e2.start = snap.v;
      if (snap.guide != null) showGuide(snap.guide); else hideGuide();
    } else {
      const ne = Math.max(drag.start0 + 0.1, drag.start0 + drag.dur0 + dt);
      const snap = snapTrim(ne, e2.id, null);
      e2.dur = Math.max(0.1, snap.v - (e2.start || 0));
      if (snap.guide != null) showGuide(snap.guide); else hideGuide();
    }
    sortEffects();
    renderTimeline();
  } else if (drag.type === 'zoomcenter') {
    const eff = soleSelectedEffect();
    if (eff) {
      const pose = editTargetPose();
      if (pose) { panPoseBy(pose, e.clientX - drag.lastX, e.clientY - drag.lastY, pose.z); }
      drag.lastX = e.clientX; drag.lastY = e.clientY;
      updatePreviewZoomTransform();
    }
  } else if (drag.type === 'marker') {
    const m = state.markers.find((x) => x.id === drag.id);
    if (!m) return;
    const snap = snapMove(Math.max(-PREROLL, timeAtClientX(e)), 0, null);
    m.time = snap.start;
    if (snap.guide != null) showGuide(snap.guide); else hideGuide();
    renderMarkers();
  } else if (drag.type === 'marquee') {
    if (!drag.started && (Math.abs(e.clientX - drag.downX) < 4 && Math.abs(e.clientY - drag.downY) < 4)) return;
    drag.started = true;
    const r = $('#tl-scroll').getBoundingClientRect();
    const t1 = timeAtClientX(e);
    const tMin = Math.min(drag.t0, t1), tMax = Math.max(drag.t0, t1);
    const box = $('#sel-box');
    box.style.display = 'block';
    box.style.left = timeToX(tMin) + 'px';
    box.style.width = ((tMax - tMin) * state.pps) + 'px';
    box.style.top = (Math.min(drag.downY, e.clientY) - r.top + $('#tl-scroll').scrollTop) + 'px';
    box.style.height = Math.abs(e.clientY - drag.downY) + 'px';
    e.preventDefault();
  } else if (drag.type === 'scrub') {
    const sc = $('#tl-scroll');
    const dx = e.clientX - drag.lastX;
    if (dx !== 0) {
      drag.lastX = e.clientX;
      drag.wantScroll -= dx; // where the finger wants the view (may go past an edge)
      const maxSl = Math.max(0, sc.scrollWidth - sc.clientWidth);
      sc.scrollLeft = clamp(drag.wantScroll, 0, maxSl); // the view clamps at its edges…
      scrubTexX += dx;     // only this bar's hatch slides with the finger
      setTexX($('#tl-scrub'), scrubTexX);
      // …but the playhead follows the *un-clamped* desired position, so extra
      // finger travel past an edge keeps moving the tracker all the way to the
      // very start/end of the timeline (the marker slides off its pin only while
      // the view is clamped).
      const t = clamp((drag.pin + drag.wantScroll - PAD) / state.pps - PREROLL, -PREROLL, playheadMax());
      seekPreview(t);
      // At either end, drop the excess finger travel so the very next move
      // responds at once (no sticky dead-zone to undo before it moves again).
      if (t <= -PREROLL || t >= playheadMax()) drag.wantScroll = timeToX(t) - drag.pin;
      updateScrollbar();
    }
    e.preventDefault();
  } else if (drag.type === 'seek') {
    scrubTo(e);
  } else if (drag.type === 'pan') {
    const sc = $('#tl-scroll');
    sc.scrollLeft -= (e.clientX - drag.lastX);
    drag.lastX = e.clientX;
    updateScrollbar();
    e.preventDefault();
  }
}

/* ---------------- selection & toolbar state ---------------- */
function anySelected() {
  return state.selectedIds.size + state.selectedSbs.size + state.selectedHyb.size + state.selectedEff.size + state.selectedMarkers.size + state.selectedGaps.length > 0;
}
function clipSelection() { return state.timeline.filter((c) => state.selectedIds.has(c.id)); }
function soundSelection() { return state.soundboard.filter((s) => state.selectedSbs.has(s.id)); }
function hybSelection() { return state.hybrid.filter((h) => state.selectedHyb.has(h.id)); }
function effSelection() { return state.effects.filter((e) => state.selectedEff.has(e.id)); }
function soleSelectedEffect() {
  if (state.selectedEff.size !== 1) return null;
  const id = state.selectedEff.values().next().value;
  return state.effects.find((e) => e.id === id) || null;
}
// Absolute end time of an effect band.
const effectEnd = (e) => (e.start || 0) + Math.max(0, e.dur || 0);

// For Frame / Vol / Speed: clips from both the Clips and CLIPS2 lanes...
function allSelClips() { return clipSelection().concat(hybSelection().filter((h) => h.kind !== 'sound')); }
// ...sounds from the Sounds lane and the CLIPS2 lane.
function allSelSounds() { return soundSelection().concat(hybSelection().filter((h) => h.kind === 'sound')); }

function clearSelection() {
  state.selectedIds.clear();
  state.selectedSbs.clear();
  state.selectedHyb.clear();
  state.selectedEff.clear();
  state.selectedMarkers.clear();
  state.selectedGaps.length = 0;
}
function deselect() { clearSelection(); renderTimeline(); }

/* ---------------- undo / redo ---------------- */
// Snapshots cover the editable document (clips, sounds, markers). Zoom, scroll,
// playhead and selection are intentionally outside history.
const HIST_MAX = 100;
// Each entry is { snap, label } so the status-bar History modal can show actions.
let undoStack = [];
let redoStack = [];
let pendingSnap = null;

function snapshotDoc() {
  return JSON.stringify({ timeline: state.timeline, soundboard: state.soundboard, hybrid: state.hybrid, markers: state.markers, effects: state.effects });
}
// Call right before a mutation…
function snapshot() { pendingSnap = snapshotDoc(); }
// …and right after it. Records an entry (with an action label) only when the
// document actually changed.
function commit(label) {
  if (pendingSnap == null) return;
  noteEditing(); // any committed document change ends a single-clip media preview
  const now = snapshotDoc();
  if (pendingSnap !== now) {
    undoStack.push({ snap: pendingSnap, label: label || 'Edit' });
    if (undoStack.length > HIST_MAX) undoStack.shift();
    redoStack = [];
  }
  pendingSnap = null;
  renderHistory();
}
function applySnapshot(s) {
  noteEditing(); // undo/redo are edits too
  const d = TimelineOps.restoreDocument(s);
  state.timeline = d.timeline;
  state.soundboard = d.soundboard;
  state.hybrid = d.hybrid;
  state.markers = d.markers;
  state.effects = d.effects;
  drag = null;
  clearSelection();
  renderTimeline();
  renderHistory();
}
function undo() {
  if (!undoStack.length) { setStatus('Nothing to undo.'); return; }
  const popped = undoStack.pop();
  redoStack.push({ snap: snapshotDoc(), label: popped.label });
  applySnapshot(popped.snap);
  setStatus('Undo: ' + popped.label);
}
function redo() {
  if (!redoStack.length) { setStatus('Nothing to redo.'); return; }
  const popped = redoStack.pop();
  undoStack.push({ snap: snapshotDoc(), label: popped.label });
  applySnapshot(popped.snap);
  setStatus('Redo: ' + popped.label);
}
function resetHistory() { undoStack = []; redoStack = []; pendingSnap = null; renderHistory(); }

// Jump to the state after `n` recorded actions (0 = oldest undo entry).
function undoTo(n) {
  if (!undoStack.length || n < 0 || n >= undoStack.length) return;
  while (undoStack.length > n + 1) redoStack.push(undoStack.pop());
  applySnapshot(undoStack[n].snap);
  setStatus('Undone to: ' + undoStack[n].label);
}
// Jump to the state recorded by redo entry `k` (0 = nearest future).
function redoTo(k) {
  if (!redoStack.length || k < 0 || k >= redoStack.length) return;
  const target = redoStack[k].snap;
  const lbl = redoStack[k].label;
  for (let i = 0; i < k; i++) undoStack.push(redoStack[i]);
  redoStack.splice(0, k + 1);
  applySnapshot(target);
  setStatus('Redone to: ' + (lbl || 'Edit'));
}

// Build the status-bar History modal list (redo on top, then undo below).
function renderHistory() {
  const list = $('#history-list');
  if (!list) return;
  list.innerHTML = '';
  const mk = (en, type, idx, dim) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hist-item' + (dim ? ' dim' : '');
    b.textContent = `${type === 'redo' ? '↷ ' : '↶ '}${en.label || 'Edit'}`;
    b.addEventListener('click', () => {
      if (type === 'redo') redoTo(idx);
      else undoTo(idx);
    });
    list.appendChild(b);
  };
  for (let i = redoStack.length - 1; i >= 0; i--) mk(redoStack[i], 'redo', i, true);
  for (let i = undoStack.length - 1; i >= 0; i--) mk(undoStack[i], 'undo', i, false);
}

// Gaps are empty spans on the Clips track. A plain click selects just that gap;
// Ctrl/Cmd+click toggles it to build a multi-gap selection.
function selectGap(gap, addSel) {
  const i = state.selectedGaps.findIndex((g) => g.lane === gap.lane && Math.abs(g.start - gap.start) < 1e-6 && Math.abs(g.end - gap.end) < 1e-6);
  if (addSel) {
    if (i >= 0) state.selectedGaps.splice(i, 1);
    else {
      state.selectedIds.clear(); state.selectedSbs.clear(); state.selectedHyb.clear(); state.selectedMarkers.clear();
      state.selectedGaps.push(gap);
    }
  } else {
    clearSelection();
    state.selectedGaps.push(gap);
  }
  renderTimeline();
}

// addSel = Ctrl/Cmd+click: toggle this item in/out without disturbing the others.
function selectClip(id, addSel) {
  if (addSel) {
    if (state.selectedIds.has(id)) state.selectedIds.delete(id); else state.selectedIds.add(id);
  } else {
    clearSelection();
    state.selectedIds.add(id);
  }
  renderTimeline();
}

function selectSb(id, addSel) {
  if (addSel) {
    if (state.selectedSbs.has(id)) state.selectedSbs.delete(id); else state.selectedSbs.add(id);
  } else {
    clearSelection();
    state.selectedSbs.add(id);
  }
  renderTimeline();
}

function selectHyb(id, addSel) {
  if (addSel) {
    if (state.selectedHyb.has(id)) state.selectedHyb.delete(id); else state.selectedHyb.add(id);
  } else {
    clearSelection();
    state.selectedHyb.add(id);
  }
  renderTimeline();
}

function selectMarker(id, addSel) {
  if (addSel) {
    if (state.selectedMarkers.has(id)) state.selectedMarkers.delete(id); else state.selectedMarkers.add(id);
  } else {
    clearSelection();
    state.selectedMarkers.add(id);
  }
  renderTimeline();
}

// Detach audio & Slow-mo act on a single clip; enable only with exactly one selected.
function soleSelectedClip() {
  if (state.selectedIds.size !== 1) return null;
  const id = state.selectedIds.values().next().value;
  return state.timeline.find((c) => c.id === id) || null;
}

function soleSelectedHybClip() {
  if (state.selectedHyb.size !== 1) return null;
  const id = state.selectedHyb.values().next().value;
  const h = state.hybrid.find((x) => x.id === id);
  return h && h.kind !== 'sound' ? h : null;
}

function soleSelectedClipAny() {
  return soleSelectedClip() || soleSelectedHybClip();
}

function updateToolbar() {
  const item = soleSelectedClipAny();
  $('#btn-detach').disabled = !item || !item.hasAudio;
  const sp = $('#btn-speed');
  sp.disabled = !item || TimelineOps.isStill(item);
  sp.value = item ? String(speedOf(item)) : '1';
  // Framing applies to the whole clip selection (Clips + CLIPS2 lanes).
  const sel = allSelClips();
  const framing = $('#btn-framing');
  const framingLabel = $('#framing-label');
  if (framing) {
    framing.disabled = !sel.length;
    const fits = new Set(sel.map((c) => c.fit || 'blur'));
    framing.value = fits.size === 1 ? fits.values().next().value : '';
  }
  if (framingLabel) framingLabel.textContent = sel.length > 1 ? `Frame (${sel.length})` : 'Frame';

  // Camera effect tools are per-type: a zoom panel and a shake panel; only the one
  // matching the selected effect is shown.
  const selEff = soleSelectedEffect();
  const selZoom = !!(selEff && selEff.type !== 'shake');
  const selShake = !!(selEff && selEff.type === 'shake');
  const zoomSub = document.querySelector('.fx-sub[data-fx="zoom"]');
  const shakeSub = document.querySelector('.fx-sub[data-fx="shake"]');
  if (zoomSub) zoomSub.classList.toggle('hidden', !selZoom);
  if (shakeSub) shakeSub.classList.toggle('hidden', !selShake);
  const poseSel = $('#btn-eff-pose');
  if (poseSel) { poseSel.disabled = !selZoom; poseSel.value = state.effectPose; }
  const ease = $('#btn-zoom-ease');
  const zbg = $('#btn-zoom-bg');
  if (ease) { ease.disabled = !selZoom; ease.textContent = selZoom && selEff.ease === 'linear' ? 'Linear' : 'Smooth'; }
  if (zbg) { zbg.disabled = !selZoom; zbg.textContent = selZoom && selEff.bg === 'blur' ? 'Blur BG' : 'Black BG'; }
  const shAmp = $('#shake-amp');
  const shNum = $('#shake-amp-num');
  const shPct = selShake ? String(Math.round(selEff.amp * 1000) / 10) : '4';
  if (shAmp) { shAmp.disabled = !selShake; if (selShake) shAmp.value = shPct; }
  if (shNum) { shNum.disabled = !selShake; if (selShake) shNum.value = shPct; }
  const fxBtn = $('#btn-fx-toggle');
  if (fxBtn) fxBtn.textContent = state.showEffects ? 'Hide FX' : 'Show FX';
  // A/D hint for the selected item (any type): parked on one of its edges the
  // next matching press goes global (and deselects); otherwise A/D hops start/end.
  const navHint = $('#ad-nav-hint');
  if (navHint) {
    const edges = soleSelectedItemEdges();
    if (edges) {
      const atEdge = Math.abs(state.playhead - edges[0]) < 1e-6 || Math.abs(state.playhead - edges[1]) < 1e-6;
      navHint.classList.remove('hidden');
      navHint.classList.toggle('global', atEdge);
      navHint.textContent = atEdge ? 'A/D: global' : 'A/D: edges';
    } else {
      navHint.classList.add('hidden');
    }
  }

  // Volume (dB) applies to the whole selection — clips and/or sounds, both lanes.
  const selSnd = allSelSounds();
  const volCount = sel.length + selSnd.length;
  const vals = [];
  for (const c of sel) vals.push(c.volume || 0);
  for (const s of selSnd) vals.push(s.volume || 0);
  const volSame = vals.length ? (vals.every((v) => Math.abs(v - vals[0]) < 1e-9) ? vals[0] : null) : null;
  const range = $('#vol-range');
  if (range) {
    range.disabled = !volCount;
    range.value = volSame != null ? String(volSame) : '0';
  }
  const volVal = $('#vol-value');
  if (volVal) volVal.textContent = volSame == null ? '—' : `${volSame > 0 ? '+' : ''}${volSame} dB`;
  const volLabel = $('#vol-label');
  if (volLabel) volLabel.textContent = volCount > 1 ? `Vol (${volCount})` : 'Vol';
  const bs = cutBounds();
  const first = bs.length ? bs[0] : 0;
  const last = bs.length ? bs[bs.length - 1] : 0;
  const total = totalDuration();
  const prev = $('#btn-scrub-prev'), next = $('#btn-scrub-next');
  const start = $('#btn-scrub-start'), end = $('#btn-scrub-end');
  if (prev) prev.disabled = !bs.length || state.playhead <= first + 1e-6;
  if (next) next.disabled = !bs.length || state.playhead >= last - 1e-6;
  if (start) start.disabled = Math.abs(state.playhead) < 1e-6;
  if (end) end.disabled = !(total > 0) || state.playhead >= total - 1e-6;

  // Contextual toolbar: show only the groups that apply to the current selection.
  const hasClips = sel.length > 0;
  const hasSounds = selSnd.length > 0;
  const hasFx = state.selectedEff.size > 0;
  const gClip = document.querySelector('.tl-group[data-tools="clip"]');
  const gAudio = document.querySelector('.tl-group[data-tools="audio"]');
  const gFx = document.querySelector('.tl-group[data-tools="fx"]');
  if (gClip) gClip.classList.toggle('hidden', !hasClips);
  if (gAudio) gAudio.classList.toggle('hidden', !(hasClips || hasSounds));
  if (gFx) gFx.classList.toggle('hidden', !hasFx);
}

// Every cut between pieces: each clip's start (bar the very first) and its end
// (bar the very last), deduped so shared boundaries count once, sorted.
function cutBounds() {
  const total = totalDuration();
  const set = new Set();
  const addEdges = (start, dur) => {
    const st = start || 0;
    const en = st + dur;
    if (st > 1e-6) set.add(st);
    if (en < total - 1e-6) set.add(en);
  };
  for (const it of state.timeline) addEdges(it.start, durOf(it));
  for (const h of state.hybrid) addEdges(hybStartOf(h), hybDurOf(h));      // ALT clips + ALT sounds
  for (const s of state.soundboard) addEdges(s.startTime || 0, sndDur(s)); // SOUND lane
  for (const e of state.effects) addEdges(e.start || 0, Math.max(0, e.dur || 0)); // effect bands
  // Always allow jumping to the very start (00:00.000) and the very end.
  if (total > 1e-6) { set.add(0); set.add(total); }
  return [...set].sort((a, b) => a - b);
}

function jumpToStart() {
  if (state.playing) pausePlay();
  seekPreview(0);
  centerOn(0);
  updateToolbar();
}
function jumpToEnd() {
  if (state.playing) pausePlay();
  const t = totalDuration();
  seekPreview(t);
  centerOn(t);
  updateToolbar();
}

// The [start,end] of the single selected item (clip/sound/transition/effect), or
// null when the selection is empty or spans several items.
function soleSelectedItemEdges() {
  const total = state.selectedIds.size + state.selectedSbs.size + state.selectedHyb.size + state.selectedEff.size;
  if (total !== 1) return null;
  if (state.selectedIds.size) { const c = clipSelection()[0]; return c ? [c.start || 0, (c.start || 0) + durOf(c)] : null; }
  if (state.selectedSbs.size) { const s = soundSelection()[0]; return s ? [s.startTime || 0, (s.startTime || 0) + sndDur(s)] : null; }
  if (state.selectedHyb.size) { const h = hybSelection()[0]; return h ? [hybStartOf(h), hybStartOf(h) + hybDurOf(h)] : null; }
  if (state.selectedEff.size) { const e = effSelection()[0]; return e ? [e.start || 0, effectEnd(e)] : null; }
  return null;
}

// Move the marker in a direction (dir < 0 = back) and preview it.
// With a single item selected (clip, transition, sound, ALT item or effect):
// A goes to its start, D to its end (staying selected). Pressing the key for the
// edge you're already on (A at start, D at end) falls through to the GLOBAL cuts
// AND deselects. So A/D hop between the item's ends while selected, then switch to
// global jumping. Global jumps always deselect. Effects also set the edit pose.
function jumpToCut(dir) {
  if (state.playing) pausePlay();
  const t = state.playhead;
  const bs = cutBounds();
  let target = null;
  let fromGlobal = false;
  const se = soleSelectedItemEdges();
  if (se) {
    const edgeTime = dir > 0 ? se[1] : se[0]; // D -> end, A -> start
    if (Math.abs(t - edgeTime) > 1e-6) {
      target = edgeTime;
      if (soleSelectedEffect()) state.effectPose = dir > 0 ? 'to' : 'from';
    }
  }
  if (target == null) {
    if (dir < 0) {
      for (let i = bs.length - 1; i >= 0; i--) { if (bs[i] < t - 1e-6) { target = bs[i]; break; } }
    } else {
      for (const b of bs) { if (b > t + 1e-6) { target = b; break; } }
    }
    if (target != null) fromGlobal = true;
  }
  if (target == null) { setStatus(dir < 0 ? 'Already at the first cut.' : 'Already at the last cut.'); return; }
  if (fromGlobal && anySelected()) { clearSelection(); renderTimeline(); } // global jumping deselects
  seekPreview(target);
  centerOn(target);
  updateToolbar();
}

// Bring time t into the middle of the visible timeline.
function centerOn(t) {
  const sc = $('#tl-scroll');
  const x = timeToX(t);
  sc.scrollLeft = clamp(x - sc.clientWidth / 2, 0, Math.max(0, sc.scrollWidth - sc.clientWidth));
  updateScrollbar();
}

function detachAudio(item) {
  if (!item.hasAudio) { setStatus('This clip has no audio to detach.'); return; }
  noteEditing();
  snapshot();
  const snd = baseSoundFromItem(item);
  snd.srcStart = item.srcStart;
  snd.srcEnd = item.srcEnd;
  snd.startTime = state.timeline.includes(item) ? (item.start || 0) : hybStartOf(item);
  snd.volume = 0;
  state.soundboard.push(snd);
  item.mute = true;
  commit('Detach audio');
  renderTimeline();
  setStatus('Detached this clip\'s audio onto the SOUND lane.');
}

/* ---------------- markers ---------------- */
function addMarkerAtPlayhead() {
  noteEditing();
  snapshot();
  state.markers.push({ id: newId(), time: state.playhead, label: '' });
  sortMarkers();
  commit('Add marker');
  renderTimeline();
  setStatus('Marker at ' + fmt(state.playhead));
}

/* ---------------- preview ---------------- */
let srcInfo = { id: null, path: null, bIndex: -1, ready: true };   // describes the ACTIVE (visible) preview element
let srcB = { id: null, path: null, bIndex: -1, ready: false };     // describes the hidden standby element

// Only write playbackRate when it actually changes — a redundant write while
// playing can itself cause a micro-stall.
function setRate(el, item) {
  const s = speedOf(item);
  if (Math.abs(el.playbackRate - s) > 1e-6) el.playbackRate = s;
}

/* ---- Web Audio preview gain -------------------------------------------------
   HTML media.volume caps at 1 (0 dB), so boosts above 0 dB can't be previewed
   through the element itself. Routing the program videos and sound-lane <audio>
   through a GainNode makes the preview actually sound like the exported dB. */
let audioCtx = null;
const mediaGains = new Map(); // media element -> GainNode

function ensureMediaGain(el) {
  if (!el) return null;
  if (mediaGains.has(el)) return mediaGains.get(el) || null;
  try {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    const src = audioCtx.createMediaElementSource(el);
    const g = audioCtx.createGain();
    src.connect(g);
    g.connect(audioCtx.destination);
    mediaGains.set(el, g);
    return g;
  } catch (_) { return null; }
}

function resumeAudio() {
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
}

// Set a media element's gain in dB. Web Audio lets >0 dB boost; falls back to
// the clamped element volume if Web Audio is unavailable.
function setMediaGain(el, db) {
  if (!el) return;
  const g = ensureMediaGain(el);
  const lin = Math.min(Math.pow(10, db / 20), 10);
  if (g) {
    try { g.gain.setTargetAtTime(lin, audioCtx.currentTime, 0.01); }
    catch (_) { g.gain.value = lin; }
  } else {
    try { el.volume = Math.min(1, Math.pow(10, db / 20)); } catch (_) {}
  }
}

// ---- Camera effects (adjustment layers) -----------------------------------
// state.effects items warp the visible output. TimelineOps.effectPoseAt owns the
// maths (shared with export). A pose is { z, cx, cy }: z scales the frame and
// (cx,cy) is the source point held at the frame centre.
const IDENTITY_POSE = { z: 1, cx: 0.5, cy: 0.5 };

function cameraPoseAt(t) { return TimelineOps.effectPoseAt(state.effects, t); }

// The time the PREVIEW evaluates the pose at. While PLAYING we read the active
// video's live currentTime (which advances every frame) instead of state.playhead
// (HTML5 `timeupdate` only fires ~4x/s) - otherwise zoom/shake would animate in
// ~4 steps/sec. When paused we use the playhead. Effects are bounded (t < end), so
// when a selected effect's end sits exactly on t we evaluate a hair inside the
// band: the playhead/marker stays exactly on the cut while the end pose is shown.
// Display-only - export is unaffected.
function previewPoseTime() {
  let t = state.playhead;
  if (state.playing) {
    const el = $('#preview');
    const seg = videoSegments()[srcInfo.bIndex];
    if (el && seg && !TimelineOps.isStill(seg.item) && !el.paused) t = seg.start + (el.currentTime - seg.srcStart) / speedOf(seg.item);
  }
  const eff = soleSelectedEffect();
  if (eff) {
    const end = (eff.start || 0) + Math.max(0, eff.dur || 0);
    if (Math.abs(t - end) < 1e-6 && end - (eff.start || 0) > 1e-4) return end - 1e-4;
  }
  return t;
}

// Keep touching Zoom effects continuous: when A's end meets B's start, B begins
// from where A ended (no camera jump).
function linkAdjacentZoomPoses() {
  const zooms = state.effects
    .filter((e) => e.type !== 'shake' && e.from && e.to)
    .sort((a, b) => (a.start || 0) - (b.start || 0));
  for (let i = 0; i < zooms.length - 1; i++) {
    const A = zooms[i], B = zooms[i + 1];
    const aEnd = (A.start || 0) + Math.max(0, A.dur || 0);
    if (Math.abs(aEnd - (B.start || 0)) < 1e-3) B.from = { ...A.to };
  }
}

// The effect that governs the pose at t (active bands only; effects are bounded).
function governingEffectAt(t) {
  const act = state.effects.filter((e) => t >= (e.start || 0) && t < (e.start || 0) + (e.dur || 0));
  if (!act.length) return null;
  return act.reduce((a, b) => ((a.start || 0) > (b.start || 0) ? a : b));
}

// Paint the resolved camera pose on the preview (translate+scale about the top
// left — exactly the export overlay math) plus the pose HUD while editing.
function updatePreviewZoomTransform() {
  const el = $('#preview');
  const still = $('#preview-still');
  const cross = $('#zoom-cross');
  const hud = $('#zoom-hud');
  if (!el) return;
  const targets = [el, still].filter(Boolean);
  const pose = cameraPoseAt(previewPoseTime());
  const isId = Math.abs(pose.z - 1) < 1e-6 && Math.abs(pose.cx - 0.5) < 1e-6 && Math.abs(pose.cy - 0.5) < 1e-6;
  if (isId) {
    for (const n of targets) { if (n.style.transform) { n.style.transform = ''; n.style.transformOrigin = ''; } }
    if (cross) cross.classList.add('hidden');
    if (hud) hud.classList.add('hidden');
    return;
  }
  const stage = document.querySelector('.preview-stage');
  const r = stage ? stage.getBoundingClientRect() : { width: el.clientWidth || 1, height: el.clientHeight || 1 };
  const Wd = Math.max(1, r.width), Hd = Math.max(1, r.height);
  const tx = Wd / 2 - pose.cx * Wd * pose.z;
  const ty = Hd / 2 - pose.cy * Hd * pose.z;
  for (const n of targets) {
    n.style.transformOrigin = '0 0';
    n.style.transform = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${pose.z})`;
  }
  const editing = state.viewer.mode === 'program' && soleSelectedEffect();
  if (editing && cross && hud) {
    cross.classList.remove('hidden');
    hud.classList.remove('hidden');
    cross.style.left = '50%';
    cross.style.top = '50%';
    hud.textContent = `${Math.round(pose.z * 100)}%`;
  } else {
    if (cross) cross.classList.add('hidden');
    if (hud) hud.classList.add('hidden');
  }
}

// Per-frame refresh while the program plays (HTML5 timeupdate is only ~4 Hz).
let zoomLoopActive = false;
let zoomFrameCb = 0;
function anyEffects() { return state.effects.length > 0; }
function startZoomLoop() {
  stopZoomLoop();
  if (!anyEffects()) return;
  const el = $('#preview');
  if (!el) return;
  zoomLoopActive = true;
  const step = () => {
    if (!zoomLoopActive) return;
    updatePreviewZoomTransform();
    zoomFrameCb = el.requestVideoFrameCallback ? el.requestVideoFrameCallback(step) : requestAnimationFrame(step);
  };
  zoomFrameCb = el.requestVideoFrameCallback ? el.requestVideoFrameCallback(step) : requestAnimationFrame(step);
}
function stopZoomLoop() {
  zoomLoopActive = false;
  const el = $('#preview');
  if (zoomFrameCb) {
    if (el && el.cancelVideoFrameCallback) el.cancelVideoFrameCallback(zoomFrameCb);
    else cancelAnimationFrame(zoomFrameCb);
  }
  zoomFrameCb = 0;
}

// 1:1 pan of a pose by a pointer delta (inverse of the preview scale).
function panPoseBy(pose, dxPx, dyPx, z) {
  const stage = document.querySelector('.preview-stage');
  const r = stage ? stage.getBoundingClientRect() : { width: 1, height: 1 };
  const zz = Math.max(0.01, z || 1);
  pose.cx = clamp(pose.cx - dxPx / (Math.max(1, r.width) * zz), 0, 1);
  pose.cy = clamp(pose.cy - dyPx / (Math.max(1, r.height) * zz), 0, 1);
}

// The pose a scroll/drag on the preview should edit ('to' = End, 'from' = Start).
// Shake effects have no editable pose, so this returns null for them.
function editTargetPose() {
  const eff = soleSelectedEffect();
  if (!eff || eff.type === 'shake' || !eff.from || !eff.to) return null;
  return state.effectPose === 'from' ? eff.from : eff.to;
}

// Wheel / drag bursts: snapshot once, commit when the gesture goes idle.
let zoomEditSnapPending = false;
let zoomEditTimer = 0;
function zoomEditTouch(label) {
  if (!zoomEditSnapPending) { snapshot(); zoomEditSnapPending = true; }
  clearTimeout(zoomEditTimer);
  zoomEditTimer = setTimeout(() => {
    zoomEditSnapPending = false;
    commit(label || 'Effect');
    renderTimeline();
    updateToolbar();
  }, 450);
}

/* ---- Effect creation / rendering ----------------------------------------- */
function sortEffects() { state.effects.sort((a, b) => (a.start || 0) - (b.start || 0)); }
function makeEffect(defId, lane, start) {
  const def = EFFECT_DEFS.find((d) => d.defId === defId) || EFFECT_DEFS[0];
  const base = {
    id: newId(), defId: def.defId, name: def.name,
    lane: lane === 'hybrid' ? 'hybrid' : 'clips', start, dur: EFFECT_DUR_DEFAULT,
  };
  if (def.type === 'shake') {
    return {
      ...base, type: 'shake',
      amp: def.amp, freq: def.freq, decay: def.decay !== false, axes: def.axes || 'both',
      seed: Math.floor(Math.random() * 90000) + 1,
    };
  }
  const prev = state.effects.filter((e) => e.type !== 'shake' && (e.start || 0) < start)
    .sort((a, b) => (a.start || 0) - (b.start || 0)).pop();
  const from = def.from ? { ...def.from } : (prev && prev.to ? { ...prev.to } : { ...IDENTITY_POSE });
  return { ...base, type: 'zoom', from, to: { ...(def.to || IDENTITY_POSE) }, ease: 'smooth', bg: 'black' };
}
function addEffect(defId, lane, start) {
  noteEditing();
  snapshot();
  const eff = makeEffect(defId, lane, Math.max(-PREROLL, start));
  state.effects.push(eff);
  sortEffects();
  linkAdjacentZoomPoses();
  clearSelection();
  state.selectedEff.add(eff.id);
  commit(`Add ${eff.name}`);
  renderTimeline();
  setStatus(eff.type === 'shake'
    ? `${eff.name} added — drag/extend the band over the moment to shake.`
    : `${eff.name} added — extend/push the band, then scroll the preview to zoom and drag to pan.`);
  return eff;
}
function selectEff(id, addSel) {
  if (addSel) {
    if (state.selectedEff.has(id)) state.selectedEff.delete(id); else state.selectedEff.add(id);
  } else {
    clearSelection();
    state.selectedEff.add(id);
  }
  renderTimeline();
}
function startEffectMoveDrag(e, ev) {
  drag = { type: 'effmove', id: e.id, downT: timeAtClientX(ev), start0: e.start || 0 };
  ev.preventDefault();
}
function startEffectTrimDrag(e, edge, ev) {
  drag = { type: 'efftrim', id: e.id, edge, downT: timeAtClientX(ev), start0: e.start || 0, dur0: e.dur || 0 };
  ev.preventDefault();
}

// Draw the purple effect bands for one lane (overlay on top of the clips).
function renderEffects(body, lane) {
  if (!state.showEffects) return;
  for (const e of state.effects) {
    if (e.lane !== lane) continue;
    const block = document.createElement('div');
    block.className = 'effectband' + (state.selectedEff.has(e.id) ? ' selected' : '');
    block.style.left = laneX(e.start || 0) + 'px';
    block.style.width = Math.max(6, (e.dur || 0) * state.pps) + 'px';
    block.title = e.type === 'shake'
      ? `${e.name} · ${Math.round(e.amp * 1000) / 10}% · ${e.freq} Hz`
      : `${e.name}: ${e.from.z.toFixed(2)}× → ${e.to.z.toFixed(2)}×`;
    const head = document.createElement('div');
    head.className = 'effectband-head';
    head.textContent = e.type === 'shake' ? e.name : e.name.replace(/^Zoom /, 'Z ');
    block.appendChild(head);
    const hl = document.createElement('div'); hl.className = 'effect-handle l';
    hl.title = 'Extend left';
    hl.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); startEffectTrimDrag(e, 'l', ev); });
    const hr = document.createElement('div'); hr.className = 'effect-handle r';
    hr.title = 'Extend right';
    hr.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); startEffectTrimDrag(e, 'r', ev); });
    block.append(hl, hr);
    block.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      ev.stopPropagation();
      if (isDoubleDown('e' + e.id)) { selectEff(e.id, false); deleteSelection(); ev.preventDefault(); return; }
      if (ev.ctrlKey || ev.metaKey) { selectEff(e.id, true); ev.preventDefault(); return; }
      if (!state.selectedEff.has(e.id)) selectEff(e.id, false);
      snapshot();
      startEffectMoveDrag(e, ev);
      ev.preventDefault();
    });
    body.appendChild(block);
  }
}

// --- Effects panel (fixed tiles; drag onto a video lane) ---
function renderEffectsBin() {
  const list = $('#effects-list');
  if (!list) return;
  list.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'effects-grid';
  // Freeze frame is an action (not a draggable camera effect): click it to
  // insert a 3s still at the playhead, splitting the clip underneath if needed.
  const fz = document.createElement('div');
  fz.className = 'effect-tile freeze-tile';
  fz.id = 'effect-freeze';
  fz.title = 'Insert a 3s freeze frame at the playhead';
  const fzi = document.createElement('span'); fzi.className = 'effect-tile-icon'; fzi.textContent = '❄';
  const fzn = document.createElement('span'); fzn.className = 'effect-tile-name'; fzn.textContent = 'Freeze';
  fz.append(fzi, fzn);
  fz.addEventListener('click', () => insertFreeze());
  grid.appendChild(fz);
  const defs = EFFECT_DEFS.slice().sort((a, b) => {
    const dr = ratingOf(effectLibKey(b.defId)) - ratingOf(effectLibKey(a.defId));
    return dr || a.name.localeCompare(b.name);
  });
  for (const def of defs) {
    const card = document.createElement('div');
    card.className = 'effect-tile';
    card.draggable = true;
    card.title = `Drag onto a MAIN/ALT lane to add ${def.name}`;
    const ic = document.createElement('span'); ic.className = 'effect-tile-icon'; ic.textContent = '◎';
    const nm = document.createElement('span'); nm.className = 'effect-tile-name'; nm.textContent = def.name;
    const rating = ratingOf(effectLibKey(def.defId));
    card.append(ic, nm);
    if (rating) {
      const st = document.createElement('span');
      st.className = 'effect-tile-stars';
      st.textContent = '★'.repeat(rating);
      card.append(st);
    }
    card.addEventListener('dragstart', (e) => {
      const payload = JSON.stringify({ kind: 'effects', items: [{ defId: def.defId, name: def.name, duration: EFFECT_DUR_DEFAULT }] });
      e.dataTransfer.setData('application/x-clipmerger', payload);
      e.dataTransfer.setData('text/plain', payload);
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setDragImage(emptyDragImage(), 0, 0);
      buildDragCard(card, e, 1);
      binDragActive = true;
      pendingDrag = { kind: 'effects', items: [{ defId: def.defId, name: def.name, duration: EFFECT_DUR_DEFAULT }] };
    });
    card.addEventListener('dblclick', () => addEffect(def.defId, 'clips', state.playhead));
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openContextMenu({
        x: e.clientX,
        y: e.clientY,
        title: def.name,
        rating: ratingOf(effectLibKey(def.defId)),
        onRate: async (n) => { await setRating(effectLibKey(def.defId), n); renderEffectsBin(); },
      });
    });
    grid.appendChild(card);
  }
  list.appendChild(grid);
  updateFreezeButton();
}

// Reflect the active clip's Mute and framing (fit) onto the 9:16 program preview.
// Blur shows a real blurred, scaled copy behind the centered whole frame (so the
// preview matches the export); Fill & crop fills the stage with object-fit cover.
function syncActiveMute() {
  const el = $('#preview');
  const seq = videoSegments();
  const idx = srcInfo.bIndex;
  const item = idx >= 0 && idx < seq.length ? seq[idx].item : null;
  if (!el) return;
  const fit = item ? (item.fit || 'blur') : 'blur';
  const program = $('#viewer-program');
  const bg = $('#preview-bg');
  const stillImg = $('#preview-still');
  const stillBg = $('#preview-bg-still');
  const image = !!(item && isImageItem(item));
  const camPose = cameraPoseAt(previewPoseTime());
  const gov = governingEffectAt(previewPoseTime());
  const camActive = gov && (Math.abs(camPose.z - 1) > 1e-6 || Math.abs(camPose.cx - 0.5) > 1e-6 || Math.abs(camPose.cy - 0.5) > 1e-6);

  if (image) {
    // A still has no video element to play. Show the centered image (plus a
    // blurred fill copy when framing is "whole frame + blur bg").
    const url = api.toFileUrl(item.path);
    if (stillImg) {
      if (stillImg.dataset.path !== url) { stillImg.dataset.path = url; stillImg.src = url; }
      stillImg.classList.remove('hidden');
      stillImg.style.objectFit = (camActive || fit === 'cover') ? 'cover' : 'contain';
    }
    if (stillBg) {
      if (stillBg.dataset.path !== url) { stillBg.dataset.path = url; stillBg.src = url; }
      stillBg.classList.toggle('hidden', !(fit === 'blur' || (gov && gov.bg === 'blur' && camPose.z < 1)));
    }
    el.classList.add('hidden');
    try { el.pause(); } catch (_) {}
    if (program) program.classList.remove('bg-on');
    if (bg) { try { bg.pause(); } catch (_) {} bg.removeAttribute('src'); }
    el.muted = true;
    setMediaGain(el, -120);
    setMediaGain($('#preview-b'), -120);
    updatePreviewZoomTransform();
    return;
  }

  if (stillImg) stillImg.classList.add('hidden');
  if (stillBg) stillBg.classList.add('hidden');
  el.classList.remove('hidden');
  el.muted = !!(item && item.mute);
  if (fit === 'cover') {
    el.style.objectFit = 'cover';
    if (program) program.classList.remove('bg-on');
    if (bg) { try { bg.pause(); } catch (_) {} bg.removeAttribute('src'); bg.currentTime = 0; }
  } else {
    el.style.objectFit = 'contain';
    if (program) program.classList.add('bg-on');
    if (bg) {
      const url = el.currentSrc || el.src || '';
      if (bg.getAttribute('src') !== url && url) { bg.currentTime = 0; bg.src = url; }
      try { bg.currentTime = el.currentTime; } catch (_) {}
      if (!el.paused) bg.play().catch(() => {});
    }
  }
  // Audio: active element plays at the clip's dB (mute → silence); standby silent.
  setMediaGain(el, (item && item.mute) ? -120 : (item ? (item.volume || 0) : 0));
  setMediaGain($('#preview-b'), -120);
  // Camera effect: force the "fill & crop" base so the preview frame equals the
  // export frame, and show the effect's background when the pose is below 100%.
  if (camActive) {
    el.style.objectFit = 'cover';
    if (program) {
      if (gov.bg === 'blur' && camPose.z < 1) {
        program.classList.add('bg-on');
        if (bg) {
          const url = el.currentSrc || el.src || '';
          if (bg.getAttribute('src') !== url && url) { bg.currentTime = 0; bg.src = url; }
          try { bg.currentTime = el.currentTime; } catch (_) {}
          if (!el.paused) bg.play().catch(() => {});
        }
      } else {
        program.classList.remove('bg-on');
      }
    }
  }
  updatePreviewZoomTransform();
}

// Keep the blurred backdrop frame-locked to the foreground while scrubbing/playing.
function syncPreviewBgTime(t) {
  const program = $('#viewer-program');
  const bg = $('#preview-bg');
  if (program && program.classList.contains('bg-on') && bg) {
    try { bg.currentTime = t; } catch (_) {}
  }
}

// ---- Preview proxy (all-keyframe low-res copy) -----------------------------
// Long-GOP sources make the shuttle decode hundreds of frames per scrub step. A
// tiny all-keyframe copy makes each step ~1 frame; the main process builds it in
// the background on first sight and we prefer it for PREVIEW only — export always
// re-reads the original path, so exported quality is untouched.
const previewProxy = new Map();      // original path -> proxy file path (ready)
const previewRequested = new Set();  // original path -> a build was already asked for

function requestPreviewProxy(path) {
  if (!path || previewProxy.has(path) || previewRequested.has(path)) return;
  previewRequested.add(path);
  api.preview({
    ffmpegPath: state.settings.ffmpegPath,
    ffprobePath: state.settings.ffprobePath,
    file: path,
  }).then((res) => {
    if (res && res.ok && res.ready && res.file) { previewProxy.set(path, res.file); onProxyReady(path); }
    else if (res && res.ok === false) { previewRequested.delete(path); }
  }).catch(() => { previewRequested.delete(path); });
}

// URL for a preview <video>: the low-res copy when available, otherwise the
// original (and we kick off the background build for next time).
function previewUrlFor(path) {
  const proxy = previewProxy.get(path);
  if (proxy) return api.toFileUrl(proxy);
  requestPreviewProxy(path);
  return api.toFileUrl(path);
}

// Build finished for the clip on screen while parked → silently swap to it so the
// next scrub is fast. Never interrupts playback, a drag, or an in-flight seek.
function onProxyReady(path) {
  const el = $('#preview');
  if (!el || srcInfo.path !== path || !srcInfo.ready) return;
  if (state.playing || drag || el.seeking) return;
  const url = previewUrlFor(path);
  if (el.currentSrc === url) return;
  const t = el.currentTime || 0;
  const onMeta = () => { el.removeEventListener('loadedmetadata', onMeta); try { el.currentTime = t; } catch (_) {} };
  el.addEventListener('loadedmetadata', onMeta);
  el.src = url;
}

// Build proxies for every clip on the timeline (serialized in the main process) so
// the whole timeline scrubs smoothly, not just the clip currently in view.
function warmPreviewProxies() {
  const seen = new Set();
  for (const it of state.timeline) if (it && it.path && !TimelineOps.isStill(it) && !seen.has(it.path)) { seen.add(it.path); requestPreviewProxy(it.path); }
  for (const it of state.hybrid) if (it && it.kind !== 'sound' && it.path && !TimelineOps.isStill(it) && !seen.has(it.path)) { seen.add(it.path); requestPreviewProxy(it.path); }
}

// Cache the loaded source by its FILE PATH (not the clip id): pieces cut from the
// same file just seek instead of reloading, so playback is seamless through splits.
function ensureLoaded(item, idx, el, info) {
  el = el || $('#preview');
  info = info || srcInfo;
  if (info.path === item.path && info.ready) {
    info.id = item.id;
    info.bIndex = idx;
    return Promise.resolve();
  }
  info.id = item.id;
  info.path = item.path;
  info.bIndex = idx;
  info.ready = false;
  if (el === $('#preview')) $('#preview-empty').classList.add('hidden');
  return new Promise((resolve) => {
    const done = () => { info.ready = true; el.removeEventListener('loadedmetadata', done); resolve(); };
    el.addEventListener('loadedmetadata', done);
    el.src = previewUrlFor(item.path);
  });
}

// Pre-load the NEXT different file into the hidden standby element while the
// current piece plays, so a cross-file join can swap instead of reloading.
let prefetchEpoch = 0;
function prefetchStandby(nextIdx) {
  const epoch = ++prefetchEpoch;
  const b = $('#preview-b');
  const seq = videoSegments();
  const seg = (state.playing && nextIdx != null && nextIdx >= 0 && nextIdx < seq.length)
    ? seq[nextIdx] : null;
  const target = seg ? seg.item : null;
  if (!target || target.path === srcInfo.path || TimelineOps.isStill(target)) {
    try { b.pause(); } catch (_) {}
    b.removeAttribute('src');
    srcB = { id: null, path: null, bIndex: -1, ready: false };
    return;
  }
  if (srcB.bIndex === nextIdx && srcB.path === target.path && srcB.ready) return; // already ready
  if (srcB.bIndex === nextIdx && srcB.path === target.path) return;               // still loading the same target
  const done = () => {
    if (epoch !== prefetchEpoch) return;
    srcB = { id: target.id, path: target.path, bIndex: nextIdx, ready: true };
    try {
      b.muted = true;
      b.playbackRate = speedOf(target);
      b.currentTime = seg.srcStart;
      // Nudge the media pipeline so the first frames are buffered/decoded before
      // the swap — a paused, hidden element can otherwise sit at readyState 1,
      // which re-introduces a stall when the big network file is finally shown.
      const pr = b.play();
      if (pr && pr.then) pr.then(() => {
        if (epoch !== prefetchEpoch || b !== $('#preview-b')) return; // swapped in or cancelled
        try { b.pause(); b.currentTime = seg.srcStart; } catch (_) {}
      }).catch(() => {});
    } catch (_) {}
  };
  b.removeEventListener('loadedmetadata', done);
  b.addEventListener('loadedmetadata', done);
  srcB = { id: null, path: target.path, bIndex: nextIdx, ready: false };
  b.src = previewUrlFor(target.path);
}

// The standby swap: exchange which video element is visible. The visible one
// always keeps the "preview" id, so every other call site keeps working.
function swapPreview() {
  const a = $('#preview');
  const b = $('#preview-b');
  try { a.pause(); } catch (_) {}
  a.muted = true;
  b.id = 'preview';
  a.id = 'preview-b';
  const tmp = srcInfo; srcInfo = srcB; srcB = tmp;
  srcInfo.ready = true;
  srcB.ready = false;
  syncActiveMute();
}

// Clear the standby element (project load, empty timeline, …).
function clearStandby() {
  prefetchEpoch++;
  $('#preview-b').pause();
  $('#preview-b').removeAttribute('src');
  const bg = $('#preview-bg');
  if (bg) { try { bg.pause(); } catch (_) {} bg.removeAttribute('src'); }
  const program = $('#viewer-program');
  if (program) program.classList.remove('bg-on');
  srcB = { id: null, path: null, bIndex: -1, ready: false };
  clearStillPreview();
}

// Hide the still overlay(s) and let the video element show again.
function clearStillPreview() {
  for (const id of ['#preview-still', '#preview-bg-still']) {
    const el = $(id);
    if (!el) continue;
    el.classList.add('hidden');
    el.removeAttribute('src');
    el.dataset.path = '';
  }
  const v = $('#preview');
  if (v) v.classList.remove('hidden');
}

// ---- Preview seek queue ---------------------------------------------------
// Chromium *restarts* an in-flight seek the moment `currentTime` is assigned
// again. The drag fires seekPreview at mouse-polling rate (60-125 Hz), far
// faster than a decode completes, so every jump was cancelled by the next one
// and the picture never caught up with the marker. Rule: one seek at a time,
// issued only after the previous one reported `seeked`, always retargeting to
// the newest position (stale intermediate stops are skipped, not raced).
let seekBusy = false;    // a jump is in flight
let seekPending = null;  // { el, t } newest position waiting its turn
let seekTimer = 0;       // watchdog: a wedged seek must not lock the pipeline
let seekEl = null, seekOnDone = null;

function cancelPreviewSeek() {
  clearTimeout(seekTimer); seekTimer = 0;
  if (seekEl && seekOnDone) seekEl.removeEventListener('seeked', seekOnDone);
  seekEl = seekOnDone = null;
  seekBusy = false;
  seekPending = null;
}

function pumpPreviewSeek() {
  if (seekBusy || !seekPending) return;
  const { el, t } = seekPending;
  seekPending = null;
  if (!el.isConnected) { pumpPreviewSeek(); return; }
  if (Math.abs(el.currentTime - t) < 1e-4) { pumpPreviewSeek(); return; } // already on it
  seekBusy = true;
  seekEl = el;
  const started = Date.now();
  let timer = 0;
  const done = () => {
    if (seekOnDone !== done) return; // superseded: a late fire from an old seek
    clearTimeout(timer);
    el.removeEventListener('seeked', done);
    seekOnDone = null; seekEl = null;
    seekBusy = false;
    syncPreviewBgTime(el.currentTime); // backdrop advances only once a frame landed
    pumpPreviewSeek();                 // newest target next; the skipped ones are stale
  };
  // Watchdog, deliberately NOT a fixed deadline: a long-GOP 4K seek can legitimately
  // take longer than any fixed timeout, and starting a new seek mid-decode is the
  // exact bug we are fixing. Re-arm while the element is still seeking; only bail
  // out if it never reports done (element unloaded / seek truly stuck).
  const tick = () => {
    if (seekOnDone !== done) return;
    if (el.seeking === false) { done(); return; }
    if (Date.now() - started > 5000) { done(); return; }
    timer = setTimeout(tick, 100);
  };
  seekOnDone = done;
  el.addEventListener('seeked', done);
  timer = setTimeout(tick, 100);
  seekTimer = timer;
  try { el.currentTime = t; } catch (_) { done(); }
}

function requestPreviewSeek(t) {
  const el = $('#preview');
  if (!el) return;
  if (state.playing) { // playback drives the element itself: keep today's
    cancelPreviewSeek(); // behaviour and drop any stale scrub seek
    try { el.currentTime = t; } catch (_) {}
    syncPreviewBgTime(el.currentTime);
    return;
  }
  seekPending = { el, t };
  pumpPreviewSeek();
}

let seekSeq = 0; // seekPreview calls superseded while they waited on a load
async function seekPreview(t) {
  noteEditing(); // using the timeline returns the viewer to the program output
  resumeAudio();
  t = Math.max(-PREROLL, Math.min(playheadMax(), t));
  state.playhead = t;
  updatePlayhead(); // marker + scrub indicator track the drag immediately
  updateTimeReadout();
  if (state.playing) syncSoundPreview(true); // re-sync sounds after a seek during playback
  const bk = visibleVideoAt(t);
  if (!bk) { if (!state.playing) stopStillPlayback(); return; }
  const wasStill = stillIdx >= 0;
  if (TimelineOps.isStill(bk.item)) {
    if (state.playing) { await beginStillSegment(bk.seg, bk.index, t); return; }
    stopStillPlayback();
    if (isImageItem(bk.item)) {
      srcInfo = { id: bk.item.id, path: bk.item.path, bIndex: bk.index, ready: true };
      syncActiveMute();
      return;
    }
    const seqNo = ++seekSeq;
    try { await ensureLoaded(bk.item, bk.index); } catch (_) { return; }
    if (seqNo !== seekSeq) return;
    const fv = $('#preview');
    if (!fv) return;
    try { fv.pause(); } catch (_) {}
    fv.playbackRate = 1;
    try { fv.currentTime = bk.item.freezeAt || 0; } catch (_) {}
    syncActiveMute();
    return;
  }
  if (wasStill && state.playing) { await beginVideoSegment(bk.seg, bk.index); return; }
  if (!state.playing) stopStillPlayback();
  const seq = ++seekSeq;
  try {
    await ensureLoaded(bk.item, bk.index);
  } catch (_) { return; }
  if (seq !== seekSeq) return; // a newer seek arrived while we waited for the load
  const v = $('#preview');
  if (!v) return;
  v.playbackRate = speedOf(bk.item);
  syncActiveMute();
  requestPreviewSeek(bk.seg.srcStart + bk.local * speedOf(bk.item));
}

function setPlayIcon(playing) {
  const use = $('#use-play');
  if (use) use.setAttribute('href', playing ? '#i-pause' : '#i-play');
  const btn = $('#btn-play');
  if (btn) btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

async function togglePlay() {
  noteEditing(); // pressing play/editing ends a non-split media preview
  resumeAudio();
  if (!state.timeline.length && !state.hybrid.length && !state.soundboard.length) return;
  const v = $('#preview');
  if (state.playing) { pausePlay(); return; }
  if (state.playhead >= totalDuration() - 1e-6) await seekPreview(0);
  let b = visibleVideoAt(state.playhead);
  if (!b) {
    // In a gap: jump to the NEXT clip ahead (not the first one), so Play starts
    // where the content resumes. Past the last clip -> no footage, tail mode.
    const segs = videoSegments();
    const next = segs.find((s) => s.start >= state.playhead - 1e-6);
    if (next) await seekPreview(next.start);
    b = visibleVideoAt(state.playhead);
  }
  state.playing = true;
  setPlayIcon(true);
  if (!b) {
    // no footage under the marker (sounds-only project, or past the last clip):
    // just run the clock so the sound lane is audible.
    syncSoundPreview(true);
    startMonitor(true);
    return;
  }
  if (TimelineOps.isStill(b.item)) {
    // Images and freeze frames hold their frame while the still clock runs.
    syncSoundPreview(true);
    await beginStillSegment(b.seg, b.index, state.playhead);
    startZoomLoop();
    return;
  }
  syncSoundPreview(true); // start the sound lane immediately with the video
  await ensureLoaded(b.item, b.index);
  cancelPreviewSeek(); // a queued scrub jump must not fight the playhead jump
  v.playbackRate = speedOf(b.item);
  v.currentTime = b.seg.srcStart + b.local * speedOf(b.item);
  syncActiveMute();
  await v.play().catch(() => {});
  const bg = $('#preview-bg');
  if (bg && document.getElementById('viewer-program').classList.contains('bg-on')) bg.play().catch(() => {});
  startMonitor(false); // tick the sound lane as the video plays
  startZoomLoop();      // per-frame zoom glide (instead of the ~4 Hz timeupdate)
  prefetchStandby(b.index + 1); // stage the next different file while this piece plays
}

function pausePlay() {
  state.playing = false;
  setPlayIcon(false);
  stopZoomLoop();
  stopStillPlayback();
  $('#preview').pause();
  try { $('#preview-b').pause(); } catch (_) {}
  try { $('#preview-bg').pause(); } catch (_) {}
  stopMonitor();
  pauseSoundEls();
}

/* ---- still playback (images & freeze frames) ----
   A still has no `<video>` to drive the clock, so playback runs its own
   wall-clock rAF that advances the playhead across the segment's span, then
   hands off to whatever comes next (still or video) instead of dead-ending. */
let stillRaf = 0;
let stillIdx = -1;
function stopStillPlayback() {
  if (stillRaf) { cancelAnimationFrame(stillRaf); stillRaf = 0; }
  stillIdx = -1;
}
function startStillPlayback(idx, from) {
  stopMonitor();
  if (stillRaf) { cancelAnimationFrame(stillRaf); stillRaf = 0; }
  const seq = videoSegments();
  const seg = seq[idx];
  if (!seg) { stopStillPlayback(); return; }
  stillIdx = idx;
  const startT = Math.max(seg.start, Math.min(seg.end, from));
  state.playhead = startT;
  const t0 = performance.now();
  let lastSound = 0;
  const tick = () => {
    if (!state.playing || stillIdx !== idx) { stillRaf = 0; return; }
    const now = performance.now();
    const t = Math.min(seg.end, startT + (now - t0) / 1000);
    state.playhead = t;
    updatePlayhead();
    updateTimeReadout();
    updatePreviewZoomTransform();
    if (now - lastSound > 90) { lastSound = now; syncSoundPreview(false); }
    if (t >= seg.end - 1e-6) { stillRaf = 0; advanceStillPlayback(idx); return; }
    stillRaf = requestAnimationFrame(tick);
  };
  stillRaf = requestAnimationFrame(tick);
}
async function beginStillSegment(seg, idx, from) {
  if (!seg) return;
  stopMonitor();
  const item = seg.item;
  state.playhead = Math.max(seg.start, Math.min(seg.end, from == null ? seg.start : from));
  if (isImageItem(item)) {
    srcInfo = { id: item.id, path: item.path, bIndex: idx, ready: true };
    try { $('#preview').pause(); } catch (_) {}
    syncActiveMute();
    syncSoundPreview(false);
    startStillPlayback(idx, state.playhead);
    return;
  }
  // Freeze frame: load the source and hold one frame, then run the still clock.
  try { await ensureLoaded(item, idx); } catch (_) { return; }
  cancelPreviewSeek();
  const v = $('#preview');
  if (v) {
    try { v.pause(); } catch (_) {}
    v.playbackRate = 1;
    try { v.currentTime = item.freezeAt || 0; } catch (_) {}
  }
  srcInfo = { id: item.id, path: item.path, bIndex: idx, ready: true };
  syncActiveMute();
  syncSoundPreview(false);
  startStillPlayback(idx, state.playhead);
}
async function beginVideoSegment(seg, idx) {
  if (!seg) return;
  stopStillPlayback();
  const item = seg.item;
  state.playhead = seg.start;
  try { await ensureLoaded(item, idx); } catch (_) { return; }
  cancelPreviewSeek();
  const v = $('#preview');
  if (!v) return;
  v.playbackRate = speedOf(item);
  v.currentTime = seg.srcStart;
  syncActiveMute();
  syncPreviewBgTime(v.currentTime);
  syncSoundPreview(false);
  startMonitor(false);
  startZoomLoop();
  prefetchStandby(idx + 1);
  await v.play().catch(() => {});
  const bg = $('#preview-bg');
  if (bg && document.getElementById('viewer-program').classList.contains('bg-on')) bg.play().catch(() => {});
}
function advanceStillPlayback(idx) {
  const seq = videoSegments();
  const cur = seq[idx];
  const next = seq[idx + 1];
  if (next) {
    if (TimelineOps.isStill(next.item)) beginStillSegment(next, idx + 1, next.start);
    else beginVideoSegment(next, idx + 1);
    return;
  }
  if (cur && totalDuration() > cur.end + 1e-6) {
    state.playhead = cur.end;
    updatePlayhead(); updateTimeReadout();
    syncSoundPreview(true);
    startMonitor(true);
    return;
  }
  state.playhead = totalDuration();
  updatePlayhead(); updateTimeReadout();
  pausePlay();
}

/* ---------------- mic recorder (two-track: MAIN / ALT) ---------------- */
const mic = {
  ctx: null, stream: null, source: null, processor: null, sink: null,
  sampleRate: 48000,
  tracks: { main: [], alt: [] },
  activeTrack: 'main',
  selectedId: null,
  playhead: 0,
  recording: false, recChunks: null, recStart: 0, recTrack: 'main',
  playing: false, playNodes: [], playStartCtx: 0, playStartPos: 0, playEnd: 0,
  raf: 0, saved: true, drag: null,
};
let micIdSeq = 0;
function micNewId() { micIdSeq += 1; return 'm' + micIdSeq; }
function micClips() { return mic.tracks.main.concat(mic.tracks.alt); }
function micClipById(id) { return micClips().find((c) => c.id === id) || null; }
function micEnd() { return MicModel.takesEnd(micClips(), mic.sampleRate); }
function micTrackOf(id) {
  if (mic.tracks.main.some((c) => c.id === id)) return 'main';
  if (mic.tracks.alt.some((c) => c.id === id)) return 'alt';
  return null;
}
// Visible span of the mini timeline: at least 5s so there is room to place the
// playhead and record a first take on an empty editor.
function micSpan() { return Math.max(5, micEnd(), mic.playhead + 0.25); }

function micEnsureCtx() {
  if (mic.ctx) return mic.ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error('Audio capture is not available');
  try { mic.ctx = new AC({ sampleRate: 48000, latencyHint: 'interactive' }); }
  catch (_) { mic.ctx = new AC(); }
  mic.sampleRate = mic.ctx.sampleRate;
  return mic.ctx;
}

function micReset() {
  mic.tracks = { main: [], alt: [] };
  mic.activeTrack = 'main';
  mic.selectedId = null;
  mic.playhead = 0;
  mic.recording = false;
  mic.recChunks = null;
  mic.recStart = 0;
  mic.recTrack = 'main';
  mic.playing = false;
  mic.playNodes = [];
  mic.drag = null;
  mic.saved = true;
}

async function micStartCapture() {
  if (mic.stream) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Microphone access is not available');
  }
  const ctx = micEnsureCtx();
  if (ctx.state === 'suspended') await ctx.resume();
  mic.stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: mic.sampleRate,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  mic.source = ctx.createMediaStreamSource(mic.stream);
  mic.processor = ctx.createScriptProcessor(2048, 1, 1);
  mic.processor.onaudioprocess = (ev) => {
    if (!mic.recording) return;
    const input = ev.inputBuffer.getChannelData(0);
    const chunk = new Float32Array(input.length);
    chunk.set(input);
    mic.recChunks.push(chunk);
    let n = 0;
    for (const c of mic.recChunks) n += c.length;
    mic.playhead = mic.recStart + n / mic.sampleRate;
  };
  // A muted sink keeps the processor pulling without monitoring the mic.
  mic.sink = ctx.createGain();
  mic.sink.gain.value = 0;
  mic.source.connect(mic.processor);
  mic.processor.connect(mic.sink);
  mic.sink.connect(ctx.destination);
}

function micStopCapture() {
  mic.recording = false;
  try { if (mic.processor) mic.processor.disconnect(); } catch (_) {}
  try { if (mic.source) mic.source.disconnect(); } catch (_) {}
  try { if (mic.sink) mic.sink.disconnect(); } catch (_) {}
  try { if (mic.stream) mic.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
  mic.processor = null;
  mic.source = null;
  mic.sink = null;
  mic.stream = null;
}

function micStopPlay() {
  for (const n of mic.playNodes) { try { n.stop(); } catch (_) {} }
  mic.playNodes = [];
  mic.playing = false;
}

async function micToggleRecord() {
  if (mic.recording) { micFinishRecord(); return; }
  if (mic.playing) micStopPlay();
  const total = micEnd();
  mic.recStart = Math.max(0, Math.min(total, mic.playhead));
  mic.recTrack = mic.activeTrack;
  mic.recChunks = [];
  try { await micStartCapture(); }
  catch (e) {
    toast('Microphone unavailable: ' + (e && e.message ? e.message : e), { danger: true });
    return;
  }
  mic.recording = true;
  mic.saved = false;
  micUpdateUI();
  micLoop();
  setStatus('Recording… click Stop to finish');
}

// Turn the captured chunks into a clip on the record track. Anything already on
// that track under the recorded span is removed (punch-in overwrite).
function micFinishRecord() {
  micStopCapture();
  const chunks = mic.recChunks || [];
  let n = 0;
  for (const c of chunks) n += c.length;
  mic.recChunks = null;
  if (n < 1) { micUpdateUI(); micDraw(); return; }
  const samples = new Float32Array(n);
  let off = 0;
  for (const c of chunks) { samples.set(c, off); off += c.length; }
  const sr = mic.sampleRate;
  const clip = { id: micNewId(), track: mic.recTrack, start: mic.recStart, samples };
  const keep = MicModel.punchTrack(mic.tracks[mic.recTrack], mic.recStart, mic.recStart + n / sr, sr, micNewId);
  mic.tracks[mic.recTrack] = keep.concat(clip).sort((a, b) => a.start - b.start);
  mic.selectedId = clip.id;
  mic.activeTrack = mic.recTrack;
  mic.playhead = MicModel.clipEnd(clip, sr);
  mic.saved = false;
  micUpdateUI();
  micDraw();
  setStatus('Take recorded — drag / split / trim, then Save');
}

function micTogglePlay() {
  if (mic.recording) micFinishRecord();
  if (mic.playing) { micStopPlay(); micUpdateUI(); micDraw(); return; }
  const ctx = micEnsureCtx();
  const sr = mic.sampleRate;
  const clips = micClips().filter((c) => MicModel.clipEnd(c, sr) > mic.playhead + 1e-6);
  if (!clips.length) return;
  if (ctx.state === 'suspended') ctx.resume();
  const t0 = ctx.currentTime + 0.03;
  mic.playNodes = [];
  let last = mic.playhead;
  for (const c of clips) {
    const from = Math.max(c.start, mic.playhead);
    const srcOff = from - c.start;
    const dur = MicModel.clipEnd(c, sr) - from;
    if (dur <= 0) continue;
    const buf = ctx.createBuffer(1, c.samples.length, sr);
    buf.copyToChannel(c.samples, 0);
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(ctx.destination);
    node.start(t0 + Math.max(0, c.start - mic.playhead), Math.max(0, srcOff), dur);
    mic.playNodes.push(node);
    last = Math.max(last, MicModel.clipEnd(c, sr));
  }
  mic.playing = true;
  mic.playStartCtx = t0;
  mic.playStartPos = mic.playhead;
  mic.playEnd = last;
  micLoop();
}

function micStopTake() {
  if (mic.recording) micFinishRecord();
  if (mic.playing) micStopPlay();
  micUpdateUI();
  micDraw();
}

function micLoop() {
  if (mic.raf) { cancelAnimationFrame(mic.raf); mic.raf = 0; }
  const tick = () => {
    const modal = $('#mic-modal');
    if (!modal || modal.classList.contains('hidden')) { mic.raf = 0; return; }
    if (mic.playing && mic.ctx) {
      mic.playhead = mic.playStartPos + (mic.ctx.currentTime - mic.playStartCtx);
      if (mic.playhead >= mic.playEnd) { mic.playhead = mic.playEnd; micStopPlay(); }
    }
    micUpdateUI();
    micDraw();
    mic.raf = (mic.playing || mic.recording) ? requestAnimationFrame(tick) : 0;
  };
  tick();
}

function micUpdateUI() {
  const dur = micEnd();
  const ph = Math.max(0, Math.min(Math.max(dur, 0), mic.playhead));
  const t = $('#mic-time');
  if (t) t.textContent = `${ph.toFixed(3)} / ${dur.toFixed(3)}`;
  const rec = $('#mic-rec-dot');
  if (rec) rec.classList.toggle('hidden', !mic.recording);
  const rl = $('#mic-record-label');
  if (rl) rl.textContent = mic.recording ? 'Stop rec' : 'Record';
  const pl = $('#mic-play-label');
  if (pl) pl.textContent = mic.playing ? 'Pause' : 'Play';
  const use = $('#mic-use-play');
  if (use) use.setAttribute('href', mic.playing ? '#i-pause' : '#i-play');
  const del = $('#mic-del');
  if (del) del.disabled = !mic.selectedId;
  const sp = $('#mic-split');
  if (sp) sp.disabled = !mic.selectedId;
  for (const el of $$('.mic-lane')) el.classList.toggle('active', el.dataset.track === mic.activeTrack);
}

function micLaneCanvas(track) { return $(track === 'alt' ? '#mic-wave-alt' : '#mic-wave-main'); }

function micDraw() {
  const total = micSpan();
  for (const track of ['main', 'alt']) {
    const canvas = micLaneCanvas(track);
    if (!canvas) continue;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, w, h);
    g.fillStyle = track === 'alt' ? 'rgba(255,255,255,.03)' : 'rgba(255,255,255,.05)';
    g.fillRect(0, 0, w, h);
    for (const c of mic.tracks[track]) {
      const x0 = (c.start / total) * w;
      const x1 = (MicModel.clipEnd(c, mic.sampleRate) / total) * w;
      const cw = Math.max(2, x1 - x0);
      g.fillStyle = c.id === mic.selectedId ? 'rgba(90,200,255,.34)' : 'rgba(90,200,255,.18)';
      g.fillRect(x0, 0, cw, h);
      g.strokeStyle = c.id === mic.selectedId ? 'rgba(150,230,255,.95)' : 'rgba(120,200,255,.55)';
      g.lineWidth = Math.max(1, dpr);
      g.strokeRect(x0 + 0.5, 0.5, Math.max(1, cw - 1), h - 1);
      const mid = h / 2;
      const buckets = Math.max(1, Math.floor(cw / 2));
      g.strokeStyle = 'rgba(205,240,255,.85)';
      g.beginPath();
      for (let i = 0; i < buckets; i++) {
        const a = Math.floor((i / buckets) * c.samples.length);
        const b = Math.max(a + 1, Math.floor(((i + 1) / buckets) * c.samples.length));
        const step = Math.max(1, Math.floor((b - a) / 12));
        let peak = 0;
        for (let j = a; j < b; j += step) { const v = Math.abs(c.samples[j] || 0); if (v > peak) peak = v; }
        const half = Math.max(dpr * 0.75, peak * (h / 2 - 4 * dpr));
        const x = x0 + (i / buckets) * cw;
        g.moveTo(x, mid - half);
        g.lineTo(x, mid + half);
      }
      g.stroke();
      g.fillStyle = 'rgba(255,255,255,.45)';
      g.fillRect(x0, 0, Math.max(1, 2 * dpr), h);
      g.fillRect(Math.max(x0, x1 - Math.max(1, 2 * dpr)), 0, Math.max(1, 2 * dpr), h);
    }
    if (mic.recording && track === mic.recTrack) {
      const rx = (mic.recStart / total) * w;
      g.fillStyle = 'rgba(255,80,80,.55)';
      g.fillRect(rx, 0, Math.max(1, dpr), h);
    }
  }
  const mini = $('#mic-mini');
  const ph = $('#mic-playhead');
  if (mini && ph) {
    const r = mini.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, mic.playhead / total)) * r.width;
    ph.style.transform = `translateX(${x}px)`;
  }
}

function micLaneAt(e) {
  const lane = e.target && e.target.closest ? e.target.closest('.mic-lane') : null;
  return lane ? lane.dataset.track : null;
}
function micTimeAtLane(track, clientX) {
  const canvas = micLaneCanvas(track);
  if (!canvas) return 0;
  const r = canvas.getBoundingClientRect();
  const total = micSpan();
  return Math.max(0, Math.min(total, ((clientX - r.left) / Math.max(1, r.width)) * total));
}

function micPointerDown(e) {
  const track = micLaneAt(e);
  if (!track) return;
  if (mic.playing) micStopPlay();
  if (mic.recording) micFinishRecord();
  const sr = mic.sampleRate;
  const t = micTimeAtLane(track, e.clientX);
  const clip = mic.tracks[track].find((c) => t >= c.start && t <= MicModel.clipEnd(c, sr));
  const mini = $('#mic-mini');
  try { mini.setPointerCapture(e.pointerId); } catch (_) {}
  if (!clip) {
    mic.activeTrack = track;
    mic.selectedId = null;
    mic.playhead = t;
    mic.drag = { type: 'scrub', pointerId: e.pointerId };
  } else {
    const edge = Math.max(MIN_LEN, micSpan() * 0.012);
    mic.activeTrack = track;
    mic.selectedId = clip.id;
    if (t - clip.start <= edge) mic.drag = { type: 'trim-l', id: clip.id, pointerId: e.pointerId };
    else if (MicModel.clipEnd(clip, sr) - t <= edge) mic.drag = { type: 'trim-r', id: clip.id, pointerId: e.pointerId };
    else mic.drag = { type: 'move', id: clip.id, grab: t - clip.start, pointerId: e.pointerId };
  }
  micUpdateUI();
  micDraw();
  e.preventDefault();
}

function micPointerMove(e) {
  if (!mic.drag) return;
  const sr = mic.sampleRate;
  const track = micTrackOf(mic.drag.id) || mic.activeTrack;
  const t = micTimeAtLane(track, e.clientX);
  if (mic.drag.type === 'scrub') {
    mic.playhead = t;
  } else {
    const c = micClipById(mic.drag.id);
    if (!c) return;
    let next = c;
    if (mic.drag.type === 'move') next = MicModel.moveClip(c, Math.max(0, t - mic.drag.grab));
    else if (mic.drag.type === 'trim-l') next = MicModel.trimClip(c, 'left', t, sr, MIN_LEN);
    else if (mic.drag.type === 'trim-r') next = MicModel.trimClip(c, 'right', t, sr, MIN_LEN);
    mic.tracks[track] = mic.tracks[track].map((x) => (x.id === c.id ? next : x)).sort((a, b) => a.start - b.start);
    mic.saved = false;
  }
  micUpdateUI();
  micDraw();
}
function micPointerUp() { mic.drag = null; }

function micSplit() {
  const c = micClipById(mic.selectedId);
  if (!c) return;
  const sr = mic.sampleRate;
  const track = micTrackOf(c.id);
  const parts = MicModel.splitClip(c, mic.playhead, sr, micNewId);
  if (parts.length < 2) { toast('Move the playhead inside the selected take', { danger: true }); return; }
  mic.tracks[track] = mic.tracks[track].filter((x) => x.id !== c.id).concat(parts).sort((a, b) => a.start - b.start);
  mic.selectedId = parts[1].id;
  mic.saved = false;
  micUpdateUI();
  micDraw();
}

function micDelete() {
  const c = micClipById(mic.selectedId);
  if (!c) return;
  const track = micTrackOf(c.id);
  mic.tracks[track] = mic.tracks[track].filter((x) => x.id !== c.id);
  mic.selectedId = null;
  mic.saved = false;
  micUpdateUI();
  micDraw();
}

function micOpen() {
  if (state.playing) pausePlay();
  micReset();
  try { micEnsureCtx(); } catch (e) { toast('Microphone unavailable: ' + e, { danger: true }); return; }
  $('#mic-name').value = MicWav.stampName(new Date());
  $('#mic-modal').classList.remove('hidden');
  micUpdateUI();
  micDraw();
  micLoop();
  setStatus('Mic recorder — Record punches into the active track');
}

function micClose(force) {
  if (mic.recording) micStopCapture();
  mic.recChunks = null;
  if (mic.playing) micStopPlay();
  if (!force && !mic.saved && (mic.tracks.main.length || mic.tracks.alt.length)) {
    if (!confirm('Discard this mic take?')) return;
  }
  if (mic.raf) { cancelAnimationFrame(mic.raf); mic.raf = 0; }
  try { if (mic.ctx) mic.ctx.close(); } catch (_) {}
  mic.ctx = null;
  try { if (mic.stream) mic.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
  micReset();
  $('#mic-modal').classList.add('hidden');
  setStatus('Ready');
}

async function micSaveTake() {
  if (mic.recording) micFinishRecord();
  if (mic.playing) micStopPlay();
  const pcm = MicModel.mixClips(micClips(), mic.sampleRate);
  if (!pcm.length) { toast('Record something first', { danger: true }); return; }
  const name = ($('#mic-name').value || '').trim() || MicWav.stampName(new Date());
  const data = MicWav.encodeWav(pcm, mic.sampleRate);
  let res;
  try { res = await api.micSave({ name, data }); }
  catch (e) { toast('Could not save mic take: ' + e, { danger: true }); return; }
  if (!res || !res.ok) {
    toast('Could not save mic take: ' + ((res && res.error) || 'unknown error'), { danger: true });
    return;
  }
  mic.saved = true;
  toast(`Saved ${res.name} to Mic Record`);
  micClose(true);
  refreshBin('sounds');
}

function wireMicEvents() {
  $('#btn-mic').addEventListener('click', micOpen);
  $('#mic-record').addEventListener('click', micToggleRecord);
  $('#mic-play').addEventListener('click', micTogglePlay);
  $('#mic-stop').addEventListener('click', micStopTake);
  $('#mic-split').addEventListener('click', micSplit);
  $('#mic-del').addEventListener('click', micDelete);
  $('#mic-cancel').addEventListener('click', () => micClose(false));
  $('#mic-save').addEventListener('click', micSaveTake);
  const mini = $('#mic-mini');
  mini.addEventListener('pointerdown', micPointerDown);
  mini.addEventListener('pointermove', micPointerMove);
  mini.addEventListener('pointerup', micPointerUp);
  mini.addEventListener('pointercancel', micPointerUp);
}

/* ---------------- viewer: program output vs single-clip media preview ----------------
   'program' shows the edited timeline (no native transport — the timeline owns the
   tools). 'media' shows one bin clip with its own scrubber/play controls and a
   PREVIEW watermark, and closes the moment editing resumes. `split` keeps both. */
function updateViewerClasses() {
  const v = $('#viewer');
  if (!v) return;
  const media = state.viewer.mode === 'media';
  v.classList.toggle('mode-program', !media);
  v.classList.toggle('mode-media', media && !state.viewer.split);
  v.classList.toggle('split', media && state.viewer.split);
  const btn = $('#viewer-split');
  if (btn) btn.classList.toggle('on', state.viewer.split);
}

// Any editing action closes a single (non-split) media preview. In split mode the
// media preview is meant to stay put, so nothing is closed.
function noteEditing() {
  if (state.viewer.mode === 'media' && !state.viewer.split) exitMediaPreview();
}

function enterMediaPreview(item) {
  if (!item || !item.path) return;
  if (state.playing) pausePlay();
  state.viewer.mode = 'media';
  state.viewer.mediaPath = item.path;
  const v = $('#preview-media');
  const img = $('#preview-media-img');
  const url = api.toFileUrl(item.path);
  if (isImageItem(item)) {
    try { v.pause(); } catch (_) {}
    v.classList.add('hidden');
    v.removeAttribute('src');
    v.dataset.path = '';
    if (img) {
      img.src = url;
      img.classList.remove('hidden');
    }
  } else {
    if (img) {
      img.classList.add('hidden');
      img.removeAttribute('src');
    }
    v.classList.remove('hidden');
    if (v.dataset.path !== url) { v.dataset.path = url; v.src = url; }
    try { v.currentTime = 0; } catch (_) {}
    const pr = v.play();
    if (pr && pr.then) pr.catch(() => {});
  }
  $('#media-empty').classList.add('hidden');
  $('#preview-watermark').classList.remove('hidden');
  updateViewerClasses();
  setStatus('Media preview: ' + (item.name || pathBase(item.path)) + ' — click the timeline to go back to editing');
}

function exitMediaPreview() {
  if (state.viewer.mode !== 'media') return;
  const v = $('#preview-media');
  const img = $('#preview-media-img');
  try { v.pause(); } catch (_) {}
  v.removeAttribute('src');
  try { v.load(); } catch (_) {}
  v.classList.remove('hidden');
  if (img) {
    img.classList.add('hidden');
    img.removeAttribute('src');
  }
  state.viewer.mode = 'program';
  state.viewer.mediaPath = null;
  $('#preview-watermark').classList.add('hidden');
  $('#media-empty').classList.remove('hidden');
  updateViewerClasses();
}

function toggleMediaPlay() {
  const v = $('#preview-media');
  if (v.paused) v.play().catch(() => {}); else v.pause();
}

function setViewerSplit(on) {
  state.viewer.split = !!on;
  try { localStorage.setItem('cm_viewer_split', state.viewer.split ? '1' : '0'); } catch (_) {}
  updateViewerClasses();
}

/* --- playback monitor -------------------------------------------------------
   Ticks while playing. Two jobs:
   1. Keep the Sounds lane in sync so a sound whose region begins AFTER
      playback started still starts (and gently corrects drift).
   2. Run the "audio tail": when the video pieces end but sounds continue (they
      are appended after the last clip), advance the clock so the lane is heard. */
let monitorTimer = null;
let tailMode = false;
function stopMonitor() { if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; } tailMode = false; }
function startMonitor(tail) {
  stopMonitor();
  stopStillPlayback();
  tailMode = !!tail;
  if (tail) { try { $('#preview').pause(); } catch (_) {} } // hold the last video frame
  let last = performance.now();
  monitorTimer = setInterval(() => {
    if (!state.playing) { stopMonitor(); return; }
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;
    if (tailMode) {
      const total = totalDuration();
      state.playhead = Math.min(total, state.playhead + dt);
      updatePlayhead();
      updateTimeReadout();
      if (state.playhead >= total - 1e-6) {
        state.playhead = total;
        updatePlayhead(); updateTimeReadout();
        pausePlay();
        return;
      }
    }
    syncSoundPreview(false);
  }, 100);
}

/* ---------------- sound-lane preview (real-time mix) ---------------- */
const PREVIEW_SOUND_VOL = 0.9;
const PREVIEW_SOUND_DB = 20 * Math.log10(PREVIEW_SOUND_VOL); // ≈ -0.92 dB
const soundEls = new Map(); // soundboard id -> { el, url }

function ensureSoundEl(id) {
  let rec = soundEls.get(id);
  if (!rec) {
    const el = document.createElement('audio');
    el.preload = 'auto';
    const rack = document.getElementById('sound-audio-rack') || document.body;
    rack.appendChild(el);
    rec = { el, url: '' };
    soundEls.set(id, rec);
  }
  return rec;
}
function pauseSoundEls() {
  for (const rec of soundEls.values()) { try { rec.el.pause(); } catch (_) {} }
}
// Start/restart hidden <audio> elements so the sound lane is audible while playing.
function syncSoundPreview(force) {
  if (!state.playing) { pauseSoundEls(); return; }
  const t = state.playhead;
  const active = new Set();
  const sounds = state.soundboard.concat(state.hybrid.filter((h) => h.kind === 'sound'));
  for (const s of sounds) {
    const s0 = s.startTime || 0;
    if (t < s0 || t >= s0 + sndDur(s)) continue; // not overlapping the playhead
    active.add(s.id);
    const rec = ensureSoundEl(s.id);
    const url = api.toFileUrl(s.path);
    if (rec.url !== url) { rec.el.src = url; rec.url = url; }
    setMediaGain(rec.el, (s.volume || 0) + PREVIEW_SOUND_DB);
    const want = (s.srcStart || 0) + Math.max(0, t - s0);
    if (force || rec.el.paused || Math.abs(rec.el.currentTime - want) > 0.3) {
      rec.el.currentTime = want;
    }
    rec.el.play().catch(() => {});
  }
  for (const [id, rec] of soundEls) {
    if (!active.has(id)) { try { rec.el.pause(); } catch (_) {} rec.el.currentTime = 0; }
  }
}

/* ---------------- split / delete ---------------- */
// Does the playhead land strictly inside [start, start+dur)?
function crossesPoint(start, dur, t) { return start < t - 1e-6 && t < start + dur - 1e-6; }

// Split a clip into two pieces at absolute timeline time t (returns false when t
// sits on, or too close to, an edge). The new piece keeps the original srcEnd.
// `arr` is the lane's array (MAIN, or the ALT lane) the right half is pushed to.
function splitClipAt(item, t, arr = state.timeline) {
  const local = t - (item.start || 0);
  if (local <= MIN_LEN || durOf(item) - local <= MIN_LEN) return false;
  const cutSrc = item.srcStart + local * speedOf(item);
  const right = { ...item, id: newId(), srcStart: cutSrc, start: t };
  item.srcEnd = cutSrc;
  arr.push(right);
  return true;
}

// Split a sound at timeline time t. Sounds are free-positioned; the two halves
// share the source file. Normalise to explicit srcStart/srcEnd so sndDur() works.
function splitSoundAt(s, t, arr = state.soundboard) {
  const off = t - (s.startTime || 0);
  const dur = sndDur(s);
  if (off <= MIN_LEN || dur - off <= MIN_LEN) return false;
  const a = s.srcStart != null ? s.srcStart : 0;
  const b = s.srcEnd != null ? s.srcEnd : (s.endTime != null ? s.endTime : s.duration);
  const cut = a + off;
  const right = { ...s, id: newId(), startTime: t, srcStart: cut, srcEnd: b };
  delete right.endTime;
  s.srcStart = a;
  s.srcEnd = cut;
  s.endTime = undefined;
  arr.push(right);
  return true;
}

// A selection scopes the split to just those items (any lane); with nothing
// selected only MAIN clips are cut. Sounds/ALT items split when selected.
function splitAtPlayhead() {
  noteEditing();
  if (state.playing) pausePlay();
  const t = state.playhead;
  if (!state.timeline.length && !state.soundboard.length && !state.hybrid.length) { setStatus('Nothing to split.'); return; }
  const hasSel = state.selectedIds.size > 0 || state.selectedSbs.size > 0 || state.selectedHyb.size > 0;
  const clips = state.timeline.filter((c) => crossesPoint(c.start || 0, durOf(c), t) && (!hasSel || state.selectedIds.has(c.id)));
  const sounds = state.soundboard.filter((s) => crossesPoint(s.startTime || 0, sndDur(s), t) && state.selectedSbs.has(s.id));
  const hclips = state.hybrid.filter((h) => h.kind !== 'sound' && crossesPoint(hybStartOf(h), hybDurOf(h), t) && state.selectedHyb.has(h.id));
  const hsounds = state.hybrid.filter((h) => h.kind === 'sound' && crossesPoint(hybStartOf(h), hybDurOf(h), t) && state.selectedHyb.has(h.id));
  snapshot();
  let n = 0;
  for (const c of clips) if (splitClipAt(c, t, state.timeline)) n++;
  for (const s of sounds) if (splitSoundAt(s, t, state.soundboard)) n++;
  for (const h of hclips) if (splitClipAt(h, t, state.hybrid)) n++;
  for (const h of hsounds) if (splitSoundAt(h, t, state.hybrid)) n++;
  if (!n) {
    commit();
    setStatus(hasSel ? 'Nothing selected crosses the marker.' : 'Nothing crosses the marker to split.');
    return;
  }
  commit(`Split ${n} item(s) at ${fmt(t)}`);
  renderTimeline();
  setStatus(`Split ${n} item(s) at ${fmt(t)}`);
}

/* ---------------- freeze frame ---------------- */
// The visible video clip under the playhead, plus the source timestamp to grab.
function freezeTargetAt(t) {
  const b = visibleVideoAt(t);
  if (!b || !b.item || !b.item.path) return null;
  if (TimelineOps.isStill(b.item)) return null;
  const speed = speedOf(b.item);
  const start = b.item.start || 0;
  const srcStart = b.item.srcStart != null ? b.item.srcStart : (b.item.inPoint != null ? b.item.inPoint : 0);
  return { ...b, freezeAt: srcStart + (t - start) * speed };
}

function updateFreezeButton() {
  const b = $('#effect-freeze');
  if (!b) return;
  const ok = !!freezeTargetAt(state.playhead);
  b.classList.toggle('disabled', !ok);
  b.setAttribute('aria-disabled', ok ? 'false' : 'true');
}

function insertFreeze() {
  const target = freezeTargetAt(state.playhead);
  if (!target) {
    setStatus('Move the playhead over a video clip to insert a freeze frame.');
    return;
  }
  noteEditing();
  if (state.playing) pausePlay();
  const t = state.playhead;
  const item = target.item;
  const arr = target.lane === 'hybrid' ? state.hybrid : state.timeline;
  const start = item.start || 0;
  const end = start + durOf(item);
  snapshot();
  // Freeze is the one insert that splits mid-clip instead of snapping to an edge.
  if (t > start + MIN_LEN && t < end - MIN_LEN) splitClipAt(item, t, arr);
  TimelineOps.rippleOpen(state, t, FREEZE_LEN, 'all');
  const freeze = {
    id: newId(),
    path: item.path,
    name: `Freeze @ ${fmt(t)}`,
    duration: FREEZE_LEN,
    start: t,
    srcStart: 0,
    srcEnd: FREEZE_LEN,
    kind: 'freeze',
    still: true,
    freezeAt: target.freezeAt,
    mute: true,
    speed: 1,
    fit: item.fit || 'blur',
    volume: 0,
    width: item.width,
    height: item.height,
    fps: item.fps,
    vcodec: 'image',
    acodec: null,
    hasAudio: false,
    audioSampleRate: 0,
    audioChannels: 0,
    origin: 'freeze',
  };
  clearSelection();
  if (target.lane === 'hybrid') {
    state.hybrid.push(freeze);
    state.selectedHyb.add(freeze.id);
  } else {
    state.timeline.push(freeze);
    state.selectedIds.add(freeze.id);
  }
  commit('Insert freeze frame');
  renderAll();
  seekPreview(t);
  setStatus(`Inserted a ${FREEZE_LEN}s freeze at ${fmt(t)}.`);
}

function deleteSelection() {
  noteEditing();
  if (state.selectedGaps.length) { closeGaps(state.selectedGaps); return; }
  if (!anySelected()) return;
  snapshot();
  if (state.selectedIds.size) state.timeline = state.timeline.filter((c) => !state.selectedIds.has(c.id));
  if (state.selectedSbs.size) state.soundboard = state.soundboard.filter((s) => !state.selectedSbs.has(s.id));
  if (state.selectedHyb.size) state.hybrid = state.hybrid.filter((h) => !state.selectedHyb.has(h.id));
  if (state.selectedEff.size) state.effects = state.effects.filter((e) => !state.selectedEff.has(e.id));
  if (state.selectedMarkers.size) state.markers = state.markers.filter((m) => !state.selectedMarkers.has(m.id));
  clearSelection();
  commit('Delete');
  renderTimeline();
}

/* ---------------- clipboard (Ctrl+C / Ctrl+X / Ctrl+V) ---------------- */
// Snapshot the current selection as deep clones tagged with `_kind` so a paste
// can be routed to whatever lane the pointer is over.
function copySelection() {
  const items = [];
  for (const c of clipSelection()) items.push({ ...JSON.parse(JSON.stringify(c)), _kind: 'clip' });
  for (const s of soundSelection()) items.push({ ...JSON.parse(JSON.stringify(s)), _kind: 'sound' });
  for (const h of hybSelection()) items.push({ ...JSON.parse(JSON.stringify(h)), _kind: h.kind === 'sound' ? 'sound' : 'clip' });
  clipboard = { items };
  return items.length;
}
function copySelectionAction() {
  const n = copySelection();
  setStatus(n ? `Copied ${n} item(s).` : 'Nothing to copy.');
}
function cutSelection() {
  if (state.selectedGaps.length) { closeGaps(state.selectedGaps); return; }
  if (!anySelected()) { setStatus('Nothing to cut.'); return; }
  const n = copySelection();
  noteEditing();
  snapshot();
  if (state.selectedIds.size) state.timeline = state.timeline.filter((c) => !state.selectedIds.has(c.id));
  if (state.selectedSbs.size) state.soundboard = state.soundboard.filter((s) => !state.selectedSbs.has(s.id));
  if (state.selectedHyb.size) state.hybrid = state.hybrid.filter((h) => !state.selectedHyb.has(h.id));
  if (state.selectedMarkers.size) state.markers = state.markers.filter((m) => !state.selectedMarkers.has(m.id));
  clearSelection();
  commit(`Cut ${n} item(s)`);
  renderTimeline();
  setStatus(`Cut ${n} item(s) — Ctrl+V to place.`);
}

// The pending paste items a given lane can take (SOUND = sounds only, MAIN =
// clips only, ALT = both).
function pasteItemsForLane(lane) {
  const its = pastePending ? pastePending.items : [];
  if (lane === 'sounds') return its.filter((i) => i._kind === 'sound');
  if (lane === 'clips') return its.filter((i) => i._kind === 'clip');
  return its.slice();
}
function pasteItemLen(it) { return it._kind === 'sound' ? sndDur(it) : durOf(it); }

function startPastePlacement() {
  if (!clipboard.items.length) { setStatus('Clipboard is empty.'); return; }
  cancelPaste();
  pastePending = { items: clipboard.items.map((x) => JSON.parse(JSON.stringify(x))) };
  const anyClip = pastePending.items.some((i) => i._kind === 'clip');
  pendingDrag = { kind: anyClip ? 'clips' : 'sounds', items: pastePending.items.map((i) => ({ duration: pasteItemLen(i) })), paste: true };
  const panel = $('#timeline-panel');
  if (panel) panel.classList.add('pasting');
  setStatus('Paste: move over the timeline and click to place (Esc cancels).');
}
function cancelPaste() {
  if (!pastePending) return;
  pastePending = null;
  if (pendingDrag && pendingDrag.paste) pendingDrag = null;
  const panel = $('#timeline-panel');
  if (panel) panel.classList.remove('pasting');
  clearDropTargetLane();
  hideDropProxy();
  hideDropMarker();
}
// Pointer-follow: show the drop marker + length ghost over the hovered lane.
function updatePasteGhost(e) {
  if (!pastePending) return;
  const lane = laneAt(e.clientY);
  const ok = pasteItemsForLane(lane).length > 0;
  setDropTargetLane(ok ? lane : null);
  if (!ok) { hideDropProxy(); hideDropMarker(); return; }
  const t = dropInsertTime(e, lane);
  const m = $('#drop-marker');
  if (m) { m.classList.remove('hidden'); m.style.left = timeToX(t) + 'px'; }
  showDropProxy(t, lane);
}
// Place the pending paste into the clicked lane, rippling it open like a bin drop.
function placePaste(e) {
  if (!pastePending) return;
  const lane = laneAt(e.clientY);
  const picks = pasteItemsForLane(lane);
  if (!picks.length) { setStatus(lane === 'sounds' ? 'SOUND lane takes audio only.' : 'Nothing to paste here.'); return; }
  const t = dropTimeAt(e);
  const items = picks.map((it) => {
    const { _kind, ...rest } = it;
    const o = { ...rest, id: newId() };
    if (lane === 'hybrid') {
      // ALT stores sounds as 'sound' and every visual as a clip-ish kind.
      if (_kind === 'sound') o.kind = 'sound';
      else if (o.kind && o.kind !== 'video') { /* keep image/freeze/clip */ }
      else o.kind = 'clip';
    } else if (o.kind === 'video') {
      delete o.kind;
    }
    return o;
  });
  cancelPaste();
  if (lane === 'sounds') addSoundItems(items, t);
  else if (lane === 'hybrid') addHybridItems(items, t);
  else addTimelineItems(items, t);
}

// Close the given gaps: everything after each gap's end (clips, sounds, CLIPS2
// items, markers) shifts left by the gap width — a ripple, like the desktop.
function closeGaps(gaps) {
  const list = [...gaps].sort((a, b) => b.start - a.start);
  snapshot();
  for (const g of list) {
    const w = g.end - g.start;
    if (w <= 1e-6) continue;
    const isAlt = g.lane === 'alt';
    if (!isAlt) {
      for (const it of state.timeline) {
        if ((it.start || 0) >= g.end - 1e-6) it.start = Math.max(-PREROLL, (it.start || 0) - w);
      }
      for (const s of state.soundboard) {
        if ((s.startTime || 0) >= g.end - 1e-6) s.startTime = Math.max(-PREROLL, (s.startTime || 0) - w);
      }
      for (const m of state.markers) {
        if ((m.time || 0) >= g.end - 1e-6) m.time = Math.max(-PREROLL, (m.time || 0) - w);
      }
    }
    for (const h of state.hybrid) {
      if (isAlt && h.kind === 'sound') continue;
      if (!isAlt && h.kind === 'sound') continue;
      const t = hybStartOf(h);
      if (t >= g.end - 1e-6) setHybStart(h, Math.max(-PREROLL, t - w));
    }
  }
  clearSelection();
  commit('Close gap(s)');
  renderTimeline();
  setStatus(`Closed ${list.length} gap${list.length > 1 ? 's' : ''}.`);
}

// Remove every gap on the Clips track: re-stack the positive-time clips from 0
// (pre-roll clips < 0 are left parked), moving sounds/CLIPS2/markers by the same
// amount their preceding clip moved.
function closeAllGaps() {
  noteEditing();
  if (!state.timeline.length) { setStatus('No clips to arrange.'); return; }
  sortTrack();
  snapshot();
  let acc = 0;
  for (const it of state.timeline) {
    if ((it.start || 0) < -1e-6) acc = Math.max(acc, (it.start || 0) + durOf(it));
  }
  const deltas = new Map();
  for (const it of state.timeline) {
    if ((it.start || 0) < -1e-6) continue;
    const old = it.start || 0;
    it.start = acc;
    deltas.set(it.id, old - acc);
    acc += durOf(it);
  }
  const shiftAt = (t) => {
    let d = 0, lastOld = -Infinity;
    for (const it of state.timeline) {
      const old = it.start || 0;
      if (old < -1e-6) continue;
      if (old <= t + 1e-6 && old >= lastOld) { lastOld = old; d = deltas.get(it.id) || 0; }
    }
    return d;
  };
  for (const s of state.soundboard) { const d = shiftAt(s.startTime || 0); if (d > 0) s.startTime = Math.max(-PREROLL, (s.startTime || 0) - d); }
  for (const h of state.hybrid) { const d = shiftAt(hybStartOf(h)); if (d > 0) setHybStart(h, Math.max(-PREROLL, hybStartOf(h) - d)); }
  for (const m of state.markers) { const d = shiftAt(m.time || 0); if (d > 0) m.time = Math.max(-PREROLL, (m.time || 0) - d); }
  clearSelection();
  commit('Remove all gaps');
  renderTimeline();
  setStatus('Removed all gaps.');
}

// Close gaps inside the ALT lane only (its own ⇤ button).
function closeHybridGaps() {
  noteEditing();
  const hclips = state.hybrid.filter((h) => h.kind !== 'sound');
  if (!hclips.length) { setStatus('Nothing to arrange in ALT.'); return; }
  snapshot();
  arrangeHybridClips();
  clearSelection();
  commit('Close ALT gaps');
  renderTimeline();
  setStatus('Removed all gaps in ALT.');
}

/* ---------------- frame stepping & hold-to-play (A / D) ---------------- */
function frameDur() { return 1 / (state.settings.fps || 60); }

function stepFrame(dir) {
  if (state.playing) pausePlay();
  seekPreview(state.playhead + dir * frameDur());
}

// Hold D = normal playback with sound; hold A = reverse video scrub (silent —
// browsers can't play video backwards). Reversed AUDIO is a follow-up.
function startReverseScrub() {
  if (state.playing) pausePlay();
  state.nav.mode = 'rev';
  let last = performance.now();
  const tick = (now) => {
    if (state.nav.mode !== 'rev') return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    seekPreview(Math.max(-PREROLL, state.playhead - dt));
    if (state.playhead <= -PREROLL) { stopNav(); updateToolbar(); return; }
    state.nav.raf = requestAnimationFrame(tick);
  };
  state.nav.raf = requestAnimationFrame(tick);
}

function stopNav() {
  if (state.nav.timer) { clearTimeout(state.nav.timer); state.nav.timer = null; }
  if (state.nav.raf) { cancelAnimationFrame(state.nav.raf); state.nav.raf = 0; }
  const wasMode = state.nav.mode;
  state.nav.mode = null;
  state.nav.dir = 0;
  if (wasMode === 'fwd' && state.playing) pausePlay();
}

/* ---------------- global hotkeys ---------------- */
function isTypingTarget(t) {
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

function wireHotkeys() {
  document.addEventListener('keydown', (e) => {
    if (isTypingTarget(e.target)) return;
    // Undo / redo + clipboard: Ctrl+Z/Ctrl+Y (Cmd variants), Ctrl+C/X/V.
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const key = e.key.toLowerCase();
      if (key === 'z') { e.preventDefault(); if (!e.repeat) { if (e.shiftKey) redo(); else undo(); } return; }
      if (key === 'y') { e.preventDefault(); if (!e.repeat) redo(); return; }
      if (key === 'c') { e.preventDefault(); if (!e.repeat) copySelectionAction(); return; }
      if (key === 'x') { e.preventDefault(); if (!e.repeat) cutSelection(); return; }
      if (key === 'v') { e.preventDefault(); if (!e.repeat) startPastePlacement(); return; }
      if (key === 's') { e.preventDefault(); if (!e.repeat) saveProject(false); return; }
    }
    // Leave other Ctrl/Cmd/Alt combos (Ctrl+A, …) to the browser/OS.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === 'Delete') { e.preventDefault(); if (!e.repeat) deleteSelection(); return; }
    if (k === 's' || k === 'S') { e.preventDefault(); if (!e.repeat) splitAtPlayhead(); return; }
    if (k === 'a' || k === 'A') { e.preventDefault(); if (!e.repeat) jumpToCut(-1); return; }
    if (k === 'd' || k === 'D') { e.preventDefault(); if (!e.repeat) jumpToCut(1); return; }
    if (k === 'f' || k === 'F') { e.preventDefault(); if (!e.repeat) fitTimeline(); return; }
    if (k === ' ' || k === 'Spacebar') {
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (/^(INPUT|SELECT|TEXTAREA|BUTTON|VIDEO|AUDIO|A)$/.test(tag)) return;
      e.preventDefault();
      if (e.repeat) return;
      if (state.viewer.mode === 'media') toggleMediaPlay();
      else togglePlay();
      return;
    }
    if (k === 'Escape') {
      if (!$('#ctx-menu').classList.contains('hidden')) { closeContextMenu(); return; }
      if (!$('#mic-modal').classList.contains('hidden')) { micClose(false); return; }
      if (pastePending) { cancelPaste(); setStatus('Paste cancelled.'); return; }
      if (state.viewer.mode === 'media') { exitMediaPreview(); return; }
      deselect(); return;
    }
  });
  document.addEventListener('keyup', (e) => {
    const k = e.key;
    if (k === 'a' || k === 'A' || k === 'd' || k === 'D') { stopNav(); updateToolbar(); }
  });
}

/* ---------------- zoom / seek ---------------- */
function setZoom(k) {
  state.pps = Math.max(4, Math.min(3000, state.pps * k));
  renderTimeline();
}
function fitTimeline() {
  const total = totalDuration();
  const sc = $('#tl-scroll');
  if (!(total > 0)) {
    state.pps = 90;
    renderTimeline();
    sc.scrollLeft = 0;
    updateScrollbar();
    return;
  }
  // Fit [-5s, total+5s] — a 5s pad each side of the content — into the window
  // width (measured at click time, so it tracks the current window size).
  const tMin = -5;
  const tMax = total + 5;
  const avail = Math.max(80, sc.clientWidth - PAD - 16); // right of the labels, 16px slack
  state.pps = Math.max(4, Math.min(3000, avail / (tMax - tMin)));
  renderTimeline();
  // Put -5s flush against the label gutter so the whole pad is on screen.
  sc.scrollLeft = clamp((tMin + PREROLL) * state.pps, 0, Math.max(0, sc.scrollWidth - sc.clientWidth));
  updateScrollbar();
}

// On launch the view opens just before the start (~-1s) instead of at the far
// left of the 20s pre-roll, so 0:00 is visible straight away. The 20s runway is
// kept — this only moves the scroll position.
function showStartView() {
  const sc = $('#tl-scroll');
  if (!sc) return;
  const maxSl = Math.max(0, sc.scrollWidth - sc.clientWidth);
  sc.scrollLeft = clamp(timeToX(-1) - PAD, 0, maxSl);
  updateScrollbar();
}

function scrubTo(e) {
  if (state.playing) pausePlay();
  hideGuide();
  seekPreview(Math.max(-PREROLL, timeAtClientX(e)));
}

/* ---------------- export ---------------- */
function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

let exportStartT = 0; // wall-clock start of the current export (for ETA)

function lastOutputKey() { return 'cm_lastout:' + (state.projectFile || '__unsaved'); }

async function doExport() {
  if (state.exporting) return;
  if (!state.timeline.length) { setStatus('Nothing to export — add clips first.'); return; }

  const overlapIds = getOverlapIds();
  if (overlapIds.size > 0) {
    setStatus(`Cannot export: ${overlapIds.size} overlapping item${overlapIds.size > 1 ? 's' : ''} — resolve overlaps first.`);
    return;
  }

  arrangeTrack();
  // Always ask where to save; default to the last location remembered for this
  // project, else the output folder + a timestamped name.
  const sticker = lastOutputKey();
  const rem = (() => { try { return localStorage.getItem(sticker); } catch (_) { return ''; } })();
  const sep = state.settings.outputDir?.includes('\\') ? '\\' : '/';
  const def = rem || (state.settings.outputDir ? state.settings.outputDir + sep : '') + `merged_${timestamp()}.mp4`;
  const outFile = await api.saveOutputDialog(def);
  if (!outFile) return;
  const conflict = TimelineOps.sourceConflict(outFile, {
    timeline: state.timeline, hybrid: state.hybrid, soundboard: state.soundboard,
  });
  if (conflict) {
    setStatus('Cannot export over a source clip: ' + conflict);
    alert('That export path is one of the files on the timeline:\n\n'
      + conflict + '\n\nChoose a different output name.');
    return;
  }
  try { localStorage.setItem(sticker, outFile); } catch (_) {}
  state.settings.outputDir = outFile.slice(0, Math.max(outFile.lastIndexOf('\\'), outFile.lastIndexOf('/')));

  state.exporting = true;
  $('#btn-export').disabled = true;
  $('#btn-export-cancel').hidden = false;
  setProgress(0);
  setStatus('Exporting…');
  exportStartT = Date.now();

  const project = {
    timeline: state.timeline,
    soundboard: state.soundboard,
    hybrid: state.hybrid,
    effects: state.effects,
    settings: state.settings,
  };

  const res = await api.runExport({
    ffmpegPath: state.settings.ffmpegPath,
    ffprobePath: state.settings.ffprobePath,
    project, outputFile: outFile,
  });

  state.exporting = false;
  $('#btn-export').disabled = false;
  $('#btn-export-cancel').hidden = true;
  persistSettings();

  if (res.ok) {
    setProgress(1);
    showEta(null);
    setStatus('Export complete: ' + res.outputFile);
    toast('Export complete', { ding: true });
    api.reveal(res.outputFile);
  } else if (/cancelled/i.test(res.error || '')) {
    setProgress(0);
    showEta(null);
    setStatus('Export cancelled.');
  } else {
    setProgress(0);
    showEta(null);
    setStatus('Export failed.');
    toast('Export failed', { ding: true, danger: true });
    alert('Export failed:\n\n' + res.error);
    console.error(res.error);
  }
}

/* ---------------- settings ---------------- */
function openSettings() {
  const s = state.settings;
  $('#set-ffmpeg').value = s.ffmpegPath;
  $('#set-ffprobe').value = s.ffprobePath;
  $('#set-outdir').value = s.outputDir || '';
  $('#set-basedir').value = s.baseDir || '';
  $('#set-transdir').value = s.transitionDir || '';
  $('#set-soundsdir').value = s.soundsDir || '';
  $('#set-w').value = s.width;
  $('#set-h').value = s.height;
  $('#set-fps').value = s.fps;
  $('#set-normalize').checked = !!s.normalizeAudio;
  $('#set-autosave').checked = !!s.autoSave;
  $('#set-autosave-min').value = s.autoSaveMinutes || 5;
  $('#set-autosave-val').textContent = (s.autoSaveMinutes || 5) + ' min';
  $('#set-autosave-min').disabled = !s.autoSave;

  const sel = $('#set-encoder');
  sel.innerHTML = '';
  state.encoders.forEach((e) => {
    const o = document.createElement('option');
    o.value = e.id; o.textContent = e.label;
    if (e.id === s.encoder) o.selected = true;
    sel.appendChild(o);
  });
  $('#settings-modal').classList.remove('hidden');
}

async function applySettings() {
  const s = state.settings;
  // Remember the folders as they were, so we only re-scan what actually changed.
  const prev = {
    ffmpegPath: s.ffmpegPath,
    ffprobePath: s.ffprobePath,
    baseDir: s.baseDir,
    transitionDir: s.transitionDir,
    soundsDir: s.soundsDir,
  };
  s.ffmpegPath = $('#set-ffmpeg').value.trim() || 'ffmpeg';
  s.ffprobePath = $('#set-ffprobe').value.trim() || 'ffprobe';
  s.outputDir = $('#set-outdir').value.trim();
  s.baseDir = $('#set-basedir').value.trim();
  s.transitionDir = $('#set-transdir').value.trim();
  s.soundsDir = $('#set-soundsdir').value.trim();
  s.width = parseInt($('#set-w').value, 10) || 1080;
  s.height = parseInt($('#set-h').value, 10) || 1920;
  s.fps = parseFloat($('#set-fps').value) || 60;
  s.normalizeAudio = $('#set-normalize').checked;
  s.encoder = $('#set-encoder').value;
  s.autoSave = $('#set-autosave').checked;
  s.autoSaveMinutes = Math.max(1, Math.min(30, parseInt($('#set-autosave-min').value, 10) || 5));

  // A new ffmpeg binary may expose a different encoder set — re-detect so the
  // dropdown and export never reference encoders the new binary lacks.
  if (s.ffmpegPath !== prev.ffmpegPath) {
    try {
      const info = await api.init({});
      if (info) {
        state.encoders = info.encoders || [];
        const valid = state.encoders.some((e) => e.id === s.encoder);
        if (!valid) {
          s.encoder = info.preferred || (state.encoders[0] && state.encoders[0].id) || 'libx264';
        }
      }
    } catch (_) { /* keep old encoder list on failure */ }
  }

  const enc = state.encoders.find((e) => e.id === s.encoder);
  $('#encoder-label').textContent = enc ? `Encoder: ${enc.label}` : '';
  $('#settings-modal').classList.add('hidden');

  // Only re-scan the bins whose root folder changed (or all of them if the
  // ffprobe path changed, since durations may differ). Closing Settings with no
  // edits must not touch the library at all.
  const dirKey = { media: 'baseDir', transitions: 'transitionDir', sounds: 'soundsDir' };
  const probeChanged = s.ffprobePath !== prev.ffprobePath;
  for (const k of BIN_KEYS) {
    if (s[dirKey[k]] !== prev[dirKey[k]]) api.unwatch(prev[dirKey[k]]); // free the old folder watcher
    if (probeChanged || s[dirKey[k]] !== prev[dirKey[k]]) refreshBin(k);
  }
  persistSettings();
  scheduleAutoSave();
}

/* ---------------- project save/load ---------------- */
// The document (everything a project file stores). Settings live with the app,
// not the project, so they are intentionally excluded.
function projectData() {
  return {
    version: 7,
    timeline: state.timeline,
    soundboard: state.soundboard,
    hybrid: state.hybrid,
    markers: state.markers,
    effects: state.effects,
  };
}

function docSig() { return JSON.stringify(projectData()); }

let savedSig = null;          // signature of the last saved/loaded/blank document
let lastSaveAt = Date.now();  // when we last wrote (for the reminder + colour)
let autoSaveTimer = 0;

// True when the document differs from what is on disk. A brand-new blank
// document is clean, so we never nag on startup.
function isDirty() { return savedSig !== null && docSig() !== savedSig; }
function markSaved() { savedSig = docSig(); lastSaveAt = Date.now(); updateSaveAge(); }

async function saveProject(asNew) {
  const data = projectData();
  try {
    if (asNew || !state.projectFile) {
      const res = await api.saveProjectAs(data);
      if (!res) return false; // Save-As cancelled: keep any pending confirm open
      if (res.ok === false) throw new Error(res.error || 'Save failed');
      state.projectFile = res.file;
      setStatus('Project saved: ' + res.file);
    } else {
      const res = await api.saveProject({ file: state.projectFile, data });
      if (res && res.ok === false) throw new Error(res.error || 'Save failed');
      setStatus('Project saved.');
    }
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    setStatus('Save failed: ' + msg);
    toast('Could not save project', { ding: true, danger: true });
    console.error('SAVE_ERR', e);
    return false;
  }
  markSaved();
  return true;
}

function migrateClips(legacyClips) {
  let acc = 0;
  return legacyClips.map((c) => {
    const srcStart = c.srcStart != null ? c.srcStart : (c.inPoint || 0);
    const srcEnd = c.srcEnd != null ? c.srcEnd : (c.outPoint != null ? c.outPoint : c.duration);
    const item = {
      id: c.id || newId(),
      path: c.path, name: c.name, duration: c.duration,
      start: acc, srcStart, srcEnd, mute: !!c.mute,
      kind: c.kind || 'video',
      width: c.width, height: c.height, fps: c.fps, vcodec: c.vcodec, acodec: c.acodec,
      audioSampleRate: c.audioSampleRate, audioChannels: c.audioChannels, hasAudio: c.hasAudio,
    };
    acc += srcEnd - srcStart;
    return item;
  });
}

function normalizeTimeline(rawItems) {
  const items = rawItems.map((c) => {
    const image = isImageItem(c);
    return {
      ...c,
      id: c.id || newId(),
      mute: c.mute != null ? !!c.mute : image,
      kind: c.kind || (image ? 'image' : 'video'),
      still: c.still || image || c.kind === 'freeze' || undefined,
    };
  });
  const anyStart = items.some((c) => c.start != null);
  if (!anyStart) {
    let acc = 0;
    for (const it of items) { it.start = acc; acc += durOf(it); }
  }
  return items;
}

async function loadProject() {
  if (!(await confirmUnsavedChanges())) return; // save/discard the open project first
  const res = await api.loadProject();
  if (!res) return;
  if (res.error) { alert('Could not load project:\n\n' + res.error); return; }
  try {
    const d = res.data;
    if (Array.isArray(d.timeline)) state.timeline = normalizeTimeline(d.timeline);
    else if (Array.isArray(d.clips)) state.timeline = migrateClips(d.clips);
    else state.timeline = [];
    state.soundboard = Array.isArray(d.soundboard)
      ? d.soundboard.map((c) => ({
        ...c, id: c.id || newId(),
        endTime: c.endTime != null ? c.endTime : undefined,
        srcStart: c.srcStart != null ? c.srcStart : undefined,
        srcEnd: c.srcEnd != null ? c.srcEnd : undefined,
        // Volume is stored in dB; legacy projects used a linear `gain`.
        volume: c.volume != null ? c.volume : (c.gain != null ? linToDb(c.gain) : 0),
      }))
      : [];
    state.hybrid = Array.isArray(d.hybrid)
      ? d.hybrid.map((h) => {
        const kind = h.kind || ((h.startTime != null && h.srcEnd == null) ? 'sound' : 'clip');
        const image = kind !== 'sound' && isImageItem(h);
        return {
          ...h,
          id: h.id || newId(),
          kind: image ? 'image' : kind,
          still: h.still || image || kind === 'freeze' || undefined,
          mute: kind !== 'sound' && image ? true : h.mute,
        };
      })
      : [];
    state.markers = Array.isArray(d.markers)
      ? d.markers.map((m) => ({ id: m.id || newId(), time: m.time || 0, label: m.label || '' }))
      : [];
    state.effects = Array.isArray(d.effects)
      ? d.effects
        .filter((e) => e && (e.type === 'shake' || (e.from && e.to)))
        .map((e) => ({ ...e, id: e.id || newId(), type: e.type === 'shake' ? 'shake' : 'zoom', lane: e.lane === 'hybrid' ? 'hybrid' : 'clips' }))
      : [];
    // Preferences (folders, encoder, …) deliberately live with the app, not the
    // project — loading an old project must not overwrite the user's settings.
    state.projectFile = res.file;
    clearSelection();
    resetHistory();
    keyCache.clear();  // the loaded timeline's clips/keyframes differ
    waveCache.clear();
    state.playhead = 0;
    srcInfo = { id: null, path: null, bIndex: -1, ready: true };
    clearStandby();
    $('#preview').removeAttribute('src');
    renderTimeline();
    refreshAllBins();
    fitTimeline();
    setStatus('Project loaded: ' + res.file);
    warmPreviewProxies();
    markSaved();
  } catch (e) {
    alert('Could not load project: ' + e.message);
  }
}

/* ---------------- new project, unsaved-changes prompt ---------------- */
function resetDocument() {
  state.timeline = [];
  state.soundboard = [];
  state.hybrid = [];
  state.markers = [];
  state.effects = [];
  state.projectFile = null;
  clearSelection();
  resetHistory();
  keyCache.clear();
  waveCache.clear();
  state.playhead = 0;
  srcInfo = { id: null, path: null, bIndex: -1, ready: true };
  clearStandby();
  $('#preview').removeAttribute('src');
  arrangeTrack();
  renderTimeline();
  refreshAllBins();
  fitTimeline();
}

function newProject() {
  resetDocument();
  markSaved(); // a blank document has nothing to save
  setStatus('New project.');
}

// Styled 3-way prompt, reused by New / Open / window-close. Resolves true when
// it is safe to proceed (saved or discarded), false when the user cancelled.
function confirmUnsavedChanges() {
  if (!isDirty()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const modal = $('#confirm-modal');
    const save = $('#confirm-save');
    const discard = $('#confirm-discard');
    const cancel = $('#confirm-cancel');
    const finish = (v) => {
      modal.classList.add('hidden');
      save.removeEventListener('click', onSave);
      discard.removeEventListener('click', onDiscard);
      cancel.removeEventListener('click', onCancel);
      resolve(v);
    };
    const onSave = async () => {
      save.disabled = true;
      try {
        const ok = await saveProject(false);
        if (ok) finish(true); // Save-As cancelled -> keep the prompt open
      } finally {
        save.disabled = false;
      }
    };
    const onDiscard = () => finish(true);
    const onCancel = () => finish(false);
    save.addEventListener('click', onSave);
    discard.addEventListener('click', onDiscard);
    cancel.addEventListener('click', onCancel);
    modal.classList.remove('hidden');
  });
}

/* ---------------- notifications (toast + ding) ---------------- */
let dingCtx = null;
function ding() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!dingCtx) dingCtx = new AC();
    const ctx = dingCtx;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const t0 = ctx.currentTime;
    [880, 1320].forEach((freq, i) => { // two quick ascending tones
      const t = t0 + i * 0.12;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
      o.connect(g); g.connect(ctx.destination);
      o.start(t); o.stop(t + 0.13);
    });
  } catch (_) { /* audio unavailable */ }
}

const activeToasts = new Map(); // tag -> toast element (for tagged/persistent toasts)

function removeToastEl(el, tag) {
  if (!el || !el.parentNode) return;
  el.classList.add('out');
  setTimeout(() => {
    el.remove();
    if (tag && activeToasts.get(tag) === el) activeToasts.delete(tag);
  }, 300);
}
function removeToast(tag) {
  const el = activeToasts.get(tag);
  if (el) removeToastEl(el, tag);
}

function toast(msg, opts = {}) {
  const host = $('#toasts');
  if (!host) return null;
  const el = document.createElement('div');
  el.className = 'toast' + (opts.danger ? ' danger' : '') + (opts.warn ? ' warn' : '');
  el.textContent = msg;
  if (opts.ding) ding();
  if (opts.tag) activeToasts.set(opts.tag, el);
  el.title = opts.persist ? 'Click to dismiss' : '';
  el.addEventListener('click', () => {
    removeToastEl(el, opts.tag);
    if (opts.onClick) opts.onClick();
  });
  host.appendChild(el);
  if (!opts.persist) setTimeout(() => removeToastEl(el, opts.tag), opts.ms || 6000);
  return el;
}

/* ---------------- save age, reminder, auto-save ---------------- */
function updateSaveAge() {
  const btn = $('#btn-save');
  if (!btn) return;
  const mins = (Date.now() - lastSaveAt) / 60000;
  btn.classList.remove('age-green', 'age-yellow', 'age-orange', 'age-red');
  btn.classList.add(mins < 5 ? 'age-green' : mins < 15 ? 'age-yellow' : mins < 30 ? 'age-orange' : 'age-red');
  const dirty = isDirty();
  btn.classList.toggle('dirty', dirty);
  btn.title = dirty
    ? `Unsaved changes — last saved ${Math.round(mins)} min ago`
    : 'All changes saved';
  if (!dirty) removeToast('unsaved'); // e.g. undo back to the saved state
}

const SAVE_REMIND_MS = 10 * 60000;
let lastRemindAt = Date.now();
function saveReminderTick() {
  if (Date.now() - Math.max(lastSaveAt, lastRemindAt) < SAVE_REMIND_MS) return;
  if (!isDirty()) return; // nothing to lose, or auto-save kept us current
  if (activeToasts.has('unsaved')) return; // already nagging (persistent until save/click)
  lastRemindAt = Date.now();
  toast("You haven't saved in 10 minutes.", {
    ding: true, warn: true, persist: true, tag: 'unsaved',
    onClick: () => { lastRemindAt = Date.now(); }, // dismissed -> remind again in 10 min
  });
}

function scheduleAutoSave() {
  if (autoSaveTimer) { clearInterval(autoSaveTimer); autoSaveTimer = 0; }
  if (!state.settings.autoSave) return;
  const mins = Math.max(1, Math.min(30, Number(state.settings.autoSaveMinutes) || 5));
  autoSaveTimer = setInterval(autoSaveTick, mins * 60000);
}

async function autoSaveTick() {
  if (!isDirty() || !state.projectFile) return; // never pop a Save-As dialog here
  try {
    const res = await api.saveProject({ file: state.projectFile, data: projectData() });
    if (res && res.ok === false) throw new Error(res.error || 'Auto-save failed');
    markSaved();
    setStatus('Auto-saved ' + new Date().toLocaleTimeString());
  } catch (_) { /* ignore */ }
}

/* ---------------- purge used media ---------------- */
// Moves source Media files referenced by any saved project into
// <outputDir>/Purged and repoints the saves. Two-phase: a dry run builds the
// preview list, then the confirm button performs the real move.
function fmtBytes(n) {
  n = Number(n) || 0;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(i === 0 ? 0 : (n >= 10 ? 0 : 1))} ${u[i]}`;
}

function purgePayload(dryRun) {
  return {
    outputDir: (state.settings.outputDir || '').trim(),
    baseDir: (state.settings.baseDir || '').trim(),
    mediaExt: state.mediaExt,
    audioExt: state.audioExt,
    imageExt: state.imageExt,
    dryRun,
  };
}

function renderPurgeModal(r) {
  const list = $('#purge-list');
  list.innerHTML = '';
  for (const f of r.files) {
    const row = document.createElement('div');
    row.className = 'purge-item';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = f.name;
    nm.title = f.path;
    const sz = document.createElement('span');
    sz.className = 'sz';
    sz.textContent = fmtBytes(f.size);
    row.append(nm, sz);
    list.appendChild(row);
  }
  $('#purge-summary').textContent =
    `${r.files.length} file(s) (${fmtBytes(r.totalSize)}) will be moved to  ${r.purgeDir}  `
    + `and ${r.projects.length} save(s) will be updated to the new location.`;
}

async function purgeUsedMedia() {
  const payload = purgePayload(true);
  if (!payload.outputDir || !payload.baseDir) {
    setStatus('Set the Output and Media folders in Settings first.');
    return;
  }
  setStatus('Scanning saves for used media…');
  const r = await api.purgeUsedMedia(payload);
  if (!r || !r.ok) { alert('Purge failed:\n\n' + ((r && r.error) || 'unknown error')); return; }
  if (!r.files.length) { setStatus('Nothing to purge — no project-used media found in the Media folder.'); return; }
  renderPurgeModal(r);
  $('#purge-modal').classList.remove('hidden');
}

// Repoint the currently open timeline/soundboard/CLIPS2 at the moved files so
// the in-memory project keeps playing without a reload.
function remapOpenProject(moved) {
  const norm = (p) => String(p || '').toLowerCase().replace(/\//g, '\\');
  const map = new Map();
  for (const m of moved) map.set(norm(m.path), m.dest);
  const fix = (arr) => {
    for (const it of arr || []) {
      if (it && it.path) { const np = map.get(norm(it.path)); if (np) it.path = np; }
    }
  };
  fix(state.timeline); fix(state.soundboard); fix(state.hybrid);
}

async function confirmPurge() {
  $('#purge-modal').classList.add('hidden');
  const r = await api.purgeUsedMedia(purgePayload(false));
  if (!r || !r.ok) { alert('Purge failed:\n\n' + ((r && r.error) || 'unknown error')); return; }
  const moved = r.moved || [];
  if (moved.length) {
    remapOpenProject(moved);
    keyCache.clear();
    waveCache.clear();
    renderTimeline();
  }
  const updated = (r.updatedProjects || []).length;
  const failedN = (r.failed || []).length;
  setStatus(`Moved ${moved.length} file(s) to Purged, updated ${updated} save(s)`
    + (failedN ? `, ${failedN} failed` : '') + '.');
  refreshAllBins();
}

/* ---------------- drop handling ---------------- */
function dropTimeAt(e) {
  return snapDrop(Math.max(-PREROLL, timeAtClientX(e)));
}

// Total output length of the tiles currently being dragged (bin items carry a
// probed duration; multi-select stacks them sequentially like the insert does).
function pendingDragLen() {
  if (!pendingDrag || !Array.isArray(pendingDrag.items)) return 0;
  let n = 0;
  for (const it of pendingDrag.items) n += it.duration > 0 ? it.duration : 0;
  return n;
}

// Solid length ghost: a filled block over the target track spanning the inserted
// duration, with a label. Rendered as a permanent child of #tl-inner positioned
// absolutely, so timeline repaints (renderTimeline rebuilds lane bodies, not
// #tl-inner's own children) can't remove it mid-drag.
function showDropProxy(t, laneKey) {
  const track = laneKey === 'sounds' ? $('#tl-track-audio')
    : laneKey === 'hybrid' ? $('#tl-track-hybrid')
    : $('#tl-track-video');
  const proxy = $('#drop-proxy');
  if (!track || !proxy) return;
  const len = pendingDragLen();
  proxy.classList.remove('hidden');
  proxy.style.top = (track.offsetTop + 3) + 'px';
  proxy.style.height = Math.max(12, track.offsetHeight - 6) + 'px';
  proxy.style.left = timeToX(t) + 'px'; // timeline-global X, same as the marker/ruler
  proxy.style.width = Math.max(6, len * state.pps) + 'px';
  proxy.textContent = len > 0 ? fmt(len) : '⋯'; // 0-length probe -> "unknown" rather than an invisible sliver
  // Name chip, left-aligned with the ghost and sitting 2px above it. Kept even
  // if that overflows the top of the lane (it stays put until the drop).
  const chip = $('#drag-chip');
  const label = dragChipLabel();
  if (chip && label) {
    chip.textContent = label;
    chip.classList.remove('hidden');
    const chipH = chip.offsetHeight; // measured after unhide
    chip.style.left = timeToX(t) + 'px';
    chip.style.top = ((track.offsetTop + 3) - 2 - chipH) + 'px';
    hideDragCard(); // the ghost is shown, so the floating card must go
  } else if (chip) {
    chip.classList.add('hidden');
  }
}
function hideDropProxy() {
  const proxy = $('#drop-proxy');
  if (proxy) proxy.classList.add('hidden');
  const chip = $('#drag-chip');
  if (chip) chip.classList.add('hidden');
}

// Ripple scope by the lane the pointer is over (MAIN pushes all, ALT/SOUND push
// their own lane only). Matches the routing in handleDrop.
function insertScopeForLane(lane) {
  return lane === 'hybrid' ? 'alt' : lane === 'sounds' ? 'sound' : 'main';
}
// Where the dropped items will actually start (snapped to a lane edge if the
// pointer sits on top of a clip/sound), used for the drop marker + ghost.
function dropInsertTime(e, lane) {
  return TimelineOps.resolveInsertTime(state, dropTimeAt(e), insertScopeForLane(lane));
}
// Ghost time: effects are free-positioned (no clip-edge insert snap), so the
// marker/ghost follow the pointer exactly like the drop does.
function dropGhostTime(e, lane) {
  return pendingDrag && pendingDrag.kind === 'effects' ? dropTimeAt(e) : dropInsertTime(e, lane);
}
// A bin drag that can't land on the hovered lane (video over SOUND).
function dropRejectedForLane(lane) {
  return lane === 'sounds' && pendingDrag && pendingDrag.kind !== 'sounds';
}

function handleDrop(e) {
  const t = dropTimeAt(e);
  const lane = laneAt(e.clientY);
  const toHyb = lane === 'hybrid';   // ALT lane
  const toSounds = lane === 'sounds'; // SOUND lane — audio only
  let payloadStr = e.dataTransfer.getData('application/x-clipmerger');
  if (!payloadStr) payloadStr = e.dataTransfer.getData('text/plain');
  let payload = null;
  if (payloadStr) {
    try { payload = JSON.parse(payloadStr); } catch (_) { payload = null; }
  }
  // Fall back to the remembered drag if dataTransfer read-back was stripped.
  if (!payload && pendingDrag && Array.isArray(pendingDrag.items) && pendingDrag.items.length) {
    payload = pendingDrag;
  }
  if (payload) {
    const kind = payload.kind;
    const arr = Array.isArray(payload.items) ? payload.items : [];
    hideDropProxy();
    if (kind === 'effects') {
      if (toSounds) { setStatus('Effects go on a video lane (MAIN or ALT).'); return; }
      const defId = arr[0] && arr[0].defId;
      addEffect(defId, toHyb ? 'hybrid' : 'clips', t);
      return;
    }
    if (kind === 'sounds') {
      const items = arr.filter((x) => x && x.path).map(toHyb ? baseHybSound : baseSoundFromItem);
      items.forEach((it) => { it.origin = kind; });
      if (toHyb) addHybridItems(items, t); else addSoundItems(items, t);
    } else {
      if (toSounds) { setStatus('SOUND lane takes audio only — drop this on MAIN or ALT.'); return; }
      const items = arr.filter((x) => x && x.path).map(toHyb ? baseHybClip : baseItemToTimeline);
      items.forEach((it) => { it.origin = kind; });
      if (toHyb) addHybridItems(items, t); else addTimelineItems(items, t);
    }
    return;
  }
  const files = [...(e.dataTransfer?.files || [])]
    .map((f) => api.getPathForFile(f))
    .filter(Boolean);
  const extOf = (f) => { const i = f.lastIndexOf('.'); return i >= 0 ? f.slice(i + 1).toLowerCase() : ''; };
  const video = [], audio = [];
  for (const f of files) {
    const ext = extOf(f);
    if (state.mediaExt.includes(ext) || state.imageExt.includes(ext)) video.push(f);
    else if (state.audioExt.includes(ext)) audio.push(f);
  }
  if (!video.length && !audio.length) return;
  if (toSounds && !audio.length) { setStatus('SOUND lane takes audio only.'); return; }
  setStatus('Reading media…');
  api.probe({ ffprobePath: state.settings.ffprobePath, files: [...video, ...audio] }).then((probed) => {
    let vItems = [], sItems = [];
    for (const p of probed) {
      if (p.error) continue;
      if (video.includes(p.path)) {
        if (toSounds) continue; // SOUND lane ignores video
        const it = toHyb ? baseHybClip(p) : baseItemToTimeline(p);
        it.origin = 'media';
        vItems.push(it);
      } else {
        const it = toHyb ? baseHybSound(p) : baseSoundFromItem(p);
        it.origin = 'sounds';
        sItems.push(it);
      }
    }
    if (toHyb) { if (vItems.length) addHybridItems(vItems, t); if (sItems.length) addHybridItems(sItems, t); }
    else { if (vItems.length) addTimelineItems(vItems, t); if (sItems.length) addSoundItems(sItems, t); }
    setStatus(toSounds
      ? `Added ${sItems.length} sound(s) to SOUND — video ignored.`
      : `Added ${vItems.length} clip(s), ${sItems.length} sound(s)`);
  });
}

/* ---------------- events ---------------- */
function wireEvents() {
  wireMicEvents();
  // Close the shared context menu on any outside press or window blur.
  document.addEventListener('pointerdown', (e) => {
    const menu = $('#ctx-menu');
    if (menu && !menu.classList.contains('hidden') && !e.target.closest('#ctx-menu')) closeContextMenu();
  }, true);
  window.addEventListener('blur', closeContextMenu);
  $('#btn-new').addEventListener('click', async () => { if (await confirmUnsavedChanges()) newProject(); });
  $('#btn-open').addEventListener('click', loadProject);
  $('#btn-save').addEventListener('click', () => saveProject(false));
  $('#btn-settings').addEventListener('click', openSettings);
  $('#layout-toggle').addEventListener('click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (b && b.dataset.layout) setLayout(b.dataset.layout);
  });
  $('#set-close').addEventListener('click', applySettings);
  $('#set-autosave').addEventListener('change', (e) => { $('#set-autosave-min').disabled = !e.target.checked; });
  $('#set-autosave-min').addEventListener('input', (e) => { $('#set-autosave-val').textContent = e.target.value + ' min'; });
  $('#btn-export').addEventListener('click', doExport);
  $('#btn-export-cancel').addEventListener('click', () => { api.cancelExport(); setStatus('Cancelling export…'); });
  $('#btn-help').addEventListener('click', () => $('#help-modal').classList.remove('hidden'));
  $('#help-close').addEventListener('click', () => $('#help-modal').classList.add('hidden'));
  $('#btn-history').addEventListener('click', () => { renderHistory(); $('#history-modal').classList.remove('hidden'); });
  $('#history-close').addEventListener('click', () => $('#history-modal').classList.add('hidden'));
  const purgeBtn = $('#btn-purge-media');
  if (purgeBtn) purgeBtn.addEventListener('click', purgeUsedMedia);
  $('#purge-cancel').addEventListener('click', () => $('#purge-modal').classList.add('hidden'));
  $('#purge-confirm').addEventListener('click', confirmPurge);

  // Viewer: open/close the single-clip media preview and its side-by-side layout.
  $('#viewer-split').addEventListener('click', () => setViewerSplit(!state.viewer.split));

  // Effect editing on the preview stage: wheel sets the zoom of the pose being
  // edited (Start/End), drag pans it 1:1. Active when an effect is selected.
  const zoomStage = document.querySelector('.preview-stage');
  if (zoomStage) {
    zoomStage.addEventListener('wheel', (e) => {
      const eff = soleSelectedEffect();
      if (!eff || state.viewer.mode !== 'program') return;
      const pose = editTargetPose();
      if (!pose) return;
      e.preventDefault();
      const step = e.shiftKey ? 0.01 : 0.05;
      pose.z = Math.round(clamp(pose.z + (e.deltaY < 0 ? step : -step), 0.25, 4) * 100) / 100;
      zoomEditTouch('Effect zoom');
      updatePreviewZoomTransform();
    }, { passive: false });
    zoomStage.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const eff = soleSelectedEffect();
      if (!eff || eff.type === 'shake' || state.viewer.mode !== 'program') return;
      drag = { type: 'zoomcenter', id: eff.id, lastX: e.clientX, lastY: e.clientY };
      snapshot();
      try { zoomStage.setPointerCapture(e.pointerId); } catch (_) {}
      e.preventDefault();
    });
    // Double-click: reset the pose being edited to whole-frame / no zoom.
    zoomStage.addEventListener('dblclick', () => {
      const eff = soleSelectedEffect();
      if (!eff || state.viewer.mode !== 'program') return;
      const pose = editTargetPose();
      if (!pose) return;
      snapshot();
      pose.z = 1; pose.cx = 0.5; pose.cy = 0.5;
      commit('Reset effect pose');
      renderTimeline();
      updatePreviewZoomTransform();
      updateToolbar();
      setStatus(state.effectPose === 'from' ? 'Start pose reset to whole frame.' : 'End pose reset to whole frame.');
    });
  }

  $('#btn-play').addEventListener('click', togglePlay);
  $('#btn-split').addEventListener('click', splitAtPlayhead);
  $('#btn-del').addEventListener('click', deleteSelection);
  $('#btn-mark').addEventListener('click', addMarkerAtPlayhead);
  // Cut navigation now lives on the shutter bar's ends.
  $('#btn-scrub-start').addEventListener('click', jumpToStart);
  $('#btn-scrub-end').addEventListener('click', jumpToEnd);
  $('#btn-scrub-prev').addEventListener('click', () => jumpToCut(-1));
  $('#btn-scrub-next').addEventListener('click', () => jumpToCut(1));
  // Buttons sit inside the draggable shuttle; don't let a press start a scrub.
  $$('#tl-scrub .scrub-nav button').forEach((b) => b.addEventListener('pointerdown', (e) => e.stopPropagation()));
  $('#btn-detach').addEventListener('click', () => {
    const item = soleSelectedClipAny();
    if (item) detachAudio(item);
  });
  $('#btn-speed').addEventListener('change', (e) => {
    const item = soleSelectedClipAny();
    if (!item) return;
    snapshot();
    item.speed = parseFloat(e.target.value) || 1;
    commit(`Speed ${item.speed}×`);
    renderTimeline();
  });
  $('#btn-framing').addEventListener('change', (e) => {
    const sel = allSelClips();
    const v = e.target.value;
    if (!sel.length || !v) return;
    snapshot();
    for (const it of sel) it.fit = v;
    commit(`Frame ${v === 'blur' ? 'blur' : 'fill & crop'}`);
    renderTimeline();
    setStatus(`Framing set to ${v === 'blur' ? 'whole frame + blurred background' : 'fill & crop'} for ${sel.length} clip(s).`);
  });
  // Camera effects: the pose select + ease/bg buttons act on the selected effect;
  // the FX toggle hides the bands so the clips behind can be clicked.
  $('#btn-eff-pose').addEventListener('change', (e) => {
    const eff = soleSelectedEffect();
    state.effectPose = e.target.value === 'from' ? 'from' : 'to';
    if (!eff) return;
    // Park the preview at that pose's time so the scroll/drag edits it.
    const t = state.effectPose === 'from' ? eff.start : Math.max(eff.start, effectEnd(eff) - 1e-3);
    seekPreview(t);
    updatePreviewZoomTransform();
    setStatus(state.effectPose === 'from' ? 'Editing the Start pose.' : 'Editing the End pose.');
  });
  $('#btn-zoom-ease').addEventListener('click', () => {
    const eff = soleSelectedEffect();
    if (!eff) return;
    snapshot();
    eff.ease = eff.ease === 'linear' ? 'smooth' : 'linear';
    commit(`Effect ${eff.ease}`);
    renderTimeline();
    updateToolbar();
  });
  $('#btn-zoom-bg').addEventListener('click', () => {
    const eff = soleSelectedEffect();
    if (!eff) return;
    snapshot();
    eff.bg = eff.bg === 'blur' ? 'black' : 'blur';
    commit(`Effect bg ${eff.bg}`);
    renderTimeline();
    syncActiveMute();
    updateToolbar();
  });
  $('#btn-fx-toggle').addEventListener('click', () => {
    state.showEffects = !state.showEffects;
    renderTimeline();
    updateToolbar();
    setStatus(state.showEffects ? 'Effects shown.' : 'Effects hidden - click through to the clips.');
  });

  // Shake intensity: slider + number, live preview, debounced commit. Only acts on
  // a selected Shake effect; parks the playhead inside the band so the shake shows.
  const shAmpEl = $('#shake-amp');
  const shNumEl = $('#shake-amp-num');
  let shakeSnapPending = false;
  let shakeCommitTimer = 0;
  function setShakeAmp(percent, immediate) {
    const eff = soleSelectedEffect();
    if (!eff || eff.type !== 'shake') return;
    const s = eff.start || 0;
    const e = s + Math.max(0, eff.dur || 0);
    if (state.playhead < s - 1e-6 || state.playhead >= e - 1e-6) {
      seekPreview(clamp(state.playhead, s, Math.max(s, e - 1e-4)));
    }
    if (!shakeSnapPending) { snapshot(); shakeSnapPending = true; }
    const v = clamp(Number(percent) || 4, 1, 15);
    eff.amp = v / 100;
    if (shAmpEl) shAmpEl.value = String(v);
    if (shNumEl) shNumEl.value = String(v);
    updatePreviewZoomTransform();
    clearTimeout(shakeCommitTimer);
    const finish = () => {
      shakeSnapPending = false;
      commit(`Shake ${Math.round(eff.amp * 1000) / 10}%`);
      renderTimeline();
      updateToolbar();
    };
    if (immediate) finish();
    else shakeCommitTimer = setTimeout(finish, 400);
  }
  if (shAmpEl) {
    shAmpEl.addEventListener('input', (e) => setShakeAmp(e.target.value, false));
    shAmpEl.addEventListener('change', (e) => setShakeAmp(e.target.value, true));
  }
  if (shNumEl) {
    shNumEl.addEventListener('change', (e) => setShakeAmp(e.target.value, true));
  }

  // Volume applies live while dragging (input) and commits once on release
  // (change), so the preview reflects the dB immediately.
  function applyVol(db, commitHistory) {
    const clips = allSelClips();
    const snds = allSelSounds();
    if (!clips.length && !snds.length) return;
    if (commitHistory) snapshot();
    for (const it of clips) it.volume = db;
    for (const s of snds) s.volume = db;
    if (commitHistory) commit(`Volume ${db > 0 ? '+' : ''}${db} dB`);
    renderTimeline();
    syncActiveMute(); // reflect the new gain on the active preview right away
    setStatus(`Volume set to ${db > 0 ? '+' : ''}${db} dB for ${clips.length + snds.length} item(s).`);
  }
  const volRange = $('#vol-range');
  volRange.addEventListener('input', (e) => applyVol(parseFloat(e.target.value), false));
  volRange.addEventListener('change', (e) => applyVol(parseFloat(e.target.value), true));
  volRange.addEventListener('dblclick', () => { volRange.value = '0'; applyVol(0, true); });
  $('#btn-speed').addEventListener('dblclick', () => {
    const item = soleSelectedClipAny();
    if (!item) return;
    snapshot();
    item.speed = 1;
    commit('Speed 1×');
    renderTimeline();
  });
  $('#btn-fit').addEventListener('click', fitTimeline);
  $('#btn-snap').addEventListener('change', (e) => { state.snap = e.target.checked; });
  const gapBtn = $('#btn-close-gaps');
  gapBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
  gapBtn.addEventListener('click', () => closeAllGaps());
  const gapBtn2 = $('#btn-close-gaps2');
  if (gapBtn2) {
    gapBtn2.addEventListener('pointerdown', (e) => e.stopPropagation());
    gapBtn2.addEventListener('click', () => closeHybridGaps());
  }
  // The frozen label gutter shouldn't seek when clicked.
  $$('.tl-track-label').forEach((el) => el.addEventListener('pointerdown', (e) => e.stopPropagation()));

  // bins
  $$('.bin').forEach((section) => {
    const key = section.dataset.bin;
    $('.bin-toggle', section).addEventListener('click', () => { section.classList.toggle('collapsed'); applyBinSizes(); });
    if (key === 'effects') return; // fixed list, not folder-backed
    $('.bin-refresh', section).addEventListener('click', () => {
      const bin = state.bins[key];
      bin.cache.clear();
      loadBinFolder(key, bin.cwd || binDir(key), true);
    });
    $('.bin-dir', section).addEventListener('click', async () => {
      const d = await api.chooseDir();
      if (!d) return;
      const old = binDir(key);
      if (key === 'media') state.settings.baseDir = d;
      else if (key === 'transitions') state.settings.transitionDir = d;
      else state.settings.soundsDir = d;
      if (old && old !== d) api.unwatch(old); // free the old folder watcher
      persistSettings();
      refreshBin(key);
    });
    $('.bin-add', section).addEventListener('click', async () => {
      const files = await api.openMedia({ audio: key === 'sounds' });
      if (!files.length) return;
      const probed = await api.probe({ ffprobePath: state.settings.ffprobePath, files });
      const items = probed.filter((p) => !p.error);
      if (key === 'sounds') addSoundItems(items.map((it) => { const s = baseSoundFromItem(it); s.origin = 'sounds'; return s; }), totalDuration());
      else addTimelineItems(items.map((it) => { const c = baseItemToTimeline(it); c.origin = key; return c; }), totalDuration());
    });
  });
  renderEffectsBin();

  $('#set-outdir-pick').addEventListener('click', async () => {
    const d = await api.chooseDir();
    if (d) $('#set-outdir').value = d;
  });
  $('#set-basedir-pick').addEventListener('click', async () => {
    const d = await api.chooseDir();
    if (d) $('#set-basedir').value = d;
  });
  $('#set-transdir-pick').addEventListener('click', async () => {
    const d = await api.chooseDir();
    if (d) $('#set-transdir').value = d;
  });
  $('#set-soundsdir-pick').addEventListener('click', async () => {
    const d = await api.chooseDir();
    if (d) $('#set-soundsdir').value = d;
  });

  api.onBaseChanged(() => refreshLoadedBins());
  window.addEventListener('beforeunload', persistSettings);

  markSaved();                            // a blank startup document is clean
  scheduleAutoSave();
  setInterval(updateSaveAge, 30000);      // keep the Save-button colour current
  setInterval(saveReminderTick, 60000);   // nag about unsaved work (every 10 min)

  // Main asks us to close: we own the unsaved-changes prompt, then reply.
  if (api.onRequestClose) api.onRequestClose(async () => {
    const safe = await confirmUnsavedChanges();
    if (!safe) { api.closeConfirm(false); return; }
    if (state.exporting) {
      const quit = confirm('An export is still running. Cancel it and quit?');
      if (!quit) { api.closeConfirm(false); return; }
      setStatus('Cancelling export…');
    }
    api.closeConfirm(true);
  });

  api.onPreviewDone((p) => {
    if (p && p.original && p.file) { previewProxy.set(p.original, p.file); onProxyReady(p.original); }
  });

  api.onScanProgress((p) => {
    const key = BIN_KEYS.find((k) => state.bins[k].cwd === p.dir || state.bins[k].root === p.dir);
    if (!key) return;
    const bin = state.bins[key];
    bin.progress = { done: p.done, total: p.total };
    if (!bin.loading) return;
    const section = $(`.bin[data-bin="${key}"]`);
    const label = p.total ? `⏳ Scanning… ${p.done}/${p.total}` : '⏳ Scanning…';
    const sub = $('[data-role="sub"]', section);
    if (sub) sub.textContent = p.total ? `scanning ${p.done}/${p.total}` : 'scanning…';
    const empty = $('.bin-empty', section);
    if (empty) empty.textContent = label;
  });

  // timeline pointer handling (seek / middle-drag pan)
  const sc = $('#tl-scroll');
  sc.addEventListener('pointerdown', (e) => {
    if (e.button === 1) {
      drag = { type: 'pan', lastX: e.clientX };
      sc.classList.add('active-pan');
      e.preventDefault();
      return;
    }
    if (e.button === 0) {
      // Plain click = clear selection + seek; a drag beyond the threshold
      // becomes a marquee (rubber-band) selection on the lanes.
      if (anySelected()) { clearSelection(); renderTimeline(); }
      drag = { type: 'marquee', downX: e.clientX, downY: e.clientY, t0: timeAtClientX(e), started: false };
    }
  });
  sc.addEventListener('scroll', updateScrollbar);
  window.addEventListener('resize', () => { updateScrollbar(); applyBinSizes(); });

  // Ctrl / Cmd + wheel zooms the timeline, anchored at the cursor. Must be a
  // non-passive listener so we can suppress Chromium's default page zoom.
  const tlPanel = $('#timeline-panel');
  tlPanel.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.deltaY === 0) return;
    e.preventDefault();
    const r = sc.getBoundingClientRect();
    const before = (e.clientX - r.left + sc.scrollLeft - PAD) / state.pps - PREROLL;
    state.pps = Math.max(4, Math.min(3000, state.pps * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
    renderTimeline();
    // Keep the time under the cursor exactly where it was.
    const want = PAD + (before + PREROLL) * state.pps - (e.clientX - r.left);
    sc.scrollLeft = clamp(want, 0, Math.max(0, sc.scrollWidth - sc.clientWidth));
    updateScrollbar();
  }, { passive: false });

  // scrub bar: grab & slide the timeline under the pinned marker, preview follows (tap = no-op)
  const scrub = $('#tl-scrub');
  scrub.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const sc = $('#tl-scroll');
    const pin = timeToX(state.playhead) - sc.scrollLeft; // marker's screen x
    drag = {
      type: 'scrub',
      lastX: e.clientX,
      pin: pin,
      // Un-clamped accumulator for where the finger *wants* the view to be. The
      // real scrollLeft clamps at the edges, but this keeps growing so extra
      // travel past an edge keeps moving the tracker (see the scrub move branch).
      wantScroll: sc.scrollLeft,
    };
    try { scrub.setPointerCapture(e.pointerId); } catch (_) {}
    scrub.classList.add('dragging');
    if (state.playing) pausePlay();
    e.preventDefault();
  });
  scrub.addEventListener('lostpointercapture', () => scrub.classList.remove('dragging'));

  // preview glue (gap-skipping): pieces cut from the same file meet exactly in
  // source time, so the boundary is a pure bookkeeping flip (no seek/reload →
  // seamless); a different next file is pre-loaded into the hidden standby
  // element and swapped in instantly.
  async function handleBoundary(el, idx) {
    const seq = videoSegments();
    const seg = seq[idx];
    if (!seg) return;
    const cur = seg.item;
    if (idx >= seq.length - 1) {
      const pieceEnd = seg.end;
      // If anything (typically the Sounds lane) continues past the last video
      // piece, don't stop — hold the frame and run the audio tail to the end.
      if (totalDuration() > pieceEnd + 1e-6) {
        state.playhead = pieceEnd;
        updatePlayhead(); updateTimeReadout();
        syncSoundPreview(true);
        startMonitor(true);
        return;
      }
      state.playhead = totalDuration();
      updatePlayhead(); updateTimeReadout();
      pausePlay();
      return;
    }
    const nextSeg = seq[idx + 1];
    const next = nextSeg.item;
    if (TimelineOps.isStill(next)) {
      try { el.pause(); } catch (_) {}
      await beginStillSegment(nextSeg, idx + 1, nextSeg.start);
      return;
    }
    const segSrcEnd = seg.srcEnd;
    // SAME FILE + pieces essentially meet (exact split, or a couple of frames
    // apart from a keyframe-snapped trim) → keep playing, just move the
    // bookkeeping. No seek, no reload, and no redundant playbackRate write
    // (that alone can cause a micro-stall): the stream flows through the cut.
    if (next.path === cur.path && Math.abs(nextSeg.srcStart - segSrcEnd) < 0.05) {
      srcInfo.id = next.id;
      srcInfo.bIndex = idx + 1;
      state.playhead = nextSeg.start;
      updatePlayhead(); updateTimeReadout();
      setRate(el, next);
      syncActiveMute();
      prefetchStandby(idx + 2);
      return;
    }
    // DIFFERENT file already staged in the standby → swap instantly (the standby
    // kept a decoded frame at its start).
    if (srcB.ready && srcB.bIndex === idx + 1 && srcB.path === next.path) {
      swapPreview();
      const act = $('#preview');
      state.playhead = nextSeg.start;
      updatePlayhead(); updateTimeReadout();
      setRate(act, next);
      if (Math.abs(act.currentTime - nextSeg.srcStart) > 0.05) { try { act.currentTime = nextSeg.srcStart; } catch (_) {} }
      syncPreviewBgTime(act.currentTime);
      act.play().catch(() => {});
      prefetchStandby(idx + 2);
      return;
    }
    // Same file but not meeting exactly (trimmed edges) → seek in place.
    if (next.path === cur.path) {
      srcInfo.id = next.id;
      srcInfo.bIndex = idx + 1;
      state.playhead = nextSeg.start;
      updatePlayhead(); updateTimeReadout();
      setRate(el, next);
      el.currentTime = nextSeg.srcStart;
      syncActiveMute();
      syncPreviewBgTime(el.currentTime);
      prefetchStandby(idx + 2);
      return;
    }
    // Different file, standby not yet ready → load in place (accepted fallback).
    try {
      await ensureLoaded(next, idx + 1, el, srcInfo);
      setRate(el, next);
      el.currentTime = nextSeg.srcStart;
      state.playhead = nextSeg.start;
      updatePlayhead(); updateTimeReadout();
      syncActiveMute();
      syncPreviewBgTime(el.currentTime);
      el.play().catch(() => {});
    } catch (_) {}
    prefetchStandby(idx + 2);
  }
  function previewTimeupdate(e) {
    const el = e.target || $('#preview');
    if (!state.playing || el !== $('#preview')) return;
    const seq = videoSegments();
    const idx = srcInfo.bIndex;
    if (idx < 0 || idx >= seq.length) return;
    const seg = seq[idx];
    const item = seg.item;
    if (TimelineOps.isStill(item)) return;
    const speed = speedOf(item);
    if (el.currentTime >= seg.srcEnd - 0.03) {
      handleBoundary(el, idx);
      return;
    }
    const prog = seg.start + (el.currentTime - seg.srcStart) / speed;
    state.playhead = prog;
    updatePlayhead();
    updateTimeReadout();
    updatePreviewZoomTransform();
    syncPreviewBgTime(el.currentTime);
  }
  $('#preview').addEventListener('timeupdate', previewTimeupdate);
  $('#preview-b').addEventListener('timeupdate', previewTimeupdate);

  // global pointer
  window.addEventListener('pointermove', onDragMove);
  // A pending paste is placed by the next click inside the timeline (capture so
  // it wins over the item/lane handlers, which stopPropagation on the bubble).
  window.addEventListener('pointerdown', (e) => {
    if (!pastePending) return;
    const panel = $('#timeline-panel');
    if (!panel || !panel.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    placePaste(e);
  }, true);
  window.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const d = drag;
    const t = d.type;
    drag = null;
    $('#tl-scroll').classList.remove('active-pan');
    const scrubEl = $('#tl-scrub');
    if (scrubEl) scrubEl.classList.remove('dragging');
    hideGuide();
    hideDropMarker();
    hideSelBox();
    clearDropTargetLane();
    if (t === 'marquee') {
      if (!d.started) {
        // Plain click on empty timeline = seek there.
        seekPreview(Math.max(-PREROLL, d.t0));
        return;
      }
      const sc = $('#tl-scroll');
      const r = sc.getBoundingClientRect();
      const tEnd = timeAtClientX(e);
      const tMin = Math.min(d.t0, tEnd), tMax = Math.max(d.t0, tEnd);
      const top = Math.min(d.downY, e.clientY) - r.top + sc.scrollTop;
      const bottom = Math.max(d.downY, e.clientY) - r.top + sc.scrollTop;
      const lanes = [];
      const defs = [['clips', $('#tl-track-video')], ['hybrid', $('#tl-track-hybrid')], ['sounds', $('#tl-track-audio')]];
      for (const [key, el] of defs) {
        if (el && bottom >= el.offsetTop && top <= el.offsetTop + el.offsetHeight) lanes.push(key);
      }
      marqueeSelect(tMin, tMax, lanes, e.ctrlKey || e.metaKey);
      return;
    }
    if (t === 'pad') { updateScrollbar(); return; }
    if (t === 'move') {
      commit('Move clip(s)');
      // A click (or a grab that didn't actually move the clip) on one of several
      // selected clips collapses the selection to just it - so a stale group can
      // never linger after you change Frame on a single cut.
      let moved = false;
      if (d.wasMulti && d.group.length) {
        const g0 = d.group.find((x) => x.id === d.itemId);
        const cur = state.timeline.find((c) => c.id === d.itemId);
        if (g0 && cur) moved = Math.abs((cur.start || 0) - g0.start) > 1e-6;
      }
      if (d.wasMulti && !moved) selectClip(d.itemId, false);
      else renderTimeline();
      return;
    }
    if (t === 'sbmove') {
      commit('Move sound(s)');
      let movedSb = false;
      if (d.wasMulti && d.group.length) {
        const g0 = d.group.find((x) => x.id === d.id);
        const cur = state.soundboard.find((s) => s.id === d.id);
        if (g0 && cur) movedSb = Math.abs((cur.startTime || 0) - g0.start) > 1e-6;
      }
      if (d.wasMulti && !movedSb) selectSb(d.id, false);
      else renderTimeline();
      return;
    }
    if (t === 'trim' || t === 'sbtrim') { commit('Trim'); renderTimeline(); return; }
    if (t === 'effmove' || t === 'efftrim') { linkAdjacentZoomPoses(); commit('Effect timing'); renderTimeline(); updateToolbar(); return; }
    if (t === 'zoomcenter') { commit('Effect pan'); renderTimeline(); updateToolbar(); return; }
    if (t === 'marker') { commit('Move marker'); renderTimeline(); return; }
    if (t === 'hybmove' || t === 'hybtrim' || t === 'hybsoundtrim') {
      commit('Move ALT item(s)');
      renderTimeline();
      return;
    }
    renderTimeline();
  });

  // drop from bins / OS onto timeline
  const panel = $('#timeline-panel');
  // Canonical guards: never let a stray image/file drop navigate the window, and
  // make the whole window a valid drop target (the panel handler does the work).
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    e.preventDefault();
    if (!dragCardEl) return;
    moveDragCard(e);
    const r = $('#tl-scroll').getBoundingClientRect();
    const overTimeline = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (overTimeline) hideDragCard();            // the lane handler shows the name chip
    else { showDragCard(); hideDropProxy(); }    // off the lanes -> floating tile card only
  }, { capture: true });
  window.addEventListener('drop', (e) => e.preventDefault(), { capture: true });

  panel.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    panel.classList.add('dragging');
    const lane = laneAt(e.clientY);
    const t = dropGhostTime(e, lane);
    const m = $('#drop-marker');
    m.classList.remove('hidden');
    m.style.left = timeToX(t) + 'px';
    if (pendingDrag && !dropRejectedForLane(lane)) showDropProxy(t, lane);
    else hideDropProxy();
  });
  panel.addEventListener('dragenter', (e) => {
    panel.classList.add('dragging');
    const lane = laneAt(e.clientY);
    if (pendingDrag && !dropRejectedForLane(lane)) showDropProxy(dropGhostTime(e, lane), lane);
    else hideDropProxy();
  });
  panel.addEventListener('dragleave', (e) => {
    if (!panel.contains(e.relatedTarget)) {
      panel.classList.remove('dragging');
      hideDropMarker();
      hideDropProxy();
    }
  });
  panel.addEventListener('drop', (e) => {
    e.preventDefault();
    panel.classList.remove('dragging');
    hideDropMarker();
    hideDropProxy();
    handleDrop(e);
  });
  // A finished drag (dropped or cancelled) lets the bins re-render and clears
  // the remembered payload/ghost state.
  window.addEventListener('dragend', () => {
    binDragActive = false;
    pendingDrag = null;
    removeDragCard();
    hideDropProxy();
    hideSelBox();
    for (const k of pendingBinRender) renderBin(k);
    pendingBinRender.clear();
  });

  api.onExportProgress((p) => {
    if (p.stage === 'progress' && typeof p.ratio === 'number') setProgress(p.ratio);
    if (p.message) setStatus(p.message);
    if (p.stage === 'done') setProgress(1);
  });
}

function hideDropMarker() { $('#drop-marker').classList.add('hidden'); }

init();