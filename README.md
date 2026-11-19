# Earshot

Live translated subtitles over any video in Chrome. Earshot listens to the tab, turns speech into
text, translates it, and draws the subtitles on the video, all on your own machine.

> **Status: foundation.** The capture → subtitles path works end to end, but only with demo
> engines that show *when* sound was heard instead of words. Real speech-recognition and
> translation models plug into the same interfaces next.

## For humans

**What it does**

- **Any video, any site.** Earshot hears the tab's audio, so it works with whatever player the
  page uses, in any frame layout, without site-specific code.
- **Subtitles on the picture.** They sit over the video itself (not the black bars), scale with
  it, and follow it through scrolling, resizing and fullscreen.
- **Original and translation.** Show both lines, only the translation, or only what was said.
  Each line is translated on its own, so a video that switches language mid-way is fine.
- **Text appears as it's heard.** Words that may still change are shown dimmed until they settle.
- **Pick a model size.** Light, Balanced or Best, or choose engines yourself. Earshot suggests one
  that suits your device.
- **Stays on your machine.** No account, no telemetry. Audio never leaves your computer. The only
  network use will be downloading a model you choose, once.

<a id="install"></a>**Install** (not on the Chrome Web Store)

1. Download `earshot-chrome.zip` from the
   [latest release](https://github.com/limyuquan/earshot/releases/latest) and unzip it. Keep the
   folder somewhere permanent: Chrome loads the extension from it.
2. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked** and
   choose the unzipped folder.
3. Pin Earshot to the toolbar.

To update, download the new zip, replace the folder's contents, then click ↻ on Earshot's card in
`chrome://extensions`. Works in Chrome 120+ and other Chromium browsers.

<details>
<summary>Or build it from source</summary>

Install [Node.js](https://nodejs.org) 22 or newer, then:

```sh
git clone https://github.com/limyuquan/earshot.git && cd earshot
corepack enable && pnpm install && pnpm build
```

Load `earshot/.output/chrome-mv3` the same way. On a Mac, press `⌘⇧.` in the file picker to show
the hidden `.output` folder. To update: `git pull && pnpm build`, then ↻.

</details>

**Use**

| | |
|---|---|
| Open Earshot | Click the toolbar icon, or press `Alt+Shift+E` (change it at `chrome://extensions/shortcuts`) |
| Subtitles on this tab | Turn on the switch. Chrome shows its "sharing this tab" indicator while Earshot listens |
| Stop | Turn the switch off, or close the tab |
| Languages, model size, how subtitles look | **Settings** in the popup |

**Limits**

- **One tab at a time.** Turning Earshot on in another tab stops it in the first.
- **Protected video (DRM)** is silent to extensions, so there is nothing to transcribe. Most
  paid streaming services are in this group.
- **After the page navigates** to another site, click the button again to bring subtitles back.
- **Players inside frames from another site** show subtitles at the bottom of the window instead
  of on the player, unless you allow Earshot on all sites (coming with the settings for it).
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
pnpm zip                    # release zip → .output/earshot-<version>-chrome.zip
pnpm zip:store              # Chrome Web Store zip (no key) → .output/earshot-<version>-chrome-store.zip
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
  `__earshot` service-worker hooks (`src/shared/e2e.ts`), and opens the overlay's shadow root so
  tests can read it. All of that is stripped from other builds. Its sessions capture a synthetic
  test tone, because headless Chromium plays no tab audio; `capture.spec.ts` still exercises the
  real tab-capture handshake (Chromium is started with `--allowlisted-extension-id`).
- Fixture pages live in `tests/fixtures/pages/`, served on `http://127.0.0.1:4392/` by
  `scripts/serve-fixtures.mjs`.
- If `playwright test` hangs before any test starts, the machine may hang on connections to a
  closed localhost port instead of refusing them (seen with WSL mirrored networking). Start
  `node scripts/serve-fixtures.mjs` yourself first; Playwright reuses it.
- Don't run `pkill -f "playwright test"`: it kills other agents' runs too. To run suites in
  parallel, set `EARSHOT_E2E_ID=<x>` so each gets its own e2e build folder.

### 4. Repo map

| Path | What lives there |
|---|---|
| `src/entrypoints/background.ts`, `src/background/` | Service worker: the one session (start/stop, state in `storage.session`), badge, popup dispatcher |
| `src/entrypoints/offscreen/`, `src/offscreen/host.ts` | Offscreen document (`USER_MEDIA`): capture graph, engines, pipeline, cues to the overlay |
| `src/capture/` | Stream ID + offscreen lifecycle (SW side), audio sources, capture graph, AudioWorklet, resampler, clock |
| `src/pipeline/` | VAD hook, segmenter, orchestration (ASR → translation → cues), per-segment language |
| `src/engines/` | Engine interfaces (`types.ts`), registry, hardware checks, model profiles, demo engines |
| `src/overlay/`, `src/entrypoints/overlay.ts` | Injected script: picks the video, positions the shadow-DOM overlay, draws cues |
| `src/messaging/` | Every message type between contexts (`protocol.ts`), popup → SW client |
| `src/settings/` | Settings type, defaults, validation, storage |
| `src/entrypoints/popup/`, `src/entrypoints/options/` | React + Tailwind extension pages |
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
   it by id, keeps the newest two, dims what may still change, and holds finished lines for a
   reading time.
6. Stop closes the offscreen document; the overlay's port disconnects and it removes itself.

### 6. Adding an engine

1. Implement `AsrEngine` or `TranslationEngine` from `src/engines/types.ts`. Run the model in a
   dedicated Worker (one per model, so unloading frees its memory) behind a thin proxy class.
2. Describe it with static info: runtime, `requirements` (backends, memory, GPU features,
   download size), languages, streaming, language detection.
3. Register a factory in `src/engines/builtin.ts` whose `create()` dynamic-imports the engine.
4. Put its id at the front of the profiles it suits in `src/engines/profiles.ts`. Profiles fall
   back down their list, then to the demo engines, when an engine doesn't fit the device.
5. Load progress goes through `LoadOptions.onProgress`; the popup shows it.

### 7. Known limits

Headless tests can't check these, so ask a human after related changes:

- the real toolbar click, shortcut and badge;
- that captured tab audio stays audible (playback through the offscreen document);
- fullscreen placement (container fullscreen and `<video>` fullscreen via a top-layer popover);
- real players on real sites.

## License

[MIT](LICENSE)
