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
const enable = page => { page.store.zapFeatures = { shop: true }; };

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

ui('prices read as G/S/C and format back, and the check cost is a 5% range', async () => {
  const page = await boot({ scale: SCALE });
  try {
    const { parsePrice, formatMoney, checkCost } = page.w.CatworldShopCollect;
    assert.equal(parsePrice('1G40S'), 14000);
    assert.equal(parsePrice('16S50C'), 1650);
    assert.equal(parsePrice('30C'), 30);
    assert.equal(parsePrice('2G4S'), 20400);
    assert.equal(parsePrice('價格'), null);
    assert.equal(parsePrice(''), null);
    assert.equal(formatMoney(14000), '1G40S');
    assert.equal(formatMoney(450), '4S50C');
    assert.equal(formatMoney(30), '30C');
    assert.equal(formatMoney(0), '0C');
    const cost = checkCost([14000, 1900]);
    assert.equal(cost.low, 795, '5% of 15900');
    assert.equal(cost.high, 835, 'up to 5% more');
  } finally {
    page.close();
  }
});

ui('a check output after paying the merchant is saved by item name, and the same name is overwritten', async () => {
  const page = await boot({ scale: SCALE });
  enable(page);
  try {
    page.output(`<span>${checkOutput('黃金鎖鍊', '鞭類武器', 47, 200000)}</span>`);
    assert.ok(await waitFor(() => page.store.shopItems?.['黃金鎖鍊'], 2000));
    const saved = page.store.shopItems['黃金鎖鍊'];
    assert.equal(saved.category, '鞭類武器');
    assert.equal(saved.primary, 47);
    assert.equal(saved.needExp, 200000);
    assert.ok(await waitFor(() => shopBox(page), 2000));
    assert.match(shopBox(page).textContent, /已記進裝備資料庫：黃金鎖鍊（鞭類武器，傷害 47，佩帶經驗 200000）/);
    assert.match(shopBox(page).textContent, /資料庫共 1 件/);
    page.output(`<span>${checkOutput('黃金鎖鍊', '鞭類武器', 50, 200000)}</span>`);
    assert.ok(await waitFor(() => page.store.shopItems['黃金鎖鍊'].primary === 50, 2000));
    assert.equal(Object.keys(page.store.shopItems).length, 1);
  } finally {
    page.close();
  }
});

ui('a merchant check with no equipment data says nothing was recorded', async () => {
  const page = await boot({ scale: SCALE });
  enable(page);
  try {
    page.output('<span>你付了一筆錢給商人，得到了以下資料：\n這是一個包子。\n</span>');
    assert.ok(await waitFor(() => shopBox(page), 2000));
    assert.match(shopBox(page).textContent, /沒有裝備資料.*沒有記錄/);
    assert.equal(page.store.shopItems, undefined);
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
  enable(page);
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
    zapFeatures: { shop: true },
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

ui('after a list page the summary suggests the wearable items with a higher required exp than what is worn, and counts the rest', async () => {
  const page = await boot({ scale: SCALE });
  try {
    seed(page);
    page.output(`<span id="listpage">${SUMMARY_LIST}</span>`);
    assert.ok(await waitFor(() => shopBox(page), 2000));
    const text = shopBox(page).textContent;
    assert.match(text, /經驗 414748/);
    assert.match(text, /已蒐集 3 件/);
    assert.match(text, /建議 check（穿得了、佩帶經驗比現在穿的高；實際數值 check 後才知道）：4 烈火棍（需經驗 100，現穿 舊棍 0）/);
    assert.match(text, /經驗還不夠穿：1 件/);
    assert.match(text, /沒有目前穿著的資料可比：1 件/);
    assert.match(text, /還沒蒐集（1）：2/);
    assert.match(text, /批次 check 預估約 1S10C～1S16C/, '虹色項鍊 22S: 5% is 1S10C, up to 1S16C');
    assert.equal(shopBox(page).previousElementSibling.id, 'listpage', 'inserted right under the list page');
    assert.equal([...shopBox(page).querySelectorAll('button')].some(button => button.textContent.startsWith('複製')), false, 'there is no copy button any more');
    await sleep(200);
    assert.equal(page.w.document.querySelectorAll('[data-catworld-shop]').length, 1, 'its own output does not trigger another summary');
  } finally {
    page.close();
  }
});

ui('the feature is off by default and when its switch is off: nothing is recorded and nothing is added to the output', async () => {
  const fresh = await boot({ scale: SCALE });
  try {
    fresh.output(`<span>${checkOutput('黃金鎖鍊', '鞭類武器', 47, 200000)}</span>`);
    fresh.output(`<span>${SUMMARY_LIST}</span>`);
    await sleep(300);
    assert.equal(fresh.store.shopItems, undefined, 'no switch value means off');
    assert.equal(shopBox(fresh), null);
  } finally {
    fresh.close();
  }
  const off = await boot({ scale: SCALE });
  try {
    seed(off);
    off.store.zapFeatures = { shop: false, items: true };
    off.output(`<span>${SUMMARY_LIST}</span>`);
    off.output(`<span>${checkOutput('虹色項鍊', '項鍊類防具', 5, 10)}</span>`);
    await sleep(300);
    assert.equal(shopBox(off), null);
    assert.equal(off.store.shopItems['虹色項鍊'], undefined);
  } finally {
    off.close();
  }
});

// 比現在好的那一個批次按鈕也在，但這些測試只看沒蒐集的那個
const buttonOf = (page, prefix) => [...shopBox(page).querySelectorAll('button')].find(button => button.textContent.startsWith(prefix));

ui('the batch button first shows the count and estimated cost, and sends nothing until confirmed', async () => {
  const page = await boot({ scale: SCALE });
  try {
    seed(page);
    const sent = [];
    page.w.CatworldShopCollect.setSender(text => { sent.push(text); return true; });
    page.output(`<span>${SUMMARY_LIST}</span>`);
    assert.ok(await waitFor(() => shopBox(page), 2000));
    const start = buttonOf(page, '批次 check 還沒蒐集的');
    assert.match(start.textContent, /批次 check 還沒蒐集的 1 個（約 1S10C～1S16C）/);
    start.click();
    assert.match(shopBox(page).textContent, /將依序送出 1 個 check，預估約 1S10C～1S16C，確認嗎？/);
    assert.deepEqual(sent, [], 'nothing is sent before the confirmation');
    buttonOf(page, '取消').click();
    assert.deepEqual(sent, []);
    assert.ok(buttonOf(page, '批次 check 還沒蒐集的'), 'cancel brings the start button back');
    buttonOf(page, '批次 check 還沒蒐集的').click();
    buttonOf(page, '確認送出').click();
    assert.deepEqual(sent, ['check 2']);
    assert.match(shopBox(page).textContent, /已開始送出 1 個 check/);
  } finally {
    page.close();
  }
});

ui('a batch sends at most BATCH_MAX of the uncollected numbers, in list order', async () => {
  const page = await boot({ scale: SCALE });
  try {
    seed(page);
    const sent = [];
    page.w.CatworldShopCollect.setSender(text => { sent.push(text); return true; });
    const many = Array.from({ length: 45 }, (_, i) => ` ${i + 1} 未知裝備${i + 1}          價格：10S`).join('\n');
    page.output(`<span>${many}</span>`);
    assert.ok(await waitFor(() => shopBox(page), 2000));
    const start = buttonOf(page, '批次 check 還沒蒐集的');
    assert.match(start.textContent, /批次 check 還沒蒐集的 40 個/);
    start.click();
    buttonOf(page, '確認送出').click();
    const numbers = sent[0].split(';').map(piece => Number(piece.replace('check ', '')));
    assert.equal(numbers.length, 40);
    assert.equal(numbers[0], 1);
    assert.equal(numbers[39], 40);
  } finally {
    page.close();
  }
});

ui('without a sender the confirmation says it could not send', async () => {
  const page = await boot({ scale: SCALE });
  try {
    seed(page);
    page.w.CatworldShopCollect.setSender(null);
    page.output(`<span>${SUMMARY_LIST}</span>`);
    assert.ok(await waitFor(() => shopBox(page), 2000));
    buttonOf(page, '批次 check 還沒蒐集的').click();
    buttonOf(page, '確認送出').click();
    assert.match(shopBox(page).textContent, /送不出去/);
  } finally {
    page.close();
  }
});

ui('content.js hands the batch to the macro runner so the commands really go out', async () => {
  const page = await boot({ scale: SCALE });
  try {
    seed(page);
    page.output(`<span>${SUMMARY_LIST}</span>`);
    assert.ok(await waitFor(() => shopBox(page), 2000));
    buttonOf(page, '批次 check 還沒蒐集的').click();
    buttonOf(page, '確認送出').click();
    assert.ok(await waitFor(() => page.sent.includes('check 2'), 3000), 'the check command was typed into the game input');
  } finally {
    page.close();
  }
});

ui('right after a check the item is compared with what is worn, using this check\'s own numbers', async () => {
  const page = await boot({ scale: SCALE });
  try {
    seed(page);
    page.output(`<span>${checkOutput('烈火棍', '棍類武器', 60, 100)}</span>`);
    assert.ok(await waitFor(() => shopBox(page), 2000));
    assert.match(shopBox(page).textContent, /和現在穿的 舊棍 比：比現在好，建議留下（傷害 \+10）/);
    page.output(`<span>${checkOutput('突襲盾', '盾類防具', 90, 99999999)}</span>`);
    assert.ok(await waitFor(() => page.w.document.querySelectorAll('[data-catworld-shop]').length === 2, 2000));
    assert.match(page.w.document.querySelectorAll('[data-catworld-shop]')[1].textContent, /經驗還不夠穿（需要 99999999）/);
    page.output(`<span>${checkOutput('黃金鎖鍊', '鞭類武器', 47, 200000)}</span>`);
    assert.ok(await waitFor(() => page.w.document.querySelectorAll('[data-catworld-shop]').length === 3, 2000));
    assert.match(page.w.document.querySelectorAll('[data-catworld-shop]')[2].textContent, /沒有這個類別的穿著資料可比/);
  } finally {
    page.close();
  }
});

ui('a same-name item whose numbers differ from the database is flagged and compared with its own numbers', async () => {
  const page = await boot({ scale: SCALE });
  try {
    seed(page);
    page.output(`<span>${checkOutput('烈火棍', '棍類武器', 52, 100)}</span>`);
    assert.ok(await waitFor(() => shopBox(page), 2000));
    const text = shopBox(page).textContent;
    assert.match(text, /注意：同名裝備的數值和資料庫舊資料不同（傷害／防禦 60 → 52），已改成這次的/);
    assert.match(text, /和現在穿的 舊棍 比.*（傷害 \+2）/, 'judged with 52, not the 60 stored before');
    assert.equal(page.store.shopItems['烈火棍'].primary, 52);
  } finally {
    page.close();
  }
});

ui('the list summary also offers a batch check for the suggested ones', async () => {
  const page = await boot({ scale: SCALE });
  try {
    seed(page);
    const sent = [];
    page.w.CatworldShopCollect.setSender(text => { sent.push(text); return true; });
    page.output(`<span>${SUMMARY_LIST}</span>`);
    assert.ok(await waitFor(() => shopBox(page), 2000));
    const start = [...shopBox(page).querySelectorAll('button')].find(button => button.textContent.startsWith('批次 check 建議的'));
    assert.match(start.textContent, /批次 check 建議的 1 個（約 7S～7S35C）/, '烈火棍 1G40S: 5% is 7S, up to 7S35C');
    start.click();
    [...shopBox(page).querySelectorAll('button')].find(button => button.textContent === '確認送出').click();
    assert.deepEqual(sent, ['check 4']);
  } finally {
    page.close();
  }
});

ui('the suggestion looks only at required exp: stats in the database do not matter, items not above what is worn are only counted, highest level first', async () => {
  const page = await boot({ scale: SCALE });
  try {
    page.w.document.title = '測試 - CatWorld';
    page.w.document.body.insertAdjacentHTML('beforeend', '<div id="exp">414748</div>');
    const item = (name, needExp, primary) => ({ name, category: '劍類武器', kind: 'weapon', primary, attrs: [], needExp, seen: 1 });
    Object.assign(page.store, {
      zapFeatures: { shop: true },
      shopItems: { 低劍: item('低劍', 1000, 999), 中劍: item('中劍', 50000, 1), 高劍: item('高劍', 300000, 1), 超高劍: item('超高劍', 900000, 999) },
      wornEquipment: { 測試: { 劍類武器: [{ name: '現劍', primary: 10, attrs: [], needExp: 20000, readAt: 1 }, { name: '舊劍', primary: 5, attrs: [], needExp: 8000, readAt: 1 }] } },
    });
    const list = [
      ' 1 低劍                  價格：1S       2 中劍                  價格：2S     ',
      ' 3 高劍                  價格：3S       4 超高劍                價格：4S     ',
      '== 未完繼續 52% ==',
    ].join('\n');
    page.output(`<span>${list}</span>`);
    assert.ok(await waitFor(() => shopBox(page), 2000));
    const text = shopBox(page).textContent;
    assert.match(text, /3 高劍（需經驗 300000，現穿 舊劍 8000）；2 中劍（需經驗 50000，現穿 舊劍 8000）/, 'compared with the lowest worn one, highest level first; its stat 999 is not what ranks 低劍');
    assert.doesNotMatch(text, /1 低劍（/, '低劍 requires 1000, not above the worn 舊劍');
    assert.match(text, /佩帶經驗不比現在穿的高：1 件/);
    assert.match(text, /經驗還不夠穿：1 件/);
  } finally {
    page.close();
  }
});

const PAGE_ONE = [
  '商人現在有賣以下貨物：',
  ' 1 甲劍                  價格：10S       2 乙劍                  價格：10S     ',
  '== 未完繼續 52% == (ENTER 繼續下一頁，q 離開，b 前一頁)',
].join('\n');
const PAGE_TWO = [
  ' 3 丙劍                  價格：10S       4 丁劍                  價格：10S     ',
].join('\n');

ui('two list pages are totalled: one summary, one batch covering both pages', async () => {
  const page = await boot({ scale: SCALE });
  try {
    seed(page);
    const sent = [];
    page.w.CatworldShopCollect.setSender(text => { sent.push(text); return true; });
    page.output(`<span id="p1">${PAGE_ONE}</span>`);
    assert.ok(await waitFor(() => shopBox(page), 2000));
    assert.match(shopBox(page).textContent, /這頁 2 件/);
    page.output(`<span id="p2">${PAGE_TWO}</span>`);
    assert.ok(await waitFor(() => /累計 2 頁 4 件/.test(shopBox(page)?.textContent ?? ''), 2000));
    assert.equal(page.w.document.querySelectorAll('[data-catworld-shop]').length, 1, 'the older summary is replaced, so only one set of buttons is left');
    assert.equal(shopBox(page).previousElementSibling.id, 'p2', 'the totalled summary sits under the newest page');
    assert.match(shopBox(page).textContent, /還沒蒐集（4）：1 2 3 4/);
    buttonOf(page, '批次 check 還沒蒐集的').click();
    buttonOf(page, '確認送出').click();
    assert.deepEqual(sent, ['check 1;check 2;check 3;check 4']);
  } finally {
    page.close();
  }
});

ui('a list that starts again with its header starts a new total', async () => {
  const page = await boot({ scale: SCALE });
  try {
    seed(page);
    page.output(`<span>${PAGE_ONE}</span>`);
    assert.ok(await waitFor(() => shopBox(page), 2000));
    page.output(`<span>${PAGE_TWO}</span>`);
    assert.ok(await waitFor(() => /累計 2 頁/.test(shopBox(page)?.textContent ?? ''), 2000));
    page.output(`<span>${PAGE_ONE}</span>`);
    const newest = () => [...page.w.document.querySelectorAll('[data-catworld-shop]')].pop();
    assert.ok(await waitFor(() => /這頁 2 件/.test(newest()?.textContent ?? ''), 2000), 'back to a single page, nothing carried over');
    assert.equal(page.w.document.querySelectorAll('[data-catworld-shop]').length, 2, 'the previous total stays where it was printed, the new list gets its own');
  } finally {
    page.close();
  }
});

ui('a batch bigger than the limit goes out in parts, the next part starting after the last sent number', async () => {
  const page = await boot({ scale: SCALE });
  try {
    seed(page);
    const sent = [];
    page.w.CatworldShopCollect.setSender(text => { sent.push(text); return true; });
    const many = Array.from({ length: 45 }, (_, i) => ` ${i + 1} 未知裝備${i + 1}          價格：10S`).join('\n');
    page.output(`<span>${many}</span>`);
    assert.ok(await waitFor(() => shopBox(page), 2000));
    buttonOf(page, '批次 check 還沒蒐集的').click();
    buttonOf(page, '確認送出').click();
    assert.equal(sent[0].split(';').length, 40);
    const next = buttonOf(page, '批次 check 還沒蒐集的 下一批');
    assert.match(next.textContent, /下一批 5 個/);
    next.click();
    buttonOf(page, '確認送出').click();
    assert.equal(sent[1], 'check 41;check 42;check 43;check 44;check 45', 'the first 40 are not sent again');
    assert.match(shopBox(page).textContent, /全部送完了/);
  } finally {
    page.close();
  }
});

const batchList = names => [
  '商人現在有賣以下貨物：',
  ...names.map((name, i) => ` ${i + 1} ${name}          價格：10S`),
  '== 未完繼續 52% ==',
].join('\n');

ui('during a confirmed batch each check is recorded quietly, then one digest lists only the recommended ones', async () => {
  const page = await boot({ scale: SCALE });
  try {
    seed(page);
    const sent = [];
    page.w.CatworldShopCollect.setSender(text => { sent.push(text); return true; });
    page.output(`<span>${batchList(['新棍A', '新棍B', '新盾'])}</span>`);
    assert.ok(await waitFor(() => shopBox(page), 2000));
    buttonOf(page, '批次 check 還沒蒐集的').click();
    buttonOf(page, '確認送出').click();
    const boxes = () => [...page.w.document.querySelectorAll('[data-catworld-shop]')];
    page.output(`<span>${checkOutput('新棍A', '棍類武器', 60, 100)}</span>`);
    await sleep(150);
    assert.equal(boxes().length, 1, 'no per-check box while the batch is running');
    assert.ok(page.store.shopItems['新棍A'], 'but it is still recorded');
    page.output(`<span>${checkOutput('新棍B', '棍類武器', 40, 100)}</span>`);
    page.output(`<span>${checkOutput('新盾', '盾類防具', 90, 99999999)}</span>`);
    assert.ok(await waitFor(() => boxes().length === 2, 2000), 'the digest appears once all three answered');
    const text = boxes()[1].textContent;
    assert.match(text, /【批次 check 彙整】送出 3 個，收到 3 個回應/);
    assert.match(text, /值得換（1）：/);
    assert.match(text, /買 1 新棍A（10S）/);
    assert.match(text, /和現在穿的 舊棍 比：比現在好，建議留下（傷害 \+10）/);
    assert.doesNotMatch(text, /新棍B/, 'the ones that are not better are only counted');
    assert.match(text, /其他：經驗還不夠穿 1 件、不比現在好 1 件/);
    assert.doesNotMatch(text, /沒收到回應/);
    const buy = [...boxes()[1].querySelectorAll('button')].find(button => button.textContent.startsWith('買 1 新棍A'));
    buy.click();
    assert.deepEqual(sent.slice(-1), ['buy 1'], 'one click buys it by its list number, no confirmation');
    assert.match(boxes()[1].textContent, /已送出 buy 1/);
    assert.equal([...boxes()[1].querySelectorAll('button')].filter(button => button.textContent.startsWith('買 ')).length, 1, 'only the recommended one has a buy button');
  } finally {
    page.close();
  }
});

ui('a digest is printed after the quiet time even if some answers never came', async () => {
  const page = await boot({ scale: SCALE });
  try {
    seed(page);
    page.w.CatworldShopCollect.setSender(() => true);
    page.output(`<span>${batchList(['新棍A', '新棍B'])}</span>`);
    assert.ok(await waitFor(() => shopBox(page), 2000));
    buttonOf(page, '批次 check 還沒蒐集的').click();
    buttonOf(page, '確認送出').click();
    page.output(`<span>${checkOutput('新棍A', '棍類武器', 60, 100)}</span>`);
    assert.ok(await waitFor(() => page.w.document.querySelectorAll('[data-catworld-shop]').length === 2, 6000), 'the digest comes after the quiet time');
    const text = page.w.document.querySelectorAll('[data-catworld-shop]')[1].textContent;
    assert.match(text, /收到 1 個回應/);
    assert.match(text, /沒收到回應：1 個/);
  } finally {
    page.close();
  }
});

ui('checks typed by hand, outside a batch, still get their own line each', async () => {
  const page = await boot({ scale: SCALE });
  try {
    seed(page);
    page.output(`<span>${checkOutput('新棍A', '棍類武器', 60, 100)}</span>`);
    assert.ok(await waitFor(() => shopBox(page), 2000));
    assert.match(shopBox(page).textContent, /已記進裝備資料庫：新棍A/);
    assert.doesNotMatch(shopBox(page).textContent, /批次 check 彙整/);
  } finally {
    page.close();
  }
});

ui('uncollected items cheaper than the minimum price stay out of the batch and the cost estimate, and the summary says so', async () => {
  const page = await boot({ scale: SCALE });
  try {
    seed(page);
    page.store.shopMinPrice = 5;
    const sent = [];
    page.w.CatworldShopCollect.setSender(text => { sent.push(text); return true; });
    const list = [
      ' 1 包子                  價格：30C       2 不知名藥草            價格：2S     ',
      ' 3 好劍                  價格：10S',
      '== 未完繼續 52% ==',
    ].join('\n');
    page.output(`<span>${list}</span>`);
    assert.ok(await waitFor(() => shopBox(page), 2000));
    const text = shopBox(page).textContent;
    assert.match(text, /還沒蒐集（3）：1 2 3/, 'all uncollected are still listed, cheap ones included');
    assert.match(text, /其中 2 件價格低於 5S，不列入批次 check/);
    assert.match(text, /批次 check 預估約 50C～53C/, '10S only: 5%');
    assert.match(buttonOf(page, '批次 check 還沒蒐集的').textContent, /批次 check 還沒蒐集的 1 個/);
    buttonOf(page, '批次 check 還沒蒐集的').click();
    buttonOf(page, '確認送出').click();
    assert.deepEqual(sent, ['check 3']);
  } finally {
    page.close();
  }
});

ui('a minimum price of 0 checks everything, and items cheaper than the default are filtered when the setting is absent', async () => {
  const page = await boot({ scale: SCALE });
  try {
    const { evaluate } = page.w.CatworldShopCollect;
    const items = [{ no: 1, name: '包子', price: '30C' }, { no: 2, name: '好劍', price: '10S' }];
    assert.equal(evaluate(items, {}, { minPrice: 0 }).unknownItems.length, 2);
    assert.equal(evaluate(items, {}, { minPrice: 500 }).unknownItems.length, 1);
    assert.equal(evaluate(items, {}, { minPrice: 500 }).cheap, 1);
    assert.equal(page.w.CatworldShopCollect.normalizeMinSilver(undefined), 5);
    assert.equal(page.w.CatworldShopCollect.normalizeMinSilver(-1), 5);
    assert.equal(page.w.CatworldShopCollect.normalizeMinSilver(0), 0);
    assert.equal(page.w.CatworldShopCollect.normalizeMinSilver(2.5), 2.5);
  } finally {
    page.close();
  }
});

const BUY_LIST = [
  '商人現在有賣以下貨物：',
  ' 4 烈火棍                價格：1G40S     5 不知名藥草            價格：2S     ',
  ' 23 包子                 價格：30C      30 無名物品              價格：3S     ',
  '== 未完繼續 52% ==',
].join('\n');
const buyButton = page => [...shopBox(page).querySelectorAll('button')].find(button => button.textContent.startsWith('買全部符合的'));

ui('the buy button takes every listed item named in the buy list in one click, no quantity box and no confirmation', async () => {
  const page = await boot({ scale: SCALE });
  try {
    seed(page);
    const sent = [];
    page.w.CatworldShopCollect.setSender(text => { sent.push(text); return true; });
    page.output(`<span>${BUY_LIST}</span>`);
    assert.ok(await waitFor(() => shopBox(page), 2000));
    assert.equal(shopBox(page).querySelector('input[type=number]'), null, 'no quantity to type');
    assert.match(buyButton(page).textContent, /買全部符合的 2 件（約 5S）/, '不知名藥草 2S + 無名物品 3S; 包子 and 烈火棍 are not in the default names');
    assert.match(shopBox(page).textContent, /快速購買（點了就送出 buy，不再確認）：5 不知名藥草、30 無名物品/);
    buyButton(page).click();
    assert.deepEqual(sent, ['buy 5;buy 30'], 'one click, every match once, no confirmation step');
    assert.match(shopBox(page).textContent, /已送出 2 個 buy/);
  } finally {
    page.close();
  }
});

ui('the buy list comes from the setting: custom names, and an empty setting shows no buy button', async () => {
  const page = await boot({ scale: SCALE });
  try {
    seed(page);
    page.store.shopBuyNames = '包子，烈火棍';
    const sent = [];
    page.w.CatworldShopCollect.setSender(text => { sent.push(text); return true; });
    page.output(`<span>${BUY_LIST}</span>`);
    assert.ok(await waitFor(() => shopBox(page), 2000));
    assert.match(buyButton(page).textContent, /買全部符合的 2 件/);
    buyButton(page).click();
    assert.deepEqual(sent, ['buy 4;buy 23']);
  } finally {
    page.close();
  }
  const none = await boot({ scale: SCALE });
  try {
    seed(none);
    none.store.shopBuyNames = '';
    none.output(`<span>${BUY_LIST}</span>`);
    assert.ok(await waitFor(() => shopBox(none), 2000));
    assert.equal(buyButton(none), undefined);
    assert.doesNotMatch(shopBox(none).textContent, /快速購買/);
  } finally {
    none.close();
  }
});

ui('matches from every accumulated list page are bought together, and more than the limit is cut with a note', async () => {
  const page = await boot({ scale: SCALE });
  try {
    seed(page);
    const sent = [];
    page.w.CatworldShopCollect.setSender(text => { sent.push(text); return true; });
    page.store.shopBuyNames = '藥';
    const rows = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ` ${from + i} 藥          價格：2S`).join('\n');
    page.output(`<span>商人現在有賣以下貨物：\n${rows(1, 15)}\n== 未完繼續 ==</span>`);
    assert.ok(await waitFor(() => shopBox(page), 2000));
    page.output(`<span>${rows(16, 25)}</span>`);
    assert.ok(await waitFor(() => /累計 2 頁/.test(shopBox(page)?.textContent ?? ''), 2000));
    assert.match(buyButton(page).textContent, /買全部符合的 20 件/);
    assert.match(shopBox(page).textContent, /還有 5 件超過一次 20 個的上限/);
    buyButton(page).click();
    assert.equal(sent[0].split(';').length, 20);
    assert.equal(sent[0].split(';')[0], 'buy 1');
    assert.equal(sent[0].split(';')[19], 'buy 20');
  } finally {
    page.close();
  }
});

ui('the buy button says so when there is nothing to send with', async () => {
  const page = await boot({ scale: SCALE });
  try {
    seed(page);
    page.w.CatworldShopCollect.setSender(null);
    page.output(`<span>${BUY_LIST}</span>`);
    assert.ok(await waitFor(() => shopBox(page), 2000));
    buyButton(page).click();
    assert.match(shopBox(page).textContent, /送不出去/);
  } finally {
    page.close();
  }
});

ui('buy names can be separated by commas, semicolons or spaces, and a missing setting means the default', async () => {
  const page = await boot({ scale: SCALE });
  try {
    const { buyNames } = page.w.CatworldShopCollect;
    assert.deepEqual(Array.from(buyNames('包子;狗肉；藥草、水, 酒 米')), ['包子', '狗肉', '藥草', '水', '酒', '米']);
    assert.deepEqual(Array.from(buyNames('')), []);
    assert.deepEqual(Array.from(buyNames(undefined)), ['無名物品', '無名藥草', '不知名藥草']);
  } finally {
    page.close();
  }
});

ui('a hand-typed check that is better than the worn one also gets a buy button, using the number from the list', async () => {
  const page = await boot({ scale: SCALE });
  try {
    seed(page);
    const sent = [];
    page.w.CatworldShopCollect.setSender(text => { sent.push(text); return true; });
    page.output(`<span>${SUMMARY_LIST}</span>`);
    assert.ok(await waitFor(() => shopBox(page), 2000));
    page.output(`<span>${checkOutput('烈火棍', '棍類武器', 60, 100)}</span>`);
    assert.ok(await waitFor(() => page.w.document.querySelectorAll('[data-catworld-shop]').length === 2, 2000));
    const recorded = [...page.w.document.querySelectorAll('[data-catworld-shop]')].find(box => /已記進裝備資料庫/.test(box.textContent));
    const buy = [...recorded.querySelectorAll('button')].find(button => button.textContent.startsWith('買 4 烈火棍（1G40S）'));
    buy.click();
    assert.deepEqual(sent, ['buy 4']);
  } finally {
    page.close();
  }
});

ui('a hand-typed check that is not better, or whose number is not known from a list, gets no buy button', async () => {
  const page = await boot({ scale: SCALE });
  try {
    seed(page);
    page.output(`<span>${checkOutput('烈火棍', '棍類武器', 60, 100)}</span>`);
    assert.ok(await waitFor(() => shopBox(page), 2000));
    assert.equal([...shopBox(page).querySelectorAll('button')].length, 0, 'better, but no list was shown so there is no number to buy with');
    page.output(`<span>${SUMMARY_LIST}</span>`);
    await sleep(150);
    page.output(`<span>${checkOutput('烈火棍', '棍類武器', 40, 100)}</span>`);
    assert.ok(await waitFor(() => page.w.document.querySelectorAll('[data-catworld-shop]').length >= 3, 2000));
    const last = [...page.w.document.querySelectorAll('[data-catworld-shop]')].filter(box => /已記進裝備資料庫/.test(box.textContent)).pop();
    assert.equal([...last.querySelectorAll('button')].length, 0, 'worse than what is worn');
  } finally {
    page.close();
  }
});

ui('a list with no item named in the buy list shows no buy button and no quick-buy section', async () => {
  const page = await boot({ scale: SCALE });
  try {
    seed(page);
    page.output(`<span>${LIST_PAGE}</span>`);
    assert.ok(await waitFor(() => shopBox(page), 2000));
    assert.doesNotMatch(shopBox(page).textContent, /快速購買|買全部符合的/);
    assert.equal([...shopBox(page).querySelectorAll('button')].some(button => button.textContent.startsWith('買')), false);
  } finally {
    page.close();
  }
});

const HORSE_LIST = [
  '商人現在有賣以下貨物：',
  ' 1 赤兔馬                價格：30G       2 白馬                  價格：20G     ',
  ' 3 烏黑駒                價格：25G       4 自由行走的花的赤兔馬  價格：40G     ',
  ' 5 好劍                  價格：10S       6 好槍                  價格：12S     ',
  '== 未完繼續 52% ==',
].join('\n');

ui('horses in the skip list are not checked, not counted as uncollected, and the summary says how many were skipped', async () => {
  const page = await boot({ scale: SCALE });
  try {
    seed(page);
    const sent = [];
    page.w.CatworldShopCollect.setSender(text => { sent.push(text); return true; });
    page.output(`<span>${HORSE_LIST}</span>`);
    assert.ok(await waitFor(() => shopBox(page), 2000));
    const text = shopBox(page).textContent;
    assert.match(text, /這頁 2 件，已蒐集 0 件/, 'only the sword and the spear count');
    assert.match(text, /略過 4 件（名稱含「不 check 名單」裡的字，例如馬；設定頁可調）/);
    assert.match(text, /還沒蒐集（2）：5 6/);
    buttonOf(page, '批次 check 還沒蒐集的').click();
    buttonOf(page, '確認送出').click();
    assert.deepEqual(sent, ['check 5;check 6'], 'no horse number is ever sent');
  } finally {
    page.close();
  }
});

ui('a name is skipped when it contains a skip word, so the flower horse goes with just the plain horse word', async () => {
  const page = await boot({ scale: SCALE });
  try {
    seed(page);
    page.store.shopSkipNames = '赤兔馬';
    page.output(`<span>${HORSE_LIST}</span>`);
    assert.ok(await waitFor(() => shopBox(page), 2000));
    assert.match(shopBox(page).textContent, /略過 2 件/, '赤兔馬 and 自由行走的花的赤兔馬 only');
    assert.match(shopBox(page).textContent, /還沒蒐集（4）：2 3 5 6/);
  } finally {
    page.close();
  }
});

ui('a page made only of skipped items shows one short note and no check buttons; an empty skip list skips nothing', async () => {
  const page = await boot({ scale: SCALE });
  try {
    seed(page);
    const only = ['商人現在有賣以下貨物：', ' 1 赤兔馬                價格：30G       2 白馬                  價格：20G     ', '== 未完繼續 52% =='].join('\n');
    page.output(`<span>${only}</span>`);
    assert.ok(await waitFor(() => shopBox(page), 2000));
    assert.match(shopBox(page).textContent, /這頁 2 件都在「不 check 名單」裡（例如馬），略過/);
    assert.equal(shopBox(page).querySelectorAll('button').length, 0);
  } finally {
    page.close();
  }
  const none = await boot({ scale: SCALE });
  try {
    seed(none);
    none.store.shopSkipNames = '';
    none.output(`<span>${HORSE_LIST}</span>`);
    assert.ok(await waitFor(() => shopBox(none), 2000));
    assert.doesNotMatch(shopBox(none).textContent, /略過/);
    assert.match(shopBox(none).textContent, /還沒蒐集（6）：1 2 3 4 5 6/);
  } finally {
    none.close();
  }
});

ui('the built-in merchant items count as collected, the player check wins over them, and nothing is written back', async () => {
  const page = await boot({ scale: SCALE, builtin: true });
  try {
    page.w.document.title = '測試 - CatWorld';
    page.w.document.body.insertAdjacentHTML('beforeend', '<div id="exp">414748</div>');
    const built = page.w.CatworldShopCollect.builtinDb();
    assert.ok(Object.keys(built).length > 200, 'the TSV was generated into shop-data.js');
    assert.equal(built['大砍刀'].needExp, 100000);
    assert.equal(built['大砍刀'].kind, 'weapon');
    Object.assign(page.store, {
      zapFeatures: { shop: true },
      wornEquipment: { 測試: { 刀類武器: [{ name: '舊刀', primary: 10, attrs: [], needExp: 0, readAt: 1 }] } },
    });
    const list = ['商人現在有賣以下貨物：', ' 1 大砍刀                價格：30S', '== 未完繼續 52% =='].join('\n');
    page.output(`<span>${list}</span>`);
    assert.ok(await waitFor(() => shopBox(page), 2000));
    assert.match(shopBox(page).textContent, /已蒐集 1 件/);
    assert.match(shopBox(page).textContent, /建議 check[^：]*：1 大砍刀（需經驗 100000，現穿 舊刀 0）/, 'collected only from the built-in data');
    assert.equal(page.store.shopItems, undefined, 'the built-in data is not copied into the player storage');
    const merged = page.w.CatworldShopCollect.withBuiltin({ 大砍刀: { name: '大砍刀', category: '刀類武器', kind: 'weapon', primary: 1, attrs: [], needExp: 0, seen: 1 } });
    assert.equal(merged['大砍刀'].needExp, 0, 'the player check overrides the built-in entry');
  } finally {
    page.close();
  }
});
