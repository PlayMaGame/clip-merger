const test = require('node:test');
const assert = require('node:assert');
const { rippleOpen, resolveInsertTime, laneAccepts, kindForLane, findOverlaps, visibleSegments, zoomFactor, effectPoseAt, rampPose, shakeOffset, clampZoom, fitRect, framingZoomTransform, picturePointAt, screenToPicture, ZOOM_MIN, ZOOM_MAX, nextCutTarget, sourceConflict, restoreDocument, isStill } = require('../renderer/timeline-ops');

const clip = (start, dur) => ({ id: `c${start}`, start, srcStart: 0, srcEnd: dur, speed: 1 });
const hybClip = (start, dur) => ({ id: `h${start}`, kind: 'clip', start, srcStart: 0, srcEnd: dur, speed: 1 });
const hybSound = (start, dur) => ({ id: `hs${start}`, kind: 'sound', startTime: start, endTime: dur, duration: dur });
const sound = (start, dur) => ({ id: `s${start}`, startTime: start, endTime: dur, duration: dur });
const marker = (time) => ({ id: `m${time}`, time, label: '' });

function mkState() {
  return {
    timeline: [clip(0, 10), clip(10, 10)],   // A[0,10) B[10,20)
    hybrid: [hybClip(10, 10), hybSound(20, 5)], // ALT clip [10,20) + ALT sound [20,25)
    soundboard: [sound(10, 5), sound(0, 5)],    // sounds at 10 and 0
    markers: [marker(10), marker(5)],
  };
}

test("rippleOpen 'all' shifts every lane + markers at/after t", () => {
  const s = mkState();
  rippleOpen(s, 10, 4, 'all');
  assert.equal(s.timeline[0].start, 0);      // before t — untouched
  assert.equal(s.timeline[1].start, 14);     // exactly at t — shifted
  assert.equal(s.hybrid[0].start, 14);
  assert.equal(s.hybrid[1].startTime, 24);
  assert.equal(s.soundboard[0].startTime, 14);
  assert.equal(s.soundboard[1].startTime, 0); // before t
  assert.equal(s.markers[0].time, 14);
  assert.equal(s.markers[1].time, 5);         // before t
});

test("rippleOpen 'main' touches only the MAIN lane", () => {
  const s = mkState();
  rippleOpen(s, 10, 4, 'main');
  assert.equal(s.timeline[1].start, 14);
  assert.equal(s.hybrid[0].start, 10);        // ALT untouched
  assert.equal(s.hybrid[1].startTime, 20);
  assert.equal(s.soundboard[0].startTime, 10); // SOUND untouched
  assert.equal(s.markers[0].time, 10);         // markers untouched
});

test("rippleOpen 'alt' touches only the ALT lane", () => {
  const s = mkState();
  rippleOpen(s, 10, 4, 'alt');
  assert.equal(s.hybrid[0].start, 14);
  assert.equal(s.hybrid[1].startTime, 24);
  assert.equal(s.timeline[1].start, 10);
  assert.equal(s.soundboard[0].startTime, 10);
  assert.equal(s.markers[0].time, 10);
});

test("rippleOpen 'sound' touches only the SOUND lane", () => {
  const s = mkState();
  rippleOpen(s, 10, 4, 'sound');
  assert.equal(s.soundboard[0].startTime, 14);
  assert.equal(s.timeline[1].start, 10);
  assert.equal(s.hybrid[0].start, 10);
  assert.equal(s.markers[0].time, 10);
});

test('rippleOpen is a no-op for zero/negative length', () => {
  const s = mkState();
  rippleOpen(s, 10, 0, 'all');
  assert.equal(s.timeline[1].start, 10);
  assert.equal(s.soundboard[0].startTime, 10);
  assert.equal(s.markers[0].time, 10);
});

test('inserting at a boundary shifts the later clip by L (not past it)', () => {
  const s = mkState();
  // Drop a 5s clip exactly between A and B on MAIN.
  const L = 5, t = 10;
  rippleOpen(s, t, L, 'all');
  assert.equal(s.timeline[0].start + 10, 10); // A still ends at 10
  assert.equal(s.timeline[1].start, 15);      // B pushed right by L
});

test('inserting into a gap preserves the surrounding spacing', () => {
  const s = { timeline: [clip(0, 10), clip(20, 10)], hybrid: [], soundboard: [], markers: [] };
  rippleOpen(s, 15, 5, 'all'); // drop at 15, length 5
  assert.equal(s.timeline[1].start, 25); // B (was 20, after t) pushed by 5
  const newEnd = 15 + 5;                  // new item occupies [15,20)
  assert.equal(s.timeline[1].start - newEnd, 5); // trailing gap preserved
});

test('inserting past the end shifts nothing', () => {
  const s = mkState();
  rippleOpen(s, 40, 5, 'all');
  assert.equal(s.timeline[1].start, 10);
  assert.equal(s.hybrid[1].startTime, 20);
  assert.equal(s.markers[0].time, 10);
});

test("resolveInsertTime snaps to the nearer MAIN clip edge", () => {
  const s = mkState();
  assert.equal(resolveInsertTime(s, 2, 'main'), 0);  // nearer A.start
  assert.equal(resolveInsertTime(s, 8, 'main'), 10); // nearer A.end/B.start
  assert.equal(resolveInsertTime(s, 15, 'main'), 10); // exact midpoint -> earlier edge
  assert.equal(resolveInsertTime(s, 18, 'main'), 20); // nearer B.end
  assert.equal(resolveInsertTime(s, 40, 'main'), 40); // in the open — unchanged
});

test('resolveInsertTime snaps inside an ALT clip', () => {
  const s = mkState();
  assert.equal(resolveInsertTime(s, 11, 'alt'), 10); // near ALT-clip start
  assert.equal(resolveInsertTime(s, 19, 'alt'), 20); // near ALT-clip end
});

test('resolveInsertTime snaps inside a SOUND item', () => {
  const s = mkState();
  assert.equal(resolveInsertTime(s, 11, 'sound'), 10);
  assert.equal(resolveInsertTime(s, 14.5, 'sound'), 15);
  assert.equal(resolveInsertTime(s, 99, 'sound'), 99);
});

test('laneAccepts: MAIN takes clips only, SOUND sounds only, ALT both', () => {
  assert.equal(laneAccepts('clips', 'clip'), true);
  assert.equal(laneAccepts('clips', 'sound'), false);
  assert.equal(laneAccepts('sounds', 'sound'), true);
  assert.equal(laneAccepts('sounds', 'clip'), false);
  assert.equal(laneAccepts('hybrid', 'clip'), true);
  assert.equal(laneAccepts('hybrid', 'sound'), true);
  assert.equal(laneAccepts('clips', 'image'), true);
  assert.equal(laneAccepts('clips', 'freeze'), true);
  assert.equal(laneAccepts('sounds', 'image'), false);
  assert.equal(laneAccepts('hybrid', 'freeze'), true);
  assert.equal(laneAccepts('nope', 'clip'), false);
});

test('kindForLane normalizes kind for the destination lane', () => {
  assert.equal(kindForLane('clips', 'sound'), 'clip');
  assert.equal(kindForLane('sounds', 'clip'), 'sound');
  assert.equal(kindForLane('hybrid', 'sound'), 'sound');
  assert.equal(kindForLane('hybrid', 'clip'), 'clip');
});

test('findOverlaps detects overlapping items', () => {
  const items = [
    { id: 'a', start: 0, dur: 10 },
    { id: 'b', start: 5, dur: 10 },
    { id: 'c', start: 20, dur: 5 },
  ];
  const overlaps = findOverlaps(items, (it) => it.start, (it) => it.dur);
  assert.equal(overlaps.length, 1);
  assert.equal(overlaps[0][0].id, 'a');
  assert.equal(overlaps[0][1].id, 'b');
});

test('findOverlaps returns empty for non-overlapping items', () => {
  const items = [
    { id: 'a', start: 0, dur: 10 },
    { id: 'b', start: 10, dur: 10 },
  ];
  const overlaps = findOverlaps(items, (it) => it.start, (it) => it.dur);
  assert.equal(overlaps.length, 0);
});

test('findOverlaps detects multiple overlaps', () => {
  const items = [
    { id: 'a', start: 0, dur: 10 },
    { id: 'b', start: 5, dur: 10 },
    { id: 'c', start: 8, dur: 10 },
  ];
  const overlaps = findOverlaps(items, (it) => it.start, (it) => it.dur);
  assert.equal(overlaps.length, 3);
});

test('visibleSegments: MAIN covers ALT (ALT hidden where MAIN plays)', () => {
  const main = [clip(0, 10)];
  const alt = [hybClip(5, 10)]; // ALT [5,15), MAIN [0,10) -> visible ALT only [10,15)
  const segs = visibleSegments(main, alt);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].lane, 'main');
  assert.deepEqual([segs[0].start, segs[0].end], [0, 10]);
  assert.equal(segs[1].lane, 'alt');
  assert.deepEqual([segs[1].start, segs[1].end], [10, 15]);
  assert.equal(segs[1].srcStart, 5); // 5s into ALT source (hidden 5s prefix)
});

test('visibleSegments: ALT shows through MAIN gaps', () => {
  const main = [clip(0, 5), clip(10, 5)];
  const alt = [hybClip(0, 20)];
  const segs = visibleSegments(main, alt);
  const spans = segs.map((s) => [s.start, s.end, s.lane]);
  assert.deepEqual(spans, [
    [0, 5, 'main'], [5, 10, 'alt'], [10, 15, 'main'], [15, 20, 'alt'],
  ]);
});

test('visibleSegments: an ALT clip fully under MAIN yields no ALT segment', () => {
  const main = [clip(0, 20)];
  const alt = [hybClip(5, 5)];
  const segs = visibleSegments(main, alt);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].lane, 'main');
});

test('visibleSegments: non-overlapping clips are all preserved in order', () => {
  const main = [clip(0, 5)];
  const alt = [hybClip(5, 5)];
  const segs = visibleSegments(main, alt);
  assert.deepEqual(segs.map((s) => [s.start, s.end, s.lane]), [[0, 5, 'main'], [5, 10, 'alt']]);
});

test('visibleSegments: speed-aware source mapping', () => {
  const slow = { id: 'm', start: 0, srcStart: 2, srcEnd: 12, speed: 0.5 }; // output span 20s
  const segs = visibleSegments([slow], []);
  assert.equal(segs[0].srcStart, 2);
  assert.equal(segs[0].srcEnd, 12);
  assert.equal(segs[0].end, 20);
});

test('zoomFactor: no zoom is identity', () => {
  assert.equal(zoomFactor(null, 5), 1);
});

test('zoomFactor: dir in holds 1 before, eases to level, holds level after', () => {
  const z = { a: 1, b: 3, level: 2, dir: 'in', ease: 'smooth' };
  assert.equal(zoomFactor(z, 0), 1);        // before -> from
  assert.equal(zoomFactor(z, 1), 1);
  assert.equal(zoomFactor(z, 2), 1.5);      // smoothstep midpoint
  assert.equal(zoomFactor(z, 3), 2);        // after -> to
  assert.equal(zoomFactor(z, 9), 2);
});

test('zoomFactor: dir out holds level before, eases to 1', () => {
  const z = { a: 0, b: 2, level: 0.5, dir: 'out', ease: 'smooth' };
  assert.equal(zoomFactor(z, -1), 0.5);
  assert.equal(zoomFactor(z, 1), 0.75);
  assert.equal(zoomFactor(z, 2), 1);
  assert.equal(zoomFactor(z, 10), 1);
});

test('zoomFactor: linear is a straight ramp', () => {
  const z = { a: 0, b: 2, level: 3, dir: 'in', ease: 'linear' };
  assert.equal(zoomFactor(z, 1), 2);        // halfway 1 -> 3
});

test('effectPoseAt: no effects -> identity', () => {
  assert.deepEqual(effectPoseAt([], 5), { z: 1, cx: 0.5, cy: 0.5 });
});

test('effectPoseAt: single zoom-in ramps pan and zoom together', () => {
  const eff = [{ start: 2, dur: 2, from: { z: 1, cx: 0.5, cy: 0.5 }, to: { z: 2, cx: 0.3, cy: 0.7 }, ease: 'linear' }];
  assert.deepEqual(effectPoseAt(eff, 0), { z: 1, cx: 0.5, cy: 0.5 });   // before -> identity
  // Half way the picture OFFSET (z*cx) is half way, so the centre has already
  // moved further than a linear centre lerp would: 0.55/1.5 and 0.95/1.5.
  const mid = effectPoseAt(eff, 3);
  assert.ok(Math.abs(mid.z - 1.5) < 1e-9, String(mid.z));
  assert.ok(Math.abs(mid.cx - 0.55 / 1.5) < 1e-9, String(mid.cx));
  assert.ok(Math.abs(mid.cy - 0.95 / 1.5) < 1e-9, String(mid.cy));
  assert.deepEqual(effectPoseAt(eff, 9), { z: 1, cx: 0.5, cy: 0.5 });   // after -> identity (bounded)
});

test('effectPoseAt: overlapping effects multiply zoom', () => {
  const eff = [
    { start: 0, dur: 10, from: { z: 2, cx: 0.5, cy: 0.5 }, to: { z: 2, cx: 0.5, cy: 0.5 }, ease: 'linear' },
    { start: 0, dur: 10, from: { z: 1.5, cx: 0.5, cy: 0.5 }, to: { z: 1.5, cx: 0.5, cy: 0.5 }, ease: 'linear' },
  ];
  const p = effectPoseAt(eff, 5); // both held at their pose inside the band
  assert.ok(Math.abs(p.z - 3) < 1e-9); // 2 * 1.5
  assert.ok(Math.abs(p.cx - 0.5) < 1e-9);
});

test('shakeOffset: deterministic and decays to zero at the band end', () => {
  const e = { type: 'shake', start: 1, dur: 2, amp: 0.05, freq: 20, decay: true, axes: 'both', seed: 7 };
  assert.deepEqual(shakeOffset(e, 1.5), shakeOffset(e, 1.5));
  const end = shakeOffset(e, 3 - 1e-9);
  assert.ok(Math.abs(end.dx) < 1e-6 && Math.abs(end.dy) < 1e-6);
});

test('effectPoseAt: a shake adds a positional offset (and a little overscan zoom)', () => {
  const eff = [{ type: 'shake', start: 0, dur: 2, amp: 0.05, freq: 20, decay: false, axes: 'both', seed: 7 }];
  const p = effectPoseAt(eff, 0.5);
  assert.ok(p.z > 1); // overscan so the shifted frame still covers
  assert.ok(Math.abs(p.cx - 0.5) > 1e-6 || Math.abs(p.cy - 0.5) > 1e-6);
});

test('sourceConflict detects an export path that matches any source clip', () => {
  const project = {
    timeline: [{ path: 'C:\\Clips\\A.mp4' }],
    hybrid: [{ path: 'C:\\Clips\\B.mp4' }],
    soundboard: [{ path: 'C:\\Music\\C.WAV' }],
  };
  assert.equal(sourceConflict('C:\\Clips\\A.mp4', project), 'C:\\Clips\\A.mp4');
  assert.equal(sourceConflict('c:/clips/a.MP4', project), 'C:\\Clips\\A.mp4');
  assert.equal(sourceConflict('C:\\Music\\c.wav', project), 'C:\\Music\\C.WAV');
  assert.equal(sourceConflict('C:\\Output\\merged.mp4', project), null);
  assert.equal(sourceConflict('', project), null);
});

test('sourceConflict also checks legacy clips arrays', () => {
  const project = { clips: [{ path: 'C:\\Clips\\Legacy.mp4' }] };
  assert.equal(sourceConflict('c:\\clips\\legacy.mp4', project), 'C:\\Clips\\Legacy.mp4');
});

test('restoreDocument restores every snapshotted lane including effects', () => {
  const snap = JSON.stringify({
    timeline: [{ id: 't' }],
    soundboard: [{ id: 's' }],
    hybrid: [{ id: 'h' }],
    markers: [{ id: 'm' }],
    effects: [{ id: 'e', type: 'shake' }],
  });
  const d = restoreDocument(snap);
  assert.deepEqual(d.timeline, [{ id: 't' }]);
  assert.deepEqual(d.soundboard, [{ id: 's' }]);
  assert.deepEqual(d.hybrid, [{ id: 'h' }]);
  assert.deepEqual(d.markers, [{ id: 'm' }]);
  assert.deepEqual(d.effects, [{ id: 'e', type: 'shake' }]);
});

test('restoreDocument defaults missing lanes (legacy snapshots) to empty arrays', () => {
  const d = restoreDocument(JSON.stringify({ timeline: [{ id: 't' }] }));
  assert.deepEqual(d.timeline, [{ id: 't' }]);
  assert.deepEqual(d.soundboard, []);
  assert.deepEqual(d.hybrid, []);
  assert.deepEqual(d.markers, []);
  assert.deepEqual(d.effects, []);
});

test('isStill recognizes images, freezes, and explicit still flags', () => {
  assert.equal(isStill({ kind: 'image' }), true);
  assert.equal(isStill({ kind: 'freeze' }), true);
  assert.equal(isStill({ still: true, kind: 'clip' }), true);
  assert.equal(isStill({ kind: 'video' }), false);
  assert.equal(isStill(null), false);
});

test('fitRect fits a source into the box and keeps its aspect ratio', () => {
  // 16:9 source in a 9:16 box: width-limited, bars top and bottom.
  assert.deepEqual(fitRect(1080, 1920, 16 / 9), { w: 1080, h: 607.5 });
  // 9:16 source: fills the box exactly.
  assert.deepEqual(fitRect(1080, 1920, 9 / 16), { w: 1080, h: 1920 });
  // 1:1 source: width-limited.
  assert.deepEqual(fitRect(1080, 1920, 1), { w: 1080, h: 1080 });
  // A source taller than the box (e.g. 1:3): height-limited.
  assert.deepEqual(fitRect(1080, 1920, 1 / 3), { w: 640, h: 1920 });
  // Unknown ratio (metadata not loaded) = the whole box, like `cover`.
  assert.deepEqual(fitRect(1080, 1920, 0), { w: 1080, h: 1920 });
  assert.deepEqual(fitRect(1080, 1920, NaN), { w: 1080, h: 1920 });
});

test('framingZoomTransform is the identity at z=1 centred, for any aspect ratio', () => {
  const pose = { z: 1, cx: 0.5, cy: 0.5 };
  for (const ar of [9 / 16, 16 / 9, 1, 1 / 3, 0]) {
    const t = framingZoomTransform(pose, 1080, 1920, ar);
    assert.ok(Math.abs(t.tx) < 1e-9, `tx ${t.tx} for ar ${ar}`);
    assert.ok(Math.abs(t.ty) < 1e-9, `ty ${t.ty} for ar ${ar}`);
  }
});

test('framingZoomTransform reduces to the old formula when the picture fills the box', () => {
  // This is the `cover` case: the content rect is the whole stage.
  const ar = 9 / 16; // equals 1080/1920 -> fitRect = the box
  for (const z of [0.5, 1.4, 4]) {
    for (const [cx, cy] of [[0.5, 0.5], [0.2, 0.8]]) {
      const t = framingZoomTransform({ z, cx, cy }, 1080, 1920, ar);
      assert.ok(Math.abs(t.tx - (1080 / 2 - cx * 1080 * z)) < 1e-9);
      assert.ok(Math.abs(t.ty - (1920 / 2 - cy * 1920 * z)) < 1e-9);
    }
  }
});

test('framingZoomTransform puts the pose centre at the frame centre (letterboxed)', () => {
  const W = 1080, H = 1920;
  const ar = 16 / 9;
  for (const z of [0.3, 1, 1.4, 6]) {
    for (const [cx, cy] of [[0.5, 0.5], [0.25, 0.75], [1, 0]]) {
      const pose = { z, cx, cy };
      const t = framingZoomTransform(pose, W, H, ar);
      // The element point under the pose centre is the content origin plus the
      // fraction of the content size; translate+scale (origin 0 0) maps it to
      // the stage centre, exactly where the exporter's overlay puts it.
      const ox = (W - t.w) / 2, oy = (H - t.h) / 2;
      const px = ox + cx * t.w, py = oy + cy * t.h;
      assert.ok(Math.abs(t.tx + z * px - W / 2) < 1e-9, `x z=${z} cx=${cx}`);
      assert.ok(Math.abs(t.ty + z * py - H / 2) < 1e-9, `y z=${z} cy=${cy}`);
    }
  }
});

test('clampZoom keeps the effect zoom inside the slider range', () => {
  assert.equal(clampZoom(1.4), 1.4);
  assert.equal(clampZoom(0), ZOOM_MIN);
  assert.equal(clampZoom(-3), ZOOM_MIN);
  assert.equal(clampZoom(999), ZOOM_MAX);
  assert.equal(clampZoom(NaN), 1);
  assert.equal(clampZoom(undefined), 1);
  // Wide enough to shrink the picture to a speck and to push in hard.
  assert.ok(ZOOM_MIN <= 0.05);
  assert.ok(ZOOM_MAX >= 8);
});

// Cut jumps (A/D). Frames are half-open, so an item's end boundary already shows
// whatever comes next; a jump forward lands on the outgoing item's last frame.
const FPS = 60;
const FRAME = 1 / FPS;

test('nextCutTarget lands on the last frame of the item that ends there', () => {
  // Two contiguous 1 s clips: cuts at 0, 1, 2 where 1 and 2 are ends.
  const bounds = [0, 1, 2];
  const ends = [1, 2];
  assert.equal(nextCutTarget(bounds, ends, 0.2, 1, FRAME), 59 / 60);
});

test('nextCutTarget walks on from the last frame instead of sticking', () => {
  const bounds = [0, 1, 2];
  const ends = [1, 2];
  // Already on the last frame of the first clip -> the next end, one frame early.
  assert.equal(nextCutTarget(bounds, ends, 1 - FRAME, 1, FRAME), 2 - FRAME);
  // Exactly on the boundary is already the next shot, so it skips as well.
  assert.equal(nextCutTarget(bounds, ends, 1, 1, FRAME), 2 - FRAME);
});

test('nextCutTarget keeps a gap edge exact and backward jumps on the start frame', () => {
  // Clip 0..1, gap, curve: 2 is a start with nothing ending on it.
  const bounds = [0, 1, 2];
  const ends = [1];
  assert.equal(nextCutTarget(bounds, ends, 1.5, 1, FRAME), 2);
  assert.equal(nextCutTarget(bounds, ends, 1.5, -1, FRAME), 1);
  assert.equal(nextCutTarget(bounds, ends, 1 - FRAME, -1, FRAME), 0);
});

test('nextCutTarget handles the timeline end, the edges and float noise', () => {
  const bounds = [0, 1];
  const ends = [1];
  assert.equal(nextCutTarget(bounds, ends, 0.1, 1, FRAME), 1 - FRAME); // total = an end
  assert.equal(nextCutTarget([0], [0], 0, -1, FRAME), null);
  assert.equal(nextCutTarget(bounds, ends, 1 - FRAME, 1, FRAME), null);
  // A boundary carrying float noise still counts as that item's end.
  const noisy = nextCutTarget([0, 0.9999999, 2], [1], 0.2, 1, FRAME);
  assert.ok(Math.abs(noisy - (1 - FRAME)) < 1e-6, String(noisy));
});

test('nextCutTarget skips a candidate that is behind the playhead', () => {
  // t sits inside the last frame of the first clip, so 1 - frame is in the past.
  const got = nextCutTarget([0, 1, 2], [1, 2], 0.99, 1, 0.5);
  assert.equal(got, 1.5);
});

test('rampPose keeps the destination on screen and lands it dead centre', () => {
  // A hard zoom into a corner: the classic case where easing the centre and the
  // zoom separately throws the target off screen until the last frame.
  const e = { start: 0, dur: 3, from: { z: 1, cx: 0.5, cy: 0.5 }, to: { z: 8, cx: 0.15, cy: 0.85 } };
  const W = 1080, H = 1920, ar = 16 / 9; // a 16:9 picture letterboxed in a 9:16 frame
  let last = Infinity;
  for (let i = 0; i <= 30; i++) {
    const t = (i / 30) * 3;
    const p = rampPose(e, t);
    const at = picturePointAt(p, W, H, ar, e.to.cx, e.to.cy);
    const dist = Math.hypot(at.x - W / 2, at.y - H / 2);
    assert.ok(at.x >= 0 && at.x <= W && at.y >= 0 && at.y <= H, `off screen at t=${t}: ${at.x},${at.y}`);
    assert.ok(dist <= last + 1e-9, `destination moved away from the centre at t=${t}`);
    last = dist;
  }
  const end = picturePointAt(rampPose(e, 3), W, H, ar, e.to.cx, e.to.cy);
  assert.ok(Math.abs(end.x - W / 2) < 1e-6 && Math.abs(end.y - H / 2) < 1e-6);
  // The keys themselves are untouched.
  const first = rampPose(e, 0);
  assert.ok(Math.abs(first.z - 1) < 1e-12 && Math.abs(first.cx - 0.5) < 1e-12);
});

test('rampPose behaves like a plain lerp for a pure pan', () => {
  const e = { start: 0, dur: 2, from: { z: 2, cx: 0.2, cy: 0.8 }, to: { z: 2, cx: 0.6, cy: 0.4 }, ease: 'linear' };
  const mid = rampPose(e, 1);
  assert.ok(Math.abs(mid.z - 2) < 1e-12);
  assert.ok(Math.abs(mid.cx - 0.4) < 1e-12);
  assert.ok(Math.abs(mid.cy - 0.6) < 1e-12);
});

test('screenToPicture inverts picturePointAt', () => {
  const W = 1080, H = 1920, ar = 16 / 9;
  const poses = [
    { z: 1, cx: 0.5, cy: 0.5 },
    { z: 2.5, cx: 0.2, cy: 0.75 },
    { z: 0.4, cx: 0.9, cy: 0.1 },
  ];
  for (const pose of poses) {
    for (const [cx, cy] of [[0.5, 0.5], [0.15, 0.85], [0, 1], [1, 0]]) {
      const pt = picturePointAt(pose, W, H, ar, cx, cy);
      const back = screenToPicture(pose, W, H, ar, pt.x, pt.y);
      assert.ok(Math.abs(back.cx - cx) < 1e-9, `cx ${cx} -> ${back.cx}`);
      assert.ok(Math.abs(back.cy - cy) < 1e-9, `cy ${cy} -> ${back.cy}`);
    }
  }
});

test('screenToPicture reports clicks outside the picture', () => {
  const W = 1080, H = 1920, ar = 16 / 9; // picture is 1080x607.5, letterboxed
  const top = screenToPicture({ z: 1, cx: 0.5, cy: 0.5 }, W, H, ar, W / 2, 10);
  assert.ok(top.cy < 0, String(top.cy)); // above the picture
  const side = screenToPicture({ z: 1, cx: 0.5, cy: 0.5 }, W, H, ar, -5, H / 2);
  assert.ok(side.cx < 0, String(side.cx));
});
