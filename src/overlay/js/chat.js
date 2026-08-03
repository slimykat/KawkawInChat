// Anonymous Twitch chat reader (OBS path). Connects a browser WebSocket to
// Twitch IRC with no auth — login as justinfan<random>, JOIN the channel, and
// parse !call / !shoo / !kawkaw out of PRIVMSG lines. Auto-retries every 5s.
//
//   connectChat('somechannel', {
//     onCommand: ({ userId, action, privileged }) => {},
//     onStatus:  (status) => {},   // 'open' | 'closed'
//   })  →  { close() }

function connectChat(channel, { onCommand, onStatus } = {}) {
  channel = String(channel || '').toLowerCase().replace(/^#/, '');
  let ws = null;
  let retry = null;
  let closed = false;

  function open() {
    ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    ws.addEventListener('open', () => {
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send('NICK justinfan' + Math.floor(Math.random() * 90000 + 10000));
      ws.send('JOIN #' + channel);
      onStatus && onStatus('open');
    });
    ws.addEventListener('message', (e) => {
      for (const line of e.data.split('\r\n')) {
        if (!line) continue;
        if (line.startsWith('PING')) { ws.send('PONG :tmi.twitch.tv'); continue; }
        const cmd = parseCommand(line);
        if (cmd) onCommand && onCommand(cmd);
      }
    });
    ws.addEventListener('close', scheduleRetry);
    ws.addEventListener('error', () => { try { ws.close(); } catch {} });
  }

  function scheduleRetry() {
    if (closed || retry) return;
    onStatus && onStatus('closed');
    retry = setTimeout(() => { retry = null; open(); }, 5000);
  }

  open();
  return { close() { closed = true; clearTimeout(retry); if (ws) try { ws.close(); } catch {} } };
}

// Parse one IRC line → { userId, action, privileged } for our commands, else null.
// Shared shape with the relay bot's parser (bot/bot.js) — keep them in sync.
function parseCommand(line) {
  let tags = {};
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
  const token = text.trim().split(/\s+/)[0].toLowerCase();

  const action = token === '!call' ? 'call' : token === '!shoo' ? 'shoo' : token === '!kawkaw' ? 'kawkaw' : null;
  if (!action) return null;

  const badges = tags['badges'] || '';
  return {
    userId: tags['user-id'] || prefix.split('!')[0] || 'anon',
    action,
    privileged: tags['mod'] === '1' || /\bbroadcaster\b/.test(badges) || /\bmoderator\b/.test(badges),
  };
}
