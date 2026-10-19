const path = require('path');

// Keep mic take names safe on Windows while leaving ordinary spaces/dashes alone.
function safeMicFileName(name, fallback = 'Mic recording') {
  let s = String(name == null ? '' : name)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .trim();
  if (!s) s = fallback;
  return s.slice(0, 80);
}

// First free "name.wav", then "name (2).wav", ... (never overwrite a take).
function uniqueFilePath(dir, base, ext, exists = () => false) {
  const e = ext.startsWith('.') ? ext : '.' + ext;
  let file = path.join(dir, base + e);
  let n = 2;
  while (exists(file)) file = path.join(dir, `${base} (${n++})${e}`);
  return file;
}

module.exports = { safeMicFileName, uniqueFilePath };
