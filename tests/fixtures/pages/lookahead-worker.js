// A minimal player that runs MSE in a dedicated worker, as Twitch's does: the element plays the
// MediaSource's handle. Appends the WebM DASH fixture (lookahead/dash-webm), video and audio,
// segment by segment. URLs are absolute (from the page): a wrapped worker's own location is a
// blob URL.
let base = null;
self.onmessage = (e) => {
  if (e.data?.type !== 'start' || base) return;
  base = e.data.base;
  const ms = new MediaSource();
  self.postMessage({ type: 'handle', handle: ms.handle }, [ms.handle]);
  ms.addEventListener('sourceopen', () => {
    const tracks = [
      { mime: 'video/webm; codecs="vp9"', id: 0, count: 10 },
      { mime: 'audio/webm; codecs="opus"', id: 1, count: 11 },
    ];
    Promise.all(
      tracks.map(async (t) => {
        const sb = ms.addSourceBuffer(t.mime);
        const files = [`init_${t.id}.webm`];
        for (let n = 1; n <= t.count; n++)
          files.push(`seg_${t.id}_${String(n).padStart(3, '0')}.webm`);
        for (const file of files) {
          const bytes = await (await fetch(`${base}${file}`)).arrayBuffer();
          await new Promise((resolve, reject) => {
            sb.addEventListener('updateend', resolve, { once: true });
            sb.addEventListener('error', reject, { once: true });
            sb.appendBuffer(bytes);
          });
        }
      }),
    )
      .then(() => ms.endOfStream())
      .catch((err) => self.postMessage({ type: 'error', message: String(err) }));
  });
};
