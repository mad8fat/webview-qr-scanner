'use strict';
// Minimal browser fakes for CamScanner tests: camera, video, canvas, rAF, timers and the ZBar Koder.
//
// makeEnv(options):
//   options.camera      — one entry per getUserMedia call: 'ok' (default) | 'fail' (OverconstrainedError) |
//                         'deny' (NotAllowedError) | 'manual' (parked in env.pendingCamera until resolve()/reject()).
//   options.torch       — 'ok' (default: getSettings reflects the applied torch) |
//                         'reject' (applyConstraints rejects) | 'no-report' (getSettings has no torch) |
//                         'mismatch' (applyConstraints resolves, getSettings keeps torch false) |
//                         'off-hangs' (turning the torch off never settles).
//   Tracks support addEventListener/removeEventListener; track.dispatch('ended') simulates the
//   OS ending the track (MediaStreamTrack.stop() itself does not fire 'ended', as in browsers).
//   options.wasmFails   — Koder.initialize() rejects.
//   options.playRejects — video.play() rejects.

function cameraError(name, message) {
  const err = new Error(message);
  err.name = name;
  return err;
}

function makeEnv(options = {}) {
  const camera = (options.camera || []).slice();
  const decodeQueue = [];
  const frames = [];
  let nextFrameId = 1;

  const env = {
    getUserMediaCalls: [],
    cameraErrors: [],
    streams: [],
    pendingCamera: [],
    canvases: [],
    drawImageCalls: [],
    decodeCalls: [],
    koderInstances: 0,
    koderInitCalls: [],
    cancelledFrames: [],
    timers: []
  };

  function makeTrack() {
    const listeners = {};
    const track = {
      kind: 'video',
      stopCalls: 0,
      events: [],
      settings: options.torch === 'mismatch' ? { torch: false } : {},
      addEventListener(type, fn) {
        (listeners[type] = listeners[type] || []).push(fn);
      },
      removeEventListener(type, fn) {
        const list = listeners[type] || [];
        const i = list.indexOf(fn);
        if (i !== -1) list.splice(i, 1);
      },
      listenerCount(type) {
        return (listeners[type] || []).length;
      },
      dispatch(type) {
        for (const fn of (listeners[type] || []).slice()) fn({ type, target: track });
      },
      stop() {
        track.stopCalls += 1;
        track.events.push('stop');
      },
      applyConstraints(constraints) {
        track.events.push(constraints);
        const advanced = constraints.advanced && constraints.advanced[0];
        if (options.torch === 'reject') return Promise.reject(new Error('torch rejected'));
        if (options.torch === 'off-hangs' && advanced && advanced.torch === false) return new Promise(() => {});
        if (options.torch !== 'no-report' && options.torch !== 'mismatch' && advanced && 'torch' in advanced) {
          track.settings.torch = advanced.torch;
        }
        return Promise.resolve();
      },
      getSettings() {
        return { ...track.settings };
      }
    };
    return track;
  }

  function makeStream() {
    const track = makeTrack();
    const stream = { track, getTracks: () => [track], getVideoTracks: () => [track] };
    env.streams.push(stream);
    return stream;
  }

  env.navigator = {
    mediaDevices: {
      getUserMedia(constraints) {
        env.getUserMediaCalls.push(constraints);
        const mode = camera.length ? camera.shift() : 'ok';
        if (mode === 'fail' || mode === 'deny') {
          const err = mode === 'deny'
            ? cameraError('NotAllowedError', 'Permission denied')
            : cameraError('OverconstrainedError', 'Constraints not satisfied');
          env.cameraErrors.push(err);
          return Promise.reject(err);
        }
        if (mode === 'manual') {
          return new Promise((resolve, reject) => {
            env.pendingCamera.push({ resolve: () => resolve(makeStream()), reject });
          });
        }
        return Promise.resolve(makeStream());
      }
    }
  };

  env.document = {
    createElement(tag) {
      if (tag !== 'canvas') throw new Error('unexpected element ' + tag);
      const ctx = {
        drawImage(...args) {
          env.drawImageCalls.push(args);
        },
        getImageData(x, y, w, h) {
          return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
        }
      };
      const canvas = {
        width: 300,
        height: 150,
        contextArgs: null,
        context: ctx,
        getContext(type, attrs) {
          canvas.contextArgs = [type, attrs];
          return canvas.context;
        }
      };
      env.canvases.push(canvas);
      return canvas;
    }
  };

  env.requestAnimationFrame = (cb) => {
    const id = nextFrameId++;
    frames.push({ id, cb });
    return id;
  };
  env.cancelAnimationFrame = (id) => {
    env.cancelledFrames.push(id);
    const i = frames.findIndex((f) => f.id === id);
    if (i !== -1) frames.splice(i, 1);
  };
  env.pendingFrames = () => frames.length;
  // Runs exactly one queued animation frame; returns false when none was queued.
  env.tick = () => {
    const frame = frames.shift();
    if (!frame) return false;
    frame.cb(16);
    return true;
  };

  // Manual timers: nothing runs until env.runTimers().
  env.setTimeout = (fn, ms) => {
    env.timers.push({ fn, ms });
    return env.timers.length;
  };
  env.runTimers = () => {
    for (const timer of env.timers.splice(0)) timer.fn();
  };

  env.Koder = class FakeKoder {
    constructor() {
      env.koderInstances += 1;
    }
    initialize(config) {
      env.koderInitCalls.push(config);
      if (options.wasmFails) return Promise.reject(new Error('wasm failed to load'));
      return Promise.resolve({
        decode(data, width, height) {
          env.decodeCalls.push({ length: data.length, width, height });
          return decodeQueue.length ? decodeQueue.shift() : null;
        }
      });
    }
  };
  // Queues the value returned by the next decode() call (default null).
  env.nextDecode = (result) => {
    decodeQueue.push(result);
  };

  env.video = makeVideo(options);
  return env;
}

function makeVideo(options) {
  let srcObject = null;
  const listeners = {};
  const video = {
    videoWidth: 1280,
    videoHeight: 720,
    paused: true,
    muted: false,
    autoplay: false,
    style: { transform: '' },
    attributes: {},
    playCalls: 0,
    attachSnapshot: null,
    setAttribute(name, value) {
      video.attributes[name] = String(value);
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners[type] || [];
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    },
    listenerCount(type) {
      return (listeners[type] || []).length;
    },
    play() {
      video.playCalls += 1;
      if (options.playRejects) return Promise.reject(cameraError('NotAllowedError', 'play() not allowed'));
      video.paused = false;
      return Promise.resolve();
    },
    get srcObject() {
      return srcObject;
    },
    set srcObject(value) {
      srcObject = value;
      if (!value) return;
      // What the element looked like at the moment the stream was attached.
      video.attachSnapshot = {
        playsinline: video.attributes.playsinline,
        muted: video.muted,
        autoplay: video.autoplay
      };
      queueMicrotask(() => {
        if (srcObject !== value) return;
        for (const fn of (listeners.loadedmetadata || []).slice()) fn({ type: 'loadedmetadata' });
      });
    }
  };
  return video;
}

module.exports = { makeEnv };
