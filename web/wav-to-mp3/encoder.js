'use strict';
// Web Worker: encodes PCM to MP3 (lamejs) or 16-bit WAV in the visitor's browser. No network.
// The page sends audio in chunks (start, chunk..., end) so long files don't need full-length copies.
importScripts('../lame.min.js');

const jobs = new Map();

function toI16(f, gain) {
  const o = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) { const v = Math.max(-1, Math.min(1, f[i] * gain)); o[i] = v < 0 ? v * 32768 : v * 32767; }
  return o;
}

function wavHeader(nch, rate, frames) {
  const b = new DataView(new ArrayBuffer(44)), w = (o, s) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); b.setUint32(4, 36 + frames * nch * 2, true); w(8, 'WAVEfmt '); b.setUint32(16, 16, true);
  b.setUint16(20, 1, true); b.setUint16(22, nch, true); b.setUint32(24, rate, true); b.setUint32(28, rate * nch * 2, true);
  b.setUint16(32, nch * 2, true); b.setUint16(34, 16, true); w(36, 'data'); b.setUint32(40, frames * nch * 2, true);
  return b.buffer;
}

onmessage = ({ data: m }) => {
  try {
    if (m.type === 'start') {
      const j = { ...m, parts: [] };
      if (m.format === 'mp3') j.enc = new lamejs.Mp3Encoder(m.nch, m.rate, m.kbps);
      else { j.parts.push(null); j.frames = 0; }        // WAV header goes in at the end, when the frame count is known
      jobs.set(m.id, j);
    } else if (m.type === 'chunk') {
      const j = jobs.get(m.id), pcm = m.channels.map(c => toI16(c, j.gain));
      if (j.enc) {
        for (let i = 0; i < pcm[0].length; i += 1152 * 20) {
          const out = pcm.length === 1 ? j.enc.encodeBuffer(pcm[0].subarray(i, i + 1152 * 20)) : j.enc.encodeBuffer(pcm[0].subarray(i, i + 1152 * 20), pcm[1].subarray(i, i + 1152 * 20));
          if (out.length) j.parts.push(out);
        }
      } else {
        const n = pcm[0].length, inter = new Int16Array(n * pcm.length);
        for (let i = 0, o = 0; i < n; i++) for (let c = 0; c < pcm.length; c++) inter[o++] = pcm[c][i];
        j.parts.push(inter.buffer);
        j.frames += n;
      }
      postMessage({ id: m.id, ack: true });
    } else if (m.type === 'end') {
      const j = jobs.get(m.id);
      jobs.delete(m.id);
      if (j.enc) j.parts.push(j.enc.flush());
      else j.parts[0] = wavHeader(j.nch, j.rate, j.frames);
      postMessage({ id: m.id, blob: new Blob(j.parts, { type: j.enc ? 'audio/mpeg' : 'audio/wav' }) });
    }
  } catch (e) {
    jobs.delete(m.id);
    postMessage({ id: m.id, error: String(e && e.message || e) });
  }
};
