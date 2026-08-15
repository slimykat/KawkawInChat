// ── Preview canvas ────────────────────────────────────────────────────────────

const PREVIEW_W = 384;
const PREVIEW_H = 216;
const CANVAS_W  = 1280; // matches overlay
const CANVAS_H  = 720;
const SCALE_F   = PREVIEW_W / CANVAS_W; // 0.3 — maps overlay coords to preview px

// Idle frame 0 on the hand-drawn sheet — 480px grid, col 0 is an empty label
// column, so row 1 / col 1 is at (480, 480). Mirrors sprites.js; FRAME is the
// design size `scale` multiplies, which is not the source cell size.
const CELL     = 480;
const FRAME    = 50;
const IDLE_SRC = { x: CELL, y: CELL, w: CELL, h: CELL };

// ponytail: absolute path works when served by the backend; breaks if opened as a local file://
const previewSheet = new Image();
previewSheet.src = '/assets/kawkaw/KawKawSprite_HandDrawn.png';
previewSheet.onload = drawPreview;

function drawPreview() {
  const canvas = document.getElementById('preview-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  // Defaults match overlay renderCfg
  // ponytail: NaN-only fallback so explicit 0 is preserved (|| would coerce 0 to default)
  const num = (id, dflt) => { const v = parseFloat(document.getElementById(id).value); return isNaN(v) ? dflt : v; };
  const sx  = num('startPosX', 0.10);
  const sy  = num('startPosY', 0.70);
  const ex  = num('endPosX',   0.80);
  const ey  = num('endPosY',   0.70);
  const sc  = num('scale',     5);
  const rot = num('rotation',  0);
  const flipEl = document.getElementById('flipX');
  const flip = flipEl ? flipEl.value === '1' : false;

  ctx.clearRect(0, 0, PREVIEW_W, PREVIEW_H);
  ctx.imageSmoothingEnabled = true;   // downscaled hand-drawn art — see game.js

  // Travel path line. KawKaw emerges at meter 0 — the midpoint — and the two ends
  // are only where chat can push it to, so the spawn point gets its own marker.
  const startPx = { x: sx * PREVIEW_W, y: sy * PREVIEW_H };
  const endPx   = { x: ex * PREVIEW_W, y: ey * PREVIEW_H };
  const spawnPx = { x: (startPx.x + endPx.x) / 2, y: (startPx.y + endPx.y) / 2 };
  ctx.save();
  ctx.strokeStyle = 'rgba(167,139,250,0.3)';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(startPx.x, startPx.y);
  ctx.lineTo(endPx.x, endPx.y);
  ctx.stroke();
  ctx.restore();

  const spriteW = FRAME * sc * SCALE_F;
  const spriteH = FRAME * sc * SCALE_F;

  // Standing at `px`, mirrored/rotated about its own centre — same transform the
  // overlay applies, so what you see here is what OBS draws.
  function drawKaw(px, fill) {
    const cy = px.y - spriteH / 2;
    ctx.save();
    ctx.translate(px.x, cy);
    if (rot) ctx.rotate((rot * Math.PI) / 180);
    if (flip) ctx.scale(-1, 1);
    ctx.translate(-px.x, -cy);
    if (previewSheet.complete && previewSheet.naturalWidth) {
      ctx.drawImage(previewSheet, IDLE_SRC.x, IDLE_SRC.y, IDLE_SRC.w, IDLE_SRC.h,
        px.x - spriteW / 2, px.y - spriteH, spriteW, spriteH);
    } else {
      ctx.fillStyle = fill;
      ctx.fillRect(px.x - spriteW / 2, px.y - spriteH, spriteW, spriteH);
    }
    ctx.restore();
  }

  function label(text, px, color) {
    ctx.save();
    ctx.font = '7px monospace';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(text, px.x, px.y - spriteH - 3);
    ctx.restore();
  }

  // The two ends chat can push to — ghosts, since KawKaw only reaches them if it loses
  // or wins. Drawn first so the spawn marker overlaps them if the track is short.
  ctx.save();
  ctx.globalAlpha = 0.35;
  drawKaw(startPx, 'rgba(167,139,250,0.5)');
  drawKaw(endPx,   'rgba(167,139,250,0.5)');
  ctx.restore();
  label('FLEE', startPx, 'rgba(167,139,250,0.7)');
  label('LICK', endPx,   'rgba(167,139,250,0.7)');

  // Where KawKaw actually emerges — solid, because this is what you see first.
  drawKaw(spawnPx, '#c084fc');
  label('APPEARS', spawnPx, '#c084fc');
}

// The backend validates and clamps everything; this list only decides which
// inputs get read and written. Adding a knob is one entry here plus the markup.
const FIELDS = [
  'trigger', 'summonBy', 'rewardTitle',
  'step', 'decay', 'maxSessionDuration', 'perUserCap', 'terminalHoldMs',
  'startPosX', 'startPosY', 'endPosX', 'endPosY', 'scale', 'flipX', 'rotation',
  'volume',
];

const RENDER_FIELDS = ['startPosX', 'startPosY', 'endPosX', 'endPosY', 'scale', 'flipX', 'rotation'];

document.addEventListener('DOMContentLoaded', () => {
  load();

  document.getElementById('save-btn').addEventListener('click', onSave);

  // Live preview: redraw on any position/scale change
  for (const id of RENDER_FIELDS) {
    document.getElementById(id).addEventListener('input', drawPreview);
  }
  drawPreview(); // initial draw (sprite may not be loaded yet; onload covers that case)
});

// ── Backend ───────────────────────────────────────────────────────────────────

async function load() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    populateForm(await res.json());
    drawPreview();
    setMode('Connected to the backend');
  } catch (e) {
    setMode('Backend not reachable — start it, then reload');
    showStatus('Could not load settings: ' + e.message, 'error');
  }
}

async function onSave() {
  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(getFormValues()),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);

    // Show what the backend actually stored — values out of range come back clamped.
    populateForm(body.config);
    drawPreview();
    showStatus(body.clamped?.length
      ? `Saved — adjusted to allowed range: ${body.clamped.join(', ')}`
      : 'Saved! Applies at the next KawKaw.', 'ok');
  } catch (e) {
    showStatus('Could not save: ' + e.message, 'error');
  }
}

function setMode(text) { document.getElementById('mode-note').textContent = text; }

function getFormValues() {
  const cfg = {};
  for (const key of FIELDS) {
    const el = document.getElementById(key);
    if (!el) continue;
    // Sent as strings — the backend coerces and clamps, and reads a blank as
    // "unset" (keep the default) rather than as zero.
    cfg[key] = el.value.trim();
  }
  return cfg;
}

function populateForm(cfg) {
  for (const key of FIELDS) {
    const el = document.getElementById(key);
    if (el && cfg[key] != null) el.value = cfg[key];
  }
}

function showStatus(msg, type) {
  const el = document.getElementById('save-status');
  el.textContent = msg;
  el.className = type;
  setTimeout(() => { el.textContent = ''; el.className = ''; }, 3000);
}
