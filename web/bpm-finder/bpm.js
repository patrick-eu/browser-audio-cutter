'use strict';
const $ = id => document.getElementById(id);
const RATE = 44100;
const f1 = b => b.toFixed(1);

let song = null;       // { buffer: AudioBuffer, name }
let tempoRes = null;   // worker tempo result
let pick = 0;          // 0 = main reading, 1 = half/double reading
let play = null;       // { ctx, src, timer }

const TEMPO_CONF = s => s >= 0.6 ? ['strong', 'Strong beat. This tempo stands out clearly from other tempos in the file.']
  : s >= 0.25 ? ['moderate', 'Moderate. Other tempos also fit this file, so check it by ear.']
  : ['weak', 'Weak. No steady beat found, so this number may not mean much.'];
const KEY_CONF = {
  clear: 'Clear. The notes in this file match this key well.',
  weak: 'Weak. Other keys fit the notes almost as well.',
  none: 'No key fits the notes in this file well. In our tests this happened with drum-only tracks and noise.'
};

async function load(file) {
  if (!file) return;
  stopClicks();
  $('result').hidden = true;
  $('drop').classList.add('busy');
  $('status').textContent = 'Decoding audio…';
  try {
    let buffer;
    try { buffer = await new OfflineAudioContext(2, 1, RATE).decodeAudioData(await file.arrayBuffer()); }
    catch { throw new Error("Your browser couldn't decode this file. Try an MP3 or WAV."); }
    $('status').textContent = 'Finding tempo and key…';
    const chans = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
    const { x, sr } = toMono(chans, RATE);   // from analyze.js
    const res = await new Promise((resolve, reject) => {
      const w = new Worker('analyze.js');
      w.onmessage = ({ data }) => { w.terminate(); data.ok ? resolve(data.res) : reject(new Error(data.error)); };
      w.onerror = e => { w.terminate(); reject(new Error(e.message || 'Analysis failed.')); };
      w.postMessage({ channels: [x], sampleRate: sr }, [x.buffer]);
    });
    song = { buffer, name: file.name };
    show(res);
    $('status').textContent = '';
  } catch (e) {
    $('status').textContent = e.message;
  } finally {
    $('drop').classList.remove('busy');
  }
}

function show({ tempo, key, seconds }) {
  tempoRes = tempo;
  pick = 0;
  $('filename').textContent = `${song.name} · ${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  $('tempoBody').hidden = !tempo;
  $('tooShort').hidden = !!tempo;
  if (tempo) {
    const [level, text] = TEMPO_CONF(tempo.strength);
    $('tempoConf').dataset.level = level;
    $('tempoConf').textContent = text;
    $('optA').textContent = `${f1(tempo.bpm)} BPM`;
    $('optB').textContent = `${f1(tempo.alt)} BPM · ${tempo.alt < tempo.bpm ? 'half' : 'double'} time`;
    $('others').textContent = tempo.others.length ? `Other tempos that also fit: ${tempo.others.map(f1).join(', ')} BPM.` : '';
    $('varies').hidden = !tempo.varies;
    if (tempo.varies) $('varies').textContent = `The tempo seems to change. Parts of this file read between ${f1(tempo.varies.lo)} and ${f1(tempo.varies.hi)} BPM. The number above is for the whole file.`;
    choose(0);
  }
  if (key && key.clarity !== 'none') {
    $('key').textContent = key.best.name;
    $('keyOthers').textContent = `Next closest: ${key.others.map(k => k.name + (k.relative ? ' (relative ' + k.mode + ')' : '')).join(', ')}.`;
  } else {
    $('key').textContent = 'No clear key';
    $('keyOthers').textContent = '';
  }
  const clarity = key ? key.clarity : 'none';
  $('keyConf').dataset.level = { clear: 'strong', weak: 'moderate', none: 'weak' }[clarity];
  $('keyConf').textContent = KEY_CONF[clarity];
  $('result').hidden = false;
}

function choose(i) {
  pick = i;
  $('bpm').textContent = f1(i ? tempoRes.alt : tempoRes.bpm);
  ['optA', 'optB'].forEach((id, j) => $(id).setAttribute('aria-checked', String(i === j)));
  if (play) startClicks();
}

// ---------- play with clicks ----------
function startClicks() {
  stopClicks();
  const bpm = pick ? tempoRes.alt : tempoRes.bpm, spb = 60 / bpm;
  const phase = beatPhase(tempoRes.env, tempoRes.fps, bpm);   // from analyze.js
  const ctx = new AudioContext(), src = ctx.createBufferSource(), t0 = ctx.currentTime + 0.1;
  src.buffer = song.buffer;
  src.connect(ctx.destination);
  src.start(t0);
  let next = Math.max(0, Math.ceil(-phase / spb));
  const timer = setInterval(() => {
    for (let t; (t = t0 + phase + next * spb) < ctx.currentTime + 0.25; next++) {
      if (t - t0 > song.buffer.duration) return;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 1760;
      g.gain.setValueAtTime(0.5, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
      o.connect(g).connect(ctx.destination);
      o.start(t); o.stop(t + 0.05);
    }
  }, 50);
  src.onended = () => { if (play && play.src === src) stopClicks(); };
  play = { ctx, src, timer };
  $('clicks').textContent = '■ Stop';
}

function stopClicks() {
  if (!play) return;
  const p = play;
  play = null;
  clearInterval(p.timer);
  try { p.src.stop(); } catch {}
  p.ctx.close();
  $('clicks').textContent = '▶ Play with clicks';
}

// ---------- tap tempo ----------
let taps = [];
function tap() {
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > 2500) taps = [];
  taps.push(now);
  const n = taps.length;
  $('tapCount').textContent = `${n} tap${n === 1 ? '' : 's'}`;
  if (n < 2) { $('tapBpm').textContent = '—'; $('tapAlt').textContent = 'Keep tapping.'; return; }
  const bpm = 60000 * (n - 1) / (now - taps[0]);
  $('tapBpm').textContent = f1(bpm);
  $('tapAlt').textContent = `Half time ${f1(bpm / 2)} · double time ${f1(bpm * 2)}`;
}
function resetTaps() { taps = []; $('tapBpm').textContent = '—'; $('tapCount').textContent = '0 taps'; $('tapAlt').textContent = ''; }

// ---------- wiring ----------
$('file').addEventListener('change', e => load(e.target.files[0]));
const drop = $('drop');
['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => load(e.dataTransfer.files[0]));
$('optA').addEventListener('click', () => choose(0));
$('optB').addEventListener('click', () => choose(1));
$('clicks').addEventListener('click', () => play ? stopClicks() : startClicks());
$('tap').addEventListener('pointerdown', e => { e.preventDefault(); tap(); });
$('tap').addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); tap(); } });
document.addEventListener('keydown', e => { if (e.code === 'KeyT' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) tap(); });
$('tapReset').addEventListener('click', resetTaps);
