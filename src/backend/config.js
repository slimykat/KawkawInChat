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
  step:               { min: 0.01, max: 5,     default: ENGINE.step },
  decay:              { min: 0,    max: 0.9,   default: ENGINE.decay },
  maxSessionDuration: { min: 10,   max: 3600,  default: ENGINE.maxSessionDuration },
  perUserCap:         { min: 1,    max: 100,   default: ENGINE.perUserCap },
  terminalHoldMs:     { min: 500,  max: 30000, default: ENGINE.terminalHoldMs },

  // Rendering — 0–1 fractions of the overlay
  startPosX: { min: 0, max: 1, default: 0.85 },
  startPosY: { min: 0, max: 1, default: 0.70 },
  endPosX:   { min: 0, max: 1, default: 0.15 },
  endPosY:   { min: 0, max: 1, default: 0.70 },
  scale:     { min: 0.5, max: 10, default: 3 },
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
      if (!spec.enum && Number(input[key]) !== v) clamped.push(key);
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
});

module.exports = { SCHEMA, defaults, validate, load, save, engineConfig, renderConfig, FILE };
