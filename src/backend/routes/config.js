const express = require('express');
const { setConfig } = require('../state');

const router = express.Router();

router.post('/', express.json(), (req, res) => {
  const { intervalDuration, callsToWin, shooesToFlee, maxSessionDuration } = req.body ?? {};

  const incoming = {};
  if (intervalDuration != null) incoming.intervalDuration = Number(intervalDuration);
  if (callsToWin != null) incoming.callsToWin = Number(callsToWin);
  if (shooesToFlee != null) incoming.shooesToFlee = Number(shooesToFlee);
  if (maxSessionDuration != null) incoming.maxSessionDuration = Number(maxSessionDuration);

  setConfig(incoming);
  res.status(204).send();
});

module.exports = router;
