/*
 * dsp-spectral.js — Peak-Abu's zero-dependency noise suppression backend.
 *
 * Why this exists: every other backend in this module needs a WASM blob on
 * disk. This one needs nothing, so the feature always has *something* to run
 * — on a fresh clone, on a stripped build, or if a .wasm fails to load. It is
 * also the honest baseline to A/B the learned models against.
 *
 * Method: STFT spectral gating with decision-directed a priori SNR
 * (Ephraim-Malah) and a Wiener gain. Per frequency bin we track where the
 * noise floor sits, ask "how far above that floor is this bin right now", and
 * attenuate the bins that are not clearly above it.
 *
 * Honest limits: this class of algorithm is very good at *stationary* noise —
 * fans, PC whine, air conditioning, mains hum, mic hiss. It is mediocre at
 * transients (keyboard clacks, mouse clicks) because a click looks like
 * signal to a noise-floor tracker. RNNoise and GTCRN beat it on those. This
 * is the fallback, not the default.
 */

const N = 512;            // FFT size — 10.7ms at 48kHz
const HOP = 128;          // == one render quantum, so exactly one FFT per process()
const HALF = N / 2 + 1;   // usable bins for a real input signal

// Minimum-statistics window, in frames. At 48kHz/128 there are 375 frames per
// second, so 250 frames is ~0.67s per window and the rolling minimum covers
// 0.67-1.33s — comfortably longer than a syllable, shorter than a sentence.
const MIN_WIN = 375;
// Minimum-tracking runs on a SMOOTHED periodogram, not the raw one. A raw
// per-bin power is exponentially distributed, so its minimum over N frames
// sits roughly a factor of N below the mean — clamping to that would drag the
// noise estimate ~20dB under the true floor and disable suppression entirely
// (measured: suppression fell from -10dB to -3.7dB). Smoothing first cuts the
// variance so the minimum is only mildly biased.
const MIN_SMOOTH = 0.92;   // ~25-frame effective average before minimum-tracking
// Bias compensation for that residual underestimate (Martin's B_min).
// Calibrated against ground truth: the rolling minimum ran ~2.7dB low, so 2x
// (+3dB) lands the estimate on the true noise floor. Aggressiveness beyond
// that is the `strength` knob's job via overSub, not this constant's.
const MIN_MARGIN = 2.0;
// Frames to keep the minimum tracker shut after speech stops (~120ms).
// This must stay SHORTER than a normal gap between words: at 0.5s the gate
// never reopened during natural pauses, the noise floor stopped updating
// entirely, and speech damage went from 1.3dB to 9.1dB. The broadband level
// is already smoothed over ~32ms, so intra-syllable dips need no extra help.
const VAD_HANGOVER = 45;
const WARMUP_FRAMES = 40;  // ~107ms of minimum-seeking before tracking starts

// ---- Precomputed tables (module scope: built once, shared by all instances) ----

// sqrt-Hann, used for BOTH analysis and synthesis. Applying it twice yields a
// full Hann envelope, and periodic Hann at 75% overlap sums to a constant 2.0
// — so overlap-add reconstructs unit gain after dividing by that.
const WINDOW = new Float32Array(N);
for (let i = 0; i < N; i++) {
  WINDOW[i] = Math.sqrt(0.5 * (1 - Math.cos((2 * Math.PI * i) / N)));
}
const COLA_NORM = 2.0;

// Bit-reversal permutation and twiddle factors for the radix-2 FFT.
const LOG_N = Math.log2(N);
const BITREV = new Uint16Array(N);
for (let i = 0; i < N; i++) {
  let r = 0;
  for (let b = 0; b < LOG_N; b++) r |= ((i >> b) & 1) << (LOG_N - 1 - b);
  BITREV[i] = r;
}
const COS_TAB = new Float32Array(N / 2);
const SIN_TAB = new Float32Array(N / 2);
for (let i = 0; i < N / 2; i++) {
  COS_TAB[i] = Math.cos((-2 * Math.PI * i) / N);
  SIN_TAB[i] = Math.sin((-2 * Math.PI * i) / N);
}

/**
 * In-place iterative radix-2 FFT. `inverse` conjugates the twiddles and
 * scales by 1/N, so fft(fft(x, false), true) === x.
 */
function fft(re, im, inverse) {
  for (let i = 0; i < N; i++) {
    const j = BITREV[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const half = len >> 1;
    const step = N / len;
    for (let i = 0; i < N; i += len) {
      for (let k = 0; k < half; k++) {
        const tw = k * step;
        const wr = COS_TAB[tw];
        const wi = inverse ? -SIN_TAB[tw] : SIN_TAB[tw];
        const a = i + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr;        im[a] += xi;
      }
    }
  }
  if (inverse) {
    const s = 1 / N;
    for (let i = 0; i < N; i++) { re[i] *= s; im[i] *= s; }
  }
}

/** One independent denoiser state machine. One per audio channel. */
class ChannelState {
  constructor() {
    this.inBuf = new Float32Array(N);       // sliding analysis window
    this.olaBuf = new Float32Array(N);      // overlap-add accumulator
    this.re = new Float32Array(N);
    this.im = new Float32Array(N);
    this.noisePow = new Float32Array(HALF); // running noise-floor estimate
    this.prevGain = new Float32Array(HALF).fill(1);
    this.prevGamma = new Float32Array(HALF).fill(1);
    this.gainBuf = new Float32Array(HALF);
    this.warmup = 0;                        // frames seen; seeds the noise floor
    this.speechProb = 0;

    // Minimum statistics (Martin 2001), the safeguard that stops the noise
    // estimate from ever latching onto speech. Two half-open windows give a
    // rolling minimum covering MIN_WIN..2*MIN_WIN frames of history.
    this.smoothPow = new Float32Array(HALF);
    this.curMin = new Float32Array(HALF).fill(Infinity);
    this.prevMin = new Float32Array(HALF).fill(Infinity);
    this.minAge = 0;
    this.speechHang = 0;
    // Broadband level history, used to gate the minimum tracker. Kept
    // separate from noisePow on purpose — see the note at `speechLike`.
    this.bbSmooth = 0;
    this.bbCurMin = Infinity;
    this.bbPrevMin = Infinity;
  }
}

class DspSpectralProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // 0 = gentle (-6dB floor, light gating), 1 = aggressive (-30dB floor).
      { name: 'strength', defaultValue: 0.65, minValue: 0, maxValue: 1, automationRate: 'k-rate' }
    ];
  }

  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.channels = [];
    this.maxChannels = opts.maxChannels || 2;
    this.destroyed = false;
    this.learnFrames = 0;       // >0 = force-fast noise adaptation ("learn my room")
    this.frameCounter = 0;

    // Meter accumulators, flushed to the main thread ~20x/sec.
    this.meterIn = 0;
    this.meterOut = 0;
    this.meterFrames = 0;

    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg === 'destroy') { this.destroyed = true; return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'learn-noise') {
        this.learnFrames = Math.round(((msg.ms || 1500) / 1000) * (sampleRate / HOP));
      } else if (msg.type === 'reset') {
        this.channels = [];
      }
    };
  }

  channel(i) {
    if (!this.channels[i]) this.channels[i] = new ChannelState();
    return this.channels[i];
  }

  /** Process exactly one hop of samples for one channel. */
  processFrame(st, input, output, strength) {
    // Slide the analysis window left by one hop and append the new samples.
    st.inBuf.copyWithin(0, HOP);
    st.inBuf.set(input, N - HOP);

    const re = st.re, im = st.im;
    for (let i = 0; i < N; i++) { re[i] = st.inBuf[i] * WINDOW[i]; im[i] = 0; }
    fft(re, im, false);

    // --- Gain computation, per bin ---
    // Over-subtraction and the attenuation floor are the two knobs "strength"
    // drives. Both are deliberately mild at 0 so the gentle setting is usable
    // on a good mic rather than being a no-op.
    const overSub = 1 + 3 * strength;
    const maxAttenDb = 6 + 24 * strength;
    const gainFloor = Math.pow(10, -maxAttenDb / 20);
    const learning = this.learnFrames > 0;

    // --- Noise-floor estimation: minimum statistics (Martin 2001) ---
    //
    // The obvious approach — track the periodogram with a fast fall and a
    // slow rise — does NOT work here, and it fails silently. A per-bin power
    // is exponentially distributed, so it dips deeply and constantly; a
    // tracker that jumps 40% down on every dip and crawls 0.25% back up
    // converges to a low percentile of the distribution rather than its mean.
    // Measured against ground truth, that estimator sat 26-56dB BELOW the
    // true noise floor, which makes every bin look like high SNR and reduces
    // suppression to ~3dB.
    //
    // What actually works is to smooth the periodogram first, take a rolling
    // minimum of the smoothed value, and correct the known low bias of that
    // minimum. The same diagnostic put this within ~3dB of truth. It is also
    // inherently speech-safe: speech can only raise the estimate if it stays
    // continuously loud for longer than the whole minimum window.
    const adapt = learning ? 0.40 : 0.05;

    // Roll the minimum-statistics windows over.
    if (++st.minAge >= MIN_WIN) {
      st.minAge = 0;
      const swap = st.prevMin;
      st.prevMin = st.curMin;
      st.curMin = swap;
      st.curMin.fill(Infinity);
      st.bbPrevMin = st.bbCurMin;
      st.bbCurMin = Infinity;
    }

    // Speech-presence gate for the minimum tracker, from the previous frame's
    // VAD. During warmup we always update, because the VAD is not meaningful
    // until there is a noise estimate to compare against.
    // A bare threshold is too twitchy: speech dips below it between syllables
    // and inside voiced sounds, and those dips then get sampled as "silence"
    // (this alone still left -6.8dB of self-suppression). A hangover keeps the
    // gate shut for VAD_HANGOVER frames after the last speech-looking frame,
    // so an entire utterance is excluded rather than just its peaks.
    // The gate deliberately does NOT use st.speechProb. That VAD is derived
    // from gamma, which is derived from noisePow — the very thing being
    // protected — so using it here is circular: bootstrap noisePow low and
    // everything reads as speech (the tracker never learns); bootstrap it
    // high and speech reads as silence (the tracker learns the user's voice).
    // Broadband level relative to its own rolling minimum has no such
    // dependency, and it is exactly the speech-vs-stationary-noise cue that
    // minimum statistics already relies on.
    let bb = 0;
    for (let i = 0; i < HOP; i++) bb += input[i] * input[i];
    bb = bb / HOP + 1e-12;
    st.bbSmooth = st.bbSmooth === 0 ? bb : st.bbSmooth * MIN_SMOOTH + bb * (1 - MIN_SMOOTH);
    if (st.bbSmooth < st.bbCurMin) st.bbCurMin = st.bbSmooth;
    const bbMin = st.bbCurMin < st.bbPrevMin ? st.bbCurMin : st.bbPrevMin;

    // >8dB above the quietest recent moment means something is happening that
    // is not the room tone.
    const speechLike = st.bbSmooth > bbMin * 6.3;
    if (speechLike) st.speechHang = VAD_HANGOVER;
    else if (st.speechHang > 0) st.speechHang--;
    const updateMin = st.speechHang === 0;

    let speechAccum = 0, speechBins = 0;
    const binHz = sampleRate / N;
    const voiceLo = Math.max(1, Math.floor(300 / binHz));
    const voiceHi = Math.min(HALF - 1, Math.ceil(3400 / binHz));

    for (let k = 0; k < HALF; k++) {
      const pow = re[k] * re[k] + im[k] * im[k] + 1e-12;

      st.smoothPow[k] = st.smoothPow[k] === 0
        ? pow
        : st.smoothPow[k] * MIN_SMOOTH + pow * (1 - MIN_SMOOTH);

      // Only frames that do NOT look like speech are allowed into the minimum
      // tracker (this is MCRA-II). Plain minimum statistics assumes every
      // window contains a genuine pause; someone talking continuously breaks
      // that assumption, and the minimum creeps up to the quietest part of
      // their own voice — measured at -8.5dB of self-suppression after six
      // seconds of unbroken speech. Excluding speech frames means that during
      // a long monologue BOTH windows stay empty and the estimate simply
      // freezes at the last value learned from real silence, which is the
      // correct behaviour.
      if (updateMin && st.smoothPow[k] < st.curMin[k]) st.curMin[k] = st.smoothPow[k];

      const mn = st.curMin[k] < st.prevMin[k] ? st.curMin[k] : st.prevMin[k];

      if (mn !== Infinity) {
        const target = mn * MIN_MARGIN;
        if (st.warmup < WARMUP_FRAMES) {
          // Before a full window exists, converge straight onto the target so
          // suppression engages within ~100ms instead of ramping for a second.
          st.noisePow[k] = st.noisePow[k] === 0 ? target : (st.noisePow[k] * 0.7 + target * 0.3);
        } else {
          st.noisePow[k] += (target - st.noisePow[k]) * adapt;
        }
      }
      // If no quiet moment has ever been observed, noisePow stays at its
      // initial ~0 and every bin reads as high SNR — i.e. clean passthrough.
      // That is the correct failure mode: suppression that has not yet
      // learned the room should do nothing, not guess.

      const noise = st.noisePow[k] * overSub + 1e-12;
      const gamma = pow / noise;                        // a posteriori SNR

      // Decision-directed a priori SNR (Ephraim & Malah 1984). Blending the
      // previous frame's estimate in is what suppresses "musical noise" —
      // isolated bins flickering above threshold and warbling.
      let xi = 0.98 * (st.prevGain[k] * st.prevGain[k] * st.prevGamma[k])
             + 0.02 * Math.max(gamma - 1, 0);
      if (xi < 1e-6) xi = 1e-6;

      let g = xi / (xi + 1);                            // Wiener gain
      if (g < gainFloor) g = gainFloor;
      if (g > 1) g = 1;

      st.gainBuf[k] = g;
      st.prevGamma[k] = gamma;

      if (k >= voiceLo && k <= voiceHi) { speechAccum += gamma; speechBins++; }
    }
    if (st.warmup < 12) st.warmup++;

    // Smooth the gain curve across frequency (3-tap). Sharp bin-to-bin gain
    // jumps are audible as ringing; this costs a little suppression depth and
    // buys a much cleaner result.
    for (let k = 0; k < HALF; k++) {
      const a = st.gainBuf[k === 0 ? 0 : k - 1];
      const b = st.gainBuf[k];
      const c = st.gainBuf[k === HALF - 1 ? HALF - 1 : k + 1];
      const g = 0.25 * a + 0.5 * b + 0.25 * c;
      st.prevGain[k] = g;
      re[k] *= g; im[k] *= g;
      // Mirror onto the negative-frequency half to keep the spectrum
      // conjugate-symmetric, so the inverse transform stays real.
      if (k > 0 && k < N / 2) {
        re[N - k] = re[k]; im[N - k] = -im[k];
      }
    }

    // Voice activity, used only for the UI meter — never for gating.
    const meanGamma = speechBins ? speechAccum / speechBins : 0;
    const inst = Math.max(0, Math.min(1, (Math.log10(meanGamma + 1e-9) + 0.3) / 1.2));
    st.speechProb += (inst - st.speechProb) * 0.15;

    fft(re, im, true);

    // Overlap-add with synthesis windowing.
    st.olaBuf.copyWithin(0, HOP);
    st.olaBuf.fill(0, N - HOP);
    for (let i = 0; i < N; i++) st.olaBuf[i] += re[i] * WINDOW[i];

    for (let i = 0; i < HOP; i++) output[i] = st.olaBuf[i] / COLA_NORM;
  }

  process(inputs, outputs, parameters) {
    if (this.destroyed) return false;
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;

    const sp = parameters && parameters.strength;
    const s = sp && sp.length ? sp[0] : 0.65;

    const chCount = Math.min(input.length, output.length, this.maxChannels);
    let inSum = 0, outSum = 0, n = 0;

    for (let c = 0; c < chCount; c++) {
      const ic = input[c], oc = output[c];
      if (!ic || !oc) continue;
      this.processFrame(this.channel(c), ic, oc, s);
      for (let i = 0; i < ic.length; i++) { inSum += ic[i] * ic[i]; outSum += oc[i] * oc[i]; }
      n += ic.length;
    }
    // Any channels beyond maxChannels pass through untouched rather than
    // going silent.
    for (let c = chCount; c < output.length; c++) {
      if (output[c] && input[c]) output[c].set(input[c]);
    }

    if (this.learnFrames > 0) this.learnFrames--;

    if (n > 0) { this.meterIn += inSum / n; this.meterOut += outSum / n; this.meterFrames++; }
    if (++this.frameCounter % 18 === 0 && this.meterFrames > 0) {
      const inRms = Math.sqrt(this.meterIn / this.meterFrames);
      const outRms = Math.sqrt(this.meterOut / this.meterFrames);
      this.port.postMessage({
        type: 'metrics',
        inRms: inRms,
        outRms: outRms,
        reductionDb: 20 * Math.log10((inRms + 1e-9) / (outRms + 1e-9)),
        speech: this.channels[0] ? this.channels[0].speechProb : 0,
        learning: this.learnFrames > 0
      });
      this.meterIn = 0; this.meterOut = 0; this.meterFrames = 0;
    }
    return true;
  }
}

registerProcessor('peakabu/dsp-spectral', DspSpectralProcessor);
