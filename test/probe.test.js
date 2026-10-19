const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isKeyframe } = require('../electron/ffmpeg/probe');

test('isKeyframe finds exact and near-in-tol keyframes', () => {
  const kfs = [0, 5, 10, 20];
  assert.equal(isKeyframe(5, kfs), true);
  assert.equal(isKeyframe(5.02, kfs, 0.05), true);
  assert.equal(isKeyframe(0, kfs), true);
  assert.equal(isKeyframe(20, kfs), true);
});

test('isKeyframe rejects times outside the tolerance', () => {
  const kfs = [0, 5, 10, 20];
  assert.equal(isKeyframe(5.1, kfs, 0.05), false);
  assert.equal(isKeyframe(-1, kfs, 0.05), false);
  assert.equal(isKeyframe(25, kfs, 0.05), false);
  assert.equal(isKeyframe(4.95, kfs, 0.05), true); // just inside the window
});

test('isKeyframe handles empty input', () => {
  assert.equal(isKeyframe(1, []), false);
  assert.equal(isKeyframe(1, null), false);
});