// ponytail: plain node:assert, no framework, no deps
'use strict';
const assert = require('node:assert/strict');
const { getState, setConfig, startSession, castVote, endSession, resolveInterval } = require('./state');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
    passed++;
  } catch (e) {
    console.error(`FAIL  ${name}`);
    console.error(`      ${e.message}`);
    failed++;
  }
}

function reset() {
  endSession(); // returns to idle, clears timers
}

// ── 1. startSession from idle ─────────────────────────────────────────────────
test('startSession sets phase voting and position=callsToWin', () => {
  setConfig({ callsToWin: 5, shooesToFlee: 3, intervalDuration: 60, maxSessionDuration: 600 });
  startSession();
  const s = getState();
  assert.equal(s.phase, 'voting');
  assert.equal(s.position, 5);
  reset();
});

// ── 2. startSession is a no-op when not idle ──────────────────────────────────
test('startSession returns false when already voting', () => {
  setConfig({ callsToWin: 5, shooesToFlee: 3, intervalDuration: 60, maxSessionDuration: 600 });
  startSession();
  const result = startSession();
  assert.equal(result, false);
  assert.equal(getState().phase, 'voting');
  reset();
});

// ── 3. Switching vote doesn't double-count ────────────────────────────────────
test('same userId switching vote overwrites; total stays 1', () => {
  setConfig({ callsToWin: 5, shooesToFlee: 3, intervalDuration: 60, maxSessionDuration: 600 });
  startSession();
  castVote('user1', 'shoo');
  castVote('user1', 'call'); // flip
  const s = getState();
  assert.equal(s.votes.call, 1);
  assert.equal(s.votes.shoo, 0);
  reset();
});

// ── 4. Call majority → position -1, eyeLevel 0, consecutiveShoos 0 ───────────
test('call majority decrements position, resets eyeLevel and consecutiveShoos', () => {
  setConfig({ callsToWin: 5, shooesToFlee: 3, intervalDuration: 60, maxSessionDuration: 600 });
  startSession();
  // push eyeLevel up first so we can verify it resets
  castVote('u1', 'shoo');
  resolveInterval();
  assert.equal(getState().eyeLevel, 1);
  // now call majority
  castVote('u1', 'call');
  resolveInterval();
  const s = getState();
  assert.equal(s.lastAction, 'call');
  assert.equal(s.eyeLevel, 0);
  assert.equal(s.consecutiveShoos, 0);
  assert.equal(s.position, 4); // started at 5, shoo doesn't change position, call -1 → 4
  reset();
});

// ── 5. Shoo majority → eyeLevel +1, consecutiveShoos +1 ──────────────────────
test('shoo majority increments eyeLevel and consecutiveShoos', () => {
  setConfig({ callsToWin: 5, shooesToFlee: 10, intervalDuration: 60, maxSessionDuration: 600 });
  startSession();
  castVote('u1', 'shoo');
  castVote('u2', 'shoo');
  castVote('u3', 'call');
  resolveInterval();
  const s = getState();
  assert.equal(s.lastAction, 'shoo');
  assert.equal(s.eyeLevel, 1);
  assert.equal(s.consecutiveShoos, 1);
  assert.equal(s.totalShoos, 1);
  reset();
});

// ── 6. Call after shoos resets consecutiveShoos and eyeLevel ─────────────────
test('call after shoo resets consecutiveShoos and eyeLevel to 0', () => {
  setConfig({ callsToWin: 5, shooesToFlee: 10, intervalDuration: 60, maxSessionDuration: 600 });
  startSession();
  // two shoo intervals
  castVote('u1', 'shoo'); resolveInterval();
  castVote('u1', 'shoo'); resolveInterval();
  assert.equal(getState().consecutiveShoos, 2);
  assert.equal(getState().eyeLevel, 2);
  // one call interval
  castVote('u1', 'call'); resolveInterval();
  const s = getState();
  assert.equal(s.consecutiveShoos, 0);
  assert.equal(s.eyeLevel, 0);
  reset();
});

// ── 7. Tie → lastAction null, position unchanged ──────────────────────────────
test('tie vote leaves lastAction null and position unchanged', () => {
  setConfig({ callsToWin: 5, shooesToFlee: 10, intervalDuration: 60, maxSessionDuration: 600 });
  startSession();
  const before = getState().position;
  castVote('u1', 'call');
  castVote('u2', 'shoo'); // tie
  resolveInterval();
  const s = getState();
  assert.equal(s.lastAction, null);
  assert.equal(s.position, before);
  assert.equal(s.eyeLevel, 0);
  reset();
});

// ── 8. Terminal 'lick': position reaches 0 ───────────────────────────────────
test("terminal 'lick' when position reaches 0", () => {
  setConfig({ callsToWin: 2, shooesToFlee: 10, intervalDuration: 60, maxSessionDuration: 600 });
  startSession();
  castVote('u1', 'call'); resolveInterval(); // position → 1
  castVote('u1', 'call'); resolveInterval(); // position → 0 → lick
  const s = getState();
  assert.equal(s.phase, 'terminal');
  assert.equal(s.outcome, 'lick');
  reset(); // clears the 5s TERMINAL_HOLD_MS timer
});

// ── 9. Terminal 'fled_sad': consecutiveShoos >= shooesToFlee ─────────────────
test("terminal 'fled_sad' after shooesToFlee consecutive shoos", () => {
  setConfig({ callsToWin: 20, shooesToFlee: 2, intervalDuration: 60, maxSessionDuration: 600 });
  startSession();
  castVote('u1', 'shoo'); resolveInterval(); // consecutiveShoos → 1
  castVote('u1', 'shoo'); resolveInterval(); // consecutiveShoos → 2 >= 2 → fled_sad
  const s = getState();
  assert.equal(s.phase, 'terminal');
  assert.equal(s.outcome, 'fled_sad');
  reset();
});

// ── summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
