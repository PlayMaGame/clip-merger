const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MEDIA_EXT,
  AUDIO_EXT,
  IMAGE_EXT,
  IMAGE_EXT_LIST,
  scanExtSet,
} = require('../electron/media-types');
const { isImagePath, imageItemFromProbe, STILL_DEFAULT } = require('../electron/image-meta');

test('image extension set covers the supported still formats', () => {
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']) {
    assert.ok(IMAGE_EXT.has(ext));
  }
  assert.ok(IMAGE_EXT_LIST.includes('png'));
  assert.ok(!IMAGE_EXT.has('.mp4'));
});

test('scanExtSet combines video and images for the media bin', () => {
  assert.equal(scanExtSet('audio'), AUDIO_EXT);
  assert.equal(scanExtSet('video'), MEDIA_EXT);
  assert.equal(scanExtSet('image'), IMAGE_EXT);
  const media = scanExtSet('media');
  assert.ok(media.has('.mp4'));
  assert.ok(media.has('.png'));
  assert.ok(!media.has('.wav'));
  assert.equal(scanExtSet(undefined), MEDIA_EXT);
});

test('isImagePath is extension-based and case-insensitive', () => {
  assert.equal(isImagePath('E:\\Clips\\one.PNG'), true);
  assert.equal(isImagePath('/tmp/two.webp'), true);
  assert.equal(isImagePath('/tmp/clip.mp4'), false);
  assert.equal(isImagePath(''), false);
});

test('imageItemFromProbe gives stills a default duration and no audio', () => {
  const item = imageItemFromProbe(
    { path: 'E:\\Clips\\one.png', width: 1080, height: 1920, fps: 25, vcodec: 'png' },
    'E:\\Clips\\one.png',
  );
  assert.equal(item.duration, STILL_DEFAULT);
  assert.equal(item.srcEnd, STILL_DEFAULT);
  assert.equal(item.hasAudio, false);
  assert.equal(item.acodec, null);
  assert.equal(item.width, 1080);
  assert.equal(item.height, 1920);
  assert.equal(item.name, 'one.png');
  assert.equal(item.image, true);
});
