// 停止關鍵字：遊戲輸出含清單裡的詞就停止所有功能並警報。純函式直接測；遊戲頁用整個 content script 在 jsdom 裡跑。
const test = require('node:test');
const assert = require('node:assert/strict');
const { ui, boot, sleep, waitFor, START } = require('./helpers/game-page');

require('../catworld-auto-command/stop-keywords.js');
const K = globalThis.CatworldStopKeywords;

test('normalize: a missing setting means on with the default list, and a broken one falls back', () => {
  assert.deepEqual(K.normalize(undefined), { enabled: true, words: 'jrealm' });
  assert.deepEqual(K.normalize(null), { enabled: true, words: 'jrealm' });
  assert.deepEqual(K.normalize({ enabled: false, words: 'a、b' }), { enabled: false, words: 'a、b' });
  assert.deepEqual(K.normalize({ words: 5 }), { enabled: true, words: 'jrealm' });
  assert.deepEqual(K.normalize({ enabled: true, words: '' }), { enabled: true, words: '' }, 'an emptied list stays empty');
});

test('list: several separators, trimmed, no duplicates, no empty ones, bounded', () => {
  assert.deepEqual(K.list('jrealm、 GM ,管理員;巫師\nJRealm'), ['jrealm', 'GM', '管理員', '巫師']);
  assert.deepEqual(K.list(''), []);
  assert.deepEqual(K.list(null), []);
  assert.deepEqual(K.list('a'.repeat(K.MAX_LENGTH + 1)), [], 'a word that is too long is dropped');
  assert.equal(K.list(Array.from({ length: 80 }, (_, i) => `w${i}`).join('、')).length, K.MAX_WORDS);
});

test('find: case-insensitive substring, first word of the list that hits, and typed-command echoes do not count', () => {
  assert.equal(K.find('你看到 JRealm 的使者走了過來。', 'jrealm'), 'jrealm');
  assert.equal(K.find('管理員來了', 'jrealm、管理員'), '管理員');
  assert.equal(K.find('nothing here', 'jrealm'), null);
  assert.equal(K.find('> say jrealm', 'jrealm'), null, 'the echo of what you typed');
  assert.equal(K.find('> say hi\n  jrealm 出現了', 'jrealm'), 'jrealm', 'but a later line still counts');
  assert.equal(K.find('jrealm', ''), null, 'an empty list never hits');
  assert.equal(K.find('', 'jrealm'), null);
});

const alerts = page => page.messages.filter(message => message.type === 'ALERT');
const say = (page, text) => page.output(`<span>${text}\n</span>`);

ui('with nothing saved the default word stops everything and raises one alert', async () => {
  const page = await boot({ scale: 20 });
  try {
    await page.ask(START);
    assert.ok(await page.running());
    say(page, '一個自稱 JRealm 的人出現了。');
    assert.ok(await waitFor(() => alerts(page).length === 1, 2000));
    assert.match(alerts(page)[0].reason, /關鍵字「jrealm」/);
    assert.equal(await page.running(), false, 'the timer is stopped');
    say(page, 'jrealm 又說了一次。');
    await sleep(200);
    assert.equal(alerts(page).length, 1, 'the same hit again right away does not alert again');
  } finally {
    page.close();
  }
});

ui('it also alerts when nothing is running, and the list from the settings is used', async () => {
  const page = await boot({ scale: 20 });
  try {
    page.store.stopKeywords = { enabled: true, words: '巫師、foo' };
    await sleep(50);
    page.changeListeners.forEach(listener => listener({ stopKeywords: { newValue: page.store.stopKeywords } }, 'local'));
    say(page, '默認詞 jrealm 不在清單裡。');
    await sleep(200);
    assert.equal(alerts(page).length, 0);
    say(page, '一位巫師走過來。');
    assert.ok(await waitFor(() => alerts(page).length === 1, 2000));
  } finally {
    page.close();
  }
});

ui('switched off, nothing happens', async () => {
  const page = await boot({ scale: 20 });
  try {
    const value = { enabled: false, words: 'jrealm' };
    page.store.stopKeywords = value;
    page.changeListeners.forEach(listener => listener({ stopKeywords: { newValue: value } }, 'local'));
    await page.ask(START);
    say(page, 'jrealm');
    await sleep(300);
    assert.equal(alerts(page).length, 0);
    assert.ok(await page.running());
    await page.ask({ type: 'STOP' });
  } finally {
    page.close();
  }
});
