// KawKaw backend — reads chat, owns the game engine, serves the frontend, and
// streams state to the overlay.
//
// Every outward connection is outbound (Twitch IRC). The only listening socket
// is bound to loopback, so nothing here is reachable from the network.
require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { createEngine } = require('./engine');
const { connectChat } = require('./chat');
const { connectEventSub } = require('./eventsub');
const { createAuth } = require('./twitch');
const store = require('./config');

const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) ? v : d; };

// .env holds only what the installer writes once: identity and secrets.
// Everything tunable lives in config.json, edited through the config page.
const CHANNEL = (process.env.CHANNEL || '').toLowerCase().replace(/^#/, '');
const PORT    = num('PORT', 3000);
const HOST    = '127.0.0.1';   // loopback only — never 0.0.0.0

if (!CHANNEL) { console.error('KawKaw: set CHANNEL in .env'); process.exit(1); }

let config = store.load();
const engine = createEngine(store.engineConfig(config));

// Only needed for the redeem trigger. Without these the backend still runs —
// chat commands need no Twitch credentials at all.
const auth = createAuth({
  clientId: process.env.TWITCH_CLIENT_ID,
  clientSecret: process.env.TWITCH_CLIENT_SECRET,
  redirectUri: `http://localhost:${PORT}/auth/callback`,
});

const redeemEnabled = () => config.trigger === 'redeem' || config.trigger === 'both';

// ── Static file serving ───────────────────────────────────────────────────────

const REPO = path.resolve(__dirname, '../..');
const MOUNTS = {
  '/overlay': path.join(REPO, 'src/overlay'),
  '/config':  path.join(REPO, 'src/config'),
  '/assets':  path.join(REPO, 'assets'),
};

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.woff2': 'font/woff2',
};

function serveStatic(res, urlPath) {
  const mount = Object.keys(MOUNTS).find((m) => urlPath === m || urlPath.startsWith(m + '/'));
  if (!mount) return false;

  let rel = decodeURIComponent(urlPath.slice(mount.length)) || '/';
  if (rel.endsWith('/')) rel += 'index.html';

  const file = path.join(MOUNTS[mount], rel);
  // Traversal guard: the resolved path must still sit inside its mount.
  if (!file.startsWith(MOUNTS[mount] + path.sep)) { res.writeHead(403).end(); return true; }

  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      // OBS Browser Source caches hard, so an edited overlay silently keeps
      // running the old code. Everything is served off loopback — there is
      // nothing to save by caching it.
      'Cache-Control': 'no-store',
    });
    res.end(body);
  });
  return true;
}

// ── Loopback guard ────────────────────────────────────────────────────────────

// A browser cannot forge the Host header, so pinning it to a loopback name is what
// stops DNS rebinding: a malicious page that points its own domain at 127.0.0.1
// still sends its own hostname here, and gets refused.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostAllowed(req) {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  return LOOPBACK_HOSTS.has(host);
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

const MAX_BODY = 64 * 1024;

function readJson(req, res, done) {
  // Requiring JSON is a CSRF guard: a cross-origin <form> can only send
  // urlencoded/multipart/plain, and anything else triggers a preflight that
  // fails because this server emits no CORS headers.
  if (!/^application\/json\b/.test(req.headers['content-type'] || '')) {
    res.writeHead(415).end('Expected application/json');
    return;
  }
  let size = 0;
  const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY) { res.writeHead(413).end('Too large'); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (res.writableEnded) return;
    try { done(JSON.parse(Buffer.concat(chunks).toString())); }
    catch { res.writeHead(400).end('Malformed JSON'); }
  });
}

function sendJson(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  if (!hostAllowed(req)) { res.writeHead(403).end('Forbidden'); return; }

  const urlPath = (req.url || '/').split('?')[0];

  if (urlPath === '/api/config') {
    if (req.method === 'GET') return sendJson(res, 200, config);
    if (req.method === 'POST') {
      return readJson(req, res, (body) => {
        const { config: next, clamped } = store.validate(body, config);
        try { store.save(next); }
        catch (err) { return sendJson(res, 500, { error: `Could not save: ${err.message}` }); }
        config = next;
        // Staged, not live — the engine picks this up at the next start().
        engine.setConfig(store.engineConfig(config));
        broadcastConfig();
        syncRedeemTrigger();   // trigger may have just been switched on or off
        sendJson(res, 200, { config, clamped });
      });
    }
    res.writeHead(405).end('Method not allowed');
    return;
  }

  if (urlPath === '/auth/callback') return handleAuthCallback(req, res);

  if (urlPath === '/') { res.writeHead(302, { Location: '/overlay/' }); res.end(); return; }
  if (serveStatic(res, urlPath)) return;

  res.writeHead(404).end('Not found');
});

// ── One-time OAuth for the redeem trigger ─────────────────────────────────────

// The only inbound step in the whole design, and it only matters for the seconds
// between clicking the authorize link and Twitch redirecting back.
let authState = null;

function authorizeLink() {
  authState = crypto.randomBytes(16).toString('hex');
  return auth.authorizeUrl(authState);
}

function handleAuthCallback(req, res) {
  const query = new URLSearchParams((req.url.split('?')[1] || ''));
  const reply = (msg) => { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(msg); };

  if (query.get('error')) return reply(`Authorization denied: ${query.get('error_description') || query.get('error')}`);

  // Pin the callback to the link we handed out, so a stray or forged redirect
  // cannot trade in a code we never asked for.
  if (!authState || query.get('state') !== authState) return reply('Unexpected authorization response — start again from the link the backend printed.');
  authState = null;

  const code = query.get('code');
  if (!code) return reply('No authorization code in the callback.');

  auth.exchangeCode(code)
    .then(() => {
      console.log('KawKaw: authorized — redeem trigger available');
      reply('KawKaw is authorized. You can close this tab.');
      syncRedeemTrigger();
    })
    .catch((err) => {
      console.error('KawKaw: token exchange failed —', err.message);
      reply('Token exchange failed: ' + err.message);
    });
}

// ── State stream ──────────────────────────────────────────────────────────────

const clients = new Set();
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  if (!hostAllowed(req)) { ws.close(1008, 'Forbidden'); return; }
  clients.add(ws);
  // Render config first, then full state — so a reloaded overlay is positioned
  // correctly before it draws anything, and never sits blank.
  send(ws, { type: 'config', config: store.renderConfig(config) });
  send(ws, { type: 'state_update', state: engine.getState() });
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

function send(ws, msg) {
  if (ws.readyState === 1 /* OPEN */) ws.send(JSON.stringify(msg));
}

function broadcast(msg) {
  const text = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === 1) ws.send(text);
}

// Render config applies immediately — repositioning KawKaw mid-encounter is
// harmless, unlike retuning the meter.
function broadcastConfig() {
  broadcast({ type: 'config', config: store.renderConfig(config) });
}

// ── Chat → engine ─────────────────────────────────────────────────────────────

connectChat(CHANNEL, ({ userId, name, action, privileged }) => {
  if (action !== 'kawkaw') { engine.command(userId, action); return; }

  // Logged the same way redemptions are: without this there is no way to tell a
  // !kawkaw that never reached the backend from one that arrived and was gated.
  if (config.trigger === 'redeem') {
    console.log(`KawKaw: ignoring !kawkaw from ${name} — trigger is set to ${config.trigger}`);
  } else if (config.summonBy !== 'everyone' && !privileged) {
    console.log(`KawKaw: ignoring !kawkaw from ${name} — summoning is limited to ${config.summonBy}`);
  } else if (engine.start()) {
    console.log(`KawKaw: ${name} ran !kawkaw → encounter started`);
  } else {
    console.log(`KawKaw: ${name} ran !kawkaw — already on screen, ignored`);
  }
});

// ── Redeem → engine ───────────────────────────────────────────────────────────

let eventsub = null;

async function syncRedeemTrigger() {
  if (!redeemEnabled()) {
    if (eventsub) { eventsub.close(); eventsub = null; console.log('KawKaw: redeem trigger off'); }
    return;
  }
  if (eventsub) return;   // already listening

  if (!auth.configured) {
    console.warn('KawKaw: redeem trigger needs TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env');
    return;
  }
  if (!auth.hasTokens()) {
    console.warn('KawKaw: redeem trigger needs one-time authorization —\n  ' + authorizeLink());
    return;
  }

  let broadcaster;
  try {
    broadcaster = await auth.broadcasterId(CHANNEL);
  } catch (err) {
    console.error('KawKaw: could not resolve broadcaster id —', err.message);
    return;
  }

  eventsub = connectEventSub({
    onWelcome: (sessionId) => auth.subscribeRedemptions(sessionId, broadcaster),
    onNotification: (event) => {
      // Logged either way: without this there is no way to tell a redemption that
      // never arrived from one that arrived and was ignored.
      const who = event?.user_name || 'someone';
      const reward = event?.reward?.title || 'a reward';
      if (!redeemEnabled()) {
        console.log(`KawKaw: ignoring "${reward}" from ${who} — trigger is set to ${config.trigger}`);
      } else if (!store.rewardMatches(config, reward)) {
        console.log(`KawKaw: ignoring "${reward}" from ${who} — does not match "${config.rewardTitle}"`);
      } else if (engine.start()) {
        console.log(`KawKaw: ${who} redeemed "${reward}" → encounter started`);
      } else {
        console.log(`KawKaw: ${who} redeemed "${reward}" — already on screen, ignored`);
      }
    },
    onStatus: (status, detail) => {
      if (status === 'connected') console.log('KawKaw: EventSub connected, subscribing…');
      else if (status === 'subscribed') console.log(`KawKaw: redeem trigger armed on #${CHANNEL} — ` +
        (config.rewardTitle ? `rewards matching "${config.rewardTitle}"` : 'any Channel Points reward'));
      else if (status === 'revoked') console.warn('KawKaw: EventSub subscription revoked —', detail);
      else if (status === 'subscribe_failed') {
        console.error('KawKaw: could not subscribe to redemptions —', detail);
        // Almost always a dead or unscoped token; a fresh link is more useful
        // than retrying the same failure every reconnect.
        if (auth.configured) console.warn('  re-authorize:\n  ' + authorizeLink());
      }
    },
  });
}

// One tick per second. tick() returns false while idle, so a parked backend
// broadcasts nothing.
setInterval(() => {
  if (engine.tick()) broadcast({ type: 'state_update', state: engine.getState() });
}, 1000);

// An unhandled throw here would take the overlay down mid-stream; log and carry on.
process.on('uncaughtException', (err) => console.error('KawKaw: uncaught —', err));

server.listen(PORT, HOST, () => {
  console.log(`KawKaw backend on http://${HOST}:${PORT}  (channel: #${CHANNEL})`);
  console.log(`  overlay  http://${HOST}:${PORT}/overlay/`);
  console.log(`  config   http://${HOST}:${PORT}/config/config.html`);
  console.log('  config  ', config);
  syncRedeemTrigger();
});
