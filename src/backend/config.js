// Streamer config: schema, validation, and persistence to config.json.
//
// SCHEMA is the single description of every tunable — adding a knob is one line
// here, and it flows to defaults, validation, and the API without further edits.
// Engine numbers are not restated: they come from engine.js DEFAULTS.
const fs = require('fs');
const path = require('path');
const { DEFAULTS: ENGINE } = require('./engine');

const FILE = path.join(__dirname, 'config.json');

const SCHEMA = {
  // Game logic
  trigger:            { enum: ['command', 'redeem', 'both'], default: 'command' },
  summonBy:           { enum: ['everyone', 'mods'], default: 'everyone' },
  // Which Channel Points reward counts. Matched case-insensitively as a
  // substring, so "Summon KawKaw!" still fires; blank means any reward.
  rewardTitle:        { text: true, maxLength: 80, default: 'KawKaw' },
  step:               { min: 0.01, max: 5,     default: ENGINE.step },
  decay:              { min: 0,    max: 0.9,   default: ENGINE.decay },
  maxSessionDuration: { min: 10,   max: 3600,  default: ENGINE.maxSessionDuration },
  perUserCap:         { min: 1,    max: 100,   default: ENGINE.perUserCap },
  terminalHoldMs:     { min: 500,  max: 30000, default: ENGINE.terminalHoldMs },

  // Rendering — 0–1 fractions of the overlay.
  // startPos is the *flee* end of the track (meter -10), not where KawKaw appears:
  // it emerges at meter 0, the midpoint. The keys predate that distinction.
  startPosX: { min: 0, max: 1, default: 0.10 },
  startPosY: { min: 0, max: 1, default: 0.70 },
  endPosX:   { min: 0, max: 1, default: 0.80 },
  endPosY:   { min: 0, max: 1, default: 0.70 },
  scale:     { min: 0.5, max: 10, default: 5 },
  // Sprite orientation. flipX is 0/1 rather than a boolean so it rides the same
  // clamp path as every other field instead of needing its own type.
  flipX:     { min: 0, max: 1, default: 1 },
  rotation:  { min: -180, max: 180, default: 0 },

  volume:    { min: 0, max: 100, default: 100 },   // percent
};

const ENGINE_KEYS = ['step', 'decay', 'maxSessionDuration', 'perUserCap', 'terminalHoldMs'];

function defaults() {
  const out = {};
  for (const [key, spec] of Object.entries(SCHEMA)) out[key] = spec.default;
  return out;
}

// Coerce one field. Returns undefined when the value can't be used at all, so the
// caller falls back to the default rather than letting NaN reach the engine.
function coerce(spec, value) {
  if (spec.enum) return spec.enum.includes(value) ? value : undefined;
  // Free text: trimmed and length-capped, since it reaches config.json and the
  // console. Blank is a real value here (= match any reward), not "unset".
  if (spec.text) return typeof value === 'string' ? value.trim().slice(0, spec.maxLength) : undefined;
  // Number('') and Number([]) are both 0, which would silently clamp to the
  // minimum. Treat blank and non-scalar input as "not provided" instead.
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(spec.max, Math.max(spec.min, n));   // clamp
}

// Validate arbitrary input into a complete config. Unknown keys are dropped and
// out-of-range numbers are clamped; `clamped` names the fields that were altered
// so the UI can show what actually got saved.
//
// Merges onto `base` (the current config) rather than replacing it, so a partial
// update — one setting from a CLI, say — leaves everything it didn't mention alone.
function validate(input, base = defaults()) {
  const out = { ...defaults(), ...base };
  const clamped = [];
  if (input && typeof input === 'object') {
    for (const [key, spec] of Object.entries(SCHEMA)) {
      if (!(key in input)) continue;
      const v = coerce(spec, input[key]);
      if (v === undefined) { clamped.push(key); continue; }
      const altered = spec.enum ? false : spec.text ? input[key] !== v : Number(input[key]) !== v;
      if (altered) clamped.push(key);
      out[key] = v;
    }
  }
  return { config: out, clamped };
}

function load() {
  try {
    return validate(JSON.parse(fs.readFileSync(FILE, 'utf8'))).config;
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('KawKaw: config.json unreadable, using defaults —', err.message);
    return defaults();
  }
}

// Write to a temp file and rename, so a crash mid-write can't leave a truncated
// config.json behind — rename is atomic within a filesystem.
function save(config) {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, FILE);
}

const engineConfig = (c) => Object.fromEntries(ENGINE_KEYS.map((k) => [k, c[k]]));

const renderConfig = (c) => ({
  startPos: { x: c.startPosX, y: c.startPosY },
  endPos:   { x: c.endPosX,   y: c.endPosY },
  scale:    c.scale,
  flipX:    c.flipX === 1,
  rotation: c.rotation,
  volume:   c.volume,
  // Also an engine key: the overlay needs it to time the exit animation so the
  // dig finishes exactly as the engine drops back to idle.
  terminalHoldMs: c.terminalHoldMs,
});

// Does this Channel Points reward count? Matched on the title rather than the
// reward id: the EventSub condition only accepts an id, which would mean a
// reward picker in the settings page and a stale id every time the streamer
// recreates the reward. Substring so "Summon KawKaw!" matches, blank = any.
function rewardMatches(config, title) {
  const want = (config.rewardTitle || '').toLowerCase();
  return !want || String(title ?? '').toLowerCase().includes(want);
}

module.exports = {
  SCHEMA, defaults, validate, load, save, engineConfig, renderConfig, rewardMatches, FILE,
};
