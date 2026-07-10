const express = require('express');
const crypto = require('crypto');
const { castVote } = require('../state');

const router = express.Router();

// ponytail: no external JWT lib — crypto only, mirrors eventsub.js pattern
function verifyExtensionJwt(token, base64Secret) {
  if (!base64Secret) return null; // ponytail: fail-closed — empty/missing secret forges valid HMACs
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, sigB64] = parts;
  const key = Buffer.from(base64Secret, 'base64');

  // Verify signature
  const expectedSigB64 = crypto
    .createHmac('sha256', key)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');

  try {
    const sigOk = crypto.timingSafeEqual(
      Buffer.from(expectedSigB64),
      Buffer.from(sigB64)
    );
    if (!sigOk) return null;
  } catch {
    return null;
  }

  // Decode payload (base64url → utf8 → JSON)
  const payloadJson = Buffer.from(
    payloadB64.replace(/-/g, '+').replace(/_/g, '/').padEnd(
      payloadB64.length + (4 - payloadB64.length % 4) % 4, '='
    ),
    'base64'
  ).toString('utf8');

  let claims;
  try {
    claims = JSON.parse(payloadJson);
  } catch {
    return null;
  }

  if (!claims.exp || claims.exp * 1000 <= Date.now()) return null; // ponytail: require exp — no exp = fail-closed

  return claims;
}

router.post('/', express.json(), (req, res) => {
  const { action, userId: bodyUserId } = req.body ?? {};

  if (!['call', 'shoo'].includes(action)) {
    return res.status(400).json({ error: 'Invalid vote' });
  }

  const authHeader = req.headers['authorization'];
  let userId;

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const claims = verifyExtensionJwt(token, process.env.TWITCH_EXTENSION_SECRET ?? '');
    if (!claims) return res.status(401).json({ error: 'Invalid token' });
    userId = claims.opaque_user_id ?? claims.user_id;
  } else if (process.env.NODE_ENV !== 'production') {
    // ponytail: dev bypass — keeps local/OBS dev voting working without a JWT
    userId = bodyUserId;
  } else {
    return res.status(401).json({ error: 'Invalid token' });
  }

  if (!userId) return res.status(400).json({ error: 'Invalid vote' });

  const accepted = castVote(userId, action);
  if (!accepted) return res.status(409).json({ error: 'No active voting session' });

  res.status(204).send();
});

module.exports = router;
module.exports.verifyExtensionJwt = verifyExtensionJwt;
