// ── URL param parsing ─────────────────────────────────────────────────────────
// Used by OBS Browser Source. Example:
//   http://localhost:3000/overlay?intervalDuration=3&callsToWin=20&startPosX=0.85

const params = new URLSearchParams(location.search);

const cfg = {
  // Game-logic config (also sent to backend)
  intervalDuration:  Number(params.get('intervalDuration')  ?? 3),
  callsToWin:        Number(params.get('callsToWin')        ?? 20),
  shooesToFlee:      Number(params.get('shooesToFlee')       ?? 10),
  maxSessionDuration:Number(params.get('maxSessionDuration') ?? 300),
  // Rendering config (frontend only)
  startPos: {
    x: Number(params.get('startPosX') ?? 0.85),
    y: Number(params.get('startPosY') ?? 0.70),
  },
  endPos: {
    x: Number(params.get('endPosX') ?? 0.15),
    y: Number(params.get('endPosY') ?? 0.70),
  },
  scale: Number(params.get('scale') ?? 3),
};

// Push rendering config into game.js
setRenderConfig(cfg);

// Backend URL: same origin in OBS mode, overridable via ?backendUrl=
const backendUrl = params.get('backendUrl') ?? location.origin;

// ── Config delivery to backend ────────────────────────────────────────────────

async function pushConfig() {
  try {
    await fetch(`${backendUrl}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intervalDuration:   cfg.intervalDuration,
        callsToWin:         cfg.callsToWin,
        shooesToFlee:       cfg.shooesToFlee,
        maxSessionDuration: cfg.maxSessionDuration,
      }),
    });
  } catch (e) {
    console.warn('KawKaw: failed to push config to backend', e);
  }
}

// ── Vote handling ─────────────────────────────────────────────────────────────

let twitchAuthToken = null;

async function sendVote(action) {
  let userId;

  if (window.Twitch?.ext) {
    userId = window.Twitch.ext.viewer.opaqueId;
  } else if (params.get('dev') === 'true') {
    // Dev mode: stable random ID per session
    userId = sessionStorage.getItem('devUserId') ?? crypto.randomUUID();
    sessionStorage.setItem('devUserId', userId);
  } else {
    return; // OBS display-only mode — no voting
  }

  const headers = { 'Content-Type': 'application/json' };
  if (window.Twitch?.ext && twitchAuthToken) {
    headers['Authorization'] = 'Bearer ' + twitchAuthToken;
  }

  try {
    await fetch(`${backendUrl}/vote`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action, userId }),
    });
    document.querySelectorAll('.vote-btn').forEach(b =>
      b.classList.toggle('selected', b.dataset.action === action)
    );
  } catch (e) {
    console.warn('KawKaw: vote failed', e);
  }
}

document.getElementById('btn-shoo').addEventListener('click', () => {
  initAudio();
  sendVote('shoo');
});
document.getElementById('btn-call').addEventListener('click', () => {
  initAudio();
  sendVote('call');
});

// ── Twitch Extension transport ────────────────────────────────────────────────

function applyTwitchConfig() {
  let saved;
  try {
    const raw = window.Twitch.ext.configuration.broadcaster?.content;
    saved = raw ? JSON.parse(raw) : null;
  } catch { saved = null; }

  if (saved) {
    // Merge flat saved fields into cfg so pushConfig() sends streamer's values
    if (saved.intervalDuration  != null) cfg.intervalDuration   = saved.intervalDuration;
    if (saved.callsToWin        != null) cfg.callsToWin         = saved.callsToWin;
    if (saved.shooesToFlee      != null) cfg.shooesToFlee        = saved.shooesToFlee;
    if (saved.maxSessionDuration!= null) cfg.maxSessionDuration  = saved.maxSessionDuration;

    // Map flat pos fields to nested shape expected by setRenderConfig
    setRenderConfig({
      startPos: { x: saved.startPosX ?? cfg.startPos.x, y: saved.startPosY ?? cfg.startPos.y },
      endPos:   { x: saved.endPosX   ?? cfg.endPos.x,   y: saved.endPosY   ?? cfg.endPos.y   },
      scale:    saved.scale           ?? cfg.scale,
      callsToWin:       cfg.callsToWin,
      intervalDuration: cfg.intervalDuration,
    });
  }
}

function initTwitch() {
  setVoteButtonsVisible(true);

  window.Twitch.ext.onAuthorized((auth) => { twitchAuthToken = auth.token; });

  applyTwitchConfig();
  pushConfig();

  // Re-apply if streamer saves new settings while overlay is live
  window.Twitch.ext.configuration.onChanged(() => {
    applyTwitchConfig();
    pushConfig();
  });

  window.Twitch.ext.listen('broadcast', (_target, _contentType, message) => {
    try {
      const { type, state } = JSON.parse(message);
      if (type === 'state_update') onStateUpdate(state);
    } catch {}
  });
}

// ── WebSocket transport (OBS Browser Source) ──────────────────────────────────

const connLost = document.getElementById('connection-lost');
let ws = null;
let wsRetryTimer = null;

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.addEventListener('open', () => {
    connLost.classList.add('hidden');
    clearTimeout(wsRetryTimer);
    wsRetryTimer = null;
  });

  ws.addEventListener('message', (e) => {
    try {
      const { type, state } = JSON.parse(e.data);
      if (type === 'state_update') onStateUpdate(state);
    } catch {}
  });

  ws.addEventListener('close',   scheduleReconnect);
  ws.addEventListener('error',   scheduleReconnect);
}

function scheduleReconnect() {
  if (wsRetryTimer) return;
  connLost.classList.remove('hidden');
  wsRetryTimer = setTimeout(() => {
    wsRetryTimer = null;
    connectWS();
  }, 5000);
}

// ── Entry point ───────────────────────────────────────────────────────────────

if (window.Twitch?.ext) {
  initTwitch();
} else {
  // OBS / dev: vote buttons only in dev mode
  setVoteButtonsVisible(params.get('dev') === 'true');
  pushConfig();
  connectWS();
}
