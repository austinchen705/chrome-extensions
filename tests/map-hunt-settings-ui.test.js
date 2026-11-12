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

const root = path.join(__dirname, '..', 'catworld-auto-command');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (condition, ms = 3000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (condition()) return true;
    await sleep(5);
  }
  return condition();
};

async function boot(store = {}) {
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
        tabs: { query: async () => [], get: async () => { throw new Error('no tab'); }, sendMessage: async () => { throw new Error('no tab'); }, create: async () => {}, update: async () => {} },
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

ui('what follows the fight command is a select in the fight fold: the ID by default, or the position, which the fold title then mentions and the hint explains', async () => {
  const { dom, doc, store } = await boot();
  try {
    assert.ok(doc.getElementById('fold-hunt-fight').contains(field(doc, 'targetForm')));
    assert.equal(field(doc, 'targetForm').value, 'id');
    const title = () => doc.querySelector('#fold-hunt-fight > summary').textContent;
    assert.doesNotMatch(title(), /順位/);
    assert.match(cellOf(doc, 'targetForm').textContent, /fight NPC/, 'the hint says how the game counts and which form is safer');
    change(dom, field(doc, 'targetForm'), 'position');
    assert.ok(await waitFor(() => store.mapHuntSettings?.targetForm === 'position'));
    assert.match(title(), /接順位/);
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

ui('the rest return command shows only with the switch on, is marked (but does not block starting) while empty, and is saved', async () => {
  const { dom, doc, store } = await boot({ mapHuntSettings: { humanize: 'on' } });
  try {
    const cell = cellOf(doc, 'restReturnCommand');
    assert.equal(cell.hidden, false);
    assert.ok(cell.classList.contains('hmissing'), 'marked while it is empty');
    const title = () => doc.querySelector('#fold-hunt-human > summary').textContent;
    assert.match(title(), /沒填回程指令，不會掛機休息/);
    assert.doesNotMatch(title(), /有必填的沒填/, 'it only turns the rest off, so it is not a field that must be filled to start');
    change(dom, field(doc, 'restReturnCommand'), '@巨集 5');
    assert.ok(await waitFor(() => store.mapHuntSettings?.restReturnCommand === '@巨集 5'));
    assert.equal(cell.classList.contains('hmissing'), false);
    assert.doesNotMatch(title(), /沒填回程指令/);
    change(dom, field(doc, 'restReturnCommand'), '');
    assert.ok(await waitFor(() => cell.classList.contains('hmissing')));
    change(dom, field(doc, 'loopRounds'), 'off');
    assert.ok(await waitFor(() => !cell.classList.contains('hmissing')), 'not marked when waiting for the next respawn is off: it can never rest then');
    change(dom, field(doc, 'restReturnCommand'), '@巨集 5');
    assert.ok(await waitFor(() => store.mapHuntSettings?.restReturnCommand === '@巨集 5'));
    change(dom, field(doc, 'humanize'), 'off');
    assert.ok(await waitFor(() => cell.hidden === true), 'hidden again when the switch is off');
    assert.equal(store.mapHuntSettings.restReturnCommand, '@巨集 5', 'but kept');
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

ui('the fields are split into closed folds whose titles carry the main values', async () => {
  const { dom, doc } = await boot({ mapHuntSettings: { eatCommand: 'tn', homeCommand: 'ride', specialCommand: 'ps' } });
  try {
    const folds = [...doc.querySelectorAll('#huntFields > details.fold')];
    assert.deepEqual(folds.map(box => box.id), ['fold-hunt-move', 'fold-hunt-fight', 'fold-hunt-special', 'fold-hunt-heal', 'fold-hunt-sort', 'fold-hunt-rounds', 'fold-hunt-human', 'fold-hunt-advanced']);
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
