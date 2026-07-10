const express = require('express');
const { setConfig } = require('../state');

const router = express.Router();

const BOUNDS = {
  intervalDuration:   [1, 3600],
  callsToWin:         [1, 1000],
  shooesToFlee:       [1, 1000],
  maxSessionDuration: [1, 86400],
};

function validateConfig(body) {
  const out = {};
  for (const [key, [min, max]] of Object.entries(BOUNDS)) {
    if (body[key] == null) continue;
    const n = Number(body[key]);
    if (!Number.isFinite(n) || n < min || n > max) return null;
    out[key] = n;
  }
  return out;
}

router.post('/', express.json(), (req, res) => {
  const validated = validateConfig(req.body ?? {});
  if (validated === null) return res.status(400).json({ error: 'Invalid config' });
  setConfig(validated);
  res.status(204).send();
});

module.exports = router;
module.exports.validateConfig = validateConfig;
