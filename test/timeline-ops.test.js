const test = require('node:test');
const assert = require('node:assert');
const { rippleOpen, resolveInsertTime, laneAccepts, kindForLane, findOverlaps, visibleSegments, zoomFactor, effectPoseAt, shakeOffset, sourceConflict, restoreDocument, isStill } = require('../renderer/timeline-ops');

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

test('effectPoseAt: single zoom-in ramps then returns to identity after the band', () => {
  const eff = [{ start: 2, dur: 2, from: { z: 1, cx: 0.5, cy: 0.5 }, to: { z: 2, cx: 0.3, cy: 0.7 }, ease: 'linear' }];
  assert.deepEqual(effectPoseAt(eff, 0), { z: 1, cx: 0.5, cy: 0.5 });   // before -> identity
  assert.deepEqual(effectPoseAt(eff, 3), { z: 1.5, cx: 0.4, cy: 0.6 }); // half way
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
