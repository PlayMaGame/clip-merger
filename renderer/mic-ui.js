/* ---------------- mic recorder: compact audio-only timeline ----------------
   A small clone of the main timeline: ruler, one audio lane (MAIN), playhead,
   drag/trim/split/delete, zoom, fit, snap, undo/redo, a jog/shuttle bar and the
   main timeline's shortcuts. Save mixes the lane into one WAV. */
(function () {
  'use strict';

  const MM = window.MicModel;
  const MW = window.MicWav;
  if (!MM || !MW) return;

  const GUTTER = 38;       // px reserved for lane labels on the left
  const EDGE_PX = 6;       // trim hit zone
  const SNAP_PX = 8;
  const MAX_HISTORY = 80;
  const MAX_WAVE_GAIN = 8; // quiet takes are amplified visually up to 8x
  const TICK_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];

  const mic = {
    ctx: null, stream: null, source: null, processor: null, sink: null,
    sampleRate: 48000,
    tracks: { main: [] },
    activeTrack: 'main',
    selectedIds: new Set(),
    playhead: 0,
    recording: false,
    recChunks: [], recLen: 0, recStart: 0, recTrack: 'main', recUndo: null, recPeak: 0,
    playing: false, playNodes: [], playStartCtx: 0, playStartPos: 0, playEnd: 0,
    pps: 90, offset: 0,
    snap: true,
    raf: 0,
    saved: true,
    drag: null,
    history: [], redo: [],
    wired: false,
  };
  let micIdCounter = 0;
  let micLastDown = { key: null, t: 0 };
  const micScaleCache = new WeakMap();

  const mq = (sel) => document.querySelector(sel);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const MIC_MIN_LEN = MM.MIN_LEN;

  function micNewId() { micIdCounter += 1; return 'm' + micIdCounter; }
  function micClips() { return [...mic.tracks.main]; }
  function micEnd() { return MM.takesEnd(micClips(), mic.sampleRate); }
  function micContentEnd() {
    return Math.max(micEnd(), mic.recording ? mic.recStart + mic.recLen / mic.sampleRate : 0);
  }
  function micFind(id) {
    const clip = mic.tracks.main.find((c) => c.id === id);
    return clip ? { clip, track: 'main' } : null;
  }
  function micReplace(clip) {
    const arr = mic.tracks[clip.track] || mic.tracks.main;
    const i = arr.findIndex((c) => c.id === clip.id);
    if (i >= 0) arr[i] = clip;
  }
  function micRemove(id) {
    mic.tracks.main = mic.tracks.main.filter((c) => c.id !== id);
  }
  function micSort() {
    mic.tracks.main.sort((a, b) => a.start - b.start);
  }
  function micMarkDirty() { mic.saved = false; }
  function micClipAt(track, t) {
    const clips = mic.tracks[track];
    for (let i = clips.length - 1; i >= 0; i--) {
      const c = clips[i];
      if (t >= c.start - 1e-6 && t <= MM.clipEnd(c, mic.sampleRate) + 1e-6) return c;
    }
    return null;
  }
  function micSnapPoints(excludeId) {
    const points = MM.cutPoints(micClips().filter((c) => c.id !== excludeId), mic.sampleRate);
    points.push(0, mic.playhead);
    return [...new Set(points)].sort((a, b) => a - b);
  }

  /* ---- history ---- */
  function micSnapshot() {
    return {
      tracks: { main: mic.tracks.main.slice() },
      selected: [...mic.selectedIds],
      activeTrack: mic.activeTrack,
      playhead: mic.playhead,
    };
  }
  function micRestore(s) {
    if (!s) return;
    mic.tracks = { main: s.tracks.main.slice() };
    mic.selectedIds = new Set(s.selected || []);
    mic.activeTrack = s.activeTrack || 'main';
    mic.playhead = Math.max(0, s.playhead || 0);
    mic.saved = false;
    micUpdateUI();
    micDraw();
  }
  function micPushHistory(s) {
    if (!s) return;
    mic.history.push(s);
    if (mic.history.length > MAX_HISTORY) mic.history.shift();
    mic.redo = [];
  }
  function micUndo() {
    if (mic.recording) micFinishRecord();
    if (!mic.history.length) return;
    micStopPlay();
    mic.redo.push(micSnapshot());
    micRestore(mic.history.pop());
  }
  function micRedo() {
    if (!mic.redo.length) return;
    micStopPlay();
    mic.history.push(micSnapshot());
    micRestore(mic.redo.pop());
  }

  /* ---- audio context / capture ---- */
  function micEnsureCtx() {
    if (mic.ctx) return mic.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('Audio capture is not available');
    try { mic.ctx = new AC({ sampleRate: 48000, latencyHint: 'interactive' }); }
    catch (_) { mic.ctx = new AC(); }
    mic.sampleRate = mic.ctx.sampleRate;
    return mic.ctx;
  }

  function micReset() {
    mic.tracks = { main: [] };
    mic.activeTrack = 'main';
    mic.selectedIds = new Set();
    mic.playhead = 0;
    mic.recording = false;
    mic.recChunks = [];
    mic.recLen = 0;
    mic.recStart = 0;
    mic.recTrack = 'main';
    mic.recUndo = null;
    mic.recPeak = 0;
    mic.playing = false;
    mic.playNodes = [];
    mic.pps = 90;
    mic.offset = 0;
    mic.saved = true;
    mic.drag = null;
    mic.history = [];
    mic.redo = [];
  }

  async function micStartCapture() {
    if (mic.stream) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Microphone access is not available');
    }
    const ctx = micEnsureCtx();
    if (ctx.state === 'suspended') await ctx.resume();
    mic.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: mic.sampleRate,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    mic.source = ctx.createMediaStreamSource(mic.stream);
    mic.processor = ctx.createScriptProcessor(2048, 1, 1);
    mic.processor.onaudioprocess = (ev) => {
      if (!mic.recording) return;
      const input = ev.inputBuffer.getChannelData(0);
      const chunk = new Float32Array(input.length);
      chunk.set(input);
      mic.recChunks.push(chunk);
      mic.recLen += chunk.length;
      for (let i = 0; i < chunk.length; i++) {
        const v = Math.abs(chunk[i]);
        if (v > mic.recPeak) mic.recPeak = v;
      }
      mic.playhead = mic.recStart + mic.recLen / mic.sampleRate;
    };
    mic.sink = ctx.createGain();
    mic.sink.gain.value = 0;
    mic.source.connect(mic.processor);
    mic.processor.connect(mic.sink);
    mic.sink.connect(ctx.destination);
  }

  function micStopCapture() {
    mic.recording = false;
    try { if (mic.processor) mic.processor.disconnect(); } catch (_) {}
    try { if (mic.source) mic.source.disconnect(); } catch (_) {}
    try { if (mic.sink) mic.sink.disconnect(); } catch (_) {}
    try { if (mic.stream) mic.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    mic.processor = null;
    mic.source = null;
    mic.sink = null;
    mic.stream = null;
  }

  async function micToggleRecord() {
    if (mic.recording) { micFinishRecord(); return; }
    if (mic.playing) micStopPlay();
    mic.recStart = Math.max(0, mic.playhead);
    mic.recTrack = mic.activeTrack;
    mic.recChunks = [];
    mic.recLen = 0;
    mic.recPeak = 0;
    mic.recUndo = micSnapshot();
    try { await micStartCapture(); }
    catch (e) {
      mic.recUndo = null;
      toast('Microphone unavailable: ' + (e && e.message ? e.message : e), { danger: true });
      return;
    }
    mic.recording = true;
    mic.saved = false;
    micUpdateUI();
    micDraw();
    micLoop();
    setStatus('Recording… click Stop to finish');
  }

  function micFinishRecord() {
    if (!mic.recording) return;
    micStopCapture();
    const sr = mic.sampleRate;
    const total = mic.recChunks.reduce((n, c) => n + c.length, 0);
    if (!total) {
      mic.recChunks = [];
      mic.recLen = 0;
      mic.recUndo = null;
      micUpdateUI();
      micDraw();
      return;
    }
    const samples = new Float32Array(total);
    let off = 0;
    for (const chunk of mic.recChunks) { samples.set(chunk, off); off += chunk.length; }
    const start = mic.recStart;
    const end = start + samples.length / sr;
    if (mic.recUndo) micPushHistory(mic.recUndo);
    const track = mic.recTrack;
    const clips = MM.punchTrack(mic.tracks[track], start, end, sr, micNewId);
    const clip = { id: micNewId(), track, start, samples };
    clips.push(clip);
    clips.sort((a, b) => a.start - b.start);
    mic.tracks[track] = clips;
    mic.selectedIds = new Set([clip.id]);
    mic.activeTrack = track;
    mic.playhead = end;
    mic.saved = false;
    mic.recChunks = [];
    mic.recLen = 0;
    mic.recPeak = 0;
    mic.recUndo = null;
    micUpdateUI();
    micDraw();
    setStatus(`Recorded ${(samples.length / sr).toFixed(2)}s`);
  }

  /* ---- playback ---- */
  function micStopPlay() {
    for (const node of mic.playNodes) { try { node.stop(); } catch (_) {} }
    mic.playNodes = [];
    mic.playing = false;
  }

  async function micTogglePlay() {
    if (mic.recording) micFinishRecord();
    if (mic.playing) {
      micStopPlay();
      micUpdateUI();
      micDraw();
      return;
    }
    const sr = mic.sampleRate;
    if (micEnd() <= 0) return;
    let start = mic.playhead;
    if (start < 0 || start >= micEnd() - 1e-4) start = 0;
    const ctx = micEnsureCtx();
    if (ctx.state === 'suspended') await ctx.resume();
    micStopPlay();
    const t0 = ctx.currentTime + 0.03;
    let end = start;
    for (const clip of micClips()) {
      const cEnd = MM.clipEnd(clip, sr);
      if (cEnd <= start + 1e-6) continue;
      const from = Math.max(start, clip.start);
      const offset = from - clip.start;
      const dur = cEnd - from;
      if (dur <= 1e-4) continue;
      const buf = ctx.createBuffer(1, clip.samples.length, sr);
      buf.copyToChannel(clip.samples, 0);
      const node = ctx.createBufferSource();
      node.buffer = buf;
      node.connect(ctx.destination);
      node.start(t0 + (from - start), offset, dur);
      mic.playNodes.push(node);
      if (cEnd > end) end = cEnd;
    }
    mic.playStartCtx = t0;
    mic.playStartPos = start;
    mic.playEnd = end;
    mic.playing = true;
    mic.playhead = start;
    micUpdateUI();
    micDraw();
    micLoop();
  }

  function micStopTake() {
    if (mic.recording) micFinishRecord();
    micStopPlay();
    micUpdateUI();
    micDraw();
  }

  function micLoop() {
    if (mic.raf) { cancelAnimationFrame(mic.raf); mic.raf = 0; }
    const tick = () => {
      const modal = mq('#mic-modal');
      if (!modal || modal.classList.contains('hidden')) { mic.raf = 0; return; }
      if (mic.playing && mic.ctx) {
        mic.playhead = mic.playStartPos + Math.max(0, mic.ctx.currentTime - mic.playStartCtx);
        if (mic.playhead >= mic.playEnd - 1e-4) {
          mic.playhead = mic.playEnd;
          micStopPlay();
        } else {
          micEnsureVisible(mic.playhead);
        }
      }
      if (mic.recording) micEnsureVisible(mic.playhead);
      micUpdateUI();
      micDraw();
      mic.raf = (mic.playing || mic.recording) ? requestAnimationFrame(tick) : 0;
    };
    tick();
  }

  /* ---- view math ---- */
  function micMiniWidth() {
    const mini = mq('#mic-mini');
    return mini ? mini.clientWidth : 0;
  }
  function micViewWidth() { return Math.max(1, micMiniWidth() - GUTTER - 8); }
  function micViewDur() { return micViewWidth() / mic.pps; }
  function micXAt(t) { return GUTTER + (t - mic.offset) * mic.pps; }
  function micTimeAtX(clientX) {
    const mini = mq('#mic-mini');
    if (!mini) return 0;
    const r = mini.getBoundingClientRect();
    return Math.max(0, mic.offset + (clientX - r.left - GUTTER) / mic.pps);
  }
  function micOffsetMax() {
    const end = Math.max(micContentEnd(), mic.playhead, 0);
    return Math.max(0, end + 0.4 - micViewDur());
  }
  function micClampOffset() {
    mic.offset = clamp(mic.offset, 0, micOffsetMax());
  }
  function micEnsureVisible(t) {
    const w = micMiniWidth();
    if (!w) return;
    const dur = (w - GUTTER - 8) / mic.pps;
    const x = micXAt(t);
    if (x > w - 14) mic.offset = t - (dur - 18 / mic.pps);
    else if (x < GUTTER + 10) mic.offset = t - 10 / mic.pps;
    mic.offset = Math.max(0, mic.offset);
    micClampOffset();
  }
  function micFit() {
    const span = Math.max(4, Math.max(micContentEnd(), mic.playhead) + 0.5);
    mic.pps = clamp((micViewWidth() - 8) / span, 10, 3000);
    mic.offset = 0;
    micUpdateUI();
    micDraw();
  }

  /* ---- drawing ---- */
  function micCanvasSize(canvas) {
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, w: rect.width, h: rect.height };
  }

  function micRoundRect(g, x, y, w, h, r) {
    const rr = Math.min(r, Math.max(0, Math.min(w, h) / 2));
    g.beginPath();
    g.moveTo(x + rr, y);
    g.arcTo(x + w, y, x + w, y + h, rr);
    g.arcTo(x + w, y + h, x, y + h, rr);
    g.arcTo(x, y + h, x, y, rr);
    g.arcTo(x, y, x + w, y, rr);
    g.closePath();
  }

  function micFmtTick(t, step) {
    if (t < 0) t = 0;
    if (step < 1) return t.toFixed(2);
    if (t >= 60) {
      const m = Math.floor(t / 60);
      const s = Math.floor(t % 60);
      return `${m}:${String(s).padStart(2, '0')}`;
    }
    return `${Math.round(t)}s`;
  }

  function micDrawRuler() {
    const setup = micCanvasSize(mq('#mic-ruler-canvas'));
    if (!setup) return;
    const { g, w, h } = setup;
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,.025)';
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(0,0,0,.16)';
    g.fillRect(0, 0, GUTTER, h);
    const viewDur = (w - GUTTER - 8) / mic.pps;
    const step = TICK_STEPS.find((s) => s * mic.pps >= 58) || TICK_STEPS[TICK_STEPS.length - 1];
    const first = Math.floor(mic.offset / step) * step;
    g.font = '10px sans-serif';
    g.textBaseline = 'middle';
    g.textAlign = 'left';
    for (let t = first; t <= mic.offset + viewDur + step; t += step) {
      const x = micXAt(t);
      if (x < GUTTER - 1 || x > w) continue;
      g.strokeStyle = 'rgba(255,255,255,.18)';
      g.beginPath(); g.moveTo(x, h - 7); g.lineTo(x, h); g.stroke();
      g.fillStyle = 'rgba(255,255,255,.55)';
      g.fillText(micFmtTick(t, step), x + 3, h / 2 + 1);
      const half = x + (step * mic.pps) / 2;
      if (step * mic.pps >= 24 && half < w) {
        g.strokeStyle = 'rgba(255,255,255,.1)';
        g.beginPath(); g.moveTo(half, h - 4); g.lineTo(half, h); g.stroke();
      }
    }
    g.strokeStyle = 'rgba(255,255,255,.1)';
    g.beginPath(); g.moveTo(0, h - 0.5); g.lineTo(w, h - 0.5); g.stroke();
  }

  function micClipPeak(clip, t0, t1) {
    const data = MM.clipSamples(clip);
    const sr = mic.sampleRate;
    const a = Math.max(0, Math.floor((t0 - clip.start) * sr));
    const b = Math.min(data.length, Math.ceil((t1 - clip.start) * sr));
    if (b <= a) return 0;
    const step = Math.max(1, Math.floor((b - a) / 12));
    let peak = 0;
    for (let i = a; i < b; i += step) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
    return peak;
  }

  // Amplify quiet takes visually so their waveform fills the lane. The gain is
  // per source take (cached on the sample array), so split halves match exactly.
  function micClipGain(clip) {
    const data = clip.samples;
    let gain = micScaleCache.get(data);
    if (gain == null) {
      let peak = 0;
      const step = Math.max(1, Math.floor(data.length / 4000));
      for (let i = 0; i < data.length; i += step) {
        const v = Math.abs(data[i]);
        if (v > peak) peak = v;
      }
      gain = Math.min(MAX_WAVE_GAIN, 1 / Math.max(peak, 0.08));
      micScaleCache.set(data, gain);
    }
    return gain;
  }

  function micRecGain() {
    return Math.min(MAX_WAVE_GAIN, 1 / Math.max(mic.recPeak, 0.08));
  }

  function micRecPeak(t0, t1) {
    const sr = mic.sampleRate;
    const a = Math.max(0, Math.floor((t0 - mic.recStart) * sr));
    const b = Math.min(mic.recLen, Math.ceil((t1 - mic.recStart) * sr));
    if (b <= a) return 0;
    let base = 0;
    let peak = 0;
    for (const chunk of mic.recChunks) {
      const next = base + chunk.length;
      if (next <= a) { base = next; continue; }
      if (base >= b) break;
      const s = Math.max(a, base) - base;
      const e = Math.min(b, next) - base;
      const step = Math.max(1, Math.floor((e - s) / 12));
      for (let i = s; i < e; i += step) {
        const v = Math.abs(chunk[i]);
        if (v > peak) peak = v;
      }
      base = next;
    }
    return peak;
  }

  function micDrawWave(g, left, right, top, bottom, peakAt, gain) {
    const mid = (top + bottom) / 2;
    const amp = Math.max(1, (bottom - top) / 2 - 4);
    const buckets = Math.max(1, Math.floor(right - left));
    g.beginPath();
    for (let i = 0; i < buckets; i++) {
      const peak = peakAt(i, buckets);
      const half = Math.max(0.7, Math.min(amp, peak * amp * gain));
      const x = left + i + 0.5;
      g.moveTo(x, mid - half);
      g.lineTo(x, mid + half);
    }
    g.stroke();
  }

  function micDrawClip(g, w, h, clip, selected) {
    const sr = mic.sampleRate;
    const dur = MM.clipDur(clip, sr);
    const x0 = micXAt(clip.start);
    const x1 = micXAt(clip.start + dur);
    if (x1 < GUTTER || x0 > w) return;
    const left = Math.max(GUTTER, x0);
    const right = Math.min(w, x1);
    if (right <= left) return;
    const top = 5;
    const bottom = h - 5;
    const height = bottom - top;
    micRoundRect(g, left, top, right - left, height, 4);
    g.fillStyle = selected ? 'rgba(120,220,255,.34)' : 'rgba(120,220,255,.18)';
    g.fill();
    g.strokeStyle = selected ? 'rgba(170,240,255,.95)' : 'rgba(120,220,255,.5)';
    g.lineWidth = 1;
    g.stroke();
    g.save();
    g.beginPath();
    micRoundRect(g, left, top, right - left, height, 4);
    g.clip();
    g.strokeStyle = 'rgba(200,248,255,.9)';
    g.lineWidth = 1;
    const gain = micClipGain(clip);
    micDrawWave(g, left, right, top + 2, bottom - 2, (i, n) => {
      const t0 = clip.start + (i / n) * dur;
      const t1 = clip.start + ((i + 1) / n) * dur;
      return micClipPeak(clip, t0, t1);
    }, gain);
    g.restore();
    g.fillStyle = 'rgba(255,255,255,.65)';
    g.fillRect(left, top, 2, height);
    g.fillRect(right - 2, top, 2, height);
    if (right - left > 44) {
      g.fillStyle = 'rgba(255,255,255,.78)';
      g.font = '10px sans-serif';
      g.textAlign = 'left';
      g.textBaseline = 'top';
      g.fillText(`${dur.toFixed(2)}s`, left + 5, top + 4);
    }
  }

  function micDrawRecording(g, w, h) {
    const sr = mic.sampleRate;
    const dur = mic.recLen / sr;
    if (dur <= 0) return;
    const x0 = micXAt(mic.recStart);
    const x1 = micXAt(mic.recStart + dur);
    if (x1 < GUTTER || x0 > w) return;
    const left = Math.max(GUTTER, x0);
    const right = Math.min(w, x1);
    if (right <= left) return;
    const top = 5;
    const bottom = h - 5;
    const height = bottom - top;
    micRoundRect(g, left, top, right - left, height, 4);
    g.fillStyle = 'rgba(255,80,80,.26)';
    g.fill();
    g.strokeStyle = 'rgba(255,105,105,.95)';
    g.lineWidth = 1;
    g.stroke();
    g.save();
    g.beginPath();
    micRoundRect(g, left, top, right - left, height, 4);
    g.clip();
    g.strokeStyle = 'rgba(255,190,190,.95)';
    g.lineWidth = 1;
    micDrawWave(g, left, right, top + 2, bottom - 2, (i, n) => {
      const t0 = mic.recStart + (i / n) * dur;
      const t1 = mic.recStart + ((i + 1) / n) * dur;
      return micRecPeak(t0, t1);
    }, micRecGain());
    g.restore();
    g.fillStyle = 'rgba(255,255,255,.7)';
    g.fillRect(left, top, 2, height);
  }

  function micDrawLane() {
    const canvas = mq('#mic-wave-main');
    const setup = micCanvasSize(canvas);
    if (!setup) return;
    const { g, w, h } = setup;
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(0,0,0,.14)';
    g.fillRect(0, 0, GUTTER, h);
    const viewDur = (w - GUTTER - 8) / mic.pps;
    const step = TICK_STEPS.find((s) => s * mic.pps >= 58) || TICK_STEPS[TICK_STEPS.length - 1];
    const first = Math.floor(mic.offset / step) * step;
    g.strokeStyle = 'rgba(255,255,255,.045)';
    for (let t = first; t <= mic.offset + viewDur + step; t += step) {
      const x = micXAt(t);
      if (x < GUTTER || x > w) continue;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    }
    g.strokeStyle = 'rgba(255,255,255,.08)';
    g.beginPath(); g.moveTo(GUTTER, h / 2); g.lineTo(w, h / 2); g.stroke();
    for (const clip of mic.tracks.main) micDrawClip(g, w, h, clip, mic.selectedIds.has(clip.id));
    if (mic.recording) micDrawRecording(g, w, h);
    if (!mic.tracks.main.length && !mic.recording) {
      g.fillStyle = 'rgba(255,255,255,.22)';
      g.font = '11px sans-serif';
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.fillText('Record or drag a take here', GUTTER + 10, h / 2);
    }
    const d = mic.drag;
    if (d && d.type === 'marquee') {
      const a = Math.min(d.startT, d.currentT);
      const b = Math.max(d.startT, d.currentT);
      const xa = micXAt(a);
      const xb = micXAt(b);
      g.fillStyle = 'rgba(120,220,255,.12)';
      g.fillRect(xa, 2, xb - xa, h - 4);
      g.strokeStyle = 'rgba(120,220,255,.55)';
      g.strokeRect(xa + 0.5, 2.5, Math.max(1, xb - xa - 1), h - 5);
    }
  }

  function micDraw() {
    if (!mq('#mic-mini')) return;
    micClampOffset();
    micDrawRuler();
    micDrawLane();
    const ph = mq('#mic-playhead');
    if (ph) {
      const x = micXAt(mic.playhead);
      if (x < GUTTER || x > micMiniWidth()) {
        ph.style.display = 'none';
      } else {
        ph.style.display = 'block';
        ph.style.left = `${x}px`;
      }
    }
    const zoom = mq('#mic-zoom');
    if (zoom) zoom.textContent = `${Math.round(mic.pps)} px/s`;
  }

  /* ---- UI state ---- */
  function micCanSplit() {
    const t = mic.playhead;
    const ids = mic.selectedIds.size
      ? [...mic.selectedIds]
      : mic.tracks[mic.activeTrack].map((c) => c.id);
    return ids.some((id) => {
      const found = micFind(id);
      if (!found) return false;
      const dur = MM.clipDur(found.clip, mic.sampleRate);
      const local = t - found.clip.start;
      return local > MIC_MIN_LEN && local < dur - MIC_MIN_LEN;
    });
  }

  function micUpdateUI() {
    const end = micContentEnd();
    const t = mq('#mic-time');
    if (t) t.textContent = `${mic.playhead.toFixed(3)} / ${end.toFixed(3)}`;
    const dot = mq('#mic-rec-dot');
    if (dot) dot.classList.toggle('hidden', !mic.recording);
    const rl = mq('#mic-record-label');
    if (rl) rl.textContent = mic.recording ? 'Stop rec' : 'Record';
    const pl = mq('#mic-play-label');
    if (pl) pl.textContent = mic.playing ? 'Pause' : 'Play';
    const use = mq('#mic-use-play');
    if (use) use.setAttribute('href', mic.playing ? '#i-pause' : '#i-play');
    const split = mq('#mic-split');
    if (split) split.disabled = !micCanSplit();
    const del = mq('#mic-del');
    if (del) del.disabled = !mic.selectedIds.size;
    const save = mq('#mic-save');
    if (save) save.disabled = !mic.recording && !micClips().length;
    const zoom = mq('#mic-zoom');
    if (zoom) zoom.textContent = `${Math.round(mic.pps)} px/s`;
    const snap = mq('#mic-snap');
    if (snap) snap.checked = mic.snap;
    for (const lane of document.querySelectorAll('.mic-lane')) {
      lane.classList.toggle('active', lane.dataset.track === mic.activeTrack);
    }
  }

  /* ---- pointer interaction ---- */
  function micLaneAt(e) { return e.target.closest('.mic-lane'); }

  // Double-click detection on pointerdown: the pointerdown handlers prevent
  // default, which suppresses the native dblclick.
  function micIsDoubleDown(key) {
    const now = performance.now();
    const hit = micLastDown.key === key && (now - micLastDown.t) < 320;
    micLastDown = { key, t: now };
    return hit;
  }

  // First empty span at or after 0 that contains t.
  function micGapAt(t) {
    const clips = [...mic.tracks.main].sort((a, b) => a.start - b.start);
    let prevEnd = 0;
    for (const c of clips) {
      if (c.start > prevEnd + 1e-6 && t >= prevEnd - 1e-6 && t <= c.start + 1e-6) {
        return { start: prevEnd, end: c.start };
      }
      prevEnd = Math.max(prevEnd, MM.clipEnd(c, mic.sampleRate));
    }
    return null;
  }

  function micDeleteClip(clip) {
    const before = micSnapshot();
    micRemove(clip.id);
    micPushHistory(before);
    mic.selectedIds.delete(clip.id);
    mic.saved = false;
    micUpdateUI();
    micDraw();
    setStatus('Deleted take');
  }

  // Double-clicking a gap ripples everything after it left, closing the span.
  function micCloseGap(gap) {
    const w = gap.end - gap.start;
    if (w <= 1e-6) return;
    const before = micSnapshot();
    for (const c of mic.tracks.main) {
      if (c.start >= gap.end - 1e-6) c.start = Math.max(0, c.start - w);
    }
    micSort();
    micPushHistory(before);
    if (mic.playhead >= gap.end - 1e-6) mic.playhead = Math.max(0, mic.playhead - w);
    mic.saved = false;
    micUpdateUI();
    micDraw();
    setStatus(`Closed ${w.toFixed(2)}s gap`);
  }

  function micPointerDown(e) {
    if (e.button === 1) {
      micStopPlay();
      mic.drag = { type: 'pan', lastX: e.clientX };
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
      const mini = mq('#mic-mini');
      if (mini) { mini.classList.add('panning'); mini.style.cursor = 'grabbing'; }
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    const lane = micLaneAt(e);
    if (!lane) return;
    const track = lane.dataset.track;
    micStopPlay();
    const t = micTimeAtX(e.clientX);
    const clip = micClipAt(track, t);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
    e.preventDefault();

    const gap = clip ? null : micGapAt(t);
    const dblKey = clip ? 'c' + clip.id : (gap ? `g${gap.start}:${gap.end}` : null);
    if (dblKey && micIsDoubleDown(dblKey)) {
      micLastDown = { key: null, t: 0 };
      mic.drag = null;
      if (clip) micDeleteClip(clip);
      else micCloseGap(gap);
      return;
    }
    if (!dblKey) micLastDown = { key: null, t: 0 };

    if (!clip) {
      mic.activeTrack = track;
      if (!e.ctrlKey && !e.metaKey) mic.selectedIds.clear();
      mic.playhead = t;
      mic.drag = { type: 'marquee', track, startT: t, currentT: t, moved: false };
      micUpdateUI();
      micDraw();
      return;
    }
    mic.activeTrack = track;
    if (e.ctrlKey || e.metaKey) {
      if (mic.selectedIds.has(clip.id)) mic.selectedIds.delete(clip.id);
      else mic.selectedIds.add(clip.id);
      mic.drag = null;
      micUpdateUI();
      micDraw();
      return;
    }
    if (!mic.selectedIds.has(clip.id)) mic.selectedIds = new Set([clip.id]);
    const x = micXAt(t);
    const x0 = micXAt(clip.start);
    const x1 = micXAt(MM.clipEnd(clip, mic.sampleRate));
    let type = 'move';
    if (Math.abs(x - x0) <= EDGE_PX) type = 'trim-l';
    else if (Math.abs(x - x1) <= EDGE_PX) type = 'trim-r';
    const origStarts = new Map();
    for (const id of mic.selectedIds) {
      const found = micFind(id);
      if (found) origStarts.set(id, found.clip.start);
    }
    mic.drag = {
      type,
      id: clip.id,
      startT: t,
      primaryOrig: clip.start,
      origStarts,
      moved: false,
      undo: micSnapshot(),
    };
    micUpdateUI();
    micDraw();
  }

  function micPointerMove(e) {
    const d = mic.drag;
    if (!d) return;
    const t = micTimeAtX(e.clientX);
    if (d.type === 'pan') {
      const dx = e.clientX - d.lastX;
      if (dx) {
        d.lastX = e.clientX;
        mic.offset = clamp(mic.offset - dx / mic.pps, 0, micOffsetMax());
        micUpdateUI();
        micDraw();
      }
      return;
    }
    if (d.type === 'scrub') {
      // Slide the timeline under the pinned playhead, like the main jog bar.
      const raw = d.startOffset - (e.clientX - d.startX) / mic.pps;
      mic.offset = clamp(raw, 0, micOffsetMax());
      mic.playhead = clamp(d.pinTime + raw, 0, Math.max(micEnd(), 0));
      micUpdateUI();
      micDraw();
      return;
    }
    if (d.type === 'marquee') {
      d.currentT = t;
      if (Math.abs(t - d.startT) * mic.pps > 3) d.moved = true;
      mic.playhead = t;
      micUpdateUI();
      micDraw();
      return;
    }
    const found = micFind(d.id);
    if (!found) return;
    if (d.type === 'move') {
      let delta = t - d.startT;
      if (mic.snap) {
        const snapped = MM.snapTime(
          d.primaryOrig + delta,
          micSnapPoints(d.id),
          SNAP_PX / mic.pps,
        );
        delta = snapped - d.primaryOrig;
      }
      let minOrig = Infinity;
      for (const v of d.origStarts.values()) minOrig = Math.min(minOrig, v);
      if (Number.isFinite(minOrig) && minOrig + delta < 0) delta = -minOrig;
      if (Math.abs(delta) > 1e-9) d.moved = true;
      for (const [id, orig] of d.origStarts) {
        const item = micFind(id);
        if (item) micReplace(MM.moveClip(item.clip, orig + delta));
      }
      micSort();
    } else {
      let at = t;
      if (mic.snap) at = MM.snapTime(at, micSnapPoints(d.id), SNAP_PX / mic.pps);
      const edge = d.type === 'trim-l' ? 'left' : 'right';
      // trimClip moves the sample window, so the edge can be dragged back out.
      micReplace(MM.trimClip(found.clip, edge, at, mic.sampleRate, MIC_MIN_LEN));
      d.moved = true;
      micSort();
    }
    if (d.moved) micLastDown = { key: null, t: 0 };
    micMarkDirty();
    micUpdateUI();
    micDraw();
  }

  function micPointerUp() {
    const d = mic.drag;
    if (!d) return;
    mic.drag = null;
    const mini = mq('#mic-mini');
    if (mini) { mini.classList.remove('panning'); mini.style.cursor = ''; }
    const scrubEl = mq('#mic-scrub');
    if (scrubEl) scrubEl.classList.remove('dragging');
    if (d.type === 'marquee') {
      if (d.moved) {
        const a = Math.min(d.startT, d.currentT);
        const b = Math.max(d.startT, d.currentT);
        mic.selectedIds = new Set(
          micClips()
            .filter((c) => c.start < b - 1e-6 && MM.clipEnd(c, mic.sampleRate) > a + 1e-6)
            .map((c) => c.id),
        );
      } else {
        mic.playhead = Math.max(0, d.startT);
      }
    } else if (d.moved && d.undo) {
      micPushHistory(d.undo);
    }
    micUpdateUI();
    micDraw();
  }

  function micHover(e) {
    if (mic.drag) return;
    const mini = mq('#mic-mini');
    const lane = micLaneAt(e);
    if (!mini) return;
    if (!lane) { mini.style.cursor = 'default'; return; }
    const t = micTimeAtX(e.clientX);
    const clip = micClipAt(lane.dataset.track, t);
    if (!clip) { mini.style.cursor = 'crosshair'; return; }
    const x = micXAt(t);
    const x0 = micXAt(clip.start);
    const x1 = micXAt(MM.clipEnd(clip, mic.sampleRate));
    mini.style.cursor = (Math.abs(x - x0) <= EDGE_PX || Math.abs(x - x1) <= EDGE_PX)
      ? 'col-resize'
      : 'grab';
  }

  function micWheel(e) {
    const modal = mq('#mic-modal');
    if (!modal || modal.classList.contains('hidden')) return;
    const mini = mq('#mic-mini');
    if (!mini) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const r = mini.getBoundingClientRect();
    const px = clamp(e.clientX - r.left, GUTTER, mini.clientWidth);
    const anchor = mic.offset + (px - GUTTER) / mic.pps;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    mic.pps = clamp(mic.pps * factor, 10, 3000);
    mic.offset = Math.max(0, anchor - (px - GUTTER) / mic.pps);
    micClampOffset();
    micUpdateUI();
    micDraw();
  }

  /* ---- edit commands ---- */
  function micSplit() {
    const before = micSnapshot();
    const t = mic.playhead;
    const ids = mic.selectedIds.size
      ? [...mic.selectedIds]
      : mic.tracks[mic.activeTrack].map((c) => c.id);
    let made = 0;
    const selection = new Set();
    for (const id of ids) {
      const found = micFind(id);
      if (!found) continue;
      const parts = MM.splitClip(found.clip, t, mic.sampleRate, micNewId);
      if (parts.length < 2) continue;
      const arr = mic.tracks[found.track];
      const i = arr.findIndex((c) => c.id === id);
      if (i < 0) continue;
      arr.splice(i, 1, ...parts);
      arr.sort((a, b) => a.start - b.start);
      selection.add(parts[1].id);
      made += 1;
    }
    if (!made) {
      toast('Playhead must be inside a take', { danger: true });
      return;
    }
    micPushHistory(before);
    mic.selectedIds = selection;
    mic.saved = false;
    micUpdateUI();
    micDraw();
  }

  function micDelete() {
    if (!mic.selectedIds.size) return;
    const before = micSnapshot();
    for (const id of [...mic.selectedIds]) micRemove(id);
    micPushHistory(before);
    mic.selectedIds.clear();
    mic.saved = false;
    micUpdateUI();
    micDraw();
  }

  function micJumpCut(dir) {
    micStopPlay();
    const target = MM.nextCut(MM.cutPoints(micClips(), mic.sampleRate), mic.playhead, dir);
    mic.playhead = target == null ? (dir < 0 ? 0 : micEnd()) : target;
    micEnsureVisible(mic.playhead);
    micUpdateUI();
    micDraw();
  }

  function micSeek(t) {
    micStopPlay();
    mic.playhead = clamp(t, 0, Math.max(micEnd(), 0));
    micEnsureVisible(mic.playhead);
    micUpdateUI();
    micDraw();
  }

  /* ---- open / close / save ---- */
  function micOpen() {
    const modal = mq('#mic-modal');
    if (!modal || !modal.classList.contains('hidden')) return;
    if (state.playing) pausePlay();
    micReset();
    try { micEnsureCtx(); }
    catch (e) {
      toast('Microphone unavailable: ' + (e && e.message ? e.message : e), { danger: true });
      return;
    }
    const name = mq('#mic-name');
    if (name) name.value = MW.stampName(new Date());
    modal.classList.remove('hidden');
    mic.saved = true;
    requestAnimationFrame(() => {
      micFit();
      micUpdateUI();
      micDraw();
      micLoop();
    });
    setStatus('Mic recorder — press Record and speak');
  }

  function micClose(force) {
    const modal = mq('#mic-modal');
    if (!modal || modal.classList.contains('hidden')) return;
    if (!force && !mic.saved && (mic.recording || micClips().length)) {
      if (!confirm('Discard this mic take?')) return;
    }
    if (mic.recording) micStopCapture();
    micStopPlay();
    if (mic.raf) { cancelAnimationFrame(mic.raf); mic.raf = 0; }
    try { if (mic.ctx) mic.ctx.close(); } catch (_) {}
    mic.ctx = null;
    try { if (mic.stream) mic.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    micReset();
    const name = mq('#mic-name');
    if (name) name.value = '';
    modal.classList.add('hidden');
    setStatus('Ready');
  }

  async function micSaveTake() {
    if (mic.recording) micFinishRecord();
    micStopPlay();
    const pcm = MM.mixClips(micClips(), mic.sampleRate);
    if (!pcm.length) {
      toast('Record something first', { danger: true });
      return;
    }
    const nameEl = mq('#mic-name');
    const name = ((nameEl && nameEl.value) || '').trim() || MW.stampName(new Date());
    const data = MW.encodeWav(pcm, mic.sampleRate);
    let res;
    try { res = await api.micSave({ name, data }); }
    catch (e) {
      toast('Could not save mic take: ' + e, { danger: true });
      return;
    }
    if (!res || !res.ok) {
      toast('Could not save mic take: ' + ((res && res.error) || 'unknown error'), { danger: true });
      return;
    }
    mic.saved = true;
    toast(`Saved ${res.name} to Mic Record`);
    micClose(true);
    refreshBin('sounds');
  }

  /* ---- hotkeys (scoped to the open mic modal) ---- */
  function micKeyDown(e) {
    const modal = mq('#mic-modal');
    if (!modal || modal.classList.contains('hidden')) return;
    const tag = (e.target && e.target.tagName) || '';
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
      || (e.target && e.target.isContentEditable);
    if (typing && e.key !== 'Escape') return;
    const mod = e.ctrlKey || e.metaKey;
    let handled = true;
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      if (e.shiftKey) micRedo(); else micUndo();
    } else if (mod && (e.key === 'y' || e.key === 'Y')) {
      micRedo();
    } else if (e.key === ' ') {
      if (!e.repeat) {
        // A focused button would otherwise swallow Space; play/pause wins.
        const ae = document.activeElement;
        if (ae && ae !== document.body && typeof ae.blur === 'function') ae.blur();
        micTogglePlay();
      }
    } else if (!mod && (e.key === 'r' || e.key === 'R')) {
      if (!e.repeat) micToggleRecord();
    } else if (!mod && (e.key === 's' || e.key === 'S')) {
      if (!e.repeat) micSplit();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      micDelete();
    } else if (e.key === 'a' || e.key === 'A' || e.key === 'ArrowLeft') {
      micJumpCut(-1);
    } else if (e.key === 'd' || e.key === 'D' || e.key === 'ArrowRight') {
      micJumpCut(1);
    } else if (e.key === 'f' || e.key === 'F') {
      micFit();
    } else if (e.key === 'Escape') {
      micClose(false);
    } else {
      handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  function wireMicEvents() {
    if (mic.wired) return;
    mic.wired = true;
    const on = (sel, ev, fn, opts) => {
      const el = mq(sel);
      if (el) el.addEventListener(ev, fn, opts);
    };
    on('#btn-mic', 'click', micOpen);
    on('#mic-record', 'click', () => micToggleRecord());
    on('#mic-play', 'click', () => micTogglePlay());
    on('#mic-stop', 'click', micStopTake);
    on('#mic-split', 'click', micSplit);
    on('#mic-del', 'click', micDelete);
    on('#mic-cancel', 'click', () => micClose(false));
    on('#mic-save', 'click', micSaveTake);
    on('#mic-snap', 'change', (e) => { mic.snap = !!e.target.checked; });
    on('#mic-fit', 'click', micFit);
    const mini = mq('#mic-mini');
    if (mini) {
      mini.addEventListener('pointerdown', micPointerDown);
      mini.addEventListener('pointermove', micPointerMove);
      mini.addEventListener('pointermove', micHover);
      mini.addEventListener('pointerup', micPointerUp);
      mini.addEventListener('pointercancel', micPointerUp);
      mini.addEventListener('wheel', micWheel, { passive: false });
    }
    const ruler = mq('#mic-ruler');
    if (ruler) {
      ruler.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        micStopPlay();
        mic.playhead = micTimeAtX(e.clientX);
        micUpdateUI();
        micDraw();
        e.preventDefault();
      });
    }
    // Jog / shuttle bar: same controls as the main timeline's scrub bar.
    on('#mic-scrub-start', 'click', () => micSeek(0));
    on('#mic-scrub-end', 'click', () => micSeek(micEnd()));
    on('#mic-scrub-prev', 'click', () => micJumpCut(-1));
    on('#mic-scrub-next', 'click', () => micJumpCut(1));
    const scrub = mq('#mic-scrub');
    if (scrub) {
      scrub.querySelectorAll('.scrub-nav button').forEach((b) => {
        b.addEventListener('pointerdown', (e) => e.stopPropagation());
      });
      scrub.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        micStopPlay();
        mic.drag = {
          type: 'scrub',
          startX: e.clientX,
          startOffset: mic.offset,
          pinTime: mic.playhead - mic.offset,
        };
        try { scrub.setPointerCapture(e.pointerId); } catch (_) {}
        scrub.classList.add('dragging');
        e.preventDefault();
      });
      scrub.addEventListener('pointermove', micPointerMove);
      scrub.addEventListener('pointerup', micPointerUp);
      scrub.addEventListener('pointercancel', micPointerUp);
      scrub.addEventListener('lostpointercapture', () => scrub.classList.remove('dragging'));
    }
    document.addEventListener('keydown', micKeyDown);
  }

  /* Expose the entry points app.js already calls. */
  window.micOpen = micOpen;
  window.micClose = micClose;
  window.wireMicEvents = wireMicEvents;
  window.micDebugState = () => ({
    main: mic.tracks.main.length,
    alt: 0,
    selected: [...mic.selectedIds],
    playhead: mic.playhead,
    recording: mic.recording,
    playing: mic.playing,
    recLen: mic.recLen,
    recPeak: mic.recPeak,
    pps: mic.pps,
    offset: mic.offset,
    saved: mic.saved,
    activeTrack: mic.activeTrack,
    drag: mic.drag ? {
      type: mic.drag.type,
      id: mic.drag.id,
      startT: mic.drag.startT,
      moved: mic.drag.moved,
    } : null,
    clips: mic.tracks.main.map((c) => ({
      start: c.start,
      dur: MM.clipDur(c, mic.sampleRate),
      from: MM.clipFrom(c),
      to: MM.clipTo(c),
      len: c.samples.length,
    })),
  });
})();
