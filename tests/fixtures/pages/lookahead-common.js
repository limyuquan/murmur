// Shared by the lookahead fixture pages: records what the player and the video report, so tests
// can check playback isn't disturbed. `window.playback`: fatal player errors, video errors, and
// stalls (a `waiting` after playback started).
window.playback = { errors: [], waiting: 0, playing: false };
const video = document.getElementById('player');
video.addEventListener('error', () => playback.errors.push(`video:${video.error?.code}`));
video.addEventListener('playing', () => {
  playback.playing = true;
});
video.addEventListener('waiting', () => {
  if (playback.playing && !video.seeking) playback.waiting++;
});
window.addEventListener('error', (e) => playback.errors.push(`page:${e.message}`));
