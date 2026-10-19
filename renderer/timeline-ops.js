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
    if (lane === 'hybrid') return kind === 'clip' || kind === 'sound';
    if (lane === 'clips') return kind === 'clip';
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
  function rampPose(e, t) {
    const a = e.start || 0;
    const span = Math.max(1e-6, e.dur || 0);
    let p = (t - a) / span;
    if (p < 0) p = 0; else if (p > 1) p = 1;
    const f = e.from || IDENT, to = e.to || IDENT;
    if (e.ease !== 'linear') p = p * p * (3 - 2 * p);
    return { z: f.z + (to.z - f.z) * p, cx: f.cx + (to.cx - f.cx) * p, cy: f.cy + (to.cy - f.cy) * p };
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
    const zooms = active.filter((e) => e.type !== 'shake').sort((a, b) => (a.start || 0) - (b.start || 0));
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

  const api = { rippleOpen, resolveInsertTime, laneAccepts, kindForLane, durOf, sndDur, hybStartOf, hybDurOf, setHybStart, findOverlaps, visibleSegments, zoomFactor, effectPoseAt, rampPose, shakeOffset };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TimelineOps = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
