// Runnable self-check: `node meter.test.js`. No framework — assert only.
const assert = require('assert');
const { createEngine } = require('./meter.js');

// Fixed clock so decay/terminal timing is deterministic.
let t = 0;
const at = (ms) => (t = ms);

// step 1.0 keeps the math easy; no decay; small session for timeout test.
const e = createEngine({ step: 1, decay: 0, perUserCap: 3, maxSessionDuration: 10, terminalHoldMs: 1000 });

// Idle: commands and ticks do nothing.
e.command('u1', 'call');
assert.equal(e.tick(at(0)), false, 'idle tick is a no-op');
assert.equal(e.getState().phase, 'idle');

// Start, then two callers push the meter up by net 2 (capped fine).
assert.equal(e.start(at(0)), true);
e.command('u1', 'call');
e.command('u2', 'call');
assert.equal(e.tick(at(1000)), true);
assert.equal(e.getState().meter, 2, 'net +2 at step 1');
assert.equal(e.getState().shooStreak, 0);

// Per-user cap: one user spamming 10 calls counts as at most +3.
e.command('u1', 'call'); // single call from u1
for (let i = 0; i < 10; i++) e.command('u3', 'call'); // u3 spams — capped
e.tick(at(2000));
assert.equal(e.getState().meter, 2 + (1 + 3), 'u1 +1, u3 capped at +3');

// Shoo streak grows on net-shoo ticks, resets on a call tick.
e.command('u1', 'shoo'); e.tick(at(3000));
e.command('u1', 'shoo'); e.tick(at(4000));
assert.equal(e.getState().shooStreak, 2, 'two consecutive shoo ticks');
e.command('u1', 'call'); e.tick(at(5000));
assert.equal(e.getState().shooStreak, 0, 'a call tick resets the streak');

// Lick terminal: drive meter to +10, stopping once it resolves.
e.reset(); e.start(at(0));
let s = 0;
while (e.getState().phase === 'active' && s < 30) {
  for (let i = 0; i < 3; i++) e.command('a' + i, 'call');
  e.tick(at(++s * 1000));
}
const term = s * 1000;
assert.equal(e.getState().phase, 'terminal');
assert.equal(e.getState().outcome, 'lick', 'reaching +10 is a lick');
// Terminal holds, then returns to idle.
assert.equal(e.tick(at(term + 500)), false, 'terminal holds within terminalHoldMs');
assert.equal(e.tick(at(term + 1100)), true);
assert.equal(e.getState().phase, 'idle', 'returns to idle after hold');

// Confused terminal: no input, session times out at maxSessionDuration.
e.reset(); e.start(at(0));
assert.equal(e.tick(at(9000)), true);
assert.equal(e.getState().outcome, null, 'not yet timed out');
e.tick(at(10000));
assert.equal(e.getState().outcome, 'flee_confused', 'timeout with neutral meter → confused');

console.log('meter.test.js: all assertions passed');
