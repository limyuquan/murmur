# Lookahead: subtitles ahead of time (beta)

Live subtitles come from the tab's audio as it plays, so they always trail the speech. Most
players download (and append to their MediaSource) tens of seconds of audio before it plays.
Lookahead reads that audio, runs the same speech and translation engines over it ahead of the
playhead, and shows each line exactly when the video reaches it. Where it has nothing (an ad, a
seek past what is buffered, a player it can't read), the live path carries on as before.

Off everywhere until the person turns it on for a site (popup: "Show subtitles ahead of time").
Settings → Ahead of time has the list and a switch that turns it off everywhere.

## How the audio gets out of the page

```
page (MAIN world)          isolated world              offscreen document
tee.ts ──MessagePort──▶ relay.ts ──▶ overlay ──runtime port──▶ host.ts
(hooks MSE)             (holds, init segments)  ('tee')        mirror → decode → pcm → runner → cues
```

- `tee.ts` runs in the page's own world from `document_start` (registered per site by
  `src/background/lookahead.ts` with `scripting.registerContentScripts`, only where the person
  turned it on and gave Murmur access). It wraps `MediaSource.addSourceBuffer` /
  `removeSourceBuffer`, `SourceBuffer.appendBuffer` / `remove` / `abort` / `changeType` and
  `URL.createObjectURL`. Wrappers keep the built-in's name, length and `toString()`, call the
  original unconditionally, and never throw into the page. Only audio is copied (one `slice()`,
  transferred); `timestampOffset`, the append window and `mode` are read at each append.
- `relay.ts` (isolated world, same frames) takes the tee's events, keeps every SourceBuffer's
  latest init segment and the last `HOLD_BYTES` of appended audio while no session runs, and
  hands everything to the overlay when a session attaches (`globalThis.__murmurTee`). So turning
  subtitles on mid-video starts with what the player already buffered. It reads the settings at
  `document_start` and switches the tee off at once when lookahead is off for the site.
- The overlay forwards the relay's events on its own port (bytes as base64: runtime ports
  serialize as JSON) and reports where its video is (`PlayheadReport`: timeline, content key,
  ad, `currentTime`, rate, paused) on every playback event and about once a second.

## Offscreen: from bytes to cues

- `mirror.ts` mirrors one SourceBuffer: demuxes (`fmp4.ts`, `webm.ts`: streaming, any slice
  sizes, resync after skipped bytes), adds the append's `timestampOffset`, drops frames outside
  the append window, skips `sequence` mode, and marks jumps (> 50 ms).
- `decode.ts` decodes with WebCodecs, one `AudioDecoder` per contiguous run (Chrome's AAC decoder
  keeps its output times continuous across input jumps, so a single decoder mislabels audio after
  a seek), downmixes and resamples to 16 kHz, placing output by counting samples from the run's
  first frame.
- `pcm.ts` stores it per timeline (MediaSource or progressive URL) as 16-bit samples in 1 s
  blocks; `host.ts` caps the total at `PCM_CAP_S` (10 min), dropping what's far from the playhead
  first. `SourceBuffer.remove()` ahead of the playhead voids the audio and the cues made from it
  (a language switch, a re-fetch); behind it, only the audio goes.
- `progressive.ts`: `<video src="….mp4">` without MSE. Reads the index (`moov`, at the start or
  the end) with a few small range reads, then only the byte ranges holding audio near the
  playhead. A file on the page's origin is read through the page (its cookies); anything else by
  the offscreen document, under the person's site permissions (plain CORS without them).
- `runner.ts` + `scheduler.ts` run the same `Pipeline` (Silero VAD → segmenter → ASR → MT) over
  the decoded audio, in batch mode (finals only, no catching up). Rules: the stretch at the
  playhead first, never behind it, at most `HORIZON_S` (90 s) ahead, at most `IN_FLIGHT_S` pushed
  beyond what's finished. A stretch is processed once every segment starting in it has its
  finished cue. While processed audio reaches `PAUSE_LIVE_S` (3 s) past the playhead the live
  pipeline stops recognizing (capture and its activity tracking go on); under `RESUME_LIVE_S`
  (1.5 s) it starts again. A seek out of the job's stretch, or audio removed under it, drops the
  job at once (its unfinished cues are dropped in the overlay too).
- Translation: a line made ahead of time may take until `LOOKAHEAD_MARGIN_MS` (1 s) before the
  playhead reaches it, at least a live line's 3 s and at most `LOOKAHEAD_BUDGET_CAP_MS` (20 s),
  before Chrome's translator does it instead (`lookaheadBudgetMs`, from the runner's
  `untilShownMs`; paused: the cap). Gemma takes finished lines by when they are due, so live
  lines (due in 3 s) and the lines nearest the playhead go first.
- Processed spans and cues are kept per content key: a site's id for the video (YouTube's `v`),
  else the timeline, so a video coming back in a new MediaSource after an ad isn't redone. Ads
  (`.ad-showing`) are never subtitled ahead.

## Showing cues (overlay)

- `Cue.origin` says where a cue came from; lookahead cues carry `Cue.media` (timeline, start, end
  in media seconds) and no epoch times.
- `src/overlay/mediacues.ts` keeps cues by media time and shows them with the same layout rules
  as live lines (`CaptionStore`, run on media milliseconds): from the cue's start, held at least
  to the end of its speech. The controller redraws on every animation frame while playing (only
  when something is due) and on seek, pause, rate change and `timeupdate`, at
  `t = currentTime − lag` (the session plays captured tab audio back about 0.1 s late; the test
  tone has no lag).
- Where lookahead has finished subtitles (`coverage` messages), only its cues show. Elsewhere live
  lines show as before. Live lines are also placed on the timeline (`MediaClock`); one that
  mostly repeats a kept cue isn't shown, and a lookahead cue replaces the live ones it covers.
  Seeking back shows kept cues at once.
- The overlay keeps at most `MAX_MEDIA_CUES` (3000), dropping those far from the playhead.

## Limits and extension points

- MSE in a worker (Twitch: `MediaSourceHandle`) needs the tee installed inside the worker:
  `installTee(global, …)` takes the global for that; wrapping `Worker` is not done yet.
- Bilibili, Twitch: add to `sites.ts` (content key, ads).
- Players that create their MediaSource before the page scripts are registered (lookahead turned
  on mid-video) need a page reload; the popup says so.
- Encrypted media (CENC, WebM encryption) is detected and skipped.
- `srcObject = mediaSource` (no blob URL) isn't mapped to a timeline.
