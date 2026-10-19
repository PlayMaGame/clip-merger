const test = require('node:test');
const assert = require('node:assert');
const MicWav = require('../renderer/mic-wav.js');

function text(buf, start, len) {
  return buf.toString('ascii', start, start + len);
}

test('encodeWav writes a mono 16-bit PCM header and samples', () => {
  const wav = MicWav.encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1]), 48000);
  const buf = Buffer.from(wav);
  assert.equal(buf.length, 44 + 10);
  assert.equal(text(buf, 0, 4), 'RIFF');
  assert.equal(buf.readUInt32LE(4), 36 + 10);
  assert.equal(text(buf, 8, 4), 'WAVE');
  assert.equal(text(buf, 12, 4), 'fmt ');
  assert.equal(buf.readUInt32LE(16), 16);
  assert.equal(buf.readUInt16LE(20), 1); // PCM
  assert.equal(buf.readUInt16LE(22), 1); // mono
  assert.equal(buf.readUInt32LE(24), 48000);
  assert.equal(buf.readUInt32LE(28), 96000); // byte rate
  assert.equal(buf.readUInt16LE(32), 2); // block align
  assert.equal(buf.readUInt16LE(34), 16); // bits
  assert.equal(text(buf, 36, 4), 'data');
  assert.equal(buf.readUInt32LE(40), 10);
  assert.equal(buf.readInt16LE(44), 0);
  assert.equal(buf.readInt16LE(46), 16384); // round(0.5 * 32767)
  assert.equal(buf.readInt16LE(48), -16384); // -0.5 * 32768
  assert.equal(buf.readInt16LE(50), 32767);
  assert.equal(buf.readInt16LE(52), -32768);
});

test('encodeWav clamps out-of-range floats and accepts an empty take', () => {
  const buf = Buffer.from(MicWav.encodeWav(new Float32Array([2, -2]), 48000));
  assert.equal(buf.readInt16LE(44), 32767);
  assert.equal(buf.readInt16LE(46), -32768);
  const empty = Buffer.from(MicWav.encodeWav(new Float32Array(0), 48000));
  assert.equal(empty.length, 44);
  assert.equal(empty.readUInt32LE(40), 0);
});

test('mixSamples overwrites in place and grows when writing past the end', () => {
  const dest = new Float32Array([1, 2, 3, 4]);
  const same = MicWav.mixSamples(dest, new Float32Array([9, 8]), 1);
  assert.equal(same, dest);
  assert.deepEqual([...same], [1, 9, 8, 4]);

  const grown = MicWav.mixSamples(dest, new Float32Array([5, 6]), 4);
  assert.notEqual(grown, dest);
  assert.deepEqual([...grown], [1, 9, 8, 4, 5, 6]);
  assert.deepEqual([...dest], [1, 9, 8, 4]); // original untouched
});

test('trimSamples clamps its range', () => {
  const s = new Float32Array([0, 1, 2, 3, 4]);
  assert.deepEqual([...MicWav.trimSamples(s, 1, 4)], [1, 2, 3]);
  assert.deepEqual([...MicWav.trimSamples(s, -2, 99)], [0, 1, 2, 3, 4]);
  assert.deepEqual([...MicWav.trimSamples(s, 3, 1)], []);
});

test('stampName is filesystem-safe and stable', () => {
  const d = new Date(2026, 9, 19, 14, 32, 5);
  assert.equal(MicWav.stampName(d), 'Mic 2026-10-19 14-32-05');
});
