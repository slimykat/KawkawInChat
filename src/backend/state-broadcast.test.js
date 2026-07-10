// ponytail: node:assert only — tests Change 1 (intervalDuration in payload) + Change 2 (coalesce)
'use strict';
const assert = require('node:assert/strict');
const { addClient, removeClient } = require('./broadcaster');
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

function testAsync(name, fn) {
  return fn().then(() => {
    console.log(`PASS  ${name}`);
    passed++;
  }).catch((e) => {
    console.error(`FAIL  ${name}`);
    console.error(`      ${e.message}`);
    failed++;
  });
}

function fakeWs() {
  const ws = { readyState: 1, messages: [], send(m) { this.messages.push(JSON.parse(m)); } };
  return ws;
}

// ── Change 1: intervalDuration in broadcast payload ───────────────────────────

test('getState() includes numeric intervalDuration after startSession', () => {
  setConfig({ callsToWin: 5, shooesToFlee: 3, intervalDuration: 42, maxSessionDuration: 600 });
  startSession();
  assert.equal(typeof getState().intervalDuration, 'number');
  assert.equal(getState().intervalDuration, 42);
  endSession();
});

test('getState() includes intervalDuration after resolveInterval (continue)', () => {
  setConfig({ callsToWin: 5, shooesToFlee: 10, intervalDuration: 30, maxSessionDuration: 600 });
  startSession();
  castVote('u1', 'call');
  resolveInterval();
  const s = getState();
  assert.equal(typeof s.intervalDuration, 'number');
  assert.equal(s.intervalDuration, 30);
  endSession();
});

test('broadcast payload after startSession includes intervalDuration', () => {
  const ws = fakeWs();
  addClient(ws);
  setConfig({ callsToWin: 5, shooesToFlee: 3, intervalDuration: 15, maxSessionDuration: 600 });
  startSession();
  removeClient(ws);
  endSession();
  const msg = ws.messages.find(m => m.type === 'state_update' && m.state.phase === 'voting');
  assert.ok(msg, 'expected a voting state_update broadcast');
  assert.equal(msg.state.intervalDuration, 15);
});

test('broadcast payload after resolveInterval (continue) includes intervalDuration', () => {
  const ws = fakeWs();
  addClient(ws);
  setConfig({ callsToWin: 5, shooesToFlee: 10, intervalDuration: 25, maxSessionDuration: 600 });
  startSession();
  castVote('u1', 'call');
  resolveInterval();
  removeClient(ws);
  endSession();
  // The continue-path broadcast is a voting phase with intervalCount > 0
  const msg = ws.messages.find(m => m.type === 'state_update' && m.state.phase === 'voting' && m.state.intervalCount > 0);
  assert.ok(msg, 'expected continued voting broadcast');
  assert.equal(msg.state.intervalDuration, 25);
});

// ── Change 2: coalesce vote broadcasts ────────────────────────────────────────

const p1 = testAsync('5 rapid castVotes: 0 immediate WS messages, exactly 1 after ~150ms', () => {
  return new Promise((resolve, reject) => {
    const ws = fakeWs();
    addClient(ws);
    setConfig({ callsToWin: 20, shooesToFlee: 10, intervalDuration: 60, maxSessionDuration: 600 });
    startSession();
    const beforeCount = ws.messages.length; // startSession broadcast already happened

    // 5 rapid votes
    castVote('a', 'call');
    castVote('b', 'call');
    castVote('c', 'shoo');
    castVote('d', 'call');
    castVote('e', 'shoo');

    const afterSync = ws.messages.length;
    // No new messages should have arrived synchronously
    try {
      assert.equal(afterSync, beforeCount, `expected 0 immediate vote broadcasts, got ${afterSync - beforeCount}`);
    } catch (e) {
      removeClient(ws);
      endSession();
      return reject(e);
    }

    setTimeout(() => {
      const afterFlush = ws.messages.length;
      removeClient(ws);
      endSession();
      try {
        assert.equal(afterFlush, beforeCount + 1, `expected exactly 1 coalesced broadcast, got ${afterFlush - beforeCount}`);
        resolve();
      } catch (e) {
        reject(e);
      }
    }, 150);
  });
});

// ── summary ───────────────────────────────────────────────────────────────────

p1.then(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});
