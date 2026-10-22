(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.CamScanner = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_CONSTRAINTS = {
    video: {
      width: { ideal: 1920, min: 1280 },
      height: { ideal: 1080, min: 720 },
      facingMode: { exact: 'environment' },
      frameRate: { ideal: 30, min: 15 },
      focusMode: { ideal: 'continuous' },
      exposureMode: { ideal: 'continuous' },
      whiteBalanceMode: { ideal: 'continuous' }
    }
  };

  var FALLBACK_CONSTRAINTS = {
    video: {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      facingMode: 'environment'
    }
  };

  function clone(value) {
    var out, key;
    if (value === null || typeof value !== 'object') {
      return value;
    }
    out = {};
    for (key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        out[key] = clone(value[key]);
      }
    }
    return out;
  }

  function computeCrop(videoW, videoH, zoom) {
    var sw = videoW / zoom;
    var sh = videoH / zoom;
    return { sx: (videoW - sw) / 2, sy: (videoH - sh) / 2, sw: sw, sh: sh };
  }

  function createDeduper(dedupeMs) {
    var last = null;
    var lastSeen = 0;
    return {
      shouldEmit: function (text, now) {
        var same = text === last;
        var blocked = same && (dedupeMs === 0 || now - lastSeen < dedupeMs);
        last = text;
        lastSeen = now;
        return !blocked;
      },
      reset: function () {
        last = null;
        lastSeen = 0;
      }
    };
  }

  function buildConstraints(user, stage) {
    if (stage === 1 && user) {
      return user;
    }
    return clone(stage === 2 ? FALLBACK_CONSTRAINTS : DEFAULT_CONSTRAINTS);
  }

  var ENV_NAMES = ['navigator', 'document', 'requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout'];

  function globalObject() {
    if (typeof window !== 'undefined') { return window; }
    if (typeof self !== 'undefined') { return self; }
    if (typeof global !== 'undefined') { return global; }
    return {};
  }

  // ES5 glue over the Emscripten build of ZBar (wasm/zbar.js + wasm/zbar.wasm).
  // triggerDecode() takes ownership of the input buffer (ZBar frees it with the image),
  // so only the result string is freed here.
  // Derived from koder.js (maslick/koder, MIT, commit 6f8bebd2ad454ed5320b6519cb932cc52a4af9fa), rewritten in ES5.
  function ZbarKoder(factory) {
    this.factory = factory;
    this.mod = null;
    this.api = null;
  }

  ZbarKoder.prototype.initialize = function (config) {
    var self = this;
    var dir = stripSlashes((config && config.wasmDirectory) || 'wasm');
    if (typeof this.factory !== 'function') {
      return Promise.reject(new Error('CreateKoder not found: load wasm/zbar.js before calling start()'));
    }
    return Promise.resolve(this.factory({
      locateFile: function (file) { return dir + '/' + file; }
    })).then(function (mod) {
      self.mod = mod;
      self.api = {
        createBuffer: mod.cwrap('createBuffer', 'number', ['number']),
        deleteBuffer: mod.cwrap('deleteBuffer', '', ['number']),
        triggerDecode: mod.cwrap('triggerDecode', 'number', ['number', 'number', 'number']),
        getScanResults: mod.cwrap('getScanResults', 'number', []),
        getResultType: mod.cwrap('getResultType', 'number', [])
      };
      return self;
    });
  };

  ZbarKoder.prototype.decode = function (rgba, width, height) {
    var api = this.api;
    var mod = this.mod;
    var buffer = api.createBuffer(width * height * 4);
    var resultAddress, result;
    mod.HEAPU8.set(rgba, buffer);
    if (api.triggerDecode(buffer, width, height) > 0) {
      resultAddress = api.getScanResults();
      result = { code: mod.UTF8ToString(resultAddress), type: mod.UTF8ToString(api.getResultType()) };
      api.deleteBuffer(resultAddress);
      return result;
    }
    return null;
  };

  function stripSlashes(dir) {
    return dir.replace(/\/+$/, '');
  }

  // One decoder per wasmDir per page: scanners on the built-in wrapper share the init promise.
  // A rejected init leaves the cache, so the next start() tries again.
  var sharedKoders = {};

  function sharedKoder(dir, init) {
    var key = stripSlashes(dir);
    var p;
    if (!Object.prototype.hasOwnProperty.call(sharedKoders, key)) {
      p = init();
      sharedKoders[key] = p;
      p.then(null, function () {
        if (sharedKoders[key] === p) { delete sharedKoders[key]; }
      });
    }
    return sharedKoders[key];
  }

  // Injected members win; the rest come from the global object (functions bound to it).
  function resolveEnv(injected) {
    var g = globalObject();
    var src = injected || {};
    var out = {};
    var i, name, value;
    for (i = 0; i < ENV_NAMES.length; i++) {
      name = ENV_NAMES[i];
      if (src[name] !== undefined) {
        out[name] = src[name];
      } else {
        value = g[name];
        out[name] = typeof value === 'function' ? value.bind(g) : value;
      }
    }
    // Only the built-in wrapper over the page's CreateKoder is shared between scanners;
    // an injected Koder or CreateKoder (the test seam) stays per scanner.
    out.shared = !src.Koder && !src.CreateKoder;
    out.Koder = src.Koder || ZbarKoder;
    // wasm/zbar.js declares "var CreateKoder", a global binding, also reachable as a free identifier.
    out.CreateKoder = src.CreateKoder ||
      (typeof CreateKoder !== 'undefined' ? CreateKoder : g.CreateKoder);
    return out;
  }

  function attempt(fn) {
    try {
      return Promise.resolve(fn());
    } catch (e) {
      return Promise.reject(e);
    }
  }

  function normalizeZoom(level) {
    return typeof level === 'number' && isFinite(level) && level > 0 ? level : 1;
  }

  function stopStream(stream) {
    var tracks, i;
    try {
      tracks = stream.getTracks();
      for (i = 0; i < tracks.length; i++) {
        try { tracks[i].stop(); } catch (e) { /* already stopped */ }
      }
    } catch (e) { /* not a MediaStream */ }
  }

  function firstVideoTrack(stream) {
    var tracks = typeof stream.getVideoTracks === 'function' ? stream.getVideoTracks() : stream.getTracks();
    return tracks && tracks.length ? tracks[0] : null;
  }

  function applyTorch(track, on) {
    return attempt(function () {
      return track.applyConstraints({ advanced: [{ torch: on }] });
    });
  }

  function create(opts) {
    if (!opts || !opts.video) {
      throw new TypeError('CamScanner.create: opts.video is required');
    }
    var video = opts.video;
    var wasmDir = typeof opts.wasmDir === 'string' ? opts.wasmDir : 'wasm';
    var visualZoom = opts.visualZoom !== false;
    var zoom = opts.zoom === undefined ? 2 : normalizeZoom(opts.zoom);
    var deduper = createDeduper(typeof opts.dedupeMs === 'number' && opts.dedupeMs > 0 ? opts.dedupeMs : 0);
    var env = resolveEnv(opts.env);
    var state = 'idle';
    var startPromise = null;
    var session = { stopRequested: false, resolve: null };
    var koder = null;
    var koderPromise = null;
    var canvas = null;
    var ctx = null;
    var stream = null;
    var track = null;
    var torchOn = false;
    var rafId = null;
    var watchedTrack = null;
    var onTrackEnded = null;

    // An exception from onStatus/onError must not break the scanner; rethrow it asynchronously.
    function callUser(fn, args) {
      if (typeof fn !== 'function') { return; }
      try {
        fn.apply(null, args);
      } catch (e) {
        if (typeof env.setTimeout === 'function') {
          env.setTimeout(function () { throw e; }, 0);
        }
      }
    }

    function setState(next) {
      if (next === state) { return; }
      state = next;
      callUser(opts.onStatus, [next]);
    }

    function emitError(code, cause, message) {
      message = message || (cause && cause.message ? cause.message : String(cause));
      callUser(opts.onError, [{ code: code, message: message, cause: cause }]);
    }

    function fail(code, cause) {
      setState('idle');
      emitError(code, cause);
    }

    function applyVisualZoom() {
      if (visualZoom && video.style) {
        video.style.transform = zoom > 1 ? 'scale(' + zoom + ')' : '';
      }
    }

    // A refused play() (autoplay policy) is reported; the host can offer a tap that calls resume().
    function playVideo() {
      function refused(err) {
        if (state === 'scanning') { emitError('camera', err, 'video.play() rejected'); }
      }
      try {
        var played = video.play();
        if (played && typeof played.then === 'function') { played.then(null, refused); }
      } catch (e) {
        refused(e);
      }
    }

    function scheduleFrame() {
      if (rafId === null) {
        rafId = env.requestAnimationFrame(frame);
      }
    }

    function cancelFrame() {
      if (rafId !== null) {
        env.cancelAnimationFrame(rafId);
        rafId = null;
      }
    }

    function frame() {
      var vw, vh, crop, image, result;
      rafId = null;
      if (state !== 'scanning') { return; }
      try {
        vw = video.videoWidth;
        vh = video.videoHeight;
        if (vw && vh) {
          if (canvas.width !== vw || canvas.height !== vh) {
            canvas.width = vw;
            canvas.height = vh;
          }
          if (zoom > 1) {
            crop = computeCrop(vw, vh, zoom);
            ctx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, vw, vh);
          } else {
            ctx.drawImage(video, 0, 0);
          }
          image = ctx.getImageData(0, 0, vw, vh);
          result = koder.decode(image.data, vw, vh);
          if (result && deduper.shouldEmit(result.code, Date.now()) && typeof opts.onCode === 'function') {
            opts.onCode(result.code, result.type);
          }
        }
      } catch (e) {
        emitError('decode', e);
      }
      if (state === 'scanning') { scheduleFrame(); }
    }

    function initKoder() {
      return attempt(function () {
        return new env.Koder(env.CreateKoder).initialize({ wasmDirectory: wasmDir });
      });
    }

    // One init per scanner (per page and wasmDir with the built-in wrapper): stop→start during
    // loading-wasm reuses it; a failed init may be retried.
    function loadKoder() {
      if (!koderPromise) {
        koderPromise = env.shared ? sharedKoder(wasmDir, initKoder) : initKoder();
        koderPromise.then(null, function () { koderPromise = null; });
      }
      return koderPromise;
    }

    function requestCamera(s) {
      function gum(constraints) {
        return attempt(function () {
          return env.navigator.mediaDevices.getUserMedia(constraints);
        });
      }
      return gum(buildConstraints(opts.constraints, 1)).then(null, function (err) {
        if (s.stopRequested) { return null; }
        // The fallback only helps with unsatisfiable constraints, not with a refused permission.
        if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) { throw err; }
        return gum(buildConstraints(null, 2));
      }).then(null, function (err) {
        if (!s.stopRequested) { fail('camera', err); }
        return null;
      });
    }

    // The OS or another app can end the track (camera revoked, taken over, unplugged).
    function watchTrack(s, t) {
      if (!t || typeof t.addEventListener !== 'function') { return; }
      onTrackEnded = function () {
        if (s !== session || s.stopRequested || t !== track) { return; }
        // The session is over: a late loadedmetadata must not revive it.
        s.stopRequested = true;
        abortCamera(new Error('camera track ended'));
        if (s.resolve) { s.resolve(); }
      };
      watchedTrack = t;
      t.addEventListener('ended', onTrackEnded);
    }

    function unwatchTrack() {
      if (watchedTrack && onTrackEnded) {
        try { watchedTrack.removeEventListener('ended', onTrackEnded); } catch (e) { /* ignore */ }
      }
      watchedTrack = null;
      onTrackEnded = null;
    }

    // Gives the camera back after a failure past getUserMedia and reports it.
    function abortCamera(err) {
      var old = stream;
      unwatchTrack();
      cancelFrame();
      stream = null;
      track = null;
      torchOn = false;
      if (old) {
        stopStream(old);
        try {
          if (video.srcObject === old) { video.srcObject = null; }
        } catch (e) { /* ignore */ }
      }
      fail('camera', err);
    }

    function setupCanvas() {
      if (!canvas) {
        var created = env.document.createElement('canvas');
        var context = created.getContext('2d', { willReadFrequently: true });
        if (!context) { throw new Error('2d context unavailable'); }
        canvas = created;
        ctx = context;
      }
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }

    function attach(s, newStream) {
      stream = newStream;
      track = firstVideoTrack(newStream);
      watchTrack(s, track);
      video.setAttribute('playsinline', '');
      video.muted = true;
      video.autoplay = true;
      applyVisualZoom();
      return new Promise(function (resolve) {
        s.resolve = resolve;
        function onMetadata() {
          video.removeEventListener('loadedmetadata', onMetadata);
          if (s.stopRequested) { resolve(); return; }
          try {
            setupCanvas();
            setState('scanning');
            playVideo();
            scheduleFrame();
            if (opts.torch) { setTorch(true); }
          } catch (e) {
            abortCamera(e);
          }
          resolve();
        }
        video.addEventListener('loadedmetadata', onMetadata);
        video.srcObject = newStream;
      });
    }

    function start() {
      var s;
      if (state !== 'idle' && state !== 'stopped') { return startPromise; }
      s = { stopRequested: false, resolve: null };
      session = s;
      env = resolveEnv(opts.env);
      setState('loading-wasm');
      startPromise = loadKoder().then(function (loaded) {
        if (s.stopRequested) { return null; }
        koder = loaded;
        setState('requesting-camera');
        return requestCamera(s);
      }, function (err) {
        if (!s.stopRequested) { fail('wasm', err); }
        return null;
      }).then(function (newStream) {
        if (!newStream) { return undefined; }
        if (s.stopRequested) { stopStream(newStream); return undefined; }
        return attach(s, newStream);
      }).then(function () { return undefined; }, function (err) {
        // start() never rejects: anything unexpected ends up in onError.
        if (!s.stopRequested) { abortCamera(err); }
      });
      return startPromise;
    }

    function pause() {
      if (state !== 'scanning') { return; }
      cancelFrame();
      setState('paused');
    }

    function resume(options) {
      if (state !== 'paused' && state !== 'scanning') { return; }
      if (video.paused) { playVideo(); }
      if (options && options.resetDedupe) { deduper.reset(); }
      setState('scanning');
      scheduleFrame();
    }

    function stop() {
      var oldStream = stream;
      var oldTrack = track;
      var wasTorchOn = torchOn;
      var released = false;
      function release() {
        if (released) { return; }
        released = true;
        stopStream(oldStream);
        try {
          if (video.srcObject === oldStream) { video.srcObject = null; }
        } catch (e) { /* ignore */ }
      }
      try {
        session.stopRequested = true;
        if (session.resolve) { session.resolve(); }
        unwatchTrack();
        cancelFrame();
        stream = null;
        track = null;
        torchOn = false;
        setState('stopped');
        if (oldStream && wasTorchOn && oldTrack) {
          // Torch off first, but never wait more than 300 ms for it.
          return new Promise(function (resolve) {
            function finish() {
              release();
              resolve();
            }
            applyTorch(oldTrack, false).then(finish, finish);
            if (typeof env.setTimeout === 'function') { env.setTimeout(finish, 300); }
          });
        }
        if (oldStream) { release(); }
      } catch (e) { /* stop() never throws */ }
      return Promise.resolve();
    }

    function setZoom(level) {
      zoom = normalizeZoom(level);
      applyVisualZoom();
    }

    function setTorch(on) {
      var t = track;
      on = !!on;
      if (!t || typeof t.applyConstraints !== 'function') { return Promise.resolve('unsupported'); }
      return applyTorch(t, on).then(function () {
        var settings = null;
        if (t === track) { torchOn = on; }
        try {
          settings = typeof t.getSettings === 'function' ? t.getSettings() : null;
        } catch (e) { /* treated as not reported */ }
        // Many browsers accept the torch without reporting it: trust the requested state then.
        // Only an explicit mismatch means the request did nothing.
        if (settings && settings.torch !== undefined && settings.torch !== on) { return 'unsupported'; }
        return on ? 'on' : 'off';
      }, function (err) {
        emitError('torch', err);
        return 'unsupported';
      });
    }

    return {
      start: start,
      pause: pause,
      resume: resume,
      resetDedupe: function () { deduper.reset(); },
      stop: stop,
      setZoom: setZoom,
      setTorch: setTorch,
      getState: function () { return state; }
    };
  }

  var CamScanner = {};
  CamScanner.create = create;
  CamScanner._internals = {
    computeCrop: computeCrop,
    createDeduper: createDeduper,
    buildConstraints: buildConstraints,
    DEFAULT_CONSTRAINTS: DEFAULT_CONSTRAINTS,
    FALLBACK_CONSTRAINTS: FALLBACK_CONSTRAINTS,
    ZbarKoder: ZbarKoder
  };
  return CamScanner;
});
