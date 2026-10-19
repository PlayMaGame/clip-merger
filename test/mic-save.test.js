const test = require('node:test');
const assert = require('node:assert');
const { safeMicFileName, uniqueFilePath } = require('../electron/mic-save.js');

test('safeMicFileName strips path and reserved characters', () => {
  assert.equal(safeMicFileName('take 01'), 'take 01');
  assert.equal(safeMicFileName('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j');
  assert.equal(safeMicFileName('  ...hello...  '), 'hello');
  assert.equal(safeMicFileName(''), 'Mic recording');
  assert.equal(safeMicFileName('   '), 'Mic recording');
  assert.equal(safeMicFileName('x'.repeat(120)).length, 80);
});

test('uniqueFilePath adds a numbered suffix instead of overwriting', () => {
  const exists = new Set(['a.wav', 'a (2).wav']);
  const has = (p) => exists.has(p.split(/[\\/]/).pop());
  assert.equal(uniqueFilePath('dir', 'a', '.wav', has), 'dir\\a (3).wav');
  assert.equal(uniqueFilePath('dir', 'b', '.wav', has), 'dir\\b.wav');
});
