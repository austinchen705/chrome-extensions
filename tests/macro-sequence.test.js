const test = require('node:test');
const assert = require('node:assert/strict');
require('../catworld-auto-command/macro-wait.js');

const M = globalThis.CatworldMacro;

test('a command that chains several commands or waits must go through the macro runner', () => {
  assert.equal(M.isSequence('sk -r;<enter>'), true);
  assert.equal(M.isSequence('look;@等待 2;ps'), true);
  assert.equal(M.isSequence('@等待 3'), true);
  assert.equal(M.isSequence('@wait 1-2'), true);
});

test('a plain single command stays a plain command, and so does a lone <enter>', () => {
  assert.equal(M.isSequence('sk -r'), false);
  assert.equal(M.isSequence('<enter>'), false);
  assert.equal(M.isSequence(''), false);
  assert.equal(M.isSequence(undefined), false);
});
