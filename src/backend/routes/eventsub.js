const express = require('express');
const crypto = require('crypto');
const { startSession } = require('../state');
const { setChannelId } = require('../broadcaster');

const router = express.Router();

router.use(express.raw({ type: 'application/json' }));

function verifySignature(secret, messageId, timestamp, body, signature) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(messageId);
  hmac.update(timestamp);
  hmac.update(body);
  const expected = 'sha256=' + hmac.digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

router.post('/', (req, res) => {
  const secret = process.env.EVENTSUB_SECRET;
  const messageId = req.headers['twitch-eventsub-message-id'];
  const timestamp = req.headers['twitch-eventsub-message-timestamp'];
  const signature = req.headers['twitch-eventsub-message-signature'];
  const messageType = req.headers['twitch-eventsub-message-type'];

  if (!verifySignature(secret, messageId, timestamp, req.body, signature)) {
    return res.status(403).send('Forbidden');
  }

  const data = JSON.parse(req.body);

  if (messageType === 'webhook_callback_verification') {
    return res.status(200).send(data.challenge);
  }

  if (messageType === 'notification') {
    const broadcasterId = data.event?.broadcaster_user_id;
    if (broadcasterId) setChannelId(broadcasterId);
    startSession();
  }

  res.status(204).send();
});

module.exports = router;
