'use strict';
// Checks that README.md and README.ru.md carry every required section (spec section 10)
// and that the Russian file is a full translation, not a summary.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DEMO_URL = 'https://mad8fat.github.io/webview-qr-scanner/demo/';
const FIRST_LINE_EN = 'Camera QR/barcode scanner that works inside Telegram WebView (iOS/Android) and iOS Safari. ' +
  'ZBar WASM, ~355 KB, zero dependencies, no build step.';
const MIN_RU_RATIO = 0.8;

// One pattern per required section; each must match a level-2 heading (`## ...`).
// No \b around Cyrillic: JavaScript word boundaries only know ASCII letters.
const SECTIONS = [
  { name: 'What it is', en: /\bwhat\b/i, ru: /что это/i },
  { name: 'Demo', en: /\bdemo\b/i, ru: /демо/i },
  { name: 'Quick start', en: /quick start/i, ru: /подключение/i },
  { name: 'API', en: /\bAPI\b/, ru: /\bAPI\b/ },
  { name: 'FNS receipt parser', en: /\bFNS\b/, ru: /ФНС/ },
  { name: 'Why it works', en: /\bwhy\b/i, ru: /почему/i },
  { name: 'Proof', en: /\bproof\b/i, ru: /доказательство/i },
  { name: 'Limitations', en: /\blimitations\b/i, ru: /ограничения/i },
  { name: 'License', en: /\blicen[sc]es?\b/i, ru: /лицензи/i },
  { name: 'Add a parser', en: /\badd\b.*\bparsers?\b/i, ru: /добавить.*парсер/i }
];

function read(name) {
  const file = path.join(ROOT, name);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

function headings(text) {
  return text.split('\n').filter(function (line) { return /^## /.test(line); });
}

function lineCount(text) {
  return text.replace(/\n+$/, '').split('\n').length;
}

// First line that is neither empty nor a heading.
function firstTextLine(text) {
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.trim() !== '' && !/^#/.test(line)) return line.trim();
  }
  return '';
}

function checkSections(name, text, lang, problems) {
  const hs = headings(text);
  for (const s of SECTIONS) {
    if (!hs.some(function (h) { return s[lang].test(h); })) {
      problems.push(name + ': no "## " heading for section "' + s.name + '" (' + s[lang] + ')');
    }
  }
  if (text.indexOf(DEMO_URL) === -1) problems.push(name + ': demo URL ' + DEMO_URL + ' missing');
}

function main() {
  const problems = [];
  const en = read('README.md');
  const ru = read('README.ru.md');
  if (en === null) problems.push('README.md: file missing');
  if (ru === null) problems.push('README.ru.md: file missing');
  if (en !== null) {
    checkSections('README.md', en, 'en', problems);
    if (firstTextLine(en) !== FIRST_LINE_EN) problems.push('README.md: first text line is not the fixed one-sentence summary');
  }
  if (ru !== null) checkSections('README.ru.md', ru, 'ru', problems);
  if (en !== null && ru !== null) {
    const enLines = lineCount(en);
    const ruLines = lineCount(ru);
    if (ruLines < Math.ceil(enLines * MIN_RU_RATIO)) {
      problems.push('README.ru.md: ' + ruLines + ' lines, needs at least ' + Math.round(MIN_RU_RATIO * 100) +
        ' % of README.md (' + enLines + ' lines)');
    }
  }
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log('readme OK');
}

main();
