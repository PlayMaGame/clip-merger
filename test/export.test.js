const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exportProject, visualToOutput, cutArgs, srcStartOf, srcEndOf, speedOf, mergeClipsByPriority, editorTotal, zoomScaleExpr, buildCameraExprs, cameraActive, shakeExpr, chooseMode, buildRenderPlan } = require('../electron/ffmpeg/export');

function clip(start, srcStart, srcEnd, extra) {
  return Object.assign({
    start, duration: srcEnd, srcStart, srcEnd, mute: false, speed: 1,
  }, extra);
}

test('visualToOutput collapses gaps between normal clips', () => {
  const clips = [
    clip(0, 0, 2),
    clip(3, 0, 1), // gap from 2 → 3 is closed on export
  ];
  assert.equal(visualToOutput(0, clips), 0);
  assert.equal(visualToOutput(1.5, clips), 1.5);
  assert.equal(visualToOutput(2, clips), 2);   // end of clip 0
  assert.equal(visualToOutput(2.5, clips), 2); // inside the gap → still mapped to collapsed end
  assert.equal(visualToOutput(3, clips), 2);   // start of clip 1 → clip 1 begins at output 2
  assert.equal(visualToOutput(4, clips), 3);   // end of clip 1
});

test('visualToOutput accounts for slow-mo clip span (speed < 1), matching the renderer', () => {
  // A 2s source played at 0.5× lasts 4s of visual/output time.
  const clips = [clip(0, 0, 2, { speed: 0.5 })];
  assert.equal(visualToOutput(0, clips), 0);
  assert.equal(visualToOutput(2, clips), 2);   // halfway through the slow clip
  assert.equal(visualToOutput(4, clips), 4);   // end of the slow clip
});

test('visualToOutput uses source span for speed 1', () => {
  const clips = [clip(0, 0, 10)];
  assert.equal(visualToOutput(10, clips), 10);
});

test('visualToOutput maps sounds after a slow clip', () => {
  // Clip A: 1s source at 0.5× → visual [0, 2]. Clip B: 1s at 1× → visual [3, 4] (gap closed).
  const clips = [
    clip(0, 0, 1, { speed: 0.5 }),
    clip(3, 0, 1),
  ];
  // B starts at visual 3 → collapsed output 2 (end of A).
  assert.equal(visualToOutput(3, clips), 2);
  assert.equal(visualToOutput(4, clips), 3);   // end of B
});

test('srcStartOf / srcEndOf fall back to legacy inPoint / outPoint', () => {
  const legacyClip = { inPoint: 1.25, outPoint: 5.5, duration: 9 };
  assert.equal(srcStartOf(legacyClip), 1.25);
  assert.equal(srcEndOf(legacyClip), 5.5);
  assert.equal(speedOf({}), 1);
  assert.equal(speedOf({ speed: 0.5 }), 0.5);
});

test('cutArgs lossless mode stream-copies video and audio', () => {
  const a = cutArgs('x.mp4', 0, 10, {
    mode: 'lossless', encoder: 'libx264', encoderOpts: [], W: 1080, H: 1920, FPS: 60,
    normalize: false, mute: false, speed: 1,
  });
  assert.equal(a.includes('-c:v') && a[a.indexOf('-c:v') + 1], 'copy');
  assert.equal(a[a.indexOf('-c:a') + 1], 'copy');
});

test('cutArgs reencode mode re-encodes video and normalizes audio when asked', () => {
  const a = cutArgs('x.mp4', 0, 10, {
    mode: 'reencode', encoder: 'libx264', encoderOpts: ['-preset', 'fast'], W: 1080, H: 1920, FPS: 60,
    normalize: true, mute: false, speed: 0.5, fit: 'cover',
  });
  const vfIdx = a.indexOf('-vf');
  assert.ok(vfIdx >= 0);
  assert.match(a[vfIdx + 1], /setpts=PTS\/0.5/);         // slow-mo time stretch
  assert.ok(a.indexOf('-preset') >= 0);
  const afIdx = a.indexOf('-af');
  const chain = a[afIdx + 1];
  assert.match(chain, /loudnorm=/);         // normalize on
  assert.ok(chain.includes('atempo='));      // speed 0.5 chained via atempo
});

test('cutArgs mute adds a silent audio track', () => {
  const a = cutArgs('x.mp4', 0, 10, {
    mode: 'lossless', encoder: 'libx264', encoderOpts: [], W: 1080, H: 1920, FPS: 60,
    normalize: false, mute: true, speed: 1,
  });
  assert.ok(a.some((x) => x.includes('anullsrc')));
  assert.equal(a[a.indexOf('-map') + 1], '0:v:0');
});

test('cutArgs blur fit uses a filter_complex with overlay and maps [v]', () => {
  const a = cutArgs('x.mp4', 0, 10, {
    mode: 'reencode', encoder: 'libx264', encoderOpts: [], W: 1080, H: 1920, FPS: 60,
    normalize: false, mute: false, speed: 1, fit: 'blur',
  });
  const fcIdx = a.indexOf('-filter_complex');
  assert.ok(fcIdx >= 0);
  const graph = a[fcIdx + 1];
  assert.match(graph, /split=2/);
  assert.match(graph, /boxblur/);
  assert.match(graph, /overlay=/);
  assert.equal(a[a.indexOf('-map') + 1], '[v]');
});

test('cutArgs blur drops slow-mo setpts into the head of the graph', () => {
  const a = cutArgs('x.mp4', 0, 10, {
    mode: 'reencode', encoder: 'libx264', encoderOpts: [], W: 1080, H: 1920, FPS: 60,
    normalize: false, mute: false, speed: 0.5, fit: 'blur',
  });
  const graph = a[a.indexOf('-filter_complex') + 1];
  assert.ok(graph.startsWith('[0:v]setpts=PTS/0.5,fps=60,split=2'));
});

test('blur graph is size-agnostic: fg letterboxes (decrease), bg always covers (increase+crop)', () => {
  // The graph shape is identical for any source dims (16:9, square, 9:16, 4K):
  // [fg] fits the whole frame, [bg] always fills 1080x1920, overlay centers.
  const a = cutArgs('x.mp4', 0, 10, {
    mode: 'reencode', encoder: 'libx264', encoderOpts: [], W: 1080, H: 1920, FPS: 60,
    normalize: false, mute: false, speed: 1, fit: 'blur',
  });
  const graph = a[a.indexOf('-filter_complex') + 1];
  assert.match(graph, /\[fg\]scale=1080:1920:force_original_aspect_ratio=decrease(:force_divisible_by=2)?/);
  assert.match(graph, /\[bg\]scale=1080:1920:force_original_aspect_ratio=increase(:force_divisible_by=2)?,crop=1080:1920/);
  assert.match(graph, /overlay=\(W-w\)\/2:\(H-h\)\/2/);
});

test('cutArgs prepends a dB volume gain to the audio chain', () => {
  const a = cutArgs('x.mp4', 0, 10, {
    mode: 'reencode', encoder: 'libx264', encoderOpts: [], W: 1080, H: 1920, FPS: 60,
    normalize: true, mute: false, speed: 1, fit: 'cover', volumeDb: 6,
  });
  const chain = a[a.indexOf('-af') + 1];
  assert.match(chain, /^volume=1\.995/);  // 10^(6/20)
  assert.ok(chain.includes('loudnorm='));
  assert.ok(chain.includes('aresample=48000'));
});

test('cutArgs leaves the audio chain alone at 0 dB', () => {
  const a = cutArgs('x.mp4', 0, 10, {
    mode: 'reencode', encoder: 'libx264', encoderOpts: [], W: 1080, H: 1920, FPS: 60,
    normalize: false, mute: false, speed: 1, fit: 'cover', volumeDb: 0,
  });
  const chain = a[a.indexOf('-af') + 1];
  assert.ok(!chain.startsWith('volume='));
});

test('mergeClipsByPriority: MAIN covers ALT', () => {
  const main = [{ id: 'm1', start: 0, srcStart: 0, srcEnd: 10, speed: 1, _priority: 0 }];
  const alt = [{ id: 'a1', start: 5, srcStart: 0, srcEnd: 10, speed: 1, _priority: 1 }];
  const result = mergeClipsByPriority(main, alt);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, 'm1');
  assert.equal(result[0].start, 0);
  assert.equal(result[1].id, 'a1');
  assert.equal(result[1].start, 10);
  assert.equal(result[1]._srcOffset, 5);
});

test('mergeClipsByPriority: non-overlapping clips preserved', () => {
  const main = [{ id: 'm1', start: 0, srcStart: 0, srcEnd: 5, speed: 1, _priority: 0 }];
  const alt = [{ id: 'a1', start: 10, srcStart: 0, srcEnd: 5, speed: 1, _priority: 1 }];
  const result = mergeClipsByPriority(main, alt);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, 'm1');
  assert.equal(result[1].id, 'a1');
  assert.equal(result[1]._srcOffset, 0);
});

test('mergeClipsByPriority: ALT split by MAIN overlap', () => {
  const main = [
    { id: 'm1', start: 0, srcStart: 0, srcEnd: 3, speed: 1, _priority: 0 },
    { id: 'm2', start: 7, srcStart: 0, srcEnd: 3, speed: 1, _priority: 0 },
  ];
  const alt = [{ id: 'a1', start: 0, srcStart: 0, srcEnd: 10, speed: 1, _priority: 1 }];
  const result = mergeClipsByPriority(main, alt);
  assert.equal(result.length, 3);
  assert.equal(result[0].id, 'm1');
  assert.equal(result[0].start, 0);
  assert.equal(result[1].id, 'a1');
  assert.equal(result[1].start, 3);
  assert.equal(result[1]._srcOffset, 3);
  assert.equal(result[2].id, 'm2');
  assert.equal(result[2].start, 7);
});

test('editorTotal: max end over MAIN clips only', () => {
  const project = { timeline: [clip(0, 0, 5, { path: 'm.mp4' }), clip(6, 0, 4, { path: 'n.mp4' })] }; // ends at 10
  assert.equal(editorTotal(project), 10);
});

test('editorTotal: includes soundboard tails past the last clip', () => {
  const project = {
    timeline: [clip(0, 0, 5, { path: 'm.mp4' })],
    soundboard: [{ startTime: 4, srcStart: 0, srcEnd: 4, path: 'a.mp3' }], // ends at 8
  };
  assert.equal(editorTotal(project), 8);
});

test('editorTotal: counts ALT clips and ALT sounds', () => {
  const project = {
    timeline: [clip(0, 0, 3, { path: 'm.mp4' })],
    hybrid: [
      { kind: 'clip', start: 3, srcStart: 0, srcEnd: 2, speed: 1, path: 'v.mp4' }, // ends at 5
      { kind: 'sound', startTime: 5, srcStart: 0, srcEnd: 3, path: 's.mp3' },     // ends at 8
    ],
  };
  assert.equal(editorTotal(project), 8);
});

test('editorTotal: ignores entries without a path', () => {
  const project = { timeline: [{ start: 0, srcStart: 0, srcEnd: 5, speed: 1 }] };
  assert.equal(editorTotal(project), 0);
});

test('zoomScaleExpr: encodes hold + ramp for dir in (linear)', () => {
  const e = zoomScaleExpr({ a: 1, b: 3, level: 2, dir: 'in', ease: 'linear' });
  assert.match(e, /clip\(\(t-1\.0000\)\/2\.0000,0,1\)/); // holds outside [1,3]
  assert.match(e, /\(1\.0000\+\(2\.0000-1\.0000\)\*/);   // from 1 -> to 2
});

test('zoomScaleExpr: smooth ease squares/mixes for smoothstep', () => {
  const e = zoomScaleExpr({ a: 0, b: 1, level: 1.4, dir: 'in', ease: 'smooth' });
  assert.match(e, /\(3-2\*clip/);
});

test('cutArgs zoom (black bg) builds animated scale + overlay graph', () => {
  const args = cutArgs('in.mp4', 0, 2, {
    mode: 'reencode', encoder: 'libx264', encoderOpts: ['-preset', 'medium'],
    W: 1080, H: 1920, FPS: 60, normalize: false, mute: false, speed: 1, fit: 'cover', volumeDb: 0,
    zoom: { a: 0.2, b: 1.2, level: 1.4, dir: 'in', ease: 'smooth', bg: 'black', cx: 0.5, cy: 0.5 },
  });
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.match(fc, /scale=w='trunc\(iw\*/);
  assert.match(fc, /eval=frame/);
  assert.match(fc, /color=black/);
  assert.match(fc, /overlay=x='W\/2-0\.5000\*w':y='H\/2-0\.5000\*h'/);
  assert.match(fc, /\[v\]/);
  assert.ok(args.includes('[v]')); // mapped
});

test('cutArgs zoom (blur bg) splits the frame and blurs the base', () => {
  const args = cutArgs('in.mp4', 0, 2, {
    mode: 'reencode', encoder: 'libx264', encoderOpts: [],
    W: 1080, H: 1920, FPS: 60, normalize: false, mute: false, speed: 1, fit: 'cover', volumeDb: 0,
    zoom: { a: 0, b: 1, level: 0.6, dir: 'out', ease: 'linear', bg: 'blur', cx: 0.5, cy: 0.5 },
  });
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.match(fc, /boxblur/);
  assert.match(fc, /split=2/);
});

test('cameraActive: false with no effects, true during, false after (bounded)', () => {
  assert.equal(cameraActive([], 0, 5), false);
  const eff = [{ start: 1, dur: 3, from: { z: 1, cx: 0.5, cy: 0.5 }, to: { z: 2, cx: 0.5, cy: 0.5 }, ease: 'linear' }];
  assert.equal(cameraActive(eff, 0, 5), true);
  assert.equal(cameraActive(eff, 10, 12), false); // outside the band -> identity
});

test('buildCameraExprs: z/cx/cy expressions in local time', () => {
  const eff = [{ start: 1, dur: 2, from: { z: 1, cx: 0.5, cy: 0.5 }, to: { z: 2, cx: 0.3, cy: 0.7 }, ease: 'linear' }];
  const c = buildCameraExprs(eff, 0, 4, 'black');
  assert.ok(c && typeof c.z === 'string');
  assert.match(c.z, /clip\(/);
  assert.equal(c.bg, 'black');
});

test('cutArgs camera builds an animated scale + centre overlay graph', () => {
  const eff = [{ start: 0, dur: 2, from: { z: 1, cx: 0.5, cy: 0.5 }, to: { z: 1.5, cx: 0.5, cy: 0.5 }, ease: 'smooth' }];
  const cam = buildCameraExprs(eff, 0, 2, 'black');
  const args = cutArgs('in.mp4', 0, 2, {
    mode: 'reencode', encoder: 'libx264', encoderOpts: [],
    W: 540, H: 960, FPS: 30, normalize: false, mute: false, speed: 1, fit: 'cover', volumeDb: 0, camera: cam,
  });
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.match(fc, /scale=w='trunc\(iw\*\(/);
  assert.match(fc, /eval=frame/);
  assert.match(fc, /overlay=x='W\/2-\(/);
  assert.ok(args.includes('[v]'));
});

test('shakeExpr: sin/cos jitter with decay', () => {
  const s = shakeExpr({ start: 0, dur: 2, amp: 0.05, freq: 20, decay: true, axes: 'both', seed: 7 }, 't');
  assert.match(s.dx, /sin\(/);
  assert.match(s.dy, /cos\(/);
  assert.match(s.dx, /max\(0,1-/);
});

test('cameraActive: true only where an effect band intersects', () => {
  const eff = [{ type: 'shake', start: 1, dur: 1 }];
  assert.equal(cameraActive(eff, 0, 5), true);   // overlaps
  assert.equal(cameraActive(eff, 3, 4), false);  // fully outside
});

test('cutArgs camera applies a shake as an offset', () => {
  const eff = [{ type: 'shake', start: 0, dur: 2, amp: 0.05, freq: 20, decay: false, axes: 'both', seed: 7 }];
  const cam = buildCameraExprs(eff, 0, 2, 'black');
  const args = cutArgs('in.mp4', 0, 2, {
    mode: 'reencode', encoder: 'libx264', encoderOpts: [],
    W: 540, H: 960, FPS: 30, normalize: false, mute: false, speed: 1, fit: 'cover', volumeDb: 0, camera: cam,
  });
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.match(fc, /sin\(/);
  assert.match(fc, /cos\(/);
});

test('exportProject refuses to write over a source clip', async () => {
  const project = {
    timeline: [{ path: 'C:\\Clips\\A.mp4', start: 0, srcStart: 0, srcEnd: 1 }],
  };
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipmerger-guard-'));
  try {
    await assert.rejects(
      () => exportProject({
        ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', project,
        outputFile: 'c:/clips/a.MP4', workDir,
      }),
      /source/i,
    );
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

// ---- Lossless mode selection -------------------------------------------------

const modeBase = {
  fit: 'blur', vOk: true, aOk: true, inKf: true, outKf: true,
  normalize: false, speed: 1, volDb: 0, zoom: null, camera: null,
};

test('chooseMode: default blur framing stays lossless when source dims/FPS match', () => {
  // Blur is invisible when the source already fills the output frame, so the
  // default framing must not force a needless re-encode.
  assert.equal(chooseMode(modeBase), 'lossless');
});

test('chooseMode: normalize or per-clip gain keeps video copy + audio re-encode', () => {
  assert.equal(chooseMode({ ...modeBase, normalize: true }), 'vlossless');
  assert.equal(chooseMode({ ...modeBase, volDb: 3 }), 'vlossless');
});

test('chooseMode: mismatched dims/FPS still re-encode for blur framing', () => {
  assert.equal(chooseMode({ ...modeBase, vOk: false }), 'reencode');
});

test('chooseMode: non-keyframe cuts or mismatched audio fall back safely', () => {
  assert.equal(chooseMode({ ...modeBase, inKf: false }), 'reencode');
  assert.equal(chooseMode({ ...modeBase, outKf: false }), 'reencode');
  assert.equal(chooseMode({ ...modeBase, aOk: false }), 'vlossless');
});

test('chooseMode: speed, zoom and camera effects force re-encode', () => {
  assert.equal(chooseMode({ ...modeBase, speed: 0.5 }), 'reencode');
  assert.equal(chooseMode({ ...modeBase, zoom: { level: 1.5 } }), 'reencode');
  assert.equal(chooseMode({ ...modeBase, camera: { z: '1' } }), 'reencode');
});

// ---- Clips that start before 0:00 -------------------------------------------

test('buildRenderPlan: trims a negative-start clip to the 0:00 boundary', () => {
  const clips = [clip(-2, 0, 5, { path: 'a.mp4' })];
  const { plan, visSpans, cursor } = buildRenderPlan(clips, [5]);
  assert.deepEqual(plan, [{ clip: 0 }]);
  assert.equal(visSpans[0].start, 0);
  assert.equal(visSpans[0].outDur, 3);
  assert.equal(visSpans[0].srcTrim, 2);
  assert.equal(visSpans[0].skip, false);
  assert.equal(cursor, 3);
});

test('buildRenderPlan: the gap after a clamped clip stays aligned', () => {
  const clips = [clip(-2, 0, 5, { path: 'a.mp4' }), clip(5, 0, 2, { path: 'b.mp4' })];
  const { plan, cursor } = buildRenderPlan(clips, [5, 2]);
  assert.deepEqual(plan, [{ clip: 0 }, { black: 2 }, { clip: 1 }]);
  assert.equal(cursor, 7);
});

test('buildRenderPlan: a clip entirely before 0:00 is dropped', () => {
  const clips = [clip(-10, 0, 5, { path: 'a.mp4' }), clip(0, 0, 2, { path: 'b.mp4' })];
  const { plan, visSpans, cursor } = buildRenderPlan(clips, [5, 2]);
  assert.equal(visSpans[0].skip, true);
  assert.deepEqual(plan, [{ clip: 1 }]);
  assert.equal(cursor, 2);
});

test('buildRenderPlan: slow motion trims source by output time x speed', () => {
  const clips = [clip(-2, 0, 5, { path: 'a.mp4', speed: 0.5 })];
  const { visSpans } = buildRenderPlan(clips, [10]);
  assert.equal(visSpans[0].outDur, 8);
  assert.equal(visSpans[0].srcTrim, 1);
});

test('buildRenderPlan: positive starts are untouched', () => {
  const clips = [clip(3, 0, 5, { path: 'a.mp4' })];
  const { plan, visSpans, cursor } = buildRenderPlan(clips, [5]);
  assert.deepEqual(plan, [{ black: 3 }, { clip: 0 }]);
  assert.equal(visSpans[0].start, 3);
  assert.equal(visSpans[0].outDur, 5);
  assert.equal(visSpans[0].srcTrim, 0);
  assert.equal(cursor, 8);
});

test('cutArgs still mode loops one image and adds silent audio', () => {
  const args = cutArgs('still.png', 0, 3, {
    mode: 'reencode', encoder: 'libx264', encoderOpts: ['-preset', 'medium'],
    W: 1080, H: 1920, FPS: 60, normalize: false, mute: true,
    speed: 1, fit: 'cover', still: true,
  });
  assert.ok(args.includes('-loop'));
  assert.equal(args[args.indexOf('-loop') + 1], '1');
  assert.ok(args.includes('-framerate'));
  assert.equal(args[args.indexOf('-framerate') + 1], '60');
  assert.ok(!args.includes('-ss'));
  assert.ok(args.includes('anullsrc=r=48000:cl=stereo'));
  assert.equal(args.filter((x) => x === '-i').length, 2);
});
