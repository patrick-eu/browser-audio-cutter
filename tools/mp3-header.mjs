#!/usr/bin/env node
// Print the bitrate, sample rate and channel mode of the first MPEG-1 Layer III frame in an MP3.
//   node tools/mp3-header.mjs file.mp3
import fs from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('usage: node tools/mp3-header.mjs <file.mp3>'); process.exit(1); }
const b = fs.readFileSync(file);
let start = 0;
if (b.toString('latin1', 0, 3) === 'ID3') {        // skip an ID3v2 tag (syncsafe size)
  start = 10 + ((b[6] & 0x7f) << 21 | (b[7] & 0x7f) << 14 | (b[8] & 0x7f) << 7 | (b[9] & 0x7f));
}
const i = b.findIndex((v, j) => j >= start && v === 0xff && (b[j + 1] & 0xe0) === 0xe0);
if (i < 0) { console.error('no MPEG frame sync found'); process.exit(2); }
const version = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3;
if (version !== 3 || layer !== 1) { console.error('first frame is not MPEG-1 Layer III'); process.exit(3); }
const kbps = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320][b[i + 2] >> 4];
const sampleRate = [44100, 48000, 32000][(b[i + 2] >> 2) & 3];
const mode = ['stereo', 'joint stereo', 'dual channel', 'mono'][b[i + 3] >> 6];
console.log(JSON.stringify({ file, frameOffset: i, kbps, sampleRate, mode, bytes: b.length }));
