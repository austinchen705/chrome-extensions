// 設定頁「地圖巡怪」區塊：在 jsdom 載入真正的 popup.html 與 popup.js（Chrome API 用假的），檢查欄位、預設值、存檔與讀回。需要 jsdom；沒裝就跳過。
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

async function boot(store = {}, { game = null } = {}) {
  const dom = await JSDOM.fromFile(path.join(root, 'popup.html'), {
    runScripts: 'dangerously',
    resources: 'usable',
    url: `file://${root.split(path.sep).join('/')}/popup.html`,
    beforeParse(window) {
      window.chrome = {
        runtime: { getManifest: () => ({ version: '0.0.0' }), getURL: file => file, onMessage: { addListener() {} }, sendMessage: async () => ({}) },
        storage: {
          local: {
            get: async keys => Object.fromEntries([].concat(keys).filter(key => key in store).map(key => [key, JSON.parse(JSON.stringify(store[key]))])),
            set: async values => { Object.assign(store, JSON.parse(JSON.stringify(values))); },
            remove: async keys => { [].concat(keys).forEach(key => { delete store[key]; }); },
          },
          sync: { get: async () => ({}), set: async () => {} },
          session: { get: async () => ({}), set: async () => {} },
          onChanged: { addListener() {} },
        },
        tabs: game
          ? { query: async () => [{ id: 7, url: 'https://catworld.muds.tw/web' }], get: async () => ({ id: 7, url: 'https://catworld.muds.tw/web' }), sendMessage: async (id, message) => game(message), create: async () => {}, update: async () => {} }
          : { query: async () => [], get: async () => { throw new Error('no tab'); }, sendMessage: async () => { throw new Error('no tab'); }, create: async () => {}, update: async () => {} },
        permissions: { contains: async () => true, request: async () => true, remove: async () => true, onAdded: { addListener() {} }, onRemoved: { addListener() {} } },
        scripting: {},
        windows: { update: async () => {} },
      };
    },
  });
  const doc = dom.window.document;
  assert.ok(await waitFor(() => doc.getElementById('huntFields')?.children.length > 0), 'the hunt fields were built');
  return { dom, doc, store };
}
const field = (doc, key) => doc.getElementById(`hunt-${key}`);
const change = (dom, node, value) => {
  node.value = value;
  node.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
};

ui('the hunt section is a closed fold with every field at its default', async () => {
  const { dom, doc } = await boot();
  try {
    const fold = doc.getElementById('sec-hunt');
    assert.equal(fold.tagName, 'DETAILS');
    assert.equal(fold.open, false);
    assert.equal(field(doc, 'healMode').value, 'eat');
    assert.equal(field(doc, 'eatBelow').value, '50');
    assert.equal(field(doc, 'restResume').value, '80');
    assert.equal(field(doc, 'afterKillCommand').value, 'gc');
    assert.equal(field(doc, 'refuseKeyword').value, '並不想跟你較量');
    assert.equal(field(doc, 'endKeywords').value, '一動也不動了、死了');
    assert.equal(field(doc, 'fightTimeoutSec').value, '60');
    assert.equal(field(doc, 'eatCommand').value, '', 'the eat command has no default');
  } finally {
    dom.window.close();
  }
});

ui('an edit is saved at once with the other fields, and a broken stored value falls back to the default', async () => {
  const { dom, doc, store } = await boot({ mapHuntSettings: { eatBelow: 'abc', healMode: 'rest', homeCommand: '  recall  ' } });
  try {
    assert.equal(field(doc, 'eatBelow').value, '50', 'a stored value that is not a number shows the default');
    assert.equal(field(doc, 'healMode').value, 'rest');
    assert.equal(field(doc, 'homeCommand').value, 'recall', 'stored text is trimmed');
    change(dom, field(doc, 'eatCommand'), 'eat pill;eat pill');
    assert.ok(await waitFor(() => store.mapHuntSettings?.eatCommand === 'eat pill;eat pill'));
    assert.equal(store.mapHuntSettings.healMode, 'rest', 'the rest of the settings are saved with it');
    change(dom, field(doc, 'eatBelow'), '35');
    assert.ok(await waitFor(() => store.mapHuntSettings.eatBelow === 35));
    change(dom, field(doc, 'eatBelow'), '250');
    assert.ok(await waitFor(() => store.mapHuntSettings.eatBelow === 50), 'out of range goes back to the default');
    assert.equal(field(doc, 'eatBelow').value, '50');
  } finally {
    dom.window.close();
  }
});

const cellOf = (doc, key) => field(doc, key).closest('.hfield');

ui('the reaction time before a fight sits in the fight fold on one row, defaults to 800-1500 ms, and a longest below the shortest is raised to it', async () => {
  const { dom, doc, store } = await boot();
  try {
    assert.ok(doc.getElementById('fold-hunt-fight').contains(field(doc, 'reactMinMs')));
    assert.ok(field(doc, 'reactMinMs').closest('.hrow') === field(doc, 'reactMaxMs').closest('.hrow'), 'shortest and longest share a row');
    assert.equal(field(doc, 'reactMinMs').value, '800');
    assert.equal(field(doc, 'reactMaxMs').value, '1500');
    change(dom, field(doc, 'reactMinMs'), '2000');
    assert.ok(await waitFor(() => store.mapHuntSettings?.reactMinMs === 2000));
    assert.equal(store.mapHuntSettings.reactMaxMs, 2000, 'the longest follows the shortest up');
  } finally {
    dom.window.close();
  }
});

ui('the command that starts a fight sits in the fight fold, defaults to fight, falls back to fight for a value that could run as a macro, and shows in the fold title once changed', async () => {
  for (const bad of ['', 'a;b', 'f；g', '@等待 1', 'x'.repeat(21)]) {
    const { dom, doc } = await boot({ mapHuntSettings: { fightCommand: bad } });
    try {
      assert.equal(field(doc, 'fightCommand').value, 'fight', JSON.stringify(bad));
    } finally {
      dom.window.close();
    }
  }
  const { dom, doc, store } = await boot();
  try {
    assert.ok(doc.getElementById('fold-hunt-fight').contains(field(doc, 'fightCommand')));
    const title = () => doc.querySelector('#fold-hunt-fight > summary').textContent;
    assert.doesNotMatch(title(), /開打用/, 'the default leaves the title as it was');
    change(dom, field(doc, 'fightCommand'), 'f');
    assert.ok(await waitFor(() => store.mapHuntSettings?.fightCommand === 'f'));
    assert.match(title(), /開打用 f/);
    change(dom, field(doc, 'fightMode'), 'assist');
    assert.ok(await waitFor(() => /開打用 f/.test(title()) && /只下 fight/.test(title())), 'the assist mode shows it too');
    assert.equal(cellOf(doc, 'fightCommand').hidden, false, 'and the field stays visible there');
  } finally {
    dom.window.close();
  }
});

ui('the human-like switch is off by default, has its own fold, is saved with the other fields, and the fold title says which way it is', async () => {
  const { dom, doc, store } = await boot();
  try {
    assert.equal(field(doc, 'humanize').value, 'off');
    assert.ok(doc.getElementById('fold-hunt-human').contains(field(doc, 'humanize')), 'it sits in its own fold');
    assert.match(doc.querySelector('#fold-hunt-human > summary').textContent, /擬人化.*關/);
    change(dom, field(doc, 'humanize'), 'on');
    assert.ok(await waitFor(() => store.mapHuntSettings?.humanize === 'on'));
    assert.match(doc.querySelector('#fold-hunt-human > summary').textContent, /擬人化.*開/);
  } finally {
    dom.window.close();
  }
});

ui('the command log switch is on by default, sits in the advanced fold and is saved', async () => {
  const { dom, doc, store } = await boot();
  try {
    assert.equal(field(doc, 'logCommands').value, 'on');
    assert.ok(doc.getElementById('fold-hunt-advanced').contains(field(doc, 'logCommands')), 'it sits in the advanced fold');
    change(dom, field(doc, 'logCommands'), 'off');
    assert.ok(await waitFor(() => store.mapHuntSettings?.logCommands === 'off'));
  } finally {
    dom.window.close();
  }
});

ui('the return-to-the-hunting-area command is in the round settings, shows while waiting for the next respawn, is marked (but does not block starting) only for the humanized rest, and is saved', async () => {
  const { dom, doc, store } = await boot({ mapHuntSettings: { humanize: 'on' } });
  try {
    const cell = cellOf(doc, 'restReturnCommand');
    assert.equal(cell.hidden, false);
    assert.ok(cell.closest('#fold-hunt-rounds'), 'it sits with the round settings, next to the standby command');
    assert.ok(cell.classList.contains('hmissing'), 'marked while it is empty and the humanized rest is on');
    const title = () => doc.querySelector('#fold-hunt-human > summary').textContent;
    assert.match(title(), /沒填回程指令，不會掛機休息/);
    assert.doesNotMatch(doc.querySelector('#fold-hunt-rounds > summary').textContent, /有必填的沒填/, 'it only turns the rest off, so it is not a field that must be filled to start');
    change(dom, field(doc, 'restReturnCommand'), '@巨集 5');
    assert.ok(await waitFor(() => store.mapHuntSettings?.restReturnCommand === '@巨集 5'));
    assert.equal(cell.classList.contains('hmissing'), false);
    assert.doesNotMatch(title(), /沒填回程指令/);
    change(dom, field(doc, 'restReturnCommand'), '');
    assert.ok(await waitFor(() => cell.classList.contains('hmissing')));
    change(dom, field(doc, 'humanize'), 'off');
    assert.ok(await waitFor(() => !cell.classList.contains('hmissing')), 'not marked without the humanized rest');
    assert.equal(cell.hidden, false, 'still shown: the standby command may take you off the hunting map');
    change(dom, field(doc, 'restReturnCommand'), '@巨集 5');
    assert.ok(await waitFor(() => store.mapHuntSettings?.restReturnCommand === '@巨集 5'));
    change(dom, field(doc, 'loopRounds'), 'off');
    assert.ok(await waitFor(() => cell.hidden === true), 'hidden when it never waits for a respawn');
    assert.equal(store.mapHuntSettings.restReturnCommand, '@巨集 5', 'but kept');
  } finally {
    dom.window.close();
  }
});

ui('the alt ID field stays visible in sell-everything mode when always-give items are filled', async () => {
  const { dom, doc, store } = await boot({ mapHuntSettings: { loadMaxPercent: 90, sortKeep: 'none' } });
  try {
    assert.equal(cellOf(doc, 'altId').hidden, true, 'hidden in sell-everything mode with no items');
    change(dom, field(doc, 'giveItems'), 'unknown herb、unknown object');
    assert.ok(await waitFor(() => store.mapHuntSettings?.giveItems === 'unknown herb、unknown object'));
    assert.ok(await waitFor(() => cellOf(doc, 'altId').hidden === false), 'shown once items are filled');
  } finally {
    dom.window.close();
  }
});

ui('sort after every round shows with or without waiting for the next respawn, shows the sort fields even with the load check off, and needs the trip command', async () => {
  const { dom, doc, store } = await boot({ mapHuntSettings: { loadMaxPercent: 0 } });
  try {
    const cell = cellOf(doc, 'sortAfterRound');
    assert.equal(cell.hidden, false);
    assert.equal(cellOf(doc, 'tripCommand').hidden, true, 'no sort fields with the load check off');
    change(dom, field(doc, 'sortAfterRound'), 'on');
    assert.ok(await waitFor(() => store.mapHuntSettings?.sortAfterRound === 'on'));
    assert.ok(await waitFor(() => cellOf(doc, 'tripCommand').hidden === false), 'the sort fields show');
    assert.equal(cellOf(doc, 'overloadAction').hidden, true, 'what to do over the load limit still needs the load check');
    assert.ok(cellOf(doc, 'tripCommand').classList.contains('hmissing'), 'the trip command must be filled');
    change(dom, field(doc, 'tripCommand'), 'go shop');
    assert.ok(await waitFor(() => !cellOf(doc, 'tripCommand').classList.contains('hmissing')));
    change(dom, field(doc, 'loopRounds'), 'off');
    assert.ok(await waitFor(() => store.mapHuntSettings?.loopRounds === 'off'));
    assert.equal(cell.hidden, false, 'still shown: with no waiting for the respawn it sorts and stops');
    assert.equal(cellOf(doc, 'tripCommand').hidden, false);
    change(dom, field(doc, 'tripCommand'), '');
    assert.ok(await waitFor(() => cellOf(doc, 'tripCommand').classList.contains('hmissing')), 'the trip command is still required');
  } finally {
    dom.window.close();
  }
});

ui('there is no start-early field, and an old stored value is ignored and dropped by the next save', async () => {
  const { dom, doc, store } = await boot({ mapHuntSettings: { aheadSec: 45, loopRounds: 'on', stopBeforeSpawnSec: 30 } });
  try {
    assert.equal(field(doc, 'aheadSec'), null, 'the field is gone');
    assert.doesNotMatch(doc.querySelector('#fold-hunt-rounds > summary').textContent, /提早/, 'and the fold title no longer mentions it');
    assert.equal(field(doc, 'stopBeforeSpawnSec').value, '30', 'the other round settings are kept');
    change(dom, field(doc, 'eatCommand'), 'eat pill');
    assert.ok(await waitFor(() => store.mapHuntSettings?.eatCommand === 'eat pill'));
    assert.equal('aheadSec' in store.mapHuntSettings, false, 'the old value is not written back');
    assert.equal(store.mapHuntSettings.stopBeforeSpawnSec, 30);
  } finally {
    dom.window.close();
  }
});

ui('the once-per-fight special switch sits in the special group and is off by default', async () => {
  const { dom, doc } = await boot();
  try {
    const select = field(doc, 'specialOnce');
    assert.ok(doc.getElementById('fold-hunt-special').contains(select));
    assert.equal(select.value, 'off');
  } finally {
    dom.window.close();
  }
});

ui('the opener-has-special switch sits in the special group and is off by default', async () => {
  const { dom, doc } = await boot();
  try {
    const select = field(doc, 'openerHasSpecial');
    assert.ok(doc.getElementById('fold-hunt-special').contains(select));
    assert.equal(select.value, 'off');
  } finally {
    dom.window.close();
  }
});

ui('the fields are split into closed folds whose titles carry the main values', async () => {
  const { dom, doc } = await boot({ mapHuntSettings: { eatCommand: 'tn', homeCommand: 'ride', specialCommand: 'ps' } });
  try {
    const folds = [...doc.querySelectorAll('#huntFields > details.fold')];
    assert.deepEqual(folds.map(box => box.id), ['fold-hunt-move', 'fold-hunt-fight', 'fold-hunt-special', 'fold-hunt-heal', 'fold-hunt-sort', 'fold-hunt-rounds', 'fold-hunt-human', 'fold-hunt-scholar', 'fold-hunt-advanced']);
    assert.ok(folds.every(box => !box.open), 'all closed at first');
    assert.ok(doc.getElementById('fold-hunt-heal').contains(field(doc, 'ginCommand')), 'jing sits with healing');
    assert.match(doc.querySelector('#fold-hunt-heal > summary').textContent, /補氣與安全.*吃藥 tn <50%.*回家 ride/);
    assert.match(doc.querySelector('#fold-hunt-special > summary').textContent, /ps，至少隔 10 秒/);
    assert.ok(field(doc, 'ginBelow').closest('.hrow') === field(doc, 'ginCommand').closest('.hrow'), 'threshold and command share a row');
  } finally {
    dom.window.close();
  }
});

ui('the healing fold goes jing, jing injury, qi, qi injury, shen, shen injury, then the rest command', async () => {
  const { dom, doc } = await boot({ mapHuntSettings: { healMode: 'rest', homeCommand: 'ride' } });
  try {
    const shown = [...doc.querySelectorAll('#fold-hunt-heal .hfield')].filter(cell => !cell.hidden && !cell.closest('.hrow')?.hidden).map(cell => cell.querySelector('label').textContent);
    assert.deepEqual(shown.slice(0, 13), ['補氣方式', '精低於 %', '精低時的指令', '精內傷低於 %', '精內傷時的指令', '氣低於 % 休息', '回到 % 才繼續', '氣內傷低於 %', '氣內傷時的指令', '神低於 %', '神低時的指令', '神內傷低於 %', '神內傷時的指令']);
    assert.equal(shown[13], '休息時送的指令');
  } finally {
    dom.window.close();
  }
});

ui('fields that do not apply are hidden but kept, and come back when the mode changes', async () => {
  const { dom, doc, store } = await boot({ mapHuntSettings: { eatCommand: 'tn', homeCommand: 'ride' } });
  try {
    assert.equal(cellOf(doc, 'restBelow').hidden, true, 'rest fields are hidden in eat mode');
    assert.equal(cellOf(doc, 'eatCommand').hidden, false);
    change(dom, field(doc, 'healMode'), 'rest');
    assert.equal(cellOf(doc, 'restBelow').hidden, false);
    assert.equal(cellOf(doc, 'eatCommand').hidden, true);
    assert.ok(await waitFor(() => store.mapHuntSettings?.healMode === 'rest'));
    assert.equal(store.mapHuntSettings.eatCommand, 'tn', 'the hidden value is still saved');
    change(dom, field(doc, 'fightMode'), 'assist');
    assert.equal(doc.getElementById('fold-hunt-special').hidden, true, 'the special attack group is gone in fight-only mode');
    assert.equal(cellOf(doc, 'killCommand').hidden, true);
    change(dom, field(doc, 'loadMaxPercent'), '0');
    assert.equal(cellOf(doc, 'tripCommand').hidden, true, 'no sorting fields without a load check');
    assert.match(doc.querySelector('#fold-hunt-sort > summary').textContent, /不檢查/);
  } finally {
    dom.window.close();
  }
});

ui('a field that must be filled before starting is marked until it is filled', async () => {
  const { dom, doc } = await boot();
  try {
    assert.ok(cellOf(doc, 'homeCommand').classList.contains('hmissing'));
    assert.ok(cellOf(doc, 'eatCommand').classList.contains('hmissing'));
    assert.match(doc.querySelector('#fold-hunt-heal > summary').textContent, /⚠ 有必填的沒填/);
    change(dom, field(doc, 'homeCommand'), 'ride');
    assert.equal(cellOf(doc, 'homeCommand').classList.contains('hmissing'), false);
    change(dom, field(doc, 'fightMode'), 'assist');
    assert.equal(cellOf(doc, 'eatCommand').classList.contains('hmissing'), false, 'fight-only mode does not need the eat command');
    assert.doesNotMatch(doc.querySelector('#fold-hunt-heal > summary').textContent, /⚠/);
  } finally {
    dom.window.close();
  }
});

ui('the learned NPCs are listed, and the clear button forgets them', async () => {
  const { dom, doc, store } = await boot({ mapHuntNpcs: ['smith', 'banker'] });
  try {
    assert.ok(await waitFor(() => /smith、banker/.test(doc.getElementById('huntNpcs').textContent)), doc.getElementById('huntNpcs').textContent);
    assert.match(doc.getElementById('huntNpcs').textContent, /（2）/);
    doc.getElementById('huntNpcClear').click();
    assert.ok(await waitFor(() => store.mapHuntNpcs === undefined), 'the stored list is removed');
    assert.ok(await waitFor(() => /尚未學到/.test(doc.getElementById('huntNpcs').textContent)));
  } finally {
    dom.window.close();
  }
});

ui('with nothing learned the list says so', async () => {
  const { dom, doc } = await boot();
  try {
    assert.match(doc.getElementById('huntNpcs').textContent, /尚未學到/);
  } finally {
    dom.window.close();
  }
});

ui('the two command fields have a verify button: it asks the game page with the field and the verb, shows the verdict in its colour, and is disabled while the hunt runs', async () => {
  let huntOn = false;
  const asked = [];
  const game = message => {
    if (message.type === 'HUNT_VERIFY_ALIAS') {
      asked.push({ command: message.command, verb: message.verb });
      return message.verb === 'kill' ? { ok: false, error: '巡怪或掃描進行中，停下來才能驗證' } : { ok: true, level: 'warn', text: '「fn」＝「fight NPC $1」：測試用的警告' };
    }
    if (message.type === 'STATUS') return { hunt: { on: huntOn } };
    return {};
  };
  const { dom, doc } = await boot({ mapHuntSettings: { fightCommand: 'fn', killCommand: 'k' } }, { game });
  try {
    const fightButton = cellOf(doc, 'fightCommand').querySelector('.hverify');
    const killButton = cellOf(doc, 'killCommand').querySelector('.hverify');
    assert.ok(fightButton && killButton, 'both fields have one');
    const fightMessage = cellOf(doc, 'fightCommand').querySelector('.hverify-msg');
    fightButton.click();
    assert.ok(await waitFor(() => /測試用的警告/.test(fightMessage.textContent)), fightMessage.textContent);
    assert.deepEqual(asked[0], { command: 'fn', verb: 'fight' });
    assert.ok(fightMessage.classList.contains('msg-warn'), 'a warning is amber');
    killButton.click();
    const killMessage = cellOf(doc, 'killCommand').querySelector('.hverify-msg');
    assert.ok(await waitFor(() => /進行中/.test(killMessage.textContent)), killMessage.textContent);
    assert.deepEqual(asked[1], { command: 'k', verb: 'kill' });
    assert.ok(killMessage.classList.contains('msg-error'), 'a refusal is red');
    huntOn = true;
    assert.ok(await waitFor(() => fightButton.disabled && killButton.disabled, 3000), 'disabled while the hunt runs');
    huntOn = false;
    assert.ok(await waitFor(() => !fightButton.disabled, 3000), 'and back once it stops');
  } finally {
    dom.window.close();
  }
});

ui('from-alias button: lists the suggestions best first, a click fills the field and saves it, no suitable alias shows the setup hint, and it is disabled while the hunt runs', async () => {
  let huntOn = false;
  let items = [{ name: 'fn', expansion: 'fight NPC $1', rank: 'best' }, { name: 'f', expansion: 'fight $1', rank: 'ok' }];
  let empty = false;
  const asked = [];
  const game = message => {
    if (message.type === 'HUNT_SUGGEST_ALIAS') { asked.push(message.verb); return { ok: true, items, tooLong: false, empty }; }
    if (message.type === 'STATUS') return { hunt: { on: huntOn } };
    return {};
  };
  const { dom, doc, store } = await boot({}, { game });
  try {
    const cell = cellOf(doc, 'fightCommand');
    const button = cell.querySelector('.hsuggest');
    const message = cell.querySelector('.hverify-msg');
    const list = cell.querySelector('.hsuggest-list');
    button.click();
    assert.ok(await waitFor(() => list.querySelectorAll('button').length === 2), message.textContent);
    assert.deepEqual(asked, ['fight']);
    const texts = [...list.querySelectorAll('button')].map(b => b.textContent);
    assert.equal(texts[0], 'fn ＝ fight NPC $1（建議）');
    assert.equal(texts[1], 'f ＝ fight $1');
    list.querySelectorAll('button')[0].click();
    assert.equal(cell.querySelector('input').value, 'fn');
    assert.ok(await waitFor(() => store.mapHuntSettings?.fightCommand === 'fn'), 'saved like typing it');
    assert.match(message.textContent, /已填入 fn/);
    assert.equal(list.querySelectorAll('button').length, 0, 'the list closes');
    items = [];
    cellOf(doc, 'killCommand').querySelector('.hsuggest').click();
    const killMessage = cellOf(doc, 'killCommand').querySelector('.hverify-msg');
    assert.ok(await waitFor(() => /alias kn kill NPC \$1/.test(killMessage.textContent)), killMessage.textContent);
    assert.match(killMessage.textContent, /沒實測過/);
    empty = true;
    button.click();
    assert.ok(await waitFor(() => /讀不到別名列表/.test(message.textContent)), message.textContent);
    assert.ok(message.classList.contains('msg-error'));
    huntOn = true;
    assert.ok(await waitFor(() => button.disabled, 3000), 'disabled while the hunt runs');
  } finally {
    dom.window.close();
  }
});

// ---- 跨區路線（hunt-chain 05）：設定頁巡怪底下的「跨區路線」編輯器 ----
const MOB_T = '測試怪(test mob)';
const MOB_U = '另一隻怪(other mob)';
const chainStore = extra => ({
  mapMonsters: {
    't/c': { area: 't', room: 'c', areaName: '測試區', mobs: [MOB_T], seen: 1 },
    'u/q': { area: 'u', room: 'q', areaName: '第二區', mobs: [MOB_U, MOB_T], seen: 1 },
  },
  ...extra,
});
const chainBox = doc => doc.getElementById('huntChain');
const cards = doc => [...chainBox(doc).querySelectorAll('.hcard')];
const addArea = async (dom, doc, area) => {
  const select = chainBox(doc).querySelector('.hchain-add select');
  assert.ok(await waitFor(() => [...select.options].some(option => option.value === area)), `the add list has ${area}`);
  select.value = area;
  chainBox(doc).querySelector('.hchain-add button').click();
};
const press = (doc, index, selector) => cards(doc)[index].querySelector(selector).click();

ui('chain editor: the route is a remembered fold under the hunt section; the add list only has areas with records, by name', async () => {
  const { doc } = await boot(chainStore());
  try {
    const fold = doc.getElementById('fold-hunt-chain');
    assert.equal(fold.tagName, 'DETAILS');
    assert.ok(doc.getElementById('sec-hunt').contains(fold));
    const select = chainBox(doc).querySelector('.hchain-add select');
    assert.ok(await waitFor(() => select.options.length > 1));
    const texts = [...select.options].map(option => option.textContent);
    assert.ok(texts.includes('測試區（t）') && texts.includes('第二區（u）'), texts.slice(0, 5).join('、'));
    assert.ok(![...select.options].some(option => option.value === 'zz'), 'no area without a record');
    assert.equal(cards(doc).length, 0);
  } finally {
    doc.defaultView.close();
  }
});

ui('chain editor: adding, moving and removing areas saves the route, and each move command stays with its pair of areas', async () => {
  const { dom, doc, store } = await boot(chainStore());
  try {
    await addArea(dom, doc, 't');
    await addArea(dom, doc, 'u');
    assert.ok(await waitFor(() => store.mapHuntChain?.areas?.length === 2));
    assert.deepEqual(store.mapHuntChain, { areas: [{ area: 't', sortReturn: '' }, { area: 'u', sortReturn: '' }], moves: [''], back: '' });
    assert.equal(cards(doc)[0].querySelector('.hcard-name').textContent, '測試區（t）');
    assert.equal(doc.querySelector('#fold-hunt-chain > summary').textContent, '跨區路線：測試區 → 第二區 → ↺ 測試區', 'the fold title spells out the route');
    assert.ok(chainBox(doc).querySelector('.hchain-route').classList.contains('loop'), 'two areas draw the loop back to the first');
    change(dom, chainBox(doc).querySelector('.hmove'), 'go-u');
    change(dom, chainBox(doc).querySelector('.hback'), 'go-t');
    change(dom, cards(doc)[1].querySelector('.hsort'), 'back-u');
    assert.ok(await waitFor(() => store.mapHuntChain.back === 'go-t' && store.mapHuntChain.areas[1].sortReturn === 'back-u'));
    assert.deepEqual(store.mapHuntChain.moves, ['go-u']);
    // u 往上移：u→t 這一段就是原本回到第一區的 go-t，回到第一區（t→u）就是原本的 go-u；整理回程指令跟著區走
    press(doc, 1, '.hup');
    assert.ok(await waitFor(() => store.mapHuntChain.areas[0].area === 'u'));
    assert.deepEqual(store.mapHuntChain, { areas: [{ area: 'u', sortReturn: 'back-u' }, { area: 't', sortReturn: '' }], moves: ['go-t'], back: 'go-u' });
    assert.equal(chainBox(doc).querySelector('.hmove').value, 'go-t', 'the page shows the moved command');
    press(doc, 0, '.hdown');
    assert.ok(await waitFor(() => store.mapHuntChain.areas[0].area === 't'));
    assert.deepEqual(store.mapHuntChain.moves, ['go-u']);
    press(doc, 1, '.hdel');
    assert.ok(await waitFor(() => store.mapHuntChain.areas.length === 1));
    assert.deepEqual(store.mapHuntChain, { areas: [{ area: 't', sortReturn: '' }], moves: [], back: '' });
    assert.equal(cards(doc).length, 1);
    const select = chainBox(doc).querySelector('.hchain-add select');
    assert.ok(![...select.options].some(option => option.value === 't'), 'an area already in the route is not offered again');
  } finally {
    dom.window.close();
  }
});

ui('chain editor: a card lists every monster collected in its area, and ticking one writes the same picks the panel uses', async () => {
  const { dom, doc, store } = await boot(chainStore({ mapHuntPicks: { u: [MOB_T] }, mapHuntChain: { areas: [{ area: 't' }, { area: 'u' }], moves: ['go-u'], back: 'go-t' } }));
  try {
    assert.ok(await waitFor(() => cards(doc).length === 2));
    const boxes = [...cards(doc)[1].querySelectorAll('input[data-mob]')];
    assert.deepEqual(boxes.map(box => box.dataset.mob), [MOB_U, MOB_T].sort((a, b) => a.localeCompare(b)));
    assert.deepEqual(boxes.map(box => box.checked), boxes.map(box => box.dataset.mob === MOB_T), 'the stored picks are shown');
    const other = boxes.find(box => box.dataset.mob === MOB_U);
    other.checked = true;
    other.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.ok(await waitFor(() => store.mapHuntPicks.u?.length === 2));
    assert.deepEqual([...store.mapHuntPicks.u].sort(), [MOB_U, MOB_T].sort());
  } finally {
    dom.window.close();
  }
});

ui('chain editor: empty move commands and a card whose picks have no room in that area are marked amber', async () => {
  const { doc } = await boot(chainStore({ mapHuntPicks: { t: ['不在這裡的怪(gone)'] }, mapHuntChain: { areas: [{ area: 't' }, { area: 'u' }], moves: [''], back: 'go-t' } }));
  try {
    assert.ok(await waitFor(() => cards(doc).length === 2));
    assert.ok(chainBox(doc).querySelector('.hmove').classList.contains('hmissing'), 'the empty move is amber');
    assert.ok(!chainBox(doc).querySelector('.hback').classList.contains('hmissing'), 'a filled one is not');
    const warn = cards(doc)[0].querySelector('.hcard-warn');
    assert.ok(warn && !warn.hidden && warn.classList.contains('msg-warn'), 'the card with a pick that has no room is warned');
    assert.match(warn.textContent, /到了會略過（開補掃就會先掃）/);
    assert.ok(cards(doc)[1].querySelector('.hcard-warn').hidden, 'a card with nothing ticked is not warned');
  } finally {
    doc.defaultView.close();
  }
});

ui('chain editor: a pick no longer collected in its area still has a box, so the warning can be cleared; ticking keeps the other areas\' picks', async () => {
  const { dom, doc, store } = await boot(chainStore({ mapHuntPicks: { t: ['不在這裡的怪(gone)'] }, mapHuntChain: { areas: [{ area: 't' }, { area: 'u' }], moves: ['go-u'], back: 'go-t' } }));
  try {
    assert.ok(await waitFor(() => cards(doc).length === 2));
    const stale = cards(doc)[0].querySelector('input[data-mob="不在這裡的怪(gone)"]');
    assert.ok(stale?.checked, 'the stale pick is listed and ticked');
    store.mapHuntPicks = { ...store.mapHuntPicks, v: ['別區的怪(x)'] }; // 遊戲頁剛存了別區的勾選
    stale.checked = false;
    stale.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.ok(await waitFor(() => store.mapHuntPicks.t?.length === 0));
    assert.ok(cards(doc)[0].querySelector('.hcard-warn').hidden, 'the warning is gone');
    assert.deepEqual(store.mapHuntPicks.v, ['別區的怪(x)'], 'the other area is kept');
  } finally {
    dom.window.close();
  }
});

ui('chain editor: typing a move command and then clicking a button both take effect', async () => {
  const { dom, doc, store } = await boot(chainStore({ mapHuntChain: { areas: [{ area: 't' }, { area: 'u' }], moves: [''], back: 'go-t' } }));
  try {
    assert.ok(await waitFor(() => cards(doc).length === 2));
    const move = chainBox(doc).querySelector('.hmove');
    const down = cards(doc)[0].querySelector('.hdown');
    change(dom, move, 'go-u');
    assert.ok(down.isConnected, 'saving a typed command does not redraw the buttons');
    down.click();
    assert.ok(await waitFor(() => store.mapHuntChain.areas[0].area === 'u'));
    assert.deepEqual(store.mapHuntChain.moves, ['go-t'], 'the typed command was kept with its pair: t→u is now the way back');
    assert.equal(store.mapHuntChain.back, 'go-u');
  } finally {
    dom.window.close();
  }
});

ui('chain editor: a broken stored route shows as no route, without errors', async () => {
  const errors = [];
  const { doc } = await boot(chainStore({ mapHuntChain: 'broken' }));
  try {
    doc.defaultView.addEventListener('error', event => errors.push(event.message));
    assert.ok(await waitFor(() => chainBox(doc).querySelector('.hchain-add select')?.options.length > 1));
    assert.equal(cards(doc).length, 0);
    assert.deepEqual(errors, []);
  } finally {
    doc.defaultView.close();
  }
});

// ---- 跨區路線的試跑（hunt-chain 06）：設定頁的按鈕與箭頭上的結果 ----
ui('chain trial: each arrow shows its stored trial result in the right colour, and a changed command reads as not tried', async () => {
  const trial = [{ command: 'go-u', from: 't', to: 'u', ok: true, ms: 4200, at: 1 }, { command: 'go-t', from: 'u', to: 't', ok: false, why: '沒有走到 t', where: 'u/p', at: 2 }];
  const { dom, doc } = await boot(chainStore({ mapHuntChain: { areas: [{ area: 't' }, { area: 'u' }], moves: ['go-u'], back: 'go-t' }, mapHuntChainTrial: trial }));
  try {
    assert.ok(await waitFor(() => chainBox(doc).querySelectorAll('.htrial-result').length === 2));
    const [move, back] = chainBox(doc).querySelectorAll('.htrial-result');
    assert.equal(move.textContent, '試跑成功，4.2 秒');
    assert.ok(!move.classList.contains('msg-error') && !move.classList.contains('msg-warn'), 'a success is not coloured');
    assert.match(back.textContent, /試跑失敗：沒有走到 t（當時在 u\/p）/);
    assert.ok(back.classList.contains('msg-error'));
    change(dom, chainBox(doc).querySelector('.hmove'), 'go-u2');
    assert.equal(move.textContent, '沒試跑', 'the result of an old command no longer counts');
    assert.ok(move.classList.contains('msg-warn'));
  } finally {
    dom.window.close();
  }
});

ui('chain trial: the button asks the game page to run it, says why when refused, and is disabled while the hunt runs', async () => {
  let huntOn = false;
  let refuse = false;
  const asked = [];
  const game = message => {
    if (message.type === 'HUNT_CHAIN_TRIAL') { asked.push(message); return refuse ? { ok: false, error: '試跑要從第一區（t）開始，目前在 u/p，請先走到第一區' } : { ok: true }; }
    if (message.type === 'STATUS') return { hunt: { on: huntOn } };
    return {};
  };
  const { dom, doc } = await boot(chainStore({ mapHuntChain: { areas: [{ area: 't' }, { area: 'u' }], moves: ['go-u'], back: 'go-t' } }), { game });
  try {
    const button = doc.getElementById('huntChainTrial');
    const message = doc.getElementById('huntChainTrialMsg');
    assert.ok(await waitFor(() => !button.disabled));
    button.click();
    assert.ok(await waitFor(() => /試跑開始/.test(message.textContent)), message.textContent);
    assert.equal(asked.length, 1);
    assert.ok(button.disabled, 'stays disabled once the trial started');
    assert.ok(await waitFor(() => !button.disabled, 3000), 'and comes back when the status says nothing runs');
    refuse = true;
    button.click();
    assert.ok(await waitFor(() => /從第一區（t）開始/.test(message.textContent)), message.textContent);
    assert.ok(message.classList.contains('msg-error'));
    huntOn = true;
    assert.ok(await waitFor(() => button.disabled, 3000), 'disabled while the hunt or a trial runs');
    huntOn = false;
    assert.ok(await waitFor(() => !button.disabled, 3000));
  } finally {
    dom.window.close();
  }
});

ui('load interval: the every-N-rooms range and the safety line sit with the load limit, default 3-6 and 80, are tidied when saved, and hide without a load check', async () => {
  const { dom, doc, store } = await boot({ mapHuntSettings: { homeCommand: 'ride' } });
  try {
    assert.equal(field(doc, 'loadCheckEveryMin').value, '3');
    assert.equal(field(doc, 'loadCheckEveryMax').value, '6');
    assert.equal(field(doc, 'loadAlwaysPercent').value, '80');
    change(dom, field(doc, 'loadCheckEveryMin'), '5');
    change(dom, field(doc, 'loadCheckEveryMax'), '2');
    assert.ok(await waitFor(() => store.mapHuntSettings?.loadCheckEveryMin === 5));
    assert.equal(store.mapHuntSettings.loadCheckEveryMax, 5, 'a max under the min is raised to the min');
    change(dom, field(doc, 'loadMaxPercent'), '0');
    ['loadCheckEveryMin', 'loadCheckEveryMax', 'loadAlwaysPercent'].forEach(key => assert.equal(cellOf(doc, key).hidden, true, key));
  } finally {
    dom.window.close();
  }
});

ui('ride rooms: the home command and the trip command say that a recorded ride room is walked to first', async () => {
  const { dom, doc } = await boot({ mapHuntSettings: { homeCommand: 'ride', loadMaxPercent: 90 } });
  try {
    assert.match(cellOf(doc, 'homeCommand').textContent, /可 ride.*危險線/);
    assert.match(cellOf(doc, 'tripCommand').textContent, /可 ride/);
  } finally {
    dom.window.close();
  }
});

ui('long fields carry the full-row marker for the wide settings page, short ones do not', async () => {
  const { dom, doc } = await boot();
  try {
    const long = ['homeCommand', 'afterKillCommand', 'npcWhitelist', 'ginCommand', 'fightMode', 'timeSource'];
    const short = ['eatBelow', 'fightTimeoutSec', 'ginBelow', 'learnExits', 'healMode', 'loopRounds'];
    long.forEach(key => assert.ok(cellOf(doc, key).classList.contains('hlong'), `${key} spans the full row`));
    short.forEach(key => assert.ok(!cellOf(doc, key).classList.contains('hlong'), `${key} shares a row`));
    assert.ok(cellOf(doc, 'ginBelow').closest('.hrow'), 'a pair stays inside its row');
    assert.ok(cellOf(doc, 'homeCommand').closest('.hbody'), 'fields live in the group body');
  } finally {
    dom.window.close();
  }
});

ui('profile: the manual-record fold shows what has been accumulated, and clear empties it only after the confirm', async () => {
  const { dom, doc, store } = await boot({ mapHuntProfile: { segments: 3, commands: 120, rooms: 14, stops: 6, downs: 9, walkGaps: [900, 1100] } });
  try {
    const fold = doc.getElementById('fold-hunt-profile');
    assert.equal(fold.tagName, 'DETAILS');
    assert.ok(doc.getElementById('sec-hunt').contains(fold));
    assert.ok(doc.getElementById('huntFields').compareDocumentPosition(fold) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'after the fields');
    const info = doc.getElementById('huntProfileInfo');
    assert.ok(await waitFor(() => /累積 120 個指令/.test(info.textContent)), info.textContent);
    assert.match(info.textContent, /來自 3 段紀錄（進房 14 間、停下來的房間 6 間、倒下 9 隻）/);
    dom.window.confirm = () => false;
    doc.getElementById('huntProfileClear').click();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(store.mapHuntProfile, 'declining the confirm keeps it');
    dom.window.confirm = () => true;
    doc.getElementById('huntProfileClear').click();
    assert.ok(await waitFor(() => !store.mapHuntProfile), 'cleared');
    assert.ok(await waitFor(() => /還沒有累積的資料/.test(info.textContent)), info.textContent);
  } finally {
    dom.window.close();
  }
});

ui('profile: a broken stored profile shows as nothing accumulated, without errors', async () => {
  const { dom, doc } = await boot({ mapHuntProfile: 'garbage' });
  try {
    assert.ok(await waitFor(() => /還沒有累積的資料/.test(doc.getElementById('huntProfileInfo').textContent)));
  } finally {
    dom.window.close();
  }
});

const tuneProfile = () => ({
  segments: 2, commands: 300, typos: 12, rooms: 30, stops: 20, downs: 12,
  walkGaps: Array.from({ length: 40 }, (_, i) => 700 + i * 20),
  reactGaps: [900, 1000],
  firstAttack: { k: 12 }, knockoutAttack: { k: 3 },
  afterDown: { 'l;gc': 8, gc: 2 },
});
const tuneRow = (doc, text) => [...doc.querySelectorAll('#huntTune tbody tr')].find(tr => tr.cells[1].textContent.includes(text));

ui('tune: the suggestion table shows current, suggested and basis; not-enough rows have no checkbox, equal rows are unchecked', async () => {
  const { dom, doc } = await boot({ mapHuntProfile: tuneProfile(), mapHuntSettings: { killCommand: 'kill' } });
  try {
    assert.ok(await waitFor(() => doc.querySelectorAll('#huntTune tbody tr').length === 9), 'nine rows');
    const gap = tuneRow(doc, '指令間隔');
    assert.ok(gap.querySelector('input[type=checkbox]').checked, 'a different value is checked by default');
    assert.match(gap.cells[2].textContent, /1000～2000/);
    assert.match(gap.cells[4].textContent, /40 個/);
    const react = tuneRow(doc, '看完房間');
    assert.equal(react.querySelector('input'), null, 'not enough data: no checkbox');
    assert.match(react.cells[4].textContent, /資料不夠（還要 13 個）/);
    assert.equal(tuneRow(doc, '打死用的指令').querySelector('input'), null, '3 of 5');
    const fight = tuneRow(doc, '開打用的指令');
    assert.equal(fight.cells[3].textContent, 'k');
    assert.ok(fight.querySelector('input').checked);
    const typo = tuneRow(doc, '打錯字機率');
    assert.equal(typo.cells[3].textContent, '4');
  } finally {
    dom.window.close();
  }
});

ui('tune: applying writes the checked values into the settings and updates the fields; unchecked rows stay', async () => {
  const { dom, doc, store } = await boot({ mapHuntProfile: tuneProfile() });
  try {
    assert.ok(await waitFor(() => doc.querySelectorAll('#huntTune tbody tr').length === 9));
    tuneRow(doc, '打錯字機率').querySelector('input').checked = false;
    doc.getElementById('huntTuneApply').click();
    assert.ok(await waitFor(() => store.mapHuntSettings?.fightCommand === 'k'));
    assert.equal(store.mapHuntSettings.afterKillCommand, 'l;gc');
    assert.equal(store.mapHuntSettings.commandGapMinMs, 900);
    assert.equal(store.mapHuntSettings.commandGapMaxMs, 1300);
    assert.equal(store.mapHuntSettings.typoPercent, 2, 'unchecked row is untouched');
    assert.equal(field(doc, 'fightCommand').value, 'k');
    assert.equal(field(doc, 'afterKillCommand').value, 'l;gc');
    assert.match(doc.getElementById('huntTuneMsg').textContent, /已套用/);
    assert.ok(await waitFor(() => tuneRow(doc, '開打用的指令').cells[4].textContent.startsWith('已相同')), 'recomputed after applying');
    assert.equal(tuneRow(doc, '開打用的指令').querySelector('input').checked, false);
  } finally {
    dom.window.close();
  }
});

ui('tune: applying with nothing checked says so and writes nothing', async () => {
  const { dom, doc, store } = await boot({ mapHuntProfile: tuneProfile() });
  try {
    assert.ok(await waitFor(() => doc.querySelectorAll('#huntTune tbody tr').length === 9));
    doc.querySelectorAll('#huntTune input').forEach(check => { check.checked = false; });
    doc.getElementById('huntTuneApply').click();
    assert.match(doc.getElementById('huntTuneMsg').textContent, /沒有勾選/);
    assert.equal(store.mapHuntSettings, undefined);
  } finally {
    dom.window.close();
  }
});

ui('habit commands: the two fields show only with the human-like switch on, and saving keeps only whitelisted commands with 0-100 percents, deduped, scaled to at most 100 in total', async () => {
  const { dom, doc, store } = await boot();
  try {
    const arrive = cellOf(doc, 'habitAfterArrive');
    const kill = cellOf(doc, 'habitAfterKill');
    assert.ok(doc.getElementById('fold-hunt-human').contains(arrive) && doc.getElementById('fold-hunt-human').contains(kill));
    assert.equal(arrive.hidden, true);
    assert.equal(kill.hidden, true);
    assert.equal(field(doc, 'habitAfterArrive').value, '');
    change(dom, field(doc, 'humanize'), 'on');
    assert.ok(await waitFor(() => !arrive.hidden && !kill.hidden), 'shown with the switch on');
    change(dom, field(doc, 'habitAfterArrive'), ' L 30，hp 10 、 give 50 、 hp 5、edf x、sc 101、i 0、 score 20 ');
    assert.ok(await waitFor(() => store.mapHuntSettings?.habitAfterArrive === 'l 30、hp 10、score 20'), store.mapHuntSettings?.habitAfterArrive);
    assert.equal(field(doc, 'habitAfterArrive').value, 'l 30、hp 10、score 20', 'the canonical text is written back');
    change(dom, field(doc, 'habitAfterKill'), 'l 60、hp 60');
    assert.ok(await waitFor(() => store.mapHuntSettings?.habitAfterKill === 'l 50、hp 50'), 'over 100 in total is scaled down proportionally');
    change(dom, field(doc, 'humanize'), 'off');
    assert.ok(await waitFor(() => arrive.hidden), 'hidden again');
    assert.equal(store.mapHuntSettings.habitAfterArrive, 'l 30、hp 10、score 20', 'the value is kept while hidden');
  } finally {
    dom.window.close();
  }
});

ui('tune: the habit rows are suggested from the profile and applying them writes the canonical text into the fields', async () => {
  const profile = { ...tuneProfile(), stops: 20, downs: 12, habitArrive: { l: 6, hp: 2 }, habitKill: { edf: 6 } };
  const { dom, doc, store } = await boot({ mapHuntProfile: profile });
  try {
    assert.ok(await waitFor(() => doc.querySelectorAll('#huntTune tbody tr').length === 9));
    const arrive = tuneRow(doc, '到房間後的習慣指令');
    assert.equal(arrive.cells[3].textContent, 'l 30、hp 10');
    assert.match(arrive.cells[4].textContent, /20 個停下來的房間/);
    assert.equal(tuneRow(doc, '打完一隻後的習慣指令').cells[3].textContent, 'edf 50');
    doc.querySelectorAll('#huntTune input').forEach(check => { check.checked = false; });
    arrive.querySelector('input').checked = true;
    tuneRow(doc, '打完一隻後的習慣指令').querySelector('input').checked = true;
    doc.getElementById('huntTuneApply').click();
    assert.ok(await waitFor(() => store.mapHuntSettings?.habitAfterArrive === 'l 30、hp 10'));
    assert.equal(store.mapHuntSettings.habitAfterKill, 'edf 50');
    assert.equal(field(doc, 'habitAfterArrive').value, 'l 30、hp 10');
    assert.ok(await waitFor(() => tuneRow(doc, '到房間後的習慣指令').cells[4].textContent.startsWith('已相同')), 'compared as normalized text');
  } finally {
    dom.window.close();
  }
});
