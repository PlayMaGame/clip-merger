const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  normalizeKey,
  pathKey,
  effectKey,
  sanitizeLibrary,
  withRating,
  readLibrary,
} = require('../electron/library');

test('normalizes path keys for stable lookups', () => {
  assert.equal(pathKey(' E:\\Clips\\A.mp4 '), 'e:/clips/a.mp4');
  assert.equal(pathKey('E:/Clips/A.mp4/'), 'e:/clips/a.mp4');
  assert.equal(pathKey(''), '');
  assert.equal(effectKey('Zoom-In'), 'effect:zoom-in');
});

test('sanitizeLibrary keeps only integer 1-5 ratings under normalized keys', () => {
  const lib = sanitizeLibrary({
    ratings: {
      'E:\\Clips\\A.mp4': 3,
      'E:/Clips/B.mp4/': '5',
      zero: 0,
      high: 9,
      bad: 'no',
    },
  });
  assert.deepEqual(lib, {
    version: 1,
    ratings: { 'e:/clips/a.mp4': 3, 'e:/clips/b.mp4': 5 },
  });
});

test('sanitizeLibrary tolerates missing or malformed input', () => {
  assert.deepEqual(sanitizeLibrary(null), { version: 1, ratings: {} });
  assert.deepEqual(sanitizeLibrary({ ratings: [] }), { version: 1, ratings: {} });
});

test('withRating sets, clears, and never mutates the input', () => {
  const base = { version: 1, ratings: { 'e:/a.mp4': 2 } };
  const set = withRating(base, 'E:\\B.mp4', 4);
  assert.deepEqual(set.ratings, { 'e:/a.mp4': 2, 'e:/b.mp4': 4 });
  assert.deepEqual(base.ratings, { 'e:/a.mp4': 2 });
  const cleared = withRating(set, 'e:/b.mp4', 0);
  assert.deepEqual(cleared.ratings, { 'e:/a.mp4': 2 });
  assert.equal(withRating(base, 'e:/a.mp4', 9).ratings['e:/a.mp4'], 2);
});

test('readLibrary returns an empty library for missing or corrupt files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-library-'));
  try {
    const missing = path.join(dir, 'missing.json');
    assert.deepEqual(readLibrary(missing), { version: 1, ratings: {} });
    const corrupt = path.join(dir, 'bad.json');
    fs.writeFileSync(corrupt, '{not json');
    assert.deepEqual(readLibrary(corrupt), { version: 1, ratings: {} });
    const good = path.join(dir, 'good.json');
    fs.writeFileSync(good, JSON.stringify({ ratings: { 'C:\\X.mp4': 4 } }));
    assert.deepEqual(readLibrary(good), { version: 1, ratings: { 'c:/x.mp4': 4 } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
