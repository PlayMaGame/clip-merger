const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildPlan, applyPlan } = require('../electron/purge-media');

function mkTmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cm-purge-')); }
function write(p, data) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); }

function setup() {
  const root = mkTmp();
  const base = path.join(root, 'Media');
  const out = path.join(root, 'Output');
  fs.mkdirSync(base, { recursive: true });
  fs.mkdirSync(out, { recursive: true });
  // Two media files referenced by the project, one unreferenced file, one subfolder.
  const a = path.join(base, 'a.mp4');
  const b = path.join(base, 'sub', 'b.mp4');
  const unused = path.join(base, 'unused.mp4');
  write(a, 'AAAA');
  write(b, 'BB');
  write(unused, 'UNUSED');
  // An output artifact that must never be touched.
  const exported = path.join(out, 'merged.mp4');
  write(exported, 'OUT');
  // A transition outside the Media folder that the project also references.
  const transition = path.join(root, 'TRANSITIONS', 't.mp4');
  write(transition, 'T');
  const project = path.join(out, 'proj.json');
  write(project, JSON.stringify({
    version: 5,
    timeline: [{ id: '1', path: a }, { id: '2', path: transition }],
    soundboard: [{ id: '3', path: b }],
    hybrid: [],
    markers: [],
  }, null, 2));
  return { root, base, out, a, b, unused, exported, transition, project };
}

test('buildPlan finds only project-referenced media under the base folder', () => {
  const { base, out, a, b, unused, exported, transition } = setup();
  const p = buildPlan({ outputDir: out, baseDir: base, extSet: new Set(['.mp4']) });
  assert.equal(p.ok, true);
  const names = p.files.map((f) => path.basename(f.path)).sort();
  assert.deepEqual(names, ['a.mp4', 'b.mp4']);
  assert.equal(p.files.length, 2);
  // Nothing is moved by a plan.
  assert.ok(fs.existsSync(a) && fs.existsSync(b));
  assert.ok(fs.existsSync(unused) && fs.existsSync(exported) && fs.existsSync(transition));
  assert.equal(p.projects.length, 1);
});

test('applyPlan moves referenced media flat into Purged and repoints the save', () => {
  const { base, out, a, b, exported, transition, project } = setup();
  const plan = buildPlan({ outputDir: out, baseDir: base, extSet: new Set(['.mp4']) });
  const res = applyPlan(plan);

  assert.equal(res.moved.length, 2);
  assert.equal(res.updatedProjects.length, 1);
  assert.equal(res.failed.length, 0);

  // Originals gone; copies live flat in Purged.
  assert.ok(!fs.existsSync(a));
  assert.ok(!fs.existsSync(b));
  const purgeDir = path.join(out, 'Purged');
  assert.ok(fs.existsSync(path.join(purgeDir, 'a.mp4')));
  assert.ok(fs.existsSync(path.join(purgeDir, 'b.mp4')));
  // Output artifact + transition untouched.
  assert.ok(fs.existsSync(exported) && fs.existsSync(transition));

  const saved = JSON.parse(fs.readFileSync(project, 'utf8'));
  assert.equal(saved.timeline[0].path, path.join(purgeDir, 'a.mp4'));
  assert.equal(saved.timeline[1].path, transition); // untouched reference
  assert.equal(saved.soundboard[0].path, path.join(purgeDir, 'b.mp4'));
});

test('name clashes get a numbered suffix instead of clobbering', () => {
  const root = mkTmp();
  const base = path.join(root, 'Media');
  const out = path.join(root, 'Output');
  // Two different files that share a basename in different subfolders.
  write(path.join(base, 'x', 'dup.mp4'), 'ONE');
  write(path.join(base, 'y', 'dup.mp4'), 'TWO');
  const project = path.join(out, 'proj.json');
  write(project, JSON.stringify({
    version: 5,
    timeline: [
      { id: '1', path: path.join(base, 'x', 'dup.mp4') },
      { id: '2', path: path.join(base, 'y', 'dup.mp4') },
    ],
  }, null, 2));

  const plan = buildPlan({ outputDir: out, baseDir: base, extSet: new Set(['.mp4']) });
  const dests = plan.files.map((f) => path.basename(f.dest)).sort();
  assert.deepEqual(dests, ['dup (2).mp4', 'dup.mp4']);

  applyPlan(plan);
  const purgeDir = path.join(out, 'Purged');
  assert.ok(fs.existsSync(path.join(purgeDir, 'dup.mp4')));
  assert.ok(fs.existsSync(path.join(purgeDir, 'dup (2).mp4')));
});

test('missing folders return a friendly error', () => {
  const p = buildPlan({ outputDir: 'Z:\\nope\\out', baseDir: 'Z:\\nope\\media', extSet: new Set(['.mp4']) });
  assert.equal(p.ok, false);
  assert.match(p.error, /not found/i);
});

test('non-project json files are ignored', () => {
  const root = mkTmp();
  const base = path.join(root, 'Media');
  const out = path.join(root, 'Output');
  const f = path.join(base, 'clip.mp4');
  write(f, 'X');
  write(path.join(out, 'random.json'), JSON.stringify({ hello: 'world', path: f }));
  const p = buildPlan({ outputDir: out, baseDir: base, extSet: new Set(['.mp4']) });
  assert.equal(p.files.length, 0);
  assert.equal(p.projects.length, 0);
});
