// Transport wiring. Two hosts:
//   OBS  — run the engine locally, fed by anonymous IRC (zero backend).
//   Twitch Extension — render state broadcast by the relay bot over PubSub.
//
// OBS example:
//   .../overlay/index.html?channel=YOURCHANNEL&step=0.5&decay=0.05

const params = new URLSearchParams(location.search);

// Numeric query param, or `dflt` when absent/blank/unparseable. Never yields NaN —
// one bad param would otherwise poison the meter permanently.
function qs(key, dflt) {
  const raw = (params.get(key) ?? '').trim();
  return raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : dflt;
}

// Engine knobs: pass through ONLY what the URL sets, so meter.js DEFAULTS stays the
// single source for the numbers (an explicit `undefined` would clobber them).
const engineCfg = {};
for (const key of ['step', 'decay', 'maxSessionDuration', 'perUserCap']) {
  const v = qs(key, undefined);
  if (v !== undefined) engineCfg[key] = v;
}

const cfg = {
  channel: (params.get('channel') || '').toLowerCase(),
  trigger: params.get('trigger') || 'command',
  ...engineCfg,
  // Render defaults — mirrored in game.js renderCfg for the no-param case.
  startPos: { x: qs('startPosX', 0.85), y: qs('startPosY', 0.70) },
  endPos:   { x: qs('endPosX',   0.15), y: qs('endPosY',   0.70) },
  scale:    qs('scale', 3),
};

setRenderConfig({ startPos: cfg.startPos, endPos: cfg.endPos, scale: cfg.scale });

// OBS Browser Source allows autoplay; the Extension stays silent until a gesture.
initAudio();

const connLost = document.getElementById('connection-lost');

if (window.Twitch?.ext) {
  initExtension();
} else {
  initOBS();
}

// ── OBS: local engine + anonymous chat ────────────────────────────────────────

function initOBS() {
  if (!cfg.channel) {
    connLost.textContent = 'No channel — add ?channel=yourname to the URL';
    connLost.classList.remove('hidden');
    return;
  }

  const engine = KawKawEngine.createEngine(cfg);
  const allowCommandTrigger = cfg.trigger === 'command' || cfg.trigger === 'both';

  connectChat(cfg.channel, {
    onStatus: (s) => connLost.classList.toggle('hidden', s === 'open'),
    onCommand: ({ userId, action, privileged }) => {
      if (action === 'kawkaw') {
        if (allowCommandTrigger && privileged) engine.start();
      } else {
        engine.command(userId, action);
      }
    },
  });

  // One tick per second — matches Twitch PubSub's 1 msg/sec ceiling too.
  setInterval(() => { if (engine.tick()) onStateUpdate(engine.getState()); }, 1000);
}

// ── Twitch Extension: render bot broadcasts ───────────────────────────────────

function initExtension() {
  applyTwitchConfig();
  window.Twitch.ext.configuration.onChanged(applyTwitchConfig);
  window.Twitch.ext.listen('broadcast', (_target, _contentType, message) => {
    try {
      const { type, state } = JSON.parse(message);
      if (type === 'state_update') onStateUpdate(state);
    } catch {}
  });
}

// Rendering config lives in the broadcaster configuration segment (per-broadcaster).
function applyTwitchConfig() {
  let saved;
  try {
    const raw = window.Twitch.ext.configuration.broadcaster?.content;
    saved = raw ? JSON.parse(raw) : null;
  } catch { saved = null; }
  if (!saved) return;

  setRenderConfig({
    startPos: { x: saved.startPosX ?? cfg.startPos.x, y: saved.startPosY ?? cfg.startPos.y },
    endPos:   { x: saved.endPosX   ?? cfg.endPos.x,   y: saved.endPosY   ?? cfg.endPos.y   },
    scale:    saved.scale ?? cfg.scale,
  });
}
