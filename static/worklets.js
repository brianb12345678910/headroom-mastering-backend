// AudioWorklet processors for the Headroom console.
// Loaded into both the live AudioContext and the OfflineAudioContext used for bouncing,
// so the limiter sounds identical in playback and in the exported file.

const dbToGain = (db) => Math.pow(10, db / 20);

// Lookahead brickwall limiter.
// Gain computer: per-sample required gain -> running minimum over the lookahead window
// -> exponential release -> moving average over the same window. Because the averaged
// envelope has been at or below the required gain for the whole window before a peak
// leaves the delay line, the output never exceeds the ceiling (a final clamp catches
// floating-point stragglers).
class LimiterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "inputGain", defaultValue: 0, minValue: -24, maxValue: 24, automationRate: "k-rate" },
      { name: "ceiling", defaultValue: -1, minValue: -24, maxValue: 0, automationRate: "k-rate" },
      { name: "release", defaultValue: 120, minValue: 1, maxValue: 2000, automationRate: "k-rate" },
      { name: "bypass", defaultValue: 0, minValue: 0, maxValue: 1, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.window = Math.max(2, Math.round(sampleRate * 0.005)); // 5 ms lookahead
    const w = this.window;
    // Audio is delayed by window - 1 samples so each output sample's required gain
    // has been inside the min-hold window for every sample of the moving average.
    this.delayL = new Float32Array(w - 1);
    this.delayR = new Float32Array(w - 1);
    this.dpos = 0;
    this.reqRing = new Float32Array(w).fill(1);
    this.avgRing = new Float32Array(w).fill(1);
    this.avgSum = w;
    this.pos = 0;
    this.release = 1;
    this.minGainSinceReport = 1;
    this.blocks = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    const outL = output[0];
    const outR = output[1] || output[0];
    const inL = input[0] || null;
    const inR = input[1] || inL;
    const n = outL.length;

    const inGain = dbToGain(parameters.inputGain[0]);
    const ceiling = dbToGain(parameters.ceiling[0]);
    const relCoef = 1 - Math.exp(-1 / (sampleRate * parameters.release[0] / 1000));
    const bypass = parameters.bypass[0] >= 0.5;
    const w = this.window;

    for (let i = 0; i < n; i++) {
      const l = inL ? inL[i] * inGain : 0;
      const r = inR ? inR[i] * inGain : 0;
      const peak = Math.max(Math.abs(l), Math.abs(r));
      const req = peak > ceiling ? ceiling / peak : 1;

      const p = this.pos;
      this.reqRing[p] = req;
      let held = 1;
      const ring = this.reqRing;
      for (let k = 0; k < w; k++) if (ring[k] < held) held = ring[k];

      this.release = held < this.release ? held : this.release + (held - this.release) * relCoef;

      this.avgSum += this.release - this.avgRing[p];
      this.avgRing[p] = this.release;
      const gain = Math.min(1, this.avgSum / w);

      // The oldest sample in the delay line is the one this envelope was built for.
      const d = this.dpos;
      const dl = this.delayL[d];
      const dr = this.delayR[d];
      this.delayL[d] = l;
      this.delayR[d] = r;
      this.dpos = d + 1 === w - 1 ? 0 : d + 1;
      this.pos = p + 1 === w ? 0 : p + 1;

      if (bypass) {
        outL[i] = dl;
        if (outR !== outL) outR[i] = dr;
        continue;
      }
      let yl = dl * gain;
      let yr = dr * gain;
      if (yl > ceiling) yl = ceiling; else if (yl < -ceiling) yl = -ceiling;
      if (yr > ceiling) yr = ceiling; else if (yr < -ceiling) yr = -ceiling;
      outL[i] = yl;
      if (outR !== outL) outR[i] = yr;
      if (gain < this.minGainSinceReport) this.minGainSinceReport = gain;
    }

    if (++this.blocks >= 8) {
      this.port.postMessage({ reduction: bypass ? 0 : -20 * Math.log10(this.minGainSinceReport) });
      this.minGainSinceReport = 1;
      this.blocks = 0;
    }
    return true;
  }
}

// BS.1770 K-weighting (pre-filter shelf + RLB high-pass), designed for the running sample rate.
function kWeightingCoefficients(fs) {
  const shelf = (() => {
    const G = 3.999843853973347, Q = 0.7071752369554196, fc = 1681.974450955533;
    const A = Math.pow(10, G / 40), w0 = 2 * Math.PI * fc / fs, cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Q), sa = 2 * Math.sqrt(A) * alpha;
    const a0 = (A + 1) - (A - 1) * cos + sa;
    return {
      b0: A * ((A + 1) + (A - 1) * cos + sa) / a0,
      b1: -2 * A * ((A - 1) + (A + 1) * cos) / a0,
      b2: A * ((A + 1) + (A - 1) * cos - sa) / a0,
      a1: 2 * ((A - 1) - (A + 1) * cos) / a0,
      a2: ((A + 1) - (A - 1) * cos - sa) / a0,
    };
  })();
  const hp = (() => {
    const Q = 0.5003270373238773, fc = 38.13547087602444;
    const w0 = 2 * Math.PI * fc / fs, cos = Math.cos(w0), alpha = Math.sin(w0) / (2 * Q);
    const a0 = 1 + alpha;
    return {
      b0: (1 + cos) / 2 / a0, b1: -(1 + cos) / a0, b2: (1 + cos) / 2 / a0,
      a1: -2 * cos / a0, a2: (1 - alpha) / a0,
    };
  })();
  return [shelf, hp];
}

class Biquad {
  constructor(c) { this.c = c; this.x1 = this.x2 = this.y1 = this.y2 = 0; }
  step(x) {
    const c = this.c;
    const y = c.b0 * x + c.b1 * this.x1 + c.b2 * this.x2 - c.a1 * this.y1 - c.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

// Posts K-weighted mean square and sample peak per channel every 100 ms.
// The main thread turns these into momentary / short-term / integrated LUFS.
class LoudnessMeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const [shelf, hp] = kWeightingCoefficients(sampleRate);
    this.filters = [0, 1].map(() => [new Biquad(shelf), new Biquad(hp)]);
    this.blockSize = Math.round(sampleRate * 0.1);
    this.reset();
    this.port.onmessage = (e) => { if (e.data === "reset") this.reset(); };
  }

  reset() {
    this.count = 0;
    this.sum = [0, 0];
    this.peak = [0, 0];
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const out = outputs[0];
    if (!input.length) return true;
    const chans = [input[0], input[1] || input[0]];
    const n = chans[0].length;
    for (let c = 0; c < 2; c++) {
      const data = chans[c];
      const [f1, f2] = this.filters[c];
      let s = 0, pk = this.peak[c];
      for (let i = 0; i < n; i++) {
        const x = data[i];
        const a = x < 0 ? -x : x;
        if (a > pk) pk = a;
        const y = f2.step(f1.step(x));
        s += y * y;
      }
      this.sum[c] += s;
      this.peak[c] = pk;
      if (out[c]) out[c].set(data);
    }
    this.count += n;
    if (this.count >= this.blockSize) {
      this.port.postMessage({
        ms: [this.sum[0] / this.count, this.sum[1] / this.count],
        peak: this.peak.slice(),
      });
      this.reset();
    }
    return true;
  }
}

registerProcessor("headroom-limiter", LimiterProcessor);
registerProcessor("headroom-loudness", LoudnessMeterProcessor);
