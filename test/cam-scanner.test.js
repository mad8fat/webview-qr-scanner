'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const CamScanner = require('../src/cam-scanner.js');
const { makeEnv } = require('./fakes.js');

const I = CamScanner._internals;
const FRAME_BYTES = 1280 * 720 * 4;

// Lets every pending promise callback and queued microtask run.
const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(opts = {}, envOptions = {}) {
  const env = makeEnv(envOptions);
  const log = { status: [], codes: [], errors: [] };
  const scanner = CamScanner.create({
    video: env.video,
    env,
    onStatus: (s) => log.status.push(s),
    onCode: (text, type) => log.codes.push([text, type]),
    onError: (e) => log.errors.push(e),
    ...opts
  });
  return { env, log, scanner };
}

async function started(opts, envOptions) {
  const ctx = setup(opts, envOptions);
  await ctx.scanner.start();
  return ctx;
}

test('start: status sequence loading-wasm → requesting-camera → scanning', async () => {
  const { env, log, scanner } = setup();
  assert.equal(scanner.getState(), 'idle');
  const result = await scanner.start();
  assert.equal(result, undefined);
  assert.deepEqual(log.status, ['loading-wasm', 'requesting-camera', 'scanning']);
  assert.equal(scanner.getState(), 'scanning');
  assert.deepEqual(env.koderInitCalls, [{ wasmDirectory: 'wasm' }]);
  assert.deepEqual(env.getUserMediaCalls, [I.DEFAULT_CONSTRAINTS]);
  assert.deepEqual(env.video.attachSnapshot, { playsinline: '', muted: true, autoplay: true });
  assert.equal(env.video.srcObject, env.streams[0]);
  assert.equal(env.canvases.length, 1);
  assert.equal(env.canvases[0].width, 1280);
  assert.equal(env.canvases[0].height, 720);
  assert.deepEqual(env.canvases[0].contextArgs, ['2d', { willReadFrequently: true }]);
  assert.equal(env.pendingFrames(), 1);
  assert.equal(env.video.listenerCount('loadedmetadata'), 0);
  assert.deepEqual(log.errors, []);
});

test('start twice: single getUserMedia call, single rAF loop', async () => {
  const { env, scanner } = setup();
  const p1 = scanner.start();
  const p2 = scanner.start();
  assert.equal(p1, p2);
  await p1;
  assert.equal(scanner.start(), p1);
  await flush();
  assert.equal(env.getUserMediaCalls.length, 1);
  assert.equal(env.koderInitCalls.length, 1);
  assert.equal(env.pendingFrames(), 1);
  env.tick();
  assert.equal(env.decodeCalls.length, 1);
  assert.equal(env.pendingFrames(), 1);
  scanner.resume(); // resume while already scanning must not fork a second loop
  assert.equal(env.pendingFrames(), 1);
});

test('wasm init failure → onError code wasm, state idle', async () => {
  const { env, log, scanner } = setup({ wasmDir: 'vendor/zbar' }, { wasmFails: true });
  await scanner.start();
  assert.deepEqual(env.koderInitCalls, [{ wasmDirectory: 'vendor/zbar' }]);
  assert.equal(log.errors.length, 1);
  assert.equal(log.errors[0].code, 'wasm');
  assert.equal(log.errors[0].message, 'wasm failed to load');
  assert.ok(log.errors[0].cause instanceof Error);
  assert.equal(scanner.getState(), 'idle');
  assert.deepEqual(log.status, ['loading-wasm', 'idle']);
  assert.equal(env.getUserMediaCalls.length, 0);
  assert.equal(env.pendingFrames(), 0);
});

test('camera: stage1 reject → stage2 constraints used → scanning', async () => {
  const user = { video: { deviceId: { exact: 'cam-1' } } };
  const { env, log, scanner } = await started({ constraints: user }, { camera: ['fail', 'ok'] });
  assert.equal(env.getUserMediaCalls.length, 2);
  assert.equal(env.getUserMediaCalls[0], user);
  assert.deepEqual(env.getUserMediaCalls[1], I.FALLBACK_CONSTRAINTS);
  assert.equal(scanner.getState(), 'scanning');
  assert.equal(env.video.srcObject, env.streams[0]);
  assert.deepEqual(log.errors, []);
});

test('camera: both reject → onError code camera', async () => {
  const { env, log, scanner } = await started({}, { camera: ['fail', 'fail'] });
  assert.equal(env.getUserMediaCalls.length, 2);
  assert.equal(log.errors.length, 1);
  assert.equal(log.errors[0].code, 'camera');
  assert.equal(log.errors[0].message, 'Constraints not satisfied');
  assert.equal(log.errors[0].cause, env.cameraErrors[1]);
  assert.equal(scanner.getState(), 'idle');
  assert.deepEqual(log.status, ['loading-wasm', 'requesting-camera', 'idle']);
  assert.equal(env.video.srcObject, null);
  assert.equal(env.pendingFrames(), 0);
});

test('decode result → onCode(text, type) once; same code next frame suppressed (dedupeMs 0)', async () => {
  const { env, log } = await started();
  env.nextDecode({ code: 't=20240101T1200&s=100.00', type: 'QR-Code' });
  env.tick();
  assert.deepEqual(log.codes, [['t=20240101T1200&s=100.00', 'QR-Code']]);
  assert.deepEqual(env.decodeCalls[0], { length: FRAME_BYTES, width: 1280, height: 720 });
  env.nextDecode({ code: 't=20240101T1200&s=100.00', type: 'QR-Code' });
  env.tick();
  assert.equal(log.codes.length, 1);
  env.nextDecode({ code: '4601234567893', type: 'EAN-13' });
  env.tick();
  assert.deepEqual(log.codes[1], ['4601234567893', 'EAN-13']);
  assert.equal(env.decodeCalls.length, 3);
});

test('resume({resetDedupe:true}) lets same code through; resume() does not', async () => {
  const { env, log, scanner } = await started();
  const code = { code: 'X', type: 'QR-Code' };
  env.nextDecode(code);
  env.tick();
  assert.equal(log.codes.length, 1);

  scanner.pause();
  scanner.resume();
  env.nextDecode(code);
  env.tick();
  assert.equal(log.codes.length, 1);

  scanner.pause();
  scanner.resume({ resetDedupe: true });
  env.nextDecode(code);
  env.tick();
  assert.equal(log.codes.length, 2);

  env.nextDecode(code);
  env.tick();
  assert.equal(log.codes.length, 2);
  scanner.resetDedupe();
  env.nextDecode(code);
  env.tick();
  assert.equal(log.codes.length, 3);
});

test('pause → state paused, tick does not decode; resume → video.play() called when paused', async () => {
  const { env, log, scanner } = await started();
  scanner.pause();
  assert.equal(scanner.getState(), 'paused');
  assert.equal(log.status.at(-1), 'paused');
  assert.equal(env.pendingFrames(), 0);
  env.nextDecode({ code: 'X', type: 'QR-Code' });
  assert.equal(env.tick(), false);
  assert.equal(env.decodeCalls.length, 0);

  env.video.paused = true; // the OS paused the element, e.g. the WebView went to background
  const playsBefore = env.video.playCalls;
  scanner.resume();
  assert.equal(env.video.playCalls, playsBefore + 1);
  assert.equal(scanner.getState(), 'scanning');
  assert.equal(log.status.at(-1), 'scanning');
  assert.equal(env.pendingFrames(), 1);
  env.tick();
  assert.equal(env.decodeCalls.length, 1);
  assert.deepEqual(log.codes, [['X', 'QR-Code']]);

  scanner.pause();
  scanner.resume();
  assert.equal(env.video.playCalls, playsBefore + 1, 'a playing video is not restarted');
  assert.equal(env.pendingFrames(), 1);
});

test('stop: cancelAnimationFrame called, track.stop called, state stopped', async () => {
  const idle = setup();
  assert.doesNotThrow(() => idle.scanner.stop());

  const { env, log, scanner } = await started();
  const track = env.streams[0].track;
  scanner.stop();
  assert.equal(env.cancelledFrames.length, 1);
  assert.equal(env.pendingFrames(), 0);
  assert.equal(track.stopCalls, 1);
  assert.equal(env.video.srcObject, null);
  assert.equal(scanner.getState(), 'stopped');
  assert.equal(log.status.at(-1), 'stopped');
  assert.equal(env.tick(), false);

  assert.doesNotThrow(() => scanner.stop());
  assert.equal(track.stopCalls, 1);

  log.status.length = 0;
  await scanner.start();
  assert.deepEqual(log.status, ['loading-wasm', 'requesting-camera', 'scanning']);
  assert.equal(env.getUserMediaCalls.length, 2);
  assert.equal(env.video.srcObject, env.streams[1]);
  assert.equal(env.pendingFrames(), 1);
});

test('stop during camera request: later resolved stream gets track.stop(), no throw', async () => {
  const { env, log, scanner } = setup({}, { camera: ['manual'] });
  const pending = scanner.start();
  await flush();
  assert.equal(scanner.getState(), 'requesting-camera');
  assert.doesNotThrow(() => scanner.stop());
  assert.equal(scanner.getState(), 'stopped');

  env.pendingCamera[0].resolve();
  await pending;
  await flush();
  assert.equal(env.streams.length, 1);
  assert.equal(env.streams[0].track.stopCalls, 1);
  assert.equal(env.video.srcObject, null);
  assert.equal(scanner.getState(), 'stopped');
  assert.equal(env.pendingFrames(), 0);
  assert.deepEqual(log.errors, []);
});

test('setZoom(4): crop passed to drawImage matches computeCrop; visualZoom sets video.style.transform "scale(4)"', async () => {
  const { env, scanner } = await started();
  assert.equal(env.video.style.transform, 'scale(2)');
  scanner.setZoom(4);
  assert.equal(env.video.style.transform, 'scale(4)');
  env.tick();
  const c = I.computeCrop(1280, 720, 4);
  assert.deepEqual(env.drawImageCalls[0], [env.video, c.sx, c.sy, c.sw, c.sh, 0, 0, 1280, 720]);

  scanner.setZoom(1);
  assert.equal(env.video.style.transform, '');
  env.tick();
  assert.deepEqual(env.drawImageCalls[1], [env.video, 0, 0]);

  const { env: plainEnv } = await started({ zoom: 4, visualZoom: false });
  assert.equal(plainEnv.video.style.transform, '');
  plainEnv.tick();
  assert.equal(plainEnv.drawImageCalls[0].length, 9);
});

test('setTorch(true): applyConstraints({advanced:[{torch:true}]}); getSettings().torch true → "on"', async () => {
  const { env, log, scanner } = await started();
  const track = env.streams[0].track;
  assert.equal(await scanner.setTorch(true), 'on');
  assert.deepEqual(track.events, [{ advanced: [{ torch: true }] }]);

  await scanner.stop();
  assert.deepEqual(track.events, [{ advanced: [{ torch: true }] }, { advanced: [{ torch: false }] }, 'stop']);
  env.runTimers(); // the 300 ms safety timer fires late: release must not run twice
  assert.equal(track.stopCalls, 1);
  assert.equal(scanner.getState(), 'stopped');
  assert.deepEqual(log.errors, []);
});

test('setTorch(true): applyConstraints rejects → onError code torch, resolves "unsupported"', async () => {
  const { log, scanner } = await started({}, { torch: 'reject' });
  assert.equal(await scanner.setTorch(true), 'unsupported');
  assert.equal(log.errors.length, 1);
  assert.equal(log.errors[0].code, 'torch');
  assert.equal(log.errors[0].message, 'torch rejected');
  assert.ok(log.errors[0].cause instanceof Error);
  assert.equal(scanner.getState(), 'scanning');
});

test('setTorch: applyConstraints resolves, getSettings().torch undefined → trusts the request ("on"/"off")', async () => {
  const before = setup({}, { torch: 'no-report' });
  assert.equal(await before.scanner.setTorch(true), 'unsupported', 'no track before start');

  const { env, log, scanner } = await started({}, { torch: 'no-report' });
  const track = env.streams[0].track;
  assert.equal(await scanner.setTorch(true), 'on');
  assert.equal(await scanner.setTorch(false), 'off');
  assert.deepEqual(track.events, [{ advanced: [{ torch: true }] }, { advanced: [{ torch: false }] }]);

  delete track.getSettings; // a browser without getSettings() at all
  assert.equal(await scanner.setTorch(true), 'on');
  assert.deepEqual(log.errors, []);
});

test('setTorch(true): applyConstraints resolves but getSettings().torch stays false → "unsupported"', async () => {
  const { env, log, scanner } = await started({}, { torch: 'mismatch' });
  assert.equal(await scanner.setTorch(true), 'unsupported');
  assert.deepEqual(env.streams[0].track.events, [{ advanced: [{ torch: true }] }]);
  assert.equal(await scanner.setTorch(false), 'off', 'reported false matches the requested off');
  assert.deepEqual(log.errors, []);
});

test('onCode throws → caught, loop continues, onError code decode', async () => {
  let calls = 0;
  const { env, log } = await started({
    onCode: (text) => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      log.codes.push(text);
    }
  });
  env.nextDecode({ code: 'A', type: 'QR-Code' });
  assert.doesNotThrow(() => env.tick());
  assert.equal(log.errors.length, 1);
  assert.equal(log.errors[0].code, 'decode');
  assert.equal(log.errors[0].message, 'boom');
  assert.ok(log.errors[0].cause instanceof Error);
  assert.equal(env.pendingFrames(), 1);

  env.nextDecode({ code: 'B', type: 'QR-Code' });
  env.tick();
  assert.deepEqual(log.codes, ['B']);
  assert.equal(env.decodeCalls.length, 2);
  assert.equal(env.pendingFrames(), 1);
});

test('camera: stage1 NotAllowedError → no stage 2, onError carries that error', async () => {
  const { env, log, scanner } = await started({}, { camera: ['deny', 'ok'] });
  assert.equal(env.getUserMediaCalls.length, 1);
  assert.equal(log.errors.length, 1);
  assert.equal(log.errors[0].code, 'camera');
  assert.equal(log.errors[0].cause, env.cameraErrors[0]);
  assert.equal(log.errors[0].cause.name, 'NotAllowedError');
  assert.equal(scanner.getState(), 'idle');
  assert.equal(env.streams.length, 0);
});

test('stop: torch-off never settles → camera released by the 300 ms timer', async () => {
  const { env, scanner } = await started({}, { torch: 'off-hangs' });
  const track = env.streams[0].track;
  assert.equal(await scanner.setTorch(true), 'on');
  let resolved = false;
  const stopped = scanner.stop().then(() => { resolved = true; });
  assert.equal(scanner.getState(), 'stopped');
  await flush();
  assert.equal(track.stopCalls, 0);
  assert.equal(resolved, false);
  assert.deepEqual(env.timers.map((t) => t.ms), [300]);
  env.runTimers();
  await stopped;
  assert.equal(track.stopCalls, 1);
  assert.equal(env.video.srcObject, null);
  assert.equal(scanner.getState(), 'stopped');
});

test('start: canvas setup failure → onError camera, state idle, start() resolves, camera released', async () => {
  const { env, log, scanner } = setup();
  env.document.createElement = () => { throw new Error('no canvas'); };
  assert.equal(await scanner.start(), undefined);
  assert.equal(log.errors.length, 1);
  assert.equal(log.errors[0].code, 'camera');
  assert.equal(log.errors[0].message, 'no canvas');
  assert.equal(scanner.getState(), 'idle');
  assert.equal(env.streams[0].track.stopCalls, 1);
  assert.equal(env.video.srcObject, null);
  assert.equal(env.pendingFrames(), 0);

  const nullCtx = setup();
  const createCanvas = nullCtx.env.document.createElement;
  nullCtx.env.document.createElement = (tag) => {
    const canvas = createCanvas(tag);
    canvas.context = null;
    return canvas;
  };
  await nullCtx.scanner.start();
  assert.equal(nullCtx.log.errors.length, 1);
  assert.equal(nullCtx.log.errors[0].code, 'camera');
  assert.equal(nullCtx.log.errors[0].message, '2d context unavailable');
  assert.equal(nullCtx.scanner.getState(), 'idle');
  assert.equal(nullCtx.env.pendingFrames(), 0);
});

test('video.play() rejected → onError camera "video.play() rejected", state stays scanning', async () => {
  const { env, log, scanner } = await started({}, { playRejects: true });
  await flush();
  assert.equal(log.errors.length, 1);
  assert.equal(log.errors[0].code, 'camera');
  assert.equal(log.errors[0].message, 'video.play() rejected');
  assert.equal(log.errors[0].cause.name, 'NotAllowedError');
  assert.equal(scanner.getState(), 'scanning');
  assert.equal(env.pendingFrames(), 1);
});

test('stop during loading-wasm then start again → Koder constructed once', async () => {
  const { env, log, scanner } = setup();
  const first = scanner.start();
  assert.equal(scanner.getState(), 'loading-wasm');
  scanner.stop();
  const second = scanner.start();
  await Promise.all([first, second]);
  assert.equal(env.koderInstances, 1);
  assert.equal(env.koderInitCalls.length, 1);
  assert.equal(env.getUserMediaCalls.length, 1);
  assert.equal(scanner.getState(), 'scanning');
  assert.deepEqual(log.errors, []);
});

function fakeZbarModule() {
  const calls = [];
  const results = { 7: 'hello', 8: 'QR-Code' };
  let found = 1;
  const fns = {
    createBuffer: (size) => { calls.push(['createBuffer', size]); return 100; },
    deleteBuffer: (ptr) => { calls.push(['deleteBuffer', ptr]); },
    triggerDecode: (ptr, w, h) => { calls.push(['triggerDecode', ptr, w, h]); return found--; },
    getScanResults: () => 7,
    getResultType: () => 8
  };
  return {
    calls,
    HEAPU8: { set: (data, ptr) => calls.push(['HEAPU8.set', data.length, ptr]) },
    cwrap: (name) => fns[name],
    UTF8ToString: (ptr) => results[ptr]
  };
}

test('default Koder: global CreateKoder is resolved and drives decoding; env.CreateKoder wins', async () => {
  const mod = fakeZbarModule();
  const locateCalls = [];
  global.CreateKoder = (moduleArgs) => {
    locateCalls.push(moduleArgs.locateFile('zbar.wasm'));
    return Promise.resolve(mod);
  };
  try {
    const env = makeEnv();
    delete env.Koder;
    const status = [];
    const codes = [];
    const scanner = CamScanner.create({
      video: env.video,
      env,
      wasmDir: 'static/wasm',
      onStatus: (s) => status.push(s),
      onCode: (text, type) => codes.push([text, type])
    });
    await scanner.start();
    assert.deepEqual(status, ['loading-wasm', 'requesting-camera', 'scanning']);
    assert.deepEqual(locateCalls, ['static/wasm/zbar.wasm']);
    env.tick();
    assert.deepEqual(codes, [['hello', 'QR-Code']]);
    assert.deepEqual(mod.calls, [
      ['createBuffer', FRAME_BYTES],
      ['HEAPU8.set', FRAME_BYTES, 100],
      ['triggerDecode', 100, 1280, 720],
      ['deleteBuffer', 7]
    ]);
    env.tick();
    assert.equal(codes.length, 1);

    const injectedMod = fakeZbarModule();
    const injected = makeEnv();
    delete injected.Koder;
    injected.CreateKoder = () => Promise.resolve(injectedMod);
    const second = CamScanner.create({ video: injected.video, env: injected });
    await second.start();
    assert.equal(second.getState(), 'scanning');
    injected.tick();
    assert.equal(injectedMod.calls.length, 4);
    assert.equal(locateCalls.length, 1, 'global factory not used when env.CreateKoder is given');
  } finally {
    delete global.CreateKoder;
  }
});

test('default Koder without CreateKoder → onError code wasm, state idle', async () => {
  const env = makeEnv();
  delete env.Koder;
  const errors = [];
  const scanner = CamScanner.create({ video: env.video, env, onError: (e) => errors.push(e) });
  await scanner.start();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'wasm');
  assert.match(errors[0].message, /CreateKoder not found/);
  assert.equal(scanner.getState(), 'idle');
  assert.equal(env.getUserMediaCalls.length, 0);
});

test('camera track ended while scanning → onError camera "camera track ended", state idle, camera released', async () => {
  const { env, log, scanner } = await started();
  const track = env.streams[0].track;
  assert.equal(track.listenerCount('ended'), 1);
  track.dispatch('ended');
  assert.equal(scanner.getState(), 'idle');
  assert.equal(log.status.at(-1), 'idle');
  assert.equal(log.errors.length, 1);
  assert.equal(log.errors[0].code, 'camera');
  assert.equal(log.errors[0].message, 'camera track ended');
  assert.ok(log.errors[0].cause instanceof Error);
  assert.equal(env.pendingFrames(), 0);
  assert.equal(env.cancelledFrames.length, 1);
  assert.equal(track.stopCalls, 1);
  assert.equal(env.video.srcObject, null);
  assert.equal(track.listenerCount('ended'), 0);

  track.dispatch('ended'); // a second event changes nothing
  assert.equal(log.errors.length, 1);

  await scanner.start(); // "Try again" works
  assert.equal(scanner.getState(), 'scanning');
  assert.equal(env.video.srcObject, env.streams[1]);
  assert.equal(env.streams[1].track.listenerCount('ended'), 1);
});

test('camera track ended while paused → idle with onError camera; after stop() the listener is gone', async () => {
  const paused = await started();
  paused.scanner.pause();
  paused.env.streams[0].track.dispatch('ended');
  assert.equal(paused.scanner.getState(), 'idle');
  assert.deepEqual(paused.log.errors.map((e) => e.message), ['camera track ended']);

  const { env, log, scanner } = await started();
  const track = env.streams[0].track;
  await scanner.stop();
  assert.equal(track.listenerCount('ended'), 0);
  track.dispatch('ended');
  assert.equal(scanner.getState(), 'stopped');
  assert.deepEqual(log.errors, []);
});

test('camera track ended before loadedmetadata → start() resolves, state idle, no scanning afterwards', async () => {
  const { env, log, scanner } = setup();
  const video = env.video;
  // Hold loadedmetadata back: the track ends first.
  const add = video.addEventListener;
  let metadata = null;
  video.addEventListener = (type, fn) => {
    if (type === 'loadedmetadata') metadata = fn; else add(type, fn);
  };
  const pending = scanner.start();
  await flush();
  assert.equal(scanner.getState(), 'requesting-camera');
  env.streams[0].track.dispatch('ended');
  assert.equal(await pending, undefined);
  assert.equal(scanner.getState(), 'idle');
  assert.deepEqual(log.errors.map((e) => e.message), ['camera track ended']);
  metadata({ type: 'loadedmetadata' }); // arrives late
  assert.equal(scanner.getState(), 'idle');
  assert.equal(env.pendingFrames(), 0);
  assert.equal(env.video.srcObject, null);
});

test('wasmDir with trailing slashes: locateFile builds "wasm/zbar.wasm"', async () => {
  const seen = [];
  const factory = (moduleArgs) => {
    seen.push(moduleArgs.locateFile('zbar.wasm'));
    return Promise.resolve(fakeZbarModule());
  };
  await new I.ZbarKoder(factory).initialize({ wasmDirectory: 'wasm/' });
  await new I.ZbarKoder(factory).initialize({ wasmDirectory: 'https://cdn.example.com/zbar//' });
  await new I.ZbarKoder(factory).initialize({ wasmDirectory: 'wasm' });
  assert.deepEqual(seen, ['wasm/zbar.wasm', 'https://cdn.example.com/zbar/zbar.wasm', 'wasm/zbar.wasm']);
});

// Scanners on the built-in wrapper (no env.Koder / env.CreateKoder) share one WASM instance per wasmDir.
function defaultKoderScanner(wasmDir) {
  const env = makeEnv();
  delete env.Koder;
  const errors = [];
  const scanner = CamScanner.create({ video: env.video, env, wasmDir, onError: (e) => errors.push(e) });
  return { env, errors, scanner };
}

test('WASM cache: same wasmDir → global CreateKoder called once; another wasmDir → once more', async () => {
  let calls = 0;
  global.CreateKoder = () => { calls += 1; return Promise.resolve(fakeZbarModule()); };
  try {
    const a = defaultKoderScanner('cache/one');
    const b = defaultKoderScanner('cache/one/');
    await Promise.all([a.scanner.start(), b.scanner.start()]);
    assert.equal(a.scanner.getState(), 'scanning');
    assert.equal(b.scanner.getState(), 'scanning');
    assert.equal(calls, 1);

    await a.scanner.stop();
    const c = defaultKoderScanner('cache/one'); // a camera switch creates a new scanner
    await c.scanner.start();
    assert.equal(c.scanner.getState(), 'scanning');
    assert.equal(calls, 1);

    const d = defaultKoderScanner('cache/two');
    await d.scanner.start();
    assert.equal(d.scanner.getState(), 'scanning');
    assert.equal(calls, 2);

    // An injected CreateKoder (the test seam) is never cached.
    const e = makeEnv();
    delete e.Koder;
    let injectedCalls = 0;
    e.CreateKoder = () => { injectedCalls += 1; return Promise.resolve(fakeZbarModule()); };
    await CamScanner.create({ video: e.video, env: e, wasmDir: 'cache/one' }).start();
    await CamScanner.create({ video: e.video, env: e, wasmDir: 'cache/one' }).start();
    assert.equal(injectedCalls, 2);
    assert.equal(calls, 2);
  } finally {
    delete global.CreateKoder;
  }
});

test('WASM cache: a rejected init is dropped, the next create loads again', async () => {
  let calls = 0;
  global.CreateKoder = () => {
    calls += 1;
    return calls === 1 ? Promise.reject(new Error('zbar.wasm 404')) : Promise.resolve(fakeZbarModule());
  };
  try {
    const a = defaultKoderScanner('cache/retry');
    await a.scanner.start();
    assert.equal(a.scanner.getState(), 'idle');
    assert.equal(a.errors[0].code, 'wasm');
    assert.equal(a.errors[0].message, 'zbar.wasm 404');

    const b = defaultKoderScanner('cache/retry');
    await b.scanner.start();
    assert.equal(b.scanner.getState(), 'scanning');
    assert.equal(calls, 2);

    await a.scanner.start(); // the failed scanner retries and gets the cached instance
    assert.equal(a.scanner.getState(), 'scanning');
    assert.equal(calls, 2);
  } finally {
    delete global.CreateKoder;
  }
});
