// ponytail: node:assert + crypto only, no framework
'use strict';
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { signPubSubJwt, broadcast, setChannelId } = require('./broadcaster');
const { verifyExtensionJwt } = require('./routes/vote');

let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (e) {
    console.error(`  FAIL  ${name}: ${e.message}`);
    failures++;
  }
}

const secret = crypto.randomBytes(32).toString('base64');

// 1. signPubSubJwt produces a valid, verifiable JWT
check('signPubSubJwt claims round-trip via verifyExtensionJwt', () => {
  const token = signPubSubJwt(secret, 'owner123', '456');
  const claims = verifyExtensionJwt(token, secret);
  assert.ok(claims, 'expected claims object');
  assert.equal(claims.role, 'external');
  assert.equal(claims.channel_id, '456');
  assert.ok(Array.isArray(claims.pubsub_perms?.send) && claims.pubsub_perms.send.includes('broadcast'));
  assert.ok(claims.exp > Math.floor(Date.now() / 1000), 'exp must be in the future');
});

// 2. Tampered secret → null
check('signPubSubJwt token rejected by different secret', () => {
  const token = signPubSubJwt(secret, 'owner123', '456');
  const badSecret = crypto.randomBytes(32).toString('base64');
  assert.equal(verifyExtensionJwt(token, badSecret), null);
});

// 3. broadcast() is fail-safe with no creds and no WS clients
check('broadcast() does not throw with no creds and no clients', () => {
  // Ensure env vars are absent
  delete process.env.TWITCH_CLIENT_ID;
  delete process.env.TWITCH_EXTENSION_SECRET;
  delete process.env.TWITCH_EXTENSION_OWNER_ID;
  setChannelId(null);
  // Must not throw; broadcastPubSub skips due to missing creds
  assert.doesNotThrow(() => broadcast({ phase: 'idle' }));
});

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll tests passed.');
}
