// Runnable self-check: `node chat.test.js`. No framework — assert only.
const assert = require('assert');
const { parseCommand } = require('./chat.js');

const TAGS = '@badges=;mod=0;user-id=42';
const FROM = ':bob!bob@bob.tmi.twitch.tv';
const line = (tags, text) => `${tags} ${FROM} PRIVMSG #chan :${text}`;

// Commands are recognised, case-insensitively, and carry the tag user-id.
assert.deepEqual(parseCommand(line(TAGS, '!call')),
  { userId: '42', name: 'bob', action: 'call', privileged: false });
assert.equal(parseCommand(`@display-name=Bob;user-id=42 ${FROM} PRIVMSG #chan :!call`).name, 'Bob',
  'display name preferred for the console');
assert.equal(parseCommand(line(TAGS, '!SHOO')).action, 'shoo', 'case-insensitive');
assert.equal(parseCommand(line(TAGS, '!kawkaw')).action, 'kawkaw');

// Command must lead the message — trailing words are fine, leading ones are not.
assert.equal(parseCommand(line(TAGS, '!call now pls')).action, 'call', 'trailing words ok');
assert.equal(parseCommand(line(TAGS, 'hey !call')), null, 'must be the first token');
assert.equal(parseCommand(line(TAGS, 'calling it')), null);
assert.equal(parseCommand(line(TAGS, '!callx')), null, 'no prefix matching');

// Privilege comes from the mod tag or a broadcaster/moderator badge.
assert.equal(parseCommand(line('@mod=1;user-id=1', '!kawkaw')).privileged, true, 'mod tag');
assert.equal(parseCommand(line('@badges=broadcaster/1;user-id=1', '!kawkaw')).privileged, true, 'broadcaster badge');
assert.equal(parseCommand(line('@badges=moderator/1;user-id=1', '!kawkaw')).privileged, true, 'moderator badge');
assert.equal(parseCommand(line('@badges=subscriber/12;user-id=1', '!kawkaw')).privileged, false, 'subs are not privileged');
assert.equal(parseCommand(line('@badges=vip/1;mod=0;user-id=1', '!kawkaw')).privileged, false);

// Non-PRIVMSG traffic is ignored — JOINs, NOTICEs, the MOTD, keepalives.
assert.equal(parseCommand(':tmi.twitch.tv 376 justinfan1 :>'), null);
assert.equal(parseCommand(`${FROM} JOIN #chan`), null);
assert.equal(parseCommand('@msg-id=x :tmi.twitch.tv NOTICE #chan :!call'), null, 'NOTICE is not a command');
assert.equal(parseCommand('PING :tmi.twitch.tv'), null);

// Untagged lines still work — fall back to the nick from the prefix.
assert.equal(parseCommand(`${FROM} PRIVMSG #chan :!call`).userId, 'bob', 'nick fallback');

// Malformed input must not throw.
for (const bad of ['', ':', '@', '@a=1', 'PRIVMSG', `${FROM} PRIVMSG #chan`]) {
  assert.doesNotThrow(() => parseCommand(bad), `threw on ${JSON.stringify(bad)}`);
}

console.log('chat.test.js: all assertions passed');
