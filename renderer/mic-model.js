/* Two-track mic take model — pure helpers shared by the recorder UI and tests.
   A clip is { id, track, start, samples: Float32Array }. `start` is the clip's
   position on the mini timeline in seconds; the audio itself is self-contained. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MicModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const MIN_LEN = 0.05;
  const EPS = 1e-9;

  function clipDur(c, sampleRate) {
    return c.samples.length / sampleRate;
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
    const cut = Math.max(1, Math.min(c.samples.length - 1, Math.round(local * sampleRate)));
    return [
      { ...c, samples: c.samples.slice(0, cut) },
      {
        ...c,
        id: makeId ? makeId() : c.id + ':b',
        start: c.start + cut / sampleRate,
        samples: c.samples.slice(cut),
      },
    ];
  }

  function trimClip(c, edge, atAbs, sampleRate, minLen = MIN_LEN) {
    const dur = clipDur(c, sampleRate);
    const end = c.start + dur;
    if (edge === 'l') {
      const at = Math.max(c.start, Math.min(atAbs, end - minLen));
      const remove = Math.max(0, Math.min(c.samples.length - 1, Math.round((at - c.start) * sampleRate)));
      return { ...c, start: c.start + remove / sampleRate, samples: c.samples.slice(remove) };
    }
    const at = Math.max(c.start + minLen, Math.min(atAbs, end));
    const keep = Math.max(1, Math.min(c.samples.length, Math.round((at - c.start) * sampleRate)));
    return { ...c, samples: c.samples.slice(0, keep) };
  }

  function moveClip(c, start, minStart = 0) {
    return { ...c, start: Math.max(minStart, start) };
  }

  // Remove [start,end) from one clip, returning 0–2 remaining pieces.
  function removeRangeFromClip(c, start, end, sampleRate, makeId) {
    const cStart = c.start;
    const cEnd = clipEnd(c, sampleRate);
    if (end <= cStart + EPS || start >= cEnd - EPS) return [c];
    const out = [];
    const cutL = Math.max(0, Math.round((Math.min(start, cEnd) - cStart) * sampleRate));
    const cutR = Math.max(0, Math.round((Math.max(end, cStart) - cStart) * sampleRate));
    if (cutL > 0) out.push({ ...c, samples: c.samples.slice(0, cutL) });
    if (cutR < c.samples.length) {
      out.push({
        ...c,
        id: makeId ? makeId() : c.id + ':r',
        start: c.start + cutR / sampleRate,
        samples: c.samples.slice(cutR),
      });
    }
    return out;
  }

  // Punch-in: clear the recorded span on one track, preserving pieces outside it.
  function punchTrack(clips, start, end, sampleRate, makeId) {
    const out = [];
    for (const c of clips) out.push(...removeRangeFromClip(c, start, end, sampleRate, makeId));
    return out.sort((a, b) => a.start - b.start);
  }

  function mixClips(clips, sampleRate) {
    const total = Math.ceil(takesEnd(clips, sampleRate) * sampleRate - EPS);
    const out = new Float32Array(Math.max(0, total));
    for (const c of clips) {
      const off = Math.max(0, Math.round(c.start * sampleRate));
      for (let i = 0; i < c.samples.length; i++) {
        const j = off + i;
        if (j >= out.length) break;
        const v = out[j] + c.samples[i];
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
      set.add(q(c.start + c.samples.length / sampleRate));
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

  return {
    MIN_LEN,
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
  };
});
