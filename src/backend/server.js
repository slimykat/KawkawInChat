// KawKaw backend — reads chat, owns the game engine, serves the frontend, and
// streams state to the overlay.
//
// Every outward connection is outbound (Twitch IRC). The only listening socket
// is bound to loopback, so nothing here is reachable from the network.
require('dotenv').config();
const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { createEngine } = require('./engine');
const { connectChat } = require('./chat');

const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) ? v : d; };

// Engine knobs: pass through ONLY what .env actually sets, so engine.js DEFAULTS stays
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
const HOST    = '127.0.0.1';   // loopback only — never 0.0.0.0

if (!CHANNEL) { console.error('KawKaw: set CHANNEL in .env'); process.exit(1); }

const engine = createEngine(envEngineConfig());

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
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
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

const server = http.createServer((req, res) => {
  if (!hostAllowed(req)) { res.writeHead(403).end('Forbidden'); return; }

  const urlPath = (req.url || '/').split('?')[0];

  if (urlPath === '/') { res.writeHead(302, { Location: '/overlay/' }); res.end(); return; }
  if (serveStatic(res, urlPath)) return;

  res.writeHead(404).end('Not found');
});

// ── State stream ──────────────────────────────────────────────────────────────

const clients = new Set();
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  if (!hostAllowed(req)) { ws.close(1008, 'Forbidden'); return; }
  clients.add(ws);
  // Full state on connect, so a reloaded overlay never sits blank.
  ws.send(JSON.stringify({ type: 'state_update', state: engine.getState() }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

function broadcast(state) {
  const message = JSON.stringify({ type: 'state_update', state });
  for (const ws of clients) if (ws.readyState === 1 /* OPEN */) ws.send(message);
}

// ── Chat → engine ─────────────────────────────────────────────────────────────

const allowCommandTrigger = TRIGGER === 'command' || TRIGGER === 'both';

connectChat(CHANNEL, ({ userId, action, privileged }) => {
  if (action === 'kawkaw') {
    if (allowCommandTrigger && privileged) engine.start();
  } else {
    engine.command(userId, action);
  }
});

// One tick per second. tick() returns false while idle, so a parked backend
// broadcasts nothing.
setInterval(() => { if (engine.tick()) broadcast(engine.getState()); }, 1000);

// An unhandled throw here would take the overlay down mid-stream; log and carry on.
process.on('uncaughtException', (err) => console.error('KawKaw: uncaught —', err));

server.listen(PORT, HOST, () => {
  console.log(`KawKaw backend on http://${HOST}:${PORT} (channel: #${CHANNEL}, trigger: ${TRIGGER})`);
  console.log(`  overlay  http://${HOST}:${PORT}/overlay/`);
  console.log(`  config   http://${HOST}:${PORT}/config/config.html`);
  console.log('  engine  ', engine.config);
});
