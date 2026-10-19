const fs = require('fs');
const path = require('path');

/* Planning/moving helpers for "purge used media": move source Media files that
   any saved project references into <outputDir>/Purged (flat) and repoint the
   saves. Pure of Electron so it can be unit-tested and dry-run independently. */

function walkFiles(dir, skipDirs, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (skipDirs && skipDirs.has(ent.name.toLowerCase())) continue;
      walkFiles(full, skipDirs, out);
    } else if (ent.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function normAbs(p) {
  try { return path.resolve(String(p)).toLowerCase(); } catch (_) { return String(p).toLowerCase(); }
}

// Every media path a project object references (timeline clips, soundboard
// sounds, and CLIPS2 hybrid items of both kinds).
function projectPaths(obj) {
  const out = [];
  for (const key of ['timeline', 'soundboard', 'hybrid']) {
    const arr = obj && obj[key];
    if (Array.isArray(arr)) for (const it of arr) if (it && typeof it.path === 'string' && it.path) out.push(it.path);
  }
  return out;
}

// A unique destination inside `dir`, adding " (2)", " (3)" … on a clash with an
// existing file or an earlier entry in the same plan (`taken`).
function uniqueDest(dir, name, taken) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  let n = 2;
  while (taken.has(normAbs(candidate)) || fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
    n += 1;
  }
  taken.add(normAbs(candidate));
  return candidate;
}

// Read every project under outputDir (skipping the Purged dir) and find the
// Media files under baseDir they reference. Never moves or deletes anything.
function buildPlan({ outputDir, baseDir, extSet }) {
  if (!outputDir || !baseDir) return { ok: false, error: 'Set both the Output and Media folders in Settings first.' };
  if (!fs.existsSync(outputDir)) return { ok: false, error: 'Output folder not found: ' + outputDir };
  if (!fs.existsSync(baseDir)) return { ok: false, error: 'Media folder not found: ' + baseDir };

  const purgeDir = path.join(outputDir, 'Purged');

  const projectFiles = walkFiles(outputDir, new Set(['purged']), []).filter((p) => /\.(json|llc)$/i.test(p));
  const refs = new Set();
  const projects = [];
  for (const pf of projectFiles) {
    let obj;
    try { obj = JSON.parse(fs.readFileSync(pf, 'utf8')); } catch (_) { continue; }
    if (!obj || !Array.isArray(obj.timeline)) continue; // not a Clip Merger project
    projects.push({ file: pf, obj });
    for (const p of projectPaths(obj)) refs.add(normAbs(p));
  }

  const targets = [];
  let totalSize = 0;
  for (const f of walkFiles(baseDir, null, [])) {
    if (extSet && extSet.size && !extSet.has(path.extname(f).toLowerCase())) continue;
    if (!refs.has(normAbs(f))) continue;
    let size = 0;
    try { size = fs.statSync(f).size; } catch (_) {}
    targets.push({ path: f, name: path.basename(f), size });
    totalSize += size;
  }
  const taken = new Set();
  const files = targets.map((t) => ({ ...t, dest: uniqueDest(purgeDir, t.name, taken) }));

  return { ok: true, purgeDir, refs: refs.size, files, totalSize, projects };
}

// Move each planned file into Purged and rewrite the `path` of every affected
// project. Returns what moved / which saves changed / what failed.
function applyPlan(plan) {
  const { purgeDir, files, projects } = plan;
  try { fs.mkdirSync(purgeDir, { recursive: true }); } catch (_) {}

  const remap = new Map(); // oldNorm -> new absolute path
  const moved = [];
  const failed = [];
  for (const item of files) {
    try {
      try { fs.renameSync(item.path, item.dest); }
      catch (_) { fs.copyFileSync(item.path, item.dest); fs.rmSync(item.path, { force: true }); }
      remap.set(normAbs(item.path), item.dest);
      moved.push({ path: item.path, dest: item.dest, name: item.name, size: item.size });
    } catch (e) {
      failed.push({ path: item.path, error: String(e && e.message ? e.message : e) });
    }
  }

  const updatedProjects = [];
  for (const p of projects) {
    let changed = false;
    for (const key of ['timeline', 'soundboard', 'hybrid']) {
      const arr = p.obj && p.obj[key];
      if (!Array.isArray(arr)) continue;
      for (const it of arr) {
        if (!it || typeof it.path !== 'string') continue;
        const np = remap.get(normAbs(it.path));
        if (np) { it.path = np; changed = true; }
      }
    }
    if (!changed) continue;
    try { fs.writeFileSync(p.file, JSON.stringify(p.obj, null, 2), 'utf8'); updatedProjects.push(p.file); }
    catch (e) { failed.push({ path: p.file, error: String(e && e.message ? e.message : e) }); }
  }

  return { moved, updatedProjects, failed };
}

module.exports = { walkFiles, normAbs, projectPaths, uniqueDest, buildPlan, applyPlan };
