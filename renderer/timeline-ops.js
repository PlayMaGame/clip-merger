/* Pure timeline math for ripple-insert. No DOM, so it can be unit-tested by
   node. Exposed as window.TimelineOps (browser) and module.exports (node).

   Scope decides which lanes a ripple touches:
     'main'  -> MAIN (Clips) lane            (state.timeline)
     'alt'   -> ALT (CLIPS2) lane            (state.hybrid)
     'sound' -> SOUND lane                   (state.soundboard)
     'all'   -> MAIN + ALT + SOUND + markers (used when inserting on MAIN) */
(function (root) {
  'use strict';

  const EPS = 1e-6;

  const speedOf = (it) => it.speed || 1;
  const durOf = (it) => (it.srcEnd - it.srcStart) / speedOf(it);
  const sndDur = (s) => {
    if (s.srcEnd != null) return Math.max(0, s.srcEnd - (s.srcStart || 0));
    return s.endTime != null ? s.endTime : (s.duration || 0);
  };
  const hybStartOf = (h) => (h.kind === 'sound' ? (h.startTime || 0) : (h.start || 0));
  const hybDurOf = (h) => (h.kind === 'sound' ? sndDur(h) : durOf(h));
  const setHybStart = (h, t) => { if (h.kind === 'sound') h.startTime = t; else h.start = t; };

  // Normalize a filesystem path for comparison: slash direction and case do not
  // matter on the Windows targets this app supports. Return the original source
  // path when `outputPath` would land on one, so callers can name it in an error.
  const normPath = (p) => String(p || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  function sourceConflict(outputPath, project) {
    const out = normPath(outputPath);
    if (!out) return null;
    const lists = [
      project && project.timeline,
      project && project.clips, // legacy project format
      project && project.hybrid,
      project && project.soundboard,
    ];
    for (const list of lists) {
      for (const item of list || []) {
        if (item && item.path && normPath(item.path) === out) return item.path;
      }
    }
    return null;
  }

  function lanesFor(scope) {
    switch (scope) {
      case 'main': return { timeline: true, hybrid: false, soundboard: false, markers: false };
      case 'alt': return { timeline: false, hybrid: true, soundboard: false, markers: false };
      case 'sound': return { timeline: false, hybrid: false, soundboard: true, markers: false };
      case 'all':
      default: return { timeline: true, hybrid: true, soundboard: true, markers: true };
    }
  }

  function shiftList(arr, get, set, t, L) {
    for (const it of arr) {
      const s = get(it);
      if (s >= t - EPS) set(it, s + L);
    }
  }

  // Push everything at/after t on the scoped lanes right by L. Returns nothing.
  function rippleOpen(state, t, L, scope) {
    if (!(L > 0)) return;
    const lanes = lanesFor(scope);
    if (lanes.timeline) shiftList(state.timeline, (it) => it.start || 0, (it, v) => { it.start = v; }, t, L);
    if (lanes.hybrid) shiftList(state.hybrid, hybStartOf, setHybStart, t, L);
    if (lanes.soundboard) shiftList(state.soundboard, (s) => s.startTime || 0, (s, v) => { s.startTime = v; }, t, L);
    if (lanes.markers) shiftList(state.markers, (m) => m.time || 0, (m, v) => { m.time = v; }, t, L);
  }

  // [start,end) spans on a scope's lane, used to resolve an ambiguous drop point.
  function laneItems(state, scope) {
    switch (scope) {
      case 'alt':
        return state.hybrid.map((h) => [hybStartOf(h), hybStartOf(h) + hybDurOf(h)]);
      case 'sound':
        return state.soundboard.map((s) => [s.startTime || 0, (s.startTime || 0) + sndDur(s)]);
      case 'main':
      case 'all':
      default:
        return state.timeline.map((it) => [it.start || 0, (it.start || 0) + durOf(it)]);
    }
  }

  // If t lands strictly inside a span on the lane, snap to the nearer edge so
  // the insert sits cleanly before/after it instead of overlapping; else t.
  function resolveInsertTime(state, t, scope) {
    for (const [s, e] of laneItems(state, scope)) {
      if (t > s + EPS && t < e - EPS) return (t - s <= e - t) ? s : e;
    }
    return t;
  }

  // Which lanes an item of a given kind may live in. ALT (hybrid) holds both.
  function laneAccepts(lane, kind) {
    if (lane === 'hybrid') return kind === 'clip' || kind === 'sound' || kind === 'image' || kind === 'freeze' || kind === 'video';
    if (lane === 'clips') return kind === 'clip' || kind === 'image' || kind === 'freeze' || kind === 'video';
    if (lane === 'sounds') return kind === 'sound';
    return false;
  }
  // The `kind` an item carries in a destination lane (only ALT tags its items).
  function kindForLane(lane, fromKind) {
    if (lane === 'sounds') return 'sound';
    if (lane === 'clips') return 'clip';
    return fromKind;
  }

  function findOverlaps(items, getStart, getDur) {
    const overlaps = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        const aS = getStart(a), aE = aS + getDur(a);
        const bS = getStart(b), bE = bS + getDur(b);
        if (aS < bE - EPS && bS < aE - EPS) overlaps.push([a, b]);
      }
    }
    return overlaps;
  }

  // Ordered, priority-resolved visible video segments (MAIN beats ALT). Mirrors
  // export.js mergeClipsByPriority: a lower-priority clip is trimmed wherever a
  // higher-priority clip covers it, so clipping/at any instant only one clip is
  // visible. Returns [{ item, lane, start, end, srcStart, srcEnd }] sorted by time.
  function visibleSegments(mainClips, altClips) {
    const all = [];
    for (const c of mainClips) {
      const s = c.start || 0;
      all.push({ item: c, lane: 'main', prio: 0, s, e: s + durOf(c) });
    }
    for (const c of altClips) {
      const s = c.start || 0;
      all.push({ item: c, lane: 'alt', prio: 1, s, e: s + durOf(c) });
    }
    all.sort((a, b) => a.prio - b.prio || a.s - b.s);
    const segs = [];
    const covered = [];
    const push = (c, start, end) => {
      const speed = speedOf(c.item);
      const base = c.item.srcStart || 0;
      segs.push({
        item: c.item,
        lane: c.lane,
        start,
        end,
        srcStart: base + (start - c.s) * speed,
        srcEnd: base + (end - c.s) * speed,
      });
    };
    for (const c of all) {
      let vs = c.s;
      const overlaps = covered
        .filter(([s, e]) => s < c.e - EPS && e > c.s + EPS)
        .sort((a, b) => a[0] - b[0]);
      for (const [s, e] of overlaps) {
        if (s > vs + EPS) push(c, vs, Math.min(s, c.e));
        vs = Math.max(vs, e);
      }
      if (vs < c.e - EPS) push(c, vs, c.e);
      covered.push([c.s, c.e]);
    }
    return segs.sort((a, b) => a.start - b.start);
  }

  // Per-clip video zoom. `zoom` = { a, b, level, dir, ease, bg, cx, cy }.
  // a,b are clip-local OUTPUT seconds; level is the peak factor (0.25..4, 1 = off).
  //   dir 'in'  -> 1 -> level over [a,b]   (holds level after b)
  //   dir 'out' -> level -> 1 over [a,b]   (holds level before a)
  // ease 'smooth' uses the smoothstep p*p*(3-2p); anything else is linear.
  function zoomFactor(zoom, t) {
    if (!zoom) return 1;
    const level = zoom.level != null ? zoom.level : 1;
    const from = zoom.dir === 'out' ? level : 1;
    const to = zoom.dir === 'out' ? 1 : level;
    const a = zoom.a || 0;
    const b = zoom.b != null ? zoom.b : a;
    if (t <= a) return from;
    if (b <= a || t >= b) return to;
    let p = (t - a) / (b - a);
    if (p < 0) p = 0; else if (p > 1) p = 1;
    if (zoom.ease !== 'linear') p = p * p * (3 - 2 * p);
    return from + (to - from) * p;
  }

  // ---- Camera effects (adjustment layers) ---------------------------------
  // An effect = { start, dur, from:{z,cx,cy}, to:{z,cx,cy}, ease }. Within its
  // band the pose ramps from `from` to `to`; outside, the pose holds (before the
  // first effect = identity; after any effect = that effect's `to`). Overlapping
  // bands combine: zoom multiplies, centres compose (later effect outermost).
  const IDENT = { z: 1, cx: 0.5, cy: 0.5 };
  function effEnd(e) { return (e.start || 0) + Math.max(0, e.dur || 0); }
  // Ramp a pose between its two keys. The interpolation happens in PICTURE
  // OFFSET space (z*cx) rather than centre space: the frame centre is always the
  // pose's (cx,cy), so a point of the picture sitting at (px,py) is drawn at
  // z*(px - cx) from the centre. Easing cx and z separately makes the zoom
  // outrun the pan — a hard zoom toward a corner throws the destination off
  // screen and only lands it on the very last frame (the "it arrives in the last
  // second" drift Premiere/After Effects avoid by moving scale and position as
  // one camera move). Ramping the offset keeps the destination on a straight
  // line to the middle: its screen distance shrinks steadily to zero.
  function rampPose(e, t) {
    const a = e.start || 0;
    const span = Math.max(1e-6, e.dur || 0);
    let p = (t - a) / span;
    if (p < 0) p = 0; else if (p > 1) p = 1;
    const f = e.from || IDENT, to = e.to || IDENT;
    if (e.ease !== 'linear') p = p * p * (3 - 2 * p);
    const z = f.z + (to.z - f.z) * p;
    if (z > 1e-6) {
      return {
        z,
        cx: (f.z * f.cx + (to.z * to.cx - f.z * f.cx) * p) / z,
        cy: (f.z * f.cy + (to.z * to.cy - f.z * f.cy) * p) / z,
      };
    }
    return { z, cx: f.cx + (to.cx - f.cx) * p, cy: f.cy + (to.cy - f.cy) * p };
  }
  // Deterministic camera-shake offset (shared by preview + export): a sum of
  // sines of absolute time, decaying across the band. Units are a fraction of the
  // frame; adding it to (cx,cy) shifts the picture.
  const TAU2 = Math.PI * 2;
  function shakeOffset(e, t) {
    const a = e.start || 0;
    const dur = Math.max(1e-6, e.dur || 0);
    const local = t - a;
    const amp = e.amp != null ? e.amp : 0.02;
    const f = e.freq != null ? e.freq : 16;
    const seed = e.seed != null ? e.seed : 1;
    const ph = ((seed * 0.6180339887) % 1) * TAU2;
    const nx = (Math.sin(TAU2 * f * local + ph) + 0.5 * Math.sin(TAU2 * f * 1.7 * local + ph * 2 + 1.3)) / 1.5;
    const ny = (Math.cos(TAU2 * f * 1.13 * local + ph * 3 + 0.7) + 0.5 * Math.cos(TAU2 * f * 0.83 * local + ph * 5)) / 1.5;
    const decay = e.decay === false ? 1 : Math.max(0, 1 - local / dur);
    const ax = e.axes === 'v' ? 0 : 1;
    const ay = e.axes === 'h' ? 0 : 1;
    return { dx: amp * ax * nx * decay, dy: amp * ay * ny * decay };
  }

  // Effective pose { z, cx, cy } at absolute timeline time t. Effects are
  // bounded to their band: outside every band the pose is identity (whole frame).
  // Overlapping active bands combine (zoom multiplies, centres compose; shake
  // offsets are added on top).
  function effectPoseAt(effects, t) {
    if (!effects || !effects.length) return { ...IDENT };
    const active = effects.filter((e) => t >= (e.start || 0) && t < effEnd(e));
    if (!active.length) return { ...IDENT };
    const zooms = active.filter((e) => e.type !== 'shake' && e.type !== 'fade').sort((a, b) => (a.start || 0) - (b.start || 0));
    let z = 1, ux = 0.5, uy = 0.5;
    for (const e of zooms) {
      const p = rampPose(e, t);
      z *= p.z;
      ux = p.cx + (ux - 0.5) / p.z;
      uy = p.cy + (uy - 0.5) / p.z;
    }
    // Overscan so a shifted frame still covers the output (no black edges).
    let maxAmp = 0;
    for (const e of active) if (e.type === 'shake') maxAmp = Math.max(maxAmp, e.amp != null ? e.amp : 0.02);
    if (maxAmp > 0) z = Math.max(z, 1 / (1 - Math.min(0.45, 2 * maxAmp)));
    for (const e of active) {
      if (e.type !== 'shake') continue;
      const o = shakeOffset(e, t);
      ux += o.dx; uy += o.dy;
    }
    return { z, cx: ux, cy: uy };
  }

  // ---- Framing-aware zoom maths -------------------------------------------
  // The effect zoom is a multiplier on top of the clip's Framing: `cover` fills
  // the frame, `blur` fits the whole picture and fills the bars with a blurred
  // copy. Keeping the base separate from the zoom means a zoom effect never
  // crops the picture, and its first frame (z=1) is exactly the no-effect frame.
  const ZOOM_MIN = 0.05;
  const ZOOM_MAX = 8;
  function clampZoom(z) {
    const v = Number(z);
    if (!isFinite(v)) return 1;
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v));
  }

  // Size of a source with aspect ratio `ar` (width/height) fitted whole inside a
  // W×H box (object-fit: contain). Unknown ratio (metadata not loaded) = the
  // full box, which is also the `cover` picture's size.
  function fitRect(W, H, ar) {
    if (!(ar > 0) || !(W > 0) || !(H > 0)) return { w: W, h: H };
    const h = W / ar;
    return h <= H ? { w: W, h } : { w: H * ar, h: H };
  }

  // CSS transform (with transform-origin at the element's 0 0) that scales the
  // fitted picture by z about the frame centre and puts its point (cx,cy)
  // there — the same centre-point model the exporter uses for its scaled
  // overlay. Identity at z=1, cx=cy=0.5; with a picture that fills the box it
  // reduces to the old `translate(W/2 - cx*W*z) scale(z)`.
  function framingZoomTransform(pose, W, H, ar) {
    const z = pose && pose.z > 0 ? pose.z : 1;
    const cx = pose ? pose.cx : 0.5;
    const cy = pose ? pose.cy : 0.5;
    const { w, h } = fitRect(W, H, ar);
    return {
      w, h,
      tx: W / 2 - (z * (W - w)) / 2 - z * cx * w,
      ty: H / 2 - (z * (H - h)) / 2 - z * cy * h,
    };
  }

  // Where a picture point (fractions of the picture's own width/height) lands on
  // screen under a pose. The pose's (cx,cy) is, by construction, always at the
  // frame centre, so this is how you check that a destination stays in view.
  function picturePointAt(pose, W, H, ar, cx, cy) {
    const z = pose && pose.z > 0 ? pose.z : 1;
    const { w, h } = fitRect(W, H, ar);
    const px = pose ? pose.cx : 0.5;
    const py = pose ? pose.cy : 0.5;
    return { x: W / 2 + z * (cx - px) * w, y: H / 2 + z * (cy - py) * h };
  }

  // Inverse of picturePointAt / framingZoomTransform: which point of the picture
  // sits under a screen point. Turns a right-click on the preview into a zoom
  // destination. Values outside 0..1 mean the picture does not reach that pixel.
  function screenToPicture(pose, W, H, ar, sx, sy) {
    const z = pose && pose.z > 0 ? pose.z : 1;
    const { w, h } = fitRect(W, H, ar);
    const px = pose ? pose.cx : 0.5;
    const py = pose ? pose.cy : 0.5;
    return {
      cx: w > 0 ? (sx - W / 2 + z * px * w) / (z * w) : 0.5,
      cy: h > 0 ? (sy - H / 2 + z * py * h) / (z * h) : 0.5,
    };
  }

  // Where a cut jump (A/D) should land. Frames are half-open [start, end), so an
  // item's end boundary is already the first frame of whatever follows (the next
  // shot, or black at the end of the timeline). Landing there showed the next item
  // instead of the outgoing one's last frame, so an END boundary lands a frame
  // earlier; a boundary with nothing ending on it (a gap's edge) is a real first
  // frame and stays put. Backward jumps want the start frame, so they are exact.
  function nextCutTarget(bounds, ends, t, dir, frame) {
    if (!bounds || !bounds.length) return null;
    const f = Math.max(1e-6, frame || 0);
    const isEnd = (b) => !!(ends && ends.some((x) => Math.abs(x - b) < 1e-6));
    if (dir < 0) {
      for (let i = bounds.length - 1; i >= 0; i--) if (bounds[i] < t - 1e-6) return bounds[i];
      return null;
    }
    for (const b of bounds) {
      const cand = isEnd(b) ? Math.max(0, b - f) : b;
      if (cand > t + 1e-6) return cand;
    }
    return null;
  }

  // Fades. A fade band ramps the picture's opacity: 1 is the untouched frame,
  // 0 is black. Inside the band it ramps 0→1 ("in") or 1→0 ("out"); before the
  // band the frame is untouched, and after an "out" band it stays black. That is
  // exactly ffmpeg's `fade` filter, so the preview overlay and the render agree.
  function fadeAmount(e, t) {
    const a = e.start || 0;
    const dur = Math.max(1e-6, e.dur || 0);
    if (t < a) return 1;
    const p = Math.max(0, Math.min(1, (t - a) / dur));
    return e.dir === 'out' ? 1 - p : p;
  }

  // Alpha for the frame at `t` inside one segment. A fade only paints in the
  // segment it overlaps: a completed fade-out holds black until that segment
  // ends, never into the next clip (the exporter also works segment by segment).
  function fadeAlphaAt(effects, t, segStart, segEnd) {
    let a = 1;
    for (const e of effects || []) {
      if (!e || e.type !== 'fade') continue;
      const b0 = e.start || 0;
      const b1 = b0 + Math.max(0, e.dur || 0);
      if (segEnd != null && b0 >= segEnd - 1e-9) continue;
      if (segStart != null && b1 <= segStart + 1e-9) continue;
      a *= fadeAmount(e, t);
    }
    return Math.max(0, Math.min(1, a));
  }

  // The fade windows one exported segment needs, in the segment's own output
  // time (ffmpeg's `fade` filter runs on the segment's local clock). The band's
  // own start and length are kept, not clipped to the segment: a fade stretched
  // across two clips must carry on ramping in the second one, and ffmpeg reads a
  // negative `st` as "already part way through" the ramp.
  function fadeWindowsForSegment(effects, segStart, segEnd) {
    const out = [];
    for (const e of effects || []) {
      if (!e || e.type !== 'fade') continue;
      const b0 = e.start || 0;
      const b1 = b0 + Math.max(0, e.dur || 0);
      if (b1 <= segStart + 1e-6 || b0 >= segEnd - 1e-6) continue;
      out.push({
        dir: e.dir === 'out' ? 'out' : 'in',
        start: b0 - segStart,
        dur: Math.max(1e-6, b1 - b0),
        audio: e.audio !== false,
      });
    }
    return out;
  }

  // Restore a history snapshot into the document shape. Every lane that
  // snapshotDoc captures must be restored here — keeping this pure makes the
  // "undo must restore effects too" contract unit-testable.
  const asArray = (v) => (Array.isArray(v) ? v : []);
  function restoreDocument(raw) {
    const d = JSON.parse(raw);
    return {
      timeline: asArray(d.timeline),
      soundboard: asArray(d.soundboard),
      hybrid: asArray(d.hybrid),
      markers: asArray(d.markers),
      effects: asArray(d.effects),
    };
  }

  // Stills share one code path through preview and export: images and freeze
  // frames carry no moving source, but behave like clips on a video lane.
  function isStill(item) {
    return !!(item && (item.still === true || item.kind === 'image' || item.kind === 'freeze'));
  }

  const api = { rippleOpen, resolveInsertTime, laneAccepts, kindForLane, durOf, sndDur, hybStartOf, hybDurOf, setHybStart, findOverlaps, visibleSegments, zoomFactor, effectPoseAt, rampPose, shakeOffset, clampZoom, fitRect, framingZoomTransform, picturePointAt, screenToPicture, ZOOM_MIN, ZOOM_MAX, nextCutTarget, fadeAmount, fadeAlphaAt, fadeWindowsForSegment, sourceConflict, restoreDocument, isStill };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TimelineOps = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
