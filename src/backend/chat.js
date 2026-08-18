// Anonymous Twitch chat reader. Connects to Twitch IRC with no auth — login as
// justinfan<random>, JOIN the channel, parse !call / !shoo / !kawkaw out of
// PRIVMSG lines. Read-only by construction: an anonymous login cannot send.
//
//   connectChat('somechannel', (cmd) => {})   // cmd: { userId, action, privileged }
const WebSocket = require('ws');

const IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';
const RETRY_MS = 5000;

function connectChat(channel, onCommand) {
  let ws = null;
  let closed = false;

  function open() {
    ws = new WebSocket(IRC_URL);

    ws.on('open', () => {
      // Tags carry user-id, mod and badges — without them there is no way to
      // cap per user or tell a mod's !kawkaw from a viewer's.
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send('NICK justinfan' + Math.floor(Math.random() * 90000 + 10000));
      ws.send('JOIN #' + channel);
      console.log(`KawKaw: joined #${channel}`);
    });

    ws.on('message', (data) => {
      for (const line of data.toString().split('\r\n')) {
        if (!line) continue;
        if (line.startsWith('PING')) { ws.send('PONG :tmi.twitch.tv'); continue; }
        const cmd = parseCommand(line);
        if (cmd) onCommand(cmd);
      }
    });

    ws.on('close', () => {
      if (closed) return;
      console.warn(`KawKaw: chat disconnected, retrying in ${RETRY_MS / 1000}s`);
      setTimeout(open, RETRY_MS);
    });

    ws.on('error', (e) => {
      console.warn('KawKaw: chat error —', e.message);
      try { ws.close(); } catch {}
    });
  }

  open();
  return {
    // For the status page: distinguishes "joined" from "retrying".
    get connected() { return ws?.readyState === 1; },
    close() { closed = true; try { ws.close(); } catch {} },
  };
}

// One IRC line → { userId, name, action, privileged }, or null if it isn't ours.
// `name` is for the console only — never for identity, which is always userId.
//
//   @badges=broadcaster/1;mod=0;user-id=123 :nick!… PRIVMSG #chan :!call
//   └──────────── tags ───────────────────┘ └prefix┘ └cmd┘ └chan┘ └text┘
function parseCommand(line) {
  const tags = {};
  if (line[0] === '@') {
    const sp = line.indexOf(' ');
    for (const kv of line.slice(1, sp).split(';')) {
      const i = kv.indexOf('=');
      tags[kv.slice(0, i)] = kv.slice(i + 1);
    }
    line = line.slice(sp + 1);
  }

  let prefix = '';
  if (line[0] === ':') { const sp = line.indexOf(' '); prefix = line.slice(1, sp); line = line.slice(sp + 1); }

  const sp = line.indexOf(' ');
  if ((sp === -1 ? line : line.slice(0, sp)) !== 'PRIVMSG') return null;

  const rest = line.slice(sp + 1);
  const c = rest.indexOf(':');
  const text = c === -1 ? '' : rest.slice(c + 1);
  // First token only — "!call now" counts, "hey !call" does not.
  const token = text.trim().split(/\s+/)[0].toLowerCase();

  const action = token === '!call' ? 'call' : token === '!shoo' ? 'shoo' : token === '!kawkaw' ? 'kawkaw' : null;
  if (!action) return null;

  const badges = tags['badges'] || '';
  const nick = prefix.split('!')[0];
  return {
    userId: tags['user-id'] || nick || 'anon',
    name: tags['display-name'] || nick || 'someone',
    action,
    privileged: tags['mod'] === '1' || /\bbroadcaster\b/.test(badges) || /\bmoderator\b/.test(badges),
  };
}

module.exports = { connectChat, parseCommand };
