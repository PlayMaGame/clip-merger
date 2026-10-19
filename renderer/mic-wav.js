/* Tiny mono PCM helpers for the mic recorder. UMD so node:test can load it. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MicWav = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function floatTo16(v) {
    const x = Math.max(-1, Math.min(1, Number(v) || 0));
    return x < 0 ? Math.round(x * 0x8000) : Math.round(x * 0x7fff);
  }

  // 44-byte PCM WAV header + interleaved mono 16-bit samples.
  function encodeWav(samples, sampleRate) {
    const s = samples || new Float32Array(0);
    const n = s.length;
    const bytes = n * 2;
    const ab = new ArrayBuffer(44 + bytes);
    const dv = new DataView(ab);
    const ascii = (off, str) => { for (let i = 0; i < str.length; i++) dv.setUint8(off + i, str.charCodeAt(i)); };
    ascii(0, 'RIFF');
    dv.setUint32(4, 36 + bytes, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); // PCM
    dv.setUint16(22, 1, true); // mono
    dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * 2, true);
    dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true);
    ascii(36, 'data');
    dv.setUint32(40, bytes, true);
    for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, floatTo16(s[i]), true);
    return ab;
  }

  // Write chunk into dest at offset, growing (and copying) only when needed.
  function mixSamples(dest, chunk, offset) {
    const at = Math.max(0, Math.floor(offset || 0));
    const need = at + chunk.length;
    let out = dest;
    if (need > dest.length) {
      out = new Float32Array(need);
      out.set(dest.subarray(0, Math.min(dest.length, need)));
    }
    out.set(chunk, at);
    return out;
  }

  function trimSamples(samples, start, end) {
    const a = Math.max(0, Math.min(samples.length, Math.floor(start || 0)));
    const b = Math.max(a, Math.min(samples.length, Math.floor(end == null ? samples.length : end)));
    return samples.slice(a, b);
  }

  function stampName(d) {
    const dt = d || new Date();
    const p = (n) => String(n).padStart(2, '0');
    return 'Mic ' + dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate()) +
      ' ' + p(dt.getHours()) + '-' + p(dt.getMinutes()) + '-' + p(dt.getSeconds());
  }

  return { encodeWav, mixSamples, trimSamples, stampName, floatTo16 };
});
