const test = require('node:test');
const assert = require('node:assert/strict');
require('../catworld-auto-command/timer-settings.js');

const T = globalThis.CatworldTimer;

test('<enter> is sent to the game as an empty line, other commands are untouched', () => {
  assert.equal(T.commandText('<enter>'), '');
  assert.equal(T.commandText('  <ENTER> '), '');
  assert.equal(T.commandText('look'), 'look');
  assert.equal(T.commandText('say <enter>'), 'say <enter>');
  assert.equal(T.commandText(''), '');
});

test('<enter> survives the random-command cleanup', () => {
  assert.deepEqual(T.normalizeRandomItems({ randomItems: [{ command: '<enter>', minSeconds: 5, maxSeconds: 6 }] }).map(item => item.command), ['<enter>']);
});
