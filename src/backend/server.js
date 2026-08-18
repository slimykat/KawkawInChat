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
const readline = require('readline');
const { WebSocketServer } = require('ws');
const { createEngine } = require('./engine');
const { connectChat } = require('./chat');
const { connectEventSub } = require('./eventsub');
const { createAuth } = require('./twitch');
const store = require('./config');
const setup = require('./setup');
const instance = require('./instance');

const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) ? v : d; };

// .env holds only what the installer sets once: identity and secrets. Everything
// tunable lives in config.json, edited on the settings page.
//
// A missing CHANNEL is not fatal any more — it means "not set up yet". The server
// still comes up and serves the setup page, which is the only way a streamer who
// has never opened a terminal can be walked through this.
let CHANNEL = setup.normalizeChannel(process.env.CHANNEL) || '';
const HOST  = '127.0.0.1';   // loopback only — never 0.0.0.0

// The port asked for, not necessarily the one we end up on: when another program
// already holds it, boot() asks the streamer for a different one and this moves.
// Everything that derives a URL — the redirect, the front page, the OBS link —
// reads it after that, never before.
let PORT = num('PORT', 3000);

let config = store.load();
const engine = createEngine(store.engineConfig(config));

// Only needed for the redeem trigger. Without these the backend still runs —
// chat commands need no Twitch credentials at all.
//
// Rebuilt rather than mutated when credentials change: createAuth closes over
// clientId/clientSecret, so updating process.env alone would leave the old values
// in the closure and the next Helix call would use them.
let auth = buildAuth();

function buildAuth() {
  return createAuth({
    clientId: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
    redirectUri: `http://localhost:${PORT}/auth/callback`,
  });
}

const redeemEnabled = () => config.trigger === 'redeem' || config.trigger === 'both';

// ── Static file serving ───────────────────────────────────────────────────────

const REPO = path.resolve(__dirname, '../..');
const MOUNTS = {
  '/overlay': path.join(REPO, 'src/overlay'),
  '/ui':      path.join(REPO, 'src/config'),
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

// The two streamer-facing pages get real URLs rather than a path into the mount,
// because these are the ones a person types or bookmarks.
function serveFile(res, file) {
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end(body);
  });
}

const PAGES = {
  '/':         path.join(REPO, 'src/config/index.html'),
  '/settings': path.join(REPO, 'src/config/settings.html'),
};

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

  // What the front page needs to tell the streamer what is and is not working.
  // Deliberately never includes the client secret — only whether one is set.
  if (urlPath === '/api/status') {
    if (req.method !== 'GET') { res.writeHead(405).end('Method not allowed'); return; }
    return sendJson(res, 200, status());
  }

  // First-run setup: writes .env and applies it live, so the streamer never has
  // to find a text file or restart anything.
  if (urlPath === '/api/setup') {
    if (req.method !== 'POST') { res.writeHead(405).end('Method not allowed'); return; }
    return readJson(req, res, (body) => handleSetup(res, body));
  }

  if (urlPath === '/auth/start') return handleAuthStart(res);
  if (urlPath === '/auth/callback') return handleAuthCallback(req, res);

  if (PAGES[urlPath]) return serveFile(res, PAGES[urlPath]);
  if (serveStatic(res, urlPath)) return;

  res.writeHead(404).end('Not found');
});

// ── Status ────────────────────────────────────────────────────────────────────

// Last thing EventSub told us, so the page can distinguish "armed" from "the
// subscription failed" instead of both looking like silence.
let redeemStatus = null;

const fileExists = (f) => { try { return fs.existsSync(f); } catch { return false; } };

function status() {
  const assetDir = path.join(REPO, 'assets/kawkaw');
  const sounds = (() => {
    try { return fs.readdirSync(assetDir).some((f) => f.endsWith('.ogg')); }
    catch { return false; }
  })();

  return {
    // What a probing launch looks for. Older builds have no marker, so the shape
    // below is recognised too — see isKawKaw in instance.js.
    app: 'kawkaw',
    setup: Boolean(CHANNEL),
    channel: CHANNEL,
    port: PORT,
    chatConnected: Boolean(chat && chat.connected),
    trigger: config.trigger,
    rewardTitle: config.rewardTitle,
    redeem: {
      enabled: redeemEnabled(),
      configured: auth.configured,
      authorized: auth.hasTokens(),
      status: redeemStatus,
    },
    // The overlay degrades silently when these are missing, which is exactly why
    // the streamer needs to be told here instead of staring at an empty source.
    assets: {
      sprite: fileExists(path.join(assetDir, 'KawKawSprite_HandDrawn.png')),
      sounds,
    },
  };
}

// ── First-run setup ───────────────────────────────────────────────────────────

function handleSetup(res, body) {
  const channel = setup.normalizeChannel(body?.channel);
  if (!channel) {
    return sendJson(res, 400, { error: 'That does not look like a Twitch channel name.' });
  }

  // Credentials are optional — the chat command trigger needs none. Blank means
  // "leave what is already there"; the page sends null to clear them.
  const patch = { CHANNEL: channel };
  if (body.clientId !== undefined) patch.TWITCH_CLIENT_ID = String(body.clientId).trim();
  if (body.clientSecret !== undefined) patch.TWITCH_CLIENT_SECRET = String(body.clientSecret).trim();

  try { setup.writeEnv(patch); }
  catch (err) { return sendJson(res, 500, { error: `Could not write .env: ${err.message}` }); }

  // Apply without a restart: process.env feeds buildAuth, and the chat socket is
  // reconnected against the new channel.
  for (const [k, v] of Object.entries(patch)) process.env[k] = v;
  const channelChanged = channel !== CHANNEL;
  CHANNEL = channel;
  auth = buildAuth();

  if (channelChanged || !chat) startChat();
  syncRedeemTrigger();

  console.log(`KawKaw: setup saved — channel #${CHANNEL}`);
  sendJson(res, 200, status());
}

// ── One-time OAuth for the redeem trigger ─────────────────────────────────────

// The only inbound step in the whole design, and it only matters for the seconds
// between clicking the authorize link and Twitch redirecting back.
let authState = null;

function authorizeLink() {
  authState = crypto.randomBytes(16).toString('hex');
  return auth.authorizeUrl(authState);
}

// The Authorize button. Generates a fresh state and bounces to Twitch, so the
// streamer never has to find the link in terminal output.
function handleAuthStart(res) {
  if (!auth.configured) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('No Twitch application credentials yet — add them on the setup page first.');
    return;
  }
  res.writeHead(302, { Location: authorizeLink() });
  res.end();
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

// ws forwards the http server's errors onto itself, and an 'error' with no
// listener is thrown rather than delivered. Without this, a websocket failure
// escapes as an uncaught exception instead of being logged like everything else.
//
// A refused bind arrives here too, and boot() is already explaining that one in
// plain language — printing the raw EADDRINUSE first would bury it.
wss.on('error', (err) => {
  if (!bound && err.code === 'EADDRINUSE') return;
  console.error('KawKaw: websocket server error —', err.message);
});

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

// Held so setup can point it at a different channel without a restart.
let chat = null;

// No channel yet means the streamer has not finished setup; there is nothing to
// join, and the setup page is what fixes that.
function startChat() {
  if (chat) { chat.close(); chat = null; }
  if (!CHANNEL) return;
  chat = connectChat(CHANNEL, onChatCommand);
}

function onChatCommand({ userId, name, action, privileged }) {
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
}

// ── Redeem → engine ───────────────────────────────────────────────────────────

let eventsub = null;

async function syncRedeemTrigger() {
  if (!redeemEnabled()) {
    if (eventsub) { eventsub.close(); eventsub = null; console.log('KawKaw: redeem trigger off'); }
    redeemStatus = null;
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
      redeemStatus = status;
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

// ── Startup ───────────────────────────────────────────────────────────────────

// Set once the port is ours, so a bind still being negotiated can be kept quiet
// without silencing a real failure later.
let bound = false;

// Boot asks two questions before binding anything: is a KawKaw already running
// somewhere, and if not, is the port we want actually free? Both have answers a
// streamer can act on, which a bare EADDRINUSE never did — it said something holds
// the port, but never what, and "close the other window" is no help when the window
// is already gone.
async function boot() {
  const running = await instance.findRunning(PORT);
  if (running) return pointAtRunning(running);

  let port = PORT;
  for (;;) {
    try { await listen(port); break; }
    catch (err) {
      if (err.code !== 'EADDRINUSE') {
        console.error('KawKaw: could not start —', err.message);
        // 2, not 1: tells KawKaw.command the problem has already been explained in
        // plain language, so it holds the window without adding "stopped unexpectedly".
        process.exit(2);
      }
      // findRunning already ruled out a KawKaw here, so whatever holds this port
      // belongs to another program. KawKaw moves aside; it never evicts.
      port = await askForPort(port);
    }
  }

  if (port !== PORT) {
    PORT = port;
    auth = buildAuth();   // the redirect URL is built from the port
    savePort(port);
  }

  bound = true;
  // Only now, holding the port: this is what the next launch will find.
  instance.write({ port: PORT, dir: REPO });
  announce();
}

// Someone launched twice — often the ZIP in Downloads while the checkout on the
// Desktop is already serving. Send them to the one that is running instead of
// failing next to it.
function pointAtRunning(running) {
  const home = `http://${HOST}:${running.port}/`;
  console.log(`KawKaw is already running on ${home}`);
  if (running.dir) {
    console.log(`  started from ${running.dir}${running.pid ? `  (PID ${running.pid})` : ''}`);
  }
  console.log('  Nothing to do here. To stop that one, close the window it is running');
  console.log('  in — or quit it from Activity Monitor if the window is already gone.');

  // 3, not 0 or 2: nothing is wrong, and KawKaw.command has to tell this apart from
  // a backend that started and then fell over.
  if (process.env.KAWKAW_OPEN !== '1') return process.exit(3);

  // Leave once the browser is on its way, but never wait on `open` forever.
  require('child_process').exec(`open ${home}`, () => process.exit(3));
  setTimeout(() => process.exit(3), 2000).unref();
}

// One attempt to bind, as a promise.
//
// Prepended because ws registered its own error listener first, and that one
// re-emits on the WebSocketServer — an appended handler is never reached. Both
// handlers are one-shot: a later error cannot take the overlay down, and a retry on
// another port starts clean. A refused listen leaves the server unbound and
// reusable, so the retry is the same server.
function listen(port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { server.off('listening', onListening); reject(err); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.prependOnceListener('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}

// The manual assignment. Only reached when the port belongs to another program, and
// only ever a question: nothing is killed to make room for us.
async function askForPort(busy) {
  console.error(`KawKaw: port ${busy} is in use by another program (not KawKaw).`);

  // nodemon, CI, or any launch with stdin detached: there is nobody to answer, and a
  // prompt nobody can see is indistinguishable from a hang.
  if (!process.stdin.isTTY) {
    console.error('  Start KawKaw from a terminal to choose another port, or set PORT in src/backend/.env.');
    process.exit(2);
  }

  for (;;) {
    const answer = await ask('  Enter a different port for KawKaw (1024-65535), or press return to quit: ');
    if (!answer.trim()) { console.error('KawKaw: stopped — no port chosen.'); process.exit(2); }
    const port = instance.normalizePort(answer);
    if (port) return port;
    console.error('  That is not a port between 1024 and 65535.');
  }
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}

// Remember the choice, so this is asked once rather than at every launch — and say
// plainly what moving the port changed, because both of these are URLs the streamer
// has already written down somewhere else.
function savePort(port) {
  try { setup.writeEnv({ PORT: String(port) }); }
  catch (err) {
    console.warn(`KawKaw: running on ${port}, but could not save it to .env — ${err.message}`);
    return;
  }
  console.log(`KawKaw: saved PORT=${port} to src/backend/.env — the next launch uses it.`);
  console.log(`  OBS Browser Source URL is now  http://${HOST}:${port}/overlay/`);
  console.log("  Using the Channel Points trigger? Update your Twitch application's");
  console.log(`  OAuth Redirect URL to  http://localhost:${port}/auth/callback`);
}

function announce() {
  const home = `http://${HOST}:${PORT}/`;
  console.log(CHANNEL
    ? `KawKaw is running on ${home}  (channel: #${CHANNEL})`
    : `KawKaw needs setting up — open ${home}`);
  console.log(`  overlay (OBS)  ${home}overlay/`);
  console.log(`  settings       ${home}settings`);

  startChat();
  syncRedeemTrigger();

  // Only when launched from KawKaw.command. `npm run dev` restarts on every save,
  // and a browser tab per save is not help.
  if (process.env.KAWKAW_OPEN === '1') {
    // Failure here is cosmetic — the URL is on the line above either way.
    require('child_process').exec(`open ${home}`, () => {});
  }
}

// The record stands for exactly as long as we hold the port. A force-kill leaves it
// behind, which is why findRunning verifies one before believing it; everything
// short of that is cleaned up here. The signal handlers exist so that 'exit' runs at
// all — the defaults tear the process down without it.
process.on('exit', () => instance.clear());
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(0));

// Nothing in boot() is expected to throw, and a rejection that escaped here would
// be a silent no-start — the one failure mode this whole path exists to remove.
boot().catch((err) => {
  console.error('KawKaw: could not start —', err.message);
  process.exit(2);
});
