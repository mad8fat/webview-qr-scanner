'use strict';
// Scans the repository for secrets and infrastructure traces (generic rules).
// Project-specific patterns are kept OUTSIDE the repository: set CHECK_CLEAN_PRIVATE to a file
// with one JavaScript regex source per line (blank lines and lines starting with # are ignored;
// a "cs:" prefix makes the pattern case-sensitive, otherwise it is case-insensitive).
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SELF = path.join('scripts', 'check-clean.js');
// .superpowers/ and tmp/ are git-ignored scratch space.
const SKIP_DIRS = ['.git', 'node_modules', '.superpowers', 'tmp'];
// Vendored upstream files, unmodifiable; their integrity is verified by check-wasm.js.
const SKIP_FILES = [
  path.join('wasm', 'zbar.wasm'),
  path.join('wasm', 'zbar.js')
];
// Every file is scanned except binaries.
const BINARY_EXTENSIONS = ['.wasm', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.pdf', '.zip'];

// Test fixtures that look like 10-digit numbers but are not real data.
const ALLOWED_NUMBERS = ['1234567890'];

// Generic rules only. Project-specific patterns are loaded from CHECK_CLEAN_PRIVATE at runtime.
const PATTERNS = [
  { re: /gho_/i },
  { re: /ghp_/i },
  { re: /BEGIN (RSA|OPENSSH)/i },
  { re: /password/i },
  { re: /passwd/i },
  { re: /api[_-]?key/i },
  // .env not preceded by an identifier, `]`, `)` or `.`: catches file references, skips property access like opts.env.
  { re: /(^|[^\w$\]).])\.env\b/i }
];

// IPv4-like numbers are flagged, except loopback.
const IPV4 = /\b\d{1,3}(\.\d{1,3}){3}\b/g;
const ALLOWED_IPS = ['127.0.0.1'];

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/g;
const ALLOWED_EMAIL = /(users\.noreply\.github\.com|example\.com)$/i;

function loadPrivate() {
  const file = process.env.CHECK_CLEAN_PRIVATE;
  if (!file) {
    console.log('private list: not loaded (set CHECK_CLEAN_PRIVATE)');
    return [];
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    console.error('CHECK_CLEAN_PRIVATE: cannot read private pattern file: ' + e.message);
    process.exit(1);
  }
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const cs = line.indexOf('cs:') === 0;
    const src = cs ? line.slice(3) : line;
    try {
      out.push({ re: new RegExp(src, cs ? '' : 'i'), priv: true });
    } catch (e) {
      console.error('CHECK_CLEAN_PRIVATE: invalid pattern on a line of the private file: ' + e.message);
      process.exit(1);
    }
  }
  console.log('private list: ' + out.length + ' patterns');
  return out;
}

const TEN_DIGITS = /\b\d{10}\b/g;

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.indexOf(entry.name) === -1) walk(full, out);
    } else if (entry.isFile() && BINARY_EXTENSIONS.indexOf(path.extname(entry.name).toLowerCase()) === -1) {
      out.push(full);
    }
  }
  return out;
}

function main() {
  const patterns = PATTERNS.concat(loadPrivate());
  const findings = [];
  for (const file of walk(ROOT, [])) {
    const rel = path.relative(ROOT, file);
    if (rel === SELF || SKIP_FILES.indexOf(rel) !== -1) continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach(function (line, i) {
      for (const p of patterns) {
        if (p.re.test(line)) findings.push(rel + ':' + (i + 1) + ': ' + p.re.source);
      }
      for (const m of line.match(IPV4) || []) {
        if (ALLOWED_IPS.indexOf(m) === -1) findings.push(rel + ':' + (i + 1) + ': IPv4 address');
      }
      for (const m of line.match(EMAIL) || []) {
        if (!ALLOWED_EMAIL.test(m)) findings.push(rel + ':' + (i + 1) + ': email address');
      }
      for (const m of line.match(TEN_DIGITS) || []) {
        if (ALLOWED_NUMBERS.indexOf(m) === -1) findings.push(rel + ':' + (i + 1) + ': 10-digit number ' + m);
      }
    });
  }
  if (findings.length) {
    console.error(findings.join('\n'));
    process.exit(1);
  }
  console.log('clean OK');
}

main();
