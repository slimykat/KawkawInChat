// Where a running KawKaw says it lives, so a second launch can find the first one
// instead of colliding with it.
//
// The record is a hint, never an authority: a backend that is force-killed leaves
// one behind. Nothing here is believed until an HTTP probe finds a KawKaw actually
// answering on that port.
//
// Nothing in this file signals a process — not even signal 0. A port held by
// something else is worked around, never taken.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// Deliberately outside any checkout: the copy in ~/Downloads and the copy on the
// Desktop are two folders but the same KawKaw, and only a shared location lets one
// see the other. That is the whole point of the file.
function stateFile() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'KawKaw', 'instance.json');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'KawKaw', 'instance.json');
  }
  const base = process.env.XDG_STATE_HOME || path.join(home, '.local', 'state');
  return path.join(base, 'kawkaw', 'instance.json');
}

const FILE = stateFile();

// Loopback round trip on a busy machine, and no longer: ten of these run on every
// launch that has no record to go on, and a startup nobody notices is the goal.
const PROBE_MS = 300;

// The ports KawKaw can plausibly be on when there is no record to read — the
// default and the handful a streamer nudges it to. A port typed into the prompt is
// saved to .env, so the configured port covers that case separately.
const SCAN = [3000, 3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009];

// `file` is only ever passed by the tests, so they can drive a scratch record
// instead of the one belonging to the streamer's real instance.
function read(file = FILE) {
  try {
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    return rec && Number.isInteger(rec.port) ? rec : null;
  } catch { return null; }
}

// A state directory that cannot be written is not a reason to refuse to start —
// detection just degrades to probing ports. Failure returns null and says nothing.
function write({ port, dir }, file = FILE) {
  const rec = { port, pid: process.pid, dir, startedAt: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(rec, null, 2) + '\n');
  } catch { return null; }
  return rec;
}

// Only ever our own record. A slow shutdown must not delete the record of the
// instance that has already replaced us.
function clear(file = FILE) {
  const rec = read(file);
  if (!rec || rec.pid !== process.pid) return false;
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

// `app` is the marker current builds send. The second clause recognises the shape
// v1.0 already returned, so an instance started before this change is still found
// rather than mistaken for a stranger holding the port.
function isKawKaw(body) {
  if (!body || typeof body !== 'object') return false;
  if (body.app === 'kawkaw') return true;
  return Number.isFinite(body.port) && typeof body.redeem === 'object' && body.redeem !== null;
}

// Resolves to the status payload of a KawKaw listening on `port`, or null for
// anything else: silence, a refused connection, a stranger, or a stranger that
// happens to serve JSON. Never rejects — a probe is a question, not a step.
function probe(port, ms = PROBE_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };

    const req = http.get({ host: '127.0.0.1', port, path: '/api/status', timeout: ms }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return finish(null); }
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
        // Whatever is streaming this much is not a status payload.
        if (text.length > 64 * 1024) { req.destroy(); finish(null); }
      });
      res.on('end', () => {
        try {
          const body = JSON.parse(text);
          finish(isKawKaw(body) ? body : null);
        } catch { finish(null); }
      });
      res.on('error', () => finish(null));
    });

    req.on('timeout', () => { req.destroy(); finish(null); });
    req.on('error', () => finish(null));
  });
}

// Is a KawKaw already running anywhere we can reach it?
//
// The recorded port is asked first and alone — when it answers, that is the
// instance, and there is no reason to knock on nine other doors. Only when there is
// no record, or the record is stale, is the small range swept, which is what finds
// an instance started by a build that never wrote a record at all.
// `file` and `scan` are only ever passed by the tests, which cannot have the
// machine's real ports or record deciding whether they pass.
async function findRunning(configuredPort, file = FILE, scan = SCAN) {
  const rec = read(file);

  if (rec) {
    const status = await probe(rec.port);
    if (status) return { port: rec.port, dir: rec.dir, pid: rec.pid, startedAt: rec.startedAt, status };
  }

  const seen = new Set(rec ? [rec.port] : []);
  const ports = [configuredPort, ...scan].filter((p) => {
    if (!Number.isInteger(p) || seen.has(p)) return false;
    seen.add(p);
    return true;
  });

  const found = await Promise.all(ports.map(async (port) => [port, await probe(port)]));
  for (const [port, status] of found) {
    if (status) return { port, dir: null, pid: null, startedAt: null, status };
  }
  return null;
}

// A port a streamer types at the prompt. Below 1024 needs root on macOS, and 0
// would hand out a random one — no use to someone who has to write the OBS URL
// into a Browser Source.
function normalizePort(input) {
  const s = String(input ?? '').trim();
  if (!/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1024 && n <= 65535 ? n : null;
}

module.exports = { FILE, SCAN, read, write, clear, probe, findRunning, normalizePort, isKawKaw };
