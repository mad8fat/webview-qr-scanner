'use strict';
// Integration test: the inline ES5 glue against the real wasm/zbar.js + wasm/zbar.wasm.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const CamScanner = require('../src/cam-scanner.js');

const ZbarKoder = CamScanner._internals.ZbarKoder;
const WASM_DIR = path.join(__dirname, '..', 'wasm');

// Renders an EAN-13 barcode (black bars on white, quiet zones) as RGBA.
const L_CODES = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const invert = (bits) => bits.split('').map((b) => (b === '0' ? '1' : '0')).join('');
const G_CODES = L_CODES.map((c) => invert(c).split('').reverse().join(''));
const R_CODES = L_CODES.map(invert);
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

function renderEan13(code, moduleWidth = 3, height = 120) {
  const d = code.split('').map(Number);
  let bits = '101';
  for (let i = 1; i <= 6; i++) bits += (PARITY[d[0]][i - 1] === 'L' ? L_CODES : G_CODES)[d[i]];
  bits += '01010';
  for (let i = 7; i <= 12; i++) bits += R_CODES[d[i]];
  bits += '101';
  const quiet = 12 * moduleWidth;
  const width = bits.length * moduleWidth + 2 * quiet;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 0; y < height; y++) {
    for (let x = quiet; x < quiet + bits.length * moduleWidth; x++) {
      if (bits[Math.floor((x - quiet) / moduleWidth)] === '1') {
        const o = (y * width + x) * 4;
        data[o] = data[o + 1] = data[o + 2] = 0;
      }
    }
  }
  return { data, width, height };
}

// Emscripten picks fetch() whenever it exists; Node 18+ has one, but it cannot read a
// filesystem path, so fetch is hidden while the module loads and the glue's Node branch
// reads zbar.wasm with fs. Browsers take the fetch branch with the same locateFile URL.
async function initKoder() {
  const CreateKoder = require('../wasm/zbar.js');
  const savedFetch = globalThis.fetch;
  delete globalThis.fetch;
  try {
    return await new ZbarKoder(CreateKoder).initialize({ wasmDirectory: WASM_DIR });
  } finally {
    globalThis.fetch = savedFetch;
  }
}

test('real ZBar: initialize resolves to the koder; blank frames decode to null repeatedly', async () => {
  const koder = await initKoder();
  assert.ok(koder instanceof ZbarKoder);
  assert.equal(koder.decode(new Uint8ClampedArray(64 * 64 * 4), 64, 64), null);
  assert.equal(koder.decode(new Uint8ClampedArray(64 * 64 * 4), 64, 64), null);
});

test('real ZBar: rendered EAN-13 decodes to {code, type}, frame after frame', async () => {
  const koder = await initKoder();
  const img = renderEan13('4006381333931');
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(koder.decode(img.data, img.width, img.height), { code: '4006381333931', type: 'EAN-13' });
  }
  assert.equal(koder.decode(new Uint8ClampedArray(64 * 64 * 4), 64, 64), null);
});

test('real ZBar: input buffers are not leaked (heap stays flat over 40 VGA frames)', async () => {
  const koder = await initKoder();
  const frame = new Uint8ClampedArray(640 * 480 * 4);
  koder.decode(frame, 640, 480);
  const heapAfterFirst = koder.mod.HEAPU8.length;
  for (let i = 0; i < 40; i++) koder.decode(frame, 640, 480);
  assert.equal(koder.mod.HEAPU8.length, heapAfterFirst);
});
