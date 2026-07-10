// Internal canvas resolution. CSS scales this to fill the container.
const CANVAS_W = 1280;
const CANVAS_H = 720;

// Rendering config — overridden by main.js from URL params or Twitch config.
// Positions are fractions of canvas dimensions (0–1).
const renderCfg = {
  startPos: { x: 0.85, y: 0.70 },
  endPos:   { x: 0.15, y: 0.70 },
  scale:    3,
  callsToWin: 20,
};

const canvas = document.getElementById('kawkaw-canvas');
const ctx = canvas.getContext('2d');
canvas.width  = CANVAS_W;
canvas.height = CANVAS_H;

const confusedBubble = document.getElementById('confused-bubble');
const voteUI         = document.getElementById('vote-ui');
const countdownBar   = document.getElementById('countdown-bar');
const countShoo      = document.getElementById('count-shoo');
const countCall      = document.getElementById('count-call');
const btnShoo        = document.getElementById('btn-shoo');
const btnCall        = document.getElementById('btn-call');

// ── Animation state ───────────────────────────────────────────────────────────

let anim = {
  name: null,
  frame: 0,
  frameMs: 0,     // accumulated ms in current frame
  done: false,    // true once a one-shot animation has finished
  onDone: null,
};

let prevPhase         = null;
let prevOutcome       = null;
let prevIntervalCount = 0;
let eyeLevel          = 0;
let intervalEndsAt    = null;
let kawPos      = null;   // current rendered {x, y} on canvas — null when hidden
let visible     = false;

function setAnim(name, onDone = null) {
  anim.name   = name;
  anim.frame  = 0;
  anim.frameMs = 0;
  anim.done   = false;
  anim.onDone = onDone;
}

// ── State update handler ──────────────────────────────────────────────────────

function onStateUpdate(state) {
  updateVoteUI(state);

  if (state.phase === 'idle') {
    if (prevPhase !== 'idle') hide();
    prevPhase         = 'idle';
    prevOutcome       = null;
    prevIntervalCount = 0;
    return;
  }

  // Session just started
  if (prevPhase === 'idle' && state.phase === 'voting') {
    visible  = true;
    eyeLevel = 0;
    kawPos   = screenPos(state);
    setAnim('emerge', () => setAnim('idle'));
  }

  // Interval resolved — detected via monotonic counter, not lastAction value,
  // so consecutive same-action intervals are handled correctly.
  const currentCount = state.intervalCount ?? 0;
  if (currentCount > prevIntervalCount) {
    prevIntervalCount = currentCount;
    eyeLevel = state.eyeLevel;

    if (state.lastAction === 'call') {
      const from = kawPos ?? screenPos(state); // guard: snap if kawPos somehow null
      const to   = screenPos(state);
      kawPos = from; // hold current pos; tween drives it to `to`
      playCallWin();
      setAnim('happy'); // tween completion calls setAnim('idle'), not onDone
      startTween(from, to, 400);
    } else if (state.lastAction === 'shoo') {
      kawPos = screenPos(state); // shoo: no movement, snap is fine
      playShooWin(state.consecutiveShoos);
    }
  }

  // Terminal
  if (state.phase === 'terminal' && state.outcome !== prevOutcome) {
    if (state.outcome === 'lick') {
      playLick();
      setAnim('tongueStart', () => setAnim('tongue'));
    } else if (state.outcome === 'fled_sad') {
      playFledSad();
      setAnim('dig', () => { visible = false; });
    } else if (state.outcome === 'fled_confused') {
      showConfusedBubble();
      setTimeout(() => {
        hideConfusedBubble();
        setAnim('dig', () => { visible = false; });
      }, 1500);
    }
  }

  prevPhase   = state.phase;
  prevOutcome = state.outcome ?? null;
}

// ── Canvas rendering ──────────────────────────────────────────────────────────

function screenPos(state) {
  const t = (renderCfg.callsToWin - state.position) / renderCfg.callsToWin;
  return {
    x: (renderCfg.startPos.x + (renderCfg.endPos.x - renderCfg.startPos.x) * t) * CANVAS_W,
    y: (renderCfg.startPos.y + (renderCfg.endPos.y - renderCfg.startPos.y) * t) * CANVAS_H,
  };
}

// ── Position tween (call-win only) ────────────────────────────────────────────

let tween = null; // { from, to, startTs, duration } or null

function startTween(from, to, duration) {
  tween = { from, to, startTs: null, duration };
  // ponytail: startTs set on first renderLoop tick so ts origin is consistent
}

let lastTs = null;

function renderLoop(ts) {
  const dt = lastTs == null ? 0 : ts - lastTs;
  lastTs = ts;

  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.imageSmoothingEnabled = false;

  // Advance position tween if active
  if (tween) {
    if (tween.startTs === null) tween.startTs = ts;
    const raw = (ts - tween.startTs) / tween.duration;
    const t = Math.min(raw, 1);
    const e = t * t * (3 - 2 * t); // smoothstep
    kawPos = {
      x: tween.from.x + (tween.to.x - tween.from.x) * e,
      y: tween.from.y + (tween.to.y - tween.from.y) * e,
    };
    if (t >= 1) {
      kawPos = tween.to;
      tween = null;
      if (anim.name === 'happy') setAnim('idle');  // guard against terminal clobber
    }
  }

  if (visible && kawPos && anim.name) {
    // Advance animation frame
    const def = getAnim(anim.name);
    if (def) {
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
              if (anim.onDone) {
                const cb = anim.onDone;
                anim.onDone = null;
                cb();
              }
            }
          }
        }
      }
    }

    const s = renderCfg.scale;
    const def2 = getAnim(anim.name);
    if (def2) {
      const dx = kawPos.x - (def2.w * s) / 2;
      const dy = kawPos.y - def2.h * s;
      drawSprite(ctx, anim.name, anim.frame, dx, dy, s);

      // Composite eye overlay for idle/voting states
      if ((anim.name === 'idle' || anim.name === 'happy') && eyeLevel > 0) {
        drawEye(ctx, eyeLevel, dx, dy, s);
      }
    }
  }

  requestAnimationFrame(renderLoop);
}

requestAnimationFrame(renderLoop);

// ── Vote UI ───────────────────────────────────────────────────────────────────

function updateVoteUI(state) {
  const active = state.phase === 'voting';
  voteUI.classList.toggle('hidden', !active);

  if (state.votes) {
    countShoo.textContent = state.votes.shoo;
    countCall.textContent = state.votes.call;
  }

  if (state.intervalEndsAt) {
    intervalEndsAt = state.intervalEndsAt;
  }
  if (state.intervalDuration) {
    renderCfg.intervalDuration = state.intervalDuration;
  }
}

// Tick countdown bar at 100ms resolution between state updates
setInterval(() => {
  if (!intervalEndsAt) return;
  const remaining = Math.max(0, intervalEndsAt - Date.now());
  const total = (renderCfg.intervalDuration ?? 10) * 1000;
  countdownBar.style.width = `${(remaining / total) * 100}%`;
}, 100);

// ── Confused bubble ───────────────────────────────────────────────────────────

function showConfusedBubble() {
  if (!kawPos) return;
  const s = renderCfg.scale;
  const def = getAnim('idle');
  if (!def) return;

  // Position bubble above KawKaw's head, accounting for canvas→CSS scaling
  const scaleX = canvas.clientWidth  / CANVAS_W;
  const scaleY = canvas.clientHeight / CANVAS_H;
  const headX  = (kawPos.x - (def.w * s) / 2) * scaleX;
  const headY  = (kawPos.y - def.h * s - 40)  * scaleY;

  confusedBubble.style.left = `${headX}px`;
  confusedBubble.style.top  = `${headY}px`;
  confusedBubble.classList.remove('hidden');
}

function hideConfusedBubble() {
  confusedBubble.classList.add('hidden');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function hide() {
  visible = false;
  kawPos  = null;
  tween   = null;
  anim.name = null;
  hideConfusedBubble();
}

function setRenderConfig(cfg) {
  Object.assign(renderCfg, cfg);
}

function setVoteButtonsVisible(show) {
  btnShoo.style.display = show ? '' : 'none';
  btnCall.style.display = show ? '' : 'none';
}
