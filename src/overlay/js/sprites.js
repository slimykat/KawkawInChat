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

// Eye overlay sprites — row 0 (y=1), cols 1–4. Col 1 is dry; cols 2–4 add the
// teardrop and differ only in where the white shine sits, giving the eye a glint
// as the streak runs. They are all the same size — the swelling is not in the art.
const EYE_FRAMES = [
  { x: COL1,            y: 1, w: 50, h: 50 },
  { x: COL1 + CELL,     y: 1, w: 50, h: 50 },
  { x: COL1 + CELL * 2, y: 1, w: 50, h: 50 },
  { x: COL1 + CELL * 3, y: 1, w: 50, h: 50 },
];

// Eye overlay is designed to sit flush with the body sprite's top-left corner.
const EYE_OFFSET = { x: 0, y: 0 };

// The eye swells with each consecutive shoo. The sheet has no larger eye to swap
// in, so it is scaled — the one place alignment with the body's pixel grid is
// deliberately broken, since a fractional scale cannot land on it.
//
// Growth is centred on the eyeball, not the cell, or the eye would slide toward
// the bottom-right as it grew. Measured off the sheet: the dry eye's opaque
// pixels span x19–29, y31–40 inside the 50×50 cell.
const EYE_ANCHOR = { x: 24, y: 35.5 };
const EYE_GROWTH = 0.3;        // extra scale per consecutive shoo tick
const EYE_GROWTH_MAX = 2.2;    // ceiling, so a long streak can't swallow the body

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

// `shooStreak` is the raw consecutive-shoo count, not clamped: the frame stops
// changing after the last one but the eye keeps swelling up to EYE_GROWTH_MAX.
function drawEye(ctx, shooStreak, dx, dy, scale) {
  if (shooStreak < 1 || !sheet.complete) return;

  const e = EYE_FRAMES[Math.min(shooStreak, EYE_FRAMES.length) - 1];
  const grow = Math.min(EYE_GROWTH_MAX, 1 + (shooStreak - 1) * EYE_GROWTH);
  // Offset back by the growth around the anchor, so the eyeball stays put and the
  // overlay swells outward from it.
  const ox = dx + (EYE_OFFSET.x + EYE_ANCHOR.x * (1 - grow)) * scale;
  const oy = dy + (EYE_OFFSET.y + EYE_ANCHOR.y * (1 - grow)) * scale;

  ctx.drawImage(
    sheet,
    e.x, e.y, e.w, e.h,
    ox, oy,
    e.w * scale * grow,
    e.h * scale * grow,
  );
}

function getAnim(name) { return ANIMS[name]; }
