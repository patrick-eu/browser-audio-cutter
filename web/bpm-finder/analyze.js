'use strict';
// Tempo and key estimation, run inside the visitor's browser (Web Worker) — no network.
// Also loadable from Node for tests: module.exports = { analyze, beatPhase }.

const SR = 22050;

function toMono(channels, sr) {
  const f = Math.max(1, Math.round(sr / SR)), n = Math.floor(channels[0].length / f), x = new Float32Array(n);
  const scale = 1 / (f * channels.length);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const c of channels) for (let j = 0, o = i * f; j < f; j++) s += c[o + j];
    x[i] = s * scale;
  }
  return { x, sr: sr / f };
}

function makeFFT(n) {
  const rev = new Uint32Array(n);
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; rev[i] = j; }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) { cos[k] = Math.cos(2 * Math.PI * k / n); sin[k] = Math.sin(2 * Math.PI * k / n); }
  return (re, im) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half, tr = re[l] * cos[k] + im[l] * sin[k], ti = im[l] * cos[k] - re[l] * sin[k];
          re[l] = re[j] - tr; im[l] = im[j] - ti; re[j] += tr; im[j] += ti;
        }
      }
    }
  };
}

// Calls fn(magnitudes, frameIndex) for each Hann-windowed frame.
function spectra(x, n, hop, fn) {
  const fft = makeFFT(n), win = new Float64Array(n), re = new Float64Array(n), im = new Float64Array(n), mag = new Float64Array(n / 2);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
  const frames = x.length < n ? 0 : 1 + Math.floor((x.length - n) / hop);
  for (let t = 0; t < frames; t++) {
    const o = t * hop;
    for (let i = 0; i < n; i++) { re[i] = x[o + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < n / 2; k++) mag[k] = Math.hypot(re[k], im[k]) / n;
    fn(mag, t);
  }
  return frames;
}

// ---------- tempo ----------
const HOP = 256;

function onsetEnvelope(x, sr) {
  const n = 1024, kmax = Math.min(n / 2, Math.round(8000 / (sr / n)));
  let prev = new Float64Array(kmax), cur = new Float64Array(kmax);
  const raw = [];
  spectra(x, n, HOP, (mag, t) => {
    let s = 0;
    for (let k = 1; k < kmax; k++) {
      const v = Math.log1p(1000 * mag[k]);
      if (t > 0 && v > prev[k]) s += v - prev[k];
      cur[k] = v;
    }
    [prev, cur] = [cur, prev];
    raw.push(s);
  });
  const fps = sr / HOP, w = Math.round(0.2 * fps), T = raw.length, e = new Float32Array(T);
  // subtract a moving average, keep the positive part, then smooth lightly so ACF peaks are not one frame wide
  const cs = new Float64Array(T + 1);
  for (let i = 0; i < T; i++) cs[i + 1] = cs[i] + raw[i];
  const hp = new Float64Array(T);
  for (let i = 0; i < T; i++) {
    const a = Math.max(0, i - w), b = Math.min(T, i + w + 1);
    hp[i] = Math.max(0, raw[i] - (cs[b] - cs[a]) / (b - a));
  }
  const g = [1, 4, 6, 4, 1];
  for (let i = 0; i < T; i++) {
    let s = 0, ws = 0;
    for (let j = -2; j <= 2; j++) if (i + j >= 0 && i + j < T) { s += hp[i + j] * g[j + 2]; ws += g[j + 2]; }
    e[i] = s / ws;
  }
  return { env: e, fps };
}

function autocorr(e, maxLag) {
  const r = new Float64Array(maxLag + 1);
  for (let l = 0; l <= maxLag; l++) {
    let s = 0;
    for (let i = 0, m = e.length - l; i < m; i++) s += e[i] * e[i + l];
    r[l] = s / (e.length - l);
  }
  return r;
}

const at = (r, p) => { const i = Math.floor(p), f = p - i; return i + 1 < r.length ? r[i] * (1 - f) + r[i + 1] * f : 0; };
const MIN_BPM = 40, MAX_BPM = 240;
// log-normal preference around 120 BPM; only used to rank octave-equivalent readings, both are shown to the user
const prior = b => Math.exp(-0.5 * (Math.log2(b / 120) / 1.2) ** 2);

function tempoFromEnv(e, fps) {
  const maxLag = Math.min(Math.round(12 * fps), e.length >> 1);
  if (maxLag < 60 * fps / MIN_BPM * 2) return null;
  const r = autocorr(e, maxLag);
  const comb = (b, kmax) => {
    const L = 60 * fps / b; let s = 0, k = 1;
    for (; k <= kmax && k * L <= maxLag; k++) s += at(r, k * L);
    return k > 1 ? s / (k - 1) : 0;
  };
  const grid = [];
  for (let b = 30; b <= 300; b *= 1.002) grid.push({ b, s: comb(b, 4) });
  const scores = grid.map(g => g.s).sort((a, b) => a - b), median = scores[scores.length >> 1];
  let best = null;
  for (const g of grid) if (g.b >= MIN_BPM && g.b <= MAX_BPM && (!best || g.s * prior(g.b) > best.s * prior(best.b))) best = g;
  const refine = b0 => {
    let bb = b0, bs = -Infinity;
    for (let b = b0 * 0.985; b <= b0 * 1.015; b += 0.01) { const s = comb(b, 1e9); if (s > bs) { bs = s; bb = b; } }
    return bb;
  };
  const bpm = refine(best.b);
  const strength = Math.max(0, Math.min(1, (comb(bpm, 4) - median) / (r[0] - median || 1)));
  // the other octave reading people argue about (70 vs 140): double below 120 BPM, half above
  const alt = refine(bpm < 120 ? bpm * 2 : bpm / 2);
  // other peaks that are not octave relatives of the main reading
  const others = [];
  for (let i = 1; i < grid.length - 1; i++) {
    const g = grid[i];
    if (g.b < MIN_BPM || g.b > MAX_BPM || g.s < grid[i - 1].s || g.s < grid[i + 1].s) continue;
    if (g.s > median) others.push(g);
  }
  others.sort((a, b) => b.s * prior(b.b) - a.s * prior(a.b));
  const picked = [];
  const nearOctave = b => { const q = Math.log2(b / bpm); return Math.abs(q - Math.round(q)) < 0.03; };
  for (const o of others) {
    const b = refine(o.b);
    if (!nearOctave(b) && picked.every(p => Math.abs(Math.log2(p / b)) > 0.03)) picked.push(b);
    if (picked.length === 2) break;
  }
  return { bpm, alt, strength, others: picked };
}

function tempo(x, sr) {
  const { env, fps } = onsetEnvelope(x, sr);
  const whole = tempoFromEnv(env, fps);
  if (!whole) return null;
  // check whether sections agree; a single number is misleading when the tempo changes
  const seg = Math.round(20 * fps), step = Math.round(10 * fps), sections = [];
  if (env.length >= seg * 2) {
    for (let s = 0; s + seg <= env.length; s += step) {
      const t = tempoFromEnv(env.subarray(s, s + seg), fps);
      if (!t || t.strength < 0.15) continue;
      let b = t.bpm;
      while (b > whole.bpm * Math.SQRT2) b /= 2;
      while (b < whole.bpm / Math.SQRT2) b *= 2;
      sections.push({ start: s / fps, bpm: b });
    }
  }
  const bs = sections.map(s => s.bpm), lo = Math.min(...bs), hi = Math.max(...bs);
  whole.varies = sections.length >= 2 && hi / lo > 1.04 ? { lo, hi, sections } : null;
  whole.env = env; whole.fps = fps;
  return whole;
}

// Offset (seconds) of the beat grid for a given tempo, for the click track.
function beatPhase(env, fps, bpm) {
  const L = 60 * fps / bpm;
  let best = 0, bs = -1;
  for (let p = 0; p < L; p += 0.25) {
    let s = 0;
    for (let t = p; t < env.length - 1; t += L) s += at(env, t);
    if (s > bs) { bs = s; best = p; }
  }
  // env frame i covers samples starting at i*HOP; its centre is half a window later
  return best / fps + 512 / (fps * HOP);
}

// ---------- key ----------
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const MAJOR_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const MINOR_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B'];

function pearson(a, b) {
  const n = a.length, ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

function key(x, sr) {
  const n = 8192, hop = 4096, binHz = sr / n, kmin = Math.ceil(60 / binHz), kmax = Math.min(n / 2 - 2, Math.floor(2000 / binHz));
  const chroma = new Float64Array(12);
  let frames = 0;
  spectra(x, n, hop, mag => {
    const c = new Float64Array(12); let tot = 0;
    for (let k = kmin; k <= kmax; k++) {
      if (!(mag[k] > mag[k - 1] && mag[k] >= mag[k + 1])) continue;   // spectral peaks only, to limit window leakage
      const a = mag[k - 1], b = mag[k], d = mag[k + 1], off = 0.5 * (a - d) / (a - 2 * b + d);
      const midi = 69 + 12 * Math.log2((k + off) * binHz / 440), pc = ((Math.round(midi) % 12) + 12) % 12;
      c[pc] += b; tot += b;
    }
    if (tot > 1e-4) { for (let i = 0; i < 12; i++) chroma[i] += c[i] / tot; frames++; }
  });
  if (!frames) return null;
  const keys = [];
  for (let t = 0; t < 12; t++) {
    const rot = Array.from({ length: 12 }, (_, i) => chroma[(i + t) % 12]);
    keys.push({ tonic: t, mode: 'major', name: `${MAJOR_NAMES[t]} major`, r: pearson(rot, MAJOR) });
    keys.push({ tonic: t, mode: 'minor', name: `${MINOR_NAMES[t]} minor`, r: pearson(rot, MINOR) });
  }
  keys.sort((a, b) => b.r - a.r);
  const [k0] = keys;
  const relative = k0.mode === 'major' ? (k0.tonic + 9) % 12 : (k0.tonic + 3) % 12;
  for (const k of keys) k.relative = k.mode !== k0.mode && k.tonic === relative;
  const margin = k0.r - keys[1].r;
  // thresholds picked on generated test tracks (see test/bpm): drums-only and noise stayed below 0.65
  const clarity = k0.r >= 0.8 && margin >= 0.05 ? 'clear' : k0.r >= 0.65 ? 'weak' : 'none';
  return { best: k0, others: keys.slice(1, 3), margin, clarity };
}

function analyze(channels, sampleRate) {
  const { x, sr } = toMono(channels, sampleRate);
  return { tempo: tempo(x, sr), key: key(x, sr), seconds: x.length / sr };
}

if (typeof module !== 'undefined') module.exports = { analyze, beatPhase };
else if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.onmessage = ({ data }) => {
    try {
      const res = analyze(data.channels, data.sampleRate);
      self.postMessage({ ok: true, res }, res.tempo ? [res.tempo.env.buffer] : []);
    } catch (err) { self.postMessage({ ok: false, error: String(err && err.message || err) }); }
  };
}
