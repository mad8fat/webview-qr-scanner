# Changelog

## 0.1.0 — 2026-10-21

First public version.

### Core (`src/cam-scanner.js`)

- `CamScanner.create(options)` with `start()`, `pause()`, `resume({ resetDedupe })`,
  `resetDedupe()`, `stop()`, `setZoom(level)`, `setTorch(on)`, `getState()`.
- Decoding through ZBar compiled to WebAssembly (`wasm/zbar.js` + `wasm/zbar.wasm`, from koder,
  unmodified) with an ES5 wrapper inlined in the core (logic derived from koder's `koder.js`,
  MIT): hidden canvas with `willReadFrequently`, `getImageData`, one `requestAnimationFrame` loop.
- Loading order: `wasm/zbar.js` → `src/cam-scanner.js`; only `zbar.wasm` is fetched from
  `wasmDir` (trailing slashes ignored).
- Per-page WASM cache: with the built-in wrapper, ZBar is initialised once per `wasmDir` and
  shared by every scanner (a camera switch no longer loads a new instance); a failed load is
  retried by the next `start()`.
- Camera request for the rear camera at 1920×1080 (at least 1280×720) with continuous focus,
  exposure and white balance; one retry with soft constraints, no retry after a denied
  permission.
- Digital zoom by cropping the centre of the frame (default 2x), with matching visual zoom of the
  `<video>`.
- Deduplication: the same code once until reset (default), or a sliding `dedupeMs` window.
- `stop()` returns a Promise, switches the torch off (at most 300 ms wait), stops every track.
- A refused `video.play()` is reported as `onError({ code: 'camera', message: 'video.play() rejected' })`
  so the page can offer a tap that calls `resume()`.
- Track-ended detection: when the camera track ends (another app took the camera, permission
  revoked, camera unplugged), the scanner releases the camera, goes to `idle` and reports
  `onError({ code: 'camera', message: 'camera track ended' })`.
- `start()` never rejects; every failure goes to `onError` with code `wasm`, `camera`, `decode`
  or `torch`.
- Experimental torch: `setTorch(on)` resolves to `'on'` or `'off'`, trusting the requested state
  when the browser does not report the torch; `'unsupported'` only on an explicit mismatch, a
  rejected request or no camera track.
- `env` option to inject browser globals, `CreateKoder` and `Koder` for tests.

### Parsers

- `FnsReceipt.parse(text, { strict })` for Russian fiscal receipt QR codes: `fn`, `fd`, `fp`,
  `date`, `time`, `amount`, `n`, `raw`; length rules checked against real receipts;
  `parse.lastError` explains a `null`.

### Repository

- `npm test` (Node built-in test runner, no dependencies).
- `npm run check`: WASM checksums against `wasm/NOTICE`, forbidden-string scan, README sections.
- README in English and Russian, manual device test protocol (`docs/manual-test.md`).
- Licence files: koder's MIT licence text in `wasm/NOTICE` (koder pinned at commit
  `6f8bebd2ad454ed5320b6519cb932cc52a4af9fa`), the full GNU LGPL 2.1 text in
  `wasm/LICENSE.LGPL-2.1.txt`.
- Package metadata in `package.json` (repository, homepage, bugs, author, keywords);
  `"private": true` until npm publishing is decided.
- `.nojekyll` for GitHub Pages.
