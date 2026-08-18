# Devlog

What was believed, what turned out to be true, and what changed. Grounded in the
commit history rather than memory.

> **Staging note.** This will split so each area carries its own devlog
> (`src/backend/DEVLOG.md`, `src/overlay/DEVLOG.md`, …) with the README pointing
> at them. Until then it lives here, one `##` per section, nothing
> cross-referencing except through the timeline — so the split is a clean cut.

---

## Architecture evolution

Three rewrites, each because a load-bearing assumption stopped being true.

### 1. Voting on an interval → one shared meter

*`84bd54f`*

Viewers clicked Call/Shoo buttons and a majority resolved every few seconds.
Tuning it exposed the problem: `intervalDuration` dropped 10s → 3s chasing a
button-mashing feel, and "20 cumulative calls vs 5 consecutive shoos" was an
asymmetry that needed a paragraph of documentation to explain (`ee22847`). The
mechanic was fighting its own representation.

Replacing it with a single meter made the rules one sentence — net commands per
second move a number between two ends — and deleted the interval concept
entirely. Chat commands replaced buttons, which removed the vote UI too.

### 2. Twitch Extension + relay bot → one local backend

*`3a62dba`*

The Extension existed for exactly one reason: Channel Points redemptions arrive
over an authenticated EventSub subscription, and a browser page cannot hold one.
That forced a split where the overlay and the bot each ran their own copy of the
engine, kept in sync by hand.

EventSub over **WebSocket** dissolved the premise. The backend dials out, receives
a session id, subscribes with it, and events come back down the socket it opened.
No public URL, no tunnel, no webhook signature. Once a local process could hold the
trigger, the Extension had no job left — and it had been costing PubSub fan-out,
extension JWTs, a CDN upload, and a Twitch review of Deltarune assets that were
never ours.

The lesson that generalises: **the constraint that justifies an architecture is
worth re-checking periodically.** This one had quietly expired.

The embarrassing footnote: both Extension code paths were already dead.
`twitch-ext.min.js` was never loaded, so `window.Twitch` was permanently
undefined. A whole architecture had been carried for a feature that never once
ran.

### 3. Tuning out of `.env` into a schema

*`ca385ac`*

`.env` held game tuning, which meant a streamer edited a dotfile and restarted to
change how hard chat has to push. `.env` should hold identity and secrets — things
set once by an installer — and nothing else.

Settings moved to `config.json` behind a `SCHEMA` in `config.js` that is the single
description of every tunable: defaults, ranges, and validation all derive from it,
so adding a knob is one entry plus markup. Engine defaults are not restated; they
come from `engine.js`.

---

## Backend

**The engine owns the truth, and it is boring on purpose.** `engine.js` is pure —
no DOM, no timers, no I/O. The caller feeds commands and drives one tick per
second. That makes the game logic trivially testable and means the overlay can be
a pure renderer that holds no state of its own.

**Config that reaches an engine must be coerced, not trusted.** `Number('')` and
`Number([])` are both `0`, which would silently clamp a blank field to a minimum
rather than leaving it unset. Blank reads as "not provided"; unknown keys are
dropped; updates merge onto current config so a partial write cannot drop a field
it never mentioned. `config.json` is written temp-then-rename so a crash cannot
truncate it.

**Silence is not evidence.** The redeem path logged all four outcomes — wrong
trigger, title mismatch, started, already on screen — while the chat path logged
nothing at all. So a `!kawkaw` that never arrived and one that arrived and was
gated looked identical from the console. A whole debugging session went into the
backend before the fault turned out to be in the overlay (`dcecafb`). Any branch
that can silently decline to act should say so.

**Tokens are refreshed lazily, and that is fine.** There is no refresh timer. The
5-minute constant is a *margin* — refresh if the token expires within it — and it
only runs when something calls Helix, which happens at connect and on
re-subscribe. In steady state the token sits unused and often expired for hours,
because the subscription, once created, delivers events without it.

**Known gaps, written down rather than forgotten.** A `revocation` message is only
logged; nothing re-subscribes, so the socket stays open delivering nothing. The
stored OAuth `scope` is saved but never validated against the scopes the code
needs, so a token from an older scope list would refresh happily and fail at call
time.

---

## Overlay

**Plain `<script>` tags share one global scope.** A `const anim` helper added to
`sprites.js` collided with `game.js`'s existing `let anim`. Redeclaration is a
*parse-time* error, so the browser discarded the whole of `game.js` — no render
loop, no state handler. The overlay still loaded, still opened its WebSocket, and
still received every update, with nothing listening. From the stream it looked
exactly like a broken chat trigger (`01485cf`).

The fix was a rename; the useful part was the guard. `overlay.test.js`
concatenates the scripts in the order `index.html` loads them and compiles the
result, reproducing the browser's scope rules without a browser — and asserts that
list still matches the HTML, so adding a file cannot bypass the check.

**Measure the art; do not infer it.** The hand-drawn sheet is 3600×3600 where the
original was 573×533, and neither ratio is clean. The cell size was found by
measuring ink coverage across candidates: 480 uniquely captures 100% of the
sheet's ink, and independently lands the eye's centre at the same fraction of its
cell as the sheet it was drawn over (`164e00e`).

**Design space is not source space.** Sprites stay 50×50 in *design* units no
matter what resolution the art is exported at, so `scale` in a saved streamer
config keeps its meaning. Without that split, pointing the overlay at the new
sheet would have rendered everything 9.6× too large and invalidated every saved
config. Re-exporting the art now moves one constant.

**Nearest-neighbour is for integer upscales only.** `imageSmoothingEnabled` was
`false`, correct for pixel art scaled up by whole numbers. The hand-drawn cells are
scaled *down* to roughly half size, where nearest-neighbour discards half the
linework. It is now `true`.

**A wrong measurement is more dangerous than no measurement.** A frame-counting
script used a fixed `>200px` ink threshold on both sheets. A 480px cell holds
230,400 pixels; a 51px cell holds 2,601. Small frames on the old sheet fell under
the threshold, and the script confidently reported that `dig` was new and that the
old sheet's eye row had zero frames — an obvious falsehood that should have been
caught immediately. Re-measuring ink as a *percentage of cell area* showed both
sheets had four dig frames all along. Only a user correction caught it.

**Hand-drawn frames do not register.** The eye wanders about 2 design px across
the idle cycle, and `happy`'s sits nearly 4px higher again. The eye-overlay cells
wander with it, because each was drawn over a different idle frame — but the code
picked the overlay frame from `shooStreak` and the body frame from the idle loop,
two unrelated clocks. Eye frame 2 landed on idle frame 0 routinely (`4059d32`).

The fix was to stop treating either as an offset from the other: both are now
absolute eyeball centres measured off the sheet, and the draw aligns one onto the
other before scaling about that shared point. This also retired a "grow the eye
until it covers" hack added while the fault was misread as a sizing problem —
aligned, the overlay covers at 1.010.

**Frame counts drifted from the art.** `idle`, `emerge`, `tongue` and `dig` each
declared one frame fewer than the sheet held, so every one cut its last frame.
Pre-existing on the pixel sheet too; it only became visible once the art carried
detail (`d5981df`).

**Resolution independence is cheaper than it looks.** The canvas reads its own
size from the browser source each frame rather than assuming 1280×720, and scales
by one factor derived from a 720p design height. Positions are fractions, so they
need no reference resolution at all (`0f78452`).

---

## Assets and licensing

**Non-commercial is about commercial context, not price tag.** Channel Points are
free and non-purchasable, so triggering on them is not monetization. A monetized
channel is the ordinary condition of all streaming and does not change that. The
line is monetizing *the interaction itself* — Bits, sub-gating, charging for the
tool. That line is not crossed and must not be.

**Redistribution is a separate axis from monetization,** and it was the one that
actually mattered. A public repo hands the assets to every cloner regardless of
revenue. Realising these were two questions, not one, is what made the problem
tractable: the sprite was solved by redrawing it, and the audio by never shipping
it.

**Gitignoring is not removal.** The assets were in the initial commit, so
`.gitignore` alone would have left them in history for anyone who cloned. It took
a `filter-branch`, cleared `refs/original`, an expired reflog and a `gc
--prune=now` — verified afterwards by confirming no asset blob remains and `git
fsck` reports nothing unreachable (`6c3afe0`).

**A wiki's licence does not cover what the wiki does not own.** The Deltarune
wiki is CC BY-SA 4.0, which covers contributor-written text — not the game
sprites and audio it hosts. Nobody can license rights they do not hold. The
article prose really is reusable with attribution, but ShareAlike is viral, so
writing your own paragraph is usually cheaper than inheriting the obligation.

**Mechanics were never the exposure.** Game systems and rules sit on the idea side
of the idea/expression line and are not copyrightable. Recreating the encounter
was fine throughout; only the *assets* ever needed solving.

**The README GIF is rendered, not recorded.** `assets/demo.gif` is composed
offline from the sheet by a throwaway PIL script rather than screen-captured, so
it gets exact frame timing and a transparent background. The script is not in the
repo on purpose: it has to duplicate `CELL`, `FRAME`, `BODY_EYE` and `EYE_CENTRE`
from `sprites.js`, and a tracked copy would go quietly stale the first time the
art is redrawn. Rewriting it against the current tables is the cheaper half.

The white outline around the sprite is in the art itself — those edge pixels are
opaque and near-white, not soft alpha — so it survives GIF's 1-bit alpha, and
raising the cutout threshold only punches holes in the eye.

**The resolution.** The sprite is original art and ships with the repo. The voice
clips stay out permanently, with extraction instructions for anyone who owns the
game. Nothing copyrighted is redistributed, and a clone works — silently — out of
the box.

---

## Onboarding

**A process that exits cannot guide you.** The backend called `process.exit(1)` on
a missing `CHANNEL`, so there was no way to walk anyone through setup from the UI:
it died before it could serve a page. Treating a missing channel as "not set up
yet" rather than as an error is what made a browser-based setup possible at all
(`3e416f1`).

**Applying config live needs more than writing the file.** Two things bit.
`connectChat` ran at module scope and captured `CHANNEL` at require time, so it
had to become a function. `createAuth` closes over the client id and secret, so
changing credentials means rebuilding it — updating `process.env` alone leaves
stale values in the closure and the next Helix call quietly uses them.

**Put the status where the person is looking.** The authorization link was printed
to a terminal a streamer never reads. `/api/status` and an Authorize button moved
it to the page they are already on. The same route reports whether the sprite and
sound files exist — the overlay degrades silently when they are missing, which
until then left a blank source with no explanation anywhere.

**A silent failure state should be spelled out somewhere a human will look.** That
is the through-line of both the chat-logging fix and the asset status: the code
handled every one of these cases correctly and said nothing, which is
indistinguishable from being broken.

**Missing is not the same as broken.** Audio absence is the *normal* state of a
fresh clone, so it reports once as a fact rather than eight `console.warn`s, and
the volume control hides rather than sitting there doing nothing.
