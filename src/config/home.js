// Front page: what is working, what is not, and the one button that fixes the
// thing most likely to be broken.
//
// Everything here is driven by /api/status. The page holds no state of its own —
// it re-fetches after any action rather than trying to predict the result.

const $ = (id) => document.getElementById(id);

document.addEventListener('DOMContentLoaded', () => {
  $('setup-btn').addEventListener('click', save);
  $('copy-btn').addEventListener('click', copyObsUrl);
  // Enter in any setup field saves, since there is only one button.
  for (const id of ['setup-channel', 'setup-client-id', 'setup-client-secret']) {
    $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  }
  refresh();
});

async function refresh() {
  let s;
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    s = await res.json();
  } catch (e) {
    $('mode-note').textContent = 'Backend not reachable — is the Terminal window still open?';
    return;
  }
  render(s);
}

function render(s) {
  $('setup').classList.toggle('hidden', s.setup);
  $('running').classList.toggle('hidden', !s.setup);

  if (!s.setup) {
    $('mode-note').textContent = 'First run — set up below.';
    $('redirect-url').textContent = `http://localhost:${s.port}/auth/callback`;
    return;
  }

  $('mode-note').textContent = `Listening to #${s.channel}`;

  const obs = `http://127.0.0.1:${s.port}/overlay/`;
  $('obs-url').textContent = obs;

  // One line per thing that can be wrong, so a blank overlay always has a reason
  // on this page rather than only in the console.
  const rows = [];
  rows.push(s.chatConnected
    ? ok(`Reading chat in #${s.channel}`)
    : warn('Connecting to Twitch chat…'));

  if (!s.assets.sprite) {
    rows.push(bad('No sprite sheet — put KawKawSprite_HandDrawn.png in assets/kawkaw/'));
  }
  if (!s.assets.sounds) {
    rows.push(warn('No sound files in assets/kawkaw/ — KawKaw will be silent'));
  }

  rows.push(triggerRow(s));
  $('status-list').innerHTML = rows.join('');

  $('redeem-action').innerHTML = redeemAction(s);
}

const ok   = (t) => `<li>✅ ${esc(t)}</li>`;
const warn = (t) => `<li>⚠️ ${esc(t)}</li>`;
const bad  = (t) => `<li>❌ ${esc(t)}</li>`;

function triggerRow(s) {
  if (s.trigger === 'command') return ok('Summoned by typing !kawkaw in chat');

  const label = s.trigger === 'both' ? '!kawkaw and Channel Points' : 'Channel Points only';
  if (!s.redeem.configured) return bad(`${label} — no Twitch application credentials yet`);
  if (!s.redeem.authorized) return bad(`${label} — not authorized with Twitch yet`);
  if (s.redeem.status === 'subscribed') {
    return ok(`${label} — watching for rewards named "${s.rewardTitle || 'anything'}"`);
  }
  if (s.redeem.status === 'subscribe_failed') return bad(`${label} — Twitch refused the subscription`);
  if (s.redeem.status === 'revoked') return bad(`${label} — Twitch revoked it; authorize again`);
  return warn(`${label} — connecting…`);
}

// The button that used to be a link buried in terminal output.
function redeemAction(s) {
  if (!s.redeem.enabled) {
    return 'Want a Channel Points reward to summon KawKaw? Turn it on in <a href="/settings">Settings</a>.';
  }
  if (!s.redeem.configured) {
    return 'Add your Twitch application credentials to <code>src/backend/.env</code>, then restart KawKaw.';
  }
  if (!s.redeem.authorized || s.redeem.status === 'revoked') {
    return '<a href="/auth/start" class="button-link">Authorize with Twitch</a> — one time, then it renews itself.';
  }
  return 'Create the reward in your Twitch dashboard and name it to match. Viewers redeem it to summon KawKaw.';
}

async function save() {
  const channel = $('setup-channel').value.trim();
  if (!channel) return setStatus('Enter your Twitch channel name.', 'error');

  const body = { channel };
  // Blank means "leave alone" rather than "clear" — sending them only when typed.
  const id = $('setup-client-id').value.trim();
  const secret = $('setup-client-secret').value.trim();
  if (id) body.clientId = id;
  if (secret) body.clientSecret = secret;

  setStatus('Saving…', '');
  try {
    const res = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
    setStatus('', '');
    render(out);
  } catch (e) {
    setStatus(e.message, 'error');
  }
}

function copyObsUrl() {
  const text = $('obs-url').textContent;
  navigator.clipboard.writeText(text).then(
    () => flash('Copied'),
    // Clipboard access can be refused; selecting the text still works.
    () => flash('Select and copy it manually'),
  );
}

function flash(msg) {
  const b = $('copy-btn');
  const was = b.textContent;
  b.textContent = msg;
  setTimeout(() => { b.textContent = was; }, 1500);
}

function setStatus(msg, type) {
  const el = $('setup-status');
  el.textContent = msg;
  el.className = type;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
