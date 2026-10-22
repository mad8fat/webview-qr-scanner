'use strict';
// Verifies that the vendored wasm/ files are byte-identical to the upstream snapshot.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WASM_DIR = path.join(__dirname, '..', 'wasm');
const EXPECTED = [
  { file: 'zbar.wasm', size: 338031, sha256: '6d3ffd5045d20bc06c09247cf551d6d307ea4e0962673a46d67703b04e3cd185' },
  { file: 'zbar.js', size: 14782, sha256: 'e37850d4443fec003a6de3a38657802e36224d91abed4a082004df18474761cf' }
];

function main() {
  let failed = false;
  for (const item of EXPECTED) {
    let buf;
    try {
      buf = fs.readFileSync(path.join(WASM_DIR, item.file));
    } catch (e) {
      console.error('wasm/' + item.file + ': cannot read (' + e.code + ')');
      failed = true;
      continue;
    }
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (buf.length !== item.size) {
      console.error('wasm/' + item.file + ': size ' + buf.length + ', expected ' + item.size);
      failed = true;
    }
    if (sha !== item.sha256) {
      console.error('wasm/' + item.file + ': sha256 ' + sha + ', expected ' + item.sha256);
      failed = true;
    }
  }
  if (failed) process.exit(1);
  console.log('wasm OK');
}

main();
