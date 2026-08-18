// AudioContext is created on first user gesture (browser autoplay policy).
// In OBS Browser Source context, audio may be silently unavailable.

const AUDIO_FILES = {
  happy_1:    '/assets/kawkaw/Kawkaw_voiceclip_happy_1.wav.ogg',
  happy_2:    '/assets/kawkaw/Kawkaw_voiceclip_happy_2.wav.ogg',
  sad_short:  '/assets/kawkaw/Kawkaw_voiceclip_sad_short.wav.ogg',
  sad_1:      '/assets/kawkaw/Kawkaw_voiceclip_sad_1.wav.ogg',
  sad_2:      '/assets/kawkaw/Kawkaw_voiceclip_sad_2.wav.ogg',
  licking_1:  '/assets/kawkaw/Kawkaw_voiceclip_licking_1.wav.ogg',
  licking_2:  '/assets/kawkaw/Kawkaw_voiceclip_licking_2.wav.ogg',
  licking_3:  '/assets/kawkaw/Kawkaw_voiceclip_licking_3.wav.ogg',
};

let audioCtx = null;
let masterGain = null;
let volume = 1;            // 0–1; every clip plays through masterGain
const buffers = {};

function ensureContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = volume;
    masterGain.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

// 0–1. Applies to the next clip — no need to wait for the next encounter, so the
// streamer can set the level by ear while KawKaw is on screen.
function setVolume(v) {
  if (!Number.isFinite(v)) return;
  volume = Math.min(1, Math.max(0, v));
  if (masterGain) masterGain.gain.value = volume;
}

// Running with no sound files is a supported state, not a fault: the repo ships
// without audio, so a fresh clone has none. A 404 is therefore reported once, as
// a fact, and only a file that exists but will not decode is a real warning.
async function preload() {
  ensureContext();
  // Local, not module-scope: preload can run more than once, and a running total
  // would report more missing clips than exist.
  let missing = 0;
  await Promise.all(
    Object.entries(AUDIO_FILES).map(async ([name, url]) => {
      let res;
      try {
        res = await fetch(url);
      } catch (e) {
        console.warn(`KawKaw audio: could not fetch ${name}`, e);
        return;
      }
      if (!res.ok) { missing++; return; }
      try {
        buffers[name] = await audioCtx.decodeAudioData(await res.arrayBuffer());
      } catch (e) {
        console.warn(`KawKaw audio: ${name} is present but would not decode`, e);
      }
    })
  );
  if (missing) {
    console.log(`KawKaw audio: ${missing}/${Object.keys(AUDIO_FILES).length} clips not installed — running silent`);
  }
}

// playbackRate = 2^(-semitones/12). Each consecutive shoo = -1 semitone.
function play(name, consecutiveShoos = 0) {
  if (!audioCtx || !buffers[name]) return;
  const source = audioCtx.createBufferSource();
  source.buffer = buffers[name];
  source.playbackRate.value = Math.pow(2, -consecutiveShoos / 12);
  source.connect(masterGain || audioCtx.destination);
  source.start();
}

function pickRandom(...names) {
  return names[Math.floor(Math.random() * names.length)];
}

function playCallWin() {
  ensureContext();
  play(pickRandom('happy_1', 'happy_2'));
}

function playShooWin(consecutiveShoos) {
  ensureContext();
  play('sad_short', consecutiveShoos);
}

function playFledSad() {
  ensureContext();
  play(pickRandom('sad_1', 'sad_2'));
}

function playLick() {
  ensureContext();
  play(pickRandom('licking_1', 'licking_2', 'licking_3'));
}

// Called on first user interaction to unlock AudioContext and preload buffers
function initAudio() {
  preload();
}
