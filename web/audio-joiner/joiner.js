'use strict';
// Audio joiner. Decode/WAV/MP3 helpers are copied from the audio cutter's app.js on purpose,
// so this page ships without touching the cutter page.
const $ = id => document.getElementById(id);
const RATE = 44100;
const clips = [];                 // { id, name, ch: Float32Array[], len, fadeIn, fadeOut, row, peaks }
let nextId = 1, player = null;

const fmt = s => { const m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(3).padStart(6, '0')}`; };

// ---------- load ----------
async function addFiles(files) {
  const list = [...files];
  for (const [k, file] of list.entries()) {
    $('status').textContent = `Decoding ${k + 1} of ${list.length}: ${file.name}…`;
    try {
      const dec = await new OfflineAudioContext(2, 1, RATE).decodeAudioData(await file.arrayBuffer());
      let ch;
      if (dec.numberOfChannels === 1) ch = [dec.getChannelData(0)];
      else if (dec.numberOfChannels === 2) ch = [dec.getChannelData(0), dec.getChannelData(1)];
      else {
        ch = [new Float32Array(dec.length), new Float32Array(dec.length)];
        const per = Math.ceil(dec.numberOfChannels / 2);
        for (let c = 0; c < dec.numberOfChannels; c++) { const d = dec.getChannelData(c), t = ch[c % 2]; for (let i = 0; i < d.length; i++) t[i] += d[i] / per; }
      }
      const clip = { id: nextId++, name: file.name, ch, len: dec.length, fadeIn: 0, fadeOut: 0 };
      clip.row = makeRow(clip);
      clips.push(clip);
      $('clips').append(clip.row);
    } catch {
      $('status').textContent = `Your browser couldn't decode ${file.name}. Try an MP3 or WAV.`;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  if (!$('status').textContent.startsWith('Your browser')) $('status').textContent = '';
  $('file').value = '';
  $('editor').hidden = clips.length === 0;
  stop(); update();
}

// ---------- rows ----------
function makeRow(clip) {
  const li = document.createElement('li');
  li.dataset.id = clip.id;
  li.innerHTML = `
    <div class="handle" aria-hidden="true" title="Drag to reorder">☰</div>
    <div class="info"><b></b><span></span></div>
    <div class="moves">
      <button class="btn ghost icon" type="button" data-act="up" aria-label="Move up">↑</button>
      <button class="btn ghost icon" type="button" data-act="down" aria-label="Move down">↓</button>
      <button class="btn ghost icon" type="button" data-act="rm" aria-label="Remove">✕</button>
    </div>
    <div class="fades">
      <label>Fade in <input type="number" min="0" step="0.1" value="0" data-f="fadeIn" inputmode="decimal"> s</label>
      <label>Fade out <input type="number" min="0" step="0.1" value="0" data-f="fadeOut" inputmode="decimal"> s</label>
    </div>`;
  li.querySelector('b').textContent = clip.name;
  li.querySelector('.info span').textContent = `${fmt(clip.len / RATE)} · ${clip.ch.length === 1 ? 'mono' : 'stereo'}`;
  li.querySelector('[data-act=up]').onclick = () => move(clip, -1);
  li.querySelector('[data-act=down]').onclick = () => move(clip, 1);
  li.querySelector('[data-act=rm]').onclick = () => { clips.splice(clips.indexOf(clip), 1); li.remove(); $('editor').hidden = clips.length === 0; stop(); update(); };
  li.querySelectorAll('[data-f]').forEach(inp => inp.addEventListener('input', () => {
    const v = parseFloat(inp.value); clip[inp.dataset.f] = Number.isFinite(v) && v > 0 ? v : 0; update();
  }));
  // pointer-based drag (works for mouse and touch)
  const handle = li.querySelector('.handle');
  // Listeners go on window: moving the row with insertBefore detaches it for a moment,
  // which drops pointer capture, so capture can't be relied on.
  // stop the browser from treating a handle drag as a scroll/tap gesture
  handle.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
  handle.addEventListener('pointerdown', e => {
    e.preventDefault(); li.classList.add('dragging');
    const onMove = ev => {
      if (ev.pointerId !== e.pointerId) return;
      ev.preventDefault();
      const siblings = [...$('clips').children].filter(x => x !== li);
      const target = siblings.find(x => { const r = x.getBoundingClientRect(); return ev.clientY < r.top + r.height / 2; });
      if ((target || null) !== li.nextElementSibling) { $('clips').insertBefore(li, target || null); syncOrder(); }
    };
    const onUp = ev => {
      if (ev.pointerId !== e.pointerId) return;
      li.classList.remove('dragging');
      removeEventListener('pointermove', onMove); removeEventListener('pointerup', onUp); removeEventListener('pointercancel', onUp);
    };
    addEventListener('pointermove', onMove, { passive: false }); addEventListener('pointerup', onUp); addEventListener('pointercancel', onUp);
  });
  return li;
}

function move(clip, dir) {
  const i = clips.indexOf(clip), j = i + dir;
  if (j < 0 || j >= clips.length) return;
  const rows = $('clips');
  if (dir < 0) rows.insertBefore(clip.row, clips[j].row); else rows.insertBefore(clip.row, clips[j].row.nextElementSibling);
  syncOrder();
}

function syncOrder() {
  const byId = new Map(clips.map(c => [String(c.id), c]));
  const order = [...$('clips').children].map(li => byId.get(li.dataset.id));
  clips.splice(0, clips.length, ...order);
  stop(); update();
}

// ---------- layout: sample offsets, per-boundary crossfades ----------
function layout() {
  const want = Math.round(+$('xfade').value * RATE), x = [], off = [];
  for (let i = 0; i + 1 < clips.length; i++) x.push(Math.min(want, Math.floor(clips[i].len / 2), Math.floor(clips[i + 1].len / 2)));
  let pos = 0;
  clips.forEach((c, i) => { off.push(pos); pos += c.len - (x[i] || 0); });
  const total = clips.length ? off[off.length - 1] + clips[clips.length - 1].len : 0;
  return { x, off, total };
}

function ownFades(c) {
  const L = c.len / RATE; let fi = c.fadeIn, fo = c.fadeOut;
  if (fi + fo > L) { const k = L / (fi + fo); fi *= k; fo *= k; }
  return [Math.round(fi * RATE), Math.round(fo * RATE)];
}

// ---------- render the merged track ----------
function render() {
  const { x, off, total } = layout();
  const nch = clips.some(c => c.ch.length === 2) ? 2 : 1;
  const out = Array.from({ length: nch }, () => new Float32Array(total));
  clips.forEach((c, i) => {
    const [fin, fout] = ownFades(c), xin = i > 0 ? x[i - 1] : 0, xout = i < clips.length - 1 ? x[i] : 0, n = c.len;
    for (let o = 0; o < nch; o++) {
      const src = c.ch[Math.min(o, c.ch.length - 1)], dst = out[o], base = off[i];
      for (let j = 0; j < n; j++) {
        let g = 1;
        if (j < fin) g *= j / fin;
        if (n - 1 - j < fout) g *= (n - 1 - j) / fout;
        if (j < xin) g *= j / xin;
        if (n - j <= xout) g *= (n - j) / xout;   // linear crossfade: gains of the two clips sum to 1
        dst[base + j] += src[j] * g;
      }
    }
  });
  return out;
}

// ---------- UI ----------
function update() {
  const { x, total } = layout();
  $('xfadeV').textContent = `${(+$('xfade').value).toFixed(1)} s`;
  $('total').textContent = `${fmt(total / RATE)} total`;
  const mp3 = $('format').value === 'mp3', nch = clips.some(c => c.ch.length === 2) ? 2 : 1;
  $('bitrate').disabled = !mp3;
  const bytes = mp3 ? +$('bitrate').value * 1000 / 8 * total / RATE : 44 + total * nch * 2;
  $('size').textContent = (mp3 ? '≈ ' : '') + (bytes < 1048576 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1048576).toFixed(2)} MB`);
  $('formatNote').textContent = mp3 ? 'Smaller file. Size shown is an estimate.' : 'Uncompressed, larger file. Size shown is exact.';
  const ready = clips.length >= 2;
  $('export').disabled = $('play').disabled = !ready;
  $('needTwo').textContent = ready ? '' : 'Add at least two files to merge.';
  clips.forEach((c, i) => {
    c.row.querySelector('[data-act=up]').disabled = i === 0;
    c.row.querySelector('[data-act=down]').disabled = i === clips.length - 1;
  });
  draw();
}

function draw() {
  const cv = $('timeline'); if (!clips.length) return;
  const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const g = cv.getContext('2d'); g.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement), v = k => css.getPropertyValue(k).trim();
  const { x, off, total } = layout(), X = s => s / Math.max(total, 1) * w, laneH = h / 2;
  clips.forEach((c, i) => {
    const y = i % 2 ? laneH : 0, x0 = X(off[i]), x1 = X(off[i] + c.len), bw = Math.max(1, x1 - x0);
    g.fillStyle = v(i % 2 ? '--laneB' : '--laneA'); g.fillRect(x0, y + 2, bw, laneH - 4);
    // waveform peaks for this block
    const cols = Math.max(1, Math.round(bw)), step = c.len / cols; g.fillStyle = v('--wave');
    for (let k = 0; k < cols; k++) {
      const a = Math.floor(k * step), b = Math.min(c.len, Math.floor((k + 1) * step) + 1); let m = 0;
      for (const d of c.ch) for (let j = a; j < b; j += 4) { const q = Math.abs(d[j]); if (q > m) m = q; }
      const ph = m * (laneH / 2 - 4); g.fillRect(x0 + k, y + laneH / 2 - ph, 1, Math.max(1, ph * 2));
    }
    // own fades + crossfade envelope
    const [fin, fout] = ownFades(c), xin = i > 0 ? x[i - 1] : 0, xout = i < clips.length - 1 ? x[i] : 0;
    const hi = Math.max(fin, xin), ho = Math.max(fout, xout);
    g.strokeStyle = v('--fade'); g.lineWidth = 2; g.beginPath();
    g.moveTo(x0, y + laneH - 3); g.lineTo(X(off[i] + hi), y + 3); g.lineTo(X(off[i] + c.len - ho), y + 3); g.lineTo(x1, y + laneH - 3); g.stroke();
    g.fillStyle = v('--ink'); g.font = '600 12px system-ui,sans-serif'; g.fillText(String(i + 1), x0 + 4, y + 15);
  });
  g.fillStyle = v('--xf');
  x.forEach((n, i) => { if (n) g.fillRect(X(off[i + 1]), 0, X(n), h); });
  if (player) { g.fillStyle = v('--ink'); g.fillRect(X(player.pos() * RATE), 0, 2, h); }
}

// ---------- preview ----------
function stop() { if (player) { player.src.onended = null; try { player.src.stop(); } catch {} player.ctx.close(); player = null; } $('play').textContent = '▶ Preview merged track'; draw(); }
$('play').addEventListener('click', () => {
  if (player) return stop();
  const data = render(), ctx = new AudioContext(), buf = ctx.createBuffer(data.length, data[0].length, RATE);
  data.forEach((d, i) => buf.copyToChannel(d, i));
  const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination);
  const t0 = ctx.currentTime; src.start();
  player = { src, ctx, pos: () => Math.min(buf.duration, ctx.currentTime - t0) };
  src.onended = stop; $('play').textContent = '■ Stop preview';
  (function tick() { if (!player) return; draw(); requestAnimationFrame(tick); })();
});

// ---------- export (same encoders as the audio cutter) ----------
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
$('export').addEventListener('click', async () => {
  const btn = $('export'), isMp3 = $('format').value === 'mp3', label = btn.textContent;
  btn.disabled = true;
  try {
    btn.textContent = 'Merging…'; await new Promise(r => setTimeout(r));
    const data = render();
    const blob = isMp3 ? await mp3(data, +$('bitrate').value, p => (btn.textContent = `Encoding ${Math.round(p * 100)}%`)) : wav(data);
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: `joined-audio.${isMp3 ? 'mp3' : 'wav'}` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (e) { $('status').textContent = 'Merge failed: ' + (e.message || e); }
  finally { btn.textContent = label; update(); }
});

$('file').addEventListener('change', e => addFiles(e.target.files));
const drop = $('drop');
['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => addFiles(e.dataTransfer.files));
$('xfade').addEventListener('input', update);
['format', 'bitrate'].forEach(id => $(id).addEventListener('change', update));
addEventListener('resize', draw);
