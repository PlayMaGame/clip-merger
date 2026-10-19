const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomic } = require('../electron/fs-atomic');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clipmerger-atomic-'));
}

test('writeFileAtomic creates parent folders and writes the file', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'nested', 'project.json');
    writeFileAtomic(file, '{"a":1}');
    assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}');
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['project.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeFileAtomic replaces an existing file without leaving temp files', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'project.json');
    fs.writeFileSync(file, 'old');
    writeFileAtomic(file, 'new');
    assert.equal(fs.readFileSync(file, 'utf8'), 'new');
    assert.deepEqual(fs.readdirSync(dir), ['project.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeFileAtomic removes its temp file when the write cannot be committed', () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'project.json');
    fs.mkdirSync(file); // a directory cannot be replaced by the temp file
    assert.throws(() => writeFileAtomic(file, 'data'));
    assert.deepEqual(fs.readdirSync(dir), ['project.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
