// Twitch OAuth + Helix, over the `https` module (Node 16 has no global fetch).
//
// Only needed for the Channel Points redeem trigger — the chat-command trigger
// reads chat anonymously and never touches any of this.
//
// Tokens live in tokens.json (0600, gitignored). Every call here is outbound;
// the only inbound step is the one-time OAuth redirect, which lands on the
// backend's existing loopback server.
const fs = require('fs');
const https = require('https');
const path = require('path');

const TOKENS = path.join(__dirname, 'tokens.json');
const SCOPES = ['channel:read:redemptions'];

// Refresh this far before actual expiry, so a token can't die mid-request.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(json);
        reject(new Error(`HTTP ${res.statusCode} ${url} — ${json?.message || text.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const form = (obj) => new URLSearchParams(obj).toString();

// ── Token storage ─────────────────────────────────────────────────────────────

function loadTokens() {
  try { return JSON.parse(fs.readFileSync(TOKENS, 'utf8')); }
  catch { return null; }
}

function saveTokens(t) {
  // 0600 before writing: the refresh token is a long-lived credential and must
  // not be world-readable even briefly.
  fs.writeFileSync(TOKENS, JSON.stringify(t, null, 2), { mode: 0o600 });
  try { fs.chmodSync(TOKENS, 0o600); } catch {}
}

function clearTokens() { try { fs.unlinkSync(TOKENS); } catch {} }

// ── Authorization code flow ───────────────────────────────────────────────────

function createAuth({ clientId, clientSecret, redirectUri }) {
  const configured = Boolean(clientId && clientSecret);

  function authorizeUrl(state) {
    return 'https://id.twitch.tv/oauth2/authorize?' + form({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      state,
    });
  }

  async function exchangeCode(code) {
    const t = await request('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });
    return store(t);
  }

  async function refresh(refreshToken) {
    const t = await request('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    return store(t);
  }

  function store(t) {
    const saved = {
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: Date.now() + (t.expires_in ?? 3600) * 1000,
      scope: t.scope,
    };
    saveTokens(saved);
    return saved;
  }

  // Current access token, refreshed if it is expired or close to it.
  // Returns null when the streamer has not authorized yet.
  async function accessToken() {
    let t = loadTokens();
    if (!t?.refresh_token) return null;
    if (t.expires_at && t.expires_at - Date.now() > REFRESH_MARGIN_MS) return t.access_token;

    try {
      t = await refresh(t.refresh_token);
      return t.access_token;
    } catch (err) {
      // A revoked or rotated refresh token can never recover on its own —
      // drop it so the backend prints a fresh authorize link instead of
      // retrying a dead credential forever.
      console.error('KawKaw: token refresh failed, re-authorization needed —', err.message);
      clearTokens();
      return null;
    }
  }

  async function helix(pathAndQuery, opts = {}) {
    const token = await accessToken();
    if (!token) throw new Error('not authorized');
    return request('https://api.twitch.tv/helix' + pathAndQuery, {
      ...opts,
      headers: {
        Authorization: `Bearer ${token}`,
        'Client-Id': clientId,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        ...opts.headers,
      },
    });
  }

  async function broadcasterId(login) {
    const res = await helix('/users?login=' + encodeURIComponent(login));
    const id = res?.data?.[0]?.id;
    if (!id) throw new Error(`no such Twitch user: ${login}`);
    return id;
  }

  // Subscribe to Channel Points redemptions over an EventSub *WebSocket* session.
  // WebSocket transport is what keeps this backend private: Twitch pushes events
  // down the socket we opened, so there is no webhook for anyone to reach.
  function subscribeRedemptions(sessionId, broadcaster) {
    return helix('/eventsub/subscriptions', {
      method: 'POST',
      body: JSON.stringify({
        type: 'channel.channel_points_custom_reward_redemption.add',
        version: '1',
        condition: { broadcaster_user_id: String(broadcaster) },
        transport: { method: 'websocket', session_id: sessionId },
      }),
    });
  }

  return {
    configured, authorizeUrl, exchangeCode, accessToken, helix,
    broadcasterId, subscribeRedemptions,
    hasTokens: () => Boolean(loadTokens()?.refresh_token),
  };
}

module.exports = { createAuth, loadTokens, saveTokens, clearTokens, TOKENS, SCOPES };
