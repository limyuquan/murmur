# Murmur

Live translated subtitles over any video in Chrome. Murmur listens to the tab, turns speech into
text, translates it, and draws the subtitles on the video, all on your own machine.

> **Status: early.** Real speech recognition and translation run in the browser: Chrome's own
> on-device speech recognition and translator (Light), or speech recognition and a translation
> model (Gemma 4) on the graphics card (Balanced, Best). The optional companion app comes next.

## For humans

**What it does**

- **Any video, any site.** Murmur hears the tab's audio, so it works with whatever player the
  page uses, in any frame layout, without site-specific code.
- **Subtitles on the picture.** They sit over the video itself (not the black bars), scale with
  it, and follow it through scrolling, resizing and fullscreen. They move up while the player
  shows its controls, and you can drag them anywhere; Murmur remembers the spot for each site.
- **Laid out like TV subtitles.** Two lines at most, broken at natural points, each held long
  enough to read. Box, shadow or outline, in the size you like.
- **Original and translation.** Show both lines, only the translation, or only what was said.
  Each line is translated on its own, so a video that switches language mid-way is fine, and so
  is a line that switches inside it; a line in a different language from the rest gets a small
  tag (such as `DE`).
- **Text appears as it's heard.** Words that may still change are shown dimmed until they settle.
- **Or ahead of time (beta).** On sites you choose, Murmur reads the audio the video player has
  already loaded and makes the subtitles before the speech plays, so each line appears right on
  time, and straight away when you seek back. Turn it on per site in the popup ("Show subtitles
  ahead of time"); it needs the Balanced or Best model size. Where the player has nothing loaded
  yet (an ad, a jump far ahead), subtitles come as they're heard.
- **Pick a model size.** Light uses Chrome's built-in speech recognition and translation (Chrome
  downloads a small pack per language, after one click). Balanced and Best run speech
  recognition on the graphics card (Whisper: a 1.6 GB download, once; 80 to 210 MB for the small
  model on devices without a suitable graphics card) and a translation model that reads the
  lines before each one: Gemma 4 E2B in Balanced (2.0 GB more), the larger E4B in Best (3.0 GB
  more, for a graphics card with its own memory). Where the translation model doesn't fit, or
  until you download it, Chrome's translator translates (the popup offers the download).
  Murmur suggests a size that suits your device.
- **Your names and terms.** List names and terms with how they should be written (Settings →
  Glossary). The translation model uses your spelling when a line mentions one, or something
  that sounds close.
- **Say what you listen to.** Tick the languages in the videos you watch. Each line's language is
  still detected, so videos that switch language work.
- **Stays on your machine.** No account, no telemetry. Audio never leaves your computer. The only
  network use is downloading a model when you click Download (from Hugging Face; a stopped
  download picks up where it left off), and Chrome's own language packs. With subtitles ahead of
  time on, a video played straight from a file (no streaming player) is read ahead from the
  same server the video comes from, as the player would; a server on another site that doesn't
  let the page read it is read by Murmur itself, which that server can see.

<a id="install"></a>**Install** (not on the Chrome Web Store)

1. Download `murmur-chrome.zip` from the
   [latest release](https://github.com/limyuquan/murmur/releases/latest) and unzip it. Keep the
   folder somewhere permanent: Chrome loads the extension from it.
2. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked** and
   choose the unzipped folder.
3. Pin Murmur to the toolbar.

To update, download the new zip, replace the folder's contents, then click ↻ on Murmur's card in
`chrome://extensions`. Works in Chrome 120+ and other Chromium browsers.

<details>
<summary>Or build it from source</summary>

Install [Node.js](https://nodejs.org) 22 or newer, then:

```sh
git clone https://github.com/limyuquan/murmur.git && cd murmur
corepack enable && pnpm install && pnpm build
```

Load `murmur/.output/chrome-mv3` the same way. On a Mac, press `⌘⇧.` in the file picker to show
the hidden `.output` folder. To update: `git pull && pnpm build`, then ↻.

</details>

**Use**

| | |
|---|---|
| Open Murmur | Click the toolbar icon, or press `Alt+Shift+E` (change it at `chrome://extensions/shortcuts`) |
| Subtitles on this tab | Turn on the switch, or press `Alt+Shift+S`. Chrome shows its "sharing this tab" indicator while Murmur listens |
| Stop | Turn the switch off, press `Alt+Shift+S` again, or close the tab |
| Move subtitles | Drag them. Double-click to put them back |
| Languages, model size, how subtitles look | **Settings** in the popup |

**Limits**

- **One tab at a time.** Turning Murmur on in another tab stops it in the first.
- **Protected video (DRM)** is silent to extensions, so there is nothing to transcribe. Most
  paid streaming services are in this group.
- **When the tab goes to another site**, subtitles follow if Murmur can reach the new page (or
  you allowed it on all sites) and it has a video. Otherwise they stop, and the popup says why:
  turn them on again there.
- **Players inside frames from another site** show subtitles at the bottom of the window instead
  of on the player, unless you allow Murmur on all sites (coming with the settings for it).
- **Subtitles arrive after the speech**, by the time the models need. Expect a second or two,
  unless subtitles ahead of time are on for the site and the player has loaded that part.
- **Ahead of time needs a reload** the first time it is turned on for a site, and works with
  players that load media in the page itself (most sites) and with Twitch's videos. Live streams
  get subtitles as they're heard.

---

## For LLMs

This section is for coding agents (Claude Code, Codex, Cursor and others) working on this repo or
setting it up for someone. Run commands from the repo root and keep every browser headless.

### 1. Ground rules

- **Never open a visible browser window.** Every test and script here runs headless.
- **Pinned versions are deliberate.** WXT is a 0.x release and is pinned exactly, as is every
  other dependency (`.npmrc` has `save-exact`). Don't bump them unless asked.
- **Keep the permissions minimal.** The manifest asks for `tabCapture`, `offscreen`, `activeTab`,
  `scripting`, `storage` and `unlimitedStorage`, and declares `<all_urls>` only as an *optional*
  host permission requested at runtime. Don't add `tabs`, `webRequest`, `debugger`,
  `desktopCapture` or install-time host permissions. `scripts/verify-zip.mjs` enforces this.
- **No remote code.** Bundle every script and WebAssembly file (point ONNX Runtime / similar at
  local `wasmPaths`; LiteRT-LM's WebAssembly is copied to `litert/` at build time and the LLM
  worker names it). Model weights downloaded at runtime are data and are fine, but only after
  the user agrees to the download.
- **No network otherwise.** No telemetry, no analytics, no calls home. The one exception is
  lookahead's reads of a progressive video file (`src/lookahead/progressive.ts`): through the page
  first, else from the offscreen document (its `Origin` is the extension's).
- **Plain TypeScript in pages.** `src/overlay/` runs inside other people's pages: no React, no
  Tailwind, all styles inside the closed shadow root.
- **Generic names.** Use neutral examples in code, tests and docs (`example.com`, `fr` → `en`).
  Don't describe the project in terms of a particular language or kind of content.
- **Ask before tagging.** Releases are public.

### 2. Set up and build

```sh
node -v                     # must be >= 22
corepack enable             # provides pnpm 10 (pinned in package.json)
pnpm install                # also runs `wxt prepare`
pnpm build                  # production build → .output/chrome-mv3 (fixed ID via manifest key)
pnpm zip                    # release zip → .output/murmur-<version>-chrome.zip
```

Loading the extension into the person's own Chrome has to be done by the person: branded Chrome
ignores `--load-extension`, and you must not drive their browser. Tell them: open
`chrome://extensions` → Developer mode → Load unpacked → choose `.output/chrome-mv3`. After a
rebuild, they click ↻ on the card. The fixed extension ID is `mpfdaijhgpignpnhmpeimfdedmgjdfim`
(`src/shared/ids.ts`); the private half of its key was never kept.

### 3. Verify (all headless)

```sh
pnpm check          # typecheck + Biome + Vitest unit tests
pnpm test:e2e       # e2e build + Playwright with bundled Chromium
```

- One-time setup: `pnpm exec playwright install chromium`.
- A change is done when both are green.
- The e2e build (`pnpm build:e2e` → `.output/chrome-mv3-e2e`) adds `<all_urls>` and the
  `__murmur` service-worker hooks (`src/shared/e2e.ts`), and opens the overlay's shadow root so
  tests can read it. All of that is stripped from other builds. Its sessions capture a synthetic
  test tone, because headless Chromium plays no tab audio; `capture.spec.ts` still exercises the
  real tab-capture handshake (Chromium is started with `--allowlisted-extension-id`).
- Fixture pages live in `tests/fixtures/pages/`, served on `http://127.0.0.1:4392/` by
  `scripts/serve-fixtures.mjs`, and again on port 4393, another origin, for frames from another
  site (`frames.html`). The lookahead pages use hls.js, dash.js and Shaka (pinned dev
  dependencies, served from node_modules at `/lib/`) on synthetic media (tone bursts) made by
  `scripts/make-lookahead-media.sh` (ffmpeg; Opus and VP9, since Playwright's Chromium has no AAC
  or H.264). `__murmur.lookahead(site, on)` turns lookahead on for a site in e2e builds, and
  `__murmur.offscreenLog()` returns the offscreen document's lookahead cues and state. The same server stands in for Hugging Face at `/hf/`: e2e builds
  download models from there (every file in `src/engines/*/files.json`, at its real size,
  filled with a pattern, at `FIXTURE_HF_MBPS` MB/s, default 40). With `FIXTURE_HF_DIR=<dir>` it
  serves real files where `<dir>` has them (`<dir>/<repo>/<path>`, else `<dir>/<path>`).
- If `playwright test` hangs before any test starts, the machine may hang on connections to a
  closed localhost port instead of refusing them (seen with WSL mirrored networking). Start
  `node scripts/serve-fixtures.mjs` yourself first; Playwright reuses it.
- Don't run `pkill -f "playwright test"`: it kills other agents' runs too. To run suites in
  parallel, set `MURMUR_E2E_ID=<x>` so each gets its own e2e build folder.

### 4. Repo map

| Path | What lives there |
|---|---|
| `src/entrypoints/background.ts`, `src/background/` | Service worker: the one session (start/stop, state in `storage.session`), badge, popup dispatcher |
| `src/entrypoints/offscreen/`, `src/offscreen/host.ts` | Offscreen document (`USER_MEDIA`): capture graph, engines, pipeline, cues to the overlay |
| `src/capture/` | Stream ID + offscreen lifecycle (SW side), audio sources, capture graph, AudioWorklet, resampler, clock |
| `src/pipeline/` | Speech detectors (Silero VAD in `silero.ts`, run ahead of the segmenter by `vadstage.ts`; the energy gate in `vad.ts`), segmenter and its sentence-end detector (`sentence.ts`), orchestration (ASR → translation → cues), per-segment language |
| `src/engines/` | Engine interfaces (`types.ts`), registry (`builtin.ts`) and factories (`factories.ts`, offscreen only), hardware checks, model profiles, Chrome engines (`chrome/`), Whisper (`whisper/`), Qwen3-ASR (`qwen3asr/`), the segment session both use (`segments.ts`), Gemma 4 translation (`llm/`), the glossary matcher (`glossary.ts`) and what a session wraps around its translator (`translators.ts`: glossary, per-line fallback), demo engines (e2e builds only) |
| `src/overlay/`, `src/entrypoints/overlay.ts` | Injected script: picks the video, positions the shadow-DOM overlay, draws cues (live ones by wall clock, lookahead ones by `video.currentTime`: `mediacues.ts`) |
| `src/lookahead/`, `src/entrypoints/tee.ts`, `tee-relay.ts`, `src/background/lookahead.ts` | Subtitles ahead of time (beta): page tee and relay (registered per site), demuxers, WebCodecs decode, PCM store, scheduler and runner, progressive MP4 by range. Design in [src/lookahead/README.md](src/lookahead/README.md) |
| `src/messaging/` | Every message type between contexts (`protocol.ts`), who may send each (`senders.ts`), popup → SW client |
| `src/settings/` | Settings type, defaults, validation, storage; dragged positions per site (`positions.ts`) |
| `src/models/` | Downloadable models: catalog per profile and device, download manager (runs in the SW), Cache API store (`store.ts`) and the reader model workers use (`hub.ts`) |
| `src/entrypoints/popup/`, `options/`, `welcome/` | React + Tailwind extension pages (welcome opens on install) |
| `src/ui/` | Shared React components, hooks and copy for those pages; tokens in `src/styles/app.css` |
| `tests/unit`, `tests/e2e` | Vitest (pure logic) and Playwright end-to-end |
| `scripts/` | Fixture server, icon renderer (`pnpm icons`), release-zip check |

### 5. How a session flows

1. The toolbar click opens the popup, which grants `activeTab` for the tab. The switch sends
   `start` to the service worker.
2. The service worker creates the single offscreen document, injects `overlay.js` into every
   frame, then mints a tab stream ID (single-use, expires in seconds, so last) and sends the
   offscreen document a `start` command with the session config.
3. The offscreen document opens the tab audio with `getUserMedia`, plays it back (capturing mutes
   the tab), and runs it through the AudioWorklet: downmix, windowed-sinc resample to 16 kHz mono,
   20 ms frames stamped with the epoch time they are heard. It answers `start` once the capture is
   open, then loads the engines, reporting progress and any failure (with its code, pack buttons
   or missing models) as `session-status` events, so a stop never waits for a load.
4. A speech detector scores each 32 ms of audio: Silero VAD (`src/pipeline/silero.ts`, 2.3 MB,
   bundled in `src/assets/silero-vad/`, on ONNX Runtime's WebAssembly in the offscreen document,
   under 2% of a core), which tells speech from music. It loads alongside the engines; if it
   can't, or fails later, the loudness gate (`vad.ts`) takes over. Engines that listen to the
   track, and the demo engines, always get the loudness gate.
   The segmenter cuts speech segments from those scores (`src/pipeline/segmenter.ts`, every
   parameter in one `SegmenterConfig`). By default a segment ends at a 250 ms pause once it is
   1 s long, already at a 150 ms pause when the words so far end a sentence (it asks the ASR
   session to decode up to the pause, `requestPartial`, and `sentence.ts` judges the text), and
   at 5 s at the least speech-like moment of its last second (a gap between words), the rest
   carrying over into the next segment. Engines that listen to the track get the older
   pause-only rule (`PAUSE_SEGMENTER`). The ASR session streams
   partial and final results, each with its own language. Finals are translated in order with
   recent lines as context; a segment already in the target language isn't translated, unless
   a meaningful part of it is in another one (`src/pipeline/mixed.ts`: another script at once,
   Chrome's `LanguageDetector` for finished lines in the target's own script); such a line goes
   to the translator marked `mixed`. A translator that `revises` (Gemma) is also handed the line
   before when the new line ends a sentence that line left open and its translation is still on
   screen (once per line); it translates that line again with the new one after it, and the
   overlay fades in the new translation if it changed materially. The next line never waits
   for a revision: it goes first and stops it.
5. Each change to a segment is sent as a whole `Cue` over the overlay's port. The overlay replaces
   it by id and lays it out (`src/overlay/linebreak.ts`, `captions.ts`): at most two segments,
   two rows per line, growing text filled so it never jumps, finished text balanced or paged and
   held for a reading time. The offscreen document also reports what the session is doing
   (`SessionActivity`) to the popup and a short status to the overlay's chip.
6. Stop closes the offscreen document; the overlay's port disconnects and it removes itself. A
   stop (or a start in another tab) cuts short a start under way, and status writes are checked
   against the session id, so a late report can't bring a stopped session back.
7. A navigation in the tab drops the overlay; the service worker puts it back when the page has
   loaded. If it can't (no access to another site without a click), or another site has no
   video, the session stops with code `navigated`.

### 6. Adding an engine

1. Implement `AsrEngine` or `TranslationEngine` from `src/engines/types.ts`. Run the model in a
   dedicated Worker (one per model, so unloading frees its memory) behind a thin proxy class.
2. Describe it with static info: runtime, `requirements` (backends, memory, GPU features,
   download size), languages, streaming, language detection.
3. Register a factory in `src/engines/builtin.ts` whose `create()` dynamic-imports the engine.
4. Put its id at the front of the profiles it suits in `src/engines/profiles.ts`. Profiles fall
   back down their list, then to the last resorts there, when an engine doesn't fit the device.
   An engine that only finds out at load that it can't run here throws `EngineUnavailableError`
   (`src/engines/errors.ts`); the session then tries its entry in `RUNTIME_FALLBACKS`.
5. List what it downloads in `info.models`: id, label, size and the exact files (`source`: a
   Hugging Face repo at a pinned commit, with each file's byte size and its hash on the Hub,
   `sha256:` for Git LFS files and `git-sha1:` for the others, checked after download), one entry
   per `backend` when the weights differ by backend. A file from another repo names it
   (`from: { repo, revision }`). Files Murmur makes itself go in `MURMUR_MODELS`
   (`src/models/hub.ts`); until that repo is published, an engine that needs them sets
   `info.unavailable` where models come from Hugging Face. The options page, welcome page and popup show
   and manage those; the service worker downloads them into the Cache API (`src/models/store.ts`)
   only when the person clicks Download. `load()` must never download: read the files with
   `modelFileCache(source)` / `readFile` (`src/models/hub.ts`) and throw
   `ModelError(message, ids, true)` when they aren't there.
6. Load progress goes through `LoadOptions.onProgress`; the popup and the overlay's chip show it.
   Honour `LoadOptions.signal`: a stop aborts it, and any wait (downloads, Chrome packs) should end
   with it. A part of the engine that stops for good while running reports an
   `EngineUnavailableError` to `onError`; the popup lists it.
7. Report failures with the errors in `src/engines/errors.ts`: `ModelError` (code `model`),
   `CompanionError` (`companion`), `EngineActionRequiredError` (`setup`, Chrome packs),
   `UnsupportedLanguageError` (a language it can't handle at all). Keep `SessionActivity` honest:
   the offscreen host feeds `ActivityTracker` (`src/offscreen/activity.ts`) with every frame,
   cue and `AsrHealth` report (backlog, real-time factor), which is how "falling behind",
   "no sound" and unsupported languages reach the popup. List `languages` / `sources` / `targets`
   accurately: they decide what the popup calls untranslatable.

### 7. The real engines

| Engine | What it is | Notes |
|---|---|---|
| `chrome-webspeech` | Chrome's on-device `SpeechRecognition` on the tab track | Always `processLocally = true`; refuses to run when Chrome can't promise on-device. One recognizer per spoken language (up to 4) runs all session; `chrome/arbiter.ts` picks, per segment, the one that heard its own language. |
| `chrome-translator` | Chrome's `Translator`, one per language pair | `LanguageDetector` checks each line's language when Chrome has it ready. |
| `qwen3-asr-0.6b` | Qwen3-ASR-0.6B on ONNX Runtime Web (pinned), WebGPU with `shader-f16` only, in a worker | First in Balanced. SubtitleKing's fp16 encoder at a pinned commit plus our 8-bit decoder, tied-embedding offsets and vocabulary from `MURMUR_MODELS` (`qwen3asr/files.json`, 1.1 GB). **Those files aren't published yet**, so production builds show it unavailable and Balanced runs turbo. Language per segment from the model's `language X` header (`language None` = no speech); partials every 1.5 s that re-decode only the last partial's tail; probes and finals decode from scratch, and a probe at the segment's end is its final; decoding stops at a token cap that grows with the audio or on a repetition loop; Whisper's scheduler and guards (`segments.ts`). |
| `gemma4-e2b`, `gemma4-e4b` | Gemma 4 E2B / E4B (`-web.litertlm`, `litert-community` at pinned commits, `llm/files.json`) on LiteRT-LM.js 0.19.0 (pinned), WebGPU, in a **classic** worker (`entrypoints/llm-worker.ts`: its glue uses `importScripts`) | First in Balanced (E2B) and Best (E4B, then E2B). Only the relaxed-SIMD + JSPI WebAssembly build ships (24 MB; Chrome 137+); older Chrome, no WebGPU or a failed load (out of graphics memory) hands over to Chrome's translator (`RUNTIME_FALLBACKS`). A model that isn't downloaded doesn't stop the session either (`MODEL_FALLBACKS`: E4B to E2B to Chrome's translator; `splitMissing` in `models/catalog.ts` tells the service worker which missing models block a start); the popup offers the download (`TabView.models.better`). The model loads as a Blob of the cached parts; unloading terminates the worker, the only way to free its graphics memory. Prompt v2 (`llm/prompt.ts`, byte for byte the benchmarked one): earlier lines with their languages, the glossary entries the line uses, the line's own language. Number words in the lines reach the model as digits where they are plainly numbers (`llm/numbers.ts`: before a counter, or beside another number; Sino-Korean, native Korean, Japanese and Chinese numerals; 백오십 원 → 150 원, 三百で → 300で; words such as 세대, 천만에요, 百度 and 十人十色 stay); the subtitle keeps what was said. One generation at a time, finished lines before previews and revisions (`request.previous`: the line before, retranslated with the line that ends its sentence as `NEXT`, sent as `revises` only when it changes materially, `worthRevising` in `llm/output.ts`); drafts stream to the overlay; answers are cleaned and rejected when they repeat a context line or run away (`llm/output.ts`). A finished line gets 3 s (`LINE_BUDGET_MS`), then Chrome's translator does it and the popup says so; a line made ahead of time (lookahead) gets until 1 s before it shows, 3 to 20 s (`lookaheadBudgetMs`), and finished lines are generated in the order they are due, so a live line goes before one that shows later. Profiles pick it by a graphics-memory guess (`estimateGpuMemoryMB`: WebGPU doesn't report memory). Measured on an RTX 3070: E2B first token ~140 ms, ~90 tokens/s; E4B ~430 ms, ~60 tokens/s. |
| `whisper-base`, `whisper-large-v3-turbo` | transformers.js (pinned) in a worker per model | WebGPU, WebAssembly fallback (base only). Weights from Hugging Face at pinned revisions (`whisper/files.json`), one download per backend, read from the model cache with the network off. Language detected per segment; partials about every second, a final per segment; hallucination guards in `whisper/filters.ts`. |

- **Chrome language packs need a click.** Chrome only starts a speech or translation pack
  download from a user gesture, and reports packs per site (a new origin sees `downloadable`
  even when the pack is on disk; the click then finishes at once). Engines reject loading with
  `EngineActionRequiredError`; the session status says `code: 'setup'` with `setup` actions,
  and a page runs each with `runSetupAction(action)` (`src/engines/chrome/setup.ts`) straight
  from the click handler, one action per click (`SetupButtons` in the popup, `ChromePacks` in
  options and welcome, `src/ui/setup.tsx`). A running session lists packs it met later in
  `setup` too.
- **Spoken languages** (a setting; empty means the browser's languages).
  `SessionConfig.spokenLanguages` tells Chrome speech which recognizers to run (the first 4) and
  Chrome translation which packs to check; with `onlySpoken`, Whisper and Qwen3-ASR pick each
  line's language among them only.
- **No COEP/COOP.** Cross-origin isolation breaks tab capture; threaded WebAssembly works
  without it. The manifest adds only `'wasm-unsafe-eval'` for ONNX Runtime and LiteRT-LM, which
  ship in the extension.
- **Glossary** (a setting). `SessionConfig.glossary` carries it to the offscreen document;
  `withGlossary` (`translators.ts`) gives each request the entries its line or context uses
  (`glossary.ts`: whole words, or anywhere in unspaced scripts; short Korean names need a
  boundary; light fuzzy matching for misheard names). Only engines with `usesGlossary` get it.
- **Real-model checks** need a real Chrome with a GPU and language packs, so they aren't in
  `pnpm test:e2e`. Build with `WXT_MODEL_HOST=https://huggingface.co pnpm build:e2e` so models
  download from Hugging Face, download them on the options page, then the e2e build's
  `__murmur.start(tabId, 'tab', 'settings')` runs the engines the settings choose (the default
  `'demo'` keeps Playwright offline), and the offscreen
  document logs every cue and Chrome speech arbitration on `globalThis.__murmurLog`. Drive it
  over CDP from a separate, temporary Chrome profile. With puppeteer over a pipe, send nothing
  else to the browser while `start()` runs: a second CDP call then made Chrome 157 drop the
  connection.
  Qwen3-ASR before its files are published: put them in a folder, run
  `FIXTURE_HF_DIR=<folder> node scripts/serve-fixtures.mjs` and use the plain e2e build, which
  downloads from that server. `__murmurLog.decodes` lists each of its decodes (kind, audio and
  decode ms, tokens, text). `__murmurLog.vad` names the session's speech detector and the time
  it has spent so far. The same folder can hold the Gemma files (`<repo>/<file>`), which saves
  a 2–3 GB download (hashes are checked only for downloads from Hugging Face). A line's
  latency is in `__murmurLog.cues`: its cue's `endEpochMs` (end of speech) against the `at` of
  the first cue with a final translation. `__murmurLog.startup` says when the capture opened,
  each engine was loaded and warmed up (`asr`, `translation`) and live subtitles started
  (`pipeline`): how late the first line is after a start.

### 8. Known limits

Headless tests can't check these, so ask a human after related changes:

- the real toolbar click, shortcut and badge;
- that captured tab audio stays audible (playback through the offscreen document);
- fullscreen placement (container fullscreen; a top-layer popover for `<video>` fullscreen, a
  fullscreen frame from another site and a web-component player);
- real players on real sites, including moving clear of their controls (listed players in
  `src/overlay/sites.ts` are measured; others use pointer activity and pause);
- lookahead on real sites (YouTube signed in: 10+ minutes, seeks outside the buffer, ads, quality
  changes; other players the person uses), and that their players never stall or error with it.
  Automated fresh profiles can't play YouTube for more than about a minute.

## License

[MIT](LICENSE). Gemma 4 (downloaded on request) is © Google, Apache-2.0; LiteRT-LM.js (bundled)
is © Google, Apache-2.0 ([NOTICE](NOTICE)). The bundled Silero VAD model is © Silero Team, MIT
([src/assets/silero-vad/LICENSE](src/assets/silero-vad/LICENSE)). Test clips carry their own
licences ([tests/unit/fixtures/vad/README.md](tests/unit/fixtures/vad/README.md)).
