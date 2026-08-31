/*
 * av-check.js — "Test Audio & Video Playback" for Peak-Abu.
 *
 * WHAT IT DOES
 * ------------
 * Before a session, let the user prove their capture settings are right:
 * pick a mic and a video source, record 15 seconds, and play it back. While
 * recording they can A/B noise suppression live; after recording they can A/B
 * the two recorded takes against each other at the same instant.
 *
 * It also grades the take — clipping, level, noise floor, estimated SNR,
 * whether the video source is actually producing frames — because "it played
 * back" is not the same as "these settings are good".
 *
 *     const check = new PeakAbuAVCheck({
 *       container: document.getElementById('avc'),
 *       nsBasePath: 'modules/noise-suppression'
 *     });
 *     await check.mount();
 *
 * INDEPENDENCE
 * ------------
 * The noise-suppression module is OPTIONAL. If window.PeakAbuNoiseSuppression
 * is absent the panel still works as a plain A/V test; the suppression
 * controls hide themselves. Nothing else in Peak-Abu is imported.
 *
 * WHY TWO RECORDERS
 * -----------------
 * Playback A/B needs raw and suppressed takes that line up sample-for-sample.
 * Recording both simultaneously off the same source gives that for free.
 * Processing offline afterwards would too, but it would double the wait and
 * could not show the user what suppression sounded like *while they spoke*.
 */

(function (global) {
  'use strict';

  var TEST_SECONDS = 15;
  var LEARN_SECONDS = 2;     // quiet countdown so the DSP backend can profile

  // Meter scaling. -60dBFS is the bottom of the meter, 0dBFS the top.
  var METER_FLOOR_DB = -60;

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function dbToPct(db) {
    if (!isFinite(db)) return 0;
    var p = (db - METER_FLOOR_DB) / (0 - METER_FLOOR_DB);
    return Math.max(0, Math.min(1, p)) * 100;
  }

  function fmtDb(db) {
    if (!isFinite(db) || db < -99) return '-∞ dB';
    return (db > 0 ? '+' : '') + db.toFixed(1) + ' dB';
  }

  function PeakAbuAVCheck(options) {
    options = options || {};
    this.container = options.container;
    this.nsBasePath = options.nsBasePath || 'modules/noise-suppression';
    this.testSeconds = options.testSeconds || TEST_SECONDS;
    this.onComplete = options.onComplete || null;

    // Lets the host app supply Peak-Abu's real capture stream instead of the
    // demo's getDisplayMedia. Signature: () => Promise<MediaStream>.
    this.videoSourceProvider = options.videoSourceProvider || null;

    this.ns = null;
    this.nsAvailable = typeof global.PeakAbuNoiseSuppression === 'function';

    this.micStream = null;
    this.videoStream = null;
    this.rawRecorder = null;
    this.wetRecorder = null;
    this.vidRecorder = null;
    this.rawChunks = [];
    this.wetChunks = [];
    this.vidChunks = [];
    this.rawUrl = null;
    this.wetUrl = null;
    this.vidUrl = null;

    this.state = 'idle';     // idle | learning | recording | ready | playing
    this.analysis = null;
    this._els = {};
    this._raf = null;
    this._frameProbe = null;
  }

  PeakAbuAVCheck.prototype = {

    // =============================================================
    // Mounting
    // =============================================================

    mount: function () {
      var self = this;
      if (!this.container) return Promise.reject(new Error('no container given'));
      this.container.classList.add('pa-avc');
      this.container.innerHTML = '';
      this._buildUI();
      return this._enumerateDevices().then(function () {
        return self;
      });
    },

    _buildUI: function () {
      var c = this.container;
      var e = this._els;

      // ---- Devices ----
      var devSec = el('div', 'pa-avc-section');
      devSec.appendChild(el('h4', null, 'Sources'));

      var micRow = el('div', 'pa-avc-row');
      micRow.appendChild(el('label', null, 'Microphone'));
      e.micSelect = el('select');
      micRow.appendChild(e.micSelect);
      devSec.appendChild(micRow);

      var outRow = el('div', 'pa-avc-row');
      outRow.appendChild(el('label', null, 'Playback'));
      e.outSelect = el('select');
      outRow.appendChild(e.outSelect);
      devSec.appendChild(outRow);

      var vidRow = el('div', 'pa-avc-row');
      vidRow.appendChild(el('label', null, 'Video'));
      e.videoBtn = el('button', 'pa-avc-btn-secondary', 'Choose video source…');
      e.videoBtn.style.flex = '1';
      vidRow.appendChild(e.videoBtn);
      devSec.appendChild(vidRow);
      c.appendChild(devSec);

      // ---- Video preview + vertical level meters, sharing height ----
      var avSec = el('div', 'pa-avc-section');
      avSec.appendChild(el('h4', null, 'Preview & Levels'));
      var avRow = el('div', 'pa-avc-av-row');

      e.metersVert = el('div', 'pa-avc-meters-vert');
      e.meterIn = this._buildMeterVertical(e.metersVert, 'In');
      e.meterOut = this._buildMeterVertical(e.metersVert, 'Out');
      avRow.appendChild(e.metersVert);

      e.videoWrap = el('div', 'pa-avc-video-wrap');
      e.video = document.createElement('video');
      e.video.autoplay = true;
      e.video.muted = true;
      e.video.playsInline = true;
      e.videoWrap.appendChild(e.video);
      e.videoEmpty = el('div', 'pa-avc-video-empty',
        'No video source selected.<br>Choose one above to preview what Peak-Abu will capture.');
      e.videoWrap.appendChild(e.videoEmpty);
      e.videoBadge = el('div', 'pa-avc-video-badge pa-avc-hidden');
      e.videoWrap.appendChild(e.videoBadge);
      avRow.appendChild(e.videoWrap);

      avSec.appendChild(avRow);
      if (this.nsAvailable) {
        e.reductionRow = el('p', 'pa-avc-note');
        avSec.appendChild(e.reductionRow);
      }
      c.appendChild(avSec);

      // ---- Run ----
      var runSec = el('div', 'pa-avc-section');
      var runRow = el('div', 'pa-avc-row');
      e.runBtn = el('button', 'pa-avc-btn-primary',
        'Test Audio &amp; Video Playback (' + this.testSeconds + 's)');
      e.runBtn.style.flex = '1';
      runRow.appendChild(e.runBtn);
      e.stopBtn = el('button', 'pa-avc-btn-secondary', 'Cancel');
      e.stopBtn.classList.add('pa-avc-hidden');
      runRow.appendChild(e.stopBtn);
      runSec.appendChild(runRow);

      e.progress = el('div', 'pa-avc-progress');
      e.progressFill = el('div', 'pa-avc-progress-fill');
      e.progress.appendChild(e.progressFill);
      runSec.appendChild(e.progress);
      e.status = el('div', 'pa-avc-status', 'Ready when you are.');
      runSec.appendChild(e.status);
      c.appendChild(runSec);

      // ---- Noise suppression (below the Test button now) ----
      var nsSec = el('div', 'pa-avc-section');
      nsSec.appendChild(el('h4', null, 'Noise suppression'));
      if (this.nsAvailable) {
        var engRow = el('div', 'pa-avc-row');
        engRow.appendChild(el('label', null, 'Engine'));
        e.backendSelect = el('select');
        var order = global.PeakAbuNoiseSuppression.backendOrder;
        var defs = global.PeakAbuNoiseSuppression.backends;
        for (var i = 0; i < order.length; i++) {
          var o = el('option');
          o.value = order[i];
          o.textContent = defs[order[i]].label;
          e.backendSelect.appendChild(o);
        }
        engRow.appendChild(e.backendSelect);
        nsSec.appendChild(engRow);

        e.backendNote = el('p', 'pa-avc-note pa-avc-backend-note');
        nsSec.appendChild(e.backendNote);

        e.strengthRow = el('div', 'pa-avc-row');
        e.strengthRow.appendChild(el('label', null, 'Strength'));
        e.strength = el('input');
        e.strength.type = 'range';
        e.strength.min = '0'; e.strength.max = '100'; e.strength.value = '65';
        e.strengthRow.appendChild(e.strength);
        e.strengthVal = el('span', 'pa-avc-val', '65%');
        e.strengthVal.style.minWidth = '38px';
        e.strengthRow.appendChild(e.strengthVal);
        nsSec.appendChild(e.strengthRow);

        var abWrap = el('div', 'pa-avc-row');
        abWrap.appendChild(el('label', null, 'Monitor'));
        e.ab = el('div', 'pa-avc-ab');
        e.abRaw = el('button', null, 'Raw');
        e.abClean = el('button', 'active', 'Suppressed');
        e.ab.appendChild(e.abRaw);
        e.ab.appendChild(e.abClean);
        e.ab.style.flex = '1';
        abWrap.appendChild(e.ab);
        nsSec.appendChild(abWrap);
      } else {
        nsSec.appendChild(el('p', 'pa-avc-note',
          'The noise-suppression module is not loaded, so this panel is ' +
          'running as a plain A/V test. Load ' +
          '<code>modules/noise-suppression/noise-suppression.js</code> to ' +
          'enable engine selection and A/B monitoring.'));
      }
      c.appendChild(nsSec);

      // ---- Playback + verdict ----
      e.resultSec = el('div', 'pa-avc-section pa-avc-hidden');
      e.resultSec.appendChild(el('h4', null, 'Playback'));

      e.pbVideoWrap = el('div', 'pa-avc-video-wrap pa-avc-hidden');
      e.pbVideoWrap.style.marginBottom = '10px';
      e.pbVideo = document.createElement('video');
      e.pbVideo.muted = true;
      e.pbVideo.playsInline = true;
      e.pbVideoWrap.appendChild(e.pbVideo);
      e.resultSec.appendChild(e.pbVideoWrap);

      var pbRow = el('div', 'pa-avc-row');
      e.playBtn = el('button', 'pa-avc-btn-primary', '▶ Play back');
      e.playBtn.style.flex = '1';
      pbRow.appendChild(e.playBtn);
      e.resultSec.appendChild(pbRow);

      var pbAb = el('div', 'pa-avc-row');
      pbAb.appendChild(el('label', null, 'Compare'));
      e.pbAb = el('div', 'pa-avc-ab');
      e.pbRaw = el('button', null, 'Raw');
      e.pbClean = el('button', 'active', 'Suppressed');
      e.pbAb.appendChild(e.pbRaw);
      e.pbAb.appendChild(e.pbClean);
      e.pbAb.style.flex = '1';
      pbAb.appendChild(e.pbAb);
      e.resultSec.appendChild(pbAb);
      e.resultSec.appendChild(el('p', 'pa-avc-note',
        'Both takes were recorded at the same time, so switching mid-playback ' +
        'compares the exact same moment.'));

      e.stats = el('div', 'pa-avc-stat-grid');
      e.stats.style.marginTop = '12px';
      e.resultSec.appendChild(e.stats);

      e.verdict = el('ul', 'pa-avc-verdict');
      e.verdict.style.marginTop = '12px';
      e.resultSec.appendChild(e.verdict);
      c.appendChild(e.resultSec);

      this._wireEvents();
    },

    _buildMeterVertical: function (parent, label) {
      var wrap = el('div', 'pa-avc-meter-v');
      wrap.appendChild(el('div', 'pa-avc-meter-v-label', label));
      var val = el('div', 'pa-avc-meter-v-val', '-∞');
      wrap.appendChild(val);
      var track = el('div', 'pa-avc-meter-v-track');
      var fill = el('div', 'pa-avc-meter-v-fill');
      track.appendChild(fill);
      wrap.appendChild(track);
      parent.appendChild(wrap);
      return { fill: fill, val: val };
    },

    _wireEvents: function () {
      var self = this;
      var e = this._els;

      e.micSelect.addEventListener('change', function () { self._restartMic(); });
      e.videoBtn.addEventListener('click', function () { self._pickVideo(); });
      e.runBtn.addEventListener('click', function () { self.run(); });
      e.stopBtn.addEventListener('click', function () { self.cancel(); });
      e.playBtn.addEventListener('click', function () { self._togglePlayback(); });

      e.pbRaw.addEventListener('click', function () { self._setPlaybackSource('raw'); });
      e.pbClean.addEventListener('click', function () { self._setPlaybackSource('clean'); });

      if (e.outSelect) {
        e.outSelect.addEventListener('change', function () { self._applySink(); });
      }
      if (this.nsAvailable) {
        e.abRaw.addEventListener('click', function () { self._setMonitor(true); });
        e.abClean.addEventListener('click', function () { self._setMonitor(false); });
        e.backendSelect.addEventListener('change', function () {
          self._applyBackend(e.backendSelect.value);
        });
        e.strength.addEventListener('input', function () {
          var v = parseInt(e.strength.value, 10) / 100;
          e.strengthVal.textContent = e.strength.value + '%';
          if (self.ns) self.ns.setStrength(v);
        });
      }
    },

    // =============================================================
    // Devices
    // =============================================================

    _enumerateDevices: function () {
      var self = this;
      var e = this._els;
      // Labels are blank until permission is granted, so ask first.
      return navigator.mediaDevices.getUserMedia({ audio: true })
        .then(function (s) {
          s.getTracks().forEach(function (t) { t.stop(); });
          return navigator.mediaDevices.enumerateDevices();
        })
        .catch(function () { return navigator.mediaDevices.enumerateDevices(); })
        .then(function (devices) {
          e.micSelect.innerHTML = '';
          e.outSelect.innerHTML = '';
          var mics = 0, outs = 0;
          devices.forEach(function (d) {
            if (d.kind === 'audioinput') {
              var o = el('option');
              o.value = d.deviceId;
              o.textContent = d.label || ('Microphone ' + (mics + 1));
              e.micSelect.appendChild(o);
              mics++;
            } else if (d.kind === 'audiooutput') {
              var p = el('option');
              p.value = d.deviceId;
              p.textContent = d.label || ('Output ' + (outs + 1));
              e.outSelect.appendChild(p);
              outs++;
            }
          });
          if (!mics) {
            var none = el('option');
            none.textContent = 'No microphone found';
            e.micSelect.appendChild(none);
            e.micSelect.disabled = true;
            e.runBtn.disabled = true;
            self._setStatus('No microphone detected.', 'bad');
          }
          // setSinkId is not universally available; hide the row if not.
          if (!outs || !('setSinkId' in HTMLMediaElement.prototype)) {
            e.outSelect.parentNode.classList.add('pa-avc-hidden');
          }
          return self._restartMic();
        });
    },

    /** Opens (or reopens) the mic and rebuilds the suppression graph. */
    _restartMic: function () {
      var self = this;
      var e = this._els;
      this._stopMic();

      var deviceId = e.micSelect.value;
      var constraints = {
        audio: {
          // Browser-side processing is disabled on purpose: it would run
          // BEFORE our suppressor and make the A/B meaningless, since the
          // "raw" side would already be cleaned by Chromium.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1
        }
      };
      if (deviceId) constraints.audio.deviceId = { exact: deviceId };

      return navigator.mediaDevices.getUserMedia(constraints)
        .then(function (stream) {
          self.micStream = stream;
          if (!self.nsAvailable) {
            self._startPlainMeter(stream);
            return null;
          }
          self.ns = new global.PeakAbuNoiseSuppression({
            basePath: self.nsBasePath,
            backend: e.backendSelect ? e.backendSelect.value : 'gtcrn',
            strength: e.strength ? parseInt(e.strength.value, 10) / 100 : 0.65,
            onMetrics: function (m) { self._onMetrics(m); },
            onBackendChange: function (b, isFallback) {
              self._onBackendChange(b, isFallback);
            }
          });
          return self.ns.process(stream);
        })
        .then(function () {
          self._setStatus('Ready when you are.');
        })
        .catch(function (err) {
          self._setStatus('Could not open the microphone: ' + err.message, 'bad');
        });
    },

    _onBackendChange: function (backend, isFallback) {
      var e = this._els;
      if (e.backendSelect) e.backendSelect.value = backend.id;
      if (e.backendNote) {
        e.backendNote.textContent =
          (isFallback ? 'Fell back to this engine — the previous one failed to load. ' : '') +
          backend.note;
      }
      if (e.strengthRow) {
        // The learned models have a fixed, trained suppression amount, so a
        // strength slider on them would be a lie.
        e.strengthRow.classList.toggle('pa-avc-hidden', !backend.strengthSupported);
      }
    },

    _applyBackend: function (id) {
      var self = this;
      if (!this.ns) return;
      this._setStatus('Loading ' + id + '…');
      this.ns.setBackend(id).then(function () {
        self._setStatus('Ready when you are.');
      }).catch(function (err) {
        self._setStatus('Engine failed: ' + err.message, 'bad');
      });
    },

    _setMonitor: function (raw) {
      var e = this._els;
      if (this.ns) this.ns.setBypass(raw);
      e.abRaw.classList.toggle('active', raw);
      e.abClean.classList.toggle('active', !raw);
    },

    /** Meter path used when the suppression module is absent. */
    _startPlainMeter: function (stream) {
      var self = this;
      var Ctx = global.AudioContext || global.webkitAudioContext;
      this._plainCtx = new Ctx();
      var src = this._plainCtx.createMediaStreamSource(stream);
      var an = this._plainCtx.createAnalyser();
      an.fftSize = 1024;
      src.connect(an);
      var buf = new Float32Array(an.fftSize);
      var tick = function () {
        an.getFloatTimeDomainData(buf);
        var s = 0;
        for (var i = 0; i < buf.length; i++) s += buf[i] * buf[i];
        var rms = Math.sqrt(s / buf.length);
        self._onMetrics({
          inRms: rms, outRms: rms,
          inDb: 20 * Math.log10(rms + 1e-9),
          outDb: 20 * Math.log10(rms + 1e-9),
          reductionDb: 0, speech: null, bypassed: true, backend: null
        });
        self._raf = requestAnimationFrame(tick);
      };
      tick();
    },

    _onMetrics: function (m) {
      var e = this._els;
      this._lastMetrics = m;

      var inPct = dbToPct(m.inDb);
      e.meterIn.fill.style.height = inPct + '%';
      e.meterIn.val.textContent = fmtDb(m.inDb);
      e.meterIn.fill.className = 'pa-avc-meter-v-fill' +
        (m.inDb > -3 ? ' clip' : m.inDb > -12 ? ' hot' : '');

      var outPct = dbToPct(m.outDb);
      e.meterOut.fill.style.height = outPct + '%';
      e.meterOut.val.textContent = fmtDb(m.outDb);
      e.meterOut.fill.className = 'pa-avc-meter-v-fill' +
        (m.outDb > -3 ? ' clip' : m.outDb > -12 ? ' hot' : '');

      if (e.reductionRow) {
        var r = m.reductionDb;
        e.reductionRow.textContent =
          'Removing ' + (isFinite(r) ? r.toFixed(1) : '0.0') + ' dB' +
          (m.speech != null
            ? '  ·  voice ' + Math.round(m.speech * 100) + '%'
            : '');
      }

      // Peak/noise accumulation for the post-test verdict.
      if (this.state === 'recording' && this._acc) {
        this._acc.frames++;
        this._acc.sumIn += m.inRms * m.inRms;
        if (m.inDb > this._acc.peakIn) this._acc.peakIn = m.inDb;
        // The suppression module's VAD is primary, but a simple energy
        // floor runs alongside it as a second, independent check — real
        // talking still counts even if the module's VAD misses it or (as
        // in the plain-meter fallback) never reports speech at all.
        var isSpeechLike = (m.speech != null && m.speech > 0.6) || (m.inDb > -40);
        if (isSpeechLike) {
          this._acc.speechFrames++;
          this._acc.sumSpeech += m.inRms * m.inRms;
        } else {
          this._acc.quietFrames++;
          this._acc.sumQuiet += m.inRms * m.inRms;
        }
        if (isFinite(m.reductionDb)) {
          this._acc.sumReduction += m.reductionDb;
          this._acc.reductionFrames++;
        }
      }
    },

    // =============================================================
    // Video
    // =============================================================

    _pickVideo: function () {
      var self = this;
      var e = this._els;
      var get = this.videoSourceProvider
        ? this.videoSourceProvider()
        : navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: 60 } },
            audio: false
          });

      return Promise.resolve(get).then(function (stream) {
        self._stopVideo();
        self.videoStream = stream;
        e.video.srcObject = stream;
        e.videoEmpty.classList.add('pa-avc-hidden');
        e.videoBadge.classList.remove('pa-avc-hidden');
        e.videoBtn.textContent = 'Change video source…';

        var track = stream.getVideoTracks()[0];
        if (track) {
          track.addEventListener('ended', function () { self._onVideoEnded(); });
        }
        self._startFrameProbe();
      }).catch(function (err) {
        if (err && err.name === 'NotAllowedError') return;   // user cancelled
        self._setStatus('Could not open the video source: ' + err.message, 'bad');
      });
    },

    /**
     * Measures the frame rate actually being delivered. A source that is
     * "connected" but frozen (a minimised window, a stale capture handle) is
     * the exact failure this whole panel exists to catch, and its settings
     * still look perfect.
     */
    _startFrameProbe: function () {
      var self = this;
      var e = this._els;
      this._stopFrameProbe();

      var frames = 0;
      var last = performance.now();
      var video = e.video;
      var useCallback = typeof video.requestVideoFrameCallback === 'function';

      var report = function () {
        var track = self.videoStream && self.videoStream.getVideoTracks()[0];
        var s = track ? track.getSettings() : {};
        var now = performance.now();
        var elapsed = (now - last) / 1000;
        var fps = elapsed > 0 ? frames / elapsed : 0;
        frames = 0;
        last = now;
        self._measuredFps = fps;
        e.videoBadge.textContent =
          (s.width || video.videoWidth || '?') + '×' +
          (s.height || video.videoHeight || '?') + '  ·  ' +
          fps.toFixed(0) + ' fps' +
          (fps < 1 ? '  ·  NO FRAMES' : '');
        e.videoBadge.style.color = fps < 1 ? 'var(--avc-danger)' : 'var(--avc-accent)';
      };

      if (useCallback) {
        var onFrame = function () {
          frames++;
          if (self._frameProbe) video.requestVideoFrameCallback(onFrame);
        };
        video.requestVideoFrameCallback(onFrame);
      }
      this._frameProbe = setInterval(function () {
        if (!useCallback) {
          // Fallback: webkitDecodedFrameCount where available, else assume
          // the element is producing whatever the track advertises.
          var q = video.getVideoPlaybackQuality
            ? video.getVideoPlaybackQuality()
            : null;
          if (q) {
            frames = q.totalVideoFrames - (self._lastTotalFrames || 0);
            self._lastTotalFrames = q.totalVideoFrames;
          }
        }
        report();
      }, 1000);
    },

    _stopFrameProbe: function () {
      if (this._frameProbe) { clearInterval(this._frameProbe); this._frameProbe = null; }
    },

    _onVideoEnded: function () {
      var e = this._els;
      this._stopFrameProbe();
      this.videoStream = null;
      e.video.srcObject = null;
      e.videoEmpty.classList.remove('pa-avc-hidden');
      e.videoBadge.classList.add('pa-avc-hidden');
      e.videoBtn.textContent = 'Choose video source…';
      this._setStatus('The video source stopped sharing.', 'warn');
    },

    // =============================================================
    // The test itself
    // =============================================================

    run: function () {
      var self = this;
      if (this.state !== 'idle' && this.state !== 'ready') return;
      if (!this.micStream) { this._setStatus('No microphone.', 'bad'); return; }

      this._resetResults();
      var e = this._els;
      e.runBtn.classList.add('pa-avc-hidden');
      e.stopBtn.classList.remove('pa-avc-hidden');
      e.resultSec.classList.add('pa-avc-hidden');

      // Give the DSP backend a quiet moment to profile the room first. The
      // learned engines have no per-room state, so skip it for them.
      var needsLearn = this.ns && this.ns.activeBackend &&
                       this.ns.activeBackend.id === 'dsp';
      if (!needsLearn) return this._startRecording();

      this.state = 'learning';
      var left = LEARN_SECONDS;
      this._setStatus('Stay quiet — profiling your room (' + left + ')…');
      this.ns.learnNoise(LEARN_SECONDS * 1000);
      this._learnTimer = setInterval(function () {
        left--;
        if (left > 0) {
          self._setStatus('Stay quiet — profiling your room (' + left + ')…');
        } else {
          clearInterval(self._learnTimer);
          self._learnTimer = null;
          self._startRecording();
        }
      }, 1000);
    },

    _startRecording: function () {
      var self = this;
      var e = this._els;
      this.state = 'recording';
      this.rawChunks = [];
      this.wetChunks = [];
      this.vidChunks = [];
      this._acc = {
        frames: 0, sumIn: 0, peakIn: -Infinity,
        speechFrames: 0, sumSpeech: 0,
        quietFrames: 0, sumQuiet: 0,
        sumReduction: 0, reductionFrames: 0,
        startedAt: Date.now()
      };

      var mime = this._pickMime();
      try {
        this.rawRecorder = new MediaRecorder(this.micStream, { mimeType: mime });
        this.rawRecorder.ondataavailable = function (ev) {
          if (ev.data && ev.data.size) self.rawChunks.push(ev.data);
        };
        this.rawRecorder.start();

        if (this.ns && this.ns.outputStream) {
          this.wetRecorder = new MediaRecorder(this.ns.outputStream, { mimeType: mime });
          this.wetRecorder.ondataavailable = function (ev) {
            if (ev.data && ev.data.size) self.wetChunks.push(ev.data);
          };
          this.wetRecorder.start();
        }
      } catch (err) {
        this._setStatus('Could not start recording: ' + err.message, 'bad');
        this._finishUI();
        return;
      }

      this._startVideoRecorder();

      this._setStatus('Recording — speak normally.', 'recording');
      var total = this.testSeconds * 1000;
      var t0 = performance.now();
      var tick = function () {
        if (self.state !== 'recording') return;
        var done = performance.now() - t0;
        var pct = Math.min(100, (done / total) * 100);
        e.progressFill.style.width = pct + '%';
        var remain = Math.ceil((total - done) / 1000);
        if (remain >= 0) {
          e.status.textContent = 'Recording — speak normally. ' + remain + 's left';
        }
        if (done >= total) { self._stopRecording(); return; }
        self._raf2 = requestAnimationFrame(tick);
      };
      tick();
    },

    /**
     * Video records into a third recorder of its own rather than being muxed
     * into one of the takes. The compare switch crossfades between two audio
     * elements, so either take has to stay swappable underneath the same
     * picture. A codec failure here must not abort the audio test, so this
     * degrades to the audio-only behaviour instead of throwing.
     */
    _startVideoRecorder: function () {
      var self = this;
      var track = this.videoStream && this.videoStream.getVideoTracks()[0];
      if (!track) return;
      try {
        this.vidRecorder = new MediaRecorder(
          new MediaStream([track]), { mimeType: this._pickVideoMime() });
        this.vidRecorder.ondataavailable = function (ev) {
          if (ev.data && ev.data.size) self.vidChunks.push(ev.data);
        };
        this.vidRecorder.start();
      } catch (err) {
        this.vidRecorder = null;
        this._setStatus('Recording audio only — this browser could not ' +
                        'record the video source: ' + err.message, 'warn');
      }
    },

    _pickMime: function () {
      var prefs = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus'
      ];
      for (var i = 0; i < prefs.length; i++) {
        if (MediaRecorder.isTypeSupported(prefs[i])) return prefs[i];
      }
      return '';
    },

    _pickVideoMime: function () {
      var prefs = [
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
        'video/mp4'
      ];
      for (var i = 0; i < prefs.length; i++) {
        if (MediaRecorder.isTypeSupported(prefs[i])) return prefs[i];
      }
      return '';
    },

    _stopRecording: function () {
      var self = this;
      if (this.state !== 'recording') return;
      this.state = 'ready';
      if (this._raf2) { cancelAnimationFrame(this._raf2); this._raf2 = null; }

      var pending = [];
      var close = function (rec) {
        if (!rec || rec.state === 'inactive') return Promise.resolve();
        return new Promise(function (resolve) {
          rec.onstop = resolve;
          rec.stop();
        });
      };
      pending.push(close(this.rawRecorder));
      pending.push(close(this.wetRecorder));
      pending.push(close(this.vidRecorder));

      Promise.all(pending).then(function () {
        self._buildPlayback();
        self._analyse();
        self._finishUI();
      });
    },

    cancel: function () {
      if (this._learnTimer) { clearInterval(this._learnTimer); this._learnTimer = null; }
      if (this._raf2) { cancelAnimationFrame(this._raf2); this._raf2 = null; }
      if (this.state === 'recording') {
        try { if (this.rawRecorder) this.rawRecorder.stop(); } catch (e) {}
        try { if (this.wetRecorder) this.wetRecorder.stop(); } catch (e) {}
        try { if (this.vidRecorder) this.vidRecorder.stop(); } catch (e) {}
      }
      this.state = 'idle';
      this._els.progressFill.style.width = '0%';
      this._setStatus('Cancelled.');
      this._finishUI();
    },

    _finishUI: function () {
      var e = this._els;
      e.runBtn.classList.remove('pa-avc-hidden');
      e.stopBtn.classList.add('pa-avc-hidden');
      e.runBtn.innerHTML = 'Test again (' + this.testSeconds + 's)';
    },

    _resetResults: function () {
      this._revokeUrls();
      if (this._els.pbVideo) {
        this._els.pbVideo.pause();
        this._els.pbVideo.removeAttribute('src');
        this._els.pbVideo.load();
      }
      this._els.stats.innerHTML = '';
      this._els.verdict.innerHTML = '';
      this._els.progressFill.style.width = '0%';
      this.analysis = null;
    },

    _revokeUrls: function () {
      if (this.rawUrl) { URL.revokeObjectURL(this.rawUrl); this.rawUrl = null; }
      if (this.wetUrl) { URL.revokeObjectURL(this.wetUrl); this.wetUrl = null; }
      if (this.vidUrl) { URL.revokeObjectURL(this.vidUrl); this.vidUrl = null; }
    },

    // =============================================================
    // Playback
    // =============================================================

    _buildPlayback: function () {
      var e = this._els;
      this._revokeUrls();

      if (this.rawChunks.length) {
        this.rawUrl = URL.createObjectURL(new Blob(this.rawChunks, { type: this._pickMime() }));
      }
      if (this.wetChunks.length) {
        this.wetUrl = URL.createObjectURL(new Blob(this.wetChunks, { type: this._pickMime() }));
      }
      if (this.vidChunks.length) {
        this.vidUrl = URL.createObjectURL(
          new Blob(this.vidChunks, { type: this._pickVideoMime() }));
      }
      if (!this.rawUrl && !this.wetUrl) {
        this._setStatus('Nothing was recorded.', 'bad');
        return;
      }

      if (!this._audioRaw) {
        this._audioRaw = new Audio();
        this._audioClean = new Audio();
        var self = this;
        [this._audioRaw, this._audioClean].forEach(function (a) {
          a.preload = 'auto';
          a.addEventListener('ended', function () { self._onPlaybackEnd(); });
        });
      }
      this._audioRaw.src = this.rawUrl || '';
      this._audioClean.src = this.wetUrl || this.rawUrl || '';
      // Only one is audible; the other tracks position silently so switching
      // lands at the same instant.
      this._playbackSource = this.wetUrl ? 'clean' : 'raw';
      this._applyPlaybackGains();
      this._applySink();

      // The recorded take replays in its own element; the preview above stays
      // on the live source so the frame-rate probe keeps measuring it.
      if (this.vidUrl) {
        e.pbVideo.src = this.vidUrl;
        e.pbVideo.currentTime = 0;
      } else {
        e.pbVideo.removeAttribute('src');
        e.pbVideo.load();
      }
      e.pbVideoWrap.classList.toggle('pa-avc-hidden', !this.vidUrl);

      // Hide the compare switch when there is only one take to compare.
      e.pbAb.parentNode.classList.toggle('pa-avc-hidden', !this.wetUrl);
      e.resultSec.classList.remove('pa-avc-hidden');
    },

    _applySink: function () {
      var e = this._els;
      var id = e.outSelect ? e.outSelect.value : null;
      if (!id) return;
      [this._audioRaw, this._audioClean].forEach(function (a) {
        if (a && a.setSinkId) { a.setSinkId(id).catch(function () {}); }
      });
    },

    _applyPlaybackGains: function () {
      var clean = this._playbackSource === 'clean';
      if (this._audioRaw) this._audioRaw.volume = clean ? 0 : 1;
      if (this._audioClean) this._audioClean.volume = clean ? 1 : 0;
      this._els.pbRaw.classList.toggle('active', !clean);
      this._els.pbClean.classList.toggle('active', clean);
    },

    _setPlaybackSource: function (which) {
      this._playbackSource = which;
      this._applyPlaybackGains();
    },

    _togglePlayback: function () {
      var self = this;
      var e = this._els;
      if (!this._audioRaw) return;

      if (this.state === 'playing') {
        this._audioRaw.pause();
        this._audioClean.pause();
        if (this.vidUrl) e.pbVideo.pause();
        this.state = 'ready';
        e.playBtn.innerHTML = '▶ Play back';
        return;
      }
      // Restart everything from zero together so they stay aligned.
      this._audioRaw.currentTime = 0;
      this._audioClean.currentTime = 0;
      var starts = [
        this._audioRaw.play().catch(function () {}),
        this._audioClean.play().catch(function () {})
      ];
      if (this.vidUrl) {
        e.pbVideo.currentTime = 0;
        starts.push(e.pbVideo.play().catch(function () {}));
      }
      Promise.all(starts).then(function () {
        self.state = 'playing';
        e.playBtn.innerHTML = '⏸ Pause';
      });
    },

    _onPlaybackEnd: function () {
      if (this.state !== 'playing') return;
      if (this.vidUrl) this._els.pbVideo.pause();
      this.state = 'ready';
      this._els.playBtn.innerHTML = '▶ Play back';
    },

    // =============================================================
    // Verdict
    // =============================================================

    _analyse: function () {
      var a = this._acc;
      if (!a || !a.frames) return;

      var toDb = function (meanSq) { return 10 * Math.log10(meanSq + 1e-12); };
      var avgIn = toDb(a.sumIn / a.frames);
      var speechDb = a.speechFrames ? toDb(a.sumSpeech / a.speechFrames) : null;
      var quietDb = a.quietFrames ? toDb(a.sumQuiet / a.quietFrames) : null;
      var snr = (speechDb != null && quietDb != null) ? speechDb - quietDb : null;
      var reduction = a.reductionFrames ? a.sumReduction / a.reductionFrames : 0;

      this.analysis = {
        peakDb: a.peakIn,
        avgDb: avgIn,
        speechDb: speechDb,
        noiseFloorDb: quietDb,
        snrDb: snr,
        reductionDb: reduction,
        spokeAtAll: a.speechFrames > a.frames * 0.05,
        fps: this._measuredFps || 0,
        hasVideo: !!this.videoStream
      };
      this._renderVerdict();
      if (this.onComplete) this.onComplete(this.analysis);
    },

    _renderVerdict: function () {
      var an = this.analysis;
      var e = this._els;
      if (!an) return;

      var stat = function (k, v) {
        var s = el('div', 'pa-avc-stat');
        s.appendChild(el('div', 'k', k));
        s.appendChild(el('div', 'v', v));
        return s;
      };
      e.stats.innerHTML = '';
      e.stats.appendChild(stat('Peak', fmtDb(an.peakDb)));
      if (an.speechDb != null) e.stats.appendChild(stat('Voice', fmtDb(an.speechDb)));
      if (an.noiseFloorDb != null) e.stats.appendChild(stat('Noise floor', fmtDb(an.noiseFloorDb)));
      if (an.snrDb != null) e.stats.appendChild(stat('SNR', fmtDb(an.snrDb)));
      if (this.ns) e.stats.appendChild(stat('Removed', fmtDb(an.reductionDb)));
      if (an.hasVideo) e.stats.appendChild(stat('Video', Math.round(an.fps) + ' fps'));

      var items = [];
      var add = function (level, text, detail) {
        items.push({ level: level, text: text, detail: detail });
      };

      if (!an.spokeAtAll) {
        add('warn', 'No speech detected',
          'The test only grades what it heard. Run it again and talk normally for the full ' +
          this.testSeconds + ' seconds.');
      }
      if (an.peakDb > -1) {
        add('bad', 'Your microphone is clipping',
          'Peaks hit ' + fmtDb(an.peakDb) + '. Turn the input gain down in Windows sound ' +
          'settings — clipped audio cannot be repaired afterwards, by suppression or anything else.');
      } else if (an.peakDb > -3) {
        add('warn', 'Very close to clipping',
          'Peaks at ' + fmtDb(an.peakDb) + '. A few dB of headroom would be safer.');
      } else if (an.speechDb != null && an.speechDb < -34) {
        add('warn', 'Microphone level is low',
          'Voice averaged ' + fmtDb(an.speechDb) + '. Raise the gain so normal speech ' +
          'sits nearer -18 dB, or you will amplify hiss later.');
      } else if (an.speechDb != null) {
        add('ok', 'Microphone level looks good', 'Voice averaged ' + fmtDb(an.speechDb) + '.');
      }

      if (an.noiseFloorDb != null) {
        if (an.noiseFloorDb > -40) {
          add('warn', 'Noisy environment',
            'Background sits at ' + fmtDb(an.noiseFloorDb) + '. Suppression will help a lot here — ' +
            'compare the two takes above.');
        } else if (an.noiseFloorDb > -55) {
          add('ok', 'Mild background noise', 'Background at ' + fmtDb(an.noiseFloorDb) + '.');
        } else {
          add('ok', 'Quiet environment', 'Background at ' + fmtDb(an.noiseFloorDb) + '.');
        }
      }

      if (an.snrDb != null) {
        if (an.snrDb < 10) {
          add('bad', 'Voice barely rises above the background',
            'Only ' + fmtDb(an.snrDb) + ' of separation. Move the mic closer to your mouth ' +
            'before relying on suppression to fix it.');
        } else if (an.snrDb < 20) {
          add('warn', 'Usable but not clean', fmtDb(an.snrDb) + ' between voice and background.');
        } else {
          add('ok', 'Strong signal-to-noise', fmtDb(an.snrDb) + ' between voice and background.');
        }
      }

      if (this.ns && an.reductionDb > 1) {
        add('ok', 'Suppression is working',
          'Removing ' + fmtDb(an.reductionDb) + ' on average with ' +
          (this.ns.activeBackend ? this.ns.activeBackend.label : 'the current engine') +
          '. Use the compare switch to confirm your voice still sounds natural.');
      }

      if (!an.hasVideo) {
        add('warn', 'No video source selected',
          'Pick the monitor or window Peak-Abu should capture, so you can confirm it is the right one.');
      } else if (an.fps < 1) {
        add('bad', 'Video source is not producing frames',
          'The source is connected but frozen. This is usually a minimised window — ' +
          'restore it, or capture the whole monitor instead.');
      } else if (an.fps < 20) {
        add('warn', 'Low capture frame rate',
          'Measured ' + Math.round(an.fps) + ' fps. Expect choppy highlights.');
      } else {
        add('ok', 'Video source is live', Math.round(an.fps) + ' fps.');
      }

      e.verdict.innerHTML = '';
      items.forEach(function (it) {
        var li = el('li');
        var icon = el('span', 'pa-avc-icon ' + it.level,
          it.level === 'ok' ? '✓' : it.level === 'warn' ? '!' : '✕');
        li.appendChild(icon);
        var body = el('div');
        body.appendChild(el('div', null, it.text));
        if (it.detail) body.appendChild(el('div', 'pa-avc-detail', it.detail));
        li.appendChild(body);
        e.verdict.appendChild(li);
      });

      this._setStatus('Test complete — play it back and check how it sounds.');
    },

    _setStatus: function (text, level) {
      var s = this._els.status;
      if (!s) return;
      s.textContent = text;
      s.className = 'pa-avc-status' + (level === 'recording' ? ' recording' : '');
      if (level === 'bad') s.style.color = 'var(--avc-danger)';
      else if (level === 'warn') s.style.color = 'var(--avc-warn)';
      else s.style.color = '';
    },

    // =============================================================
    // Teardown
    // =============================================================

    _stopMic: function () {
      if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
      if (this._plainCtx) { try { this._plainCtx.close(); } catch (e) {} this._plainCtx = null; }
      if (this.ns) { this.ns.destroy(); this.ns = null; }
      if (this.micStream) {
        this.micStream.getTracks().forEach(function (t) { t.stop(); });
        this.micStream = null;
      }
    },

    _stopVideo: function () {
      this._stopFrameProbe();
      if (this.videoStream) {
        this.videoStream.getTracks().forEach(function (t) { t.stop(); });
        this.videoStream = null;
      }
    },

    destroy: function () {
      this.cancel();
      this._stopMic();
      this._stopVideo();
      this._revokeUrls();
      if (this._audioRaw) { this._audioRaw.pause(); this._audioRaw = null; }
      if (this._audioClean) { this._audioClean.pause(); this._audioClean = null; }
      if (this._els.pbVideo) { this._els.pbVideo.pause(); }
      if (this.container) this.container.innerHTML = '';
    }
  };

  global.PeakAbuAVCheck = PeakAbuAVCheck;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PeakAbuAVCheck;
  }

})(typeof window !== 'undefined' ? window : this);
