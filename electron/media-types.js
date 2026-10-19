// Single source of truth for accepted media/audio/image extensions. Everything
// that decides "is this a clip / sound / still?" — bin scanning, the +Add
// dialog filters, and OS drag-and-drop — reads from here so formats never drift.
const MEDIA_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.mpg', '.mpeg', '.ts', '.flv', '.wmv', '.m2ts']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma', '.aiff', '.aif']);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

// Dialog-filter friendly arrays, entries without the leading dot.
const mediaList = [...MEDIA_EXT].map((e) => e.slice(1)).sort();
const audioList = [...AUDIO_EXT].map((e) => e.slice(1)).sort();
const imageList = [...IMAGE_EXT].map((e) => e.slice(1)).sort();

// The media bin accepts moving pictures and stills; the other bins stay narrow.
function scanExtSet(mode) {
  if (mode === 'audio') return AUDIO_EXT;
  if (mode === 'image') return IMAGE_EXT;
  if (mode === 'media') return new Set([...MEDIA_EXT, ...IMAGE_EXT]);
  return MEDIA_EXT;
}

module.exports = {
  MEDIA_EXT,
  AUDIO_EXT,
  IMAGE_EXT,
  MEDIA_EXT_LIST: mediaList,
  AUDIO_EXT_LIST: audioList,
  IMAGE_EXT_LIST: imageList,
  scanExtSet,
};
