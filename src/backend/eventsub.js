// EventSub over WebSocket. The backend dials out to Twitch and events arrive
// down that socket — there is no webhook, so nothing has to be publicly
// reachable and there is no callback signature to verify.
//
//   connectEventSub({
//     onWelcome:      async (sessionId) => {},  // subscribe here; fresh sessions only
//     onNotification: (event, subscriptionType) => {},
//     onStatus:       (status, detail) => {},
//   })  →  { close() }
const WebSocket = require('ws');

const DEFAULT_URL = 'wss://eventsub.wss.twitch.tv/ws';
const RETRY_MS = 5000;
// Twitch states a keepalive interval; if nothing arrives within it plus this
// slack, the socket is dead even though TCP hasn't noticed yet.
const KEEPALIVE_GRACE_MS = 5000;
const SEEN_MAX = 500;

function connectEventSub({ url = DEFAULT_URL, onWelcome, onNotification, onStatus } = {}) {
  let ws = null;
  let closed = false;
  let keepaliveTimer = null;
  // Twitch may redeliver a message; ids are unique per delivery attempt, so a
  // repeat means we already acted on it.
  const seen = new Set();

  const status = (s, detail) => onStatus && onStatus(s, detail);

  function armKeepalive(seconds) {
    clearTimeout(keepaliveTimer);
    if (!seconds) return;
    keepaliveTimer = setTimeout(() => {
      console.warn('KawKaw: EventSub went quiet, reconnecting');
      try { ws.close(); } catch {}
    }, seconds * 1000 + KEEPALIVE_GRACE_MS);
  }

  // `reconnectUrl` is set when Twitch asks us to migrate: the new session
  // inherits the existing subscriptions, so we must NOT subscribe again.
  function open(target, isReconnect = false) {
    const socket = new WebSocket(target);
    ws = socket;
    let keepaliveSeconds = null;

    socket.on('message', async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      const id = msg.metadata?.message_id;
      if (id) {
        if (seen.has(id)) return;
        seen.add(id);
        // Bounded — oldest out first. Insertion order is guaranteed for Sets.
        if (seen.size > SEEN_MAX) seen.delete(seen.values().next().value);
      }

      armKeepalive(keepaliveSeconds);

      switch (msg.metadata?.message_type) {
        case 'session_welcome': {
          const session = msg.payload?.session;
          keepaliveSeconds = session?.keepalive_timeout_seconds ?? null;
          armKeepalive(keepaliveSeconds);
          status('connected');
          if (!isReconnect && onWelcome) {
            // 'connected' only means the socket opened. The subscription is a
            // separate Helix call that can still fail (dead token, missing
            // scope), so success gets its own status rather than being implied.
            try { await onWelcome(session?.id); status('subscribed'); }
            catch (err) { status('subscribe_failed', err.message); }
          }
          break;
        }

        case 'session_keepalive':
          break;

        case 'notification':
          if (onNotification) {
            onNotification(msg.payload?.event, msg.payload?.subscription?.type);
          }
          break;

        case 'session_reconnect': {
          // Bring the replacement up before dropping this one, so no event is
          // missed in the gap.
          const next = msg.payload?.session?.reconnect_url;
          if (next) { const old = socket; open(next, true); try { old.close(); } catch {} }
          break;
        }

        case 'revocation':
          status('revoked', msg.payload?.subscription?.status);
          break;
      }
    });

    socket.on('close', () => {
      if (closed || ws !== socket) return;   // superseded by a reconnect
      clearTimeout(keepaliveTimer);
      status('disconnected');
      setTimeout(() => { if (!closed) open(DEFAULT_URL); }, RETRY_MS);
    });

    socket.on('error', (e) => {
      status('error', e.message);
      try { socket.close(); } catch {}
    });
  }

  open(url);

  return {
    close() {
      closed = true;
      clearTimeout(keepaliveTimer);
      try { ws.close(); } catch {}
    },
  };
}

module.exports = { connectEventSub, DEFAULT_URL };
