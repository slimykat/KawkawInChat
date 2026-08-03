// Transport. The overlay is a pure renderer: the backend owns the engine and
// streams state here over the loopback WebSocket. Nothing is computed locally.
//
// Served by the backend, so the socket always points back at the same origin:
//   http://127.0.0.1:3000/overlay/

const params = new URLSearchParams(location.search);

// Numeric query param, or `dflt` when absent/blank/unparseable. Never yields NaN —
// one bad param would otherwise put KawKaw off-screen.
function qs(key, dflt) {
  const raw = (params.get(key) ?? '').trim();
  return raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : dflt;
}

// Render config still comes from the URL; the config page takes this over next.
setRenderConfig({
  startPos: { x: qs('startPosX', 0.85), y: qs('startPosY', 0.70) },
  endPos:   { x: qs('endPosX',   0.15), y: qs('endPosY',   0.70) },
  scale:    qs('scale', 3),
});

// OBS Browser Source allows autoplay.
initAudio();

const connLost = document.getElementById('connection-lost');
const RETRY_MS = 5000;

function connect() {
  const ws = new WebSocket(`ws://${location.host}`);

  ws.addEventListener('open', () => connLost.classList.add('hidden'));

  ws.addEventListener('message', (e) => {
    try {
      const { type, state } = JSON.parse(e.data);
      if (type === 'state_update') onStateUpdate(state);
    } catch {}
  });

  ws.addEventListener('close', () => {
    connLost.textContent = 'Backend not running — retrying…';
    connLost.classList.remove('hidden');
    setTimeout(connect, RETRY_MS);
  });

  ws.addEventListener('error', () => { try { ws.close(); } catch {} });
}

connect();
