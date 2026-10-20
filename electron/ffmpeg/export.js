const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { keyframes, isKeyframe } = require('./probe');
const TimelineOps = require('../../renderer/timeline-ops');

const LOUD = 'I=-14:TP=-1.5:LRA=11';

// Linear multiplier for a gain in decibels (volume filter takes a multiplier).
const linGain = (db) => Math.pow(10, db / 20);
const toDb = (lin) => 20 * Math.log10(Math.max(lin, 1e-6));

const srcStartOf = (c) => (c.srcStart != null ? c.srcStart : (c.inPoint != null ? c.inPoint : 0));
const srcEndOf = (c) => (c.srcEnd != null ? c.srcEnd : (c.outPoint != null ? c.outPoint : c.duration));
const speedOf = (c) => c.speed || 1;

const sndStartOf = (x) => x.startTime || 0;
const sndLenOf = (x) => (x.srcEnd != null ? Math.max(0, x.srcEnd - (x.srcStart || 0))
  : (x.endTime != null ? x.endTime : (x.duration || 0)));

// Editor timeline length: the max end over every clip/sound. Used so the output
// preserves gaps (as black+silence padding) and sound positions line up 1:1 with
// the timeline instead of sliding when video gaps collapse.
function editorTotal(project) {
  let m = 0;
  for (const c of (project.timeline || project.clips || [])) {
    if (!c || !c.path) continue;
    m = Math.max(m, (c.start || 0) + (srcEndOf(c) - srcStartOf(c)) / speedOf(c));
  }
  for (const h of (project.hybrid || [])) {
    if (!h || !h.path) continue;
    if (h.kind === 'sound') m = Math.max(m, sndStartOf(h) + sndLenOf(h));
    else m = Math.max(m, (h.start || 0) + (srcEndOf(h) - srcStartOf(h)) / speedOf(h));
  }
  for (const x of (project.soundboard || [])) {
    if (!x || !x.path) continue;
    m = Math.max(m, sndStartOf(x) + sndLenOf(x));
  }
  return m;
}

function mergeClipsByPriority(mainSeq, hybSeq) {
  const allClips = [...mainSeq, ...hybSeq].sort((a, b) => a._priority - b._priority || (a.start || 0) - (b.start || 0));
  const segments = [];
  const covered = [];

  for (const clip of allClips) {
    const cs = clip.start || 0;
    const ce = cs + (srcEndOf(clip) - srcStartOf(clip)) / speedOf(clip);
    let visibleStart = cs;

    const overlaps = covered
      .filter(([s, e]) => s < ce && e > cs)
      .sort((a, b) => a[0] - b[0]);

    for (const [s, e] of overlaps) {
      if (s > visibleStart + 1e-6) {
        segments.push({ ...clip, start: visibleStart, _srcOffset: (visibleStart - cs) * speedOf(clip) });
      }
      visibleStart = Math.max(visibleStart, e);
    }

    if (visibleStart < ce - 1e-6) {
      segments.push({ ...clip, start: visibleStart, _srcOffset: (visibleStart - cs) * speedOf(clip) });
    }

    covered.push([cs, ce]);
  }

  return segments
    .filter((s) => s._srcOffset < (srcEndOf(s) - srcStartOf(s)) - 1e-6)
    .sort((a, b) => a.start - b.start);
}

// Choose how a source segment is written. Lossless requires a stream-copyable
// source: H.264, exactly matching target dims/FPS, and keyframe-aligned edges.
// `fit:'blur'` is the editor's default framing, but when the source already
// fills the output frame the blurred background is covered and invisible — so
// it must not force a needless re-encode (the exact-dims check already covers
// the case where the frame would actually need scaling).
function chooseMode({ vOk, aOk, inKf, outKf, normalize, speed = 1, volDb = 0, zoom = null, camera = null }) {
  let mode = 'reencode';
  if (vOk && inKf && outKf) mode = normalize ? 'vlossless' : 'lossless';
  else if (vOk) mode = 'reencode';
  // lossless audio also needs matching audio params
  if (mode === 'lossless' && !aOk) mode = 'vlossless';
  // slow motion needs filters, which can't be stream-copied
  if (speed !== 1) mode = 'reencode';
  // a per-clip zoom animates scale/crop — must be re-encoded
  if (zoom) mode = 'reencode';
  // camera effects (adjustment layers) animate scale/pan over this segment
  if (camera) mode = 'reencode';
  // a non-zero volume re-encodes audio — lossless stream-copy can't carry gain
  if (mode === 'lossless' && Math.abs(volDb) > 1e-3) mode = 'vlossless';
  return mode;
}

// Clips can be parked in the 20s editing-only pre-roll (negative start). Export
// time begins at 0:00, so trim a negative start to the boundary and skip the
// corresponding source seconds instead of shifting the whole edit later.
function clampClipStart(start, outDur, speed) {
  if (start >= 0) return { start, outDur, srcTrim: 0, skip: outDur <= 1e-6 };
  const trim = Math.min(-start, outDur);
  const visible = Math.max(0, outDur - trim);
  return { start: 0, outDur: visible, srcTrim: trim * speed, skip: visible <= 1e-6 };
}

// Build the ordered render plan (clips + black padding for gaps) with any
// negative timeline starts clamped to 0:00.
function buildRenderPlan(clips, outDurs) {
  const visSpans = clips.map((c, i) => clampClipStart(c.start || 0, outDurs[i], speedOf(c)));
  const plan = [];
  let cursor = 0;
  for (let i = 0; i < clips.length; i++) {
    const vis = visSpans[i];
    if (vis.skip) continue;
    if (vis.start > cursor + 1e-6) plan.push({ black: vis.start - cursor });
    plan.push({ clip: i });
    cursor = vis.start + vis.outDur;
  }
  return { plan, visSpans, cursor };
}

// Live ffmpeg processes, so a running export can be aborted from the UI.
const liveChildren = new Set();
let cancelRequested = false;

function killChild(child) {
  try {
    if (process.platform === 'win32') {
      // ffmpeg ignores SIGTERM on Windows; kill the whole tree with taskkill.
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGKILL');
    }
  } catch (_) { /* already gone */ }
}

// Abort the current export: flag it and terminate every ffmpeg child in flight.
function cancelExport() {
  cancelRequested = true;
  for (const child of liveChildren) killChild(child);
  liveChildren.clear();
}

function spawnFfmpeg(ffmpegPath, args, onProgress, total, span) {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    liveChildren.add(child);
    let err = '';
    const re = /time=(\d+):(\d+):(\d+\.?\d*)/;
    child.stderr.on('data', (d) => {
      const s = d.toString();
      err += s;
      if (onProgress && total > 0) {
        const m = s.match(re);
        if (m) {
          const t = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
          onProgress(Math.max(0, Math.min(1, t / total)), span);
        }
      }
    });
    child.on('error', (e) => { liveChildren.delete(child); resolve({ code: -1, err: err + String(e) }); });
    child.on('close', (code) => { liveChildren.delete(child); resolve({ code, err }); });
  });
}

// atempo only accepts 0.5–2.0 per instance, so chain for very slow speeds.
function atempoChain(speed) {
  const parts = [];
  let s = speed;
  while (s < 0.5) { parts.push('atempo=0.5'); s /= 0.5; }
  while (s > 2.0) { parts.push('atempo=2.0'); s /= 2.0; }
  parts.push(`atempo=${s.toFixed(4)}`);
  return parts.join(',');
}

// ffmpeg expression for the zoom scale factor over output time `t`, matching
// renderer/TimelineOps.zoomFactor. a,b are clip-local output seconds; level is
// the peak factor; dir 'in' -> 1..level, 'out' -> level..1; ease 'smooth' uses
// the smoothstep p*p*(3-2p). The factor holds outside [a,b]. Verified against
// ffmpeg 8.1.1 (single quotes protect the commas inside clip(...)).
function zoomScaleExpr(zoom) {
  const level = zoom.level != null ? zoom.level : 1;
  const from = zoom.dir === 'out' ? level : 1;
  const to = zoom.dir === 'out' ? 1 : level;
  const a = Number(zoom.a) || 0;
  const b = zoom.b != null ? Number(zoom.b) : a;
  const span = Math.max(1e-6, b - a);
  const p = `clip((t-${a.toFixed(4)})/${span.toFixed(4)},0,1)`;
  const e = zoom.ease === 'linear' ? p : `(${p}*${p}*(3-2*${p}))`;
  return `(${from.toFixed(4)}+(${to.toFixed(4)}-${from.toFixed(4)})*${e})`;
}

// ---- Camera effects -> ffmpeg expressions ---------------------------------
const IDP = { z: 1, cx: 0.5, cy: 0.5 };
const num4 = (x) => (Number(x) || 0).toFixed(4);
function peExpr(e, T) {
  const a = e.start || 0;
  const b = a + Math.max(1e-6, e.dur || 0);
  const p = `clip((${T}-${num4(a)})/${num4(b - a)},0,1)`;
  return e.ease === 'linear' ? p : `(${p}*${p}*(3-2*${p}))`;
}
const lerpExpr = (f, t, pe) => `(${num4(f)}+(${num4(t)}-${num4(f)})*${pe})`;

// Deterministic shake offset expressions (matches TimelineOps.shakeOffset).
function shakeExpr(e, T) {
  const a = e.start || 0;
  const dur = Math.max(1e-6, e.dur || 0);
  const amp = e.amp != null ? e.amp : 0.02;
  const f = e.freq != null ? e.freq : 16;
  const seed = e.seed != null ? e.seed : 1;
  const TAU2 = Math.PI * 2;
  const ph = ((seed * 0.6180339887) % 1) * TAU2;
  const tau = `(${T}-${num4(a)})`;
  const nx = `((sin(${num4(TAU2 * f)}*${tau}+${num4(ph)})+0.5*sin(${num4(TAU2 * f * 1.7)}*${tau}+${num4(ph * 2 + 1.3)}))/1.5)`;
  const ny = `((cos(${num4(TAU2 * f * 1.13)}*${tau}+${num4(ph * 3 + 0.7)})+0.5*cos(${num4(TAU2 * f * 0.83)}*${tau}+${num4(ph * 5)}))/1.5)`;
  const decay = e.decay === false ? '1' : `max(0,1-${tau}/${num4(dur)})`;
  const ax = e.axes === 'v' ? 0 : 1;
  const ay = e.axes === 'h' ? 0 : 1;
  return {
    dx: ax ? `(${num4(amp)}*${decay}*${nx})` : '0',
    dy: ay ? `(${num4(amp)}*${decay}*${ny})` : '0',
  };
}

// Pose over an interval with no effect boundary, as expressions in local time t.
function posePiece(effects, lo, hi, T) {
  const EPS = 1e-6;
  const active = effects.filter((e) => {
    const a = e.start || 0, b = a + Math.max(0, e.dur || 0);
    return a <= lo + EPS && b >= hi - EPS;
  });
  if (!active.length) return { z: '1', cx: '0.5', cy: '0.5' };
  const zooms = active.filter((e) => e.type !== 'shake').sort((a, b) => (a.start || 0) - (b.start || 0));
  let z = '1', ux = '0.5', uy = '0.5';
  for (const e of zooms) {
    const f = e.from || IDP, to = e.to || IDP;
    const pe = peExpr(e, T);
    const zc = lerpExpr(f.z, to.z, pe);
    const cxc = lerpExpr(f.cx, to.cx, pe);
    const cyc = lerpExpr(f.cy, to.cy, pe);
    z = `(${z}*${zc})`;
    ux = `(${cxc}+(${ux}-0.5)/${zc})`;
    uy = `(${cyc}+(${uy}-0.5)/${zc})`;
  }
  let dx = '0', dy = '0';
  let maxAmp = 0;
  for (const e of active) {
    if (e.type !== 'shake') continue;
    maxAmp = Math.max(maxAmp, e.amp != null ? e.amp : 0.02);
    const o = shakeExpr(e, T);
    dx = `(${dx}+${o.dx})`;
    dy = `(${dy}+${o.dy})`;
  }
  if (maxAmp > 0) z = `max(${z},${num4(1 / (1 - Math.min(0.45, 2 * maxAmp)))})`;
  return { z, cx: `(${ux}+${dx})`, cy: `(${uy}+${dy})` };
}

// { z, cx, cy } expressions (in local `t`) for segment [segStart,segEnd), or null.
function buildCameraExprs(effects, segStart, segEnd, bg) {
  const T = `(t+${num4(segStart)})`;
  const EPS = 1e-6;
  const bps = new Set();
  for (const e of effects) {
    const a = e.start || 0, b = a + Math.max(0, e.dur || 0);
    if (a > segStart + EPS && a < segEnd - EPS) bps.add(a);
    if (b > segStart + EPS && b < segEnd - EPS) bps.add(b);
  }
  const cuts = [segStart, ...[...bps].sort((x, y) => x - y), segEnd];
  const pieces = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    if (cuts[i + 1] - cuts[i] < EPS) continue;
    pieces.push({ hi: cuts[i + 1], ...posePiece(effects, cuts[i], cuts[i + 1], T) });
  }
  if (!pieces.length) return null;
  let z = pieces[pieces.length - 1].z, cx = pieces[pieces.length - 1].cx, cy = pieces[pieces.length - 1].cy;
  for (let i = pieces.length - 2; i >= 0; i--) {
    const cond = `lt(t,${num4(pieces[i].hi - segStart)})`;
    z = `if(${cond},${pieces[i].z},${z})`;
    cx = `if(${cond},${pieces[i].cx},${cx})`;
    cy = `if(${cond},${pieces[i].cy},${cy})`;
  }
  return { z, cx, cy, bg };
}

// True when any effect band intersects [segStart,segEnd) (bounded effects: no
// influence outside their band).
function cameraActive(effects, segStart, segEnd) {
  const EPS = 1e-6;
  return effects.some((e) => {
    const a = e.start || 0, b = a + Math.max(0, e.dur || 0);
    return a < segEnd - EPS && b > segStart + EPS;
  });
}

// The effect governing the pose at t (active bands only) — for background choice.
function governingEffectAt(effects, t) {
  const act = effects.filter((e) => t >= (e.start || 0) && t < (e.start || 0) + Math.max(0, e.dur || 0));
  if (!act.length) return null;
  return act.reduce((a, b) => ((a.start || 0) > (b.start || 0) ? a : b));
}

function cutArgs(src, inPoint, outPoint, cfg) {
  const { mode, encoder, encoderOpts, W, H, FPS, normalize, mute, speed = 1, fit = 'blur', volumeDb = 0, zoom = null, camera = null, still = false } = cfg;
  const dur = Math.max(0.001, outPoint - inPoint);
  const slow = Math.abs(speed - 1) > 1e-6;
  const outDur = dur / speed; // duration after the speed change
  const blur = fit === 'blur';
  let vmap = '0:v:0';
  const a = ['-hide_banner', '-loglevel', 'error', '-nostats', '-y'];
  if (still) {
    // One still image held for the segment's duration. No seek is possible (or
    // wanted); the audio track is always the silent one below.
    a.push('-loop', '1', '-framerate', String(FPS), '-t', outDur.toFixed(3), '-i', src);
  } else {
    a.push('-ss', inPoint.toFixed(3), '-t', dur.toFixed(3), '-i', src);
  }
  if (mute) {
    a.push('-f', 'lavfi', '-t', outDur.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo');
  }

  if (mode === 'reencode') {
    if (camera) {
      // Animated camera (zoom + pan) driven by effect-layer expressions in `t`.
      // The base picture follows the clip's framing — `blur` fits the whole
      // picture with a blurred cover behind it, anything else fills & crops —
      // so at z=1 the frame is exactly the no-effect frame and the zoom only
      // magnifies it. `camera.bg` picks the backdrop revealed when the picture
      // is smaller than the frame.
      const pre = slow ? `setpts=PTS/${speed},` : '';
      const zE = camera.z, cxE = camera.cx, cyE = camera.cy;
      // The 2px floor keeps a hand-edited tiny z from rounding the frame to 0.
      const sc = `scale=w='trunc(max(2,iw*(${zE}))/2)*2':h='trunc(max(2,ih*(${zE}))/2)*2':eval=frame`;
      const ov = `overlay=x='W/2-(${cxE})*w':y='H/2-(${cyE})*h'`;
      const fgBase = blur
        ? `scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1`
        : `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`;
      if (blur || camera.bg === 'blur') {
        // Blurred cover of the source stays put behind the scaled picture.
        a.push('-filter_complex',
          `[0:v]${pre}fps=${FPS},split=2[fg0][bg0];` +
          `[bg0]scale=${W}:${H}:force_original_aspect_ratio=increase:force_divisible_by=2,crop=${W}:${H},boxblur=20:5[bg];` +
          `[fg0]${fgBase},${sc}[fg];` +
          `[bg][fg]${ov},setsar=1[v]`);
      } else {
        a.push('-filter_complex',
          `color=black:s=${W}x${H}:r=${FPS}[bg];` +
          `[0:v]${pre}fps=${FPS},${fgBase},${sc}[fg];` +
          `[bg][fg]${ov}:shortest=1,setsar=1[v]`);
      }
      vmap = '[v]';
      a.push('-map', '[v]');
      if (!mute) a.push('-map', '0:a?');
    } else if (zoom) {
      // Animated zoom/pan over output time. Normalize to W:H first, then scale
      // by the time-varying factor and composite over the chosen background
      // (only visible when zoomed below 100%). Verified against ffmpeg 8.1.
      const pre = slow ? `setpts=PTS/${speed},` : '';
      const base = `${pre}fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`;
      const Z = zoomScaleExpr(zoom);
      const sc = `scale=w='trunc(iw*${Z}/2)*2':h='trunc(ih*${Z}/2)*2':eval=frame`;
      const cx = (zoom.cx != null ? zoom.cx : 0.5).toFixed(4);
      const cy = (zoom.cy != null ? zoom.cy : 0.5).toFixed(4);
      // Centre-point model: the source point (cx,cy) lands at the output centre.
      // x = W/2 - cx*overlayW -> matches the renderer's translate/scale preview.
      const ov = `overlay=x='W/2-${cx}*w':y='H/2-${cy}*h'`;
      if (zoom.bg === 'blur') {
        a.push('-filter_complex',
          `[0:v]${base},split=2[bb][f];` +
          `[bb]boxblur=20:5[bg];` +
          `[f]${sc}[fg];` +
          `[bg][fg]${ov},setsar=1[v]`);
      } else {
        a.push('-filter_complex',
          `color=black:s=${W}x${H}:r=${FPS}[bg];` +
          `[0:v]${base},${sc}[fg];` +
          `[bg][fg]${ov}:shortest=1,setsar=1[v]`);
      }
      vmap = '[v]';
      a.push('-map', '[v]');
      if (!mute) a.push('-map', '0:a?');
    } else if (blur) {
      // [bg] = blurred cover of the whole frame; [fg] = whole source letterboxed.
      // -filter_complex requires explicit -map; keep audio with the optional marker.
      const pre = slow ? `setpts=PTS/${speed},` : '';
      a.push('-filter_complex',
        `[0:v]${pre}fps=${FPS},split=2[fg][bg];` +
        `[bg]scale=${W}:${H}:force_original_aspect_ratio=increase:force_divisible_by=2,crop=${W}:${H},boxblur=20:5[bg2];` +
        `[fg]scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2[fg2];` +
        `[bg2][fg2]overlay=(W-w)/2:(H-h)/2,setsar=1[v]`);
      vmap = '[v]';
      a.push('-map', '[v]');
      if (!mute) a.push('-map', '0:a?');
    } else {
      const vf = [
        ...(slow ? [`setpts=PTS/${speed}`] : []),
        `fps=${FPS}`, `scale=${W}:${H}:force_original_aspect_ratio=increase`, `crop=${W}:${H}`, 'setsar=1',
      ].join(',');
      a.push('-vf', vf);
    }
    a.push('-c:v', encoder, ...encoderOpts, '-profile:v', 'high', '-pix_fmt', 'yuv420p',
      '-g', '120', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709');
  } else {
    a.push('-c:v', 'copy');
  }

  if (mute) {
    if (vmap === '[v]') a.push('-map', '1:a:0');
    else a.push('-map', vmap, '-map', '1:a:0');
    a.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
  } else if (mode === 'lossless') {
    a.push('-c:a', 'copy');
  } else {
    const af = [];
    if (Math.abs(volumeDb) > 1e-3) af.push(`volume=${linGain(volumeDb).toFixed(4)}`);
    if (normalize) af.push(`loudnorm=${LOUD}`);
    if (slow) af.push(atempoChain(speed));
    af.push('aresample=48000');
    a.push('-af', af.join(','), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
  }
  a.push('-avoid_negative_ts', 'make_zero', '-movflags', '+faststart');
  return a;
}

function assertNotCancelled() {
  if (cancelRequested) throw new Error('Export cancelled');
}

// Move `from` onto the final output path. The concat stage already completed
// when this runs, so a plain rename usually works; fall back to copy+unlink
// when the two live on different volumes.
function finalizeFile(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (_) {
    fs.copyFileSync(from, to);
    try { fs.unlinkSync(from); } catch (_) {}
  }
  return to;
}

// Map a sound's visual start time onto the collapsed (concatenated) output
// timeline: gaps are closed on export and each clip contributes its OUTPUT
// span, i.e. source seconds divided by playback speed (a slowed clip occupies
// more of the visual timeline -> more of the output too).
function visualToOutput(t, clips, srcStartOfFn, srcEndOfFn, speedFn) {
  const s0 = srcStartOfFn || srcStartOf;
  const e0 = srcEndOfFn || srcEndOf;
  const sp = speedFn || speedOf;
  let out = 0;
  for (const c of clips) {
    const s = c.start || 0;
    const d = Math.max(0, e0(c) - s0(c)) / sp(c);
    if (t < s) return out;
    if (t < s + d) return out + (t - s);
    out += d;
  }
  return out;
}

// Freeze frames are generated on export only: read one frame from the source
// video at the freeze timestamp and feed it to the still path. Nothing is cached
// to disk alongside the media.
async function extractStillFrame(ffmpegPath, src, at, out) {
  const r = await spawnFfmpeg(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-nostats', '-y',
    '-ss', Math.max(0, Number(at) || 0).toFixed(3),
    '-i', src, '-frames:v', '1', '-update', '1', '-q:v', '2', out,
  ], null, 0, 0);
  assertNotCancelled();
  if (r.code !== 0 || !fs.existsSync(out)) {
    throw new Error('Failed freezing frame:\n' + r.err.slice(-800));
  }
  return out;
}

async function exportProject(opts) {
  const {
    ffmpegPath, ffprobePath, project, outputFile, workDir, onEvent = () => {},
  } = opts;

  cancelRequested = false;

  // Never let a render target be one of the files feeding the render. The save
  // dialog can otherwise overwrite irreplaceable source media via finalizeFile.
  const conflict = TimelineOps.sourceConflict(outputFile, project);
  if (conflict) throw new Error('Refusing to overwrite source media: ' + conflict);

  // Clips: merge MAIN + ALT by time with MAIN priority.
  // At any moment, the visible clip is the highest-priority one (MAIN > ALT).
  // Lower-priority clips are trimmed where a higher-priority clip covers them.
  const mainSeq = (project.timeline || project.clips || [])
    .filter((c) => c && c.path)
    .map((c) => ({ ...c, _priority: 0 }));
  const hybSeq = (project.hybrid || [])
    .filter((h) => h && h.path && h.kind !== 'sound')
    .map((h) => ({ ...h, _priority: 1 }));

  const clips = mergeClipsByPriority(mainSeq, hybSeq);
  const effects = (project.effects || []).filter((e) => e && (e.type === 'shake' || (e.from && e.to)));
  if (!clips.length) throw new Error('No clips to export.');

  const s = project.settings || {};
  const W = s.width || 1080;
  const H = s.height || 1920;
  const FPS = s.fps || 60;
  const encoder = s.encoder || 'libx264';
  const ENC_OPTS = {
    h264_amf: ['-quality', 'balanced', '-rc', 'cqp', '-qp_i', '20', '-qp_p', '22'],
    h264_nvenc: ['-preset', 'p5', '-rc', 'constqp', '-qp', '21'],
    libx264: ['-preset', 'medium', '-crf', '20'],
  };
  const HW_ENCODERS = new Set(['h264_nvenc', 'h264_amf']);
  const normalize = !!(s.normalizeAudio);

  fs.mkdirSync(workDir, { recursive: true });

  const srcDurs = clips.map((c) => {
    const srcOffset = c._srcOffset || 0;
    return Math.max(0, srcEndOf(c) - (srcStartOf(c) + srcOffset));
  });
  const outDurs = srcDurs.map((d, i) => d / speedOf(clips[i]));

  // Render plan: the visible clip segments PLUS black+silent padding for every
  // gap on the editor timeline (leading, between clips, trailing). Padding keeps
  // output time equal to timeline time, so sounds land where the editor shows
  // them instead of sliding earlier when video gaps collapse.
  const editorEnd = editorTotal(project);
  const { plan, visSpans, cursor } = buildRenderPlan(clips, outDurs);
  if (editorEnd > cursor + 1e-6) plan.push({ black: editorEnd - cursor });
  if (!plan.some((step) => step.clip != null)) throw new Error('No clips overlap the exported timeline.');
  const totalDur = Math.max(editorEnd, cursor) || 1;

  const segFiles = [];
  let elapsed = 0;
  let segNo = 0;

  for (const step of plan) {
    assertNotCancelled();
    segNo++;
    if (step.black != null) {
      const d = step.black;
      const seg = path.join(workDir, `seg_${String(segNo).padStart(3, '0')}.mp4`);
      const base = elapsed / totalDur;
      const span = d / totalDur;
      const rr = await spawnFfmpeg(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-nostats', '-y',
        '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${FPS}`,
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
        '-t', d.toFixed(3),
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
        '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-g', '120',
        '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
        '-movflags', '+faststart', seg,
      ], (p, sp) => {
        onEvent({ stage: 'progress', ratio: base + p * sp, message: 'Padding gaps...' });
      }, d, span);
      assertNotCancelled();
      if (rr.code !== 0) throw new Error('Failed building gap padding:\n' + rr.err.slice(-800));
      segFiles.push(seg);
      elapsed += d;
      continue;
    }
    const i = step.clip;
    const c = clips[i];
    const vis = visSpans[i];
    const srcOffset = (c._srcOffset || 0) + vis.srcTrim;
    const inPoint = Math.max(0, srcStartOf(c) + srcOffset);
    const outPoint = srcEndOf(c) != null ? srcEndOf(c) : c.duration;
    const speed = c.speed || 1;
    const dur = srcDurs[i] - vis.srcTrim;
    const outDur = vis.outDur;
    const seg = path.join(workDir, `seg_${String(segNo).padStart(3, '0')}.mp4`);

    // Camera effects (adjustment layers) animating scale/pan over this segment.
    let camera = null;
    if (effects.length) {
      const segStart = vis.start;
      const segEnd = segStart + outDur;
      if (cameraActive(effects, segStart, segEnd)) {
        const bgEff = governingEffectAt(effects, (segStart + segEnd) / 2);
        camera = buildCameraExprs(effects, segStart, segEnd, bgEff && bgEff.bg === 'blur' ? 'blur' : 'black');
      }
    }

    const still = TimelineOps.isStill(c);
    const stillKind = c.kind === 'freeze' || c.stillKind === 'freeze';
    let stillSrc = c.path;
    let mode;
    const volDb = c.volume || 0;
    if (still) {
      // Stills are always re-encoded: a single frame held for the segment, with a
      // silent AAC track so the concat segments keep matching streams.
      if (stillKind) {
        stillSrc = path.join(workDir, `still_${String(segNo).padStart(3, '0')}.png`);
        await extractStillFrame(ffmpegPath, c.path, c.freezeAt || 0, stillSrc);
      }
      mode = 'reencode';
    } else {
      const kfs = await keyframes(ffprobePath, c.path).catch(() => []);
      const dimsOk = c.width === W && c.height === H && Math.abs((c.fps || 0) - FPS) < 0.05;
      const vOk = c.vcodec === 'h264' && dimsOk;
      const aOk = c.hasAudio && c.acodec === 'aac'
        && c.audioSampleRate === 48000 && c.audioChannels === 2;
      const inKf = isKeyframe(inPoint, kfs, 0.05);
      const outKf = isKeyframe(outPoint, kfs, 0.05) || Math.abs(outPoint - c.duration) < 0.05;
      mode = chooseMode({
        vOk, aOk, inKf, outKf, normalize, speed, volDb: c.volume || 0, zoom: c.zoom || null, camera,
      });
    }

    onEvent({
      stage: 'cut', index: i, count: clips.length, mode,
      message: `Clip ${i + 1}/${clips.length}: ${mode === 'lossless' ? 'lossless copy' : mode === 'vlossless' ? 'video copy + audio re-encode' : 're-encode'}${speed !== 1 ? ` (${speed}× slow)` : ''}${mode === 'reencode' && c.fit === 'blur' ? ' (blur bg)' : ''}${Math.abs(volDb) > 1e-3 ? ` (${volDb > 0 ? '+' : ''}${volDb} dB)` : ''}`,
    });

    const buildArgs = (enc, encOpts) => cutArgs(still ? stillSrc : c.path, still ? 0 : inPoint, still ? dur : outPoint, {
      mode, encoder: enc, encoderOpts: encOpts, W, H, FPS, normalize,
      mute: still ? true : !!c.mute,
      speed: still ? 1 : speed, fit: c.fit || 'blur', volumeDb: volDb,
      zoom: still ? null : (c.zoom || null), camera, still,
    }).concat([seg]);
    const runSeg = async (enc, encOpts) => {
      const args = buildArgs(enc, encOpts);
      const base = elapsed / totalDur;
      const span = outDur / totalDur;
      const rr = await spawnFfmpeg(ffmpegPath, args, (p, sp) => {
        onEvent({ stage: 'progress', ratio: base + p * sp, message: 'Encoding clips...' });
      }, outDur, span);
      assertNotCancelled();
      return { rr, args };
    };

    const encOpts = ENC_OPTS[encoder] || ENC_OPTS.libx264;
    let { rr, args } = await runSeg(encoder, encOpts);
    // Hardware encoders (NVENC/AMF) can fail to open for a segment — driver/API
    // version, dll missing, odd dims... Retry just that segment on CPU so an
    // export never hard-fails on the hardware path.
    if (rr.code !== 0 && HW_ENCODERS.has(encoder)) {
      onEvent({ stage: 'cut', message: `Clip ${i + 1}/${clips.length}: ${encoder} failed — retrying with CPU (libx264)…` });
      const fb = await runSeg('libx264', ENC_OPTS.libx264);
      rr = fb.rr;
      args = fb.args;
    }
    if (rr.code !== 0) {
      throw new Error(`Failed cutting clip ${i + 1}:\n${rr.err.slice(-800)}\n[ffmpeg] ffmpeg ${args.join(' ')}`);
    }

    segFiles.push(seg);
    elapsed += outDur;
  }

  // ---- concat ----
  assertNotCancelled();
  const listFile = path.join(workDir, 'list.txt');
  fs.writeFileSync(listFile,
    segFiles.map((f) => `file '${path.basename(f)}'`).join('\n') + '\n');

  const baseFile = path.join(workDir, 'base.mp4');
  onEvent({ stage: 'concat', ratio: 0.85, message: 'Merging clips...' });
  const concatCopy = await spawnFfmpeg(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-nostats', '-y',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c', 'copy', '-movflags', '+faststart', baseFile,
  ], null, 0, 0);
  assertNotCancelled();

  let merged = baseFile;
  if (concatCopy.code !== 0) {
    onEvent({ stage: 'concat', ratio: 0.85, message: 'Re-muxing merge (fallback)...' });
    const r = await spawnFfmpeg(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-nostats', '-y',
      '-f', 'concat', '-safe', '0', '-i', listFile,
      '-vf', `fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`,
      ...(normalize ? ['-af', `loudnorm=${LOUD},aresample=48000`] : ['-af', 'aresample=48000']),
      // The remux fallback always re-encodes on CPU — a hardware encoder that broke
    // the copy-concat may be equally broken here.
    '-c:v', 'libx264', ...ENC_OPTS.libx264, '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-g', '120',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart', baseFile,
    ], null, 0, 0);
    assertNotCancelled();
    if (r.code !== 0) throw new Error('Merge failed:\n' + r.err.slice(-800));
  }

  // ---- soundboard overlay ----
  assertNotCancelled();
  const sb = (project.soundboard || []).filter((x) => x && x.path)
    .concat((project.hybrid || []).filter((h) => h && h.path && h.kind === 'sound'));
  if (sb.length) {
    onEvent({ stage: 'soundboard', ratio: 0.92, message: 'Mixing soundboard...' });
    const inputs = ['-i', merged];
    for (const item of sb) {
      const ss = item.srcStart || 0;
      const se = item.srcEnd != null ? item.srcEnd
        : (item.endTime != null ? item.endTime : (item.duration || 1e9));
      const d = Math.max(0.05, se - (item.srcStart || 0));
      if (ss > 0.001) inputs.push('-ss', ss.toFixed(3));
      inputs.push('-t', d.toFixed(3), '-i', item.path);
    }

    const parts = [];
    const labels = [];
    sb.forEach((item, idx) => {
      const outStart = item.startTime || 0; // output time == timeline time (gaps padded)
      const delay = Math.max(0, Math.round(outStart * 1000));
      // Volume is stored in dB; legacy projects used a linear `gain`.
      const gainDb = item.volume != null ? item.volume : (item.gain != null ? toDb(item.gain) : 0);
      const lbl = `sb${idx}`;
      parts.push(
        `[${idx + 1}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,` +
        `volume=${linGain(gainDb).toFixed(4)},adelay=${delay}|${delay}[${lbl}]`);
      labels.push(`[${lbl}]`);
    });
    const mixInputs = ['[0:a]', ...labels].join('');
    parts.push(`${mixInputs}amix=inputs=${sb.length + 1}:normalize=0:dropout_transition=0[aout]`);

    const args = [
      '-hide_banner', '-loglevel', 'error', '-nostats', '-y',
      ...inputs,
      '-filter_complex', parts.join(';'),
      '-map', '0:v:0', '-map', '[aout]',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart', outputFile,
    ];
    const r = await spawnFfmpeg(ffmpegPath, args, (p) => {
      onEvent({ stage: 'progress', ratio: 0.92 + p * 0.08, message: 'Mixing soundboard...' });
    }, totalDur, 0.08);
    assertNotCancelled();
    if (r.code !== 0) throw new Error('Soundboard mix failed:\n' + r.err.slice(-800));
  } else {
    assertNotCancelled();
    finalizeFile(baseFile, outputFile);
  }

  onEvent({ stage: 'done', ratio: 1, message: 'Done' });
  return outputFile;
}

module.exports = { exportProject, cancelExport, visualToOutput, cutArgs, srcStartOf, srcEndOf, speedOf, mergeClipsByPriority, editorTotal, chooseMode, buildRenderPlan, zoomScaleExpr, buildCameraExprs, cameraActive, governingEffectAt, shakeExpr };
