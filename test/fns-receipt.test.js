'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const FnsReceipt = require('../src/parsers/fns-receipt.js');

const OK = 't=20231215T1830&s=1234.56&fn=1234567890123456&i=12345&fp=1234567890&n=1';
function build(over) {
  const p = { t: '20240101T0000', s: '10', fn: '1234567890123456', i: '1', fp: '1234567890' };
  Object.keys(over || {}).forEach(function (k) { p[k] = over[k]; });
  return Object.keys(p).map(function (k) { return k + '=' + p[k]; }).join('&');
}

test('valid receipt', function () {
  assert.deepEqual(FnsReceipt.parse(OK), {
    fn: '1234567890123456', fd: '12345', fp: '1234567890',
    date: '2023-12-15', time: '18:30', amount: 1234.56, n: '1', raw: OK
  });
  assert.equal(FnsReceipt.parse.lastError, null);
});

test('fp 14 digits (FFD 1.2) accepted', function () {
  const r = FnsReceipt.parse(build({ fp: '12345678901234' }));
  assert.equal(r.fp, '12345678901234');
});

test('fp 20 digits accepted', function () {
  const r = FnsReceipt.parse(build({ fp: '12345678901234567890' }));
  assert.equal(r.fp, '12345678901234567890');
});

test('fp 21 digits rejected', function () {
  assert.equal(FnsReceipt.parse(build({ fp: '123456789012345678901' })), null);
  assert.equal(FnsReceipt.parse.lastError, 'bad:fp');
});

test('fd 10 digits accepted; fd 11 digits rejected (bad:fd)', function () {
  const r = FnsReceipt.parse(build({ i: '1234567890' }));
  assert.equal(r.fd, '1234567890');
  assert.equal(FnsReceipt.parse(build({ i: '12345678901' })), null);
  assert.equal(FnsReceipt.parse.lastError, 'bad:fd');
});

test('fn not 16 digits rejected (bad:fn)', function () {
  assert.equal(FnsReceipt.parse(build({ fn: '123456789012345' })), null);
  assert.equal(FnsReceipt.parse.lastError, 'bad:fn');
  assert.equal(FnsReceipt.parse(build({ fn: '12345678901234567' })), null);
  assert.equal(FnsReceipt.parse.lastError, 'bad:fn');
});

test('missing fp -> null, lastError missing:fp', function () {
  assert.equal(FnsReceipt.parse('t=20240101T0000&s=10&fn=1234567890123456&i=1'), null);
  assert.equal(FnsReceipt.parse.lastError, 'missing:fp');
});

test('any order and extra params', function () {
  const r = FnsReceipt.parse('fp=1&fn=1234567890123456&x=1&i=2&s=10&t=20240101T0000');
  assert.notEqual(r, null);
  assert.equal(r.amount, 10);
});

test('t with seconds 20240101T000059 -> time 00:00', function () {
  const r = FnsReceipt.parse(build({ t: '20240101T000059' }));
  assert.equal(r.time, '00:00');
  assert.equal(r.date, '2024-01-01');
});

test('t malformed 2024-01-01 -> bad:t', function () {
  assert.equal(FnsReceipt.parse(build({ t: '2024-01-01' })), null);
  assert.equal(FnsReceipt.parse.lastError, 'bad:t');
});

test('comma amount s=12,50 -> bad:s', function () {
  assert.equal(FnsReceipt.parse(build({ s: '12,50' })), null);
  assert.equal(FnsReceipt.parse.lastError, 'bad:s');
});

test('url-encoded value fn=1234%20 -> bad:fn', function () {
  assert.equal(FnsReceipt.parse(build({ fn: '1234%20' })), null);
  assert.equal(FnsReceipt.parse.lastError, 'bad:fn');
});

test('strict:false returns fields without length checks', function () {
  const r = FnsReceipt.parse(build({ fp: '123456789012345678901' }), { strict: false });
  assert.notEqual(r, null);
  assert.equal(r.fp, '123456789012345678901');
});

test('non-receipt text (https://example.com) -> null, missing:fn', function () {
  assert.equal(FnsReceipt.parse('https://example.com'), null);
  assert.equal(FnsReceipt.parse.lastError, 'missing:fn');
});

test('empty string -> null, lastError empty', function () {
  assert.equal(FnsReceipt.parse(''), null);
  assert.equal(FnsReceipt.parse.lastError, 'empty');
});
