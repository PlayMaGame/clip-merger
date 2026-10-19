const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isKeyframe, keyframes } = require('../electron/ffmpeg/probe');

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

test('keyframes cache invalidates when the source file changes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipmerger-kf-'));
  const file = path.join(dir, 'clip.mp4');
  try {
    fs.writeFileSync(file, 'a');
    let calls = 0;
    const fakeRun = async () => {
      calls += 1;
      return { code: 0, out: calls === 1 ? '0\n2\n' : '0\n1\n3\n' };
    };

    assert.deepEqual(await keyframes('ffprobe', file, 20000, fakeRun), [0, 2]);
    assert.deepEqual(await keyframes('ffprobe', file, 20000, fakeRun), [0, 2]);
    assert.equal(calls, 1);

    fs.writeFileSync(file, 'changed-size'); // same path, new size/mtime
    assert.deepEqual(await keyframes('ffprobe', file, 20000, fakeRun), [0, 1, 3]);
    assert.equal(calls, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});