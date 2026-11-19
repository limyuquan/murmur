# Murmur

Live translated subtitles over any video in Chrome. Murmur listens to the tab, turns speech into
text, translates it, and draws the subtitles on the video, all on your own machine.

> **Status: early.** Real speech recognition and translation run in the browser: Chrome's own
> on-device speech recognition and translator (Light), or Whisper on the graphics card with
> Chrome's translator (Balanced, Best). A dedicated translation model and the optional companion
> app come next.

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
  Each line is translated on its own, so a video that switches language mid-way is fine; a line
  in a different language from the rest gets a small tag (such as `DE`).
- **Text appears as it's heard.** Words that may still change are shown dimmed until they settle.
- **Pick a model size.** Light uses Chrome's built-in speech recognition and translation (Chrome
  downloads a small pack per language, after one click). Balanced and Best run Whisper on the
  graphics card (a 1.6 GB download, once; 80 to 210 MB for the small model on devices without a
  suitable graphics card). Murmur suggests one that suits your device.
- **Say what you listen to.** Tick the languages in the videos you watch. Each line's language is
  still detected, so videos that switch language work.
- **Stays on your machine.** No account, no telemetry. Audio never leaves your computer. The only
  network use is downloading a model when you click Download (from Hugging Face; a stopped
  download picks up where it left off), and Chrome's own language packs.

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
- **After the page navigates** to another site, click the button again to bring subtitles back.
- **Players inside frames from another site** show subtitles at the bottom of the window instead
  of on the player, unless you allow Murmur on all sites (coming with the settings for it).
- **Subtitles arrive after the speech**, by the time the models need. Expect a second or two.

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
  local `wasmPaths`). Model weights downloaded at runtime are data and are fine, but only after
  the user agrees to the download.
- **No network otherwise.** No telemetry, no analytics, no calls home.
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
  `scripts/serve-fixtures.mjs`. The same server stands in for Hugging Face at `/hf/`: e2e builds
  download models from there (every file in `src/engines/whisper/files.json`, at its real size,
  filled with a pattern, at `FIXTURE_HF_MBPS` MB/s, default 40).
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
| `src/pipeline/` | VAD hook, segmenter, orchestration (ASR → translation → cues), per-segment language |
| `src/engines/` | Engine interfaces (`types.ts`), registry (`builtin.ts`) and factories (`factories.ts`, offscreen only), hardware checks, model profiles, Chrome engines (`chrome/`), Whisper (`whisper/`), demo engines (e2e builds only) |
| `src/overlay/`, `src/entrypoints/overlay.ts` | Injected script: picks the video, positions the shadow-DOM overlay, draws cues |
| `src/messaging/` | Every message type between contexts (`protocol.ts`), popup → SW client |
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
   20 ms frames stamped with the epoch time they are heard.
4. The segmenter cuts speech segments (pre-roll, hangover, max length). The ASR session streams
   partial and final results, each with its own language. Finals are translated in order with
   recent lines as context; a segment already in the target language isn't translated.
5. Each change to a segment is sent as a whole `Cue` over the overlay's port. The overlay replaces
   it by id and lays it out (`src/overlay/linebreak.ts`, `captions.ts`): at most two segments,
   two rows per line, growing text filled so it never jumps, finished text balanced or paged and
   held for a reading time. The offscreen document also reports what the session is doing
   (`SessionActivity`) to the popup and a short status to the overlay's chip.
6. Stop closes the offscreen document; the overlay's port disconnects and it removes itself.

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
   Hugging Face repo at a pinned commit, with each file's byte size), one entry per `backend`
   when the weights differ by backend. The options page, welcome page and popup show and manage
   those; the service worker downloads them into the Cache API (`src/models/store.ts`) only when
   the person clicks Download. `load()` must never download: read the files with
   `modelFileCache(source)` / `readFile` (`src/models/hub.ts`) and throw
   `ModelError(message, ids, true)` when they aren't there.
6. Load progress goes through `LoadOptions.onProgress`; the popup and the overlay's chip show it.
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
  Chrome translation which packs to check; with `onlySpoken`, Whisper picks each line's language
  among them only.
- **No COEP/COOP.** Cross-origin isolation breaks tab capture; threaded WebAssembly works
  without it. The manifest adds only `'wasm-unsafe-eval'` for ONNX Runtime, which ships in the
  extension.
- **Real-model checks** need a real Chrome with a GPU and language packs, so they aren't in
  `pnpm test:e2e`. Build with `WXT_MODEL_HOST=https://huggingface.co pnpm build:e2e` so models
  download from Hugging Face, download them on the options page, then the e2e build's
  `__murmur.start(tabId, 'tab', 'settings')` runs the engines the settings choose (the default
  `'demo'` keeps Playwright offline), and the offscreen
  document logs every cue and Chrome speech arbitration on `globalThis.__murmurLog`. Drive it
  over CDP from a separate, temporary Chrome profile. With puppeteer over a pipe, send nothing
  else to the browser while `start()` runs: a second CDP call then made Chrome 157 drop the
  connection.

### 8. Known limits

Headless tests can't check these, so ask a human after related changes:

- the real toolbar click, shortcut and badge;
- that captured tab audio stays audible (playback through the offscreen document);
- fullscreen placement (container fullscreen and `<video>` fullscreen via a top-layer popover);
- real players on real sites, including moving clear of their controls (listed players in
  `src/overlay/sites.ts` are measured; others use pointer activity and pause).

## License

[MIT](LICENSE)
