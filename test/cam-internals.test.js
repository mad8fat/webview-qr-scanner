'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const CamScanner = require('../src/cam-scanner.js');
const I = CamScanner._internals;

test('computeCrop zoom 1 → full frame', () => {
  assert.deepEqual(I.computeCrop(1920, 1080, 1), { sx: 0, sy: 0, sw: 1920, sh: 1080 });
});
test('computeCrop zoom 2 → center half', () => {
  assert.deepEqual(I.computeCrop(1920, 1080, 2), { sx: 480, sy: 270, sw: 960, sh: 540 });
});
test('computeCrop zoom 4', () => {
  assert.deepEqual(I.computeCrop(1920, 1080, 4), { sx: 720, sy: 405, sw: 480, sh: 270 });
});
test('deduper 0: same text blocked until reset', () => {
  const d = I.createDeduper(0);
  assert.equal(d.shouldEmit('a', 0), true);
  assert.equal(d.shouldEmit('a', 99999), false);
  d.reset();
  assert.equal(d.shouldEmit('a', 100000), true);
});
test('deduper 0: different text passes', () => {
  const d = I.createDeduper(0);
  assert.equal(d.shouldEmit('a', 0), true);
  assert.equal(d.shouldEmit('b', 1), true);
  assert.equal(d.shouldEmit('a', 2), true);
});
test('deduper 3000: sliding window from last seen', () => {
  const d = I.createDeduper(3000);
  assert.equal(d.shouldEmit('a', 0), true);
  assert.equal(d.shouldEmit('a', 2000), false);
  assert.equal(d.shouldEmit('a', 4000), false);
  assert.equal(d.shouldEmit('a', 7001), true);
});
test('deduper 3000: window boundary is exclusive of dedupeMs', () => {
  const d = I.createDeduper(3000);
  assert.equal(d.shouldEmit('a', 0), true);
  assert.equal(d.shouldEmit('a', 2999), false);
  assert.equal(d.shouldEmit('a', 5998), false);
  assert.equal(d.shouldEmit('a', 8998), true);
});
test('buildConstraints stage 1 defaults', () => {
  assert.deepEqual(I.buildConstraints(null, 1), {
    video: {
      width: { ideal: 1920, min: 1280 },
      height: { ideal: 1080, min: 720 },
      facingMode: { exact: 'environment' },
      frameRate: { ideal: 30, min: 15 },
      focusMode: { ideal: 'continuous' },
      exposureMode: { ideal: 'continuous' },
      whiteBalanceMode: { ideal: 'continuous' }
    }
  });
});
test('buildConstraints stage 2 fallback', () => {
  assert.deepEqual(I.buildConstraints(null, 2), {
    video: { width: { ideal: 1920 }, height: { ideal: 1080 }, facingMode: 'environment' }
  });
});
test('buildConstraints user replaces stage 1, stage 2 untouched', () => {
  const user = { video: { deviceId: { exact: 'x' } } };
  assert.equal(I.buildConstraints(user, 1), user);
  assert.deepEqual(I.buildConstraints(user, 2), I.FALLBACK_CONSTRAINTS);
  assert.notEqual(I.buildConstraints(user, 2), I.FALLBACK_CONSTRAINTS);
});
