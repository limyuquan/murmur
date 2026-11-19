/**
 * What a SourceBuffer carries, from its MIME type. Kept apart so the page-side tee (tee.ts) stays
 * small.
 */

/** What a page's SourceBuffer holds, from its MIME type: decides whether its bytes are copied. */
export type TrackKind = 'audio' | 'video' | 'muxed' | 'unknown';

/**
 * The kind of a SourceBuffer by its codecs (some players put audio in `video/mp4`), else its
 * MIME type. Self-contained: the tee passes its source text into workers (tee.ts).
 */
export function kindOf(mime: string): TrackKind {
  const t = mime.toLowerCase();
  const codecs = /codecs\s*=\s*"?([^";]+)/.exec(t)?.[1] ?? '';
  const audio = /mp4a|opus|vorbis|flac|mp3|ac-3|ec-3|aac/.test(codecs);
  const video = /avc|hev|hvc|vp8|vp9|vp09|av01|dvh|dva/.test(codecs);
  if (audio && video) return 'muxed';
  if (video) return 'video';
  if (audio || t.startsWith('audio/')) return 'audio';
  return 'unknown';
}
