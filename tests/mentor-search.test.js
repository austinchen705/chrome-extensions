// 拜師導師搜尋：整個 content script 在 jsdom 裡跑（假的 chrome、假的遊戲頁），檢查開關、搜尋、排序與分組。
// 假的內建資料用 preload 放，不被真實資料影響；有一個測試用真實的內建資料（builtin: true）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { ui, boot, waitFor } = require('./helpers/game-page');

// 每列：[導師, 功法, 路線, 類別, 最高等級, 配合心法]
const preload = rows => `globalThis.CatworldMentorData = ${JSON.stringify(rows)};`;
const FAKE = [
  ['甲導師', '基本劍術', 'run e 5n 2o nu nu e', '', '600', ''],
  ['甲導師', '陣法概念', 'run e 5n 2o 2nu e', '', '100', ''],
  ['甲導師', '拆招之法', 'run e 5n 2o sw t', '', '200', ''],
  ['乙導師', '醉刀', 'run e 5n 2o w', '刀類', '', '降龍神功'],
  ['丙導師', '降龍十八掌', 'run e 5n 2o s', '掌拳類', '', '降龍神功'],
  ['降龍老人', '雜學', 'run e 5n 2o n', '', '50', ''],
];

const panel = page => page.hosts()[0].shadowRoot;
const setFeatures = (page, features) => {
  page.store.zapFeatures = features;
  page.changeListeners.forEach(listener => listener({ zapFeatures: { newValue: features } }, 'local'));
};
const rowOf = page => [...panel(page).querySelectorAll('.line')].find(line => line.querySelector('.mt-open'));
const open = async page => {
  setFeatures(page, { masters: true });
  rowOf(page).querySelector('.mt-open').click();
  assert.ok(await waitFor(() => !panel(page).querySelector('.mt-box').hidden));
};
const type = (page, text) => {
  const input = panel(page).querySelector('.mt-box input[type=search]');
  input.value = text;
  input.dispatchEvent(new page.w.Event('input', { bubbles: true }));
};
const items = page => [...panel(page).querySelectorAll('.mt-item')].map(node => node.textContent);
const names = page => [...panel(page).querySelectorAll('.mt-name')].map(node => node.textContent);

ui('the mentor row is hidden until the switch in the settings page is on, and turning it off closes an open list', async () => {
  const page = await boot({ preload: preload(FAKE) });
  try {
    assert.equal(rowOf(page).hidden, true, 'off by default');
    setFeatures(page, { masters: true });
    assert.equal(rowOf(page).hidden, false);
    rowOf(page).querySelector('.mt-open').click();
    assert.equal(panel(page).querySelector('.mt-box').hidden, false);
    setFeatures(page, { masters: false });
    assert.equal(rowOf(page).hidden, true);
    assert.equal(panel(page).querySelector('.mt-box').hidden, true);
  } finally {
    page.close();
  }
});

ui('an empty search lists every mentor, grouped by mentor and route, sorted by mentor name', async () => {
  const page = await boot({ preload: preload(FAKE) });
  try {
    await open(page);
    // 甲導師的前兩條路線寫法不同但等價（nu nu ＝ 2nu）合成一筆，第三條不同路線另成一筆
    assert.deepEqual(names(page), ['丙導師', '乙導師', '甲導師', '甲導師', '降龍老人']);
    const shared = items(page).find(text => text.includes('基本劍術'));
    assert.match(shared, /陣法概念/, 'the two skills with the same route are in one entry');
    assert.doesNotMatch(shared, /拆招之法/);
    assert.match(items(page).find(text => text.includes('拆招之法')), /路線 run e 5n 2o sw t/);
  } finally {
    page.close();
  }
});

ui('search matches mentor, skill and heart method, ignoring case and spaces, with mentor name matches first', async () => {
  const page = await boot({ preload: preload(FAKE) });
  try {
    await open(page);
    type(page, '降龍');
    assert.deepEqual(names(page), ['降龍老人', '丙導師', '乙導師'], 'the mentor named 降龍 first, then skill or heart matches by mentor name');
    type(page, '醉 刀');
    assert.deepEqual(names(page), ['乙導師']);
    type(page, 'zzz');
    assert.deepEqual(names(page), []);
    assert.match(panel(page).querySelector('.mt-list').textContent, /沒有符合的導師/);
    type(page, '');
    assert.equal(names(page).length, 5);
  } finally {
    page.close();
  }
});

ui('an entry shows the skills with category, highest level and heart method, and the route as written', async () => {
  const page = await boot({ preload: preload(FAKE) });
  try {
    await open(page);
    type(page, '乙導師');
    assert.equal(items(page).length, 1);
    assert.match(items(page)[0], /醉刀（刀類、心法 降龍神功）/);
    assert.match(items(page)[0], /路線 run e 5n 2o w/);
    type(page, '甲導師');
    assert.match(items(page)[0], /基本劍術（最高 600）/);
  } finally {
    page.close();
  }
});

ui('the built-in data finds the mentor behind a heart method', async () => {
  const page = await boot({ builtin: true });
  try {
    await open(page);
    assert.ok(names(page).length >= 25, 'an empty search lists the built-in mentors');
    type(page, '降龍');
    assert.ok(names(page).includes('喬峰'));
    assert.match(items(page).find(text => text.startsWith('喬峰')), /降龍/);
  } finally {
    page.close();
  }
});

ui('the search box does not leak keys or clicks to the game', async () => {
  const page = await boot({ preload: preload(FAKE) });
  try {
    await open(page);
    const input = panel(page).querySelector('.mt-box input[type=search]');
    let leaked = 0;
    page.w.document.addEventListener('keydown', () => { leaked += 1; });
    page.w.document.addEventListener('click', () => { leaked += 1; });
    input.dispatchEvent(new page.w.KeyboardEvent('keydown', { key: 'a', bubbles: true, composed: true }));
    input.dispatchEvent(new page.w.MouseEvent('click', { bubbles: true, composed: true }));
    assert.equal(leaked, 0);
  } finally {
    page.close();
  }
});
