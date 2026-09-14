'use strict';
// Web Worker: writes WAV (16-bit PCM, 24-bit PCM or 32-bit float) in the visitor's browser. No network.
// The page sends audio in chunks (start, chunk..., end) so long files don't need extra full-length copies.
const jobs = new Map();

function header(nch, rate, bits, frames) {
  const float = bits === 32, bytes = bits / 8, data = frames * nch * bytes;
  const size = float ? 58 : 44, b = new DataView(new ArrayBuffer(size));
  const w = (o, s) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); b.setUint32(4, size - 8 + data, true); w(8, 'WAVE');
  w(12, 'fmt '); b.setUint32(16, float ? 18 : 16, true);
  b.setUint16(20, float ? 3 : 1, true);                 // 3 = IEEE float, 1 = PCM
  b.setUint16(22, nch, true); b.setUint32(24, rate, true);
  b.setUint32(28, rate * nch * bytes, true); b.setUint16(32, nch * bytes, true); b.setUint16(34, bits, true);
  let o = 36;
  if (float) { b.setUint16(36, 0, true); w(38, 'fact'); b.setUint32(42, 4, true); b.setUint32(46, frames, true); o = 50; }
  w(o, 'data'); b.setUint32(o + 4, data, true);
  return b.buffer;
}

function interleave(channels, bits, gain) {
  const nch = channels.length, n = channels[0].length, bytes = bits / 8;
  const out = new DataView(new ArrayBuffer(n * nch * bytes));
  for (let i = 0, o = 0; i < n; i++) {
    for (let c = 0; c < nch; c++, o += bytes) {
      const x = channels[c][i] * gain;
      if (bits === 32) out.setFloat32(o, x, true);
      else {
        const v = Math.max(-1, Math.min(1, x));
        if (bits === 16) out.setInt16(o, v < 0 ? v * 32768 : v * 32767, true);
        else { const s = Math.round(v < 0 ? v * 8388608 : v * 8388607); out.setUint8(o, s & 255); out.setUint8(o + 1, (s >> 8) & 255); out.setUint8(o + 2, (s >> 16) & 255); }
      }
    }
  }
  return out.buffer;
}

onmessage = ({ data: m }) => {
  try {
    if (m.type === 'start') jobs.set(m.id, { bits: m.bits, gain: m.gain, parts: [header(m.nch, m.rate, m.bits, m.frames)] });
    else if (m.type === 'chunk') {
      const j = jobs.get(m.id);
      j.parts.push(interleave(m.channels, j.bits, j.gain));
      postMessage({ id: m.id, ack: true });
    } else if (m.type === 'end') {
      const j = jobs.get(m.id);
      jobs.delete(m.id);
      postMessage({ id: m.id, blob: new Blob(j.parts, { type: 'audio/wav' }) });
    }
  } catch (e) {
    jobs.delete(m.id);
    postMessage({ id: m.id, error: String(e && e.message || e) });
  }
};
