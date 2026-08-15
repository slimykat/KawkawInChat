// ── Sheet geometry ────────────────────────────────────────────────────────────
// The hand-drawn sheet is a plain 480px grid — no cell borders, and column 0 is
// an empty label column kept from the layout of the sheet it was drawn over.
// So row n starts at y = n * CELL, and sprite column c at x = c * CELL.
//
// 480 was measured off the art rather than assumed: it captures 100% of the
// sheet's ink, and it puts the dry eye's centre at fraction (0.466, 0.709) of
// its cell against (0.480, 0.710) on the original — the giveaway that the grid
// is right.
const CELL = 480;

// Sprites are 50×50 in *design* space no matter what resolution the sheet is
// exported at. `scale` in the streamer config multiplies this, not the source
// cell, so re-exporting the art at a different size moves only the source rects
// and leaves every saved config meaning what it did.
const FRAME = 50;

// Body animation definitions. `row` indexes the sheet; `w`/`h` are design size,
// deliberately not the source cell size — game.js multiplies them by `scale` to
// place and size the sprite.
// Named defAnim, not anim: these files are plain scripts sharing one global
// scope, and game.js already owns `anim` for the current render state.
const defAnim = (row, frames, fps, loop) => ({ row, frames, fps, loop, w: FRAME, h: FRAME });

// Frame counts match what is drawn on the sheet. They used to be one short on
// idle, emerge, tongue and dig, so every one of those cut its last frame: emerge
// popped to idle a frame early, and dig ended with KawKaw still ~24% on screen.
const ANIMS = {
  idle:        defAnim(1, 3, 6, true),
  happy:       defAnim(2, 1, 6, true),
  dig:         defAnim(6, 4, 8, false),
  emerge:      defAnim(3, 4, 8, false),
  tongueStart: defAnim(4, 1, 6, false),
  tongue:      defAnim(5, 3, 6, true),
};

// Eye overlay sprites — row 0, cols 1–4. Col 1 is dry; cols 2–4 add the
// teardrop and differ only in where the white shine sits, giving the eye a glint
// as the streak runs. They are all the same size — the swelling is not in the art.
const EYE_FRAMES = [1, 2, 3, 4].map((col) => ({ col, row: 0 }));

// Eye overlay is designed to sit flush with the body sprite's top-left corner.
const EYE_OFFSET = { x: 0, y: 0 };

// The eye swells with each consecutive shoo. The sheet has no larger eye to swap
// in, so it is scaled — the one place alignment with the body's pixel grid is
// deliberately broken, since a fractional scale cannot land on it.
//
// Growth is centred on the eyeball, not the cell, or the eye would slide toward
// the bottom-right as it grew. Measured off the sheet: the dry eye's ink spans
// x172–275, y291–390 inside its 480px cell → centre (223.5, 340.5), which is
// (23.3, 35.5) in design px.
const EYE_ANCHOR = { x: 23.3, y: 35.5 };
const EYE_GROWTH = 0.3;        // extra scale per consecutive shoo tick
const EYE_GROWTH_MAX = 2.2;    // ceiling, so a long streak can't swallow the body

const sheet = new Image();
sheet.src = '/assets/kawkaw/KawKawSprite_HandDrawn.png';

function drawSprite(ctx, animName, frame, dx, dy, scale) {
  const a = ANIMS[animName];
  if (!a || !sheet.complete) return;

  const f = frame % a.frames;
  ctx.drawImage(
    sheet,
    (1 + f) * CELL, a.row * CELL, CELL, CELL,
    dx, dy, FRAME * scale, FRAME * scale,
  );
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
    e.col * CELL, e.row * CELL, CELL, CELL,
    ox, oy,
    FRAME * scale * grow,
    FRAME * scale * grow,
  );
}

function getAnim(name) { return ANIMS[name]; }
