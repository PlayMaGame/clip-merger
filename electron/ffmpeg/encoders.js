const { spawn } = require('child_process');

function run(bin, args) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (e) {
      resolve({ code: -1, out: '', err: String(e) });
      return;
    }
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => resolve({ code: -1, out, err: err + String(e) }));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

// Like run(), but captures stdout as a Buffer (for binary output).
function runRaw(bin, args) {
  return new Promise((resolve) => {
    const chunks = [];
    let err = '';
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (e) {
      resolve({ code: -1, buf: Buffer.alloc(0), err: String(e) });
      return;
    }
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => resolve({ code: -1, buf: Buffer.concat(chunks), err: err + String(e) }));
    child.on('close', (code) => resolve({ code, buf: Buffer.concat(chunks), err }));
  });
}

const CANDIDATES = [
  { id: 'h264_amf', label: 'AMD AMF', opts: ['-quality', 'balanced', '-rc', 'cqp', '-qp_i', '20', '-qp_p', '22'] },
  // constqp avoids the `-rc vbr -b:v 0` combo that makes NVENC throw
  // "Error while opening encoder" on several ffmpeg builds. `-tune hq` is
  // dropped too — it's invalid/deprecated on newer nvenc.
  { id: 'h264_nvenc', label: 'NVIDIA NVENC', opts: ['-preset', 'p5', '-rc', 'constqp', '-qp', '21'] },
  { id: 'libx264', label: 'CPU (libx264)', opts: ['-preset', 'medium', '-crf', '20'] },
];

async function detectEncoders(ffmpegPath, probeSize) {
  const { out } = await run(ffmpegPath, ['-hide_banner', '-encoders']);
  const found = [];
  for (const c of CANDIDATES) {
    if (out.includes(c.id)) found.push({ id: c.id, label: c.label, opts: c.opts });
  }
  if (!found.length) found.push(CANDIDATES[2]);
  // Verify each candidate at the real export geometry (so a hardware encoder that
  // can't do that resolution is never preferred), starting with the fastest.
  const size = probeSize || '1080x1920';
  for (const c of found) {
    const r = await run(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
      '-i', `color=c=black:s=${size}:d=0.1`, '-pix_fmt', 'yuv420p',
      '-c:v', c.id, ...c.opts, '-f', 'null', process.platform === 'win32' ? 'NUL' : '/dev/null',
    ]);
    if (r.code === 0) return { encoders: found, preferred: c.id };
  }
  return { encoders: found, preferred: 'libx264' };
}

module.exports = { run, runRaw, detectEncoders, CANDIDATES };
