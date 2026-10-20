const test = require('node:test');
const assert = require('node:assert');
const M = require('../renderer/mic-model.js');

const SR = 10; // 10 samples per second keeps the fixtures readable
const c = (start, data, id = 'c1') => ({
  id, track: 'main', start, samples: Float32Array.from(data),
});
const win = (clip) => [...M.clipSamples(clip)];

test('splitClip cuts the window and offsets the right piece', () => {
  const src = c(0, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const [a, b] = M.splitClip(src, 0.4, SR, () => 'c2');
  assert.equal(M.clipDur(a, SR), 0.4);
  assert.equal(a.start, 0);
  assert.deepEqual(win(a), [0, 1, 2, 3]);
  assert.equal(b.id, 'c2');
  assert.equal(b.start, 0.4);
  assert.deepEqual(win(b), [4, 5, 6, 7, 8, 9]);
  // Both halves keep the whole take, so their edges stay extendable.
  assert.equal(a.samples, b.samples);
  assert.equal(M.clipEnd(b, SR), 1);
});

test('splitClip refuses cuts inside the minimum length', () => {
  const src = c(0, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(M.splitClip(src, 0.01, SR), [src]);
  assert.deepEqual(M.splitClip(src, 0.99, SR), [src]);
});

test('trimClip moves the left edge and keeps the right edge fixed', () => {
  const src = c(0, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const left = M.trimClip(src, 'l', 0.3, SR);
  assert.equal(left.start, 0.3);
  assert.deepEqual(win(left), [3, 4, 5, 6, 7, 8, 9]);
  assert.equal(M.clipEnd(left, SR), 1);
});

test('trimClip shortens the right edge', () => {
  const src = c(0, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const right = M.trimClip(src, 'r', 0.3, SR);
  assert.equal(right.start, 0);
  assert.deepEqual(win(right), [0, 1, 2]);
  assert.equal(M.clipDur(right, SR), 0.3);
});

test('trimClip accepts the UI edge names (left/right)', () => {
  const src = c(0, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const left = M.trimClip(src, 'left', 0.3, SR);
  assert.equal(left.start, 0.3);
  assert.deepEqual(win(left), [3, 4, 5, 6, 7, 8, 9]);
  const right = M.trimClip(src, 'right', 0.3, SR);
  assert.equal(right.start, 0);
  assert.deepEqual(win(right), [0, 1, 2]);
});

test('trimClip drags an edge back out after a split (non-destructive)', () => {
  const src = c(0, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const [a, b] = M.splitClip(src, 0.4, SR, () => 'c2');

  let right = b;
  for (const at of [0.5, 0.6, 0.5, 0.4]) right = M.trimClip(right, 'l', at, SR);
  assert.equal(right.start, 0.4);
  assert.deepEqual(win(right), [4, 5, 6, 7, 8, 9]);

  let left = a;
  for (const at of [0.3, 0.35, 0.4]) left = M.trimClip(left, 'r', at, SR);
  assert.equal(M.clipDur(left, SR), 0.4);
  assert.deepEqual(win(left), [0, 1, 2, 3]);

  // And a trimmed clip can be pulled back out to the original take bounds.
  const back = M.trimClip(M.trimClip(src, 'l', 0.5, SR), 'l', 0, SR);
  assert.equal(back.start, 0);
  assert.equal(M.clipDur(back, SR), 1);
});

test('removeRangeFromClip punches a hole into two pieces', () => {
  const src = c(0, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const parts = M.removeRangeFromClip(src, 0.3, 0.6, SR, () => 'tail');
  assert.equal(parts.length, 2);
  assert.deepEqual(win(parts[0]), [0, 1, 2]);
  assert.equal(parts[1].start, 0.6);
  assert.equal(parts[1].id, 'tail');
  assert.deepEqual(win(parts[1]), [6, 7, 8, 9]);
});

test('removeRangeFromClip keeps windows of already trimmed clips', () => {
  const src = c(0, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const trimmed = M.trimClip(src, 'l', 0.2, SR);
  const parts = M.removeRangeFromClip(trimmed, 0.4, 0.5, SR, () => 'tail');
  assert.equal(parts.length, 2);
  assert.deepEqual(win(parts[0]), [2, 3]);
  assert.equal(parts[1].start, 0.5);
  assert.deepEqual(win(parts[1]), [5, 6, 7, 8, 9]);
});

test('removeRangeFromClip deletes a fully covered clip and ignores misses', () => {
  const src = c(1, [0, 1, 2]);
  assert.deepEqual(M.removeRangeFromClip(src, 1, 1.3, SR), []);
  assert.deepEqual(M.removeRangeFromClip(src, 0, 0.5, SR), [src]);
});

test('punchTrack clears only the target span and keeps order', () => {
  const a = c(0, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'a');
  const b = c(1, [0, 1, 2], 'b');
  const out = M.punchTrack([a, b], 0.3, 0.6, SR);
  assert.deepEqual(out.map((x) => x.id), ['a', 'a:r', 'b']);
  assert.deepEqual(win(out[0]), [0, 1, 2]);
  assert.deepEqual(win(out[1]), [6, 7, 8, 9]);
  assert.equal(M.takesEnd(out, SR), 1.3);
});

test('punchTrack drops the overwritten audio so it cannot be trimmed back in', () => {
  const src = c(0, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const out = M.punchTrack([src], 0.3, 0.6, SR);
  assert.equal(out.length, 2);
  const left = M.trimClip(out[0], 'r', 0.9, SR);
  assert.deepEqual(win(left), [0, 1, 2]);
  const right = M.trimClip(out[1], 'l', 0, SR);
  assert.deepEqual(win(right), [6, 7, 8, 9]);
  assert.equal(right.start, 0.6);
});

test('moveClip clamps below zero and mixClips sums overlapping audio', () => {
  const a = c(0, [0.5, 0.5]);
  const b = M.moveClip(c(0.1, [0.75, 0.25]), 0.1, 0);
  assert.equal(b.start, 0.1);
  assert.equal(M.moveClip(a, -2).start, 0);
  const mixed = M.mixClips([a, b], SR);
  assert.equal(mixed.length, 3);
  assert.ok(Math.abs(mixed[0] - 0.5) < 1e-6);
  assert.ok(Math.abs(mixed[1] - 1) < 1e-6); // 0.5 + 0.75 clamps to 1
  assert.ok(Math.abs(mixed[2] - 0.25) < 1e-6);
});

test('mixClips leaves gaps silent and handles an empty take', () => {
  const mixed = M.mixClips([c(0.2, [1, -1])], SR);
  assert.equal(mixed.length, 4);
  assert.deepEqual([...mixed], [0, 0, 1, -1]);
  assert.equal(M.mixClips([], SR).length, 0);
  assert.equal(M.takesEnd([], SR), 0);
});

test('mixClips honours a trimmed window', () => {
  const src = c(0, [0.1, 0.2, 0.3, 0.4]);
  const trimmed = M.trimClip(M.trimClip(src, 'l', 0.1, SR), 'r', 0.3, SR);
  const mixed = M.mixClips([trimmed], SR);
  assert.equal(mixed.length, 3);
  assert.ok(Math.abs(mixed[0]) < 1e-6);
  assert.ok(Math.abs(mixed[1] - 0.2) < 1e-6);
  assert.ok(Math.abs(mixed[2] - 0.3) < 1e-6);
});

test('snapTime picks the nearest point inside the threshold', () => {
  assert.equal(M.snapTime(1.04, [0, 1, 2], 0.05), 1);
  assert.equal(M.snapTime(1.2, [0, 1, 2], 0.05), 1.2);
});

test('cutPoints returns sorted unique starts and ends', () => {
  const clips = [c(0, new Array(10).fill(0)), c(1, new Array(10).fill(0))];
  assert.deepEqual(M.cutPoints(clips, SR), [0, 1, 2]);
});

test('cutPoints uses the audible window of trimmed clips', () => {
  const src = c(0, new Array(10).fill(0));
  const trimmed = M.trimClip(M.trimClip(src, 'l', 0.2, SR), 'r', 0.7, SR);
  assert.deepEqual(M.cutPoints([trimmed], SR), [0, 0.2, 0.7]);
});

test('nextCut walks to the previous and next cut', () => {
  const points = [0, 1, 2.5];
  assert.equal(M.nextCut(points, 1, -1), 0);
  assert.equal(M.nextCut(points, 1, 1), 2.5);
  assert.equal(M.nextCut(points, 0, -1), null);
  assert.equal(M.nextCut(points, 2.5, 1), null);
});
