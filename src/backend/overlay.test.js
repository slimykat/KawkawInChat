// Runnable self-check: `node overlay.test.js`.
//
// The overlay's scripts are plain <script> tags, not modules, so they all share
// one global scope. A `const` in one file colliding with a `const` in another is
// a parse-time SyntaxError that kills the *whole* second file — the overlay then
// loads, connects, and renders nothing, with the only clue in the browser
// console. That is exactly how `anim` (sprites.js) vs `anim` (game.js) shipped.
//
// Concatenating them in source order and compiling reproduces the browser's
// scope rules without a browser.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = path.join(__dirname, '../overlay');

// Source order, as index.html loads them. Kept in sync by the assert below.
const SCRIPTS = ['js/sprites.js', 'js/audio.js', 'js/game.js', 'js/main.js'];

const inHtml = [...fs.readFileSync(path.join(DIR, 'index.html'), 'utf8')
  .matchAll(/<script src="([^"?]+)/g)].map((m) => m[1]);
assert.deepEqual(inHtml, SCRIPTS, 'index.html script order changed — update SCRIPTS');

const combined = SCRIPTS
  .map((f) => `// ---- ${f} ----\n${fs.readFileSync(path.join(DIR, f), 'utf8')}`)
  .join('\n');

// Compile only. Running it would need a DOM; a redeclaration fails at compile.
assert.doesNotThrow(() => new vm.Script(combined), 'overlay scripts collide in global scope');

console.log('overlay: ok');
