// 設定頁「雲端同步」區的畫面測試：在 jsdom 載入真正的 popup.html 與 popup.js（Chrome API、fetch、遊戲分頁都是假的），
// 檢查角色自動帶入、密碼只存本機、上傳的內容、下載的確認與先備份、各種錯誤的文字與顏色。需要 jsdom；沒裝就跳過。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

let JSDOM = null;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  // 沒裝 jsdom：整批跳過
}
const ui = JSDOM ? test : test.skip;

const root = path.join(__dirname, '..', '..', '..', 'catworld-auto-command');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (condition, ms = 3000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (condition()) return true;
    await sleep(5);
  }
  return condition();
};

const URL_OK = 'https://script.google.com/macros/s/AKfycb-example/exec';
const GAME_TAB = { id: 7, url: 'https://catworld.muds.tw/web', title: '小貓 - CatWorld' };
const OK_REPLY = { ok: true, updatedAt: '2026-11-25T08:00:00.000Z', claimed: false };

// tab：假的目前分頁（popup 的 getTab 取 active tab）；reply：(請求本文) => 假的雲端回應（Error 代表網路失敗）；
// game：假的遊戲分頁，(訊息) => 回覆（沒給就連不上遊戲分頁）
async function boot({ store = {}, tab = GAME_TAB, reply = () => OK_REPLY, confirmAnswer = true, game = null } = {}) {
  const flags = { failSet: null };
  const calls = [];
  const confirms = [];
  const copied = [];
  const order = [];
  const listeners = [];
  const dom = await JSDOM.fromFile(path.join(root, 'popup.html'), {
    runScripts: 'dangerously',
    resources: 'usable',
    url: `file://${root.split(path.sep).join('/')}/popup.html`,
    beforeParse(window) {
      Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async text => { copied.push(text); } } });
      window.confirm = message => { confirms.push(message); return confirmAnswer; };
      window.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        calls.push({ url, init, body });
        const answer = await reply(body);
        if (answer instanceof Error) throw answer;
        if (answer?.rawText !== undefined) return { ok: true, status: 200, json: async () => JSON.parse(answer.rawText) };
        return { ok: answer?.http === undefined, status: answer?.http ?? 200, json: async () => answer };
      };
      window.chrome = {
        runtime: { getManifest: () => ({ version: '9.9.9' }), getURL: file => file, onMessage: { addListener() {} }, sendMessage: async () => ({}) },
        storage: {
          local: {
            get: async keys => Object.fromEntries([].concat(keys).filter(key => key in store).map(key => [key, JSON.parse(JSON.stringify(store[key]))])),
            set: async values => {
              if (flags.failSet?.(values)) throw new Error('disk full');
              order.push(...Object.keys(values));
              Object.assign(store, JSON.parse(JSON.stringify(values)));
            },
            remove: async keys => { [].concat(keys).forEach(key => { delete store[key]; }); },
          },
          sync: { get: async () => ({}), set: async () => {} },
          session: { get: async () => ({}), set: async () => {} },
          onChanged: { addListener: listener => listeners.push(listener) },
        },
        tabs: { query: async () => (tab ? [tab] : []), get: async () => { throw new Error('no tab'); }, sendMessage: async (id, message) => { if (!game) throw new Error('Receiving end does not exist'); return game(message); }, create: async () => {}, update: async () => {} },
        permissions: { contains: async () => true, request: async () => true, remove: async () => true, onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
        scripting: {},
        windows: { update: async () => {} },
      };
    },
  });
  const doc = dom.window.document;
  const $ = id => doc.getElementById(id);
  assert.ok(await waitFor(() => listeners.length > 0 && !$('cloudAccount').disabled), 'the settings page loaded and the cloud block unlocked');
  const input = (id, value) => { $(id).value = value; $(id).dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  const check = (id, value) => { $(id).checked = value; $(id).dispatchEvent(new dom.window.Event('change', { bubbles: true })); };
  const msg = () => ({ text: $('cloudMsg').textContent, error: $('cloudMsg').classList.contains('msg-error'), warn: $('cloudMsg').classList.contains('msg-warn') });
  // 按下去後等到請求結束：按鈕又可按，或整頁被凍結（備份區的按鈕也停用）
  const press = async id => {
    $(id).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await sleep(10);
    await waitFor(() => !$('cloudUpload').disabled || $('backupCopy').disabled);
  };
  return { dom, $, store, flags, calls, confirms, copied, order, input, check, msg, press, close: () => dom.window.close() };
}

const STORE = {
  settings: { fixedItems: [{ command: 'ps', minSeconds: 5, maxSeconds: 9 }] },
  triggerGroupSettings: { combat: { rules: [] } },
  mapMonsters: { 'a/1': { mobs: ['x(1)'] } },
  lineNotify: { enabled: true, token: 'SECRET-TOKEN', userId: 'U123' },
  captchaSampleUrl: 'https://script.google.com/macros/s/abc/exec',
  running: true,
};

const ready = async options => {
  const page = await boot(options);
  page.input('cloudUrl', URL_OK);
  page.input('cloudPassword', 'pw-1');
  return page;
};

ui('the section is a fold in the data group; the url sits in a closed 進階 fold; the password field is a password input', async () => {
  const page = await boot();
  try {
    const { $ } = page;
    assert.ok($('sec-cloud').classList.contains('fold'));
    assert.ok($('sec-cloud').closest('#grp-data'));
    assert.equal($('cloudPassword').type, 'password');
    const advanced = $('fold-cloud-advanced');
    assert.equal(advanced.open, false);
    assert.ok(advanced.contains($('cloudUrl')));
    assert.match(advanced.querySelector('summary').textContent, /進階/);
    const boxes = [...$('cloudBlocks').querySelectorAll('input[type="checkbox"]')];
    assert.equal(boxes.length, 8);
    assert.ok(boxes.every(box => box.checked));
  } finally {
    page.close();
  }
});

ui('the character is filled from the game tab title and can be edited; a non-game tab is ignored; with no tab it is typed by hand', async () => {
  const page = await boot({ store: { cloudSyncAccount: '舊角色' } });
  try {
    assert.equal(page.$('cloudAccount').value, '小貓');
    page.input('cloudAccount', ' 阿虎 ');
    assert.equal(page.store.cloudSyncAccount, '阿虎');
  } finally {
    page.close();
  }
  const other = await boot({ store: { cloudSyncAccount: '阿虎' }, tab: { id: 1, url: 'https://mail.example.com/', title: 'Inbox - Mail' } });
  try {
    assert.equal(other.$('cloudAccount').value, '阿虎', 'a non-game tab title is not a character name');
  } finally {
    other.close();
  }
  const none = await boot({ tab: null });
  try {
    assert.equal(none.$('cloudAccount').value, '');
    none.input('cloudAccount', 'manual');
    assert.equal(none.store.cloudSyncAccount, 'manual');
  } finally {
    none.close();
  }
});

ui('the password is kept locally and shown again next time, but never goes into a settings export or the cloud payload', async () => {
  const page = await ready({ store: { ...STORE } });
  try {
    assert.equal(page.store.cloudSyncPassword, 'pw-1');
    await page.press('cloudUpload');
    assert.equal(page.calls[0].body.password, 'pw-1', 'the password is the request field the server checks');
    assert.equal(JSON.stringify(page.calls[0].body.payload).includes('pw-1'), false, 'not in the payload');
    page.check('backupSecrets', true);
    page.$('backupCopy').dispatchEvent(new page.dom.window.MouseEvent('click', { bubbles: true }));
    assert.ok(await waitFor(() => page.copied.length === 1));
    assert.ok(page.copied[0].includes('SECRET-TOKEN'), 'the export really carried the secrets that are exportable');
    assert.equal(page.copied[0].includes('pw-1'), false, 'but not the sync password');
    ['cloudSyncPassword', 'cloudSyncAccount', 'cloudSyncBlocks'].forEach(key => assert.equal(page.copied[0].includes(key), false, key));
    assert.ok(page.copied[0].includes('cloudSyncUrl'), 'the url is an ordinary setting in the 共用與網址 block');
  } finally {
    page.close();
  }
  const again = await boot({ store: { cloudSyncPassword: 'pw-1' } });
  try {
    assert.equal(again.$('cloudPassword').value, 'pw-1');
  } finally {
    again.close();
  }
});

ui('a missing password, character or block shows an amber one and sends nothing', async () => {
  const page = await boot({ store: { ...STORE } });
  try {
    page.input('cloudUrl', URL_OK);
    page.input('cloudPassword', '');
    await page.press('cloudUpload');
    assert.deepEqual([page.msg().text, page.msg().warn, page.msg().error], ['請填同步密碼', true, false]);
    page.input('cloudPassword', 'pw-1');
    page.input('cloudAccount', '');
    await page.press('cloudUpload');
    assert.match(page.msg().text, /角色/);
    page.input('cloudAccount', 'x');
    page.$('cloudBlocks').querySelectorAll('input').forEach(box => page.check(box.id, false));
    await page.press('cloudUpload');
    assert.match(page.msg().text, /至少勾選/);
    assert.equal(page.calls.length, 0);
    page.input('cloudUrl', 'https://example.com/x');
    page.check('cloudBlock-timer', true);
    await page.press('cloudUpload');
    assert.equal(page.msg().error, true);
    assert.equal(page.calls.length, 0, 'a foreign host is refused before any request');
  } finally {
    page.close();
  }
});

ui('upload sends only the ticked blocks in the settings backup format, with no secrets, and reports the time and a claim', async () => {
  const page = await ready({ store: { ...STORE }, reply: () => ({ ...OK_REPLY, claimed: true }) });
  try {
    ['trigger', 'safety', 'helpers', 'chat', 'hunt', 'sources', 'data'].forEach(id => page.check(`cloudBlock-${id}`, false));
    await page.press('cloudUpload');
    assert.equal(page.calls.length, 1);
    const { url, init, body } = page.calls[0];
    assert.equal(url, URL_OK);
    assert.equal(init.method, 'POST');
    assert.deepEqual([body.action, body.account, body.password], ['upload', '小貓', 'pw-1']);
    assert.deepEqual(Object.keys(body.payload), ['settings']);
    const { settings } = body.payload;
    assert.equal(settings.format, 'catworld-settings');
    assert.equal(settings.exportedWith, '9.9.9');
    assert.deepEqual(Object.keys(settings.blocks), ['timer']);
    assert.deepEqual(settings.blocks.timer.settings, STORE.settings);
    assert.equal('secrets' in settings, false);
    const wire = JSON.stringify(body.payload);
    ['SECRET-TOKEN', 'U123', 'script.google.com/macros/s/abc', 'pw-1', 'mapMonsters'].forEach(text => assert.equal(wire.includes(text), false, text));
    assert.deepEqual([page.msg().error, page.msg().warn], [false, false]);
    assert.match(page.msg().text, /\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/);
    assert.match(page.msg().text, /已用這組密碼認領 小貓/);
    assert.deepEqual(page.store.cloudSyncBlocks, ['timer']);
  } finally {
    page.close();
  }
});

ui('an upload that did not claim does not mention a claim', async () => {
  const page = await ready({ store: { ...STORE } });
  try {
    await page.press('cloudUpload');
    assert.doesNotMatch(page.msg().text, /認領/);
    assert.match(page.msg().text, /已上傳 8 個區塊/);
  } finally {
    page.close();
  }
});

ui('every failure is red with its own words, and the next message clears the colour', async () => {
  let answer;
  const page = await ready({ store: { ...STORE }, reply: () => answer });
  try {
    const cases = [
      [{ ok: false, error: 'bad-password' }, /同步密碼不對/],
      [{ ok: false, error: 'not-found' }, /雲端還沒有 小貓 的設定/],
      [{ ok: false, error: 'too-large' }, /太大/],
      [{ ok: false, error: 'bad-request' }, /格式不對/],
      [{ ok: false, error: 'server-error' }, /伺服器出錯/],
      [new TypeError('Failed to fetch'), /連不上雲端/],
      [{ http: 500 }, /HTTP 500/],
      [{ rawText: '"not an object"' }, /看不懂/],
    ];
    for (const [reply, pattern] of cases) {
      answer = reply;
      await page.press('cloudUpload');
      assert.equal(page.msg().error, true, String(pattern));
      assert.match(page.msg().text, pattern);
    }
    answer = OK_REPLY;
    await page.press('cloudUpload');
    assert.deepEqual([page.msg().error, page.msg().warn], [false, false]);
    answer = { ok: false, error: 'not-found' };
    await page.press('cloudDownload');
    assert.match(page.msg().text, /雲端還沒有 小貓 的設定/);
    assert.equal(page.confirms.length, 0, 'no confirm when info fails');
    assert.equal(page.calls.at(-1).body.action, 'info');
  } finally {
    page.close();
  }
});

const CLOUD_SETTINGS = {
  format: 'catworld-settings',
  version: 1,
  exportedWith: '1.2.3',
  exportedAt: '2026-11-20T00:00:00.000Z',
  blocks: {
    timer: { settings: { fixedItems: [{ command: 'look', minSeconds: 1, maxSeconds: 2 }] }, bogusKey: 1 },
    chat: { chatReply: { enabled: true } },
    unknownBlock: { whatever: 1 },
  },
};
const cloud = (settings = CLOUD_SETTINGS) => body => (body.action === 'info'
  ? { ok: true, updatedAt: '2026-11-20T01:02:03.000Z', exportedWith: settings.exportedWith }
  : { ok: true, payload: { settings }, updatedAt: '2026-11-20T01:02:03.000Z', exportedWith: settings.exportedWith });

ui('download asks info first, confirms with the time, version and blocks, backs up before writing, and ignores unknown blocks and keys', async () => {
  const page = await ready({ store: { ...STORE, chatReply: { enabled: false }, mapHuntSettings: { a: 1 } }, reply: cloud() });
  try {
    page.check('cloudBlock-hunt', false);
    await page.press('cloudDownload');
    assert.deepEqual(page.calls.map(call => call.body.action), ['info', 'download']);
    assert.equal(page.confirms.length, 1);
    assert.match(page.confirms[0], /\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/);
    assert.match(page.confirms[0], /1\.2\.3/);
    assert.match(page.confirms[0], /定時與隨機/);
    assert.doesNotMatch(page.confirms[0], /巡怪/, 'an unticked block is not listed');
    assert.ok(page.order.indexOf('settingsBackup') >= 0 && page.order.indexOf('settingsBackup') < page.order.indexOf('settings'), 'backup first');
    assert.deepEqual(page.store.settings, CLOUD_SETTINGS.blocks.timer.settings);
    assert.equal('bogusKey' in page.store, false);
    assert.equal('whatever' in page.store, false);
    assert.deepEqual(page.store.chatReply, { enabled: true });
    assert.deepEqual(page.store.mapHuntSettings, { a: 1 }, 'an unticked block is left alone');
    assert.equal(page.store.lineNotify.token, 'SECRET-TOKEN');
    assert.equal(page.store.settingsBackup.values.settings.fixedItems[0].command, 'ps', 'the backup holds what was there before');
    assert.equal(page.store.cloudSyncPassword, 'pw-1', 'the password is not touched');
    assert.match(page.msg().text, /已套用 2 個區塊/);
    assert.equal(page.msg().error, false);
    assert.equal(page.$('cloudDownload').disabled, true, 'the page is frozen like after a file import');
  } finally {
    page.close();
  }
});

ui('declining the confirm downloads and writes nothing', async () => {
  const page = await ready({ store: { ...STORE }, reply: cloud(), confirmAnswer: false });
  try {
    await page.press('cloudDownload');
    assert.deepEqual(page.calls.map(call => call.body.action), ['info']);
    assert.equal('settingsBackup' in page.store, false);
    assert.deepEqual(page.store.settings, STORE.settings);
    assert.match(page.msg().text, /取消/);
    assert.equal(page.$('cloudDownload').disabled, false);
  } finally {
    page.close();
  }
});

ui('if the backup cannot be written nothing is imported', async () => {
  const page = await ready({ store: { ...STORE }, reply: cloud() });
  try {
    page.flags.failSet = values => 'settingsBackup' in values;
    await page.press('cloudDownload');
    assert.equal(page.msg().error, true);
    assert.match(page.msg().text, /備份寫不進去/);
    assert.deepEqual(page.store.settings, STORE.settings);
    assert.equal('chatReply' in page.store, false);
  } finally {
    page.close();
  }
});

ui('a cloud file that fails the import check, or has none of the ticked blocks, changes nothing', async () => {
  const bad = await ready({ store: { ...STORE }, reply: cloud({ format: 'something-else', version: 1, blocks: {} }) });
  try {
    await bad.press('cloudDownload');
    assert.equal(bad.msg().error, true);
    assert.match(bad.msg().text, /什麼都沒有動/);
    assert.deepEqual(bad.store.settings, STORE.settings);
  } finally {
    bad.close();
  }
  const page = await ready({ store: { ...STORE }, reply: cloud() });
  try {
    ['timer', 'chat'].forEach(id => page.check(`cloudBlock-${id}`, false));
    await page.press('cloudDownload');
    assert.match(page.msg().text, /沒有你勾選的區塊/);
    assert.equal(page.msg().warn, true);
    assert.equal('settingsBackup' in page.store, false);
  } finally {
    page.close();
  }
});

ui('cloud content identical to the local settings is reported and leaves the old backup alone', async () => {
  const same = { format: 'catworld-settings', version: 1, exportedWith: '1', blocks: { timer: { settings: STORE.settings } } };
  const page = await ready({ store: { ...STORE, settingsBackup: { at: 'old', values: {}, absent: [] } }, reply: cloud(same) });
  try {
    page.$('cloudBlocks').querySelectorAll('input').forEach(box => page.check(box.id, box.id === 'cloudBlock-timer'));
    await page.press('cloudDownload');
    assert.match(page.msg().text, /和現在一樣/);
    assert.equal(page.store.settingsBackup.at, 'old');
  } finally {
    page.close();
  }
});

// 遊戲分頁的巨集：90 格，第 1 格有內容；假的遊戲分頁回答 MACRO_READ／MACRO_WRITE
const GAME_MACROS = JSON.stringify([['65', 'look'], ...Array(89).fill(0)]);
const makeGame = (raw = GAME_MACROS, { failWrite = false } = {}) => {
  const state = { raw, types: [] };
  state.handler = async message => {
    if (message.type.startsWith('MACRO_')) state.types.push(message.type);
    if (message.type === 'MACRO_READ') return { ok: true, raw: state.raw };
    if (message.type === 'MACRO_WRITE') {
      if (failWrite) return { ok: false, error: 'storage full' };
      state.raw = message.raw;
      return { ok: true };
    }
    return {};
  };
  return state;
};
const CLOUD_MACROS = { version: 1, macros: [['66', 'cloud-cmd'], ...Array(89).fill(0)], notes: { 1: 'cloud note' } };
const cloudWithMacros = (settings = CLOUD_SETTINGS) => body => {
  const answer = cloud(settings)(body);
  return body.action === 'download' ? { ...answer, payload: { settings, macros: CLOUD_MACROS } } : answer;
};
const plain = value => JSON.parse(JSON.stringify(value));

ui('the macros box is off by default, remembered, and not part of a settings export', async () => {
  const page = await boot({ store: { ...STORE } });
  try {
    assert.equal(page.$('cloudMacros').checked, false);
    assert.equal(page.$('cloudBlocks').contains(page.$('cloudMacros')), false, 'it is not one of the settings blocks');
    page.check('cloudMacros', true);
    assert.equal(page.store.cloudSyncMacros, true);
    page.check('backupSecrets', true);
    page.$('backupCopy').dispatchEvent(new page.dom.window.MouseEvent('click', { bubbles: true }));
    assert.ok(await waitFor(() => page.copied.length === 1));
    assert.equal(page.copied[0].includes('cloudSyncMacros'), false);
  } finally {
    page.close();
  }
  const again = await boot({ store: { cloudSyncMacros: true } });
  try {
    assert.equal(again.$('cloudMacros').checked, true);
  } finally {
    again.close();
  }
});

ui('upload with the macros box ticked puts the macro export (same shape as the export file) in payload.macros', async () => {
  const game = makeGame();
  const page = await ready({ store: { ...STORE, macroNotes: { 1: '備註一', 5: '   ' } }, game: game.handler });
  try {
    page.check('cloudMacros', true);
    await page.press('cloudUpload');
    assert.equal(page.calls.length, 1);
    const { payload } = page.calls[0].body;
    assert.deepEqual(Object.keys(payload), ['settings', 'macros']);
    assert.equal(payload.macros.version, 1);
    assert.equal(payload.macros.macros.length, 90);
    assert.deepEqual(payload.macros.macros[0], ['65', 'look']);
    assert.deepEqual(payload.macros.notes, { 1: '備註一' });
    assert.deepEqual(game.types, ['MACRO_READ']);
    assert.match(page.msg().text, /與遊戲巨集/);
    assert.equal(page.msg().error, false);
  } finally {
    page.close();
  }
});

ui('upload with the box unticked never touches the game tab and sends settings only', async () => {
  const game = makeGame();
  const page = await ready({ store: { ...STORE }, game: game.handler });
  try {
    await page.press('cloudUpload');
    assert.deepEqual(Object.keys(page.calls[0].body.payload), ['settings']);
    assert.deepEqual(game.types, []);
  } finally {
    page.close();
  }
});

ui('upload with the box ticked but no game tab, or unreadable macros, is a red error and sends nothing', async () => {
  const none = await ready({ store: { ...STORE } });
  try {
    none.check('cloudMacros', true);
    await none.press('cloudUpload');
    assert.equal(none.calls.length, 0);
    assert.equal(none.msg().error, true);
    assert.match(none.msg().text, /什麼都沒有上傳/);
    assert.match(none.msg().text, /遊戲分頁/);
  } finally {
    none.close();
  }
  const broken = makeGame('{not json');
  const damaged = await ready({ store: { ...STORE }, game: broken.handler });
  try {
    damaged.check('cloudMacros', true);
    await damaged.press('cloudUpload');
    assert.equal(damaged.calls.length, 0);
    assert.equal(damaged.msg().error, true);
    assert.match(damaged.msg().text, /讀不懂/);
  } finally {
    damaged.close();
  }
});

ui('download with the box ticked backs up the game macros first, then writes macros and notes, and confirm mentions them', async () => {
  const game = makeGame();
  const page = await ready({ store: { ...STORE, macroNotes: { 2: 'old note' } }, reply: cloudWithMacros(), game: game.handler });
  try {
    page.check('cloudMacros', true);
    await page.press('cloudDownload');
    assert.match(page.confirms[0], /巨集/);
    assert.equal(page.store.macroBackup.raw, GAME_MACROS, 'the backup is the game text as it was');
    assert.deepEqual(plain(page.store.macroBackup.notes), { 2: 'old note' });
    assert.ok(page.order.indexOf('macroBackup') < page.order.indexOf('macroNotes'), 'backup before the notes are replaced');
    assert.ok(game.types.indexOf('MACRO_READ') < game.types.indexOf('MACRO_WRITE'), 'read before write');
    const written = JSON.parse(game.raw);
    assert.equal(written.length, 90);
    assert.deepEqual(written[0], ['66', 'cloud-cmd']);
    assert.deepEqual(plain(page.store.macroNotes), { 1: 'cloud note' });
    assert.equal(page.store.macroNotesWriter, 'macro-io');
    assert.deepEqual(page.store.settings, CLOUD_SETTINGS.blocks.timer.settings, 'the settings part is applied too');
    assert.match(page.msg().text, /已套用 2 個區塊/);
    assert.match(page.msg().text, /重新整理遊戲頁/);
    assert.equal(page.msg().error, false);
    assert.equal(page.msg().warn, false);
  } finally {
    page.close();
  }
});

ui('download with the box ticked but no game tab writes the settings, skips the macros with an amber warning', async () => {
  const page = await ready({ store: { ...STORE, macroNotes: { 2: 'old note' } }, reply: cloudWithMacros() });
  try {
    page.check('cloudMacros', true);
    await page.press('cloudDownload');
    assert.deepEqual(page.store.settings, CLOUD_SETTINGS.blocks.timer.settings);
    assert.equal(page.msg().warn, true);
    assert.equal(page.msg().error, false);
    assert.match(page.msg().text, /打開遊戲後再下載一次/);
    assert.equal('macroBackup' in page.store, false);
    assert.deepEqual(plain(page.store.macroNotes), { 2: 'old note' });
  } finally {
    page.close();
  }
});

ui('download with the box unticked never touches macros, even when the cloud has them', async () => {
  const game = makeGame();
  const page = await ready({ store: { ...STORE, macroNotes: { 2: 'old note' } }, reply: cloudWithMacros(), game: game.handler });
  try {
    await page.press('cloudDownload');
    assert.doesNotMatch(page.confirms[0], /巨集/);
    assert.deepEqual(game.types, []);
    assert.equal(game.raw, GAME_MACROS);
    assert.equal('macroBackup' in page.store, false);
    assert.deepEqual(plain(page.store.macroNotes), { 2: 'old note' });
    assert.match(page.msg().text, /已套用 2 個區塊/);
  } finally {
    page.close();
  }
});

ui('if the macro backup cannot be written the macros are not written but the settings are; a bad cloud macro blob is refused', async () => {
  const game = makeGame();
  const page = await ready({ store: { ...STORE }, reply: cloudWithMacros(), game: game.handler });
  try {
    page.flags.failSet = values => 'macroBackup' in values;
    page.check('cloudMacros', true);
    await page.press('cloudDownload');
    assert.deepEqual(page.store.settings, CLOUD_SETTINGS.blocks.timer.settings);
    assert.equal(game.raw, GAME_MACROS);
    assert.equal(game.types.includes('MACRO_WRITE'), false);
    assert.equal(page.msg().error, true);
    assert.match(page.msg().text, /備份寫不進去/);
  } finally {
    page.close();
  }
  const game2 = makeGame();
  const badBlob = body => {
    const answer = cloudWithMacros()(body);
    return body.action === 'download' ? { ...answer, payload: { ...answer.payload, macros: { version: 99 } } } : answer;
  };
  const bad = await ready({ store: { ...STORE }, reply: badBlob, game: game2.handler });
  try {
    bad.check('cloudMacros', true);
    await bad.press('cloudDownload');
    assert.equal(bad.msg().error, true);
    assert.match(bad.msg().text, /雲端的遊戲巨集不能用/);
    assert.equal(game2.raw, GAME_MACROS);
    assert.equal('macroBackup' in bad.store, false);
  } finally {
    bad.close();
  }
});

ui('a failed game write puts the previous macro backup back; a macros-only download still works when the settings are identical', async () => {
  const game = makeGame(GAME_MACROS, { failWrite: true });
  const oldBackup = { at: 1, raw: 'old-text', notes: {} };
  const page = await ready({ store: { ...STORE, macroBackup: oldBackup }, reply: cloudWithMacros(), game: game.handler });
  try {
    page.check('cloudMacros', true);
    await page.press('cloudDownload');
    assert.deepEqual(plain(page.store.macroBackup), oldBackup);
    assert.equal(page.msg().error, true);
    assert.match(page.msg().text, /寫不進去/);
  } finally {
    page.close();
  }
  const same = { format: 'catworld-settings', version: 1, exportedWith: '1', blocks: { timer: { settings: STORE.settings } } };
  const game2 = makeGame();
  const only = await ready({ store: { ...STORE }, reply: cloudWithMacros(same), game: game2.handler });
  try {
    only.$('cloudBlocks').querySelectorAll('input').forEach(box => only.check(box.id, box.id === 'cloudBlock-timer'));
    only.check('cloudMacros', true);
    await only.press('cloudDownload');
    assert.match(only.msg().text, /和現在一樣/);
    assert.deepEqual(JSON.parse(game2.raw)[0], ['66', 'cloud-cmd']);
    assert.equal('settingsBackup' in only.store, false);
    assert.equal(only.$('cloudDownload').disabled, false, 'the page is not frozen when only macros were written');
  } finally {
    only.close();
  }
});
