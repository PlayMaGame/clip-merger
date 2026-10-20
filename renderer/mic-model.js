/* Mic take model — pure helpers shared by the recorder UI and tests.
   A clip is { id, track, start, samples: Float32Array, from?, to? }. `start` is
   the clip's position on the mini timeline in seconds; `samples` is the whole
   recorded take and [from, to) is the audible window into it. Splitting and
   trimming only move that window, so an edge can always be dragged back out
   (like the main timeline's srcStart/srcEnd). Clips without from/to play all
   samples. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MicModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MIN_LEN = 0.05;
  const EPS = 1e-9;

  function clipFrom(c) { return c.from == null ? 0 : c.from; }
  function clipTo(c) { return c.to == null ? c.samples.length : c.to; }
  function clipSamples(c) {
    const from = clipFrom(c);
    const to = clipTo(c);
    if (from === 0 && to === c.samples.length) return c.samples;
    return c.samples.subarray(from, to);
  }

  function clipDur(c, sampleRate) {
    return (clipTo(c) - clipFrom(c)) / sampleRate;
  }

  function clipEnd(c, sampleRate) {
    return c.start + clipDur(c, sampleRate);
  }

  function takesEnd(clips, sampleRate) {
    let end = 0;
    for (const c of clips) end = Math.max(end, clipEnd(c, sampleRate));
    return end;
  }

  function splitClip(c, atAbs, sampleRate, makeId) {
    const dur = clipDur(c, sampleRate);
    const local = atAbs - c.start;
    if (local < MIN_LEN || dur - local < MIN_LEN) return [c];
    const from = clipFrom(c);
    const to = clipTo(c);
    const cut = Math.max(1, Math.min(to - from - 1, Math.round(local * sampleRate)));
    return [
      { ...c, from, to: from + cut },
      {
        ...c,
        id: makeId ? makeId() : c.id + ':b',
        start: c.start + cut / sampleRate,
        from: from + cut,
        to,
      },
    ];
  }

  // Move one edge to an absolute time. The take stays intact, so an edge can
  // be dragged back out to the original recorded bounds — never destructive.
  function trimClip(c, edge, atAbs, sampleRate, minLen = MIN_LEN) {
    const left = edge === 'l' || edge === 'left';
    const minSamples = Math.max(1, Math.round(minLen * sampleRate));
    const from = clipFrom(c);
    const to = clipTo(c);
    const idx = from + Math.round((atAbs - c.start) * sampleRate);
    if (left) {
      const next = Math.max(0, Math.min(idx, to - minSamples));
      if (next === from) return c;
      return { ...c, start: c.start + (next - from) / sampleRate, from: next, to };
    }
    const next = Math.max(from + minSamples, Math.min(idx, c.samples.length));
    if (next === to) return c;
    return { ...c, from, to: next };
  }

  function moveClip(c, start, minStart = 0) {
    return { ...c, start: Math.max(minStart, start) };
  }

  // Remove [start,end) from one clip, returning 0–2 remaining pieces.
  function removeRangeFromClip(c, start, end, sampleRate, makeId) {
    const cStart = c.start;
    const cEnd = clipEnd(c, sampleRate);
    if (end <= cStart + EPS || start >= cEnd - EPS) return [c];
    const from = clipFrom(c);
    const to = clipTo(c);
    const out = [];
    const cutL = Math.max(0, Math.round((Math.min(start, cEnd) - cStart) * sampleRate));
    const cutR = Math.max(0, Math.round((Math.max(end, cStart) - cStart) * sampleRate));
    if (cutL > 0) out.push({ ...c, from, to: from + Math.min(cutL, to - from) });
    if (from + cutR < to) {
      out.push({
        ...c,
        id: makeId ? makeId() : c.id + ':r',
        start: c.start + cutR / sampleRate,
        from: from + cutR,
        to,
      });
    }
    return out;
  }

  // Punch-in: clear the recorded span on one track, preserving pieces outside it.
  // Surviving pieces get their own sample buffer, so the overwritten audio cannot
  // be trimmed back in later.
  function punchTrack(clips, start, end, sampleRate, makeId) {
    const out = [];
    for (const c of clips) {
      for (const piece of removeRangeFromClip(c, start, end, sampleRate, makeId)) {
        if (piece === c) { out.push(c); continue; }
        const from = clipFrom(piece);
        const to = clipTo(piece);
        out.push({ ...piece, samples: piece.samples.slice(from, to), from: 0, to: to - from });
      }
    }
    return out.sort((a, b) => a.start - b.start);
  }

  function mixClips(clips, sampleRate) {
    const total = Math.ceil(takesEnd(clips, sampleRate) * sampleRate - EPS);
    const out = new Float32Array(Math.max(0, total));
    for (const c of clips) {
      const data = clipSamples(c);
      const off = Math.max(0, Math.round(c.start * sampleRate));
      for (let i = 0; i < data.length; i++) {
        const j = off + i;
        if (j >= out.length) break;
        const v = out[j] + data[i];
        out[j] = v > 1 ? 1 : (v < -1 ? -1 : v);
      }
    }
    return out;
  }

  function snapTime(t, points, threshold) {
    let best = t;
    let bestD = threshold;
    for (const p of points) {
      const d = Math.abs(p - t);
      if (d <= bestD) { best = p; bestD = d; }
    }
    return best;
  }

  function cutPoints(clips, sampleRate) {
    const q = (v) => Math.round(v * 1e6) / 1e6;
    const set = new Set([0]);
    for (const c of clips) {
      set.add(q(c.start));
      set.add(q(c.start + clipDur(c, sampleRate)));
    }
    return [...set].sort((a, b) => a - b);
  }

  function nextCut(points, t, dir, eps = 1e-6) {
    let best = null;
    if (dir < 0) {
      for (const p of points) if (p < t - eps && (best === null || p > best)) best = p;
    } else {
      for (const p of points) if (p > t + eps && (best === null || p < best)) best = p;
    }
    return best;
  }

  // Timeline pixel <-> time. The mini timeline maps `pps` pixels to one second
  // after a fixed gutter, so a visible span of N px is always N/pps seconds.
  // Never scale a clip to fit the viewport: that squeezes it and freezes its
  // waveform while the ruler scrolls.
  function xAt(t, offset, pps, gutter) {
    return gutter + (t - offset) * pps;
  }

  function timeAtX(x, offset, pps, gutter) {
    return offset + (x - gutter) / pps;
  }

  // Where playback must start reading inside c.samples when the playhead is at
  // `atAbs`. `start` is the first audible sample of the window, so the buffer
  // offset is the source in-point - not "how far into the timeline the clip
  // began". Without this a split tail plays the head of the take.
  function sourceOffsetAt(c, atAbs, sampleRate) {
    const from = clipFrom(c);
    const to = clipTo(c);
    const idx = from + Math.round((atAbs - c.start) * sampleRate);
    return Math.max(from, Math.min(to, idx)) / sampleRate;
  }

  return {
    MIN_LEN,
    clipFrom,
    clipTo,
    clipSamples,
    clipDur,
    clipEnd,
    takesEnd,
    splitClip,
    trimClip,
    moveClip,
    removeRangeFromClip,
    punchTrack,
    mixClips,
    snapTime,
    cutPoints,
    nextCut,
    xAt,
    timeAtX,
    sourceOffsetAt,
  };
});
