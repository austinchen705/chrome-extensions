// 聊天回覆：遊戲輸出裡別人對我說的話（[P]X回答你：…）和我的回覆（[P]你告訴X：…、[P]你回答X：…）配成一筆筆「對方說 → 我回」存起來。
// 純函式（解析、配對、去重、上限）直接測；遊戲頁用整個 content script 在 jsdom 裡跑。
const test = require('node:test');
const assert = require('node:assert/strict');
const { ui, boot, waitFor } = require('./helpers/game-page');

require('../catworld-auto-command/chat-reply.js');
const Chat = globalThis.CatworldChatReply;

const feedAll = (recorder, ...texts) => texts.flatMap(text => recorder.feed(text));

test('an incoming line followed by my tell or reply to the same person makes one pair', () => {
  const tell = Chat.createRecorder({ now: () => 0 });
  assert.deepEqual(feedAll(tell, '[P]有氣質回答你：測試\n', '[P]你告訴有氣質：我在蒐集講話格式\n').map(({ said, reply }) => ({ said, reply })), [{ said: '測試', reply: '我在蒐集講話格式' }]);
  const reply = Chat.createRecorder({ now: () => 0 });
  assert.deepEqual(feedAll(reply, '[P]有氣質回答你：我上夜班4天\n', '[P]你回答有氣質：hehe\n').map(({ said, reply: text }) => ({ said, reply: text })), [{ said: '我上夜班4天', reply: 'hehe' }]);
});

test('a line that arrives cut in two batches is read once it is complete, and half a line is never recorded', () => {
  const recorder = Chat.createRecorder({ now: () => 0 });
  assert.deepEqual(feedAll(recorder, '[P]有氣質回答你：測', '試\n[P]你告訴有氣質：好'), []);
  const pairs = recorder.feed('喔\n');
  assert.deepEqual(pairs.map(({ said, reply }) => ({ said, reply })), [{ said: '測試', reply: '好喔' }]);
  const half = Chat.createRecorder({ now: () => 0 });
  half.feed('[P]有氣質回答你：嗨\n');
  assert.deepEqual(half.feed('[P]你回答有氣質：嗨'), [], 'a line without its line break yet is not a reply');
});

test('public say, unanswered lines, another person, a late answer, echoes and unsafe replies are not recorded', () => {
  let clock = 0;
  const recorder = Chat.createRecorder({ now: () => clock });
  assert.deepEqual(feedAll(recorder, '[P]你說道：test\n', '[P]有氣質回答你：嗨\n'), [], 'nothing answered yet');
  assert.deepEqual(feedAll(recorder, '[P]你告訴別人：哈囉\n'), [], 'a different person');
  assert.deepEqual(feedAll(recorder, '> reply 嗨\n', '> [P]你回答有氣質：嗨\n'), [], 'echoes of typed commands');
  clock += Chat.PAIR_WINDOW_MS + 1000;
  assert.deepEqual(feedAll(recorder, '[P]你回答有氣質：太晚了\n'), [], 'two minutes later is too late');
  assert.deepEqual(feedAll(recorder, '[P]有氣質回答你：再來\n', '[P]你回答有氣質：a;b\n'), [], 'a reply with a semicolon would run as a macro');
  assert.deepEqual(feedAll(recorder, '[P]有氣質回答你：\n', '[P]你回答有氣質：好\n'), [], 'an empty incoming message');
  assert.deepEqual(feedAll(recorder, '[P]有氣質回答你：一\n', '[P]你回答有氣質：二\n').length, 1, 'and a normal one still works afterwards');
});

test('an unsafe reply does not use up the incoming message, and an empty incoming line clears the older one', () => {
  const recorder = Chat.createRecorder({ now: () => 0 });
  assert.deepEqual(feedAll(recorder, '[P]有氣質回答你：嗨\n', '[P]你回答有氣質：a;b\n'), []);
  assert.deepEqual(feedAll(recorder, '[P]你回答有氣質：好\n').map(({ said, reply }) => ({ said, reply })), [{ said: '嗨', reply: '好' }], 'a clean reply still pairs with the same message');
  const empty = Chat.createRecorder({ now: () => 0 });
  assert.deepEqual(feedAll(empty, '[P]有氣質回答你：舊的\n', '[P]有氣質回答你：\n', '[P]你回答有氣質：好\n'), [], 'it must not pair with the older line');
});

test('addPair skips a pair that is already there and keeps only the newest MAX_PAIRS', () => {
  const one = { said: 'a', reply: 'b', at: 1 };
  assert.deepEqual(Chat.addPair([one], { said: 'a', reply: 'b', at: 2 }), [one], 'same said and reply');
  assert.equal(Chat.addPair([one], { said: 'a', reply: 'c', at: 2 }).length, 2);
  const full = Array.from({ length: Chat.MAX_PAIRS }, (_, i) => ({ said: `s${i}`, reply: 'r', at: i }));
  const next = Chat.addPair(full, { said: 'new', reply: 'r', at: 9999 });
  assert.equal(next.length, Chat.MAX_PAIRS);
  assert.equal(next[0].said, 's1', 'the oldest one is dropped');
  assert.equal(next[next.length - 1].said, 'new');
});

ui('the game page records what people tell me and how I answered, across batches, into chatPairs', async () => {
  const page = await boot();
  try {
    page.output('<span>[P]有氣質回答你：我上夜班4天，玩了</span>');
    page.output('<span>4天小貓\n</span>');
    page.output('<span>[P]你說道：test\n</span>');
    page.output('<span>[P]你回答有氣質：辛苦了\n</span>');
    assert.ok(await waitFor(() => page.store.chatPairs?.length === 1, 2000), 'one pair is saved');
    const [pair] = JSON.parse(JSON.stringify(page.store.chatPairs));
    assert.equal(pair.said, '我上夜班4天，玩了4天小貓');
    assert.equal(pair.reply, '辛苦了');
    page.output('<span>[P]有氣質回答你：我上夜班4天，玩了4天小貓\n</span>');
    page.output('<span>[P]你回答有氣質：辛苦了\n</span>');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(page.store.chatPairs.length, 1, 'the same pair is not saved twice');
  } finally {
    page.close();
  }
});
