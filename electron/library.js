const fs = require('fs');

// Favorites metadata lives in the app's userData folder. Keys are normalized so
// a path typed with forward slashes, backslashes, a trailing slash, or different
// case still resolves to the same rating on every platform.
function normalizeKey(key) {
  return String(key == null ? '' : key)
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function pathKey(file) {
  return normalizeKey(file);
}

function effectKey(id) {
  return normalizeKey('effect:' + String(id == null ? '' : id).trim());
}

function emptyLibrary() {
  return { version: 1, ratings: {} };
}

function sanitizeLibrary(raw) {
  const out = emptyLibrary();
  const ratings = raw && raw.ratings && typeof raw.ratings === 'object' && !Array.isArray(raw.ratings)
    ? raw.ratings
    : {};
  for (const [key, value] of Object.entries(ratings)) {
    const k = normalizeKey(key);
    const n = Math.round(Number(value));
    if (k && Number.isFinite(n) && n >= 1 && n <= 5) out.ratings[k] = n;
  }
  return out;
}

function withRating(library, key, stars) {
  const base = sanitizeLibrary(library);
  const k = normalizeKey(key);
  const n = Math.round(Number(stars));
  const next = { version: 1, ratings: { ...base.ratings } };
  if (!k) return next;
  if (Number.isFinite(n) && n >= 1 && n <= 5) next.ratings[k] = n;
  else if (n === 0) delete next.ratings[k];
  return next;
}

function readLibrary(file) {
  try {
    return sanitizeLibrary(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (_) {
    return emptyLibrary();
  }
}

module.exports = {
  normalizeKey,
  pathKey,
  effectKey,
  emptyLibrary,
  sanitizeLibrary,
  withRating,
  readLibrary,
};
