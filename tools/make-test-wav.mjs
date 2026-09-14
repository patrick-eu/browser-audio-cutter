#!/usr/bin/env node
// Generate WAV files whose samples you can predict, for testing audio cutters/joiners.
//   node tools/make-test-wav.mjs saw  out.wav [seconds=10] [channels=2]   sawtooth: sample i = (i % 1000) * 16 - 8000 (right channel inverted)
//   node tools/make-test-wav.mjs sine out.wav [seconds=6]  [channels=1] [hz=440]
// Every sawtooth sample differs from its neighbours, so an off-by-one cut is visible in the first sample.
import fs from 'node:fs';

const [kind, out, secs = kind === 'saw' ? '10' : '6', chArg, hzArg] = process.argv.slice(2);
if (!['saw', 'sine'].includes(kind) || !out) {
  console.error('usage: node tools/make-test-wav.mjs <saw|sine> <out.wav> [seconds] [channels] [hz]');
  process.exit(1);
}
const rate = 44100;
const channels = Number(chArg || (kind === 'saw' ? 2 : 1));
const hz = Number(hzArg || 440);
const n = Math.round(rate * Number(secs));
const buf = Buffer.alloc(44 + n * channels * 2);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * channels * 2, 4); buf.write('WAVEfmt ', 8);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(channels, 22);
buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * channels * 2, 28);
buf.writeUInt16LE(channels * 2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * channels * 2, 40);

for (let i = 0, o = 44; i < n; i++) {
  const v = kind === 'saw' ? (i % 1000) * 16 - 8000 : Math.round(Math.sin(2 * Math.PI * hz * i / rate) * 12000);
  for (let c = 0; c < channels; c++, o += 2) buf.writeInt16LE(c % 2 ? -v : v, o);
}
fs.writeFileSync(out, buf);
console.log(`${out}: ${kind}, ${secs} s, ${channels} ch, ${rate} Hz, ${n} samples`);
