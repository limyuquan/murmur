# Contributing

Issues and pull requests are welcome. For anything larger than a fix, open an issue first so we
can agree on the shape.

## Setup

Node.js 22+ and pnpm (`corepack enable`), then `pnpm i`.

## Before you open a PR

```sh
pnpm check      # typecheck, Biome lint/format, unit tests
pnpm test:e2e   # extension in headless Chromium
```

- Run `pnpm format` to fix formatting, including `pnpm-lock.yaml` after a dependency change.
- Tests and scripts run headless. Don't add anything that opens a visible browser window.
- Keep audio on the machine: no telemetry, no network requests other than a model download the
  user asked for. Bundle all code and WebAssembly; never load scripts from a CDN.
- Dependencies are pinned to exact versions; don't bump them in unrelated changes.
- Use generic names in code, tests and docs: `example.com`, `fr` → `en`.
- New engines follow [README → Adding an engine](README.md#6-adding-an-engine).

## Builds and releases

Every push to `main` uploads a build as a workflow artifact (`earshot-<sha>`), so you can try a
change without a release.

Releases are cut by the maintainer: bump `version` in `package.json`, commit, tag `v<version>` and
push the tag. `.github/workflows/release.yml` checks, builds and attaches `earshot-chrome.zip`,
`earshot-<version>-chrome.zip` and `SHA256SUMS`. Release zips come from `pnpm zip`, which keeps
the manifest `key` (fixed extension ID); `node scripts/verify-zip.mjs <zip>` checks that and the
permissions. `pnpm zip:store` drops the key and is only for a store upload.

By contributing you agree that your work is released under the [MIT License](LICENSE).
