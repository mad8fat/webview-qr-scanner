(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.FnsReceipt = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var REQUIRED = ['fn', 'i', 'fp', 't', 's'];
  var RE_T = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?$/;
  var RE_S = /^\d+(\.\d+)?$/;

  function fail(code) {
    parse.lastError = code;
    return null;
  }

  function parse(text, opts) {
    var strict = !(opts && opts.strict === false);
    if (typeof text !== 'string' || text.replace(/\s+/g, '') === '') {
      return fail('empty');
    }
    var params = {};
    var pairs = text.replace(/^\s+|\s+$/g, '').split('&');
    var i, parts;
    for (i = 0; i < pairs.length; i++) {
      parts = pairs[i].split('=');
      if (parts.length === 2) {
        params[parts[0]] = parts[1];
      }
    }
    for (i = 0; i < REQUIRED.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(params, REQUIRED[i]) || params[REQUIRED[i]] === '') {
        return fail('missing:' + REQUIRED[i]);
      }
    }
    if (strict && !/^\d{16}$/.test(params.fn)) return fail('bad:fn');
    if (!strict && !/^\d+$/.test(params.fn)) return fail('bad:fn');
    if (strict && !/^\d{1,10}$/.test(params.i)) return fail('bad:fd');
    if (!strict && !/^\d+$/.test(params.i)) return fail('bad:fd');
    if (strict && !/^\d{1,20}$/.test(params.fp)) return fail('bad:fp');
    if (!strict && !/^\d+$/.test(params.fp)) return fail('bad:fp');
    var m = RE_T.exec(params.t);
    if (!m) return fail('bad:t');
    if (!RE_S.test(params.s)) return fail('bad:s');

    parse.lastError = null;
    return {
      fn: params.fn,
      fd: params.i,
      fp: params.fp,
      date: m[1] + '-' + m[2] + '-' + m[3],
      time: m[4] + ':' + m[5],
      amount: Number(params.s),
      n: Object.prototype.hasOwnProperty.call(params, 'n') ? params.n : null,
      raw: text
    };
  }

  parse.lastError = null;
  return { parse: parse };
});
