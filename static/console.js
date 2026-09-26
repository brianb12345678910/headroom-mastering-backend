// Headroom Console: multitrack mixer + mastering chain built on the Web Audio API.
// The same graph builders drive live playback and the offline bounce, so what you
// hear is what gets exported.

const WORKLET_URL = new URL("./worklets.js", import.meta.url).href;
const METER_FLOOR = -60;
const METER_TOP = 6;
const FADER_MIN = -60;

const dbToGain = (db) => (db <= FADER_MIN ? 0 : Math.pow(10, db / 20));
const gainToDb = (g) => (g > 0 ? 20 * Math.log10(g) : -Infinity);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const $ = (sel, root = document) => root.querySelector(sel);

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

const EQ_SPECS = {
  "eq.high.gain": { label: "Hi", min: -15, max: 15, def: 0, fmt: "db", bipolar: true },
  "eq.high.freq": { label: "Hi f", min: 1500, max: 16000, def: 8000, log: true, fmt: "hz" },
  "eq.mid.gain": { label: "Mid", min: -15, max: 15, def: 0, fmt: "db", bipolar: true },
  "eq.mid.freq": { label: "Mid f", min: 150, max: 8000, def: 1000, log: true, fmt: "hz" },
  "eq.mid.q": { label: "Q", min: 0.3, max: 8, def: 1, log: true, fmt: "q" },
  "eq.low.gain": { label: "Lo", min: -15, max: 15, def: 0, fmt: "db", bipolar: true },
  "eq.low.freq": { label: "Lo f", min: 30, max: 500, def: 100, log: true, fmt: "hz" },
};

const COMP_SPECS = {
  "comp.threshold": { label: "Thresh", min: -60, max: 0, def: -18, fmt: "db" },
  "comp.ratio": { label: "Ratio", min: 1, max: 20, def: 3, log: true, fmt: "ratio" },
  "comp.attack": { label: "Attack", min: 0.5, max: 200, def: 10, log: true, fmt: "ms" },
  "comp.release": { label: "Release", min: 20, max: 1000, def: 150, log: true, fmt: "ms" },
  "comp.makeup": { label: "Makeup", min: 0, max: 24, def: 0, fmt: "db" },
};

const CHANNEL_SPECS = {
  trim: { label: "Trim", min: -24, max: 24, def: 0, fmt: "db", bipolar: true },
  hpf: { label: "Lo cut", min: 20, max: 600, def: 20, log: true, fmt: "hzoff" },
  ...EQ_SPECS,
  ...COMP_SPECS,
  "send.reverb": { label: "Reverb", min: -60, max: 6, def: -60, fmt: "dboff" },
  pan: { label: "Pan", min: -1, max: 1, def: 0, fmt: "pan", bipolar: true },
};

const MASTER_SPECS = {
  "eq.low.gain": { ...EQ_SPECS["eq.low.gain"], min: -6, max: 6 },
  "eq.low.freq": { ...EQ_SPECS["eq.low.freq"], def: 80 },
  "eq.mid.gain": { ...EQ_SPECS["eq.mid.gain"], min: -6, max: 6 },
  "eq.mid.freq": EQ_SPECS["eq.mid.freq"],
  "eq.mid.q": { ...EQ_SPECS["eq.mid.q"], def: 0.7 },
  "eq.high.gain": { ...EQ_SPECS["eq.high.gain"], min: -6, max: 6 },
  "eq.high.freq": { ...EQ_SPECS["eq.high.freq"], def: 10000 },
  "comp.threshold": { ...COMP_SPECS["comp.threshold"], def: -12 },
  "comp.ratio": { ...COMP_SPECS["comp.ratio"], max: 10, def: 2 },
  "comp.attack": { ...COMP_SPECS["comp.attack"], def: 30 },
  "comp.release": { ...COMP_SPECS["comp.release"], def: 200 },
  "comp.makeup": { ...COMP_SPECS["comp.makeup"], max: 12 },
  width: { label: "Width", min: 0, max: 2, def: 1, fmt: "pct", bipolar: true },
  "lim.gain": { label: "Drive", min: -12, max: 24, def: 0, fmt: "db", bipolar: true },
  "lim.ceiling": { label: "Ceiling", min: -6, max: 0, def: -1, fmt: "db" },
  "lim.release": { label: "Release", min: 10, max: 1000, def: 120, log: true, fmt: "ms" },
};

const REVERB_SPECS = {
  "rev.decay": { label: "Decay", min: 0.3, max: 8, def: 2.2, log: true, fmt: "s" },
  "rev.predelay": { label: "Pre-dly", min: 0, max: 120, def: 20, fmt: "ms" },
  "rev.tone": { label: "Tone", min: 1500, max: 16000, def: 7000, log: true, fmt: "hz" },
  "rev.lowcut": { label: "Lo cut", min: 20, max: 1000, def: 200, log: true, fmt: "hz" },
};

const defaultsFrom = (specs) => Object.fromEntries(Object.entries(specs).map(([k, s]) => [k, s.def]));

const channelDefaults = () => ({
  ...defaultsFrom(CHANNEL_SPECS),
  "eq.on": true, "comp.on": false, mute: false, solo: false, fader: 0,
});
const masterDefaults = () => ({
  ...defaultsFrom(MASTER_SPECS), "eq.on": true, "comp.on": false, "lim.on": true, fader: 0,
});
const reverbDefaults = () => ({ ...defaultsFrom(REVERB_SPECS), mute: false, fader: -4 });

const CHANNEL_PRESETS = {
  Flat: {},
  Vocal: {
    hpf: 100, "eq.low.gain": -1.5, "eq.low.freq": 200, "eq.mid.gain": 2, "eq.mid.freq": 3000,
    "eq.high.gain": 3, "eq.high.freq": 10000, "comp.on": true, "comp.threshold": -22, "comp.ratio": 4,
    "comp.attack": 5, "comp.release": 120, "comp.makeup": 5, "send.reverb": -14,
  },
  Kick: {
    hpf: 30, "eq.low.gain": 3, "eq.low.freq": 60, "eq.mid.gain": -4, "eq.mid.freq": 350, "eq.mid.q": 1.4,
    "eq.high.gain": 2, "eq.high.freq": 4000, "comp.on": true, "comp.threshold": -14, "comp.ratio": 4,
    "comp.attack": 20, "comp.release": 80, "comp.makeup": 2,
  },
  Snare: {
    hpf: 90, "eq.low.gain": 2, "eq.low.freq": 200, "eq.mid.gain": -2, "eq.mid.freq": 800,
    "eq.high.gain": 3, "eq.high.freq": 6000, "comp.on": true, "comp.threshold": -18, "comp.ratio": 4,
    "comp.attack": 8, "comp.release": 100, "comp.makeup": 3, "send.reverb": -12,
  },
  "Hi-hats": {
    hpf: 400, "eq.mid.gain": -2, "eq.mid.freq": 2500, "eq.high.gain": 2, "eq.high.freq": 10000,
    "send.reverb": -22, pan: 0.3,
  },
  Bass: {
    hpf: 35, "eq.low.gain": 2, "eq.low.freq": 80, "eq.mid.gain": -3, "eq.mid.freq": 250, "eq.mid.q": 1.2,
    "eq.high.gain": 1.5, "eq.high.freq": 2500, "comp.on": true, "comp.threshold": -20, "comp.ratio": 4,
    "comp.attack": 15, "comp.release": 150, "comp.makeup": 4,
  },
  Guitar: {
    hpf: 90, "eq.mid.gain": -2, "eq.mid.freq": 400, "eq.high.gain": 2, "eq.high.freq": 5000,
    "comp.on": true, "comp.threshold": -18, "comp.ratio": 3, "comp.attack": 15, "comp.makeup": 2,
    "send.reverb": -18,
  },
  "Keys / Pad": {
    hpf: 120, "eq.mid.gain": -2, "eq.mid.freq": 500, "eq.high.gain": 1.5, "send.reverb": -10,
  },
  "Lead synth": {
    hpf: 150, "eq.mid.gain": 2, "eq.mid.freq": 2000, "comp.on": true, "comp.threshold": -16,
    "comp.ratio": 3, "comp.makeup": 2, "send.reverb": -12,
  },
};

const PRESET_HINTS = [
  [/kick|bd\b|bassdrum/i, "Kick"],
  [/snare|sd\b|clap/i, "Snare"],
  [/hat|hh\b|cymbal|overhead|ride/i, "Hi-hats"],
  [/bass|808|sub/i, "Bass"],
  [/vox|vocal|voice|lead ?vox|singer/i, "Vocal"],
  [/guitar|gtr/i, "Guitar"],
  [/key|piano|pad|chord|organ|synth ?pad/i, "Keys / Pad"],
  [/lead|melody|synth/i, "Lead synth"],
];

const MASTER_PRESETS = {
  Transparent: {},
  "Glue + loud": {
    "comp.on": true, "comp.threshold": -14, "comp.ratio": 2, "comp.attack": 30, "comp.release": 150,
    "comp.makeup": 1, "lim.gain": 6, "eq.high.gain": 1, "eq.low.gain": 0.5,
  },
  Warm: {
    "eq.low.gain": 1.5, "eq.low.freq": 90, "eq.high.gain": -1, "eq.high.freq": 12000,
    "comp.on": true, "comp.threshold": -16, "comp.ratio": 1.8, "comp.attack": 50, "comp.release": 300,
    "lim.gain": 3,
  },
  Wide: { width: 1.3, "eq.high.gain": 1.5, "lim.gain": 3 },
};

const COLORS = ["#f0a53a", "#4fb3ff", "#3ddc84", "#ff6b9a", "#b58cff", "#ffd23f", "#48e0d0", "#ff8a4c"];

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

const state = {
  channels: [],
  master: masterDefaults(),
  reverb: reverbDefaults(),
  loop: false,
};
let nextChannelId = 1;

let ctx = null;
let live = null; // { master, reverb } node sets for the live context
let playing = false;
let startCtxTime = 0;
let startOffset = 0;
let sources = [];
let lastBounce = null; // { blob, buffer, stats }

const songDuration = () => state.channels.reduce((d, ch) => Math.max(d, ch.buffer.duration), 0);
const soloActive = () => state.channels.some((ch) => ch.params.solo);

// ---------------------------------------------------------------------------
// Audio graph builders (shared by live and offline rendering)
// ---------------------------------------------------------------------------

function setParam(param, value, context, smooth) {
  if (smooth && context.state === "running") {
    param.setTargetAtTime(value, context.currentTime, 0.012);
  } else {
    param.cancelScheduledValues(0);
    param.value = value;
  }
}

function stereoGain(context) {
  return new GainNode(context, { channelCount: 2, channelCountMode: "explicit", channelInterpretation: "speakers" });
}

function buildEq(context) {
  return {
    low: new BiquadFilterNode(context, { type: "lowshelf" }),
    mid: new BiquadFilterNode(context, { type: "peaking" }),
    high: new BiquadFilterNode(context, { type: "highshelf" }),
  };
}

function applyEq(eq, p, context, smooth) {
  const on = p["eq.on"];
  setParam(eq.low.frequency, p["eq.low.freq"], context, smooth);
  setParam(eq.low.gain, on ? p["eq.low.gain"] : 0, context, smooth);
  setParam(eq.mid.frequency, p["eq.mid.freq"], context, smooth);
  setParam(eq.mid.Q, p["eq.mid.q"], context, smooth);
  setParam(eq.mid.gain, on ? p["eq.mid.gain"] : 0, context, smooth);
  setParam(eq.high.frequency, p["eq.high.freq"], context, smooth);
  setParam(eq.high.gain, on ? p["eq.high.gain"] : 0, context, smooth);
}

function applyComp(comp, makeup, p, context, smooth) {
  const on = p["comp.on"];
  // ratio 1 with a 0 dB threshold is transparent but keeps latency identical when bypassed.
  setParam(comp.threshold, on ? p["comp.threshold"] : 0, context, smooth);
  setParam(comp.ratio, on ? p["comp.ratio"] : 1, context, smooth);
  setParam(comp.knee, 6, context, false);
  setParam(comp.attack, p["comp.attack"] / 1000, context, smooth);
  setParam(comp.release, p["comp.release"] / 1000, context, smooth);
  setParam(makeup.gain, on ? dbToGain(p["comp.makeup"]) : 1, context, smooth);
}

function buildChannelNodes(context, masterIn, reverbIn) {
  const n = {
    input: new GainNode(context),
    trim: new GainNode(context),
    hpf: new BiquadFilterNode(context, { type: "highpass", Q: Math.SQRT1_2 }),
    eq: buildEq(context),
    comp: new DynamicsCompressorNode(context),
    makeup: new GainNode(context),
    fader: new GainNode(context),
    pan: new StereoPannerNode(context),
    send: new GainNode(context, { gain: 0 }),
  };
  n.input.connect(n.trim).connect(n.hpf).connect(n.eq.low).connect(n.eq.mid).connect(n.eq.high)
    .connect(n.comp).connect(n.makeup).connect(n.fader).connect(n.pan).connect(masterIn);
  n.pan.connect(n.send).connect(reverbIn);
  return n;
}

function applyChannel(n, p, context, smooth, anySolo) {
  setParam(n.trim.gain, dbToGain(p.trim), context, smooth);
  setParam(n.hpf.frequency, p.hpf <= 20 ? 5 : p.hpf, context, smooth);
  applyEq(n.eq, p, context, smooth);
  applyComp(n.comp, n.makeup, p, context, smooth);
  const silenced = p.mute || (anySolo && !p.solo);
  setParam(n.fader.gain, silenced ? 0 : dbToGain(p.fader), context, smooth);
  setParam(n.pan.pan, p.pan, context, smooth);
  setParam(n.send.gain, p["send.reverb"] <= -60 ? 0 : dbToGain(p["send.reverb"]), context, smooth);
}

function buildWidth(context) {
  const split = new ChannelSplitterNode(context, { numberOfOutputs: 2 });
  const merge = new ChannelMergerNode(context, { numberOfInputs: 2 });
  const g = () => new GainNode(context);
  const ll = g(), rl = g(), lr = g(), rr = g();
  split.connect(ll, 0); split.connect(lr, 0);
  split.connect(rl, 1); split.connect(rr, 1);
  ll.connect(merge, 0, 0); rl.connect(merge, 0, 0);
  lr.connect(merge, 0, 1); rr.connect(merge, 0, 1);
  return {
    input: split,
    output: merge,
    set(width, smooth) {
      // Mid/side matrix: L' = M + wS, R' = M - wS.
      const same = (1 + width) / 2, cross = (1 - width) / 2;
      setParam(ll.gain, same, context, smooth); setParam(rr.gain, same, context, smooth);
      setParam(rl.gain, cross, context, smooth); setParam(lr.gain, cross, context, smooth);
    },
  };
}

function buildMasterNodes(context) {
  const n = {
    input: stereoGain(context),
    eq: buildEq(context),
    comp: new DynamicsCompressorNode(context),
    makeup: stereoGain(context),
    width: buildWidth(context),
    fader: stereoGain(context),
    limiter: new AudioWorkletNode(context, "headroom-limiter", {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      channelCount: 2, channelCountMode: "explicit",
    }),
  };
  n.input.connect(n.eq.low).connect(n.eq.mid).connect(n.eq.high).connect(n.comp).connect(n.makeup)
    .connect(n.width.input);
  n.width.output.connect(n.fader).connect(n.limiter);
  n.output = n.limiter;
  return n;
}

function applyMaster(n, p, context, smooth) {
  applyEq(n.eq, p, context, smooth);
  applyComp(n.comp, n.makeup, p, context, smooth);
  n.width.set(p.width, smooth);
  setParam(n.fader.gain, dbToGain(p.fader), context, smooth);
  const lp = n.limiter.parameters;
  setParam(lp.get("inputGain"), p["lim.gain"], context, false);
  setParam(lp.get("ceiling"), p["lim.ceiling"], context, false);
  setParam(lp.get("release"), p["lim.release"], context, false);
  setParam(lp.get("bypass"), p["lim.on"] ? 0 : 1, context, false);
}

// Deterministic impulse response so live playback and bounce use the same reverb.
const irCache = new Map();
function impulseResponse(sampleRate, decay) {
  const key = `${sampleRate}:${decay.toFixed(2)}`;
  if (irCache.has(key)) return irCache.get(key);
  const len = Math.max(1, Math.round(sampleRate * decay));
  const data = [new Float32Array(len), new Float32Array(len)];
  let seed = 1234567;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296 * 2 - 1;
  };
  const fadeIn = Math.round(sampleRate * 0.004);
  for (let i = 0; i < len; i++) {
    const t = i / sampleRate;
    const env = Math.exp(-6.9 * t / decay) * Math.min(1, i / fadeIn);
    data[0][i] = rand() * env;
    data[1][i] = rand() * env;
  }
  irCache.set(key, data);
  if (irCache.size > 8) irCache.delete(irCache.keys().next().value);
  return data;
}

function buildReverbNodes(context, masterIn) {
  const n = {
    input: new GainNode(context),
    predelay: new DelayNode(context, { maxDelayTime: 0.2 }),
    lowcut: new BiquadFilterNode(context, { type: "highpass", Q: Math.SQRT1_2 }),
    convolver: new ConvolverNode(context),
    tone: new BiquadFilterNode(context, { type: "lowpass", Q: Math.SQRT1_2 }),
    fader: stereoGain(context),
    decay: null,
  };
  n.input.connect(n.predelay).connect(n.lowcut).connect(n.convolver).connect(n.tone).connect(n.fader).connect(masterIn);
  return n;
}

function applyReverb(n, p, context, smooth) {
  const decay = Math.round(p["rev.decay"] * 20) / 20;
  if (n.decay !== decay) {
    const [l, r] = impulseResponse(context.sampleRate, decay);
    const buf = new AudioBuffer({ numberOfChannels: 2, length: l.length, sampleRate: context.sampleRate });
    buf.copyToChannel(l, 0);
    buf.copyToChannel(r, 1);
    n.convolver.buffer = buf;
    n.decay = decay;
  }
  setParam(n.predelay.delayTime, p["rev.predelay"] / 1000, context, smooth);
  setParam(n.lowcut.frequency, p["rev.lowcut"], context, smooth);
  setParam(n.tone.frequency, p["rev.tone"], context, smooth);
  setParam(n.fader.gain, p.mute ? 0 : dbToGain(p.fader), context, smooth);
}

function reverbInUse() {
  return !state.reverb.mute && state.reverb.fader > FADER_MIN &&
    state.channels.some((ch) => ch.params["send.reverb"] > -60);
}

// ---------------------------------------------------------------------------
// Live context
// ---------------------------------------------------------------------------

async function ensureAudio() {
  if (ctx) return ctx;
  ctx = new AudioContext({ latencyHint: "playback" });
  await ctx.audioWorklet.addModule(WORKLET_URL);

  const master = buildMasterNodes(ctx);
  const reverb = buildReverbNodes(ctx, master.input);
  const meter = new AudioWorkletNode(ctx, "headroom-loudness", {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: "explicit",
  });
  master.output.connect(meter).connect(ctx.destination);
  meter.port.onmessage = (e) => loudness.push(e.data);
  master.limiter.port.onmessage = (e) => { limiterReduction = e.data.reduction; };

  live = { master, reverb, meter, masterMeter: createPeakMeter(ctx, master.output), reverbMeter: createPeakMeter(ctx, reverb.fader) };
  applyMaster(master, state.master, ctx, false);
  applyReverb(reverb, state.reverb, ctx, false);
  for (const ch of state.channels) attachLiveChannel(ch);
  return ctx;
}

function attachLiveChannel(ch) {
  ch.nodes = buildChannelNodes(ctx, live.master.input, live.reverb.input);
  ch.meter = createPeakMeter(ctx, ch.nodes.pan);
  applyChannel(ch.nodes, ch.params, ctx, false, soloActive());
}

function createPeakMeter(context, node) {
  const split = new ChannelSplitterNode(context, { numberOfOutputs: 2 });
  const analysers = [0, 1].map(() => new AnalyserNode(context, { fftSize: 2048 }));
  node.connect(split);
  split.connect(analysers[0], 0);
  split.connect(analysers[1], 1);
  const buf = new Float32Array(2048);
  return {
    read() {
      return analysers.map((a) => {
        a.getFloatTimeDomainData(buf);
        let pk = 0;
        for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > pk) pk = v; }
        return pk;
      });
    },
    disconnect() { node.disconnect(split); },
  };
}

function refreshChannels() {
  if (!ctx) return;
  const anySolo = soloActive();
  for (const ch of state.channels) if (ch.nodes) applyChannel(ch.nodes, ch.params, ctx, true, anySolo);
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const position = () => (playing ? startOffset + (ctx.currentTime - startCtxTime) : startOffset);

function startSource(ch, offset, when) {
  if (offset >= ch.buffer.duration) return;
  const src = new AudioBufferSourceNode(ctx, { buffer: ch.buffer });
  src.connect(ch.nodes.input);
  src.start(when, offset);
  sources.push({ src, ch });
}

async function play() {
  if (!state.channels.length) return;
  await ensureAudio();
  await ctx.resume();
  if (playing) return;
  if (startOffset >= songDuration()) startOffset = 0;
  if (startOffset === 0) resetLoudness();
  const when = ctx.currentTime + 0.05;
  for (const ch of state.channels) startSource(ch, startOffset, when);
  startCtxTime = when;
  playing = true;
  updateTransportUi();
}

function stopSources() {
  for (const { src } of sources) {
    try { src.stop(); } catch { /* already stopped */ }
    src.disconnect();
  }
  sources = [];
}

function pause() {
  if (!playing) return;
  startOffset = Math.min(position(), songDuration());
  stopSources();
  playing = false;
  updateTransportUi();
}

function stop() {
  if (playing) pause();
  startOffset = 0;
  resetLoudness();
  updateTransportUi();
}

async function seek(t) {
  const wasPlaying = playing;
  if (playing) pause();
  startOffset = clamp(t, 0, songDuration());
  if (wasPlaying) await play();
  updateTransportUi();
}

function updateTransportUi() {
  const btn = $("#btn-play");
  btn.classList.toggle("playing", playing);
  btn.innerHTML = playing ? "&#10074;&#10074;" : "&#9654;";
  btn.setAttribute("aria-label", playing ? "Pause" : "Play");
}

const fmtTime = (t) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
};

// ---------------------------------------------------------------------------
// Loudness metering (BS.1770 / EBU R128)
// ---------------------------------------------------------------------------

let limiterReduction = 0;
const loudness = {
  blocks: [],      // 100 ms mean squares (L + R)
  gating: [],      // 400 ms block powers for integrated loudness
  maxPeak: 0,
  push({ ms, peak }) {
    if (!playing) return;
    this.blocks.push(ms[0] + ms[1]);
    if (this.blocks.length > 30) this.blocks.shift();
    if (this.blocks.length >= 4) this.gating.push(mean(this.blocks.slice(-4)));
    this.maxPeak = Math.max(this.maxPeak, peak[0], peak[1]);
  },
};

const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
const powerToLufs = (p) => (p > 0 ? -0.691 + 10 * Math.log10(p) : -Infinity);

function integratedLufs(blockPowers) {
  const abs = blockPowers.filter((p) => powerToLufs(p) > -70);
  if (!abs.length) return -Infinity;
  const relGate = powerToLufs(mean(abs)) - 10;
  const rel = abs.filter((p) => powerToLufs(p) > relGate);
  return rel.length ? powerToLufs(mean(rel)) : -Infinity;
}

function resetLoudness() {
  loudness.blocks = [];
  loudness.gating = [];
  loudness.maxPeak = 0;
  if (live) live.meter.port.postMessage("reset");
}

// Offline analysis of a rendered buffer (same K-weighting as the meter worklet).
function analyzeBuffer(buffer) {
  const fs = buffer.sampleRate;
  const coeffs = kWeighting(fs);
  const chans = [buffer.getChannelData(0), buffer.getChannelData(buffer.numberOfChannels > 1 ? 1 : 0)];
  const block = Math.round(fs * 0.1);
  const nBlocks = Math.floor(buffer.length / block);
  const sums = new Float64Array(nBlocks);
  let peak = 0;
  for (const data of chans) {
    const f = coeffs.map((c) => ({ c, x1: 0, x2: 0, y1: 0, y2: 0 }));
    for (let i = 0; i < nBlocks * block; i++) {
      let x = data[i];
      const a = Math.abs(x);
      if (a > peak) peak = a;
      for (const s of f) {
        const y = s.c.b0 * x + s.c.b1 * s.x1 + s.c.b2 * s.x2 - s.c.a1 * s.y1 - s.c.a2 * s.y2;
        s.x2 = s.x1; s.x1 = x; s.y2 = s.y1; s.y1 = y; x = y;
      }
      sums[Math.floor(i / block)] += x * x;
    }
  }
  const ms = Array.from(sums, (s) => s / block);
  const gating = [];
  for (let i = 3; i < ms.length; i++) gating.push((ms[i] + ms[i - 1] + ms[i - 2] + ms[i - 3]) / 4);
  return { lufs: integratedLufs(gating), peakDb: gainToDb(peak) };
}

function kWeighting(fs) {
  const G = 3.999843853973347, Qs = 0.7071752369554196, fcs = 1681.974450955533;
  const A = Math.pow(10, G / 40), w0 = 2 * Math.PI * fcs / fs, cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Qs), sa = 2 * Math.sqrt(A) * alpha;
  const a0 = (A + 1) - (A - 1) * cos + sa;
  const shelf = {
    b0: A * ((A + 1) + (A - 1) * cos + sa) / a0, b1: -2 * A * ((A - 1) + (A + 1) * cos) / a0,
    b2: A * ((A + 1) + (A - 1) * cos - sa) / a0, a1: 2 * ((A - 1) - (A + 1) * cos) / a0,
    a2: ((A + 1) - (A - 1) * cos - sa) / a0,
  };
  const Qh = 0.5003270373238773, fch = 38.13547087602444;
  const w1 = 2 * Math.PI * fch / fs, c1 = Math.cos(w1), al = Math.sin(w1) / (2 * Qh), h0 = 1 + al;
  const hp = { b0: (1 + c1) / 2 / h0, b1: -(1 + c1) / h0, b2: (1 + c1) / 2 / h0, a1: -2 * c1 / h0, a2: (1 - al) / h0 };
  return [shelf, hp];
}

// ---------------------------------------------------------------------------
// Offline bounce
// ---------------------------------------------------------------------------

async function renderMix() {
  if (!state.channels.length) throw new Error("Add some tracks first.");
  const sampleRate = ctx ? ctx.sampleRate : 48000;
  const tail = reverbInUse() ? Math.min(state.reverb["rev.decay"], 8) + 0.2 : 0.2;
  const length = Math.ceil((songDuration() + tail) * sampleRate);
  const off = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate });
  await off.audioWorklet.addModule(WORKLET_URL);

  const master = buildMasterNodes(off);
  master.output.connect(off.destination);
  applyMaster(master, state.master, off, false);
  const reverb = buildReverbNodes(off, master.input);
  applyReverb(reverb, state.reverb, off, false);

  const anySolo = soloActive();
  for (const ch of state.channels) {
    const n = buildChannelNodes(off, master.input, reverb.input);
    applyChannel(n, ch.params, off, false, anySolo);
    const src = new AudioBufferSourceNode(off, { buffer: ch.buffer });
    src.connect(n.input);
    src.start(0);
  }
  return off.startRendering();
}

function encodeWav(buffer, bitDepth) {
  const channels = buffer.numberOfChannels;
  const bytes = bitDepth / 8;
  const frames = buffer.length;
  const dataSize = frames * channels * bytes;
  const view = new DataView(new ArrayBuffer(44 + dataSize));
  const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF"); view.setUint32(4, 36 + dataSize, true); writeStr(8, "WAVE");
  writeStr(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * bytes, true);
  view.setUint16(32, channels * bytes, true); view.setUint16(34, bitDepth, true);
  writeStr(36, "data"); view.setUint32(40, dataSize, true);

  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  const max = bitDepth === 16 ? 32767 : 8388607;
  const dither = bitDepth === 16; // TPDF dither when truncating to 16-bit
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      let v = data[c][i] * max;
      if (dither) v += Math.random() - Math.random();
      const s = clamp(Math.round(v), -max - 1, max);
      if (bitDepth === 16) { view.setInt16(o, s, true); o += 2; }
      else { view.setUint8(o, s & 0xff); view.setUint8(o + 1, (s >> 8) & 0xff); view.setUint8(o + 2, (s >> 16) & 0xff); o += 3; }
    }
  }
  return new Blob([view.buffer], { type: "audio/wav" });
}

function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

const fmtLufs = (v) => (Number.isFinite(v) ? v.toFixed(1) : "-inf");

async function bounce({ download = true } = {}) {
  const buffer = await renderMix();
  const depth = Number($("#bounce-depth").value);
  const blob = encodeWav(buffer, depth);
  const stats = analyzeBuffer(buffer);
  lastBounce = { blob, buffer, stats, signature: mixSignature() };
  if (download) downloadBlob(blob, "headroom_mix.wav");
  return lastBounce;
}

// Identifies the exact mix a bounce was rendered from, so stale bounces are never uploaded.
const mixSignature = () =>
  JSON.stringify(serializeMix()) + state.channels.map((c) => c.id).join(",") + $("#bounce-depth").value;

async function matchTarget() {
  const target = Number($("#target-lufs").value);
  const p = state.master;
  if (!p["lim.on"]) setMasterParam("lim.on", true);
  let result;
  for (let pass = 1; pass <= 5; pass++) {
    setStatus("#bounce-status", `Pass ${pass}: rendering...`);
    result = await bounce({ download: false });
    const delta = target - result.stats.lufs;
    if (!Number.isFinite(delta)) throw new Error("The mix is silent.");
    if (Math.abs(delta) < 0.3) break;
    const next = clamp(p["lim.gain"] + delta, MASTER_SPECS["lim.gain"].min, MASTER_SPECS["lim.gain"].max);
    if (next === p["lim.gain"]) break;
    setMasterParam("lim.gain", Math.round(next * 10) / 10);
  }
  return { result, drive: p["lim.gain"] };
}

// ---------------------------------------------------------------------------
// Server mastering
// ---------------------------------------------------------------------------

let consoles = [];

async function loadConsoles() {
  const select = $("#server-console");
  try {
    const res = await fetch("/consoles");
    if (!res.ok) throw new Error(res.statusText);
    consoles = await res.json();
    select.innerHTML = "";
    for (const c of consoles) select.add(new Option(c.label, c.id));
    select.value = consoles.some((c) => c.id === "neve8078") ? "neve8078" : consoles[0]?.id;
    showConsoleDescription();
  } catch {
    $("#console-desc").textContent = "Backend not reachable: server mastering is unavailable, browser bounce still works.";
    $("#btn-server-master").disabled = true;
  }
}

function showConsoleDescription() {
  const c = consoles.find((x) => x.id === $("#server-console").value);
  $("#console-desc").textContent = c ? c.description : "";
}

async function serverMaster() {
  if (!lastBounce || lastBounce.signature !== mixSignature()) {
    setStatus("#server-status", "Bouncing mix...");
    await bounce({ download: false });
  }
  setStatus("#server-status", "Uploading and mastering (two-pass loudness)...");
  const form = new FormData();
  form.append("file", lastBounce.blob, "headroom_mix.wav");
  form.append("console", $("#server-console").value);
  form.append("target_lufs", $("#server-lufs").value);
  form.append("true_peak", $("#server-tp").value);
  form.append("width", $("#server-width").value);
  form.append("bit_depth", $("#bounce-depth").value);

  const res = await fetch("/master", { method: "POST", body: form });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch { /* not JSON */ }
    throw new Error(`Server error (${res.status}): ${detail}`);
  }
  const blob = await res.blob();
  let stats = null;
  try { stats = JSON.parse(res.headers.get("X-Headroom-Stats")); } catch { /* optional */ }

  const ab = $("#ab");
  for (const el of [$("#audio-a"), $("#audio-b"), $("#download-master")]) {
    const prev = el.dataset.url;
    if (prev) URL.revokeObjectURL(prev);
  }
  const urlA = URL.createObjectURL(lastBounce.blob);
  const urlB = URL.createObjectURL(blob);
  $("#audio-a").src = urlA; $("#audio-a").dataset.url = urlA;
  $("#audio-b").src = urlB; $("#audio-b").dataset.url = urlB;
  const dl = $("#download-master");
  dl.href = urlB;
  dl.download = "headroom_master.wav";
  ab.hidden = false;

  if (stats) {
    const i = stats.input, o = stats.output;
    setStatus("#server-status",
      `Mix     ${fmtLufs(i.integrated_lufs)} LUFS  ${fmtLufs(i.true_peak_db)} dBTP  LRA ${fmtLufs(i.loudness_range_lu)} LU\n` +
      `Master  ${fmtLufs(o.integrated_lufs)} LUFS  ${fmtLufs(o.true_peak_db)} dBTP  LRA ${fmtLufs(o.loudness_range_lu)} LU`);
  } else {
    setStatus("#server-status", "Mastered.");
  }
}

function setStatus(sel, text, isError = false) {
  const el = $(sel);
  el.textContent = text;
  el.classList.toggle("error", isError);
}

async function runTask(button, statusSel, fn) {
  button.disabled = true;
  try {
    await fn();
  } catch (err) {
    console.error(err);
    setStatus(statusSel, err.message || String(err), true);
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// UI: knobs, strips
// ---------------------------------------------------------------------------

function formatValue(spec, v) {
  switch (spec.fmt) {
    case "db": return `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
    case "dboff": return v <= spec.min ? "off" : `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
    case "hz": return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : `${Math.round(v)}`;
    case "hzoff": return v <= spec.min ? "off" : `${Math.round(v)}`;
    case "q": return v.toFixed(2);
    case "ratio": return v >= 19.95 ? "inf" : `${v.toFixed(1)}:1`;
    case "ms": return v < 10 ? `${v.toFixed(1)}ms` : `${Math.round(v)}ms`;
    case "s": return `${v.toFixed(1)}s`;
    case "pan": return Math.abs(v) < 0.01 ? "C" : `${v < 0 ? "L" : "R"}${Math.round(Math.abs(v) * 100)}`;
    case "pct": return `${Math.round(v * 100)}%`;
    default: return String(v);
  }
}

const toNorm = (s, v) => (s.log ? Math.log(v / s.min) / Math.log(s.max / s.min) : (v - s.min) / (s.max - s.min));
const fromNorm = (s, t) => {
  t = clamp(t, 0, 1);
  const v = s.log ? s.min * Math.pow(s.max / s.min, t) : s.min + t * (s.max - s.min);
  const precision = s.log ? (v < 10 ? 100 : v < 1000 ? 10 : 1) : s.max - s.min > 20 ? 10 : 100;
  return Math.round(v * precision) / precision;
};

const polar = (cx, cy, r, deg) => {
  const a = (deg - 90) * Math.PI / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
};
const arcPath = (a0, a1, r = 14) => {
  if (Math.abs(a1 - a0) < 0.5) return "";
  const [x0, y0] = polar(18, 18, r, Math.min(a0, a1));
  const [x1, y1] = polar(18, 18, r, Math.max(a0, a1));
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
};

function createKnob(spec, value, onChange) {
  const el = document.createElement("div");
  el.className = "knob";
  el.tabIndex = 0;
  el.setAttribute("role", "slider");
  el.setAttribute("aria-label", spec.label);
  el.setAttribute("aria-valuemin", spec.min);
  el.setAttribute("aria-valuemax", spec.max);
  el.innerHTML = `
    <svg viewBox="0 0 36 36" aria-hidden="true">
      <path class="track" d="${arcPath(-135, 135)}" fill="none" stroke-width="3" stroke-linecap="round"/>
      <path class="arc" fill="none" stroke-width="3" stroke-linecap="round"/>
      <circle class="cap" cx="18" cy="18" r="10"/>
      <line class="needle" x1="18" y1="18" x2="18" y2="9" stroke-width="2" stroke-linecap="round"/>
    </svg>
    <span class="k-value"></span>
    <span class="k-label">${spec.label}</span>`;
  const arc = el.querySelector(".arc");
  const needle = el.querySelector(".needle");
  const valueEl = el.querySelector(".k-value");
  let current = value;

  const render = () => {
    const t = toNorm(spec, current);
    const angle = -135 + 270 * t;
    const from = spec.bipolar ? 0 : -135;
    arc.setAttribute("d", arcPath(from, angle));
    needle.setAttribute("transform", `rotate(${angle} 18 18)`);
    const text = formatValue(spec, current);
    valueEl.textContent = text;
    el.setAttribute("aria-valuenow", current);
    el.setAttribute("aria-valuetext", text);
  };

  const commit = (v) => {
    v = clamp(v, spec.min, spec.max);
    if (v === current) return;
    current = v;
    render();
    onChange(v);
  };

  let drag = null;
  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    el.setPointerCapture(e.pointerId);
    drag = { y: e.clientY, t: toNorm(spec, current) };
    e.preventDefault();
    el.focus();
  });
  el.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const sens = e.shiftKey ? 800 : 180;
    commit(fromNorm(spec, drag.t + (drag.y - e.clientY) / sens));
  });
  const end = () => { drag = null; };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("dblclick", () => commit(spec.def));
  el.addEventListener("wheel", (e) => {
    e.preventDefault();
    const step = (e.shiftKey ? 0.005 : 0.02) * (e.deltaY < 0 ? 1 : -1);
    commit(fromNorm(spec, toNorm(spec, current) + step));
  }, { passive: false });
  el.addEventListener("keydown", (e) => {
    const steps = { ArrowUp: 0.02, ArrowRight: 0.02, ArrowDown: -0.02, ArrowLeft: -0.02, PageUp: 0.1, PageDown: -0.1 };
    if (e.key in steps) {
      e.preventDefault();
      commit(fromNorm(spec, toNorm(spec, current) + steps[e.key] * (e.shiftKey ? 0.25 : 1)));
    } else if (e.key === "Home") { e.preventDefault(); commit(spec.min); }
    else if (e.key === "End") { e.preventDefault(); commit(spec.max); }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); commit(spec.def); }
  });

  render();
  return { el, set(v) { current = v; render(); } };
}

// Builds a console strip. `layout` lists sections of knobs; `target` holds the params.
function buildStrip({ kind, title, color, specs, layout, target, onParam, onRemove, onRename, presets, onPreset, buttons }) {
  const strip = document.createElement("div");
  strip.className = `strip ${kind}`;
  if (color) strip.style.setProperty("--strip-color", color);
  const controls = {};

  const head = document.createElement("div");
  head.className = "strip-head";
  if (onRename) {
    const name = document.createElement("input");
    name.className = "name";
    name.value = title;
    name.spellcheck = false;
    name.setAttribute("aria-label", "Channel name");
    name.addEventListener("change", () => onRename(name.value));
    head.appendChild(name);
  } else {
    const t = document.createElement("div");
    t.className = "title";
    t.textContent = title;
    head.appendChild(t);
  }
  if (onRemove) {
    const x = document.createElement("button");
    x.className = "x";
    x.title = "Remove channel";
    x.setAttribute("aria-label", `Remove ${title}`);
    x.innerHTML = "&times;";
    x.addEventListener("click", onRemove);
    head.appendChild(x);
  }
  strip.appendChild(head);

  if (presets) {
    const sel = document.createElement("select");
    sel.className = "preset";
    sel.setAttribute("aria-label", `${title} preset`);
    sel.add(new Option("Preset...", ""));
    for (const name of Object.keys(presets)) sel.add(new Option(name, name));
    sel.addEventListener("change", () => { if (sel.value) onPreset(sel.value); sel.value = ""; });
    strip.appendChild(sel);
  }

  const toggles = {};
  const makeToggle = (key, label, cls) => {
    const b = document.createElement("button");
    b.className = cls;
    b.textContent = label;
    b.setAttribute("aria-pressed", String(!!target[key]));
    b.addEventListener("click", () => onParam(key, !target[key]));
    toggles[key] = b;
    return b;
  };

  for (const section of layout) {
    const box = document.createElement("div");
    box.className = "section";
    const st = document.createElement("div");
    st.className = "section-title";
    st.textContent = section.title;
    if (section.toggle) st.appendChild(makeToggle(section.toggle, "ON", "mini"));
    if (section.gr) {
      const gr = document.createElement("span");
      gr.className = "gr";
      gr.title = "Gain reduction";
      gr.innerHTML = "<i></i>";
      st.appendChild(gr);
      controls[`gr:${section.gr}`] = gr.firstChild;
    }
    box.appendChild(st);
    const grid = document.createElement("div");
    grid.className = "knobs";
    for (const key of section.knobs) {
      const knob = createKnob(specs[key], target[key], (v) => onParam(key, v));
      controls[key] = knob;
      if (section.toggle) knob.el.dataset.section = section.toggle;
      grid.appendChild(knob.el);
    }
    box.appendChild(grid);
    if (section.extra) box.appendChild(section.extra);
    strip.appendChild(box);
  }

  if (buttons?.length) {
    const row = document.createElement("div");
    row.className = "buttons";
    for (const [key, label, cls] of buttons) row.appendChild(makeToggle(key, label, `ms ${cls}`));
    strip.appendChild(row);
  }

  const faderArea = document.createElement("div");
  faderArea.className = "fader-area";
  faderArea.innerHTML = `
    <div class="fader-wrap"><input class="fader" type="range" min="${FADER_MIN}" max="12" step="0.1" aria-label="${title} fader"></div>
    <div class="meter"><div class="meter-bar"></div><div class="meter-bar"></div><div class="peak-hold"></div></div>`;
  const fader = faderArea.querySelector(".fader");
  fader.value = target.fader;
  fader.addEventListener("input", () => onParam("fader", Number(fader.value)));
  fader.addEventListener("dblclick", () => onParam("fader", 0));
  strip.appendChild(faderArea);

  const readout = document.createElement("div");
  readout.className = "readout";
  readout.innerHTML = `<span class="db"></span><span class="pk" title="Peak hold (click to reset)">-inf</span>`;
  strip.appendChild(readout);

  const dbEl = readout.querySelector(".db");
  const pkEl = readout.querySelector(".pk");
  const bars = faderArea.querySelectorAll(".meter-bar");
  const hold = faderArea.querySelector(".peak-hold");
  const meterState = { held: 0, heldAt: 0, max: 0, levels: [0, 0] };
  pkEl.addEventListener("click", () => { meterState.max = 0; pkEl.textContent = "-inf"; pkEl.classList.remove("clip"); });

  const ui = {
    el: strip,
    controls,
    sync() {
      for (const [key, c] of Object.entries(controls)) if (c.set) c.set(target[key]);
      for (const [key, b] of Object.entries(toggles)) b.setAttribute("aria-pressed", String(!!target[key]));
      for (const c of Object.values(controls)) {
        if (c.el?.dataset.section) c.el.classList.toggle("disabled", !target[c.el.dataset.section]);
      }
      fader.value = target.fader;
      dbEl.textContent = target.fader <= FADER_MIN ? "-inf dB" : `${target.fader > 0 ? "+" : ""}${target.fader.toFixed(1)} dB`;
    },
    meter(peaks, now) {
      const meterHeight = bars[0].parentElement.clientHeight - 2;
      peaks.forEach((pk, i) => {
        // fast attack, ~20 dB/s fall
        const db = gainToDb(pk);
        const prev = meterState.levels[i];
        meterState.levels[i] = db > prev ? db : Math.max(db, prev - 0.33);
        const h = clamp((meterState.levels[i] - METER_FLOOR) / (METER_TOP - METER_FLOOR), 0, 1);
        bars[i].style.height = `${(h * 100).toFixed(1)}%`;
        bars[i].style.setProperty("--meter-h", `${meterHeight}px`);
      });
      const top = Math.max(...peaks);
      if (top >= meterState.held || now - meterState.heldAt > 1500) {
        meterState.held = top;
        meterState.heldAt = now;
      }
      const hh = clamp((gainToDb(meterState.held) - METER_FLOOR) / (METER_TOP - METER_FLOOR), 0, 1);
      hold.style.bottom = `${(hh * 100).toFixed(1)}%`;
      hold.style.opacity = hh > 0 ? 1 : 0;
      if (top > meterState.max) {
        meterState.max = top;
        pkEl.textContent = fmtLufs(gainToDb(top));
        pkEl.classList.toggle("clip", top >= 1);
      }
    },
    reduction(key, db) {
      const bar = controls[`gr:${key}`];
      if (bar) bar.style.width = `${clamp(db / 20, 0, 1) * 100}%`;
    },
  };
  ui.sync();
  return ui;
}

const CHANNEL_LAYOUT = [
  { title: "INPUT", knobs: ["trim", "hpf"] },
  { title: "EQ", toggle: "eq.on", knobs: ["eq.high.gain", "eq.high.freq", "eq.mid.gain", "eq.mid.freq", "eq.mid.q", "eq.low.gain", "eq.low.freq"] },
  { title: "COMP", toggle: "comp.on", gr: "comp", knobs: ["comp.threshold", "comp.ratio", "comp.attack", "comp.release", "comp.makeup"] },
  { title: "SEND / PAN", knobs: ["send.reverb", "pan"] },
];

function mountChannel(ch) {
  ch.ui = buildStrip({
    kind: "channel",
    title: ch.name,
    color: ch.color,
    specs: CHANNEL_SPECS,
    layout: CHANNEL_LAYOUT,
    target: ch.params,
    presets: CHANNEL_PRESETS,
    buttons: [["mute", "M", "mute"], ["solo", "S", "solo"]],
    onParam: (key, v) => {
      ch.params[key] = v;
      if (key === "solo") refreshChannels();
      else if (ch.nodes) applyChannel(ch.nodes, ch.params, ctx, true, soloActive());
      ch.ui.sync();
      if (key === "send.reverb" || key === "mute" || key === "solo") drawTimeline();
    },
    onPreset: (name) => applyChannelPreset(ch, name),
    onRename: (name) => { ch.name = name || ch.name; drawTimeline(); },
    onRemove: () => removeChannel(ch),
  });
  $("#channels").appendChild(ch.ui.el);
}

function applyChannelPreset(ch, name) {
  const keep = { fader: ch.params.fader, mute: ch.params.mute, solo: ch.params.solo, pan: ch.params.pan };
  Object.assign(ch.params, channelDefaults(), keep, CHANNEL_PRESETS[name]);
  if (ch.nodes) applyChannel(ch.nodes, ch.params, ctx, true, soloActive());
  ch.ui.sync();
}

let masterUi, reverbUi;

function setMasterParam(key, v) {
  state.master[key] = v;
  if (live) applyMaster(live.master, state.master, ctx, true);
  masterUi.sync();
}

function setReverbParam(key, v) {
  state.reverb[key] = v;
  if (live) applyReverb(live.reverb, state.reverb, ctx, true);
  reverbUi.sync();
}

function mountBuses() {
  const lufsBox = document.createElement("dl");
  lufsBox.className = "lufs";
  lufsBox.innerHTML = `
    <dt>Momentary</dt><dd id="lufs-m">-inf</dd>
    <dt>Short-term</dt><dd id="lufs-s">-inf</dd>
    <dt>Integrated</dt><dd id="lufs-i">-inf</dd>
    <dt>Peak</dt><dd id="lufs-pk">-inf</dd>
    <button class="btn reset" id="lufs-reset" type="button">Reset meter</button>`;
  lufsBox.querySelector("#lufs-reset").addEventListener("click", resetLoudness);

  reverbUi = buildStrip({
    kind: "fx",
    title: "REVERB",
    specs: REVERB_SPECS,
    layout: [{ title: "ROOM", knobs: ["rev.decay", "rev.predelay", "rev.tone", "rev.lowcut"] }],
    target: state.reverb,
    buttons: [["mute", "M", "mute"]],
    onParam: setReverbParam,
  });

  masterUi = buildStrip({
    kind: "master",
    title: "MASTER",
    specs: MASTER_SPECS,
    layout: [
      { title: "EQ", toggle: "eq.on", knobs: ["eq.low.gain", "eq.mid.gain", "eq.high.gain", "eq.low.freq", "eq.mid.freq", "eq.high.freq", "eq.mid.q"] },
      { title: "BUS COMP", toggle: "comp.on", gr: "comp", knobs: ["comp.threshold", "comp.ratio", "comp.makeup", "comp.attack", "comp.release"] },
      { title: "STEREO", knobs: ["width"] },
      { title: "LIMITER", toggle: "lim.on", gr: "lim", knobs: ["lim.gain", "lim.ceiling", "lim.release"] },
      { title: "LOUDNESS", knobs: [], extra: lufsBox },
    ],
    target: state.master,
    presets: MASTER_PRESETS,
    onPreset: (name) => {
      Object.assign(state.master, masterDefaults(), { fader: state.master.fader }, MASTER_PRESETS[name]);
      if (live) applyMaster(live.master, state.master, ctx, true);
      masterUi.sync();
    },
    onParam: setMasterParam,
  });

  $("#buses").append(reverbUi.el, masterUi.el);
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

function guessPreset(name) {
  for (const [re, preset] of PRESET_HINTS) if (re.test(name)) return preset;
  return null;
}

function addChannel(name, buffer, preset = guessPreset(name), overrides = {}) {
  const ch = {
    id: nextChannelId++,
    name,
    buffer,
    color: COLORS[(nextChannelId - 2) % COLORS.length],
    params: { ...channelDefaults(), ...(preset ? CHANNEL_PRESETS[preset] : {}), ...overrides },
    peaks: computePeaks(buffer),
  };
  state.channels.push(ch);
  mountChannel(ch);
  if (ctx) {
    attachLiveChannel(ch);
    refreshChannels();
    if (playing) startSource(ch, position(), ctx.currentTime + 0.02);
  }
  onChannelsChanged();
  return ch;
}

function removeChannel(ch) {
  for (const s of sources.filter((x) => x.ch === ch)) {
    try { s.src.stop(); } catch { /* ignore */ }
    s.src.disconnect();
  }
  sources = sources.filter((x) => x.ch !== ch);
  if (ch.nodes) {
    ch.meter.disconnect();
    ch.nodes.pan.disconnect();
    ch.nodes.send.disconnect();
  }
  ch.ui.el.remove();
  state.channels = state.channels.filter((c) => c !== ch);
  refreshChannels();
  if (!state.channels.length) stop();
  onChannelsChanged();
}

function onChannelsChanged() {
  $("#dropzone").classList.toggle("hidden", state.channels.length > 0);
  lastBounce = null;
  drawTimeline();
}

async function addFiles(files) {
  const list = Array.from(files).filter((f) => f.type.startsWith("audio/") || /\.(wav|mp3|flac|ogg|m4a|aiff?|aac|opus)$/i.test(f.name));
  if (!list.length) return;
  await ensureAudio();
  for (const file of list) {
    try {
      const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
      addChannel(file.name.replace(/\.[^.]+$/, ""), buffer);
    } catch (err) {
      console.error(err);
      setStatus("#bounce-status", `Could not decode ${file.name}: ${err.message || err}`, true);
    }
  }
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

function computePeaks(buffer, points = 1500) {
  const peaks = new Float32Array(points);
  const step = buffer.length / points;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let p = 0; p < points; p++) {
      const start = Math.floor(p * step), end = Math.min(data.length, Math.floor((p + 1) * step));
      let m = peaks[p];
      for (let i = start; i < end; i += 4) { const v = Math.abs(data[i]); if (v > m) m = v; }
      peaks[p] = m;
    }
  }
  return peaks;
}

const timelineCache = document.createElement("canvas");

function drawTimeline() {
  const canvas = $("#timeline");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  for (const c of [canvas, timelineCache]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = timelineCache.getContext("2d");
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  const total = songDuration();
  const chans = state.channels;
  if (!chans.length || !total) { drawPlayhead(); return; }
  const lane = h / chans.length;
  const anySolo = soloActive();
  chans.forEach((ch, idx) => {
    const y0 = idx * lane, mid = y0 + lane / 2;
    const width = (ch.buffer.duration / total) * w;
    const silent = ch.params.mute || (anySolo && !ch.params.solo);
    g.fillStyle = ch.color;
    g.globalAlpha = silent ? 0.15 : 0.75;
    for (let x = 0; x < width; x++) {
      const pk = ch.peaks[Math.floor((x / width) * ch.peaks.length)] || 0;
      const hh = Math.max(0.5, pk * (lane / 2 - 1));
      g.fillRect(x, mid - hh, 1, hh * 2);
    }
    g.globalAlpha = 1;
    g.fillStyle = "rgba(255,255,255,0.75)";
    g.font = "10px system-ui, sans-serif";
    if (lane >= 12) g.fillText(ch.name, 6, y0 + Math.min(12, lane - 2));
    if (idx) { g.fillStyle = "rgba(255,255,255,0.06)"; g.fillRect(0, y0, w, 1); }
  });
  drawPlayhead();
}

function drawPlayhead() {
  const canvas = $("#timeline");
  const g = canvas.getContext("2d");
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.drawImage(timelineCache, 0, 0);
  const total = songDuration();
  if (!total) return;
  const x = (position() / total) * canvas.width;
  g.fillStyle = "#fff";
  g.fillRect(Math.round(x), 0, Math.max(1, window.devicePixelRatio || 1), canvas.height);
}

// ---------------------------------------------------------------------------
// Animation loop: meters, clock, playhead, looping
// ---------------------------------------------------------------------------

function frame(now) {
  const total = songDuration();
  if (playing && position() >= total) {
    if (state.loop && total > 0) {
      pause();
      startOffset = 0;
      play();
    } else {
      pause();
      startOffset = total;
    }
  }
  $("#clock").textContent = `${fmtTime(Math.min(position(), total))} / ${fmtTime(total)}`;
  drawPlayhead();

  if (live) {
    for (const ch of state.channels) {
      if (!ch.meter) continue;
      ch.ui.meter(ch.meter.read(), now);
      ch.ui.reduction("comp", ch.params["comp.on"] ? -ch.nodes.comp.reduction : 0);
    }
    masterUi.meter(live.masterMeter.read(), now);
    masterUi.reduction("comp", state.master["comp.on"] ? -live.master.comp.reduction : 0);
    masterUi.reduction("lim", limiterReduction);
    reverbUi.meter(live.reverbMeter.read(), now);

    const b = loudness.blocks;
    $("#lufs-m").textContent = fmtLufs(b.length >= 4 ? powerToLufs(mean(b.slice(-4))) : -Infinity);
    $("#lufs-s").textContent = fmtLufs(b.length >= 30 ? powerToLufs(mean(b)) : -Infinity);
    $("#lufs-i").textContent = fmtLufs(integratedLufs(loudness.gating));
    $("#lufs-pk").textContent = fmtLufs(gainToDb(loudness.maxPeak));
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Save / load mix settings
// ---------------------------------------------------------------------------

function serializeMix() {
  return {
    app: "headroom-console",
    version: 1,
    master: { ...state.master },
    reverb: { ...state.reverb },
    channels: state.channels.map((ch) => ({ name: ch.name, params: { ...ch.params } })),
  };
}

function applyMix(data) {
  if (data?.app !== "headroom-console") throw new Error("Not a Headroom mix file.");
  const pick = (defaults, src) => {
    const out = { ...defaults };
    for (const k of Object.keys(defaults)) if (src && typeof src[k] === typeof defaults[k]) out[k] = src[k];
    return out;
  };
  Object.assign(state.master, pick(masterDefaults(), data.master));
  Object.assign(state.reverb, pick(reverbDefaults(), data.reverb));
  const saved = data.channels || [];
  state.channels.forEach((ch, i) => {
    const match = saved.find((s) => s.name === ch.name) || saved[i];
    if (match) Object.assign(ch.params, pick(channelDefaults(), match.params));
    ch.ui.sync();
  });
  if (live) {
    applyMaster(live.master, state.master, ctx, true);
    applyReverb(live.reverb, state.reverb, ctx, true);
  }
  refreshChannels();
  masterUi.sync();
  reverbUi.sync();
  drawTimeline();
}

// ---------------------------------------------------------------------------
// Demo song (synthesized in the browser, no downloads)
// ---------------------------------------------------------------------------

function synthDemo(sampleRate) {
  const bpm = 112, beat = 60 / bpm, bars = 8, dur = bars * 4 * beat;
  const len = Math.ceil((dur + 1) * sampleRate);
  const make = () => [new Float32Array(len), new Float32Array(len)];
  let seed = 42;
  const noise = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2147483648 - 1; };
  const at = (t) => Math.floor(t * sampleRate);
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const add = (buf, t0, samples, fn, panL = 1, panR = 1) => {
    const s0 = at(t0);
    for (let i = 0; i < samples && s0 + i < len; i++) {
      const v = fn(i / sampleRate, i);
      buf[0][s0 + i] += v * panL;
      buf[1][s0 + i] += v * panR;
    }
  };

  const chords = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // Am F C G
  const roots = [33, 29, 36, 31];

  const kick = make();
  const snare = make();
  const hats = make();
  const bass = make();
  const keys = make();
  const lead = make();

  for (let bar = 0; bar < bars; bar++) {
    const t0 = bar * 4 * beat;
    const ci = bar % 4;
    // Kick: beats 1 and 3, plus a push on the "and" of 4 every other bar.
    const kicks = [0, 2].concat(bar % 2 ? [3.5] : []);
    for (const b of kicks) {
      let phase = 0;
      add(kick, t0 + b * beat, at(0.45), (t) => {
        const f = 45 + 110 * Math.exp(-t * 35);
        phase += 2 * Math.PI * f / sampleRate;
        return Math.sin(phase) * Math.exp(-t * 7) * 0.9 + (t < 0.003 ? noise() * 0.3 : 0);
      });
    }
    // Snare: beats 2 and 4.
    for (const b of [1, 3]) {
      let lp = 0;
      add(snare, t0 + b * beat, at(0.3), (t) => {
        const n = noise();
        lp += (n - lp) * 0.5;
        return (n - lp) * Math.exp(-t * 16) * 0.55 + Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 30) * 0.4;
      });
    }
    // Hats: 8ths, accented off-beats.
    for (let e = 0; e < 8; e++) {
      let prev = 0;
      const amp = e % 2 ? 0.28 : 0.16;
      add(hats, t0 + e * beat / 2, at(0.06), (t) => {
        const n = noise();
        const hp = n - prev;
        prev = n;
        return hp * Math.exp(-t * 70) * amp;
      }, 0.8, 1);
    }
    // Bass: 8th-note root with octave jump.
    for (let e = 0; e < 8; e++) {
      const note = roots[ci] + (e === 3 || e === 7 ? 12 : 0);
      const f = mtof(note);
      let lp = 0;
      add(bass, t0 + e * beat / 2, at(beat / 2 * 0.95), (t) => {
        const saw = 2 * ((t * f) % 1) - 1;
        const cutoff = 0.04 + 0.12 * Math.exp(-t * 12);
        lp += (saw - lp) * cutoff;
        return lp * 0.6 * Math.min(1, t * 400) * Math.exp(-t * 2);
      });
    }
    // Keys: sustained detuned-saw chord per bar, spread across the stereo field.
    chords[ci].forEach((m, vi) => {
      const f = mtof(m);
      let lp = 0;
      const pan = [-0.5, 0, 0.5][vi];
      add(keys, t0, at(4 * beat), (t) => {
        const s = (2 * ((t * f * 1.003) % 1) - 1) + (2 * ((t * f * 0.997) % 1) - 1);
        lp += (s - lp) * 0.06;
        const env = Math.min(1, t * 8) * Math.min(1, (4 * beat - t) * 10);
        return lp * 0.09 * env;
      }, 1 - Math.max(0, pan), 1 + Math.min(0, pan));
    });
  }
  // Lead: simple melody over the last 4 bars.
  const melody = [[0, 76, 1], [1, 74, 0.5], [1.5, 72, 0.5], [2, 71, 1], [3, 72, 1],
    [4, 69, 1.5], [5.5, 72, 0.5], [6, 74, 2], [8, 72, 1], [9, 71, 0.5], [9.5, 69, 0.5],
    [10, 67, 2], [12, 71, 1], [13, 72, 1], [14, 74, 2]];
  for (const [b, m, l] of melody) {
    const f = mtof(m);
    let phase = 0;
    add(lead, 4 * 4 * beat + b * beat, at(l * beat), (t) => {
      const vib = 1 + 0.004 * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, t * 3);
      phase += f * vib / sampleRate;
      const tri = 1 - 4 * Math.abs((phase % 1) - 0.5);
      const env = Math.min(1, t * 60) * Math.min(1, (l * beat - t) * 20);
      return tri * 0.35 * env;
    });
  }

  const toBuffer = ([l, r]) => {
    const b = new AudioBuffer({ numberOfChannels: 2, length: len, sampleRate });
    b.copyToChannel(l, 0);
    b.copyToChannel(r, 1);
    return b;
  };
  return [
    ["Kick", toBuffer(kick), "Kick", { fader: -9 }],
    ["Snare", toBuffer(snare), "Snare", { fader: -10 }],
    ["Hi-hats", toBuffer(hats), "Hi-hats", { fader: -14 }],
    ["Bass", toBuffer(bass), "Bass", { fader: -11 }],
    ["Keys", toBuffer(keys), "Keys / Pad", { fader: -12 }],
    ["Lead", toBuffer(lead), "Lead synth", { fader: -12, pan: -0.15 }],
  ];
}

async function loadDemo() {
  await ensureAudio();
  for (const [name, buffer, preset, overrides] of synthDemo(ctx.sampleRate)) addChannel(name, buffer, preset, overrides);
  state.reverb.fader = -4;
  reverbUi.sync();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function wire() {
  $("#btn-play").addEventListener("click", () => (playing ? pause() : play()));
  $("#btn-stop").addEventListener("click", stop);
  $("#btn-rewind").addEventListener("click", () => seek(0));
  $("#btn-loop").addEventListener("click", (e) => {
    state.loop = !state.loop;
    e.currentTarget.setAttribute("aria-pressed", String(state.loop));
  });

  $("#file-input").addEventListener("change", async (e) => {
    await addFiles(e.target.files);
    e.target.value = "";
  });
  $("#btn-demo").addEventListener("click", (e) => runTask(e.currentTarget, "#bounce-status", loadDemo));

  $("#btn-save").addEventListener("click", () => {
    downloadBlob(new Blob([JSON.stringify(serializeMix(), null, 2)], { type: "application/json" }), "headroom_mix.json");
  });
  $("#settings-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      applyMix(JSON.parse(await file.text()));
      setStatus("#bounce-status", `Loaded mix settings from ${file.name}.`);
    } catch (err) {
      setStatus("#bounce-status", `Could not load ${file.name}: ${err.message}`, true);
    }
  });

  $("#btn-bounce").addEventListener("click", (e) => runTask(e.currentTarget, "#bounce-status", async () => {
    setStatus("#bounce-status", "Rendering...");
    const { stats } = await bounce();
    setStatus("#bounce-status", `Bounced: ${fmtLufs(stats.lufs)} LUFS integrated, ${fmtLufs(stats.peakDb)} dBFS sample peak.`);
  }));
  $("#btn-match").addEventListener("click", (e) => runTask(e.currentTarget, "#bounce-status", async () => {
    const { result, drive } = await matchTarget();
    setStatus("#bounce-status",
      `Limiter drive set to ${drive > 0 ? "+" : ""}${drive.toFixed(1)} dB -> ${fmtLufs(result.stats.lufs)} LUFS, ${fmtLufs(result.stats.peakDb)} dBFS peak.`);
  }));
  $("#server-console").addEventListener("change", showConsoleDescription);
  $("#btn-server-master").addEventListener("click", (e) => runTask(e.currentTarget, "#server-status", serverMaster));

  $("#timeline").addEventListener("click", (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    seek(((e.clientX - rect.left) / rect.width) * songDuration());
  });

  // Drag and drop anywhere.
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; document.body.classList.add("dragging"); });
  window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); } });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove("dragging");
    addFiles(e.dataTransfer.files);
  });

  window.addEventListener("keydown", (e) => {
    if (e.target.closest("input, select, textarea, [role=slider]")) return;
    if (e.code === "Space") { e.preventDefault(); playing ? pause() : play(); }
    else if (e.code === "Home") { e.preventDefault(); seek(0); }
  });
  window.addEventListener("resize", drawTimeline);
}

mountBuses();
wire();
drawTimeline();
loadConsoles();
requestAnimationFrame(frame);

// Exposed for debugging and automated tests.
window.headroom = { state, renderMix, analyzeBuffer, encodeWav, loadDemo, play, pause, stop, serializeMix, applyMix };
