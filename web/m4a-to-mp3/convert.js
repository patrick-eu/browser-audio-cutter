'use strict';
const $ = id => document.getElementById(id);
const worker = new Worker('encoder.js');
const jobs = new Map();          // id -> { resolve, reject, progress }
worker.onmessage = ({ data }) => {
  const j = jobs.get(data.id);
  if (!j) return;
  jobs.delete(data.id);
  data.error ? j.reject(new Error(data.error)) : j.resolve(data.blob);
};
const ask = (msg, transfer) => new Promise((resolve, reject) => { jobs.set(msg.id, { resolve, reject }); worker.postMessage(msg, transfer); });
const CHUNK_SECONDS = 10;

let items = [];                  // { id, file, base, duration, el, url, state }
let seq = 0, busy = false;
const fmtTime = s => { const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`; };
const fmtSize = b => b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
const settings = () => ({ format: $('format').value, kbps: +$('bitrate').value, rate: +$('rate').value, gain: +$('volume').value / 100 });

function add(fileList) {
  for (const file of fileList) {
    const it = { id: ++seq, file, base: file.name.replace(/\.[^.]+$/, '') || 'audio', duration: null, url: null, state: 'reading' };
    it.el = row(it);
    $('files').append(it.el);
    items.push(it);
    const a = new Audio(), src = URL.createObjectURL(file);
    a.preload = 'metadata';
    a.onloadedmetadata = () => {
      URL.revokeObjectURL(src);
      it.duration = isFinite(a.duration) ? a.duration : null;
      q(it, '.dur').textContent = it.duration ? fmtTime(it.duration) + (it.duration > 1800 ? ' · long file: converting can take several minutes, and very long files can run out of memory' : '') : 'length unknown';
      if (it.duration) q(it, '[data-f=end]').value = it.duration.toFixed(1);
      setState(it, 'ready');
    };
    a.onerror = () => { URL.revokeObjectURL(src); setState(it, 'ready'); q(it, '.dur').textContent = 'length unknown'; };
    a.src = src;
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

// Wider than stereo -> stereo. Web Audio channel order is L R C LFE SL SR (quad: L R SL SR): centre goes to both sides at -3 dB,
// LFE is dropped, the other channels alternate left/right at -3 dB, and each side is divided by its total weight so it can't clip.
function toStereo(src) {
  const n = src.length, len = src[0].length, out = [new Float32Array(len), new Float32Array(len)], sum = [0, 0];
  const add = (d, s, w) => { const t = out[s]; sum[s] += w; for (let i = 0; i < len; i++) t[i] += d[i] * w; };
  let k = 0;
  src.forEach((d, c) => {
    if (c < 2) add(d, c, 1);
    else if (c === 2 && n !== 4) { add(d, 0, Math.SQRT1_2); add(d, 1, Math.SQRT1_2); }
    else if (!(c === 3 && n >= 6)) add(d, k++ % 2, Math.SQRT1_2);
  });
  for (let s = 0; s < 2; s++) for (let i = 0; i < len; i++) out[s][i] /= sum[s];
  return out;
}

function channelsOf(buf) {
  if (buf.numberOfChannels <= 2) return Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  return toStereo(Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c)));
}

async function convert(it) {
  const s = settings();
  const start = Math.max(0, +q(it, '[data-f=start]').value || 0);
  const endIn = q(it, '[data-f=end]').value;
  setState(it, 'working', 'Decoding…');
  let buf;
  try { buf = await new OfflineAudioContext(2, 1, s.rate).decodeAudioData(await it.file.arrayBuffer()); }
  catch { throw new Error("Your browser couldn't decode this file."); }
  const end = endIn === '' ? buf.duration : Math.min(buf.duration, +endIn);
  if (!(end - start > 0.05)) throw new Error('End must be after start.');
  const a = Math.round(start * s.rate), b = Math.round(end * s.rate);
  const src = channelsOf(buf), nch = src.length, seconds = (b - a) / s.rate, step = CHUNK_SECONDS * s.rate;
  buf = null;
  // send the audio in chunks and wait for each to be encoded, so no second full-length copy is ever held
  worker.postMessage({ id: it.id, type: 'start', nch, rate: s.rate, format: s.format, kbps: s.kbps, gain: s.gain, frames: b - a });
  for (let off = a; off < b; off += step) {
    q(it, '.st').textContent = `Encoding ${Math.round((off - a) / (b - a) * 100)}%`;
    const chunk = src.map(c => c.slice(off, Math.min(off + step, b)));
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

// settings
function syncSettings() {
  const mp3 = $('format').value === 'mp3';
  $('bitrate').disabled = !mp3;
  $('volumeV').textContent = `${$('volume').value}%`;
  $('volNote').textContent = +$('volume').value > 100 ? 'Above 100%, loud parts can clip.' : '';
}
['format', 'bitrate', 'rate'].forEach(id => $(id).addEventListener('change', () => { syncSettings(); items.forEach(outdated); }));
$('volume').addEventListener('input', syncSettings);
$('volume').addEventListener('change', () => items.forEach(outdated));
syncSettings();

$('file').addEventListener('change', e => { add(e.target.files); e.target.value = ''; });
const drop = $('drop');
['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => add(e.dataTransfer.files));
$('all').addEventListener('click', () => run(items.filter(i => i.state === 'ready' || i.state === 'error')));
