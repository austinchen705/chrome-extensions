// 悟招圖（move-arts.js）：整個 content script 在 jsdom 裡跑，遊戲輸出真實的悟招訊息（tests/fixtures/moves/learn-cow.html），
// 檢查抓到的圖存進 storage 一次、不被後來的覆蓋，招式列表與動畫用存的圖。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ui, boot, waitFor, sleep } = require('../../helpers/game-page');

const root = path.join(__dirname, '..', '..', '..', 'catworld-auto-command');
const SKILLS_DATA = new Function(`${fs.readFileSync(path.join(root, 'skills-data.js'), 'utf8')}; return SKILLS_DATA;`)();
require('../../../catworld-auto-command/skill-moves.js');
const S = globalThis.CatworldSkillMoves;
const COW_HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'fixtures', 'moves', 'learn-cow.html'), 'utf8');
const KEY = '牛蛇生死搏/對牛彈琴';

async function movesPage(initialStore = {}) {
  const page = await boot({ initialStore: { zapFeatures: { skills: true }, ...initialStore } });
  const original = page.w.chrome.runtime.sendMessage;
  page.w.chrome.runtime.sendMessage = async message => (message?.type === 'SKILL_MOVES'
    ? { ok: true, skills: S.lookup(SKILLS_DATA, message.names) }
    : original(message));
  return page;
}
const box = page => page.w.document.querySelector('[data-catworld-skills]');

ui('a learn announcement is stored once with the art and the move-name colours; the same one later does not replace it', async () => {
  const page = await movesPage();
  try {
    page.output(COW_HTML);
    assert.ok(await waitFor(() => page.store.moveArts?.[KEY], 3000), 'the art is stored');
    const first = JSON.parse(JSON.stringify(page.store.moveArts[KEY]));
    assert.equal(Object.keys(page.store.moveArts).join(), KEY);
    assert.equal(JSON.stringify(first.lines), JSON.stringify(page.w.CatworldMoveFx.MOVE_ART['對牛彈琴']));
    assert.equal(JSON.stringify(first.nameCodes), '["H5","H7","N7","N7"]');
    assert.deepEqual({ skill: first.skill, move: first.move }, { skill: '牛蛇生死搏', move: '對牛彈琴' });
    assert.ok(!JSON.stringify(page.store.moveArts).includes('mukoda'), 'the learner id is not stored');

    page.output(COW_HTML);
    await sleep(900);
    assert.equal(JSON.stringify(page.store.moveArts[KEY]), JSON.stringify(first), 'the second identical announcement changes nothing (same time stamp too)');
  } finally {
    page.close();
  }
});

ui('an X block that is not a learn announcement, and the extension\'s own art block, are not stored', async () => {
  const page = await movesPage();
  try {
    page.output('<span class="H3 X">有氣質一招一式地揮灑...全新劍意源源湧出...\n</span>');
    page.output('<div data-catworld-moveart><span class="H5 X">&lt;你悟出了新甲武功&gt;\n</span><span class="H5 X">&lt;之中的一招:『甲乙』&gt;\n</span></div>');
    page.output('<span class="H5">&lt;某(</span><span class="H5">)悟出了新甲武功&gt;\n</span><span class="H5">&lt;之中的一招:『甲乙』&gt;\n</span>');
    await sleep(900);
    assert.equal(page.store.moveArts, undefined);
  } finally {
    page.close();
  }
});

ui('the move list uses a stored art for the name colours and the animation, and a captured announcement shows up in it', async () => {
  const art = { skill: '全真劍法', move: '雁行斜擊', lines: [[['試', 'H3'], ['圖', 'N0']]], nameCodes: ['H1', 'N4', 'H2', 'N0'], at: 1 };
  const page = await movesPage({ moveArts: { '全真劍法/雁行斜擊': art } });
  try {
    page.output('<span> 你所領悟的招式數目為:\n   全真劍法          :  2 招\n</span>');
    assert.ok(await waitFor(() => box(page), 3000));
    const row = box(page).querySelector('[data-catworld-move="雁行斜擊"]');
    assert.deepEqual([...row.querySelectorAll('span')].map(span => span.style.color), ['rgb(255, 0, 0)', 'rgb(0, 0, 238)', 'rgb(0, 255, 0)', 'rgb(102, 102, 102)']);
    row.dispatchEvent(new page.w.MouseEvent('click', { bubbles: true }));
    const pre = box(page).querySelector('[data-catworld-moveart]');
    assert.ok(pre, 'the stored art is shown above the animation');
    assert.equal(pre.textContent, '試圖');
    assert.deepEqual([...pre.querySelectorAll('span')].map(span => span.style.color), ['rgb(255, 255, 0)', 'rgb(102, 102, 102)']);
    const other = box(page).querySelector('[data-catworld-move="白虹經天"]');
    other.dispatchEvent(new page.w.MouseEvent('click', { bubbles: true }));
    assert.equal(box(page).querySelector('[data-catworld-moveart]'), null, 'a move with no art has none');
  } finally {
    page.close();
  }
});

ui('a captured 對牛彈琴 comes back in the careers list with the art and the game colours', async () => {
  const page = await movesPage();
  try {
    page.output(COW_HTML);
    assert.ok(await waitFor(() => page.store.moveArts?.[KEY], 3000));
    page.output('<span> 你所領悟的招式數目為:\n   牛蛇生死搏        :  2 招\n</span>');
    assert.ok(await waitFor(() => box(page), 3000));
    const row = box(page).querySelector('[data-catworld-move="對牛彈琴"]');
    assert.deepEqual([...row.querySelectorAll('span')].map(span => span.style.color), ['rgb(255, 0, 255)', 'rgb(255, 255, 255)', 'rgb(229, 229, 229)', 'rgb(229, 229, 229)']);
    row.dispatchEvent(new page.w.MouseEvent('click', { bubbles: true }));
    const pre = box(page).querySelector('[data-catworld-moveart]');
    assert.match(pre.textContent, /<你悟出了新牛蛇生死搏>/);
    assert.equal(pre.textContent.split('\n').length, 4);
  } finally {
    page.close();
  }
});
