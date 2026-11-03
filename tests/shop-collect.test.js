// 商人裝備資料庫：玩家自己打的 check 輸出記進資料庫（以名稱為鍵），打 list 時在那一頁下面插摘要。需要 jsdom
const test = require('node:test');
const assert = require('node:assert/strict');
const { ui, boot, sleep, waitFor } = require('./helpers/game-page');

const LIST_PAGE = [
  '商人現在有賣以下貨物：',
  ' 1 黃金鎖鍊              價格：60S       2 虹色項鍊              價格：22S     ',
  ' 3 笨重的金刀            價格：32S       4 烈火棍                價格：1G40S   ',
  '14 烈陽劍                價格：16S50C   24 [百勝刀]              價格：2G4S    ',
  '== 未完繼續 52% == (ENTER 繼續下一頁，q 離開，b 前一頁)',
].join('\n');

const checkOutput = (name, category, primary, needExp) => [
  '你付了一筆錢給商人，得到了以下資料：',
  `此物名曰 ：${name}，${category}`,
  '硬    度 ：104',
  `傷 害 力 ：${primary} / ${primary}`,
  `佩帶條件 ：經驗 ${needExp}`,
].join('\n');

const SCALE = 10;
const shopBox = page => page.w.document.querySelector('[data-catworld-shop]');

ui('parseList reads two items per line, price included, bracketed names kept', async () => {
  const page = await boot({ scale: SCALE });
  try {
    const items = page.w.CatworldShopCollect.parseList(LIST_PAGE);
    assert.deepEqual(Array.from(items, item => item.no), [1, 2, 3, 4, 14, 24]);
    assert.equal(items[0].name, '黃金鎖鍊');
    assert.equal(items[4].price, '16S50C');
    assert.equal(items[5].name, '[百勝刀]');
  } finally {
    page.close();
  }
});

ui('a check output after paying the merchant is saved by item name, and the same name is overwritten', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.output(`<span>${checkOutput('黃金鎖鍊', '鞭類武器', 47, 200000)}</span>`);
    assert.ok(await waitFor(() => page.store.shopItems?.['黃金鎖鍊'], 2000));
    const saved = page.store.shopItems['黃金鎖鍊'];
    assert.equal(saved.category, '鞭類武器');
    assert.equal(saved.primary, 47);
    assert.equal(saved.needExp, 200000);
    page.output(`<span>${checkOutput('黃金鎖鍊', '鞭類武器', 50, 200000)}</span>`);
    assert.ok(await waitFor(() => page.store.shopItems['黃金鎖鍊'].primary === 50, 2000));
    assert.equal(Object.keys(page.store.shopItems).length, 1);
  } finally {
    page.close();
  }
});

ui('an equipment block that did not come from a merchant check is not recorded', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.output('<span>此物名曰 ：某裝備，劍類武器\n傷 害 力 ：30 / 30\n佩帶條件 ：經驗 1000\n</span>');
    await sleep(200);
    assert.equal(page.store.shopItems, undefined);
  } finally {
    page.close();
  }
});

ui('a check output split over several batches is still recorded', async () => {
  const page = await boot({ scale: SCALE });
  try {
    const lines = checkOutput('烈火棍', '棍類武器', 60, 100).split('\n');
    lines.forEach(line => page.output(`<span>${line}\n</span>`));
    assert.ok(await waitFor(() => page.store.shopItems?.['烈火棍']?.primary === 60, 2000));
  } finally {
    page.close();
  }
});

// 烈火棍比現在穿的好、黃金鎖鍊沒有鞭類基準可比、突襲盾的經驗條件還不夠、虹色項鍊沒蒐集過
function seed(page) {
  page.w.document.title = '測試 - CatWorld';
  page.w.document.body.insertAdjacentHTML('beforeend', '<div id="exp">414748</div>');
  const item = (name, category, kind, primary, needExp) => ({ name, category, kind, primary, attrs: [], needExp, seen: 1 });
  Object.assign(page.store, {
    zapFeatures: { items: true },
    shopItems: {
      烈火棍: item('烈火棍', '棍類武器', 'weapon', 60, 100),
      黃金鎖鍊: item('黃金鎖鍊', '鞭類武器', 'weapon', 47, 200000),
      突襲盾: item('突襲盾', '盾類防具', 'armor', 90, 99999999),
    },
    wornEquipment: { 測試: { 棍類武器: [{ name: '舊棍', primary: 50, attrs: [], needExp: 0, readAt: 1 }], 盾類防具: [{ name: '舊盾', primary: 10, attrs: [], needExp: 0, readAt: 1 }] } },
  });
}
const SUMMARY_LIST = [
  ' 1 黃金鎖鍊              價格：60S       2 虹色項鍊              價格：22S     ',
  ' 4 烈火棍                價格：1G40S     9 突襲盾                價格：40S     ',
  '== 未完繼續 52% == (ENTER 繼續下一頁，q 離開，b 前一頁)',
].join('\n');

ui('after a list page the summary says what is better than the worn gear, what cannot be worn yet, and what is still uncollected', async () => {
  const page = await boot({ scale: SCALE });
  try {
    seed(page);
    page.output(`<span id="listpage">${SUMMARY_LIST}</span>`);
    assert.ok(await waitFor(() => shopBox(page), 2000));
    const text = shopBox(page).textContent;
    assert.match(text, /經驗 414748/);
    assert.match(text, /已蒐集 3 件/);
    assert.match(text, /比現在好：4 烈火棍（傷害 \+10）/);
    assert.match(text, /經驗還不夠穿：1 件/);
    assert.match(text, /沒有目前穿著的資料可比：1 件/);
    assert.match(text, /還沒蒐集（1）：2/);
    assert.equal(shopBox(page).previousElementSibling.id, 'listpage', 'inserted right under the list page');
    assert.ok([...shopBox(page).querySelectorAll('button')].some(button => button.textContent === '複製 check 指令'));
    await sleep(200);
    assert.equal(page.w.document.querySelectorAll('[data-catworld-shop]').length, 1, 'its own output does not trigger another summary');
  } finally {
    page.close();
  }
});

ui('the copy button puts the check commands of the uncollected numbers on the clipboard', async () => {
  const page = await boot({ scale: SCALE });
  try {
    seed(page);
    let copied = null;
    Object.defineProperty(page.w.navigator, 'clipboard', { value: { writeText: async text => { copied = text; } }, configurable: true });
    page.output(`<span>${LIST_PAGE}</span>`);
    assert.ok(await waitFor(() => shopBox(page), 2000));
    [...shopBox(page).querySelectorAll('button')].find(button => button.textContent === '複製 check 指令').click();
    assert.ok(await waitFor(() => copied !== null, 2000));
    assert.equal(copied, 'check 2;check 3;check 14;check 24');
  } finally {
    page.close();
  }
});

ui('without the equipment feature switch the list gets no summary, but check results are still recorded', async () => {
  const page = await boot({ scale: SCALE });
  try {
    seed(page);
    page.store.zapFeatures = { items: false };
    page.output(`<span>${SUMMARY_LIST}</span>`);
    await sleep(200);
    assert.equal(shopBox(page), null);
    page.output(`<span>${checkOutput('虹色項鍊', '項鍊類防具', 5, 10)}</span>`);
    assert.ok(await waitFor(() => page.store.shopItems['虹色項鍊'], 2000));
  } finally {
    page.close();
  }
});
