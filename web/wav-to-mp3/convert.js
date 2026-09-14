'use strict';
const $ = id => document.getElementById(id);
const worker = new Worker('encoder.js');
const jobs = new Map();          // id -> { resolve, reject }
worker.onmessage = ({ data }) => {
  const j = jobs.get(data.id);
  if (!j) return;
  jobs.delete(data.id);
  data.error ? j.reject(new Error(data.error)) : j.resolve(data.blob);
};
const ask = (msg, transfer) => new Promise((resolve, reject) => { jobs.set(msg.id, { resolve, reject }); worker.postMessage(msg, transfer); });
const LONG_SECONDS = 1800;

// MP3 bitrates (kbps) that lamejs encodes exactly at each sample rate, checked with ffprobe (test/wav2mp3/lame-rates.csv).
// Stereo lists are also exact for mono files, so "same as file" uses them.
const KBPS = {
  16000: { mono: [32, 48, 64, 96, 128, 160], stereo: [32, 48, 64, 96, 128, 160] },
  22050: { mono: [32, 48, 64, 96, 128, 160], stereo: [48, 64, 96, 128, 160] },
  24000: { mono: [48, 64, 96, 128, 160], stereo: [64, 96, 128, 160] },
  32000: { mono: [48, 64, 96, 128, 160, 192, 224, 256, 320], stereo: [96, 128, 160, 192, 224, 256, 320] },
  44100: { mono: [64, 96, 128, 160, 192, 224, 256, 320], stereo: [128, 160, 192, 224, 256, 320] },
  48000: { mono: [64, 96, 128, 160, 192, 224, 256, 320], stereo: [128, 160, 192, 224, 256, 320] },
};

let items = [];                  // { id, file, base, duration, el, url, state }
let seq = 0, busy = false;
const fmtTime = s => { const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`; };
const fmtSize = b => b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
const settings = () => ({ format: $('format').value, kbps: +$('bitrate').value, rate: +$('rate').value, channels: $('channels').value, gain: +$('volume').value / 100 });

// Read the WAV header (fmt and data chunks): shown to the visitor, and used to decode the file piece by piece.
const CODECS = { 1: 'PCM', 3: 'float', 6: 'A-law', 7: 'μ-law', 2: 'ADPCM', 17: 'ADPCM', 49: 'GSM' };
const SLICEABLE = [1, 3, 6, 7];  // fixed bytes per frame, so any whole-frame slice is valid audio
async function wavInfo(file) {
  const v = new DataView(await file.slice(0, 1 << 20).arrayBuffer()), tag = o => String.fromCharCode(...new Uint8Array(v.buffer, o, 4));
  if (v.byteLength < 12 || !['RIFF', 'RF64'].includes(tag(0)) || tag(8) !== 'WAVE') return null;
  let o = 12, fmt = null;
  while (o + 8 <= v.byteLength) {
    const id = tag(o), size = v.getUint32(o + 4, true);
    if (id === 'fmt ' && o + 8 + size <= v.byteLength) {
      let code = v.getUint16(o + 8, true);
      if (code === 0xfffe && size >= 26) code = v.getUint16(o + 32, true);   // WAVE_FORMAT_EXTENSIBLE: real format in the sub-format GUID
      fmt = { code, nch: v.getUint16(o + 10, true), rate: v.getUint32(o + 12, true), align: v.getUint16(o + 20, true), bits: v.getUint16(o + 22, true),
        fmtChunk: new Uint8Array(v.buffer.slice(o, o + 8 + size + (size & 1))) };
    } else if (id === 'data' && fmt) {
      const bytes = size === 0xffffffff || o + 8 + size > file.size ? file.size - o - 8 : size;   // RF64 or unknown size: to end of file
      const ok = fmt.align > 0 && fmt.rate > 0 && SLICEABLE.includes(fmt.code);
      return { ...fmt, dataOffset: o + 8, frames: ok ? Math.floor(bytes / fmt.align) : 0, duration: ok ? Math.floor(bytes / fmt.align) / fmt.rate : null };
    }
    o += 8 + size + (size & 1);
  }
  return fmt && { ...fmt, frames: 0, duration: null };
}
// a small WAV file holding frames p0..p1 of the original
function wavPiece(w, file, p0, p1) {
  const h = new Uint8Array(20 + w.fmtChunk.length), d = new DataView(h.buffer), put = (o, t) => [...t].forEach((c, i) => { h[o + i] = c.charCodeAt(0); });
  const bytes = (p1 - p0) * w.align;
  put(0, 'RIFF'); d.setUint32(4, h.length - 8 + bytes, true); put(8, 'WAVE');
  h.set(w.fmtChunk, 12); put(12 + w.fmtChunk.length, 'data'); d.setUint32(16 + w.fmtChunk.length, bytes, true);
  return new Blob([h, file.slice(w.dataOffset + p0 * w.align, w.dataOffset + p1 * w.align)]);
}
const describe = w => [w.duration ? fmtTime(w.duration) : 'length unknown', `${w.rate / 1000} kHz`,
  [1, 3].includes(w.code) ? `${w.bits}-bit${w.code === 3 ? ' float' : ''}` : CODECS[w.code] || `format ${w.code}`,
  w.nch === 1 ? 'mono' : w.nch === 2 ? 'stereo' : `${w.nch} channels`].join(' · ');

function add(fileList) {
  for (const file of fileList) {
    const it = { id: ++seq, file, base: file.name.replace(/\.[^.]+$/, '') || 'audio', duration: null, url: null, state: 'reading' };
    it.el = row(it);
    $('files').append(it.el);
    items.push(it);
    wavInfo(file).catch(() => null).then(w => {
      if (!w) q(it, '.dur').textContent = 'Not a WAV file we can read the header of';
      else {
        it.duration = w.duration;
        it.wav = w;
        q(it, '.dur').textContent = describe(w) + (w.duration > LONG_SECONDS ? ' · long file: converting takes several minutes' : '');
        if (w.duration) q(it, '[data-f=end]').value = w.duration.toFixed(1);
      }
      setState(it, 'ready');
    });
  }
  refresh();
}

const q = (it, sel) => it.el.querySelector(sel);

function row(it) {
  const li = document.createElement('li');
  li.innerHTML = `
    <div class="fname"><b></b><span class="dur">Reading…</span></div>
    <div class="trim">
      <label>Start (s) <input data-f="start" type="number" min="0" step="0.1" value="0" inputmode="decimal"></label>
      <label>End (s) <input data-f="end" type="number" min="0" step="0.1" inputmode="decimal"></label>
    </div>
    <p class="st" role="status"></p>
    <div class="acts">
      <button class="btn small" type="button" data-act="go">Convert</button>
      <a class="btn small" data-act="dl" hidden>Download</a>
      <button class="btn ghost small icon" type="button" data-act="rm" aria-label="Remove file">✕</button>
    </div>`;
  li.querySelector('b').textContent = it.file.name;
  li.querySelector('[data-act=go]').onclick = () => run([it]);
  li.querySelector('[data-act=rm]').onclick = () => {
    if (it.state === 'working') return;
    if (it.url) URL.revokeObjectURL(it.url);
    li.remove();
    items = items.filter(x => x !== it);
    refresh();
  };
  li.querySelectorAll('input').forEach(inp => inp.addEventListener('change', () => outdated(it)));
  return li;
}

function setState(it, state, text = '') {
  it.state = state;
  q(it, '.st').textContent = text;
  q(it, '.st').dataset.state = state;
  q(it, '[data-act=go]').hidden = state === 'done';
  q(it, '[data-act=go]').disabled = state === 'working' || state === 'reading' || busy;
  q(it, '[data-act=dl]').hidden = state !== 'done';
  refresh();
}

function outdated(it) {
  if (it.state !== 'done') return;
  URL.revokeObjectURL(it.url);
  it.url = null;
  setState(it, 'ready', 'Settings changed. Convert again to get a file with the new settings.');
}

function refresh() {
  const pending = items.filter(i => i.state === 'ready' || i.state === 'error').length;
  $('all').disabled = busy || !pending;
  $('all').textContent = busy ? 'Converting…' : pending > 1 ? `Convert ${pending} files` : 'Convert';
  $('list').hidden = !items.length;
  for (const it of items) if (q(it, '[data-act=go]')) q(it, '[data-act=go]').disabled = busy || it.state === 'reading';
}

// Frames i0..i1 of the decoded channels -> output channels. More than two channels are first mixed down to stereo.
function channelsOf(buf, mode, i0, i1) {
  let ch = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c).slice(i0, i1));
  if (ch.length > 2) {
    const n = ch[0].length, L = new Float32Array(n), R = new Float32Array(n), k = Math.ceil(ch.length / 2);
    ch.forEach((d, c) => { const t = c % 2 ? R : L; for (let i = 0; i < n; i++) t[i] += d[i] / k; });
    ch = [L, R];
  }
  if (mode === 'mono' && ch.length === 2) {
    const [L, R] = ch;
    for (let i = 0; i < L.length; i++) L[i] = (L[i] + R[i]) / 2;
    return [L];
  }
  if (mode === 'stereo' && ch.length === 1) return [ch[0], ch[0].slice()];
  return ch;
}

const gcd = (x, y) => y ? gcd(y, x % y) : x;
const decode = (bytes, rate) => new OfflineAudioContext(2, 1, rate).decodeAudioData(bytes).catch(() => null);
function decodeError(w) {
  if (w && !([1, 6, 7].includes(w.code) || (w.code === 3 && w.bits === 32))) return new Error(`Your browser couldn't decode this file. The file uses ${w.code === 3 ? `${w.bits}-bit float` : CODECS[w.code] || `format ${w.code}`} audio, which the browser we tested with couldn't decode either.`);
  return new Error("Your browser couldn't decode this file. It may be damaged or not a WAV file.");
}
const SEG_SECONDS = 30, PAD_SECONDS = 0.5;

async function convert(it) {
  const s = settings(), w = it.wav, rate = s.rate;
  const start = Math.max(0, +q(it, '[data-f=start]').value || 0);
  const endIn = q(it, '[data-f=end]').value;
  setState(it, 'working', 'Decoding…');
  // Readable PCM WAVs are decoded 30 s at a time, so memory use doesn't grow with the file.
  // Other files are decoded whole, which needs memory for the full file.
  const sliced = !!(w && w.frames), whole = sliced ? null : await decode(await it.file.arrayBuffer(), rate);
  if (!sliced && !whole) throw decodeError(w);
  const duration = sliced ? w.duration : whole.duration;
  const end = endIn === '' ? duration : Math.min(duration, +endIn);
  if (!(end - start > 0.05)) throw new Error('End must be after start.');
  const a = Math.round(start * rate), b = Math.round(end * rate), seconds = (b - a) / rate;
  // Piece edges sit where source and output frame positions are both whole numbers, and each piece is decoded
  // with 0.5 s extra on both sides that is then cut off, so the resampled pieces join without a seam.
  const rs = sliced ? w.rate : rate, g = gcd(rs, rate), U = rs / g, V = rate / g;
  const T = V * Math.ceil(SEG_SECONDS * rate / V), pad = U * Math.ceil(PAD_SECONDS * rs / U);
  let nch = 0;
  for (let t0 = Math.floor(a / V) * V; t0 < b; t0 += T) {
    q(it, '.st').textContent = `Converting ${Math.round(Math.max(0, t0 - a) / (b - a) * 100)}%`;
    let buf = whole, base = 0;               // base: output frame number of buf's first frame
    if (sliced) {
      const p0 = Math.max(0, t0 / V * U - pad), p1 = Math.min(w.frames, (t0 + T) / V * U + pad);
      if (p0 >= p1) break;
      buf = await decode(await wavPiece(w, it.file, p0, p1).arrayBuffer(), rate);
      if (!buf) throw decodeError(w);
      base = p0 / U * V;
    }
    const lo = Math.max(t0, a) - base, hi = Math.min(t0 + T, b) - base;
    if (lo >= buf.length) break;
    const chunk = channelsOf(buf, s.channels, lo, hi);
    buf = null;
    if (!nch) { nch = chunk.length; worker.postMessage({ id: it.id, type: 'start', nch, rate, format: s.format, kbps: s.kbps, gain: s.gain }); }
    await ask({ id: it.id, type: 'chunk', channels: chunk }, chunk.map(c => c.buffer));
  }
  const blob = await ask({ id: it.id, type: 'end' });
  const ext = s.format === 'mp3' ? 'mp3' : 'wav';
  it.url = URL.createObjectURL(blob);
  const dl = q(it, '[data-act=dl]');
  dl.href = it.url;
  dl.download = `${it.base}.${ext}`;
  dl.textContent = `Download ${ext.toUpperCase()}`;
  const desc = s.format === 'mp3' ? `MP3 ${s.kbps} kbps` : 'WAV 16-bit';
  setState(it, 'done', `${desc}, ${s.rate / 1000} kHz, ${nch === 1 ? 'mono' : 'stereo'}, ${fmtTime(seconds)}, ${fmtSize(blob.size)}`);
}

async function run(list) {
  if (busy) return;
  busy = true;
  refresh();
  for (const it of list) {
    if (!items.includes(it) || it.state === 'done') continue;
    try { await convert(it); }
    catch (e) { setState(it, 'error', e.message); }
  }
  busy = false;
  items.forEach(it => setState(it, it.state, q(it, '.st').textContent));
}

// settings: the bitrate list only offers what lamejs encodes exactly at the chosen sample rate and channels
let wantedKbps = 192;             // the visitor's last own choice, restored when a sample rate allows it again
function syncBitrates() {
  const allowed = KBPS[$('rate').value][$('channels').value === 'mono' ? 'mono' : 'stereo'], sel = $('bitrate'), cur = wantedKbps;
  const pick = allowed.includes(cur) ? cur : allowed.reduce((x, y) => Math.abs(y - cur) < Math.abs(x - cur) ? y : x);
  sel.replaceChildren(...allowed.map(k => new Option(`${k} kbps`, k, false, k === pick)));
}
function syncSettings() {
  $('bitrate').disabled = $('format').value !== 'mp3';
  $('volumeV').textContent = `${$('volume').value}%`;
  $('volNote').textContent = +$('volume').value > 100 ? 'Above 100%, loud parts can clip.' : '';
}
['rate', 'channels'].forEach(id => $(id).addEventListener('change', syncBitrates));
$('bitrate').addEventListener('change', () => { wantedKbps = +$('bitrate').value; });
['format', 'bitrate', 'rate', 'channels'].forEach(id => $(id).addEventListener('change', () => { syncSettings(); items.forEach(outdated); }));
$('volume').addEventListener('input', syncSettings);
$('volume').addEventListener('change', () => items.forEach(outdated));
syncBitrates();
syncSettings();

$('file').addEventListener('change', e => { add(e.target.files); e.target.value = ''; });
const drop = $('drop');
['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => add(e.dataTransfer.files));
$('all').addEventListener('click', () => run(items.filter(i => i.state === 'ready' || i.state === 'error')));
