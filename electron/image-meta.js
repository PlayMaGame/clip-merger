const path = require('path');
const { IMAGE_EXT } = require('./media-types');

// A still has no intrinsic duration, so the editor gives it a 3 s default. The
// item's `duration` is the bin-facing/default length; trims can extend it.
const STILL_DEFAULT = 3;

function isImagePath(file) {
  return IMAGE_EXT.has(path.extname(String(file == null ? '' : file)).toLowerCase());
}

function imageItemFromProbe(info, file) {
  const src = file || (info && info.path) || '';
  return {
    ...(info || {}),
    path: src,
    name: path.basename(src),
    duration: STILL_DEFAULT,
    srcEnd: STILL_DEFAULT,
    fps: (info && info.fps) || 30,
    vcodec: (info && info.vcodec) || 'image',
    acodec: null,
    hasAudio: false,
    audioSampleRate: 0,
    audioChannels: 0,
    image: true,
  };
}

module.exports = { isImagePath, imageItemFromProbe, STILL_DEFAULT };
