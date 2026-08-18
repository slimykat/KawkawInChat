// Runnable self-check: `node instance.test.js`. No framework — assert only.
//
// Two things have to hold, or a launch does the wrong thing to a streamer: a record
// left behind by a force-killed backend must never be believed, and a program that
// merely happens to hold a port must never be mistaken for KawKaw. Both are checked
// against real loopback servers rather than a stub, because the probe is the part
// that decides.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const instance = require('./instance.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawkaw-'));
const REC = path.join(dir, 'instance.json');

// ── Port normalisation ────────────────────────────────────────────────────────
const port = instance.normalizePort;
assert.equal(port('3210'), 3210);
assert.equal(port('  8080  '), 8080, 'surrounding space tolerated');
assert.equal(port('80'), null, 'below 1024 needs root');
assert.equal(port('0'), null, 'a random port cannot be written into OBS');
assert.equal(port('70000'), null, 'above the port range');
assert.equal(port('abc'), null);
assert.equal(port('3000x'), null);
assert.equal(port(''), null);
assert.equal(port(undefined), null);

// ── The record ────────────────────────────────────────────────────────────────
assert.equal(instance.read(REC), null, 'no file is not an error');

const written = instance.write({ port: 3000, dir: '/somewhere/KawkawInChat' }, REC);
assert.equal(written.port, 3000);
assert.equal(written.pid, process.pid);

const back = instance.read(REC);
assert.equal(back.port, 3000);
assert.equal(back.dir, '/somewhere/KawkawInChat', 'which copy is running is the point of the record');
assert.ok(back.startedAt);

fs.writeFileSync(REC, 'not json at all');
assert.equal(instance.read(REC), null, 'a corrupt record reads as no record');

// Someone else's record is not ours to delete: a slow shutdown must not remove the
// record of the instance that already replaced us.
fs.writeFileSync(REC, JSON.stringify({ port: 3000, pid: process.pid + 1, dir: '/elsewhere' }));
assert.equal(instance.clear(REC), false, 'another pid, left alone');
assert.ok(fs.existsSync(REC));

instance.write({ port: 3000, dir }, REC);
assert.equal(instance.clear(REC), true);
assert.equal(fs.existsSync(REC), false);

// ── Probing ───────────────────────────────────────────────────────────────────

// Serves one canned reply on /api/status, the way a real instance would.
function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const json = (body) => (req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

// A port nothing is listening on. Bound and released, so the number is real and
// free rather than guessed at.
async function deadPort() {
  const { server, port } = await serve(json({}));
  await new Promise((r) => server.close(r));
  return port;
}

(async () => {
  // Current builds send the marker.
  const kawkaw = await serve(json({ app: 'kawkaw', port: 1, redeem: {}, setup: true }));
  assert.ok(await instance.probe(kawkaw.port), 'a marked KawKaw is found');

  // v1.0 has no marker. It is still KawKaw, and still must be found — that is the
  // instance most likely to be holding a port when this ships.
  const older = await serve(json({ port: 3000, channel: 'sizutw', redeem: { enabled: false } }));
  assert.ok(await instance.probe(older.port), 'an older KawKaw is recognised by shape');

  // Strangers, in the three shapes a held port actually takes.
  const notFound = await serve((req, res) => res.writeHead(404).end('Not found'));
  assert.equal(await instance.probe(notFound.port), null, '404 is not KawKaw');

  const html = await serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>some other dev server</html>');
  });
  assert.equal(await instance.probe(html.port), null, 'a web page is not KawKaw');

  const otherJson = await serve(json({ status: 'ok', service: 'something else' }));
  assert.equal(await instance.probe(otherJson.port), null, 'unrelated JSON is not KawKaw');

  const dead = await deadPort();
  assert.equal(await instance.probe(dead), null, 'a refused connection is not KawKaw');

  // ── findRunning ─────────────────────────────────────────────────────────────

  // The record points at a live instance: that is the answer, and it carries the
  // folder the streamer needs to be told about.
  instance.write({ port: kawkaw.port, dir: '/Users/someone/Desktop/KawkawInChat' }, REC);
  let found = await instance.findRunning(dead, REC, []);
  assert.equal(found.port, kawkaw.port);
  assert.equal(found.dir, '/Users/someone/Desktop/KawkawInChat');

  // The record survived a force-kill and points at nothing. It must be ignored, not
  // obeyed — believing it is what would refuse to start for no reason.
  instance.write({ port: dead, dir: '/stale' }, REC);
  assert.equal(await instance.findRunning(dead, REC, []), null, 'a stale record is not an instance');

  // Nothing recorded at all — an instance from a build that never wrote one. The
  // scan is what finds it.
  fs.rmSync(REC, { force: true });
  found = await instance.findRunning(dead, REC, [older.port]);
  assert.equal(found.port, older.port, 'the scan finds an unrecorded instance');
  assert.equal(found.dir, null, 'without a record there is no folder to name');

  assert.equal(await instance.findRunning(dead, REC, [dead]), null, 'nothing running is nothing found');

  for (const s of [kawkaw, older, notFound, html, otherJson]) s.server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('instance: ok');
})();
