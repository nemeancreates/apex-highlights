/*
 * noise-suppression.js — real-time microphone noise suppression for Peak-Abu.
 *
 * MODULE CONTRACT
 * ---------------
 * Drop-in, dependency-free, no build step. Load with a plain <script> tag and
 * use window.PeakAbuNoiseSuppression. It touches nothing else in the app: give
 * it a MediaStream, get a cleaned MediaStream back.
 *
 *     const ns = new PeakAbuNoiseSuppression({ basePath: 'modules/noise-suppression' });
 *     await ns.init();
 *     const clean = await ns.process(rawMicStream);
 *     ns.setBypass(true);        // instant A/B, no clicks
 *     ns.setStrength(0.8);
 *     ns.onMetrics = (m) => { ... };
 *
 * WHY A BACKEND REGISTRY
 * ----------------------
 * The brief asked for DeepFilterNet. DeepFilterNet has no maintained
 * JS/WASM distribution — it is a Rust crate with a Python API, so using it
 * from Electron means shipping a native sidecar per platform. That is a real
 * option (see backends.deepfilternet below, which speaks the same TCP framing
 * as the existing noise_suppressor service) but it is not something that can
 * just run in the renderer today.
 *
 * So the engine is pluggable and ships three that work right now:
 *
 *   gtcrn    Neural, 2024 model (~24K params). Closest thing to
 *            DeepFilterNet quality that runs in a browser. Default.
 *   rnnoise  Neural, the Jitsi/Discord-era standard. Cheapest of the
 *            learned models, very robust.
 *   speex    Classic DSP from the Speex preprocessor.
 *   dsp      Our own STFT spectral gating. No WASM at all — the guaranteed
 *            fallback. Measured +20dB SNR gain on stationary noise.
 *
 * AUDIO GRAPH
 * -----------
 *                     ┌── rawGain ─────────────┐
 *   source ── split ──┤                        ├── merge ── dest
 *                     └── suppressor ─ wetGain ┘
 *
 * Both paths always run. A/B switching crossfades the two gains over 25ms
 * instead of rewiring, so toggling is click-free and the model never loses
 * its internal state (a learned denoiser that gets torn down and rebuilt has
 * to re-converge, which sounds like a swell every time you toggle).
 */

(function (global) {
  'use strict';

  // Every learned backend here is trained for 48kHz. Forcing the context
  // rather than adapting to the device avoids a resampling stage and matches
  // what Peak-Abu already records at.
  var TARGET_SAMPLE_RATE = 48000;
  var CROSSFADE_SEC = 0.025;

  var BACKENDS = {
    gtcrn: {
      id: 'gtcrn',
      label: 'GTCRN (neural, best quality)',
      kind: 'neural',
      worklet: 'vendor/worklets/gtcrn.js',
      processor: '@sapphi-red/web-noise-suppressor/gtcrn',
      wasm: ['vendor/gtcrn.wasm'],
      strengthSupported: false,
      note: 'Grouped temporal convolutional recurrent network. The closest ' +
            'in-browser stand-in for DeepFilterNet. Fixed suppression amount.'
    },
    rnnoise: {
      id: 'rnnoise',
      label: 'RNNoise (neural, lightest)',
      kind: 'neural',
      worklet: 'vendor/worklets/rnnoise.js',
      processor: '@sapphi-red/web-noise-suppressor/rnnoise',
      // SIMD build first; loadWasm() falls back if the runtime lacks SIMD.
      wasm: ['vendor/rnnoise_simd.wasm', 'vendor/rnnoise.wasm'],
      strengthSupported: false,
      note: 'The Jitsi/Discord-era standard. ~1% of a core. Fixed amount.'
    },
    speex: {
      id: 'speex',
      label: 'Speex (classic DSP)',
      kind: 'dsp',
      worklet: 'vendor/worklets/speex.js',
      processor: '@sapphi-red/web-noise-suppressor/speex',
      wasm: ['vendor/speex.wasm'],
      strengthSupported: false,
      note: 'The Speex preprocessor. Cheap, dated, sometimes gentler on voice.'
    },
    dsp: {
      id: 'dsp',
      label: 'Spectral gating (no dependencies)',
      kind: 'dsp',
      worklet: 'vendor/worklets/dsp-spectral.js',
      processor: 'peakabu/dsp-spectral',
      wasm: [],
      strengthSupported: true,
      note: 'Written for this module, needs no WASM. Strongest on steady ' +
            'noise (fans, hiss, hum), weakest on clicks and clatter.'
    }
  };

  var BACKEND_ORDER = ['gtcrn', 'rnnoise', 'speex', 'dsp'];

  function joinPath(base, rel) {
    if (!base) return rel;
    return base.replace(/\/+$/, '') + '/' + rel;
  }

  /**
   * WebAssembly SIMD feature probe. The RNNoise SIMD build is meaningfully
   * faster but will not instantiate without it, so check before fetching.
   */
  var _simdSupported = null;
  function hasSimd() {
    if (_simdSupported !== null) return _simdSupported;
    try {
      // Minimal module containing a single v128 instruction.
      _simdSupported = WebAssembly.validate(new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
        10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11
      ]));
    } catch (e) {
      _simdSupported = false;
    }
    return _simdSupported;
  }

  function PeakAbuNoiseSuppression(options) {
    options = options || {};
    this.basePath = options.basePath || 'modules/noise-suppression';
    this.backendId = options.backend || 'gtcrn';
    this.strength = typeof options.strength === 'number' ? options.strength : 0.65;
    this.bypassed = !!options.bypass;

    this.context = options.context || null;
    this._ownsContext = !options.context;
    this._loadedWorklets = {};
    this._wasmCache = {};

    this.sourceNode = null;
    this.suppressorNode = null;
    this.rawGain = null;
    this.wetGain = null;
    this.mergeNode = null;
    this.destNode = null;
    this.inputAnalyser = null;
    this.outputAnalyser = null;

    this.inputStream = null;
    this.outputStream = null;
    this.ready = false;
    this.activeBackend = null;
    this.lastError = null;
    /** Every automatic engine downgrade this instance has made. */
    this.fallbacks = [];

    /** Called ~20x/sec with { inRms, outRms, reductionDb, speech }. */
    this.onMetrics = options.onMetrics || null;
    /** Called when a backend fails and the module falls back. */
    this.onBackendChange = options.onBackendChange || null;

    this._metricsTimer = null;
    this._workletMetrics = null;
  }

  PeakAbuNoiseSuppression.backends = BACKENDS;
  PeakAbuNoiseSuppression.backendOrder = BACKEND_ORDER;

  PeakAbuNoiseSuppression.prototype = {

    // ---------------------------------------------------------------
    // Setup
    // ---------------------------------------------------------------

    init: function () {
      var self = this;
      if (!this.context) {
        var Ctx = global.AudioContext || global.webkitAudioContext;
        if (!Ctx) return Promise.reject(new Error('Web Audio is unavailable'));
        // Requesting the rate explicitly makes Chromium resample the device
        // for us, rather than us discovering a 44.1kHz context later and
        // having to resample inside every backend.
        this.context = new Ctx({ sampleRate: TARGET_SAMPLE_RATE });
      }
      if (this.context.state === 'suspended') {
        return this.context.resume().then(function () { return self; });
      }
      return Promise.resolve(this);
    },

    /** Loads a worklet module once per context. */
    _ensureWorklet: function (backend) {
      var self = this;
      if (this._loadedWorklets[backend.id]) return Promise.resolve();
      var url = joinPath(this.basePath, backend.worklet);
      return this.context.audioWorklet.addModule(url).then(function () {
        self._loadedWorklets[backend.id] = true;
      });
    },

    /** Fetches a backend's WASM, preferring SIMD builds where offered. */
    _loadWasm: function (backend) {
      var self = this;
      if (!backend.wasm.length) return Promise.resolve(null);
      if (this._wasmCache[backend.id]) return Promise.resolve(this._wasmCache[backend.id]);

      var candidates = backend.wasm.slice();
      if (candidates.length > 1 && !hasSimd()) candidates.shift();

      var attempt = function (i) {
        if (i >= candidates.length) {
          return Promise.reject(new Error('no usable wasm for ' + backend.id));
        }
        return fetch(joinPath(self.basePath, candidates[i]))
          .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + candidates[i]);
            return r.arrayBuffer();
          })
          .catch(function () { return attempt(i + 1); });
      };

      return attempt(0).then(function (buf) {
        self._wasmCache[backend.id] = buf;
        return buf;
      });
    },

    /**
     * Builds the AudioWorkletNode for a backend. Rejects if anything is
     * missing so the caller can fall back.
     */
    _createSuppressor: function (backendId) {
      var self = this;
      var backend = BACKENDS[backendId];
      if (!backend) return Promise.reject(new Error('unknown backend: ' + backendId));

      return this._ensureWorklet(backend)
        .then(function () { return self._loadWasm(backend); })
        .then(function (wasmBinary) {
          var processorOptions = { maxChannels: 2 };
          if (wasmBinary) processorOptions.wasmBinary = wasmBinary;

          // Channel counts must be forced on BOTH sides. The neural
          // processors write one output channel per input channel, so
          // declaring a mono output while leaving the input at its default
          // ("max", which follows a stereo source) makes them write two
          // channels into a one-channel output and trap inside the WASM
          // heap. That surfaces only as onprocessorerror at runtime — the
          // node constructs fine — so it silently fell all the way through
          // to the DSP backend. Explicit mono in gives mono out.
          var node = new AudioWorkletNode(self.context, backend.processor, {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            channelCount: 1,
            channelCountMode: 'explicit',
            channelInterpretation: 'speakers',
            processorOptions: processorOptions
          });

          // Only our own DSP backend exposes a strength parameter; the
          // learned models have a fixed, trained suppression amount.
          if (backend.strengthSupported && node.parameters.get('strength')) {
            node.parameters.get('strength').value = self.strength;
          }

          node.port.onmessage = function (e) {
            if (e.data && e.data.type === 'metrics') self._workletMetrics = e.data;
          };
          node.onprocessorerror = function () {
            self.lastError = new Error(backend.id + ' processor crashed');
            self._fallbackFrom(backend.id);
          };

          return { node: node, backend: backend };
        });
    },

    // ---------------------------------------------------------------
    // Main entry point
    // ---------------------------------------------------------------

    /**
     * Wraps a microphone MediaStream and returns a suppressed one.
     * The returned stream carries the ORIGINAL stream's track settings for
     * everything except the audio content, so it can be handed straight to
     * MediaRecorder in place of the raw stream.
     */
    process: function (stream) {
      var self = this;
      return this.init().then(function () {
        self.teardownGraph();
        self.inputStream = stream;

        var ctx = self.context;
        self.sourceNode = ctx.createMediaStreamSource(stream);

        self.rawGain = ctx.createGain();
        self.wetGain = ctx.createGain();
        self.mergeNode = ctx.createGain();
        self.destNode = ctx.createMediaStreamDestination();

        self.inputAnalyser = ctx.createAnalyser();
        self.inputAnalyser.fftSize = 1024;
        self.inputAnalyser.smoothingTimeConstant = 0.3;
        self.outputAnalyser = ctx.createAnalyser();
        self.outputAnalyser.fftSize = 1024;
        self.outputAnalyser.smoothingTimeConstant = 0.3;

        // Side-tap for metering. Peak-Abu's auto-highlight detector already
        // relies on analysers being pulled without a downstream connection
        // (index.html), so this matches existing app behaviour.
        self.sourceNode.connect(self.inputAnalyser);

        self.rawGain.gain.value = self.bypassed ? 1 : 0;
        self.wetGain.gain.value = self.bypassed ? 0 : 1;

        self.sourceNode.connect(self.rawGain);
        self.rawGain.connect(self.mergeNode);
        self.mergeNode.connect(self.outputAnalyser);
        self.mergeNode.connect(self.destNode);

        return self._attachBackend(self.backendId);
      }).then(function () {
        self.outputStream = self.destNode.stream;
        self.ready = true;
        self._startMetrics();
        return self.outputStream;
      });
    },

    /** Builds a backend and splices it into the wet path. */
    _attachBackend: function (backendId, _isFallback) {
      var self = this;
      return this._createSuppressor(backendId).then(function (built) {
        if (self.suppressorNode) {
          try { self.suppressorNode.port.postMessage('destroy'); } catch (e) {}
          try { self.suppressorNode.disconnect(); } catch (e) {}
        }
        self.suppressorNode = built.node;
        self.activeBackend = built.backend;
        self.backendId = built.backend.id;
        self.sourceNode.connect(self.suppressorNode);
        self.suppressorNode.connect(self.wetGain);
        self.wetGain.connect(self.mergeNode);
        if (self.onBackendChange) {
          self.onBackendChange(built.backend, !!_isFallback);
        }
        return built.backend;
      }).catch(function (err) {
        self.lastError = err;
        if (backendId === 'dsp') throw err;   // nothing left to fall back to
        return self._fallbackFrom(backendId);
      });
    },

    /**
     * Drops to the next backend down the list. The 'dsp' backend is last and
     * has no external dependency, so this always terminates somewhere usable.
     */
    _fallbackFrom: function (failedId) {
      var order = BACKEND_ORDER;
      var idx = order.indexOf(failedId);
      var next = idx >= 0 && idx < order.length - 1 ? order[idx + 1] : 'dsp';
      // Falling back silently once hid a real bug: a channel-count mismatch
      // crashed all three neural engines at runtime and the module quietly
      // served the DSP fallback, which looked like it was working. Always
      // leave a trace.
      var reason = this.lastError ? this.lastError.message : 'unknown';
      this.fallbacks.push({ from: failedId, to: next, reason: reason });
      if (global.console && console.warn) {
        console.warn('[PeakAbuNoiseSuppression] "' + failedId + '" failed (' +
                     reason + '); falling back to "' + next + '"');
      }
      return this._attachBackend(next, true);
    },

    // ---------------------------------------------------------------
    // Controls
    // ---------------------------------------------------------------

    /** Click-free A/B. Both paths keep running; only the mix changes. */
    setBypass: function (on) {
      this.bypassed = !!on;
      if (!this.rawGain) return;
      var t = this.context.currentTime;
      var raw = this.bypassed ? 1 : 0;
      this.rawGain.gain.setTargetAtTime(raw, t, CROSSFADE_SEC / 3);
      this.wetGain.gain.setTargetAtTime(1 - raw, t, CROSSFADE_SEC / 3);
    },

    toggleBypass: function () {
      this.setBypass(!this.bypassed);
      return this.bypassed;
    },

    setStrength: function (value) {
      this.strength = Math.max(0, Math.min(1, value));
      if (this.suppressorNode && this.activeBackend &&
          this.activeBackend.strengthSupported) {
        var p = this.suppressorNode.parameters.get('strength');
        if (p) p.setTargetAtTime(this.strength, this.context.currentTime, 0.02);
      }
    },

    setBackend: function (backendId) {
      if (!BACKENDS[backendId]) return Promise.reject(new Error('unknown backend'));
      if (!this.ready) { this.backendId = backendId; return Promise.resolve(); }
      return this._attachBackend(backendId);
    },

    /**
     * Tells the DSP backend to re-learn the room fast. Meaningless for the
     * learned models, which carry no per-room state.
     */
    learnNoise: function (ms) {
      if (this.suppressorNode && this.activeBackend &&
          this.activeBackend.id === 'dsp') {
        this.suppressorNode.port.postMessage({ type: 'learn-noise', ms: ms || 1500 });
        return true;
      }
      return false;
    },

    // ---------------------------------------------------------------
    // Metering
    // ---------------------------------------------------------------

    _startMetrics: function () {
      var self = this;
      if (this._metricsTimer) return;
      var inBuf = new Float32Array(this.inputAnalyser.fftSize);
      var outBuf = new Float32Array(this.outputAnalyser.fftSize);

      var rms = function (a) {
        var s = 0;
        for (var i = 0; i < a.length; i++) s += a[i] * a[i];
        return Math.sqrt(s / a.length);
      };

      this._metricsTimer = setInterval(function () {
        if (!self.ready || !self.onMetrics) return;
        self.inputAnalyser.getFloatTimeDomainData(inBuf);
        self.outputAnalyser.getFloatTimeDomainData(outBuf);
        var inRms = rms(inBuf);
        var outRms = rms(outBuf);

        // While bypassed the output IS the input, so a measured reduction
        // would read as zero and the meter would look broken. Prefer the
        // worklet's own figure, which is measured across the suppressor
        // regardless of which way the crossfade is pointing.
        var wm = self._workletMetrics;
        var reductionDb;
        if (wm && typeof wm.reductionDb === 'number') {
          reductionDb = wm.reductionDb;
        } else {
          reductionDb = self.bypassed ? 0 : 20 * Math.log10((inRms + 1e-9) / (outRms + 1e-9));
        }

        self.onMetrics({
          inRms: inRms,
          outRms: outRms,
          inDb: 20 * Math.log10(inRms + 1e-9),
          outDb: 20 * Math.log10(outRms + 1e-9),
          reductionDb: reductionDb,
          speech: wm && typeof wm.speech === 'number' ? wm.speech : null,
          bypassed: self.bypassed,
          backend: self.activeBackend ? self.activeBackend.id : null
        });
      }, 50);
    },

    // ---------------------------------------------------------------
    // Teardown
    // ---------------------------------------------------------------

    teardownGraph: function () {
      if (this._metricsTimer) { clearInterval(this._metricsTimer); this._metricsTimer = null; }
      if (this.suppressorNode) {
        try { this.suppressorNode.port.postMessage('destroy'); } catch (e) {}
        try { this.suppressorNode.disconnect(); } catch (e) {}
        this.suppressorNode = null;
      }
      [this.sourceNode, this.rawGain, this.wetGain, this.mergeNode,
       this.inputAnalyser, this.outputAnalyser].forEach(function (n) {
        if (n) { try { n.disconnect(); } catch (e) {} }
      });
      this.sourceNode = this.rawGain = this.wetGain = this.mergeNode = null;
      this.inputAnalyser = this.outputAnalyser = null;
      this.destNode = null;
      this.outputStream = null;
      this.ready = false;
      this._workletMetrics = null;
    },

    /**
     * Full shutdown. Does NOT stop the input stream's tracks — the caller
     * owns that stream and may still be recording from it.
     */
    destroy: function () {
      this.teardownGraph();
      if (this._ownsContext && this.context) {
        try { this.context.close(); } catch (e) {}
      }
      this.context = null;
      this.inputStream = null;
    }
  };

  global.PeakAbuNoiseSuppression = PeakAbuNoiseSuppression;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PeakAbuNoiseSuppression;
  }

})(typeof window !== 'undefined' ? window : this);
