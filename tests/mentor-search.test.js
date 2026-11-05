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

// ---- 走過去 ----
const WALK = [
  // [導師, 功法, 路線, 類別, 最高等級, 配合心法, 巨集指令, 解謎之後的路線, 備註, 不能自動走的原因]
  ['甲', '功法甲', 'run e 5n 2o t (push stone) run 9s e', '', '', '', 'run e 5n 2o t;push stone;run 9s e', '', ['要穿真武令'], ''],
  ['乙', '功法乙', 'run e 5n 2o t 謎 run e', '', '', '', 'run e 5n 2o t', '謎 run e', [], ''],
  ['丙', '功法丙', 'run 2e u', '', '', '', '', '', [], '不是從醉仙樓出發'],
  ['丁', '功法丁', 'run e 5n 2o t', '', '', '', '@等待 abc', '', [], ''],
];
const itemOf = (page, mentor) => [...panel(page).querySelectorAll('.mt-item')].find(node => node.querySelector('.mt-name').textContent === mentor);

ui('the walk button sends the commands of the macro one after another', async () => {
  const page = await boot({ scale: 20, preload: preload(WALK) });
  try {
    await open(page);
    itemOf(page, '甲').querySelector('.mt-walk').click();
    assert.ok(await waitFor(() => page.sent.length === 3), `sent ${JSON.stringify(page.sent)}`);
    assert.deepEqual(page.sent, ['run e 5n 2o t', 'push stone', 'run 9s e']);
    assert.match(itemOf(page, '甲').textContent, /備註：要穿真武令/);
  } finally {
    page.close();
  }
});

ui('a route with a riddle walks only up to it and says what is left', async () => {
  const page = await boot({ scale: 20, preload: preload(WALK) });
  try {
    await open(page);
    const item = itemOf(page, '乙');
    assert.equal(item.querySelector('.mt-walk').textContent, '走到解謎處');
    assert.match(item.textContent, /走到這裡要先解謎，後面的路線：謎 run e/);
    item.querySelector('.mt-walk').click();
    assert.ok(await waitFor(() => page.sent.length === 1));
    assert.deepEqual(page.sent, ['run e 5n 2o t']);
  } finally {
    page.close();
  }
});

ui('when the macro cannot be started the button says so instead of claiming it was sent', async () => {
  const page = await boot({ preload: preload(WALK) });
  try {
    await open(page);
    const button = itemOf(page, '丁').querySelector('.mt-walk');
    button.click();
    assert.equal(button.textContent, '送不出去');
    assert.equal(button.classList.contains('mt-bad'), true);
    assert.deepEqual(page.sent, []);
  } finally {
    page.close();
  }
});

ui('a route that cannot be walked automatically has no button, only the route and the reason', async () => {
  const page = await boot({ preload: preload(WALK) });
  try {
    await open(page);
    const item = itemOf(page, '丙');
    assert.equal(item.querySelector('.mt-walk'), null);
    assert.match(item.textContent, /路線 run 2e u/);
    assert.match(item.textContent, /不能自動走：不是從醉仙樓出發/);
    assert.deepEqual(page.sent, []);
  } finally {
    page.close();
  }
});

ui('the built-in data lets 小龍女 walk through the tomb in one macro', async () => {
  const page = await boot({ scale: 20, builtin: true });
  try {
    await open(page);
    type(page, '美女拳法');
    const item = itemOf(page, '小龍女');
    assert.ok(item, 'found');
    item.querySelector('.mt-walk').click();
    assert.ok(await waitFor(() => page.sent.length >= 3));
    assert.ok(page.sent.includes('worship tomb'), JSON.stringify(page.sent));
  } finally {
    page.close();
  }
});

// ---- 個人編輯路線 ----
const ROW = (mentor, skill, route) => [mentor, skill, route, '', '', '', route, '', [], ''];
const EDITABLE = [
  ROW('甲', '功法一', 'run e 5n 2o t'),
  ROW('甲', '功法二', 'run e 5n 2o t'),
  ROW('乙', '功法三', 'run e 5n 2o w'),
  ROW('乙', '功法四', 'run e 5n 2o s'),
];
const entriesOf = (page, mentor) => [...panel(page).querySelectorAll('.mt-item')].filter(node => node.querySelector('.mt-name').textContent === mentor);
const entryWith = (page, mentor, skill) => entriesOf(page, mentor).find(node => node.textContent.includes(skill));
// 打開某一筆的編輯框：只勾 skills 列的功法（不給就全勾），填入路線
const startEdit = (page, node, { skills, text } = {}) => {
  node.querySelector('.mt-edit').click();
  const box = node.querySelector('.mt-editbox');
  if (skills) box.querySelectorAll('.mt-edit-skill').forEach(check => { check.checked = skills.includes(check.value); });
  if (text !== undefined) box.querySelector('.mt-edit-text').value = text;
  return box;
};
// 跨視窗的物件原型不同，deepStrictEqual 會失敗，先轉成純 JSON
const plain = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const store = page => plain(page.store.mentorRoutes);

ui('editing the route of one skill saves it under mentor and skill, splits that skill into its own entry marked as edited, and walks the edited route', async () => {
  const page = await boot({ scale: 20, preload: preload(EDITABLE) });
  try {
    await open(page);
    assert.equal(entriesOf(page, '甲').length, 1, 'the two skills share one entry before the edit');
    startEdit(page, entriesOf(page, '甲')[0], { skills: ['功法二'], text: 'run e 5n 2o t;push stone' }).querySelector('.mt-edit-save').click();
    assert.ok(await waitFor(() => store(page)));
    assert.deepEqual(store(page), { '甲|功法二': 'run e 5n 2o t;push stone' });
    assert.ok(await waitFor(() => entriesOf(page, '甲').length === 2));
    const edited = entryWith(page, '甲', '功法二');
    assert.match(edited.textContent, /已自訂/);
    assert.match(edited.textContent, /路線 run e 5n 2o t;push stone/);
    assert.doesNotMatch(entryWith(page, '甲', '功法一').textContent, /已自訂/);
    edited.querySelector('.mt-walk').click();
    assert.ok(await waitFor(() => page.sent.length === 2));
    assert.deepEqual(page.sent, ['run e 5n 2o t', 'push stone']);
  } finally {
    page.close();
  }
});

ui('a skill edited to the same route as another entry joins it', async () => {
  const page = await boot({ preload: preload(EDITABLE) });
  try {
    await open(page);
    startEdit(page, entryWith(page, '乙', '功法四'), { text: 'run e 5n 2o w' }).querySelector('.mt-edit-save').click();
    assert.ok(await waitFor(() => entriesOf(page, '乙').length === 1));
    assert.match(entriesOf(page, '乙')[0].textContent, /功法三.*功法四|功法四.*功法三/);
  } finally {
    page.close();
  }
});

ui('resetting to built-in removes the saved edit and the entry goes back where it was', async () => {
  const page = await boot({ preload: preload(EDITABLE), initialStore: { mentorRoutes: { '甲|功法二': 'run e 5n 2o t;push stone' } } });
  try {
    await open(page);
    assert.ok(await waitFor(() => entriesOf(page, '甲').length === 2));
    startEdit(page, entryWith(page, '甲', '功法二')).querySelector('.mt-edit-reset').click();
    assert.ok(await waitFor(() => entriesOf(page, '甲').length === 1));
    assert.deepEqual(store(page), {});
    assert.doesNotMatch(entriesOf(page, '甲')[0].textContent, /已自訂/);
  } finally {
    page.close();
  }
});

ui('an empty route, a route the macro cannot read, or no skill ticked is refused with the reason and nothing is saved', async () => {
  const page = await boot({ preload: preload(EDITABLE) });
  try {
    await open(page);
    const item = entriesOf(page, '甲')[0];
    const box = startEdit(page, item, { text: '   ' });
    const msg = () => box.querySelector('.mt-edit-msg');
    box.querySelector('.mt-edit-save').click();
    assert.match(msg().textContent, /不能是空的/);
    assert.equal(msg().classList.contains('mt-bad'), true);
    box.querySelector('.mt-edit-text').value = '@等待 abc';
    box.querySelector('.mt-edit-save').click();
    assert.match(msg().textContent, /等待/);
    box.querySelector('.mt-edit-text').value = 'run e';
    box.querySelectorAll('.mt-edit-skill').forEach(check => { check.checked = false; });
    box.querySelector('.mt-edit-save').click();
    assert.match(msg().textContent, /至少選一個功法/);
    assert.equal(store(page), undefined, 'nothing was saved');
  } finally {
    page.close();
  }
});

ui('edits saved before the page loaded are applied, and an edit made in another tab shows up without a reload', async () => {
  const page = await boot({ preload: preload(EDITABLE), initialStore: { mentorRoutes: { '乙|功法三': 'run e 5n 2o n' } } });
  try {
    await open(page);
    assert.ok(await waitFor(() => /路線 run e 5n 2o n/.test(entryWith(page, '乙', '功法三')?.textContent ?? '')));
    const next = { '乙|功法三': 'run e 5n 2o n', '甲|功法一': 'run 3e' };
    page.store.mentorRoutes = next;
    page.changeListeners.forEach(listener => listener({ mentorRoutes: { newValue: next } }, 'local'));
    assert.ok(await waitFor(() => /路線 run 3e/.test(entryWith(page, '甲', '功法一')?.textContent ?? '')));
  } finally {
    page.close();
  }
});

ui('bad saved data does not break the list: wrong shapes and non-string values are ignored', async () => {
  for (const junk of ['junk', ['a|b'], { '甲|功法一': 5, 'no-bar': 'x', '乙|功法三': '   ' }]) {
    const page = await boot({ preload: preload(EDITABLE), initialStore: { mentorRoutes: junk } });
    try {
      await open(page);
      assert.deepEqual(names(page), ['乙', '乙', '甲'], JSON.stringify(junk));
    } finally {
      page.close();
    }
  }
});

ui('the built-in data is never rewritten: only the edit is stored, and the edit and its box do not leak clicks to the game', async () => {
  const page = await boot({ preload: preload(EDITABLE) });
  try {
    await open(page);
    let leaked = 0;
    page.w.document.addEventListener('click', () => { leaked += 1; });
    const item = entriesOf(page, '乙')[0];
    item.querySelector('.mt-edit').dispatchEvent(new page.w.MouseEvent('click', { bubbles: true, composed: true }));
    const box = item.querySelector('.mt-editbox');
    box.querySelector('.mt-edit-text').dispatchEvent(new page.w.MouseEvent('click', { bubbles: true, composed: true }));
    assert.equal(leaked, 0);
    box.querySelector('.mt-edit-text').value = 'run 9n';
    box.querySelector('.mt-edit-save').click();
    assert.ok(await waitFor(() => store(page)));
    assert.deepEqual(Object.keys(page.store).sort(), ['mentorRoutes', 'zapFeatures'], 'only the edit is added to storage (zapFeatures is the switch the test turned on)');
    assert.deepEqual(JSON.parse(JSON.stringify(page.w.CatworldMentorData)), EDITABLE);
  } finally {
    page.close();
  }
});

// ---- 個人編輯路線：審查後的修正 ----
const CUT = ['丙', '功法丙', 'run e 5n 2o t 謎 run e', '', '', '', 'run e 5n 2o t', '謎 run e', [], ''];

ui('saving a route unchanged is not saved, so the riddle warning of a cut route is not lost, and the box shows what is left after the riddle', async () => {
  const page = await boot({ preload: preload([...EDITABLE, CUT]) });
  try {
    await open(page);
    const box = startEdit(page, entriesOf(page, '丙')[0]);
    assert.match(box.textContent, /走到謎就停，後面的路線：謎 run e/);
    const msg = () => box.querySelector('.mt-edit-msg');
    box.querySelector('.mt-edit-text').value = '  ';
    box.querySelector('.mt-edit-save').click();
    assert.equal(msg().classList.contains('mt-bad'), true);
    box.querySelector('.mt-edit-text').value = 'run e 5n 2o t';
    box.querySelector('.mt-edit-save').click();
    assert.match(msg().textContent, /沒有改動/);
    assert.equal(msg().classList.contains('mt-bad'), false, 'the red of the earlier error is cleared');
    assert.equal(store(page), undefined);
    assert.match(entriesOf(page, '丙')[0].textContent, /走到這裡要先解謎/);
  } finally {
    page.close();
  }
});

ui('resetting skills that were never edited says so and saves nothing', async () => {
  const page = await boot({ preload: preload(EDITABLE) });
  try {
    await open(page);
    const box = startEdit(page, entriesOf(page, '乙')[0]);
    box.querySelector('.mt-edit-reset').click();
    assert.match(box.querySelector('.mt-edit-msg').textContent, /沒有自己改過/);
    assert.equal(store(page), undefined);
  } finally {
    page.close();
  }
});

ui('a change from another tab does not throw away an open edit box; the list catches up when the box is closed', async () => {
  const page = await boot({ preload: preload(EDITABLE) });
  try {
    await open(page);
    const box = startEdit(page, entryWith(page, '乙', '功法三'), { text: 'run 打到一半' });
    const next = { '甲|功法一': 'run 3e' };
    page.store.mentorRoutes = next;
    page.changeListeners.forEach(listener => listener({ mentorRoutes: { newValue: next } }, 'local'));
    assert.ok(panel(page).querySelector('.mt-editbox'), 'the box is still there');
    assert.equal(box.querySelector('.mt-edit-text').value, 'run 打到一半', 'and so is what was typed');
    assert.doesNotMatch(entryWith(page, '甲', '功法一').textContent, /run 3e/, 'the list was not redrawn yet');
    box.querySelector('.mt-edit-cancel').click();
    assert.match(entryWith(page, '甲', '功法一').textContent, /路線 run 3e/);
  } finally {
    page.close();
  }
});

ui('two edit boxes saved back to back both land, the second is not built on a stale copy', async () => {
  const page = await boot({ preload: preload(EDITABLE) });
  try {
    await open(page);
    const first = startEdit(page, entriesOf(page, '甲')[0], { text: 'run 1e' });
    const second = startEdit(page, entryWith(page, '乙', '功法三'), { text: 'run 2e' });
    first.querySelector('.mt-edit-save').click();
    second.querySelector('.mt-edit-save').click();
    assert.ok(await waitFor(() => Object.keys(store(page) ?? {}).length === 3), JSON.stringify(store(page)));
    assert.deepEqual(store(page), { '甲|功法一': 'run 1e', '甲|功法二': 'run 1e', '乙|功法三': 'run 2e' });
  } finally {
    page.close();
  }
});

ui('when the macro module is not there the format cannot be checked, so nothing is saved', async () => {
  const page = await boot({ preload: preload(EDITABLE) });
  try {
    await open(page);
    const box = startEdit(page, entriesOf(page, '乙')[0], { text: 'run 9n' });
    page.w.CatworldMacro = undefined;
    box.querySelector('.mt-edit-save').click();
    assert.match(box.querySelector('.mt-edit-msg').textContent, /無法檢查指令格式/);
    assert.equal(store(page), undefined);
  } finally {
    page.close();
  }
});
