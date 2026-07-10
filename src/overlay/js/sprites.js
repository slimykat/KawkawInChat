// Grid constants — each cell is 50×50px content with a 1px frame border.
// Cell stride = 51px (50 content + 1 border, shared between adjacent cells).
// Col 0 = label column. First sprite column (col 1) content starts at x = 52.
// Row n content starts at y = n * 51 + 1.
const CELL = 51;
const COL1 = CELL + 1; // x-origin of first sprite column = 52

// Body animation definitions.
// x/y = content origin of frame 0.  stride = px between frame origins (51).
// Dig is not in kawkaw_framed.png — add it when the sprite is available.
const ANIMS = {
  idle:        { x: COL1, y: CELL * 1 + 1, w: 50, h: 50, stride: CELL, frames: 2, fps: 6,  loop: true  },
  happy:       { x: COL1, y: CELL * 2 + 1, w: 50, h: 50, stride: CELL, frames: 1, fps: 6,  loop: true  },
  dig:         { x: COL1, y: CELL * 6 + 1, w: 50, h: 50, stride: CELL, frames: 3, fps: 8,  loop: false },
  emerge:      { x: COL1, y: CELL * 3 + 1, w: 50, h: 50, stride: CELL, frames: 3, fps: 8,  loop: false },
  tongueStart: { x: COL1, y: CELL * 4 + 1, w: 50, h: 50, stride: CELL, frames: 1, fps: 6,  loop: false },
  tongue:      { x: COL1, y: CELL * 5 + 1, w: 50, h: 50, stride: CELL, frames: 2, fps: 6,  loop: true  },
};

// Eye overlay sprites — row 0 (y=1), cols 1–4.
// eyeLevel 1–4 maps to index 0–3.
const EYE_FRAMES = [
  { x: COL1,             y: 1, w: 50, h: 50 },
  { x: COL1 + CELL,     y: 1, w: 50, h: 50 },
  { x: COL1 + CELL * 2, y: 1, w: 50, h: 50 },
  { x: COL1 + CELL * 3, y: 1, w: 50, h: 50 },
];

// Eye overlay is designed to sit flush with the body sprite's top-left corner.
const EYE_OFFSET = { x: 0, y: 0 };

const sheet = new Image();
sheet.src = '/assets/kawkaw/kawkaw_framed.png';

function drawSprite(ctx, animName, frame, dx, dy, scale) {
  const anim = ANIMS[animName];
  if (!anim || !sheet.complete) return;

  const f = frame % anim.frames;
  const sx = anim.x + f * (anim.stride ?? anim.w);
  const sy = anim.y;

  ctx.drawImage(sheet, sx, sy, anim.w, anim.h, dx, dy, anim.w * scale, anim.h * scale);
}

function drawEye(ctx, eyeLevel, dx, dy, scale) {
  if (eyeLevel < 1 || eyeLevel > 4 || !sheet.complete) return;

  const e = EYE_FRAMES[eyeLevel - 1];
  ctx.drawImage(
    sheet,
    e.x, e.y, e.w, e.h,
    dx + EYE_OFFSET.x * scale,
    dy + EYE_OFFSET.y * scale,
    e.w * scale,
    e.h * scale,
  );

}

function getAnim(name) { return ANIMS[name]; }
