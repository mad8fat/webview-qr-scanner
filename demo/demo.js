/*
 * webview-qr-scanner demo page. ES5, no dependencies.
 * Needs, in this order: ../wasm/zbar.js, ../src/cam-scanner.js, ../src/parsers/fns-receipt.js.
 * Anything that came from a scanned code is written with textContent, never innerHTML.
 */
(function () {
  'use strict';

  var HISTORY_MAX = 20;
  var RESCAN_DELAY_MS = 3000;
  var WASM_DIR = '../wasm';
  var LINK_RE = /^https?:\/\//i;
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var XLINK_NS = 'http://www.w3.org/1999/xlink';

  // Status pill text and tone for each scanner state.
  var STATE_STATUS = {
    'loading-wasm': ['Loading decoder…', 'busy'],
    'requesting-camera': ['Starting camera…', 'busy'],
    scanning: ['Point your camera at a code', 'success'],
    paused: ['Paused', 'warning'],
    stopped: ['Camera stopped', 'neutral'],
    idle: ['Ready', 'neutral']
  };

  var KIND_META = {
    link: { label: 'Link', icon: 'i-link', resultIcon: 'i-check-circle' },
    fns: { label: 'Receipt', icon: 'i-receipt', resultIcon: 'i-receipt' },
    barcode: { label: 'Barcode', icon: 'i-barcode', resultIcon: 'i-barcode' },
    text: { label: 'Text', icon: 'i-text', resultIcon: 'i-check-circle' }
  };

  var IDS = [
    'app', 'stage', 'video', 'status', 'statusText', 'loading', 'loadingText', 'progressBar',
    'errorPanel', 'errorIcon', 'errorTitle', 'errorText', 'errorDetail', 'btnRetry', 'tapToResume',
    'dialog', 'dialogIcon', 'dialogTitle', 'lastType', 'lastKind', 'lastCode', 'fnsFields',
    'btnOpenLink', 'btnScanAgain', 'btnClose',
    'btnZoom1', 'btnZoom2', 'btnZoom4', 'btnTorch', 'torchIcon', 'torchLabel', 'btnCamera',
    'btnPause', 'pauseIcon', 'pauseLabel', 'fps', 'historyCount',
    'history', 'historyEmpty', 'btnClear', 'repoLink', 'stateRaw',
    'httpsWarning', 'btnCopyRepo', 'copyLabel', 'btnHttpsClose', 'copyResult'
  ];

  var els = {};
  var zoomButtons = [];

  var scanner = null;
  var generation = 0;          // callbacks of a replaced scanner are ignored
  var scannerState = 'idle';
  var blocked = false;         // page is not on HTTPS: the scanner never starts
  var errorInfo = null;        // shown in the viewfinder after a camera or wasm error
  var currentResult = null;    // entry shown in the dialog
  var dialogFromHistory = false;
  var dialogPausedScanner = false;
  var rescanTimer = null;
  var zoomLevel = 2;
  var torchOn = false;
  var torchBusy = false;
  var devices = [];
  var currentDeviceId = null;
  var switching = false;
  var decodeWarned = false;
  var scans = [];

  // ---------- small helpers ----------

  function show(el) { el.hidden = false; }
  function hide(el) { el.hidden = true; }

  function setClass(el, name, on) {
    if (on) { el.classList.add(name); } else { el.classList.remove(name); }
  }

  function clearNode(el) {
    while (el.firstChild) { el.removeChild(el.firstChild); }
  }

  function make(tag, className) {
    var el = document.createElement(tag);
    if (className) { el.className = className; }
    return el;
  }

  function setIcon(svg, id) {
    var use = svg.getElementsByTagName('use')[0];
    use.setAttribute('href', '#' + id);
    use.setAttributeNS(XLINK_NS, 'xlink:href', '#' + id);
  }

  function makeIcon(id) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    var use = document.createElementNS(SVG_NS, 'use');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.appendChild(use);
    setIcon(svg, id);
    return svg;
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function formatTime(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }

  function formatAmount(amount) {
    var parts = amount.toFixed(2).split('.');
    return parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + '.' + parts[1] + ' ₽';
  }

  function isLink(text) { return LINK_RE.test(text); }

  // 'link' | 'fns' | 'barcode' | 'text'
  function classify(text, type) {
    if (isLink(text)) { return 'link'; }
    if (window.FnsReceipt && window.FnsReceipt.parse(text)) { return 'fns'; }
    if (type !== 'QR-Code') { return 'barcode'; }
    return 'text';
  }

  function resultTitle(entry) {
    if (entry.kind === 'fns') { return 'Receipt'; }
    if (entry.kind === 'barcode') { return 'Barcode detected'; }
    return entry.type === 'QR-Code' ? 'QR code detected' : 'Code detected';
  }

  function detectedStatus(entry) {
    return entry.kind === 'fns' ? 'Receipt detected' : resultTitle(entry);
  }

  function makeLink(url, className) {
    var a = make('a', className);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    return a;
  }

  // ---------- UI state ----------

  function updateStatus() {
    var s;
    if (blocked) {
      s = ['HTTPS required', 'error'];
    } else if (switching) {
      s = ['Switching camera…', 'busy'];
    } else if (rescanTimer !== null) {
      s = ['Move the code out of the frame', 'warning'];
    } else if (currentResult) {
      s = [dialogFromHistory ? 'Saved scan' : detectedStatus(currentResult), 'success'];
    } else if (errorInfo) {
      s = [errorInfo.status, 'error'];
    } else if (!els.tapToResume.hidden) {
      s = ['Tap to start camera', 'warning'];
    } else {
      s = STATE_STATUS[scannerState] || STATE_STATUS.idle;
    }
    els.statusText.textContent = s[0];
    els.status.setAttribute('data-tone', s[1]);
  }

  function updatePauseButton() {
    var canContinue = scannerState === 'paused' && !currentResult && rescanTimer === null;
    setClass(els.btnPause, 'is-active', canContinue);
    els.pauseLabel.textContent = canContinue ? 'Continue' : 'Pause';
    els.btnPause.setAttribute('aria-label', canContinue ? 'Continue scanning' : 'Pause scanning');
    setIcon(els.pauseIcon, canContinue ? 'i-play' : 'i-pause');
  }

  function updateControls() {
    var live = !blocked && !switching && (scannerState === 'scanning' || scannerState === 'paused');
    var starting = scannerState === 'loading-wasm' || scannerState === 'requesting-camera';
    var i;
    for (i = 0; i < zoomButtons.length; i++) { zoomButtons[i].disabled = blocked; }
    els.btnTorch.disabled = !live || torchBusy;
    els.btnPause.disabled = !live || !!currentResult || rescanTimer !== null;
    els.btnCamera.disabled = blocked || switching || starting || devices.length < 2;
    els.btnClear.disabled = scans.length === 0;
  }

  function updateUi() {
    updateStatus();
    updatePauseButton();
    updateControls();
  }

  function setTorchUi(mode) {
    setClass(els.btnTorch, 'is-on', mode === 'on');
    setClass(els.btnTorch, 'is-unavailable', mode === 'unavailable');
    els.torchLabel.textContent = mode === 'on' ? 'On' : (mode === 'unavailable' ? 'Unavailable' : 'Off');
    els.btnTorch.setAttribute('aria-label', mode === 'unavailable' ? 'Torch unavailable' : (mode === 'on' ? 'Torch on' : 'Torch off'));
    setIcon(els.torchIcon, mode === 'unavailable' ? 'i-torch-off' : 'i-torch');
  }

  function setZoomUi(level) {
    var i, b, active;
    for (i = 0; i < zoomButtons.length; i++) {
      b = zoomButtons[i];
      active = Number(b.getAttribute('data-zoom')) === level;
      setClass(b, 'is-active', active);
      b.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  // ---------- errors ----------

  function describeError(err) {
    var name = err.cause && err.cause.name;
    if (err.code === 'wasm') {
      return { status: 'Decoder error', title: 'Decoder unavailable',
        text: 'The barcode decoder could not be loaded. Check your connection and try again.' };
    }
    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
      return { status: 'Camera error', title: 'Camera access denied',
        text: 'Allow camera access in the browser or app settings, then try again.' };
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
      return { status: 'Camera error', title: 'No camera found',
        text: 'This device has no camera the page can use.' };
    }
    if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
      return { status: 'Camera error', title: 'Camera is busy',
        text: 'Another app is using the camera. Close it and try again.' };
    }
    return { status: 'Camera error', title: 'Camera unavailable',
      text: 'Please check permissions or another app using the camera.' };
  }

  function showErrorPanel(info, detail, icon, canRetry) {
    errorInfo = info;
    setIcon(els.errorIcon, icon);
    els.errorTitle.textContent = info.title;
    els.errorText.textContent = info.text;
    els.errorDetail.textContent = detail || '';
    els.btnRetry.hidden = !canRetry;
    hide(els.loading);
    hide(els.tapToResume);
    show(els.errorPanel);
  }

  function hideErrorPanel() {
    errorInfo = null;
    hide(els.errorPanel);
  }

  // ---------- scanner callbacks ----------

  function handleStatus(state) {
    scannerState = state;
    els.app.setAttribute('data-state', state);
    els.stateRaw.textContent = state;

    if (state === 'loading-wasm' || state === 'requesting-camera') {
      hideErrorPanel();
      hide(els.tapToResume);
      els.loadingText.textContent = state === 'loading-wasm' ? 'Loading decoder…' : 'Starting camera…';
      els.progressBar.style.width = state === 'loading-wasm' ? '35%' : '75%';
      show(els.loading);
    } else {
      hide(els.loading);
    }

    if (state === 'scanning') {
      hideErrorPanel();
      refreshDevices();
    }

    if (state === 'stopped' || state === 'idle') {
      hide(els.tapToResume);
      clearRescan();
      if (torchOn) { torchOn = false; setTorchUi('off'); }
    }
    updateUi();
  }

  function handleError(err) {
    if (!err) { return; }
    if (err.code === 'camera' && err.message === 'video.play() rejected') {
      // Autoplay refused: a tap is a user gesture, and resume() calls video.play() again.
      show(els.tapToResume);
      updateUi();
      return;
    }
    if (err.code === 'torch') { return; }  // the torch button shows the outcome of setTorch()
    if (err.code === 'decode') {
      if (!decodeWarned && window.console) {
        decodeWarned = true;
        window.console.warn('decode error: ' + err.message);
      }
      return;
    }
    showErrorPanel(describeError(err), err.message, 'i-alert', true);
    updateUi();
  }

  function handleCode(text, type) {
    var kind = classify(text, type);
    var entry = {
      text: text,
      type: type,
      kind: kind,
      fns: kind === 'fns' ? window.FnsReceipt.parse(text) : null,
      time: new Date()
    };
    addToHistory(entry);
    scanner.pause();
    dialogPausedScanner = true;
    showResult(entry, false);
  }

  function createScanner(constraints) {
    var gen = ++generation;
    var opts = {
      video: els.video,
      wasmDir: WASM_DIR,
      zoom: zoomLevel,
      onCode: function (text, type) { if (gen === generation) { handleCode(text, type); } },
      onStatus: function (state) { if (gen === generation) { handleStatus(state); } },
      onError: function (err) { if (gen === generation) { handleError(err); } }
    };
    if (constraints) { opts.constraints = constraints; }
    return window.CamScanner.create(opts);
  }

  // ---------- result dialog ----------

  function renderFields(fns) {
    var rows = [
      ['FN', fns.fn], ['FD', fns.fd], ['FP', fns.fp],
      ['Date', fns.date], ['Time', fns.time], ['Amount', formatAmount(fns.amount)]
    ];
    var i, dt, dd;
    clearNode(els.fnsFields);
    for (i = 0; i < rows.length; i++) {
      dt = make('dt');
      dt.textContent = rows[i][0];
      dd = make('dd');
      dd.textContent = rows[i][1];
      els.fnsFields.appendChild(dt);
      els.fnsFields.appendChild(dd);
    }
  }

  function showResult(entry, fromHistory) {
    var link = entry.kind === 'link';
    var a;
    currentResult = entry;
    dialogFromHistory = fromHistory;
    clearRescan();

    els.dialog.setAttribute('data-kind', entry.kind);
    setIcon(els.dialogIcon, KIND_META[entry.kind].resultIcon);
    els.dialogTitle.textContent = resultTitle(entry);
    els.lastType.textContent = entry.type;
    els.lastKind.textContent = KIND_META[entry.kind].label;

    clearNode(els.lastCode);
    if (link) {
      a = makeLink(entry.text);
      a.textContent = entry.text;
      els.lastCode.appendChild(a);
      els.btnOpenLink.href = entry.text;
      show(els.btnOpenLink);
    } else {
      els.lastCode.textContent = entry.text;
      els.btnOpenLink.removeAttribute('href');
      hide(els.btnOpenLink);
    }

    if (entry.kind === 'fns') {
      renderFields(entry.fns);
      show(els.fnsFields);
      hide(els.lastCode);
    } else {
      clearNode(els.fnsFields);
      hide(els.fnsFields);
      show(els.lastCode);
    }

    // With "Open link" present it is the primary action; otherwise "Scan again" is.
    els.btnScanAgain.className = 'btn ' + (link ? 'btn-secondary' : 'btn-primary');
    els.btnClose.className = 'btn ' + (link ? 'btn-ghost' : 'btn-secondary');

    show(els.dialog);
    updateUi();
  }

  function closeDialog() {
    hide(els.dialog);
    currentResult = null;
    dialogFromHistory = false;
    dialogPausedScanner = false;
  }

  function clearRescan() {
    if (rescanTimer !== null) {
      clearTimeout(rescanTimer);
      rescanTimer = null;
    }
  }

  function onClose() {
    var resume = dialogPausedScanner;
    closeDialog();
    if (resume && scannerState === 'paused') { scanner.resume(); }
    updateUi();
  }

  // "Scan again": give the user time to move the code away, then forget it so it can be read again.
  function onScanAgain() {
    closeDialog();
    clearRescan();
    if (scannerState === 'paused') {
      rescanTimer = setTimeout(function () {
        rescanTimer = null;
        if (scannerState === 'paused') {
          scanner.resume({ resetDedupe: true });
        } else {
          updateUi();
        }
      }, RESCAN_DELAY_MS);
    } else if (scanner && scannerState === 'scanning') {
      scanner.resetDedupe();
    }
    updateUi();
  }

  function openFromHistory(entry) {
    if (scannerState === 'scanning') {
      scanner.pause();
      dialogPausedScanner = true;
    } else if (!currentResult && rescanTimer === null) {
      dialogPausedScanner = false;
    } else if (rescanTimer !== null) {
      dialogPausedScanner = true;  // the countdown had the scanner paused on our behalf
    }
    showResult(entry, true);
    if (typeof els.stage.scrollIntoView === 'function') {
      els.stage.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }

  // ---------- history ----------

  function summary(entry) {
    if (entry.kind === 'fns') {
      return 'Receipt ' + formatAmount(entry.fns.amount) + ', ' + entry.fns.date;
    }
    return entry.text;
  }

  function historyRow(entry) {
    var li = make('li', 'history-row');
    var btn = make('button', 'history-item');
    var iconBox = make('span', 'history-icon');
    var body = make('span', 'history-body');
    var text = make('span', 'history-text');
    var meta = make('span', 'history-meta');
    var chevron, open;

    li.setAttribute('data-kind', entry.kind);
    btn.type = 'button';
    iconBox.appendChild(makeIcon(KIND_META[entry.kind].icon));
    text.textContent = summary(entry);
    meta.textContent = entry.type + ' · ' + formatTime(entry.time);
    body.appendChild(text);
    body.appendChild(meta);
    btn.appendChild(iconBox);
    btn.appendChild(body);
    btn.addEventListener('click', function () { openFromHistory(entry); });
    li.appendChild(btn);

    if (entry.kind === 'link') {
      open = makeLink(entry.text, 'history-open');
      open.setAttribute('aria-label', 'Open link');
      open.appendChild(makeIcon('i-external'));
      li.appendChild(open);
    } else {
      chevron = make('span', 'history-chevron');
      chevron.setAttribute('aria-hidden', 'true');
      chevron.appendChild(makeIcon('i-chevron'));
      btn.appendChild(chevron);
    }
    return li;
  }

  function renderHistory() {
    var i;
    clearNode(els.history);
    for (i = 0; i < scans.length; i++) {
      els.history.appendChild(historyRow(scans[i]));
    }
    els.historyCount.textContent = String(scans.length);
    els.historyEmpty.hidden = scans.length > 0;
    updateControls();
  }

  function addToHistory(entry) {
    scans.unshift(entry);
    if (scans.length > HISTORY_MAX) { scans.length = HISTORY_MAX; }
    renderHistory();
  }

  // ---------- controls ----------

  function onZoom(level) {
    zoomLevel = level;
    setZoomUi(level);
    if (scanner) { scanner.setZoom(level); }
  }

  function onTorch() {
    var gen = generation;
    if (!scanner || torchBusy) { return; }
    torchBusy = true;
    updateControls();
    scanner.setTorch(!torchOn).then(function (result) {
      torchBusy = false;
      if (gen === generation) {
        if (result === 'unsupported') {
          setTorchUi('unavailable');
        } else {
          torchOn = result === 'on';
          setTorchUi(result);
        }
      }
      updateControls();
    });
  }

  function onPause() {
    if (!scanner) { return; }
    if (scannerState === 'paused') {
      scanner.resume();
    } else if (scannerState === 'scanning') {
      scanner.pause();
    }
  }

  function refreshDevices() {
    var md = navigator.mediaDevices;
    if (!md || typeof md.enumerateDevices !== 'function') {
      devices = [];
      updateControls();
      return;
    }
    md.enumerateDevices().then(function (list) {
      var out = [];
      var i;
      for (i = 0; i < list.length; i++) {
        if (list[i].kind === 'videoinput' && list[i].deviceId) { out.push(list[i]); }
      }
      devices = out;
      updateControls();
    }, function () {
      devices = [];
      updateControls();
    });
  }

  function activeDeviceId() {
    var stream = els.video.srcObject;
    var tracks, settings;
    try {
      tracks = stream && stream.getVideoTracks ? stream.getVideoTracks() : [];
      settings = tracks.length && tracks[0].getSettings ? tracks[0].getSettings() : null;
      if (settings && settings.deviceId) { return settings.deviceId; }
    } catch (e) { /* fall through */ }
    return currentDeviceId;
  }

  function nextDevice() {
    var id = activeDeviceId();
    var i;
    for (i = 0; i < devices.length; i++) {
      if (devices[i].deviceId === id) { return devices[(i + 1) % devices.length]; }
    }
    return devices[0];
  }

  function onSwitchCamera() {
    var next, old;
    if (!scanner || switching || devices.length < 2) { return; }
    next = nextDevice();
    old = scanner;
    switching = true;
    closeDialog();
    clearRescan();
    hideErrorPanel();
    hide(els.tapToResume);
    generation++;                 // the old scanner's 'stopped' must not drive the UI
    handleStatus('stopped');
    old.stop().then(function () {
      switching = false;
      currentDeviceId = next.deviceId;
      torchOn = false;
      setTorchUi('off');
      scanner = createScanner({
        video: { deviceId: { exact: next.deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      });
      scanner.start();
    });
  }

  function onRetry() {
    hideErrorPanel();
    updateUi();
    if (scanner) { scanner.start(); }
  }

  function onTapToResume() {
    hide(els.tapToResume);
    if (scanner) { scanner.resume(); }
    updateUi();
  }

  // ---------- HTTPS warning ----------

  function needsHttps() {
    var host = location.hostname;
    return location.protocol !== 'https:' && host !== 'localhost' && host !== '127.0.0.1';
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    var ok = false;
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { ta.setSelectionRange(0, text.length); } catch (e) { /* old engines */ }
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function onCopyRepo() {
    var url = els.repoLink.href;
    function done(ok) {
      els.copyLabel.textContent = ok ? 'Link copied' : 'Copy repository link';
      els.copyResult.textContent = ok ? url : 'Copy this link: ' + url;
      show(els.copyResult);
    }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(url).then(function () { done(true); }, function () { done(fallbackCopy(url)); });
    } else {
      done(fallbackCopy(url));
    }
  }

  function enterBlocked() {
    blocked = true;
    els.app.setAttribute('data-state', 'blocked');
    els.stateRaw.textContent = 'not started (HTTPS required)';
    showErrorPanel({ status: 'HTTPS required', title: 'HTTPS required',
      text: 'Camera access works only on HTTPS (or localhost). Open this page via HTTPS.' }, '', 'i-lock', false);
    show(els.httpsWarning);
    updateUi();
    els.btnCopyRepo.focus();
  }

  // ---------- FPS: the page's own requestAnimationFrame rate while scanning ----------

  var fpsFrames = 0;
  var fpsSince = 0;

  function fpsTick(now) {
    now = typeof now === 'number' ? now : Date.now();
    if (!fpsSince) { fpsSince = now; }
    if (scannerState === 'scanning') { fpsFrames++; }
    if (now - fpsSince >= 1000) {
      els.fps.textContent = String(Math.round(fpsFrames * 1000 / (now - fpsSince)));
      fpsFrames = 0;
      fpsSince = now;
    }
    window.requestAnimationFrame(fpsTick);
  }

  // ---------- start ----------

  function bind() {
    var i;
    zoomButtons = [els.btnZoom1, els.btnZoom2, els.btnZoom4];
    for (i = 0; i < zoomButtons.length; i++) {
      zoomButtons[i].addEventListener('click', function () {
        onZoom(Number(this.getAttribute('data-zoom')));
      });
    }
    els.btnTorch.addEventListener('click', onTorch);
    els.btnCamera.addEventListener('click', onSwitchCamera);
    els.btnPause.addEventListener('click', onPause);
    els.btnScanAgain.addEventListener('click', onScanAgain);
    els.btnClose.addEventListener('click', onClose);
    els.btnRetry.addEventListener('click', onRetry);
    els.tapToResume.addEventListener('click', onTapToResume);
    els.btnClear.addEventListener('click', function () {
      scans = [];
      renderHistory();
    });
    els.btnCopyRepo.addEventListener('click', onCopyRepo);
    els.btnHttpsClose.addEventListener('click', function () { hide(els.httpsWarning); });
    els.video.addEventListener('playing', function () {
      if (!els.tapToResume.hidden) {
        hide(els.tapToResume);
        updateUi();
      }
    });
    document.addEventListener('keydown', function (e) {
      if ((e.key === 'Escape' || e.keyCode === 27) && currentResult) { onClose(); }
    });
    window.addEventListener('pagehide', function () {
      if (scanner) { scanner.stop(); }
    });
    window.addEventListener('pageshow', function (e) {
      // Back/forward cache: the camera was released on pagehide, take it again.
      if (e.persisted && scanner && !blocked) {
        closeDialog();
        scanner.start();
      }
    });
  }

  function init() {
    var i;
    for (i = 0; i < IDS.length; i++) { els[IDS[i]] = document.getElementById(IDS[i]); }
    bind();
    setZoomUi(zoomLevel);
    setTorchUi('off');
    renderHistory();
    window.requestAnimationFrame(fpsTick);

    if (needsHttps()) {
      enterBlocked();
      return;
    }
    if (!window.CamScanner) {
      showErrorPanel({ status: 'Error', title: 'Scanner not loaded',
        text: 'The scanner scripts could not be loaded. Reload the page.' }, '', 'i-alert', false);
      updateUi();
      return;
    }
    scanner = createScanner(null);
    scanner.start();
  }

  init();
})();
