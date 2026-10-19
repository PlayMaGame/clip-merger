const { run } = require('./encoders');

// Keyframes for a file are stable between edits, so cache them by path. Bounded
// FIFO — the export loop, IPC preview and anything else share one probe.
const kfCache = new Map();
const KF_CACHE_MAX = 500;

function parseRate(rate) {
  if (!rate || rate === '0/0') return 0;
  const [a, b] = rate.split('/').map(Number);
  return b ? a / b : a;
}

async function probe(ffprobePath, file) {
  const { out, code } = await run(ffprobePath, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ]);
  if (code !== 0) throw new Error('ffprobe failed for: ' + file);
  const data = JSON.parse(out);
  const v = (data.streams || []).find((s) => s.codec_type === 'video');
  const a = (data.streams || []).find((s) => s.codec_type === 'audio');
  return {
    path: file,
    duration: Number(data.format && data.format.duration) || (v && Number(v.duration)) || 0,
    width: v ? v.width : 0,
    height: v ? v.height : 0,
    fps: v ? parseRate(v.r_frame_rate) : 0,
    vcodec: v ? v.codec_name : null,
    acodec: a ? a.codec_name : null,
    audioSampleRate: a ? Number(a.sample_rate) || 0 : 0,
    audioChannels: a ? Number(a.channels) || 0 : 0,
    hasAudio: !!a,
  };
}

async function keyframes(ffprobePath, file, limit = 20000) {
  if (kfCache.has(file)) return kfCache.get(file);
  const { out } = await run(ffprobePath, [
    '-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey',
    '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file,
  ]);
  const times = [];
  for (const line of out.split(/\r?\n/)) {
    const t = parseFloat(line);
    if (!Number.isNaN(t)) times.push(t);
    if (times.length >= limit) break;
  }
  times.sort((a, b) => a - b);
  kfCache.set(file, times);
  if (kfCache.size > KF_CACHE_MAX) {
    const oldest = kfCache.keys().next().value;
    if (oldest !== undefined) kfCache.delete(oldest);
  }
  return times;
}

// True if `time` is within `tol` of any keyframe (times are sorted ascending).
function isKeyframe(time, kfs, tol = 0.05) {
  if (!kfs || !kfs.length) return false;
  let lo = 0, hi = kfs.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (kfs[mid] <= time) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (best >= 0 && Math.abs(kfs[best] - time) <= tol) return true;
  if (best + 1 < kfs.length && Math.abs(kfs[best + 1] - time) <= tol) return true;
  return false;
}

module.exports = { probe, keyframes, isKeyframe };
