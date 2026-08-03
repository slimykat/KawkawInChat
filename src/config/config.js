// ── Preview canvas ────────────────────────────────────────────────────────────

const PREVIEW_W = 384;
const PREVIEW_H = 216;
const CANVAS_W  = 1280; // matches overlay
const CANVAS_H  = 720;
const SCALE_F   = PREVIEW_W / CANVAS_W; // 0.3 — maps overlay coords to preview px

// Idle frame 0 source rect from kawkaw_framed.png (matches sprites.js ANIMS.idle)
const IDLE_SRC = { x: 52, y: 52, w: 50, h: 50 };

// ponytail: absolute path works when served by the backend; breaks if opened as a local file://
const previewSheet = new Image();
previewSheet.src = '/assets/kawkaw/kawkaw_framed.png';
previewSheet.onload = drawPreview;

function drawPreview() {
  const canvas = document.getElementById('preview-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');

  // Defaults match overlay renderCfg
  // ponytail: NaN-only fallback so explicit 0 is preserved (|| would coerce 0 to default)
  const num = (id, dflt) => { const v = parseFloat(document.getElementById(id).value); return isNaN(v) ? dflt : v; };
  const sx  = num('startPosX', 0.85);
  const sy  = num('startPosY', 0.70);
  const ex  = num('endPosX',   0.15);
  const ey  = num('endPosY',   0.70);
  const sc  = num('scale',     3);

  ctx.clearRect(0, 0, PREVIEW_W, PREVIEW_H);
  ctx.imageSmoothingEnabled = false;

  // Travel path line
  const startPx = { x: sx * PREVIEW_W, y: sy * PREVIEW_H };
  const endPx   = { x: ex * PREVIEW_W, y: ey * PREVIEW_H };
  ctx.save();
  ctx.strokeStyle = 'rgba(167,139,250,0.3)';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(startPx.x, startPx.y);
  ctx.lineTo(endPx.x, endPx.y);
  ctx.stroke();
  ctx.restore();

  const spriteW = IDLE_SRC.w * sc * SCALE_F;
  const spriteH = IDLE_SRC.h * sc * SCALE_F;

  // End position — ghost/semi-transparent
  ctx.save();
  ctx.globalAlpha = 0.35;
  if (previewSheet.complete && previewSheet.naturalWidth) {
    ctx.drawImage(previewSheet, IDLE_SRC.x, IDLE_SRC.y, IDLE_SRC.w, IDLE_SRC.h,
      endPx.x - spriteW / 2, endPx.y - spriteH, spriteW, spriteH);
  } else {
    ctx.fillStyle = 'rgba(167,139,250,0.5)';
    ctx.fillRect(endPx.x - spriteW / 2, endPx.y - spriteH, spriteW, spriteH);
  }
  ctx.restore();

  // "END" label
  ctx.save();
  ctx.font = '7px monospace';
  ctx.fillStyle = 'rgba(167,139,250,0.7)';
  ctx.textAlign = 'center';
  ctx.fillText('END', endPx.x, endPx.y - spriteH - 3);
  ctx.restore();

  // Start position — solid sprite
  if (previewSheet.complete && previewSheet.naturalWidth) {
    ctx.drawImage(previewSheet, IDLE_SRC.x, IDLE_SRC.y, IDLE_SRC.w, IDLE_SRC.h,
      startPx.x - spriteW / 2, startPx.y - spriteH, spriteW, spriteH);
  } else {
    ctx.fillStyle = '#c084fc';
    ctx.fillRect(startPx.x - spriteW / 2, startPx.y - spriteH, spriteW, spriteH);
  }

  // "START" label
  ctx.save();
  ctx.font = '7px monospace';
  ctx.fillStyle = '#c084fc';
  ctx.textAlign = 'center';
  ctx.fillText('START', startPx.x, startPx.y - spriteH - 3);
  ctx.restore();
}

// The backend validates and clamps everything; this list only decides which
// inputs get read and written. Adding a knob is one entry here plus the markup.
const FIELDS = [
  'trigger',
  'step', 'decay', 'maxSessionDuration', 'perUserCap',
  'startPosX', 'startPosY', 'endPosX', 'endPosY', 'scale',
];

const RENDER_FIELDS = ['startPosX', 'startPosY', 'endPosX', 'endPosY', 'scale'];

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
