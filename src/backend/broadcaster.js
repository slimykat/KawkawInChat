const crypto = require('crypto');
const https = require('https');

const clients = new Set();

let channelId = null;
function setChannelId(id) { channelId = id; }

function addClient(ws) {
  clients.add(ws);
}

function removeClient(ws) {
  clients.delete(ws);
}

// ponytail: manual HS256 — no jwt lib needed, same pattern as verifyExtensionJwt in routes/vote.js
function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function signPubSubJwt(base64Secret, ownerId, chanId) {
  const header  = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = b64url(Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 60,
    user_id: String(ownerId),
    role: 'external',
    channel_id: String(chanId),
    pubsub_perms: { send: ['broadcast'] },
  })));
  const sig = b64url(
    crypto.createHmac('sha256', Buffer.from(base64Secret, 'base64'))
          .update(`${header}.${payload}`)
          .digest()
  );
  return `${header}.${payload}.${sig}`;
}

// ponytail: live HTTP path untested — no real Twitch creds in CI.
// To smoke-test with real creds: set all three env vars + a real channelId, call broadcastPubSub({test:1}),
// confirm 204 from Twitch and that the extension overlay receives the PubSub message.
// Verify: endpoint URL, JWT claims accepted by Twitch, pubsub_perms scope.
async function broadcastPubSub(state) {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const secret   = process.env.TWITCH_EXTENSION_SECRET;
  const ownerId  = process.env.TWITCH_EXTENSION_OWNER_ID;
  if (!clientId || !secret || !ownerId || !channelId) return; // fail-safe: OBS/dev works without creds

  const jwt  = signPubSubJwt(secret, ownerId, channelId);
  const body = JSON.stringify({
    target: ['broadcast'],
    broadcaster_id: String(channelId),
    is_global_broadcast: false,
    message: JSON.stringify({ type: 'state_update', state }),
  });

  try {
    await new Promise((resolve, reject) => {
      const req = https.request(
        'https://api.twitch.tv/helix/extensions/pubsub',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${jwt}`,
            'Client-Id': clientId,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          res.resume(); // drain
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}`));
          } else {
            resolve();
          }
        }
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  } catch (err) {
    console.warn('KawKaw PubSub broadcast failed', err.message);
  }
}

function broadcast(state) {
  const message = JSON.stringify({ type: 'state_update', state });
  for (const ws of clients) {
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(message);
    }
  }
  broadcastPubSub(state).catch(() => {}); // fire-and-forget: PubSub failure never affects WS or caller
}

module.exports = { addClient, removeClient, broadcast, setChannelId, signPubSubJwt };
