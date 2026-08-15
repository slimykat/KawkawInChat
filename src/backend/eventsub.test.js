// Runnable self-check: `node eventsub.test.js`. No framework — assert only.
//
// Drives eventsub.js against a local WebSocket server standing in for Twitch,
// so the protocol handling (welcome, dedup, reconnect migration, revocation) is
// exercised without credentials or network access.
const assert = require('assert');
const { WebSocketServer } = require('ws');
const { connectEventSub } = require('./eventsub.js');

const msg = (type, payload = {}, id = Math.random().toString(36).slice(2)) =>
  JSON.stringify({ metadata: { message_id: id, message_type: type }, payload });

const welcome = (id, keepalive = 30) =>
  msg('session_welcome', { session: { id, keepalive_timeout_seconds: keepalive } });

const redemption = (id) =>
  msg('notification', {
    subscription: { type: 'channel.channel_points_custom_reward_redemption.add' },
    event: { broadcaster_user_id: '1', user_name: 'viewer' },
  }, id);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function server(onConnection) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  wss.on('connection', onConnection);
  return new Promise((res) => wss.on('listening', () =>
    res({ wss, url: `ws://127.0.0.1:${wss.address().port}` })));
}

(async () => {
  // ── Welcome triggers exactly one subscribe, with the session id ─────────────
  {
    const welcomes = [];
    const { wss, url } = await server((ws) => ws.send(welcome('sess-1')));
    const notifications = [];
    const statuses = [];
    const client = connectEventSub({
      url,
      onWelcome: (id) => { welcomes.push(id); },
      onNotification: (e, t) => notifications.push([e, t]),
      onStatus: (s) => statuses.push(s),
    });
    await sleep(300);
    assert.deepEqual(welcomes, ['sess-1'], 'subscribed once with the session id');
    // 'connected' is just the socket; 'subscribed' must come after the Helix call.
    assert.ok(statuses.indexOf('subscribed') > statuses.indexOf('connected'),
      `subscribed reported after connected (got ${JSON.stringify(statuses)})`);
    client.close(); wss.close();
  }

  // ── Notifications reach the caller; duplicates are dropped ─────────────────
  {
    const { wss, url } = await server((ws) => {
      ws.send(welcome('sess-2'));
      ws.send(redemption('dup-id'));
      ws.send(redemption('dup-id'));      // Twitch redelivery
      ws.send(redemption('other-id'));
    });
    const events = [];
    const client = connectEventSub({ url, onNotification: (e, t) => events.push(t) });
    await sleep(300);
    assert.equal(events.length, 2, `redelivered message ignored (got ${events.length})`);
    assert.equal(events[0], 'channel.channel_points_custom_reward_redemption.add');
    client.close(); wss.close();
  }

  // ── session_reconnect migrates without re-subscribing ─────────────────────
  {
    const welcomes = [];
    const events = [];

    // The replacement session inherits subscriptions, so onWelcome must NOT fire.
    const second = await server((ws) => {
      ws.send(welcome('sess-new'));
      ws.send(redemption('after-migration'));
    });

    const first = await server((ws) => {
      ws.send(welcome('sess-old'));
      setTimeout(() => ws.send(msg('session_reconnect', {
        session: { id: 'sess-old', reconnect_url: second.url },
      })), 100);
    });

    const client = connectEventSub({
      url: first.url,
      onWelcome: (id) => { welcomes.push(id); },
      onNotification: (e, t) => events.push(t),
    });
    await sleep(600);
    assert.deepEqual(welcomes, ['sess-old'], 'no re-subscribe on the migrated session');
    assert.equal(events.length, 1, 'events keep flowing after migration');
    client.close(); first.wss.close(); second.wss.close();
  }

  // ── Revocation is surfaced rather than swallowed ───────────────────────────
  {
    const statuses = [];
    const { wss, url } = await server((ws) => {
      ws.send(welcome('sess-3'));
      ws.send(msg('revocation', { subscription: { status: 'authorization_revoked' } }));
    });
    const client = connectEventSub({ url, onStatus: (s, d) => statuses.push([s, d]) });
    await sleep(300);
    assert.ok(statuses.some(([s, d]) => s === 'revoked' && d === 'authorization_revoked'),
      `revocation reported (got ${JSON.stringify(statuses)})`);
    client.close(); wss.close();
  }

  // ── A throwing subscribe is reported, not left to crash the process ───────
  {
    const statuses = [];
    const { wss, url } = await server((ws) => ws.send(welcome('sess-4')));
    const client = connectEventSub({
      url,
      onWelcome: async () => { throw new Error('401 unscoped token'); },
      onStatus: (s, d) => statuses.push([s, d]),
    });
    await sleep(300);
    assert.ok(statuses.some(([s, d]) => s === 'subscribe_failed' && /401/.test(d)),
      'subscribe failure surfaced');
    assert.ok(!statuses.some(([s]) => s === 'subscribed'),
      'a failed subscribe must never report success');
    client.close(); wss.close();
  }

  // ── Malformed frames must not throw ───────────────────────────────────────
  {
    const { wss, url } = await server((ws) => {
      ws.send('not json');
      ws.send('{}');
      ws.send(JSON.stringify({ metadata: null }));
      ws.send(welcome('sess-5'));
    });
    const welcomes = [];
    const client = connectEventSub({ url, onWelcome: (id) => welcomes.push(id) });
    await sleep(300);
    assert.deepEqual(welcomes, ['sess-5'], 'survives garbage and still handles the welcome');
    client.close(); wss.close();
  }

  console.log('eventsub.test.js: all assertions passed');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
