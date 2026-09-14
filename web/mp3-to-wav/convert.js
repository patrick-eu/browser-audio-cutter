'use strict';
const $ = id => document.getElementById(id);
const worker = new Worker('wav-writer.js');
const jobs = new Map();          // id -> { resolve, reject, progress }
worker.onmessage = ({ data }) => {
  const j = jobs.get(data.id);
  if (!j) return;
  jobs.delete(data.id);
  data.error ? j.reject(new Error(data.error)) : j.resolve(data.blob);
};
const ask = (msg, transfer) => new Promise((resolve, reject) => { jobs.set(msg.id, { resolve, reject }); worker.postMessage(msg, transfer); });
const CHUNK_SECONDS = 10;

let items = [];                  // { id, file, base, duration, src: {rate, nch} | null, el, url, state }
let seq = 0, busy = false;
const fmtTime = s => { const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`; };
const fmtSize = b => b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
const settings = () => ({ bits: +$('bits').value, rate: $('rate').value, gain: +$('volume').value / 100 });
const MAX_WAV_BYTES = 4294967295 - 58;   // RIFF sizes are 32-bit

// Sample rate and channel count from the first MP3 frame header (after an ID3v2 tag), checked against the next frame.
async function probeMp3(file) {
  const h = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  const skip = h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33 ? 10 + ((h[6] & 127) << 21 | (h[7] & 127) << 14 | (h[8] & 127) << 7 | (h[9] & 127)) + (h[5] & 16 ? 10 : 0) : 0;
  const u = new Uint8Array(await file.slice(skip, skip + (1 << 16)).arrayBuffer());   // ID3v2 tags (cover art) can be large
  const i = 0;
  const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  const KBPS1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], KBPS2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const parse = j => {
    if (j + 4 > u.length || u[j] !== 0xff || (u[j + 1] & 0xe0) !== 0xe0) return null;
    const ver = (u[j + 1] >> 3) & 3, layer = (u[j + 1] >> 1) & 3, br = u[j + 2] >> 4, sr = (u[j + 2] >> 2) & 3, pad = (u[j + 2] >> 1) & 1;
    if (ver === 1 || layer !== 1 || br === 0 || br === 15 || sr === 3) return null;   // MPEG audio layer III only
    const rate = RATES[ver][sr], kbps = (ver === 3 ? KBPS1 : KBPS2)[br];
    return { rate, nch: (u[j + 3] >> 6) === 3 ? 1 : 2, len: Math.floor((ver === 3 ? 144000 : 72000) * kbps / rate) + pad };
  };
  for (let j = i; j < u.length - 4; j++) {
    const a = parse(j);
    if (a && a.len > 4) { const b = parse(j + a.len); if (b && b.rate === a.rate) return { rate: a.rate, nch: a.nch }; }
  }
  return null;
}
const outRate = it => settings().rate === 'source' ? (it.src ? it.src.rate : 44100) : +settings().rate;

function add(fileList) {
  for (const file of fileList) {
    const it = { id: ++seq, file, base: file.name.replace(/\.[^.]+$/, '') || 'audio', duration: null, src: null, url: null, state: 'reading' };
    it.el = row(it);
    $('files').append(it.el);
    items.push(it);
    const a = new Audio(), src = URL.createObjectURL(file);
    const meta = new Promise(res => {
      a.preload = 'metadata';
      a.onloadedmetadata = () => { URL.revokeObjectURL(src); res(isFinite(a.duration) ? a.duration : null); };
      a.onerror = () => { URL.revokeObjectURL(src); res(null); };
      a.src = src;
    });
    Promise.all([meta, probeMp3(file).catch(() => null)]).then(([duration, info]) => {
      it.duration = duration;
      it.src = info;
      if (duration) q(it, '[data-f=end]').value = duration.toFixed(1);
      describe(it);
      setState(it, 'ready');
    });
  }
  refresh();
}

const q = (it, sel) => it.el.querySelector(sel);

function wavBytes(it) {
  const s = settings(), nch = it.src ? it.src.nch : 2;
  const start = Math.max(0, +q(it, '[data-f=start]').value || 0), endIn = q(it, '[data-f=end]').value;
  const end = endIn === '' ? it.duration : Math.min(it.duration, +endIn);
  return it.duration ? (s.bits === 32 ? 58 : 44) + Math.round(Math.max(0, end - start) * outRate(it)) * nch * s.bits / 8 : null;
}

function describe(it) {
  const parts = [it.duration ? fmtTime(it.duration) : 'length unknown'];
  parts.push(it.src ? `MP3 ${it.src.rate / 1000} kHz ${it.src.nch === 1 ? 'mono' : 'stereo'}` : 'MP3 details unknown');
  const bytes = wavBytes(it);
  if (bytes) parts.push(`WAV about ${fmtSize(bytes)}${it.src ? '' : ' if stereo'}`);
  if (it.duration > 1800) parts.push('long file: converting can take several minutes, and very long files can run out of memory');
  q(it, '.dur').textContent = parts.join(' · ');
}

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
  li.querySelectorAll('input').forEach(inp => inp.addEventListener('change', () => { outdated(it); describe(it); }));
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

function channelsOf(buf) {
  if (buf.numberOfChannels <= 2) return Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  const L = new Float32Array(buf.length), R = new Float32Array(buf.length), k = Math.ceil(buf.numberOfChannels / 2);
  for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c), t = c % 2 ? R : L; for (let i = 0; i < d.length; i++) t[i] += d[i] / k; }
  return [L, R];
}

async function convert(it) {
  const s = settings();
  const rate = outRate(it);
  const start = Math.max(0, +q(it, '[data-f=start]').value || 0);
  const endIn = q(it, '[data-f=end]').value;
  const est = wavBytes(it);
  if (est && est > MAX_WAV_BYTES) throw new Error('This WAV would be larger than 4 GB, which the WAV format cannot hold. Use a lower sample rate or bit depth, or trim the file.');
  setState(it, 'working', 'Decoding…');
  let buf;
  try { buf = await new OfflineAudioContext(2, 1, rate).decodeAudioData(await it.file.arrayBuffer()); }
  catch { throw new Error("Your browser couldn't decode this file." + (it.duration > 1800 ? ' Long files can fail here when the decoded audio does not fit in memory. A lower sample rate needs less.' : '')); }
  const end = endIn === '' ? buf.duration : Math.min(buf.duration, +endIn);
  if (!(end - start > 0.05)) throw new Error('End must be after start.');
  const a = Math.round(start * rate), b = Math.round(end * rate);
  const src = channelsOf(buf), nch = src.length, frames = b - a, step = CHUNK_SECONDS * rate;
  buf = null;
  if ((s.bits === 32 ? 58 : 44) + frames * nch * s.bits / 8 > MAX_WAV_BYTES) throw new Error('This WAV would be larger than 4 GB, which the WAV format cannot hold. Use a lower sample rate or bit depth, or trim the file.');
  // send the audio in chunks and wait for each to be written, so no second full-length copy is ever held
  worker.postMessage({ id: it.id, type: 'start', nch, rate, bits: s.bits, gain: s.gain, frames });
  for (let off = a; off < b; off += step) {
    q(it, '.st').textContent = `Writing WAV ${Math.round((off - a) / frames * 100)}%`;
    const chunk = src.map(c => c.slice(off, Math.min(off + step, b)));
    await ask({ id: it.id, type: 'chunk', channels: chunk }, chunk.map(c => c.buffer));
  }
  const blob = await ask({ id: it.id, type: 'end' });
  it.url = URL.createObjectURL(blob);
  const dl = q(it, '[data-act=dl]');
  dl.href = it.url;
  dl.download = `${it.base}.wav`;
  dl.textContent = 'Download WAV';
  const depth = s.bits === 32 ? '32-bit float' : `${s.bits}-bit`;
  setState(it, 'done', `WAV ${depth}, ${rate / 1000} kHz, ${nch === 1 ? 'mono' : 'stereo'}, ${fmtTime(frames / rate)}, ${fmtSize(blob.size)}`);
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
  $('volumeV').textContent = `${$('volume').value}%`;
  $('volNote').textContent = +$('volume').value > 100 ? (+$('bits').value === 32 ? 'Above 100%, samples can go past full scale; 32-bit float keeps them.' : 'Above 100%, loud parts can clip.') : '';
  items.forEach(it => it.state !== 'reading' && describe(it));
}
['bits', 'rate'].forEach(id => $(id).addEventListener('change', () => { syncSettings(); items.forEach(outdated); }));
$('volume').addEventListener('input', syncSettings);
$('volume').addEventListener('change', () => items.forEach(outdated));
syncSettings();

$('file').addEventListener('change', e => { add(e.target.files); e.target.value = ''; });
const drop = $('drop');
['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => add(e.dataTransfer.files));
$('all').addEventListener('click', () => run(items.filter(i => i.state === 'ready' || i.state === 'error')));
