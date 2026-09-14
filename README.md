# browser-audio-cutter

Cut and join audio files entirely in the browser. No uploads, no server code, no build step.

The same code runs at [snipaudio.com](https://snipaudio.com/).

## What's inside

| Path | What it is |
|---|---|
| [`web/index.html`](web/index.html), [`web/app.js`](web/app.js) | Audio cutter: waveform, draggable start/end markers, millisecond time inputs, fade in/out, several regions each exported on its own, MP3 or WAV export |
| [`web/audio-joiner/`](web/audio-joiner/) | Audio joiner: put clips in order (drag or arrow buttons), per-clip fades, crossfade between clips, preview, export one MP3 or WAV |
| [`web/bpm-finder/`](web/bpm-finder/) | BPM finder: tempo and key of a song worked out in the browser (own FFT, onset autocorrelation, key-profile matching in a Web Worker), both half-time and double-time readings, a click track to check the beat by ear, tap tempo |
| [`web/m4a-to-mp3/`](web/m4a-to-mp3/) | M4A to MP3 converter: decodes AAC M4A in the browser, encodes MP3 (128–320 kbps) or WAV at 44.1 or 48 kHz in a Web Worker, sending audio in 10-second chunks; volume, per-file trim, several files at once |
| [`web/mp3-to-wav/`](web/mp3-to-wav/) | MP3 to WAV converter: reads the MP3 frame header for its sample rate and channels, decodes in the browser, writes 16-bit PCM, 24-bit PCM or 32-bit float WAV in a Web Worker; refuses outputs over the 4 GB WAV limit before decoding |
| [`web/wav-to-mp3/`](web/wav-to-mp3/) | WAV to MP3 converter: reads the WAV header, decodes PCM WAVs 30 seconds at a time (with overlap so resampled pieces join without a seam), encodes MP3 with lamejs in a Web Worker; bitrate choices limited to what lamejs encodes exactly at each sample rate and channel count |
| [`tools/`](tools/) | Node scripts for testing audio tools: predictable test WAVs, sample-by-sample WAV comparison, MP3 header reader, lamejs sample-rate probe |
| [`data/`](data/) | Measured lamejs output sample rates, and a dated feature audit of the top 10 results for "audio cutter" |
| [`docs/`](docs/) | Notes on the measurements and on how the audit was made |

## Run it locally

```bash
cd web
python3 -m http.server 8000
# open http://localhost:8000/, /audio-joiner/, /bpm-finder/, /m4a-to-mp3/, /mp3-to-wav/ and /wav-to-mp3/
```

Any static file server works. There is nothing to install or build.

## How it works

- **Decoding:** `new OfflineAudioContext(2, 1, 44100).decodeAudioData(buffer)`. The browser decodes the file and resamples it to 44.1 kHz. Mono stays mono, stereo stays stereo, wider layouts are downmixed to stereo. Which input formats work depends on the browser; MP3 and WAV were tested.
- **Cutting:** a region is the sample range `Math.round(start * 44100)` to `Math.round(end * 44100)` of each channel.
- **Fades and crossfades:** linear gain ramps. In a crossfade the outgoing clip's gain is `(x - k) / x` and the incoming clip's is `k / x`, so they always sum to 1.
- **WAV export:** a small 16-bit PCM writer in plain JavaScript.
- **MP3 export:** [lamejs](https://github.com/zhuker/lamejs) at 128, 192, 256 or 320 kbps. Lower bitrates are not offered because lamejs resamples them (see [`docs/lamejs-browser-notes.md`](docs/lamejs-browser-notes.md)).
- **Privacy:** files never leave the page. The only network requests are for the page's own HTML and scripts.

## Testing tools

```bash
node tools/make-test-wav.mjs saw saw.wav 10 2          # every sample predictable
node tools/wav-compare.mjs saw.wav cut.wav 1.234       # is cut.wav exactly saw.wav from 1.234 s?
node tools/mp3-header.mjs cut.mp3                      # bitrate, sample rate, channel mode of frame 1
node tools/lamejs-samplerate.mjs                       # reproduce data/lamejs-output-sample-rate.csv
```

Tested with Node.js 20. The scripts have no dependencies.

## Known limits

- MP3 files begin with a short encoder delay (about 25 ms measured); WAV is sample-exact.
- Export formats are MP3 and WAV only.
- One file at a time in the cutter; no batch processing.
- The whole decoded audio is kept in memory, so very long files need more memory.

## License

The code in this repository is released under the [MIT License](LICENSE), except [`web/lame.min.js`](web/lame.min.js), which is the unmodified lamejs build distributed under the LGPL 3.0 ([`web/LICENSE-lamejs.txt`](web/LICENSE-lamejs.txt)).

The feature audit in `data/` records what third-party pages stated on 2026-09-14; product names belong to their owners.
