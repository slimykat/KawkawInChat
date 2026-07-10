require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const eventsubRoute = require('./routes/eventsub');
const voteRoute = require('./routes/vote');
const configRoute = require('./routes/config');
const { addClient, removeClient } = require('./broadcaster');
const { getState, startSession, endSession } = require('./state');

const app = express();

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use('/overlay', express.static(path.join(__dirname, '../overlay')));
app.use('/config',  express.static(path.join(__dirname, '../config')));
app.use('/assets',  express.static(path.join(__dirname, '../../assets')));

app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.use('/eventsub', eventsubRoute);
app.use('/vote', voteRoute);
app.use('/config', configRoute);

// Dev-only helpers — trigger/reset a session without Twitch
if (process.env.NODE_ENV !== 'production') {
  app.post('/debug/start', (req, res) => res.json({ started: startSession() }));
  app.post('/debug/reset', (req, res) => { endSession(); res.json({ ok: true }); });
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  addClient(ws);
  ws.send(JSON.stringify({ type: 'state_update', state: getState() }));

  ws.on('close', () => removeClient(ws));
  ws.on('error', () => removeClient(ws));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`KawKaw backend on :${PORT}`));
