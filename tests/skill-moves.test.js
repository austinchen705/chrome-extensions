// 招式列表：解析 careers 的輸出、依 skills-data.js 列出已悟的招式並依傷害上色。
// 純函式直接測；遊戲頁的部分用整個 content script 在 jsdom 裡跑（假的 background 用 lookup 回真實資料）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ui, boot, waitFor, sleep } = require('./helpers/game-page');

const root = path.join(__dirname, '..', 'catworld-auto-command');
const SKILLS_DATA = new Function(`${fs.readFileSync(path.join(root, 'skills-data.js'), 'utf8')}; return SKILLS_DATA;`)();
require('../catworld-auto-command/skill-moves.js');
const S = globalThis.CatworldSkillMoves;

const CAREERS = `【 道  士 】[罪]timer的犯人「傳說的魔獸」愛吃肉的緋爾(fenrir)

 你是一位十四歲的男性人類，乙酉年四月三十日戌時生。

 你的師父是歐冶子。你的職業是劍客。

 你目前的武器經驗為下:
   劍客      (     sword)  經驗: 140169   潛能: 1963(92%)
   拳術家    (   unarmed)  經驗: 5139     潛能: 2866(69%)

 你所領悟的招式數目為:
   全真劍法          :  5 招
   雪山劍法          :  5 招
`;

test('parseLearned reads the skill lines under the header and nothing else', () => {
  assert.deepEqual(S.parseLearned(CAREERS), [{ name: '全真劍法', count: 5 }, { name: '雪山劍法', count: 5 }]);
  assert.deepEqual(S.parseLearned('   全真劍法          :  5 招\n'), [], 'no header, no list');
  assert.deepEqual(S.parseLearned(''), []);
  assert.deepEqual(S.parseLearned(null), []);
  assert.deepEqual(S.parseLearned('你所領悟的招式數目為:   全真劍法          :  5 招   雪山劍法          :  5 招'), [{ name: '全真劍法', count: 5 }, { name: '雪山劍法', count: 5 }], 'works when the lines come with no line breaks');
});

test('lookup returns only the skills asked for, by exact name', () => {
  const found = S.lookup(SKILLS_DATA, ['全真劍法', '全真劍法', '不存在的武功']);
  assert.deepEqual(Object.keys(found), ['全真劍法']);
  assert.equal(found['全真劍法'].moves.length, 11);
  assert.equal(found['全真劍法'].moves[0].name, '雁行斜擊');
  assert.deepEqual(S.lookup(null, ['全真劍法']), {});
});

test('describe lists the first N moves with a colour by damage, cleans the damage type, and says what the next move needs', () => {
  const skill = S.lookup(SKILLS_DATA, ['全真劍法'])['全真劍法'];
  const info = S.describe(skill, 5);
  assert.deepEqual(info.moves.map(move => move.name), ['雁行斜擊', '白虹經天', '天外飛山', '春花飛柳', '三花聚頂']);
  assert.equal(info.count, 5);
  assert.equal(info.total, 11);
  assert.equal(info.moves[0].color, S.TIERS.at(-1).color, '70 is the lowest tier');
  assert.equal(info.moves[2].color, S.TIERS[2].color, '130 is the 100+ tier');
  assert.equal(info.moves[4].color, S.TIERS[2].color, '190 is still the 100+ tier');
  assert.equal(info.moves[1].type, '傷勢', 'the long explanation after the first sentence is dropped');
  assert.deepEqual({ no: info.next.no, name: info.next.name, self: info.next.self, force: info.next.force }, { no: 6, name: '五內朝元', self: 300, force: 211 });
  const snow = S.describe(S.lookup(SKILLS_DATA, ['雪山劍法'])['雪山劍法'], 6);
  assert.equal(snow.moves[5].damage, 350);
  assert.equal(snow.moves[5].color, S.TIERS[0].color, '350 is the top tier');
  assert.equal(snow.moves[5].effect, 'SnowDamage');
});

test('describe copes with a count past the end, zero, and moves with no damage number', () => {
  const lastSkill = S.lookup(SKILLS_DATA, ['六脈神劍'])['六脈神劍'];
  const all = S.describe(lastSkill, 99);
  assert.equal(all.moves.length, lastSkill.moves.length);
  assert.equal(all.next, null);
  assert.equal(S.describe(lastSkill, 0).moves.length, 0);
  const forceOnly = { moves: [{ level: 1, name: '測試', damage: undefined, damageType: '', extra: { force: 50 } }], levels: [{ self: 1, force: 1 }], forceName: '內功' };
  const move = S.describe(forceOnly, 1).moves[0];
  assert.equal(move.damage, null);
  assert.equal(move.color, S.FORCE_COLOR);
  assert.match(S.moveText(move), /內力加成 50/);
});

async function skillsPage(features = { skills: true }) {
  const page = await boot({ scale: 1 });
  page.store.zapFeatures = features;
  const original = page.w.chrome.runtime.sendMessage;
  page.w.chrome.runtime.sendMessage = async message => (message?.type === 'SKILL_MOVES'
    ? { ok: true, skills: S.lookup(SKILLS_DATA, message.names) }
    : original(message));
  return page;
}
const box = page => page.w.document.querySelector('[data-catworld-skills]');

ui('careers output gets a coloured list of the learned moves under it', async () => {
  const page = await skillsPage();
  try {
    page.output(`<span>${CAREERS}</span>`);
    assert.ok(await waitFor(() => box(page), 3000), 'the list is inserted');
    const text = box(page).textContent;
    assert.match(text, /全真劍法　已悟 5／11 招/);
    assert.match(text, /1\. 雁行斜擊　傷害 70（刺傷）/);
    assert.match(text, /5\. 三花聚頂　傷害 190/);
    assert.match(text, /雪山劍法　已悟 5／11 招/);
    assert.match(text, /下一招 6\. 五內朝元/);
    const rows = [...box(page).querySelectorAll('div')];
    const colourOf = needle => rows.find(row => row.textContent.includes(needle)).style.color;
    assert.notEqual(colourOf('雁行斜擊'), colourOf('三花聚頂'), 'different damage, different colour');
    assert.equal(page.w.document.querySelectorAll('[data-catworld-skills]').length, 1, 'inserted once, not once per batch');
  } finally {
    page.close();
  }
});

ui('with the switch off, nothing is inserted and background is not asked', async () => {
  const page = await skillsPage({ skills: false });
  try {
    let asked = 0;
    const wrapped = page.w.chrome.runtime.sendMessage;
    page.w.chrome.runtime.sendMessage = async message => { if (message?.type === 'SKILL_MOVES') asked += 1; return wrapped(message); };
    page.output(`<span>${CAREERS}</span>`);
    await sleep(700);
    assert.equal(box(page), null);
    assert.equal(asked, 0);
  } finally {
    page.close();
  }
});

ui('a skill that is not in the data says so, and a failed lookup shows the reason instead of nothing', async () => {
  const page = await skillsPage();
  try {
    page.output('<span> 你所領悟的招式數目為:\n   不存在的武功 : 3 招\n</span>');
    assert.ok(await waitFor(() => box(page), 3000));
    assert.match(box(page).textContent, /不存在的武功：資料裡沒有這門武功/);
    box(page).remove();
    page.w.chrome.runtime.sendMessage = async () => { throw new Error('Receiving end does not exist'); };
    page.output(`<span>${CAREERS}</span>`);
    assert.ok(await waitFor(() => box(page), 3000));
    assert.match(box(page).textContent, /查不到招式資料：Receiving end does not exist/);
  } finally {
    page.close();
  }
});

test('the background answers SKILL_MOVES from the real data, and the files are wired in the manifest and the settings page', () => {
  const background = fs.readFileSync(path.join(root, 'background.js'), 'utf8');
  assert.match(background, /importScripts\([^)]*'skills-data\.js', 'skill-moves\.js'/);
  assert.match(background, /message\?\.type === 'SKILL_MOVES'/);
  const popupHtml = fs.readFileSync(path.join(root, 'popup.html'), 'utf8');
  assert.match(popupHtml, /id="featureSkills"/);
  assert.match(fs.readFileSync(path.join(root, 'popup.js'), 'utf8'), /skills: 'featureSkills'/);
});
