# webview-qr-scanner

Camera QR/barcode scanner that works inside Telegram WebView (iOS/Android) and iOS Safari. ZBar WASM, ~355 KB, zero dependencies, no build step.

It reads QR codes and 1D barcodes from the rear camera and hands you the raw text plus the
symbology name. It is meant for the places where browser scanners usually break: Telegram Mini
Apps, the Telegram in-app browser, iOS Safari. Its defaults come from a production project with
real users, and the [Why it works](#why-it-works) section explains each one.

Русская версия: [README.ru.md](README.ru.md)

## What it is

- **A camera scanner core**, `src/cam-scanner.js`: opens the camera, feeds frames to ZBar, calls
  you back with `(text, type)`. Digital zoom, deduplication, pause/resume, torch, clean shutdown.
- **ZBar compiled to WebAssembly**: `wasm/zbar.wasm` (338 KB) and its Emscripten loader
  `wasm/zbar.js` (15 KB), taken unmodified from the [koder](https://github.com/maslick/koder)
  project. The small glue between ZBar and the scanner is built into `src/cam-scanner.js`.
- **Optional parsers** in `src/parsers/`. The first one is `FnsReceipt`: it turns the QR code
  printed on Russian fiscal (FNS) receipts into fields.
- **No dependencies, no build step, no framework.** The core and parsers are plain ES5 (the
  vendored Emscripten glue uses ES2015 features within the stated floor); you copy the files next
  to your page and load them with `<script>` tags. Works the same in a Telegram Mini App, a
  regular website or a WebView inside a native app.

Who it is for: developers who need "point the phone at a code, get the text" inside a Mini App
or a mobile web page, and who tried a scanner library that worked on the desktop and failed on
the phone.

## Demo

**[mad8fat.github.io/webview-qr-scanner/demo](https://mad8fat.github.io/webview-qr-scanner/demo/)**

<img src="docs/demo-qr.svg" alt="QR code with the demo link" width="160">

Scan the QR code above with your phone, or open the link in Telegram. The demo reads links,
receipt QR codes and product barcodes, and shows the zoom buttons (1x / 2x / 4x), the torch
toggle, camera switching and an in-page dialog that does not freeze the video.

## Quick start

1. Copy the `wasm/` and `src/` folders from this repository next to your page
   (`git clone https://github.com/mad8fat/webview-qr-scanner`, or download the ZIP).
2. Load the scripts in this order and create the scanner:

```html
<div style="width: 100%; max-width: 480px; aspect-ratio: 4 / 3; overflow: hidden;">
  <video id="cam" playsinline muted style="width: 100%; height: 100%; object-fit: cover;"></video>
</div>

<script src="wasm/zbar.js?v=0.1.0"></script>
<script src="src/cam-scanner.js?v=0.1.0"></script>
<script>
  var scanner = CamScanner.create({
    video: document.getElementById('cam'),
    wasmDir: 'wasm',
    onCode: function (text, type) { console.log(type, text); },
    onError: function (err) { console.log(err.code, err.message); }
  });
  scanner.start();
  window.addEventListener('pagehide', function () { scanner.stop(); });
</script>
```

- **Loading order matters:** `wasm/zbar.js` → `src/cam-scanner.js`
  (→ `src/parsers/fns-receipt.js` if you need it). `zbar.js` must come first: it defines the
  global `CreateKoder` that the core uses to start ZBar.
- **`wasmDir`** must point at the folder that contains `zbar.wasm`, relative to the page or as an
  absolute URL. The core needs only two files from `wasm/`: `zbar.js` (loaded by your `<script>`
  tag) and `zbar.wasm` (fetched from `wasmDir`). With the layout above it is `'wasm'`; from a page in a subfolder it is `'../wasm'`.
  Each `wasmDir` loads the WASM once per page: every further scanner (for example after a camera
  switch) reuses it.
- **The wrapper with `overflow: hidden`** keeps the visual zoom (a CSS `scale()` on the video)
  inside its box.
- **`?v=0.1.0` on every script** defeats the Telegram WebView cache: Telegram keeps old scripts
  for a long time, so bump the version on every release. `zbar.wasm` is requested by `zbar.js`
  under a fixed name, so if you ever replace ZBar (always `zbar.wasm` and `zbar.js` together),
  put the new files in a new folder, change `wasmDir` and bump the `?v=` of `zbar.js`.

### Requirements

- **Secure context: HTTPS, or `localhost` / `127.0.0.1`.** Browsers give camera access only to
  secure pages; the loopback addresses are the exception, which is handy for development.
- **`Content-Type: application/wasm`** for `zbar.wasm`. Without it the browser refuses streaming
  compilation, the glue code logs an error and falls back to a slower path. Most servers already
  send the right type; check with `curl -sI https://your.site/wasm/zbar.wasm`.
- **If you use a Content Security Policy**, `script-src` must allow WebAssembly:
  `'wasm-unsafe-eval'` on Chrome 97+ / Safari 16+, `'unsafe-eval'` on older engines.
- **Engines:** Chrome / Android WebView ≥ 57, Safari / iOS ≥ 11 (WebAssembly); WKWebView
  (Telegram iOS, in-app browsers) iOS ≥ 14.3 for `getUserMedia`; a WebView inside your own native
  app must grant camera access (Android `onPermissionRequest` + CAMERA permission, iOS
  `NSCameraUsageDescription`).

## API

### `CamScanner.create(options)` → scanner

Throws a `TypeError` if `options.video` is missing. Nothing else happens until `start()`.

| Option | Default | Meaning |
|---|---|---|
| `video` | (required) | The `<video>` element to show the camera in. The core sets `playsinline`, `muted` and `autoplay` on it. |
| `wasmDir` | `'wasm'` | Folder that contains `zbar.wasm` (trailing slashes are ignored). The WASM is loaded once per page for each `wasmDir` and shared by every scanner that uses it. |
| `zoom` | `2` | Digital zoom factor: the decoder sees the central `1/zoom` part of the frame. A value that is not a positive number becomes `1`. |
| `visualZoom` | `true` | Also scale the `<video>` with CSS `transform: scale(zoom)`, so the user sees what the decoder sees. It overwrites the `transform` of the `<video>`: to keep your own (a mirror, for example), set `visualZoom: false` and scale the video yourself. |
| `dedupeMs` | `0` | `0`: the same text is reported once until you reset the deduper. `> 0`: the same text is reported again after it has not been decoded for this many milliseconds. |
| `constraints` | built-in | Your own `getUserMedia` constraints for the first camera request, in the full shape, for example `{ video: { deviceId: { exact: id }, width: { ideal: 1920 }, height: { ideal: 1080 } } }`. They REPLACE the built-in constraints wholesale (nothing is merged, so ask for the resolution yourself). If this request fails, the core silently falls back to its built-in soft constraints (rear camera), unless the permission was denied. |
| `formats` | | Reserved, not used: ZBar reads every format it knows. Filter by `type` in `onCode`. |
| `torch` | `false` | Try to switch the torch on as soon as scanning starts (experimental, see below). |
| `onCode(text, type)` | | A code was decoded. `text` is the raw string, `type` is the ZBar symbology name, for example `'QR-Code'` or `'EAN-13'`. |
| `onStatus(state)` | | The state changed (see below). |
| `onError(error)` | | Something failed: `{ code, message, cause }`. |
| `env` | globals | A test seam: an object that replaces browser globals (`navigator`, `document`, `requestAnimationFrame`, `cancelAnimationFrame`, `setTimeout`), the ZBar factory `CreateKoder` (normally the global from `zbar.js`) and the decoder wrapper `Koder`. Used by the unit tests to run the core in Node with fakes; you normally leave it out. An injected `CreateKoder` or `Koder` is not shared between scanners. |

An exception thrown inside `onStatus` or `onError` does not break the scanner (it is re-thrown
asynchronously). An exception thrown inside `onCode` is reported as an `onError` with code
`decode`.

### Methods

| Method | What it does |
|---|---|
| `start()` → `Promise` | Loads the WASM, asks for the camera, starts scanning. The promise **never rejects**: every failure goes to `onError`. Calling it while the scanner is starting or running returns the same promise. It can be called again after `stop()`. |
| `pause()` | Stops decoding (only from `scanning`). The camera and the video keep running, so resuming is instant. |
| `resume(options)` | Continues decoding from `paused` (or `scanning`). Calls `video.play()` if the video was paused. `resume({ resetDedupe: true })` also forgets the last code. |
| `resetDedupe()` | Forgets the last code, so the same code can be reported again. |
| `stop()` → `Promise` | Switches the torch off (waits at most 300 ms for it), cancels the frame loop, stops every camera track and detaches the stream. Never throws. The promise resolves when the camera is released. |
| `setZoom(level)` | Changes the digital zoom at once (and the visual zoom, if enabled). |
| `setTorch(on)` → `Promise` | Resolves to `'on'`, `'off'` or `'unsupported'` (see 4 in [Why it works](#why-it-works)). Experimental, not production-verified. |
| `getState()` | The current state. |

### States

`idle` → `loading-wasm` → `requesting-camera` → `scanning` ⇄ `paused` → `stopped`

- `idle`: created, not started yet; also the state after a failed start and after the camera
  track ended.
- `stopped`: after `stop()`; `start()` works again from here.
- When a start fails, the state goes back to `idle` first and then `onError` is called.

### Error codes

| `code` | When |
|---|---|
| `wasm` | ZBar could not be loaded: `zbar.js` was not loaded before `start()` (`CreateKoder not found`), wrong `wasmDir`, `zbar.wasm` is missing, blocked by CSP. |
| `camera` | No camera, permission denied, the camera is busy, or the video could not be attached. Also `message: 'video.play() rejected'` when the browser refused to start the video (see 7 in [Why it works](#why-it-works)); in that case the state stays `scanning`. Also `message: 'camera track ended'` when the camera track ends while the scanner runs (another app took the camera, the permission was revoked, the camera was unplugged): the state goes to `idle`, the camera is released, and `start()` (a "Try again" button) opens it again. |
| `decode` | An exception while processing a frame, including one thrown by your `onCode`. |
| `torch` | The browser rejected the torch request. |

If the user denies camera permission (`NotAllowedError` or `SecurityError`), the core does not
ask a second time: the error goes straight to `onError` with code `camera`.

### Handling a refused `video.play()`

Some WebViews refuse to start a video that was not started by a tap. The core then reports
`onError({ code: 'camera', message: 'video.play() rejected' })` and keeps the camera open. Offer a
tap; a tap is a user gesture, and `resume()` called from it starts the video:

```js
var tapButton = document.getElementById('tapToStart');

var scanner = CamScanner.create({
  video: document.getElementById('cam'),
  onCode: function (text, type) { console.log(type, text); },
  onError: function (err) {
    if (err.code === 'camera' && err.message === 'video.play() rejected') {
      tapButton.hidden = false;
    }
  }
});

tapButton.addEventListener('click', function () {
  tapButton.hidden = true;
  scanner.resume();
});

scanner.start();
```

### Showing a result: pause, your own dialog, resume

```js
onCode: function (text, type) {
  scanner.pause();
  showMyDialog(text, {
    onScanMore: function () {
      showHint('Move the code out of the frame');
      setTimeout(function () { scanner.resume({ resetDedupe: true }); }, 3000);
    },
    onClose: function () { scanner.resume(); }
  });
}
```

`showMyDialog` and `showHint` are your own HTML elements. Never use `alert()` or `confirm()`
here: see 7 in [Why it works](#why-it-works).

## FNS receipt parser

Russian fiscal receipts carry a QR code with the data the tax service (FNS) needs to look the
receipt up:

```
t=20231215T1830&s=1234.56&fn=1234567890123456&i=12345&fp=1234567890&n=1
```

| Key | Meaning | Rule (strict mode) |
|---|---|---|
| `t` | Date and time, `YYYYMMDDTHHMM`, optional seconds `HHMMSS` | Required |
| `s` | Total amount, dot as the decimal separator | Required, digits with an optional `.fraction` |
| `fn` | Fiscal drive number | Required, exactly 16 digits |
| `i` | Fiscal document number (FD) | Required, 1–10 digits |
| `fp` | Fiscal sign (FP) | Required, 1–20 digits |
| `n` | Payment type | Optional, passed through as is |

Load `src/parsers/fns-receipt.js` after the core and use it in `onCode`:

```js
onCode: function (text) {
  var r = FnsReceipt.parse(text);
  if (!r) { showHint('This is not a receipt QR'); return; }
  sendToMyBackend(r);
}
```

`FnsReceipt.parse(text)` returns `null` or:

```js
{
  fn: '1234567890123456',
  fd: '12345',
  fp: '1234567890',
  date: '2023-12-15',
  time: '18:30',
  amount: 1234.56,
  n: '1',
  raw: 't=20231215T1830&s=1234.56&fn=1234567890123456&i=12345&fp=1234567890&n=1'
}
```

- `fn`, `fd`, `fp` stay strings, so leading zeros survive. `amount` is a `Number`.
- `n` is `null` when the QR code has no `n`.
- Parameters may come in any order; unknown parameters are ignored.
- The length rules were checked against 18 308 real receipt QR codes: `fn` was always 16 digits,
  FD 1 to 10 digits, FP 6 to 14 digits (14 appears in receipts of the newer 1.2 format). The FP
  limit of 20 leaves room above what was observed.
- `t` is a **format check only**: `20231315T9930` (month 13, hour 99) passes. Validate the date
  yourself if it matters.
- `FnsReceipt.parse(text, { strict: false })` skips the length rules (fields must still be digits)
  for those who validate on their own server.
- When the result is `null`, `FnsReceipt.parse.lastError` says why: `empty`, `missing:fn`,
  `missing:i`, `missing:fp`, `missing:t`, `missing:s`, `bad:fn`, `bad:fd`, `bad:fp`, `bad:t`,
  `bad:s`. Required fields are checked in the order `fn`, `i`, `fp`, `t`, `s`, so an ordinary
  link gives `missing:fn`. After a successful parse it is `null`.

The parser only reads the QR code. Checking the receipt with the tax service is up to your
server.

## Why it works

Each point is a lesson from production, except the torch (item 4): the symptom it cures and what
the core does about it.

**1. Decoding: one path for every platform.**
Symptom: scanners built on the browser's `BarcodeDetector` stop at iOS Safari, where it does not
exist, and it is not guaranteed in WebViews either; reading a canvas back every frame is slow when
the browser keeps that canvas on the GPU.
Fix: every frame is drawn to a hidden `<canvas>` created with `willReadFrequently: true`, read
with `getImageData` and passed to ZBar in WebAssembly. The same code runs in Chrome, Safari and
every WebView, and the canvas stays in memory the CPU can read quickly.

**2. Camera request: the rear camera at a real resolution.**
Symptom: the default camera request returns 640×480 or the front camera, and a small, dense QR
code on a receipt is just a grey blur at that resolution.
Fix: the core asks for the rear camera (`facingMode: { exact: 'environment' }`), 1920×1080
preferred and at least 1280×720, 15–30 frames per second, with continuous focus, exposure and
white balance. If the device cannot satisfy that (a laptop has no rear camera), it retries once
with soft constraints. If the user denied permission, it does not retry: a second request cannot
help and would only show the prompt again.

**3. Digital zoom by cropping the frame.**
Symptom: a receipt QR code is about 2–3 cm wide. Held close, the phone cannot focus on it; held
far enough to focus, the code covers too few pixels and ZBar does not find it. The native camera
zoom (`applyConstraints({ zoom })`) is not available everywhere and behaves differently from
phone to phone; it did not stick in production.
Fix: the core zooms in software. With `zoom: 2` it takes the central half of the frame
(width / 2 × height / 2) and stretches it over the whole canvas, so ZBar sees the code twice as
large and sees less of the clutter around it. The user holds the phone at a comfortable distance
(about 15 cm), the camera focuses, and the code is still big enough. The `<video>` is scaled by
the same factor with CSS, so everything on screen is decoded; the decoder may also see slightly
beyond the edges. Aim the code at the centre and it is read. For this to hold, `object-fit: cover`
on the `<video>` is REQUIRED: with `contain` the screen shows more than is decoded. The visual
zoom overwrites the video's `transform`; to keep your own (a mirror), set `visualZoom: false` and
scale the video yourself. The default is `2`; `setZoom(1)` turns it off, `setZoom(4)` is for
very small codes.

**4. Torch (experimental, not production-verified).**
Symptom: some Android phones do not list `torch` in `getCapabilities()`, yet the torch works;
iOS may accept the request and do nothing.
Fix: `setTorch(on)` sends the request without checking capabilities first, then reads
`getSettings().torch`. When the browser does not report the torch, the core trusts the requested
state and resolves `'on'` or `'off'`. It resolves `'unsupported'` only on an explicit mismatch
(the browser reports a different state), on a rejected request, or without a camera track. So on a
device that silently ignores the request the label can say "on" while nothing is lit. Do not hide
your torch button on `'unsupported'`: show a label instead. This feature was not used in
production, so treat it as experimental, not production-verified.

**5. One frame loop, never two.**
Symptom: after a few pause/resume or stop/start cycles, two or three decode loops ran at the
same time, each of them decoding every frame.
Fix: the loop runs on `requestAnimationFrame`, its id is kept, and `pause()` and `stop()` cancel
it with `cancelAnimationFrame`. Scheduling a frame when one is already scheduled does nothing.

**6. Deduplication.**
Symptom: the camera sees the same code 30 times a second; without deduplication `onCode` fires
again and again, and your backend receives duplicates.
Fix: by default the core remembers the last text and does not report it again until you call
`resetDedupe()` or `resume({ resetDedupe: true })`. It remembers only the last code: A, B, A
reports A twice. There are two ways to resume, and both are needed:
- after a **failed** submission on your side, call `resume()` without a reset. The code still in
  front of the camera is not sent again, which would create a duplicate if the first request did
  reach the server;
- after a **successful** submission, show "move the code out of the frame", wait a moment, then
  call `resume({ resetDedupe: true })`. From then on any code is accepted, the same one included.

For reader-style pages (links, warehouse labels) where one code is shown many times, set
`dedupeMs`: the same text is reported again once it has not been decoded for that many
milliseconds. The window slides: while the code stays in view, it stays silent.

**7. System dialogs freeze the video in Telegram.**
Symptom: in Telegram WebView, after `alert()` or `confirm()` the `<video>` froze on the last frame
and did not come back after the dialog closed. The scanner looked dead and the user had to
reopen the Mini App.
Fix: never use system dialogs (`alert`, `confirm`, `prompt`) while the scanner is open; draw your
own dialog in HTML, call `pause()` before showing it and `resume()` after. As a safety net,
`resume()` calls `video.play()` if the video is paused. If the browser refuses that `play()`, you
get `onError({ code: 'camera', message: 'video.play() rejected' })`: show a "tap to continue"
button that calls `resume()` (see [Handling a refused `video.play()`](#handling-a-refused-videoplay)).

**8. Stopping really releases the camera.**
Symptom: after the user left the page, the camera indicator stayed on, and users reasonably
thought they were still being filmed.
Fix: `stop()` switches the torch off (waiting at most 300 ms for it, so a hanging torch cannot
keep the camera open), cancels the frame loop, calls `track.stop()` on every track and detaches
the stream from the video. Call it when your scanner screen closes and on `pagehide`.

**9. iOS needs `playsinline` and `muted`.**
Symptom: on iOS, without `playsinline` the video opens fullscreen in the system player; without
`muted` it does not start by itself.
Fix: the core sets `playsinline`, `muted` and `autoplay` on the video before attaching the
stream. Put `playsinline muted` in your markup as well.

**10. Telegram caches scripts aggressively.**
Symptom: you deploy a fix, but users inside Telegram keep running the old script.
Fix: load every script with a version in the query, `cam-scanner.js?v=0.1.0`, and bump it on
every release.

## Proof

Since December 2025 this configuration has been scanning receipts in a production
loyalty-program project: **18 308 QR receipts from 630 users**. Platforms seen in its production
logs: iOS 18 Safari, Android 10–16 Chrome, Telegram iOS and Android (as of October 2026).

The torch is not part of this proof: production did not use it.

Device matrix for this repository, filled in by hand with
[docs/manual-test.md](docs/manual-test.md) on real devices:

| Platform | Status |
|---|---|
| Android Chrome | not yet verified |
| Telegram Android (Mini App) | not yet verified |
| iOS Safari | not yet verified |
| Telegram iOS (Mini App) | not yet verified |
| Desktop Chrome | not yet verified |

## Limitations

What this library deliberately does not do (at least in this version):

- **No npm package, no bundler build, no TypeScript types.** Copy the files. These may come later.
- **No QR generation**, no decoding of photos from the gallery, **one code per frame** (if several
  codes are visible, one of them is reported).
- **No server side.** Checking a receipt with the tax service, storing it, deduplicating across
  users: all of that is up to you.
- **No Telegram-specific APIs** (`showScanQrPopup`, `initData`). The library does not know it is
  in Telegram; it simply works in its WebView.
- **No native optical zoom**: zoom is digital (see 3 in [Why it works](#why-it-works)).
- **No built-in camera switching**: `stop()` the scanner and create a new one with the camera's
  `deviceId` in `constraints`, in the full shape:
  `{ video: { deviceId: { exact: id }, width: { ideal: 1920 }, height: { ideal: 1080 } } }`. Your
  constraints REPLACE the built-in ones wholesale; if that request fails, the core silently falls
  back to its built-in soft constraints, that is the rear camera. The new scanner reuses the WASM
  already loaded for its `wasmDir`.
- **The torch is experimental** and not production-verified.
- **The deduper remembers one code**, not a history.

## License

The code of this repository is under the [MIT License](LICENSE).

The `wasm/` folder contains third-party files, redistributed without modification:

- `zbar.wasm` and `zbar.js` are a WebAssembly build of the **ZBar** bar code reader,
  version 0.23.90, licensed under the **GNU LGPL 2.1** (or later); the full licence text is in
  [`wasm/LICENSE.LGPL-2.1.txt`](wasm/LICENSE.LGPL-2.1.txt). Source:
  [github.com/mchehab/zbar](https://github.com/mchehab/zbar). Because ZBar is under the LGPL, you
  may replace it with your own build and the scanner keeps working. To rebuild, replace
  `zbar.wasm` and `zbar.js` together: the Emscripten glue is tied to its build. The build uses
  Emscripten in Docker, as described in the [koder](https://github.com/maslick/koder) README.
- The build setup and the original JavaScript wrapper come from **koder** by maslick, under the
  MIT License, pinned at commit `6f8bebd2ad454ed5320b6519cb932cc52a4af9fa`. The wrapper is not
  shipped as a file: its logic is derived from koder's `koder.js` and rewritten in ES5 in
  `src/cam-scanner.js`. koder's copyright notice and MIT licence text are in
  [`wasm/NOTICE`](wasm/NOTICE). `zbar.js` and `zbar.wasm` are unmodified.

Source, version, sha256 checksums and sizes are listed in [`wasm/NOTICE`](wasm/NOTICE);
`npm run check` verifies the checksums. Keep `wasm/NOTICE` and `wasm/LICENSE.LGPL-2.1.txt` when
you redistribute the files.

## How to add a parser

A parser turns the raw text from `onCode` into something useful. The contract, the same one
`FnsReceipt` follows:

- a global object with a `parse(text[, options])` function;
- `parse` returns an **object** when the text is its format, and **`null`** otherwise;
- it never throws, has no side effects and does not touch the DOM;
- optionally, `parse.lastError` holds a short code explaining the last `null`.

Example: a parser for `geo:` links (`geo:55.7558,37.6173`), in `src/parsers/geo-uri.js`:

```js
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.GeoUri = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var RE = /^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/i;

  function parse(text) {
    var m = typeof text === 'string' ? RE.exec(text) : null;
    if (!m) { parse.lastError = 'not-geo'; return null; }
    parse.lastError = null;
    return { lat: Number(m[1]), lon: Number(m[2]), raw: text };
  }

  parse.lastError = null;
  return { parse: parse };
});
```

The wrapper makes the same file work as a `<script>` in the browser and as `require()` in Node,
so you can test it with `node --test` without a browser. Then try parsers one by one:

```js
onCode: function (text, type) {
  var receipt = FnsReceipt.parse(text);
  var place = receipt ? null : GeoUri.parse(text);
  if (receipt) { sendToMyBackend(receipt); }
  else if (place) { showOnMap(place.lat, place.lon); }
  else { showHint('Unknown code: ' + type); }
}
```

Pull requests with new parsers are welcome: add the file, tests in `test/`, and a line in this
section.
