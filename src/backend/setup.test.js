// Runnable self-check: `node setup.test.js`. No framework — assert only.
//
// Writing .env is the one place the setup page can destroy something the streamer
// cannot get back (their client secret), so the merge behaviour is what this
// mostly guards. Everything runs against a scratch file; the real .env is never
// touched.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const setup = require('./setup.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawkaw-'));
const ENV = path.join(dir, '.env');

// ── Channel normalisation ─────────────────────────────────────────────────────
const chan = setup.normalizeChannel;
assert.equal(chan('sizutw'), 'sizutw');
assert.equal(chan('  #SizuTW  '), 'sizutw', 'strips # and case');
assert.equal(chan('https://twitch.tv/SizuTW'), 'sizutw', 'accepts a pasted URL');
assert.equal(chan('https://www.twitch.tv/sizutw/about'), 'sizutw', 'trailing path dropped');
assert.equal(chan(''), null, 'blank is not a channel');
assert.equal(chan('has space'), null);
assert.equal(chan('bad!'), null, 'punctuation rejected');
assert.equal(chan('x'.repeat(26)), null, 'too long');
assert.equal(chan(undefined), null);

// ── Parsing ───────────────────────────────────────────────────────────────────
const p = setup.parseEnv([
  '# a comment',
  '',
  'CHANNEL=sizutw',
  'PORT = 3000',
  'QUOTED="has space"',
  "SINGLE='also fine'",
  'HASH="a#b"',
  'not_a_pair',
].join('\n'));
assert.equal(p.CHANNEL, 'sizutw');
assert.equal(p.PORT, '3000', 'whitespace around = tolerated');
assert.equal(p.QUOTED, 'has space');
assert.equal(p.SINGLE, 'also fine');
assert.equal(p.HASH, 'a#b', 'a quoted # is not a comment');
assert.ok(!('not_a_pair' in p));

// ── The real writer, against a scratch .env ───────────────────────────────────
assert.equal(setup.hasEnv(ENV), false);

setup.writeEnv({ CHANNEL: 'sizutw', TWITCH_CLIENT_SECRET: 'abc#123 def' }, ENV);
assert.equal(setup.hasEnv(ENV), true);

let r = setup.readEnv(ENV);
assert.equal(r.CHANNEL, 'sizutw');
assert.equal(r.PORT, '3000', 'PORT defaulted rather than left blank');
// The quoting path is the reason this test exists: unquoted, everything from the
// '#' onward would be read back as a comment.
assert.equal(r.TWITCH_CLIENT_SECRET, 'abc#123 def', 'a secret with # and spaces survives');
assert.equal(fs.statSync(ENV).mode & 0o777, 0o600, '.env must not be world-readable');

// The wizard posts partial updates — setting one field must not drop another.
setup.writeEnv({ CHANNEL: 'someoneelse' }, ENV);
r = setup.readEnv(ENV);
assert.equal(r.CHANNEL, 'someoneelse');
assert.equal(r.TWITCH_CLIENT_SECRET, 'abc#123 def', 'unspecified fields preserved');

// A key the wizard does not own must survive a rewrite too.
fs.appendFileSync(ENV, '\nCUSTOM_THING=keepme\n');
setup.writeEnv({ CHANNEL: 'third' }, ENV);
assert.equal(setup.readEnv(ENV).CUSTOM_THING, 'keepme', 'unknown keys preserved');

// Round trip has to be stable, or repeated saves would drift.
const before = fs.readFileSync(ENV, 'utf8');
setup.writeEnv({}, ENV);
assert.equal(fs.readFileSync(ENV, 'utf8'), before, 'rewriting with no changes is a no-op');

fs.rmSync(dir, { recursive: true, force: true });
console.log('setup: ok');
