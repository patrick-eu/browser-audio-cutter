#!/usr/bin/env node
// Check that an exported WAV is exactly a slice of a source WAV (16-bit PCM, same rate).
//   node tools/wav-compare.mjs source.wav cut.wav <startSeconds> [toleranceLSB=1]
// Mono cut channels are compared against source channel 0; extra source channels are ignored.
import fs from 'node:fs';

const [srcPath, cutPath, startArg, tolArg = '1'] = process.argv.slice(2);
if (!srcPath || !cutPath || startArg === undefined) {
  console.error('usage: node tools/wav-compare.mjs <source.wav> <cut.wav> <startSeconds> [toleranceLSB]');
  process.exit(1);
}
function read(path) {
  const b = fs.readFileSync(path);
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') throw new Error(`${path}: not a WAV file`);
  let o = 12, fmt, data;
  while (o + 8 <= b.length) {                       // walk chunks instead of assuming a 44-byte header
    const id = b.toString('latin1', o, o + 4), size = b.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = { channels: b.readUInt16LE(o + 10), rate: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
    if (id === 'data') data = { offset: o + 8, size };
    o += 8 + size + (size % 2);
  }
  if (!fmt || !data || fmt.bits !== 16) throw new Error(`${path}: need 16-bit PCM with fmt and data chunks`);
  const frames = Math.floor(data.size / (fmt.channels * 2));
  return { ...fmt, frames, sample: (i, c) => b.readInt16LE(data.offset + (i * fmt.channels + c) * 2) };
}
const src = read(srcPath), cut = read(cutPath);
if (src.rate !== cut.rate) { console.error(`sample rates differ: ${src.rate} vs ${cut.rate}`); process.exit(2); }
const first = Math.round(Number(startArg) * src.rate), tol = Number(tolArg);
let bad = 0, maxDiff = 0;
for (let i = 0; i < cut.frames; i++) {
  for (let c = 0; c < cut.channels; c++) {
    const d = Math.abs(cut.sample(i, c) - src.sample(first + i, Math.min(c, src.channels - 1)));
    if (d > tol) bad++;
    if (d > maxDiff) maxDiff = d;
  }
}
const ok = bad === 0 && first + cut.frames <= src.frames;
console.log(JSON.stringify({ firstSourceSample: first, frames: cut.frames, channels: cut.channels, samplesOverTolerance: bad, maxDiff, ok }));
process.exit(ok ? 0 : 4);
