const { broadcast } = require('./broadcaster');

const DEFAULT_CONFIG = {
  intervalDuration: 10,
  callsToWin: 20,
  shooesToFlee: 5,
  maxSessionDuration: 300,
};

let config = { ...DEFAULT_CONFIG };

// Per-interval vote map: userId → 'call' | 'shoo'
const votes = new Map();

let state = idleState();
let intervalTimer = null;
let sessionTimer = null;
let sessionExpired = false;

// How long (ms) to hold the terminal phase before returning to idle
const TERMINAL_HOLD_MS = 5000;

function idleState() {
  return {
    phase: 'idle',
    position: null,
    eyeLevel: 0,
    consecutiveShoos: 0,
    totalCalls: 0,
    totalShoos: 0,
    lastAction: null,
    intervalCount: 0,
    votes: { shoo: 0, call: 0 },
    intervalEndsAt: null,
    outcome: null,
  };
}

function getState() {
  return { ...state, votes: { ...state.votes }, intervalDuration: config.intervalDuration };
}

function setConfig(incoming) {
  config = { ...DEFAULT_CONFIG, ...incoming };
}

function getConfig() {
  return { ...config };
}

function startSession() {
  if (state.phase !== 'idle') return false;

  votes.clear();
  sessionExpired = false;

  state = {
    phase: 'voting',
    position: config.callsToWin,
    eyeLevel: 0,
    consecutiveShoos: 0,
    totalCalls: 0,
    totalShoos: 0,
    lastAction: null,
    intervalCount: 0,
    votes: { shoo: 0, call: 0 },
    intervalEndsAt: Date.now() + config.intervalDuration * 1000,
    outcome: null,
  };

  broadcast(state);
  scheduleInterval();
  scheduleSessionExpiry();
  return true;
}

function castVote(userId, action) {
  if (state.phase !== 'voting') return false;

  votes.set(userId, action);

  let shoo = 0;
  let call = 0;
  for (const v of votes.values()) {
    if (v === 'shoo') shoo++;
    else call++;
  }
  state.votes = { shoo, call };
  broadcast(state);
  return true;
}

function resolveInterval() {
  state.phase = 'resolving';

  const { shoo, call } = state.votes;
  let action = null;
  if (call > shoo) action = 'call';
  else if (shoo > call) action = 'shoo';

  if (action === 'call') {
    state.position = Math.max(0, state.position - 1);
    state.eyeLevel = 0;
    state.consecutiveShoos = 0;
    state.totalCalls++;
    state.lastAction = 'call';
  } else if (action === 'shoo') {
    state.eyeLevel = Math.min(4, state.eyeLevel + 1);
    state.consecutiveShoos++;
    state.totalShoos++;
    state.lastAction = 'shoo';
  } else {
    // Tie or no votes — reset so the frontend doesn't re-trigger the previous action's animation
    state.lastAction = null;
  }

  const terminal = pickTerminal();

  state.intervalCount++;

  if (terminal) {
    clearTimeout(sessionTimer);
    state.phase = 'terminal';
    state.outcome = terminal;
    state.intervalEndsAt = null;
    broadcast(state);
    setTimeout(endSession, TERMINAL_HOLD_MS);
  } else {
    votes.clear();
    state.votes = { shoo: 0, call: 0 };
    state.phase = 'voting';
    state.intervalEndsAt = Date.now() + config.intervalDuration * 1000;
    broadcast(state);
    scheduleInterval();
  }
}

function pickTerminal() {
  if (state.position <= 0) return 'lick';
  if (state.consecutiveShoos >= config.shooesToFlee) return 'fled_sad';
  if (sessionExpired) return 'fled_confused';
  return null;
}

function endSession() {
  clearTimeout(intervalTimer);
  clearTimeout(sessionTimer);
  votes.clear();
  state = idleState();
  broadcast(state);
}

function scheduleInterval() {
  intervalTimer = setTimeout(resolveInterval, config.intervalDuration * 1000);
}

function scheduleSessionExpiry() {
  sessionTimer = setTimeout(() => {
    sessionExpired = true;
  }, config.maxSessionDuration * 1000);
}

module.exports = { getState, setConfig, getConfig, startSession, castVote, endSession, resolveInterval };
