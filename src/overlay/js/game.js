// Renders the engine's state object. Everything visual is derived from three
// fields: `meter` → screen position, `shooStreak` → sad-eye size + pitch,
// `push` → the happy/sad reaction on the last tick.

const CANVAS_W = 1280;
const CANVAS_H = 720;

// Rendering config — overridden by main.js from URL params or Twitch config.
// Positions are fractions of canvas dimensions (0–1).
const renderCfg = {
  startPos: { x: 0.85, y: 0.70 },  // meter = -10 (Flee end)
  endPos:   { x: 0.15, y: 0.70 },  // meter = +10 (Lick / streamer)
  scale:    3,
};

const canvas = document.getElementById('kawkaw-canvas');
const ctx = canvas.getContext('2d');
canvas.width  = CANVAS_W;
canvas.height = CANVAS_H;

const confusedBubble = document.getElementById('confused-bubble');
const meterEl        = document.getElementById('meter');
const meterMarker    = document.getElementById('meter-marker');

// ── Animation + render state ──────────────────────────────────────────────────

let anim = { name: null, frame: 0, frameMs: 0, done: false, onDone: null };
let prevPhase   = 'idle';
let prevOutcome = null;
let emerged     = false;
let eyeLevel    = 0;
let kawPos      = null;   // current rendered {x, y}; null when hidden
let targetPos   = null;   // meter-derived destination; render loop eases toward it
let visible     = false;

function setAnim(name, onDone = null) {
  anim = { name, frame: 0, frameMs: 0, done: false, onDone };
}

// ── State update handler ──────────────────────────────────────────────────────

function onStateUpdate(state) {
  updateMeterHud(state);

  if (state.phase === 'idle') {
    if (prevPhase !== 'idle') hide();
    prevPhase = 'idle';
    prevOutcome = null;
    return;
  }

  // Session just started — Emerge, then settle to idle.
  if (prevPhase === 'idle' && state.phase === 'active') {
    visible = true;
    emerged = false;
    eyeLevel = 0;
    kawPos = targetPos = screenPos(state);
    setAnim('emerge', () => { emerged = true; setAnim('idle'); });
  }

  if (state.phase === 'active') {
    eyeLevel  = Math.max(0, Math.min(4, state.shooStreak));
    targetPos = screenPos(state);

    // React to the last tick's net push (skip while Emerge is still playing).
    if (emerged) {
      if (state.push > 0) { setAnim('happy'); playCallWin(); }
      else if (state.push < 0) { setAnim('idle'); playShooWin(state.shooStreak); }
      else setAnim('idle');
    }
  }

  // Terminal — fire once per outcome.
  if (state.phase === 'terminal' && state.outcome !== prevOutcome) {
    if (state.outcome === 'lick') {
      playLick();
      setAnim('tongueStart', () => setAnim('tongue'));
    } else if (state.outcome === 'flee_sad') {
      playFledSad();
      setAnim('dig', () => { visible = false; });
    } else if (state.outcome === 'flee_confused') {
      showConfusedBubble();
      setTimeout(() => { hideConfusedBubble(); setAnim('dig', () => { visible = false; }); }, 1500);
    }
  }

  prevPhase = state.phase;
  prevOutcome = state.outcome ?? null;
}

// meter -10..+10 → point on the Flee→Lick track.
function screenPos(state) {
  const t = (state.meter + 10) / 20;
  return {
    x: (renderCfg.startPos.x + (renderCfg.endPos.x - renderCfg.startPos.x) * t) * CANVAS_W,
    y: (renderCfg.startPos.y + (renderCfg.endPos.y - renderCfg.startPos.y) * t) * CANVAS_H,
  };
}

// ── Canvas render loop ────────────────────────────────────────────────────────

let lastTs = null;

function renderLoop(ts) {
  const dt = lastTs == null ? 0 : ts - lastTs;
  lastTs = ts;

  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.imageSmoothingEnabled = false;

  // Ease position toward the meter-derived target (frame-rate independent).
  if (kawPos && targetPos) {
    const k = 1 - Math.exp(-dt / 150);
    kawPos = { x: kawPos.x + (targetPos.x - kawPos.x) * k, y: kawPos.y + (targetPos.y - kawPos.y) * k };
  }

  if (visible && kawPos && anim.name) {
    advanceFrame(dt);
    const def = getAnim(anim.name);
    if (def) {
      const s = renderCfg.scale;
      const dx = kawPos.x - (def.w * s) / 2;
      const dy = kawPos.y - def.h * s;
      drawSprite(ctx, anim.name, anim.frame, dx, dy, s);
      // Sad crying overlay sits on the idle/happy body; size = shooStreak.
      if ((anim.name === 'idle' || anim.name === 'happy') && eyeLevel > 0) {
        drawEye(ctx, eyeLevel, dx, dy, s);
      }
    }
  }

  requestAnimationFrame(renderLoop);
}

function advanceFrame(dt) {
  const def = getAnim(anim.name);
  if (!def) return;
  anim.frameMs += dt;
  const frameDur = 1000 / def.fps;
  while (anim.frameMs >= frameDur) {
    anim.frameMs -= frameDur;
    anim.frame++;
    if (anim.frame >= def.frames) {
      if (def.loop) {
        anim.frame = 0;
      } else {
        anim.frame = def.frames - 1;
        if (!anim.done) {
          anim.done = true;
          const cb = anim.onDone;
          anim.onDone = null;
          if (cb) cb();
        }
      }
    }
  }
}

requestAnimationFrame(renderLoop);

// ── Meter HUD ─────────────────────────────────────────────────────────────────

function updateMeterHud(state) {
  const active = state.phase === 'active' || state.phase === 'terminal';
  meterEl.classList.toggle('hidden', !active);
  if (!active) return;
  const t = (state.meter + 10) / 20; // 0 (Flee) .. 1 (Lick)
  meterMarker.style.left = `${t * 100}%`;
}

// ── Confused bubble ───────────────────────────────────────────────────────────

function showConfusedBubble() {
  if (!kawPos) return;
  const s = renderCfg.scale;
  const def = getAnim('idle');
  if (!def) return;
  const scaleX = canvas.clientWidth  / CANVAS_W;
  const scaleY = canvas.clientHeight / CANVAS_H;
  confusedBubble.style.left = `${(kawPos.x - (def.w * s) / 2) * scaleX}px`;
  confusedBubble.style.top  = `${(kawPos.y - def.h * s - 40) * scaleY}px`;
  confusedBubble.classList.remove('hidden');
}

function hideConfusedBubble() { confusedBubble.classList.add('hidden'); }

// ── Helpers ───────────────────────────────────────────────────────────────────

function hide() {
  visible = false;
  emerged = false;
  kawPos = targetPos = null;
  anim.name = null;
  hideConfusedBubble();
  meterEl.classList.add('hidden');
}

function setRenderConfig(cfg) { Object.assign(renderCfg, cfg); }
