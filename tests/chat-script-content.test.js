// 劇本對話的第一批內容：docs/data/chat-scripts-w45.csv（貼進共用試算表用的 12 份，依 2026 年第 45 週的時事）與內建備援劇本。
// 內容本身沒辦法用測試判斷好壞，這裡只擋「交付前就該通過」的客觀條件：驗證規則、輪數、題材分佈、來源註明、不碰禁區字眼、開場句彼此分得開。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'catworld-auto-command');
require(path.join(dir, 'zap-mobs.js'));
require(path.join(dir, 'shared-data.js'));
require(path.join(dir, 'chat-reply.js'));
require(path.join(dir, 'chat-script.js'));
require(path.join(dir, 'chat-script-data.js'));
const S = globalThis.CatworldSharedData;
const C = globalThis.CatworldChatScript;
const BUILTIN = globalThis.CatworldChatScriptData.scripts;

const CSV = fs.readFileSync(path.join(__dirname, '..', 'docs', 'data', 'chat-scripts-w45.csv'), 'utf8').replace(/\r\n/g, '\n');
const IN_WEEK = new Date(2026, 10, 8, 12, 0, 0).getTime(); // 2026-11-08
const built = S.buildChatScripts(CSV, IN_WEEK);
const turnCount = script => C.toTurns(script).length;
const textOf = script => script.lines.map(line => line.text);

test('all 12 scripts of the first batch pass the sheet rules with nothing dropped or left out', () => {
  assert.equal(built.ok, true);
  assert.deepEqual([built.report.used, built.report.dropped.length, built.report.unmatched.length], [12, 0, 0]);
  assert.equal(new Set(built.scripts.map(script => script.id)).size, 12);
  assert.equal(C.usableScripts(built.scripts).length, 12, 'and the game page accepts every one');
});

test('each script is 7 or 8 turns long and opens with A', () => {
  built.scripts.forEach(script => {
    assert.ok([7, 8].includes(turnCount(script)), `${script.id} has ${turnCount(script)} turns`);
    assert.equal(script.lines[0].who, 'A', script.id);
  });
});

test('two scripts for each of the six topics, and every script says where its news came from and when', () => {
  const topics = built.scripts.map(script => /^w45-(weather|sports|tech|ent|food|game)-[12]$/.exec(script.id)?.[1]);
  assert.ok(topics.every(Boolean), `ids: ${built.scripts.map(script => script.id)}`);
  ['weather', 'sports', 'tech', 'ent', 'food', 'game'].forEach(topic => assert.equal(topics.filter(item => item === topic).length, 2, topic));
  const records = S.parseCsv(CSV).slice(1).filter(record => record[0]);
  const firstRows = new Map();
  records.forEach(record => { if (!firstRows.has(record[0])) firstRows.set(record[0], record); });
  firstRows.forEach((record, id) => {
    assert.match(record[4], /20\d\d-\d\d-\d\d/, `${id}: the note has the date of the news`);
    assert.match(record[4], /https?:\/\//, `${id}: the note has the source link`);
    assert.equal(record[5], '2026-11-02', `${id}: the week is the Monday of that week`);
  });
});

// 劇本會用兩個禮拜：新聞的時間要寫絕對日期，不能寫「這禮拜」「下禮拜」
const relativeWeek = ['這禮拜', '這個禮拜', '下禮拜', '下個禮拜', '上禮拜', '上個禮拜', '這週', '下週', '上週'];

test('the lines are short and colloquial, not every turn ends as a question, and nothing touches politics, casualties or disasters', () => {
  const forbidden = ['政治', '選舉', '總統', '政府', '戰爭', '死', '傷', '災', '颱風', '地震', '火災', '車禍', '事故'];
  built.scripts.forEach(script => {
    const lines = textOf(script);
    lines.forEach(text => {
      relativeWeek.forEach(word => assert.ok(!text.includes(word), `${script.id} says ${word}, which is wrong a few days later: ${text}`));
      assert.ok(text.split('／').every(part => [...part].length <= 40), `${script.id}: a part is long: ${text}`);
      forbidden.forEach(word => assert.ok(!text.includes(word), `${script.id} mentions ${word}: ${text}`));
    });
    const turns = C.toTurns(script);
    const questions = turns.filter(turn => /[嗎？?沒]$|你呢$/.test(turn.parts[turn.parts.length - 1])).length;
    assert.ok(questions * 2 <= turns.length, `${script.id}: ${questions} of ${turns.length} turns end as a question`);
  });
});

test('no two scripts open alike, so the answering side never takes one script for another', () => {
  const all = [...built.scripts, ...BUILTIN];
  const openers = script => C.toTurns(script)[0].parts;
  all.forEach((one, i) => all.slice(i + 1).forEach(other => {
    openers(one).forEach(a => openers(other).forEach(b => {
      const score = globalThis.CatworldChatReply.similarity(a, b);
      assert.ok(score < C.MATCH_THRESHOLD, `${one.id} and ${other.id} open too alike (${score.toFixed(2)}): ${a} / ${b}`);
    }));
  }));
});

test('the built-in scripts are three general ones with no news, no placeholder, 7 or 8 turns, and they pass the same sheet rules', () => {
  assert.equal(BUILTIN.length, 3);
  assert.deepEqual(BUILTIN.map(script => script.id), ['builtin-1', 'builtin-2', 'builtin-3']);
  BUILTIN.forEach(script => {
    assert.ok([7, 8].includes(turnCount(script)), `${script.id} has ${turnCount(script)} turns`);
    assert.equal(script.lines[0].who, 'A', script.id);
    script.lines.forEach(line => {
      assert.ok(!line.text.includes('{對方}'), `${script.id} has the placeholder`);
      // 備援劇本在任何時候開場都要自然：不綁週末、深夜、星期幾
      ['週末', '這麼晚', '半夜', '晚安', '早安', '禮拜'].forEach(word => assert.ok(!line.text.includes(word), `${script.id} is tied to a time (${word}): ${line.text}`));
      assert.ok(!/\d/.test(line.text), `${script.id} has a number, which smells like news: ${line.text}`);
    });
  });
  const rows = BUILTIN.flatMap(script => script.lines.map((line, i) => `${script.id},${i + 1},${line.who},${line.text},,`));
  const checked = S.buildChatScripts(['劇本ID,順序,誰,台詞,備註,週', ...rows].join('\n'), IN_WEEK);
  assert.deepEqual([checked.report.used, checked.report.dropped.length], [3, 0]);
  assert.equal(C.usableScripts(BUILTIN).length, 3);
});
