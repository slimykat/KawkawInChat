// Transport. The overlay is a pure renderer: the backend owns the engine and
// streams both state and render config here over the loopback WebSocket.
//
// Served by the backend, so the socket always points back at the same origin:
//   http://127.0.0.1:3000/overlay/

// OBS Browser Source allows autoplay.
initAudio();

const connLost = document.getElementById('connection-lost');
const RETRY_MS = 5000;

function connect() {
  const ws = new WebSocket(`ws://${location.host}`);

  ws.addEventListener('open', () => connLost.classList.add('hidden'));

  ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'state_update') onStateUpdate(msg.state);
    else if (msg.type === 'config') setRenderConfig(msg.config);
  });

  ws.addEventListener('close', () => {
    connLost.classList.remove('hidden');
    setTimeout(connect, RETRY_MS);
  });

  ws.addEventListener('error', () => { try { ws.close(); } catch {} });
}

connect();
