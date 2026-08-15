// Runnable self-check: `node config.test.js`. No framework — assert only.
const assert = require('assert');
const { validate, defaults, engineConfig, renderConfig, rewardMatches } = require('./config.js');
const { DEFAULTS: ENGINE } = require('./engine.js');

// Defaults are not restated — engine numbers come from engine.js.
assert.equal(defaults().step, ENGINE.step, 'step default tracks the engine');
assert.equal(defaults().perUserCap, ENGINE.perUserCap);
assert.equal(defaults().trigger, 'command');

// A partial save keeps defaults for everything it didn't mention.
const partial = validate({ step: 0.8 });
assert.equal(partial.config.step, 0.8);
assert.equal(partial.config.decay, ENGINE.decay, 'untouched keys keep defaults');
assert.deepEqual(partial.clamped, []);

// Out-of-range numbers clamp, and say so.
assert.equal(validate({ step: 999 }).config.step, 5, 'clamped to max');
assert.equal(validate({ decay: -3 }).config.decay, 0, 'clamped to min');
assert.deepEqual(validate({ step: 999 }).clamped, ['step']);
assert.equal(validate({ startPosX: 4 }).config.startPosX, 1, 'positions are 0–1');

// Garbage never reaches the engine — it falls back to the default, not NaN.
for (const bad of ['abc', '', null, undefined, NaN, {}, [], Infinity]) {
  const { config } = validate({ step: bad });
  assert.equal(config.step, ENGINE.step, `step survived ${JSON.stringify(bad)}`);
  assert.ok(Number.isFinite(config.step));
}

// Enum fields reject anything not on the list.
assert.equal(validate({ trigger: 'both' }).config.trigger, 'both');
assert.equal(validate({ trigger: 'nonsense' }).config.trigger, 'command', 'falls back');
assert.equal(validate({ trigger: 5 }).config.trigger, 'command');

// Unknown keys are dropped rather than persisted.
const injected = validate({ step: 1, evil: 'x', __proto__: { polluted: true } });
assert.equal(injected.config.evil, undefined, 'unknown key dropped');
assert.equal({}.polluted, undefined, 'no prototype pollution');

// Non-object input yields clean defaults instead of throwing.
for (const bad of [null, undefined, 'string', 42, []]) {
  assert.deepEqual(validate(bad).config, defaults(), `defaults for ${JSON.stringify(bad)}`);
}

// A partial update merges onto the current config — it must not reset the rest.
// (A CLI setting one value would otherwise silently wipe every other setting.)
const current = validate({ trigger: 'both', step: 0.9, scale: 5 }).config;
const patched = validate({ decay: 0.2 }, current).config;
assert.equal(patched.decay, 0.2, 'the named field changes');
assert.equal(patched.trigger, 'both', 'unnamed enum survives');
assert.equal(patched.step, 0.9, 'unnamed number survives');
assert.equal(patched.scale, 5, 'unnamed render field survives');

// A base missing keys (an older config.json) still fills from defaults.
assert.equal(validate({}, { step: 0.9 }).config.decay, ENGINE.decay, 'gaps in base fill from defaults');

// Projections hand each consumer only what it needs.
const c = validate({ step: 0.7, startPosX: 0.2, scale: 4 }).config;
assert.deepEqual(Object.keys(engineConfig(c)).sort(),
  ['decay', 'maxSessionDuration', 'perUserCap', 'step', 'terminalHoldMs']);
assert.equal(engineConfig(c).startPosX, undefined, 'render keys stay out of the engine');
assert.deepEqual(renderConfig(c).startPos, { x: 0.2, y: 0.70 });
assert.equal(renderConfig(c).scale, 4);

// Orientation: flipX is stored 0/1 but reaches the overlay as a boolean, and the
// overlay needs terminalHoldMs to time the exit animation.
assert.equal(renderConfig(validate({ flipX: '1' }).config).flipX, true, 'mirrored');
assert.equal(renderConfig(validate({ flipX: '0' }).config).flipX, false, 'normal');
assert.equal(renderConfig(c).terminalHoldMs, ENGINE.terminalHoldMs, 'exit timing reaches the overlay');
assert.equal(validate({ rotation: 400 }).config.rotation, 180, 'rotation clamped');
assert.equal(validate({ rotation: -90 }).config.rotation, -90, 'negative rotation kept');

// Volume is a percent; the overlay divides by 100, so a bad value must not reach it as NaN.
assert.equal(defaults().volume, 100, 'full volume by default');
assert.equal(validate({ volume: 250 }).config.volume, 100, 'volume clamped to 100');
assert.equal(validate({ volume: 0 }).config.volume, 0, 'muting is allowed');
assert.equal(validate({ volume: 'loud' }).config.volume, 100, 'garbage falls back, never NaN');

// Who may summon: open to chat by default, restrictable to mods.
assert.equal(defaults().summonBy, 'everyone', 'anyone can summon out of the box');
assert.equal(validate({ summonBy: 'mods' }).config.summonBy, 'mods');
assert.equal(validate({ summonBy: 'subs' }).config.summonBy, 'everyone', 'unknown falls back to open');

// Reward title is free text: trimmed, length-capped, and blank is a real value.
assert.equal(defaults().rewardTitle, 'KawKaw');
assert.equal(validate({ rewardTitle: '  Summon KawKaw  ' }).config.rewardTitle, 'Summon KawKaw', 'trimmed');
assert.deepEqual(validate({ rewardTitle: 'KawKaw' }).clamped, [], 'an unchanged title is not "adjusted"');
assert.deepEqual(validate({ rewardTitle: ' KawKaw ' }).clamped, ['rewardTitle'], 'trimming is reported');
assert.equal(validate({ rewardTitle: 'x'.repeat(200) }).config.rewardTitle.length, 80, 'length capped');
assert.equal(validate({ rewardTitle: '' }).config.rewardTitle, '', 'blank is kept — it means "any reward"');
assert.equal(validate({ rewardTitle: 42 }).config.rewardTitle, 'KawKaw', 'non-string falls back');

// Matching: substring, case-insensitive, blank matches everything.
const named = validate({ rewardTitle: 'KawKaw' }).config;
assert.ok(rewardMatches(named, 'KawKaw'), 'exact');
assert.ok(rewardMatches(named, 'Summon kawkaw!'), 'substring, any case');
assert.ok(!rewardMatches(named, 'Hydrate'), 'an unrelated reward must not start an encounter');
assert.ok(!rewardMatches(named, undefined), 'a reward with no title never matches a named filter');
const anyReward = validate({ rewardTitle: '' }).config;
assert.ok(rewardMatches(anyReward, 'Hydrate'), 'blank filter accepts anything');
assert.ok(rewardMatches(anyReward, undefined), 'blank filter tolerates a missing title');

console.log('config.test.js: all assertions passed');
