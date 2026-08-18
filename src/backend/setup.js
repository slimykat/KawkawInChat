// Reads and writes .env for the first-run setup page.
//
// .env holds only what the installer sets once — identity and secrets. Everything
// tunable lives in config.json and is edited on the settings page instead.
//
// The wizard exists because the alternative is telling a streamer to open a text
// file. It deliberately does not offer PORT: changing that also means editing the
// Twitch app's redirect URL, so it stays a documented hand-edit.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '.env');

// Keys the wizard owns. Anything else found in an existing .env is preserved.
const KEYS = ['CHANNEL', 'PORT', 'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET'];

// `file` is only ever passed by the tests, so the destructive path can be driven
// against a scratch file instead of the streamer's real .env.
const hasEnv = (file = FILE) => fs.existsSync(file);

// KEY=VALUE lines, '#' comments, optional quotes. Deliberately not a full dotenv
// parser — this only has to read back what writeEnv wrote, plus a hand-edited file.
function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    const q = val[0];
    if ((q === '"' || q === "'") && val.endsWith(q) && val.length > 1) {
      val = val.slice(1, -1).replace(/\\(["'\\])/g, '$1');
    }
    out[key] = val;
  }
  return out;
}

function readEnv(file = FILE) {
  try { return parseEnv(fs.readFileSync(file, 'utf8')); }
  catch { return {}; }
}

// Twitch logins are ASCII word characters. Accept what a streamer is likely to
// paste — a URL fragment, a leading '#', stray case — and reject the rest rather
// than letting a bad name reach an IRC JOIN.
function normalizeChannel(input) {
  const s = String(input ?? '').trim().toLowerCase()
    .replace(/^https?:\/\/(www\.)?twitch\.tv\//, '')
    .replace(/^#/, '')
    .replace(/\/.*$/, '');
  return /^[a-z0-9_]{3,25}$/.test(s) ? s : null;
}

// Quote only when the value would otherwise be misread — a bare '#' starts a
// comment, and leading/trailing space is invisible in an editor.
function quote(v) {
  const s = String(v ?? '');
  if (s === '') return '';
  return /[\s#'"]/.test(s) ? `"${s.replace(/(["\\])/g, '\\$1')}"` : s;
}

// Merge over whatever is already there, so setting one field cannot silently
// drop another. Written tmp-then-rename like config.json, at 0600 because the
// client secret is a real credential.
function writeEnv(values = {}, file = FILE) {
  const merged = { ...readEnv(file) };
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) continue;
    merged[k] = v === null ? '' : String(v);
  }

  const extra = Object.keys(merged).filter((k) => !KEYS.includes(k)).sort();
  const body = [
    '# Written by the KawKaw setup page. Safe to edit by hand while the backend',
    '# is stopped. Everything tunable lives on the settings page, not here.',
    '',
    '# Twitch channel login to read chat from (no leading #)',
    `CHANNEL=${quote(merged.CHANNEL || '')}`,
    '',
    '# Loopback port for the overlay, settings page, and state stream. Changing',
    '# this also means updating your Twitch app\'s OAuth Redirect URL to match.',
    `PORT=${quote(merged.PORT || '3000')}`,
    '',
    '# Channel Points redeem trigger only — leave blank for the chat command.',
    '# Register an app at https://dev.twitch.tv/console/apps and set its OAuth',
    `# Redirect URL to exactly: http://localhost:${merged.PORT || '3000'}/auth/callback`,
    `TWITCH_CLIENT_ID=${quote(merged.TWITCH_CLIENT_ID || '')}`,
    `TWITCH_CLIENT_SECRET=${quote(merged.TWITCH_CLIENT_SECRET || '')}`,
    ...(extra.length ? ['', '# Preserved from a previous .env'] : []),
    ...extra.map((k) => `${k}=${quote(merged[k])}`),
    '',
  ].join('\n');

  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, body, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
  return merged;
}

module.exports = { FILE, KEYS, hasEnv, readEnv, parseEnv, writeEnv, normalizeChannel };
