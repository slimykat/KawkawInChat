// KawKaw relay bot — the Extension path's authoritative engine host.
// Reads chat over anonymous IRC, runs the shared meter engine, and broadcasts
// state to Extension overlays (PubSub) and any OBS overlay pointed at its WS.
// Optionally starts sessions from a Channel Points redeem (EventSub webhook).
require('dotenv').config();
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');
const { WebSocketServer } = require('ws');
const { createEngine } = require('../overlay/js/meter.js');
const { broadcast, addClient, removeClient, setChannelId } = require('./broadcaster');

const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) ? v : d; };

// Engine knobs: pass through ONLY what .env actually sets, so meter.js DEFAULTS stays
// the single source for the numbers. Blank or garbage values fall through to it —
// spreading an explicit `undefined` would clobber the default instead.
function envEngineConfig() {
  const out = {};
  for (const [key, name] of Object.entries({
    step: 'STEP', decay: 'DECAY', maxSessionDuration: 'MAX_SESSION_DURATION', perUserCap: 'PER_USER_CAP',
  })) {
    const raw = (process.env[name] ?? '').trim();
    if (raw !== '' && Number.isFinite(Number(raw))) out[key] = Number(raw);
  }
  return out;
}

const CHANNEL = (process.env.CHANNEL || '').toLowerCase().replace(/^#/, '');
const TRIGGER = process.env.TRIGGER || 'command';
const PORT    = num('PORT', 3000);

if (!CHANNEL) { console.error('KawKaw bot: set CHANNEL in .env'); process.exit(1); }

// PubSub is keyed by the broadcaster's numeric id. The redeem event carries it;
// for the command trigger, supply it via env so Extension overlays still get state.
if (process.env.TWITCH_CHANNEL_ID) setChannelId(process.env.TWITCH_CHANNEL_ID);

const engine = createEngine(envEngineConfig());
console.log('KawKaw bot engine config:', engine.config);

// ── Chat (anonymous IRC) ──────────────────────────────────────────────────────

function connectIRC() {
  const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
  ws.on('open', () => {
    ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
    ws.send('NICK justinfan' + Math.floor(Math.random() * 90000 + 10000));
    ws.send('JOIN #' + CHANNEL);
    console.log(`KawKaw bot joined #${CHANNEL}`);
  });
  ws.on('message', (data) => {
    for (const line of data.toString().split('\r\n')) {
      if (!line) continue;
      if (line.startsWith('PING')) { ws.send('PONG :tmi.twitch.tv'); continue; }
      handle(parseCommand(line));
    }
  });
  ws.on('close', () => { console.warn('KawKaw bot: IRC closed, retrying in 5s'); setTimeout(connectIRC, 5000); });
  ws.on('error', (e) => { console.warn('KawKaw bot: IRC error', e.message); try { ws.close(); } catch {} });
}

function handle(cmd) {
  if (!cmd) return;
  if (cmd.action === 'kawkaw') {
    if ((TRIGGER === 'command' || TRIGGER === 'both') && cmd.privileged) engine.start();
  } else {
    engine.command(cmd.userId, cmd.action);
  }
}

// Shared shape with the overlay parser (overlay/js/chat.js) — keep in sync.
function parseCommand(line) {
  let tags = {};
  if (line[0] === '@') {
    const sp = line.indexOf(' ');
    for (const kv of line.slice(1, sp).split(';')) { const i = kv.indexOf('='); tags[kv.slice(0, i)] = kv.slice(i + 1); }
    line = line.slice(sp + 1);
  }
  let prefix = '';
  if (line[0] === ':') { const sp = line.indexOf(' '); prefix = line.slice(1, sp); line = line.slice(sp + 1); }
  const sp = line.indexOf(' ');
  if ((sp === -1 ? line : line.slice(0, sp)) !== 'PRIVMSG') return null;
  const rest = line.slice(sp + 1);
  const c = rest.indexOf(':');
  const text = c === -1 ? '' : rest.slice(c + 1);
  const token = text.trim().split(/\s+/)[0].toLowerCase();
  const action = token === '!call' ? 'call' : token === '!shoo' ? 'shoo' : token === '!kawkaw' ? 'kawkaw' : null;
  if (!action) return null;
  const badges = tags['badges'] || '';
  return {
    userId: tags['user-id'] || prefix.split('!')[0] || 'anon',
    action,
    privileged: tags['mod'] === '1' || /\bbroadcaster\b/.test(badges) || /\bmoderator\b/.test(badges),
  };
}

// ── Tick loop ─────────────────────────────────────────────────────────────────

setInterval(() => { if (engine.tick()) broadcast(engine.getState()); }, 1000);

// ── HTTP: WS server + optional EventSub redeem webhook ────────────────────────

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/eventsub' && (TRIGGER === 'redeem' || TRIGGER === 'both')) {
    return handleEventSub(req, res);
  }
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  addClient(ws);
  ws.send(JSON.stringify({ type: 'state_update', state: engine.getState() }));
  ws.on('close', () => removeClient(ws));
  ws.on('error', () => removeClient(ws));
});

function handleEventSub(req, res) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const secret = process.env.EVENTSUB_SECRET;
    const id = req.headers['twitch-eventsub-message-id'];
    const ts = req.headers['twitch-eventsub-message-timestamp'];
    const sig = req.headers['twitch-eventsub-message-signature'] || '';
    const type = req.headers['twitch-eventsub-message-type'];

    // Fail closed: with no secret, any HMAC we compute is forgeable by anyone.
    if (!secret) { console.error('KawKaw bot: EVENTSUB_SECRET unset, rejecting webhook'); res.writeHead(500).end(); return; }

    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(id + ts + body).digest('hex');
    let ok = false;
    try { ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig)); } catch {}
    if (!ok) { res.writeHead(403).end('Forbidden'); return; }

    let data;
    try { data = JSON.parse(body.toString()); } catch { res.writeHead(400).end(); return; }
    if (type === 'webhook_callback_verification') { res.writeHead(200).end(data.challenge); return; }
    if (type === 'notification') {
      const broadcasterId = data.event?.broadcaster_user_id;
      if (broadcasterId) setChannelId(broadcasterId);
      engine.start();
    }
    res.writeHead(204).end();
  });
}

server.listen(PORT, () => console.log(`KawKaw bot WS/webhook on :${PORT} (trigger: ${TRIGGER})`));
connectIRC();
