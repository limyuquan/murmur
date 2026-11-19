/**
 * What a SourceBuffer carries, from its MIME type. Kept apart so the page-side tee (tee.ts) stays
 * small.
 */

/** What a page's SourceBuffer holds, from its MIME type: decides whether its bytes are copied. */
export type TrackKind = 'audio' | 'video' | 'muxed' | 'unknown';

const AUDIO_CODEC = /mp4a|opus|vorbis|flac|mp3|ac-3|ec-3|aac/;
const VIDEO_CODEC = /avc|hev|hvc|vp8|vp9|vp09|av01|dvh|dva/;

/**
 * The kind of a SourceBuffer by its codecs (some players put audio in `video/mp4`), else its
 * MIME type.
 */
export function kindOf(mime: string): TrackKind {
  const t = mime.toLowerCase();
  const codecs = /codecs\s*=\s*"?([^";]+)/.exec(t)?.[1] ?? '';
  const audio = AUDIO_CODEC.test(codecs);
  const video = VIDEO_CODEC.test(codecs);
  if (audio && video) return 'muxed';
  if (video) return 'video';
  if (audio || t.startsWith('audio/')) return 'audio';
  return 'unknown';
}
