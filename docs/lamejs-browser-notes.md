# Measured notes: MP3 export with lamejs in the browser

All numbers below were measured with the `lame.min.js` build included in [`web/`](../web/lame.min.js). Re-run the scripts to reproduce them.

## 1. Low bitrates change the output sample rate

lamejs resamples when the requested bitrate is low, and may switch to MPEG-2 frames. Input was 44.1 kHz in every case.

| Channels | Requested kbps | Output sample rate | MPEG version |
|---|---|---|---|
| mono | 32 / 40 | 22,050 / 24,000 Hz | 2 |
| mono | 48 / 56 | 32,000 Hz | 1 |
| mono | 64 – 320 | 44,100 Hz | 1 |
| stereo | 32 / 40 | 16,000 Hz | 2 |
| stereo | 48 | 22,050 Hz | 2 |
| stereo | 56 / 64 | 24,000 Hz | 2 |
| stereo | 80 / 96 | 32,000 Hz | 1 |
| stereo | 112 – 320 | 44,100 Hz | 1 |

Full table: [`data/lamejs-output-sample-rate.csv`](../data/lamejs-output-sample-rate.csv). Reproduce with:

```bash
node tools/lamejs-samplerate.mjs
```

The cutter and joiner in `web/` only offer 128, 192, 256 and 320 kbps, so their MP3 files are always written at 44.1 kHz.

## 2. MP3 files start with a short silence

A 2.000 s mono sine region exported as MP3 at 192 kbps decoded back (Chromium `decodeAudioData`) to 2.0376 s, and the first sample above 0.02 amplitude appeared 25.1 ms in. The same region exported as WAV decoded to exactly 2.000 s, with the tone above 0.02 within the first two samples. This is encoder delay and padding; choose WAV when the exact cut point matters.

## 3. Checking that a cut is sample-accurate

1. Make a source file where every sample is predictable:
   ```bash
   node tools/make-test-wav.mjs saw saw.wav 10 2
   ```
2. Cut it in the browser, for example from 1.234 s to 3.456 s, and export WAV.
3. Compare the export with the source:
   ```bash
   node tools/wav-compare.mjs saw.wav cut.wav 1.234
   ```
   A correct cut reports `"ok": true` with `maxDiff` of at most 1 (rounding between float and 16-bit). Passing the wrong start time, even by 1 ms, reports `"ok": false`.
4. Check an MP3 export's first frame header:
   ```bash
   node tools/mp3-header.mjs cut.mp3
   ```
