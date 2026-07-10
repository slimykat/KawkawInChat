// ponytail: node:assert only — unit tests validateConfig pure function
'use strict';
const assert = require('node:assert/strict');
const { validateConfig } = require('./config');

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

// ── valid cases ───────────────────────────────────────────────────────────────

test('valid full config returns normalized numbers', () => {
  const r = validateConfig({ intervalDuration: '30', callsToWin: 10, shooesToFlee: 5, maxSessionDuration: 300 });
  assert.ok(r !== null);
  assert.equal(r.intervalDuration, 30);
  assert.equal(r.callsToWin, 10);
  assert.equal(r.shooesToFlee, 5);
  assert.equal(r.maxSessionDuration, 300);
});

test('empty body returns empty object (not null)', () => {
  const r = validateConfig({});
  assert.ok(r !== null);
  assert.deepEqual(r, {});
});

test('partial body — only intervalDuration — is valid', () => {
  const r = validateConfig({ intervalDuration: 60 });
  assert.ok(r !== null);
  assert.equal(r.intervalDuration, 60);
});

test('boundary values accepted: intervalDuration 1 and 3600', () => {
  assert.ok(validateConfig({ intervalDuration: 1 }) !== null);
  assert.ok(validateConfig({ intervalDuration: 3600 }) !== null);
});

test('boundary values accepted: callsToWin 1 and 1000', () => {
  assert.ok(validateConfig({ callsToWin: 1 }) !== null);
  assert.ok(validateConfig({ callsToWin: 1000 }) !== null);
});

// ── invalid cases → null ──────────────────────────────────────────────────────

test('intervalDuration 0 → null', () => {
  assert.equal(validateConfig({ intervalDuration: 0 }), null);
});

test('intervalDuration negative → null', () => {
  assert.equal(validateConfig({ intervalDuration: -5 }), null);
});

test('intervalDuration NaN string "abc" → null', () => {
  assert.equal(validateConfig({ intervalDuration: 'abc' }), null);
});

test('intervalDuration empty string "" → null', () => {
  assert.equal(validateConfig({ intervalDuration: '' }), null);
});

test('intervalDuration over cap 3601 → null', () => {
  assert.equal(validateConfig({ intervalDuration: 3601 }), null);
});

test('callsToWin 0 → null', () => {
  assert.equal(validateConfig({ callsToWin: 0 }), null);
});

test('callsToWin over cap 1001 → null', () => {
  assert.equal(validateConfig({ callsToWin: 1001 }), null);
});

test('shooesToFlee 0 → null', () => {
  assert.equal(validateConfig({ shooesToFlee: 0 }), null);
});

test('maxSessionDuration over cap 86401 → null', () => {
  assert.equal(validateConfig({ maxSessionDuration: 86401 }), null);
});

test('Infinity → null', () => {
  assert.equal(validateConfig({ intervalDuration: Infinity }), null);
});

test('one bad field among otherwise-valid fields → null', () => {
  assert.equal(validateConfig({ intervalDuration: 30, callsToWin: 0 }), null);
});

// ── router is still an express router + validateConfig attached ───────────────

test('require config router is a function with validateConfig', () => {
  const router = require('./config');
  assert.equal(typeof router, 'function');
  assert.equal(typeof router.validateConfig, 'function');
});

// ── summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
