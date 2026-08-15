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

// Eye overlay sprites — row 0, cols 1–4. Col 1 is dry, cols 2–4 add the teardrop.
const EYE_FRAMES = [1, 2, 3, 4].map((col) => ({ col, row: 0 }));

// ── Eye registration ──────────────────────────────────────────────────────────
// The art is hand-drawn, so the eye does not sit in the same place twice. It
// wanders ~2 design px horizontally across the idle cycle, and the overlay cells
// wander with it — each was drawn over a different idle frame.
//
// That coupling cannot be relied on, because the two are driven by different
// clocks: the overlay frame comes from shooStreak, the body frame from the idle
// loop. Eye frame 2 lands on idle frame 0 routinely, which is a 3.6 design px
// miss — enough to leave the body's own eye showing beside the overlay.
//
// So neither table is an offset from the other. Both are absolute eyeball centres
// in design px, measured off the sheet (the largest dark blob in each body cell;
// the white fill in each overlay cell), and drawEye aligns one onto the other.
// Re-measure both if the eyes are redrawn.
const BODY_EYE = {
  idle:  [{ x: 23.33, y: 34.64 }, { x: 21.82, y: 33.96 }, { x: 21.09, y: 34.32 }],
  happy: [{ x: 23.18, y: 30.73 }],
};

const EYE_CENTRE = [
  { x: 23.23, y: 35.42 }, { x: 21.98, y: 35.42 },
  { x: 20.73, y: 35.21 }, { x: 19.69, y: 35.31 },
];

// The eye swells with each consecutive shoo. The sheet has no larger eye to swap
// in, so it is scaled about the eyeball's centre — not the cell's, or the eye
// would slide toward the bottom-right as it grew.
//
// Aligned, the overlay already covers the body's eye at 1.010, so the streak
// starts at 1:1 and the swelling is pure effect rather than cover-up.
const EYE_GROWTH = 0.15;       // extra scale per consecutive shoo tick
const EYE_GROWTH_MAX = 1.8;    // ceiling, so a long streak can't swallow the body

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
// `bodyAnim`/`bodyFrame` are what is drawn underneath — the overlay is placed
// against that frame's eye, not against the cell.
function drawEye(ctx, shooStreak, dx, dy, scale, bodyAnim, bodyFrame) {
  if (shooStreak < 1 || !sheet.complete) return;

  const i = Math.min(shooStreak, EYE_FRAMES.length) - 1;
  const e = EYE_FRAMES[i];
  const oc = EYE_CENTRE[i];
  const body = BODY_EYE[bodyAnim] || BODY_EYE.idle;
  const bc = body[bodyFrame % body.length];

  const grow = Math.min(EYE_GROWTH_MAX, 1 + (shooStreak - 1) * EYE_GROWTH);
  // Put the overlay's eyeball on the body's, then swell about that shared point.
  const ox = dx + (bc.x - oc.x * grow) * scale;
  const oy = dy + (bc.y - oc.y * grow) * scale;

  ctx.drawImage(
    sheet,
    e.col * CELL, e.row * CELL, CELL, CELL,
    ox, oy,
    FRAME * scale * grow,
    FRAME * scale * grow,
  );
}

function getAnim(name) { return ANIMS[name]; }
