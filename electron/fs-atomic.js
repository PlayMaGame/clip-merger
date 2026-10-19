const fs = require('fs');
const path = require('path');

// Write to a sibling temp file, then rename over the destination. Rename is
// atomic on a single volume, so a crash/full disk can only leave the old file
// intact (plus a temp file), never a half-written project.
function writeFileAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir,
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* already gone */ }
    throw err;
  }
}

module.exports = { writeFileAtomic };
