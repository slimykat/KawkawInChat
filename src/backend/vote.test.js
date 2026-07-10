const assert = require('node:assert');
const crypto = require('crypto');
const { verifyExtensionJwt } = require('./routes/vote');

// ── Helpers ───────────────────────────────────────────────────────────────────

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function mintToken(payload, secretBase64) {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body   = b64url(Buffer.from(JSON.stringify(payload)));
  const sig    = b64url(
    crypto.createHmac('sha256', Buffer.from(secretBase64, 'base64'))
          .update(`${header}.${body}`)
          .digest()
  );
  return `${header}.${body}.${sig}`;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const secret = crypto.randomBytes(32).toString('base64');
const wrongSecret = crypto.randomBytes(32).toString('base64');
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

// 1. Valid token with future exp
check('valid token returns claims with opaque_user_id', () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = mintToken({ opaque_user_id: 'U123', exp }, secret);
  const claims = verifyExtensionJwt(token, secret);
  assert.ok(claims, 'expected claims object');
  assert.strictEqual(claims.opaque_user_id, 'U123');
});

// 2. Tampered payload → null
check('tampered payload returns null', () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = mintToken({ opaque_user_id: 'U123', exp }, secret);
  const parts = token.split('.');
  // Flip a char in the payload segment
  parts[1] = parts[1][0] === 'A' ? 'B' + parts[1].slice(1) : 'A' + parts[1].slice(1);
  assert.strictEqual(verifyExtensionJwt(parts.join('.'), secret), null);
});

// 3. Wrong secret → null
check('wrong secret returns null', () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = mintToken({ opaque_user_id: 'U123', exp }, secret);
  assert.strictEqual(verifyExtensionJwt(token, wrongSecret), null);
});

// 4. Expired token → null
check('expired token returns null', () => {
  const exp = Math.floor(Date.now() / 1000) - 1; // 1 second in the past
  const token = mintToken({ opaque_user_id: 'U123', exp }, secret);
  assert.strictEqual(verifyExtensionJwt(token, secret), null);
});

// 5. Malformed string → null
check('malformed token "abc" returns null', () => {
  assert.strictEqual(verifyExtensionJwt('abc', secret), null);
});

// 6. Empty secret → null (never reaches crypto)
check('empty secret returns null for valid token', () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = mintToken({ opaque_user_id: 'U123', exp }, secret);
  assert.strictEqual(verifyExtensionJwt(token, ''), null);
});

// 7. Exploit token: signed with empty-buffer key + empty secret → null
check('exploit token signed with empty key is rejected', () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  // mintToken uses Buffer.from('', 'base64') = 0-byte key — the exact exploit
  const exploitToken = mintToken({ opaque_user_id: 'ATTACKER', exp }, '');
  assert.strictEqual(verifyExtensionJwt(exploitToken, ''), null);
});

// 8. Token with no exp field → null
check('token missing exp returns null', () => {
  const token = mintToken({ opaque_user_id: 'U123' }, secret); // no exp
  assert.strictEqual(verifyExtensionJwt(token, secret), null);
});

// ── Result ────────────────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
} else {
  console.log('\nAll tests passed.');
}
