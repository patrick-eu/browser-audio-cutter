#!/usr/bin/env node
// Encode 2 s of a test tone with the bundled lamejs (web/lame.min.js) at every MPEG-1 bitrate
// and report the sample rate written into the first frame header. Prints CSV.
//   node tools/lamejs-samplerate.mjs > data/lamejs-output-sample-rate.csv
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const libPath = fileURLToPath(new URL('../web/lame.min.js', import.meta.url));
const ctx = {};
vm.runInNewContext(fs.readFileSync(libPath, 'utf8') + '\nthis.lamejs = lamejs;', ctx);
const { lamejs } = ctx;

const inputRate = 44100, n = inputRate * 2;
const tone = Int16Array.from({ length: n }, (_, i) => Math.round(Math.sin(2 * Math.PI * 440 * i / inputRate) * 8000));
const kbpsTable = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];      // MPEG-1 Layer III
const kbpsTableLsf = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];     // MPEG-2 / 2.5 Layer III
const srTable = [44100, 48000, 32000];

console.log('channels,requested_kbps,header_mpeg_version,header_kbps,input_sample_rate,output_sample_rate');
for (const channels of [1, 2]) {
  for (const kbps of [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]) {
    const enc = new lamejs.Mp3Encoder(channels, inputRate, kbps);
    const parts = [channels === 1 ? enc.encodeBuffer(tone) : enc.encodeBuffer(tone, tone), enc.flush()];
    const b = Buffer.concat(parts.map(p => Buffer.from(p.buffer, p.byteOffset, p.length)));
    const i = b.findIndex((v, j) => v === 0xff && (b[j + 1] & 0xe0) === 0xe0);
    const version = (b[i + 1] >> 3) & 3;                 // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
    const base = { 3: 1, 2: 2, 0: 4 }[version];
    const sr = srTable[(b[i + 2] >> 2) & 3] / base;
    const hk = (version === 3 ? kbpsTable : kbpsTableLsf)[b[i + 2] >> 4];
    const ver = { 3: '1', 2: '2', 0: '2.5' }[version];
    console.log(`${channels},${kbps},${ver},${hk},${inputRate},${sr}`);
  }
}
