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
const buffers = {};

function ensureContext() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

async function preload() {
  ensureContext();
  await Promise.all(
    Object.entries(AUDIO_FILES).map(async ([name, url]) => {
      try {
        const res = await fetch(url);
        const raw = await res.arrayBuffer();
        buffers[name] = await audioCtx.decodeAudioData(raw);
      } catch (e) {
        console.warn(`KawKaw audio: failed to load ${name}`, e);
      }
    })
  );
}

// playbackRate = 2^(-semitones/12). Each consecutive shoo = -1 semitone.
function play(name, consecutiveShoos = 0) {
  if (!audioCtx || !buffers[name]) return;
  const source = audioCtx.createBufferSource();
  source.buffer = buffers[name];
  source.playbackRate.value = Math.pow(2, -consecutiveShoos / 12);
  source.connect(audioCtx.destination);
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
