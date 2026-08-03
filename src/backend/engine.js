// KawKaw engine — the single source of game logic. Pure: no DOM, no timers, no I/O.
// The caller feeds commands and drives one tick per second.
//
//   meter ∈ [-10, +10]   -10 = Flee, +10 = Lick
//   shooStreak            consecutive net-shoo ticks; resets on any call tick
//
// State object (see DESIGN.md):
//   { phase, meter, push, shooStreak, outcome, endsAt }

const DEFAULTS = {
  step: 0.5,               // meter units per net command per tick
  decay: 0.05,             // fraction the meter relaxes toward 0 each tick
  maxSessionDuration: 300, // seconds before a stalled session → confused flee
  perUserCap: 5,           // max net commands counted per viewer per tick
  terminalHoldMs: 5000,    // how long to hold a terminal before returning to idle
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function idleState() {
  return { phase: 'idle', meter: 0, push: 0, shooStreak: 0, outcome: null, endsAt: null };
}

function createEngine(config = {}) {
  let cfg = { ...DEFAULTS, ...config };
  let state = idleState();
  let buffer = new Map();    // userId → { call, shoo } accumulated this tick
  let terminalUntil = null;  // wall-clock ms to hold terminal before idle

  // Staged, not applied live — start() picks it up, so retuning can never yank
  // the meter out from under viewers mid-encounter.
  let pending = null;
  function setConfig(next = {}) { pending = { ...DEFAULTS, ...next }; }

  function start(now = Date.now()) {
    if (state.phase !== 'idle') return false;
    if (pending) { cfg = pending; pending = null; }
    buffer.clear();
    terminalUntil = null;
    state = { phase: 'active', meter: 0, push: 0, shooStreak: 0, outcome: null,
              endsAt: now + cfg.maxSessionDuration * 1000 };
    return true;
  }

  // Record one raw command. Spam counts (capped per-user at tick time).
  function command(userId, action) {
    if (state.phase !== 'active') return;
    if (action !== 'call' && action !== 'shoo') return;
    let u = buffer.get(userId);
    if (!u) buffer.set(userId, (u = { call: 0, shoo: 0 }));
    u[action]++;
  }

  // Advance one tick. Returns true if state changed (caller broadcasts).
  function tick(now = Date.now()) {
    if (state.phase === 'terminal') {
      if (terminalUntil != null && now >= terminalUntil) { state = idleState(); return true; }
      return false;
    }
    if (state.phase !== 'active') return false;

    // Sum capped per-user contributions, then clear the buffer.
    let push = 0;
    for (const { call, shoo } of buffer.values()) {
      push += clamp(call - shoo, -cfg.perUserCap, cfg.perUserCap);
    }
    buffer.clear();

    const meter = clamp(state.meter * (1 - cfg.decay) + push * cfg.step, -10, 10);
    const shooStreak = push > 0 ? 0 : push < 0 ? state.shooStreak + 1 : state.shooStreak;
    state = { ...state, meter, push, shooStreak };

    let outcome = null;
    if (meter >= 10) outcome = 'lick';
    else if (meter <= -10) outcome = 'flee_sad';
    else if (now >= state.endsAt) outcome = 'flee_confused';

    if (outcome) {
      state = { ...state, phase: 'terminal', outcome, endsAt: null };
      terminalUntil = now + cfg.terminalHoldMs;
    }
    return true;
  }

  function reset() { buffer.clear(); terminalUntil = null; state = idleState(); }
  function getState() { return { ...state }; }

  return { start, command, tick, getState, reset, setConfig, get config() { return cfg; } };
}

module.exports = { createEngine, DEFAULTS };
