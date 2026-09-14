'use strict';
const $ = id => document.getElementById(id);
const RATE = 44100;              // decode + export rate (lamejs supports 44.1 kHz)
const FADE = () => [+$('fadeIn').value, +$('fadeOut').value];

let audio = null;                // { ch: Float32Array[], len, name }
let regions = [];                // [{ start, end }] in seconds
let active = 0;
let player = null;               // { src, ctx, t0, region }

const fmt = s => { const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(3).padStart(6, '0')}`; };
const dur = () => audio.len / RATE;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const msRound = s => Math.round(s * 1000) / 1000;

async function load(file) {
  if (!file) return;
  stop();
  $('status').textContent = 'Decoding audio…';
  try {
    const buf = await file.arrayBuffer();
    let dec;
    try { dec = await new OfflineAudioContext(2, 1, RATE).decodeAudioData(buf); }
    catch { throw new Error("Your browser couldn't decode this file. Try an MP3 or WAV."); }
    // keep mono as mono, stereo as stereo; downmix anything wider to stereo
    let ch = [];
    if (dec.numberOfChannels === 1) ch = [dec.getChannelData(0)];
    else if (dec.numberOfChannels === 2) ch = [dec.getChannelData(0), dec.getChannelData(1)];
    else {
      ch = [new Float32Array(dec.length), new Float32Array(dec.length)];
      for (let c = 0; c < dec.numberOfChannels; c++) {
        const d = dec.getChannelData(c), t = ch[c % 2];
        for (let i = 0; i < d.length; i++) t[i] += d[i] / Math.ceil(dec.numberOfChannels / 2);
      }
    }
    audio = { ch, len: dec.length, name: file.name.replace(/\.[^.]+$/, '') || 'audio' };
    peaks = null;
    const d = dur();
    regions = [{ start: msRound(d * 0.25), end: msRound(d * 0.75) }];
    active = 0;
    $('filename').textContent = `${file.name} · ${fmt(d)} · ${ch.length === 1 ? 'mono' : 'stereo'}`;
    $('durLabel').textContent = fmt(d);
    $('status').textContent = '';
    $('editor').hidden = false;
    update();
  } catch (e) {
    $('status').textContent = e.message || String(e);
  }
}

// ---------- waveform ----------
let peaks = null, peaksW = 0;
function computePeaks(w) {
  const step = audio.len / w, out = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const a = Math.floor(x * step), b = Math.min(audio.len, Math.floor((x + 1) * step) + 1);
    let m = 0;
    for (const c of audio.ch) for (let i = a; i < b; i += 1) { const v = Math.abs(c[i]); if (v > m) m = v; }
    out[x] = m;
  }
  return out;
}

function draw() {
  const cv = $('wave'), dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const g = cv.getContext('2d'); g.scale(dpr, dpr);
  if (!peaks || peaksW !== w) { peaks = computePeaks(w); peaksW = w; }
  const css = getComputedStyle(document.documentElement), v = k => css.getPropertyValue(k).trim();
  const X = t => t / dur() * w, mid = h / 2;
  regions.forEach((r, i) => { g.fillStyle = v(i === active ? '--sel-active' : '--sel'); g.fillRect(X(r.start), 0, X(r.end) - X(r.start), h); });
  g.fillStyle = v('--wave');
  for (let x = 0; x < w; x++) { const p = peaks[x] * (mid - 4); g.fillRect(x, mid - p, 1, Math.max(1, p * 2)); }
  const [fi, fo] = FADE();
  regions.forEach((r, i) => {
    const [a, b] = fades(r, fi, fo), x0 = X(r.start), x1 = X(r.end);
    // fade envelope
    g.strokeStyle = v('--fade'); g.lineWidth = 2; g.beginPath();
    g.moveTo(x0, h - 2); g.lineTo(X(r.start + a), 2); g.lineTo(X(r.end - b), 2); g.lineTo(x1, h - 2); g.stroke();
    // handles
    g.fillStyle = v('--accent');
    for (const x of [x0, x1]) { g.fillRect(x - 1.5, 0, 3, h); if (i === active) { g.beginPath(); g.arc(x, mid, 9, 0, 7); g.fill(); } }
    g.font = '600 12px system-ui,sans-serif'; g.fillText(String(i + 1), x0 + 5, 14);
  });
  if (player) { g.fillStyle = v('--ink'); g.fillRect(X(player.pos()), 0, 2, h); }
}

// fade lengths actually used for a region (fades can't overlap past the region length)
function fades(r, fi, fo) {
  const L = r.end - r.start;
  if (fi + fo <= L) return [fi, fo];
  const k = L / (fi + fo); return [fi * k, fo * k];
}

// ---------- dragging (mouse + touch via pointer events) ----------
let drag = null;
$('wave').addEventListener('pointerdown', e => {
  if (!audio) return;
  const cv = $('wave'), rect = cv.getBoundingClientRect(), x = e.clientX - rect.left;
  const t = x / rect.width * dur(), tol = (e.pointerType === 'touch' ? 24 : 10) / rect.width * dur();
  let best = null;
  regions.forEach((r, i) => ['start', 'end'].forEach(edge => {
    const d = Math.abs(r[edge] - t);
    if (d <= tol && (!best || d < best.d || (d === best.d && i === active))) best = { i, edge, d };
  }));
  if (best) { active = best.i; drag = best; cv.setPointerCapture(e.pointerId); }
  else { const hit = regions.findIndex(r => t >= r.start && t <= r.end); if (hit >= 0) active = hit; }
  update();
});
$('wave').addEventListener('pointermove', e => {
  if (!drag) return;
  const rect = $('wave').getBoundingClientRect(), r = regions[drag.i];
  const t = msRound(clamp((e.clientX - rect.left) / rect.width * dur(), 0, dur()));
  if (drag.edge === 'start') r.start = Math.min(t, r.end - 0.001); else r.end = Math.max(t, r.start + 0.001);
  update();
});
['pointerup', 'pointercancel'].forEach(t => $('wave').addEventListener(t, () => { drag = null; }));

// ---------- UI sync ----------
function update() {
  const r = regions[active], [fi, fo] = FADE();
  $('start').value = r.start.toFixed(3); $('end').value = r.end.toFixed(3);
  $('start').max = $('end').max = dur().toFixed(3);
  $('len').textContent = `${(r.end - r.start).toFixed(3)} s`;
  $('fadeInV').textContent = `${fi.toFixed(1)} s`; $('fadeOutV').textContent = `${fo.toFixed(1)} s`;
  const mp3 = $('format').value === 'mp3';
  $('bitrate').disabled = !mp3;
  const L = r.end - r.start, nch = audio.ch.length;
  const bytes = mp3 ? +$('bitrate').value * 1000 / 8 * L : 44 + Math.round(L * RATE) * nch * 2;
  $('size').textContent = (mp3 ? '≈ ' : '') + (bytes < 1048576 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1048576).toFixed(2)} MB`);
  $('formatNote').textContent = mp3 ? 'Smaller file. Size shown is an estimate.' : 'Exact samples, larger file. Size shown is exact.';
  // rebuild the list only when regions are added/removed, so a click that follows an input's
  // change event still lands on the same button
  const list = $('regions');
  if (list.children.length !== regions.length) {
    list.innerHTML = '';
    regions.forEach((_, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="label"></span>
        <button class="btn small" type="button" data-act="dl">Download</button>
        <button class="btn small ghost" type="button" data-act="rm" aria-label="Remove region ${i + 1}">Remove</button>`;
      li.querySelector('.label').onclick = () => { active = i; update(); };
      li.querySelector('[data-act=dl]').onclick = e => exportRegion(i, e.currentTarget);
      li.querySelector('[data-act=rm]').onclick = () => { regions.splice(i, 1); active = Math.min(active, regions.length - 1); stop(); update(); };
      list.append(li);
    });
  }
  regions.forEach((g, i) => {
    const li = list.children[i];
    li.className = i === active ? 'active' : '';
    li.querySelector('.label').innerHTML = `<b>Region ${i + 1}</b>${fmt(g.start)} → ${fmt(g.end)} <span class="sub">(${(g.end - g.start).toFixed(3)} s)</span>`;
    li.querySelector('[data-act=rm]').disabled = regions.length === 1;
  });
  draw();
}

function setTime(edge) {
  const r = regions[active], v = msRound(+$(edge).value);
  if (!Number.isFinite(v)) return update();
  if (edge === 'start') r.start = clamp(v, 0, r.end - 0.001); else r.end = clamp(v, r.start + 0.001, dur());
  update();
}
$('start').addEventListener('change', () => setTime('start'));
$('end').addEventListener('change', () => setTime('end'));
['fadeIn', 'fadeOut'].forEach(id => $(id).addEventListener('input', update));
['format', 'bitrate'].forEach(id => $(id).addEventListener('change', update));
$('add').addEventListener('click', () => {
  const last = regions.reduce((m, r) => Math.max(m, r.end), 0), d = dur();
  const len = Math.min(5, d / 4);
  let start = last + 0.5 <= d - 0.01 ? last + 0.5 : 0;
  regions.push({ start: msRound(start), end: msRound(Math.min(d, start + len)) });
  active = regions.length - 1; update();
});

// ---------- render a region (cut + fades) ----------
function render(r) {
  const s0 = Math.round(r.start * RATE), s1 = Math.round(r.end * RATE), n = s1 - s0;
  const [fi, fo] = fades(r, ...FADE()), fin = Math.round(fi * RATE), fout = Math.round(fo * RATE);
  return audio.ch.map(c => {
    const out = c.slice(s0, s1);
    for (let i = 0; i < fin && i < n; i++) out[i] *= i / fin;
    for (let i = 0; i < fout && i < n; i++) out[n - 1 - i] *= i / fout;
    return out;
  });
}

// ---------- playback ----------
function stop() { if (player) { player.src.onended = null; try { player.src.stop(); } catch {} player.ctx.close(); player = null; } $('play').textContent = '▶ Play region'; if (audio) draw(); }
$('play').addEventListener('click', () => {
  if (player) return stop();
  const r = regions[active], data = render(r), ctx = new AudioContext();
  const buf = ctx.createBuffer(data.length, data[0].length, RATE);
  data.forEach((d, i) => buf.copyToChannel(d, i));
  const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination);
  const t0 = ctx.currentTime; src.start();
  player = { src, ctx, pos: () => Math.min(r.end, r.start + (ctx.currentTime - t0)) };
  src.onended = stop;
  $('play').textContent = '■ Stop';
  (function tick() { if (!player) return; draw(); requestAnimationFrame(tick); })();
});

// ---------- export ----------
function toI16(f) { const o = new Int16Array(f.length); for (let i = 0; i < f.length; i++) { const v = Math.max(-1, Math.min(1, f[i])); o[i] = v < 0 ? v * 32768 : v * 32767; } return o; }

function wav(data) {
  const nch = data.length, n = data[0].length, b = new DataView(new ArrayBuffer(44 + n * nch * 2));
  const w = (o, s) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); b.setUint32(4, 36 + n * nch * 2, true); w(8, 'WAVEfmt '); b.setUint32(16, 16, true);
  b.setUint16(20, 1, true); b.setUint16(22, nch, true); b.setUint32(24, RATE, true); b.setUint32(28, RATE * nch * 2, true);
  b.setUint16(32, nch * 2, true); b.setUint16(34, 16, true); w(36, 'data'); b.setUint32(40, n * nch * 2, true);
  const pcm = data.map(toI16);
  for (let i = 0, o = 44; i < n; i++) for (let c = 0; c < nch; c++, o += 2) b.setInt16(o, pcm[c][i], true);
  return new Blob([b.buffer], { type: 'audio/wav' });
}

async function mp3(data, kbps, progress) {
  const pcm = data.map(toI16), enc = new lamejs.Mp3Encoder(pcm.length, RATE, kbps), parts = [], block = 1152 * 20;
  for (let i = 0; i < pcm[0].length; i += block) {
    const chunk = pcm.length === 1 ? enc.encodeBuffer(pcm[0].subarray(i, i + block)) : enc.encodeBuffer(pcm[0].subarray(i, i + block), pcm[1].subarray(i, i + block));
    if (chunk.length) parts.push(chunk);
    if (i % (block * 10) === 0) { progress(i / pcm[0].length); await new Promise(r => setTimeout(r)); }
  }
  parts.push(enc.flush());
  return new Blob(parts, { type: 'audio/mpeg' });
}

async function exportRegion(i, btn) {
  const r = regions[i], isMp3 = $('format').value === 'mp3', label = btn.textContent;
  btn.disabled = true;
  try {
    const data = render(r);
    const blob = isMp3 ? await mp3(data, +$('bitrate').value, p => (btn.textContent = `Encoding ${Math.round(p * 100)}%`)) : wav(data);
    const name = `${audio.name}_${fmt(r.start).replace(/[:.]/g, '-')}_to_${fmt(r.end).replace(/[:.]/g, '-')}.${isMp3 ? 'mp3' : 'wav'}`;
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (e) {
    $('status').textContent = 'Export failed: ' + (e.message || e);
  } finally { btn.disabled = false; btn.textContent = label; }
}

// ---------- file input ----------
$('file').addEventListener('change', e => load(e.target.files[0]));
const drop = $('drop');
['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => load(e.dataTransfer.files[0]));
addEventListener('resize', () => audio && draw());
