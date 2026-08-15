// Renders the engine's state object. Everything visual is derived from three
// fields: `meter` → screen position, `shooStreak` → sad-eye size + pitch,
// `push` → the happy/sad reaction on the last tick.

// Sprite sizes are authored against a 720p-tall stage and multiplied by `unit` to
// reach real pixels, so `scale` means the same thing at any resolution. Positions
// are fractions of the live size, so they need no reference resolution at all.
const DESIGN_H = 720;

// Zero, not the design size: syncSize() skips work when nothing changed, so
// seeding these with a plausible size would make a source at exactly that size
// never get its backing store set at all.
let viewW = 0, viewH = 0, unit = 1;

// The browser source already knows its own size — read it rather than making the
// streamer declare it. Checked per frame because OBS can resize a source without
// the page seeing a resize event.
function syncSize() {
  const w = canvas.clientWidth || DESIGN_H * 16 / 9;
  const h = canvas.clientHeight || DESIGN_H;
  if (w === viewW && h === viewH) return;
  viewW = canvas.width = w;
  viewH = canvas.height = h;
  // One factor for both axes. Scaling them independently is what stretches the
  // sprite when the source is not 16:9.
  unit = viewH / DESIGN_H;
}

// Rendering config. Positions are fractions of canvas dimensions (0–1).
// Overridden by the backend on connect; these only cover the first frames.
// KawKaw emerges at meter 0 — the midpoint of the track, not at startPos.
const renderCfg = {
  startPos: { x: 0.10, y: 0.70 },  // meter = -10 (Flee end)
  endPos:   { x: 0.80, y: 0.70 },  // meter = +10 (Lick / streamer)
  scale:    5,
  flipX:    true,
  rotation: 0,                     // degrees, clockwise
  terminalHoldMs: 1500,            // how long the backend holds a terminal
};

const canvas = document.getElementById('kawkaw-canvas');
const ctx = canvas.getContext('2d');
syncSize();

const confusedBubble = document.getElementById('confused-bubble');
const meterEl        = document.getElementById('meter');
const meterMarker    = document.getElementById('meter-marker');

// ── Animation + render state ──────────────────────────────────────────────────

let anim = { name: null, frame: 0, frameMs: 0, done: false, onDone: null };
let endTimer = null;      // pending terminal exit; cleared on hide so it can't fire into the next session
let prevPhase   = 'idle';
let prevOutcome = null;
let emerged     = false;
let shooStreak  = 0;   // raw count; drives the tear frame and the eye's growth
let kawPos      = null;   // current rendered {x, y}; null when hidden
let targetPos   = null;   // meter-derived destination; render loop eases toward it
let slide       = null;   // {x, y} px per ms — constant-speed exit, overrides easing
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
    clearTimeout(endTimer);
    slide = null;
    visible = true;
    emerged = false;
    shooStreak = 0;
    kawPos = targetPos = screenPos(state);
    setAnim('emerge', () => { emerged = true; setAnim('idle'); });
  }

  if (state.phase === 'active') {
    shooStreak = state.shooStreak;
    targetPos = screenPos(state);

    // React to the last tick's net push (skip while Emerge is still playing).
    if (emerged) {
      if (state.push > 0) { setAnim('happy'); playCallWin(); }
      else if (state.push < 0) { setAnim('idle'); playShooWin(state.shooStreak); }
      else setAnim('idle');
    }
  }

  // Terminal — fire once per outcome. Each ending fills terminalHoldMs: hold the
  // pose, then dig away with just enough time left for the dig to finish.
  if (state.phase === 'terminal' && state.outcome !== prevOutcome) {
    clearTimeout(endTimer);
    const holdMs = Math.max(0, renderCfg.terminalHoldMs - animMs('dig'));

    if (state.outcome === 'lick') {
      playLick();
      setAnim('tongueStart', () => setAnim('tongue'));
      endTimer = setTimeout(digAway, holdMs);
    } else if (state.outcome === 'flee_sad') {
      // Shooed away: KawKaw slides off the screen rather than digging. With no
      // track to slide along, there is no heading — dig away instead.
      playFledSad();
      slide = fleeVelocity();
      if (!slide) endTimer = setTimeout(digAway, holdMs);
    } else if (state.outcome === 'flee_confused') {
      showConfusedBubble();
      endTimer = setTimeout(() => { hideConfusedBubble(); digAway(); }, holdMs);
    }
  }

  prevPhase = state.phase;
  prevOutcome = state.outcome ?? null;
}

// meter -10..+10 → point on the Flee→Lick track.
function screenPos(state) {
  const t = (state.meter + 10) / 20;
  return {
    x: (renderCfg.startPos.x + (renderCfg.endPos.x - renderCfg.startPos.x) * t) * viewW,
    y: (renderCfg.startPos.y + (renderCfg.endPos.y - renderCfg.startPos.y) * t) * viewH,
  };
}

// Leaving speed, design px per second (scaled by `unit`). Constant, not eased:
// the position easing
// moves a fraction of the *remaining* distance, so aiming it off-screen makes the
// first frames enormous and KawKaw vanishes instead of sliding.
const FLEE_SPEED = 700;

// The exit heading is the streamer's own track, continued past the entrance:
// away from endPos (the streamer) and out through startPos. Nothing here assumes
// an axis or a side — flipping start/end in config flips the exit with it.
// Returns null when start and end coincide, since that defines no direction.
function fleeVelocity() {
  const dx = (renderCfg.startPos.x - renderCfg.endPos.x) * viewW;
  const dy = (renderCfg.startPos.y - renderCfg.endPos.y) * viewH;
  const len = Math.hypot(dx, dy);
  if (!len) return null;
  const v = (FLEE_SPEED * unit) / 1000;   // same apparent speed at any resolution
  return { x: (dx / len) * v, y: (dy / len) * v };
}

// How long one non-looping animation takes to play through.
function animMs(name) {
  const def = getAnim(name);
  return def ? (def.frames / def.fps) * 1000 : 0;
}

const digAway = () => setAnim('dig', () => { visible = false; });

// ── Canvas render loop ────────────────────────────────────────────────────────

let lastTs = null;

function renderLoop(ts) {
  const dt = lastTs == null ? 0 : ts - lastTs;
  lastTs = ts;

  syncSize();
  ctx.clearRect(0, 0, viewW, viewH);
  // Smoothing on: the hand-drawn sheet's 480px cells are drawn *down* to ~250px,
  // and nearest-neighbour on a downscale throws away half the linework. This was
  // false for the pixel-art sheet, where every draw was a clean integer upscale.
  ctx.imageSmoothingEnabled = true;

  if (kawPos && slide) {
    // Exiting: constant speed, ignoring the meter target it left behind.
    kawPos = { x: kawPos.x + slide.x * dt, y: kawPos.y + slide.y * dt };
  } else if (kawPos && targetPos) {
    // Ease position toward the meter-derived target (frame-rate independent).
    const k = 1 - Math.exp(-dt / 150);
    kawPos = { x: kawPos.x + (targetPos.x - kawPos.x) * k, y: kawPos.y + (targetPos.y - kawPos.y) * k };
  }

  if (visible && kawPos && anim.name) {
    advanceFrame(dt);
    const def = getAnim(anim.name);
    if (def) {
      const s = renderCfg.scale * unit;
      const dx = kawPos.x - (def.w * s) / 2;
      const dy = kawPos.y - def.h * s;
      // Mirror and rotation wrap body and eyes together, so the crying overlay
      // stays registered to the face instead of drifting off it.
      ctx.save();
      ctx.translate(kawPos.x, dy + (def.h * s) / 2);
      if (renderCfg.rotation) ctx.rotate((renderCfg.rotation * Math.PI) / 180);
      if (renderCfg.flipX) ctx.scale(-1, 1);
      ctx.translate(-kawPos.x, -(dy + (def.h * s) / 2));

      drawSprite(ctx, anim.name, anim.frame, dx, dy, s);
      // Sad crying overlay sits on the idle/happy body; size = shooStreak.
      if ((anim.name === 'idle' || anim.name === 'happy') && shooStreak > 0) {
        drawEye(ctx, shooStreak, dx, dy, s, anim.name, anim.frame);
      }
      ctx.restore();
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
  const s = renderCfg.scale * unit;
  const def = getAnim('idle');
  if (!def) return;
  // The canvas backing store now matches its CSS size, so canvas coordinates are
  // already CSS pixels and the bubble needs no conversion.
  //
  // Anchor at the top-centre of the sprite; the CSS transform centres the bubble
  // on it. Font size drives every other dimension (all `em`), so the bubble keeps
  // its proportions at any sprite scale. Sub-linear on purpose: sized 1:1 with the
  // sprite it dwarfs it at high scales.
  confusedBubble.style.fontSize = `${def.h * 0.3 * Math.sqrt(renderCfg.scale) * unit}px`;
  confusedBubble.style.left = `${kawPos.x}px`;
  confusedBubble.style.top  = `${kawPos.y - def.h * s}px`;
  confusedBubble.classList.remove('hidden');
}

function hideConfusedBubble() { confusedBubble.classList.add('hidden'); }

// ── Helpers ───────────────────────────────────────────────────────────────────

function hide() {
  clearTimeout(endTimer);
  visible = false;
  emerged = false;
  kawPos = targetPos = slide = null;
  anim.name = null;
  hideConfusedBubble();
  meterEl.classList.add('hidden');
}

function setRenderConfig(cfg) { Object.assign(renderCfg, cfg); }
