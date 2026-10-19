// Single source of truth for accepted media/audio extensions. Everything that
// decides "is this a clip / sound?" — bin scanning, the +Add dialog filters,
// and OS drag-and-drop — reads from here so formats never drift apart.
const MEDIA_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.mpg', '.mpeg', '.ts', '.flv', '.wmv', '.m2ts']);
const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.wma', '.aiff', '.aif']);

// Dialog-filter friendly arrays, entries without the leading dot.
const mediaList = [...MEDIA_EXT].map((e) => e.slice(1)).sort();
const audioList = [...AUDIO_EXT].map((e) => e.slice(1)).sort();

module.exports = { MEDIA_EXT, AUDIO_EXT, MEDIA_EXT_LIST: mediaList, AUDIO_EXT_LIST: audioList };