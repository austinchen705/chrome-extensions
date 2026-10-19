// 解析 zap 攻略站的 MOB 表與 catworld 說明站的新手怪列表、合併、套用手動補充檔。
// 不碰網路與檔案，輸入輸出都是字串與物件；由 gen-zap-data.js 呼叫。
//
// Mob：{ name, id, exp, expMin?, expMax?, location, note, source, otherExp? }
// exp 是分級用的強度值：範圍取上限，兩個來源不一致時取較大者；null 表示強度不明。

const normalize = text => String(text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const idOf = name => /\(([^)]*)\)\s*$/.exec(normalize(name))?.[1].trim() ?? '';

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(text) {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&([a-z]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole);
}
const cellText = html => decode(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

function makeMob(fields) {
  const name = fields.name.replace(/\s+/g, ' ').trim();
  return { name, id: idOf(name), location: '', note: '', ...fields, name };
}

function parseZapMobHtml(html) {
  const mobs = [];
  for (const [, rowHtml] of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = Array.from(rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g), match => cellText(match[1]));
    if (cells.length < 4 || !cells[0]) continue;
    const [name, strength, location, note] = cells;
    mobs.push(makeMob({
      name,
      exp: /^\d+$/.test(strength) ? Number(strength) : null,
      location,
      note,
      source: 'zap',
    }));
  }
  return mobs;
}

function parseNewstartHtml(html) {
  const text = decode(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, ''));
  const mobs = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^(.*?\([^)]*\))\s*(\d+(?:~+\d+)?)\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const [, name, value, note] = match;
    const [min, max] = value.split(/~+/).map(Number);
    mobs.push(makeMob({
      name,
      exp: max ?? min,
      ...(max === undefined ? {} : { expMin: min, expMax: max }),
      note: note.trim(),
      source: 'newstart',
    }));
  }
  return mobs;
}

function mergeSources(zap, newstart) {
  const mobs = zap.map(mob => ({ ...mob }));
  const conflicts = [];
  const rowsByKey = new Map();
  mobs.forEach(mob => {
    const key = normalize(mob.name);
    rowsByKey.set(key, [...(rowsByKey.get(key) || []), mob]);
  });
  newstart.forEach(incoming => {
    const rows = rowsByKey.get(normalize(incoming.name));
    if (!rows) {
      mobs.push({ ...incoming });
      return;
    }
    if (incoming.exp === null || rows.some(row => row.exp === incoming.exp)) return;
    const seen = rows.map(row => row.exp ?? '未知').join('、');
    conflicts.push(`${incoming.name}：zap ${seen}／newstart ${incoming.exp}`);
    if (rows.length === 1) {
      const [row] = rows;
      if (row.exp !== null) row.otherExp = [...(row.otherExp || []), Math.min(row.exp, incoming.exp)];
      row.exp = Math.max(row.exp ?? 0, incoming.exp);
    }
  });
  return { mobs, conflicts };
}

function applyOverrides(mobs, overrides) {
  const result = mobs.map(mob => ({ ...mob }));
  const problems = [];
  const notes = [];
  const patch = (mob, override) => {
    if (override.exp !== undefined) mob.exp = override.exp;
    if (override.note !== undefined) mob.note = override.note;
    mob.source = 'override';
  };
  overrides.forEach(override => {
    const matches = result.filter(mob => normalize(mob.name) === normalize(override.name));
    if (override.location) {
      const same = matches.find(mob => normalize(mob.location) === normalize(override.location));
      if (same) patch(same, override);
      else result.push(makeMob({ name: override.name, exp: override.exp ?? null, location: override.location, note: override.note ?? '', source: 'override' }));
      return;
    }
    if (matches.length === 1) patch(matches[0], override);
    else if (!matches.length) {
      // 兩個來源都沒有的怪：視為新增，但列在報告裡，打錯字才看得出來
      result.push(makeMob({ name: override.name, exp: override.exp ?? null, note: override.note ?? '', source: 'override' }));
      notes.push(`補充檔新增（兩個來源都沒有這隻怪）：${override.name}`);
    } else problems.push(`補充檔項目有歧義（該名稱有多隻，請加 location）：${override.name}`);
  });
  return { mobs: result, problems, notes };
}

// ---- 解謎 ----
// 步驟頁的指令混在說明文字裡，所以抽取是保守的：一步只要有任何一段不被認得，整步就不給自動指令，
// 寧可讓使用者自己補，也不要給只有一半的指令送進遊戲。
const VERBS = new Set(('run ask give climb jump ride push kill search open enter squeeze get nod say touch fly apprentice '
  + 'setplace wield unlock pay wear diving dig buy wash write knock exert enforce unwield burying recall put worship insert').split(' '));
const DIRECTION = /^\d*(?:n|s|e|w|u|d|ne|nw|se|sw|nu|nd|su|sd|eu|ed|wu|wd)$/;
const ASCII_PREFIX = /^[A-Za-z0-9 \-_#'.,:+/@<>~=*]*/;

// 只有這些指令的中文引數是真正的引數（其他動詞後面的中文都是說明）；ask 的中文引數只出現在 about 之後
const CJK_ARG_VERBS = new Set(['buy', 'say', 'search', 'push', 'touch']);

// 認得就回傳指令文字，不認得回 null。這一段只要藏著任何可疑的東西（多一個指令、被丟掉的移動、截斷的 ask）就不認得
function recognizeSegment(segment) {
  const head = /^[A-Za-z][A-Za-z0-9-]*/.exec(segment);
  if (!head) return null;
  const verb = head[0].toLowerCase();
  const isDirection = DIRECTION.test(verb);
  if (!VERBS.has(verb) && !isDirection) return null;
  const prefix = ASCII_PREFIX.exec(segment)[0];
  // 「ps.」是註解的開頭，後面都是說明
  const note = /\bps\b\.?/i.exec(prefix);
  let command = note ? prefix.slice(0, note.index) : prefix;
  let consumed = command.length;
  const takesCjk = (verb === 'ask' && /\sabout\s$/i.test(command)) || (CJK_ARG_VERBS.has(verb) && /^[A-Za-z]+\s$/.test(command));
  if (!note && takesCjk) {
    const cjk = /^[\u4e00-\u9fff]+/.exec(segment.slice(consumed));
    if (cjk) {
      command += cjk[0];
      consumed += cjk[0].length;
    }
  }
  // 指令本身裡面又出現別的指令動詞，代表兩個指令黏在一起（例如 run 2se e n give woman letter）
  if (command.trim().split(/\s+/).slice(1).some(token => VERBS.has(token.toLowerCase()))) return null;
  // 後面的說明裡有指令動詞、方向或 about，代表還有東西被丟掉（被截斷的 ask、寫在說明裡的移動），不能只取前半
  const forbidden = word => VERBS.has(word.toLowerCase()) || DIRECTION.test(word) || word.toLowerCase() === 'about';
  if ((segment.slice(consumed).match(/[A-Za-z]+/g) || []).some(forbidden)) return null;
  return command.replace(/[\s\-=>~*.,:<]+$/, '').replace(/\s+/g, ' ');
}

function extractCommands(stepText) {
  const segments = String(stepText ?? '').split(/[;；]/).map(piece => piece.trim()).filter(Boolean);
  const commands = [];
  for (const segment of segments) {
    const command = recognizeSegment(segment);
    if (!command) return '';
    commands.push(command);
  }
  return commands.join(';');
}

function pageLines(html) {
  const stripped = html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(?:br\s*\/?|\/p|\/tr|\/div|\/li)>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  const lines = decode(stripped).replace(/\ufeff/g, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  return lines.filter((line, index) => line !== '回上頁' && !(index === 0 && /^qu[\d-]+$/.test(line)));
}

// 編號步驟（行首「1.」，或帶標籤的「男：1.」）；沒有編號的行接到前一步（硬換行）。
// 第一步之前的文字是 preamble（準備事項、說明）；步驟之間「入古墓：」這類小標題記在下一步的 heading，不接到上一步。
// 沒有編號步驟的頁面 steps 為 []、preamble 為 ''（整頁文字在 text）
const STEP_LINE = /^(?:([^\d\s]{1,3}[：:])\s*)?(\d+)\s*[.．、]\s*(.*)$/;
const HEADING_LINE = /^[^\d\s][^：:]{0,18}[：:]$/;

function parseRiddlePage(html) {
  const lines = pageLines(html);
  const raw = [];
  let firstStepLine = -1;
  let pendingHeading = '';
  lines.forEach((line, index) => {
    const match = STEP_LINE.exec(line);
    if (match) {
      if (firstStepLine < 0) firstStepLine = index;
      raw.push({ no: Number(match[2]), heading: [pendingHeading, match[1]].filter(Boolean).join(' '), parts: [match[3]] });
      pendingHeading = '';
    } else if (raw.length && HEADING_LINE.test(line)) {
      pendingHeading = line;
    } else if (raw.length) {
      raw[raw.length - 1].parts.push(line);
    }
  });
  const steps = raw.map(({ no, heading, parts }) => {
    const text = parts.join(' ').replace(/\s+/g, ' ').trim();
    return { no, text, commands: extractCommands(text), ...(heading ? { heading } : {}) };
  });
  return { steps, preamble: firstStepLine < 0 ? '' : lines.slice(0, firstStepLine).join('\n'), text: lines.join('\n') };
}

// 總表（qu1.htm）沒有連結，名稱也和選單（list.html）不完全一致；對應順序：名稱相同 → 別名表 → 正規化後相同或互相包含
const RIDDLE_ALIASES = {
  鞭子製作: '鞭子制作',
  唐伯虎的困擾: '新手裝備',
  靈鷲宮的委託: '冰翼無痕',
  白駝山莊的毒物: '心瓣項鍊',
  瑛姑的困擾: '天罡鬥服',
  燕子鄔: '水漾之繞',
};
const riddleNorm = text => String(text ?? '').replace(/[\s[\]（）()-]|習得|之謎|的|秘寶|寶/g, '');

function parseRiddleIndex(html) {
  const rows = [];
  let category = '';
  for (const [, rowHtml] of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = Array.from(rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g), match => cellText(match[1]));
    const filled = cells.filter(Boolean);
    if (filled.length === 1 && /類$/.test(filled[0])) category = filled[0];
    else if (cells.length >= 5 && cells[0] && cells[0] !== '名稱') {
      const [name, condition, hint, difficulty, reward] = cells;
      rows.push({ category, name, condition, hint, difficulty, reward });
    }
  }
  return rows;
}

function parseRiddleMenu(html) {
  const entries = [];
  let category = '';
  for (const match of html.matchAll(/<span class="t1">([^<]+)<\/span>|href="(qu[\d-]+\.htm)"[^>]*>([^<]+)/g)) {
    if (match[1]) category = match[1].trim();
    else if (match[2] !== 'qu1.htm') entries.push({ category, file: match[2], name: match[3].trim() });
  }
  return entries;
}

function matchMenu(name, menu) {
  const alias = RIDDLE_ALIASES[name];
  return menu.find(entry => entry.name === name)
    || (alias && menu.find(entry => entry.name === alias))
    || menu.find(entry => riddleNorm(entry.name) === riddleNorm(name))
    || menu.find(entry => riddleNorm(entry.name).includes(riddleNorm(name)) || riddleNorm(name).includes(riddleNorm(entry.name)))
    || null;
}

function buildRiddles({ indexHtml, menuHtml, pageHtml }) {
  const menu = parseRiddleMenu(menuHtml);
  const report = [];
  const used = new Set();
  const riddles = parseRiddleIndex(indexHtml).map(entry => {
    const found = matchMenu(entry.name, menu);
    if (found) used.add(found);
    else report.push(`總表有、選單沒有：${entry.name}`);
    return { id: `${entry.category}/${entry.name}`, ...entry, page: found ? found.file : null, shared: [] };
  });
  riddles.forEach(riddle => {
    if (riddle.page) riddle.shared = riddles.filter(other => other !== riddle && other.page === riddle.page).map(other => other.name);
  });
  menu.filter(entry => !used.has(entry)).forEach(entry => report.push(`選單有、沒被使用：${entry.name}（${entry.file}）`));
  const pages = {};
  for (const file of new Set(riddles.map(riddle => riddle.page).filter(Boolean))) {
    if (pageHtml[file] === undefined) report.push(`沒有 HTML：${file}`);
    else pages[file] = parseRiddlePage(pageHtml[file]);
  }
  return { riddles, pages, report };
}

// 遊戲說明站的「總路徑」（help/map.15）：每個地點一行「│ 地名 路徑 │ NPC │」，路徑都以新長安門口為起點
// （從醉仙樓出發要先走 run e 5n 2o）。路徑後面若跟「謎」代表那裡有謎，不是路徑的一部分
const ROUTES_URL = 'https://catworld.muds.tw/help/map.15';
function parseRoutesHtml(html) {
  const routes = [];
  const text = decode(String(html ?? '').replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, ''));
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*│\s+(\S+)\s+([^│]*?)\s*│\s*([^│]*?)\s*│?\s*$/.exec(line);
    if (!match || match[1].includes('﹕') || match[1].includes('map.')) continue;
    const tokens = match[2].split(/\s+/);
    const pathTokens = [];
    for (const token of tokens) {
      if (!/^[0-9a-z]+$/i.test(token)) break;
      pathTokens.push(token);
    }
    if (!pathTokens.length) continue;
    routes.push({ name: match[1], path: pathTokens.join(' '), npc: match[3].trim(), riddle: match[2].includes('謎') });
  }
  return routes;
}

const SOURCES = ['https://zap.muds.me/ot1.htm', 'https://catworld.muds.tw/help/newstart.3'];
const UB_URL = 'https://zap.muds.me/ub.htm';
const RIDDLE_URL = 'https://zap.muds.me/qu1.htm';

// 無名物品表 ub.htm：三張表，LV 在帶 rowspan 的儲存格（往下列沿用）。
// 第 1 張：LV 之後每格都是純名稱（販賣品，無功能）；第 2 張：名稱、功能（鑄模與材料）；第 3 張：名稱、武器效果、防具效果（寶石）
function weaponOf(name, note) {
  if (name.includes('劍鑄模')) return '劍';
  if (name.includes('刀鑄模')) return '刀';
  if (name.includes('杖鑄模')) return '杖';
  if (name.includes('鏢鑄模')) return '暗器';
  return /鞭/.test(`${name}${note}`) ? '鞭' : '';
}

// 補充檔裡帶 item 欄位的項目：有同名物品就覆蓋 level／note／weapon；沒有就新增（要有 level）
const WEAPON_TYPES = ['劍', '刀', '杖', '鞭', '拳套', '暗器']; // 與 zap-items.js 的 WEAPON_TYPES 一致
const compact = text => normalize(text).replace(/\s/g, '');

function applyItemOverrides(items, overrides) {
  const result = items.map(item => ({ ...item }));
  const problems = [];
  overrides.forEach(override => {
    if (override.weapon !== undefined && override.weapon !== '' && !WEAPON_TYPES.includes(override.weapon)) {
      problems.push(`補充檔物品的 weapon 不合法：${override.item}（${override.weapon}）`);
      return;
    }
    const found = result.find(item => compact(item.name) === compact(override.item));
    if (found) {
      ['level', 'note', 'weapon'].forEach(field => { if (override[field] !== undefined) found[field] = override[field]; });
    } else if (Number.isInteger(override.level) && override.level >= 1 && override.level <= 5) {
      result.push({ name: override.item, level: override.level, note: override.note ?? '', weapon: override.weapon ?? '' });
    } else {
      problems.push(`補充檔物品找不到對應項目，也沒有 level 可以新增：${override.item}`);
    }
  });
  return { items: result, problems };
}

function parseUnknownObjectHtml(html) {
  const items = [];
  html.split(/<table/i).slice(1).forEach((tableHtml, tableIndex) => {
    let level = null;
    for (const [, rowHtml] of tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = Array.from(rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g), match => cellText(match[1]));
      if (cells.some(text => /等級|物品名稱|功能|鑲於/.test(text))) continue;
      const levelMatch = /^LV\s*(\d)$/.exec(cells[0] ?? '');
      if (levelMatch) level = Number(levelMatch[1]);
      const rest = levelMatch ? cells.slice(1) : cells;
      if (level === null) continue;
      const entries = tableIndex === 0
        ? rest.filter(Boolean).map(name => ({ name, note: '' }))
        : [{
          name: rest[0],
          note: tableIndex === 1
            ? rest[1] ?? ''
            : [rest[1] && `武器：${rest[1]}`, rest[2] && `防具：${rest[2]}`].filter(Boolean).join('　'),
        }];
      entries.filter(entry => entry.name).forEach(({ name, note }) => items.push({ name, level, note, weapon: weaponOf(name, note) }));
    }
  });
  return items;
}

// 來源改版時解析結果會突然變少，這時寧可失敗也不要產生一份殘缺的資料
function buildData({ zapHtml, newstartHtml, overrides, ubHtml, riddleHtml, routesHtml }, { minZap = 100, minNewstart = 20, minItems = 30, minRiddles = 40, minPages = 30, minRoutes = 30 } = {}) {
  const zap = parseZapMobHtml(zapHtml);
  const newstart = parseNewstartHtml(newstartHtml);
  if (zap.length < minZap || newstart.length < minNewstart) {
    throw new Error(`來源解析異常：zap ${zap.length} 筆（至少 ${minZap}）、newstart ${newstart.length} 筆（至少 ${minNewstart}）`);
  }
  const items = ubHtml === undefined ? [] : parseUnknownObjectHtml(ubHtml);
  if (ubHtml !== undefined && items.length < minItems) {
    throw new Error(`來源解析異常：無名物品表 ${items.length} 筆（至少 ${minItems}）`);
  }
  const merged = mergeSources(zap, newstart);
  const riddleData = riddleHtml === undefined ? null : buildRiddles(riddleHtml);
  if (riddleData && riddleData.riddles.length < minRiddles) {
    throw new Error(`來源解析異常：解謎總表 ${riddleData.riddles.length} 個（至少 ${minRiddles}）`);
  }
  if (riddleData && Object.keys(riddleData.pages).length < minPages) {
    throw new Error(`來源解析異常：解謎步驟頁 ${Object.keys(riddleData.pages).length} 頁（至少 ${minPages}）`);
  }
  const routes = routesHtml === undefined ? null : parseRoutesHtml(routesHtml);
  if (routes && routes.length < minRoutes) {
    throw new Error(`來源解析異常：總路徑 ${routes.length} 個地點（至少 ${minRoutes}）`);
  }
  const mobOverrides = overrides.filter(override => !('item' in override));
  const itemOverrides = overrides.filter(override => 'item' in override);
  const { mobs, problems: mobProblems, notes } = applyOverrides(merged.mobs, mobOverrides);
  const applied = applyItemOverrides(items, itemOverrides);
  const problems = [...mobProblems, ...applied.problems];
  const unknown = mobs.filter(mob => mob.exp === null);
  const report = [
    `zap ${zap.length} 筆、newstart ${newstart.length} 筆、合併後 ${mobs.length} 筆、無名物品 ${items.length} 筆`,
    ...merged.conflicts.map(line => `數值差異：${line}`),
    ...unknown.map(mob => `強度不明：${mob.name}（${mob.location}）`),
    ...notes,
    ...(riddleData ? [`謎 ${riddleData.riddles.length} 個、步驟頁 ${Object.keys(riddleData.pages).length} 頁`, ...riddleData.report] : []),
    ...(routes ? [`總路徑 ${routes.length} 個地點`] : []),
  ];
  const sources = [...SOURCES, ...(ubHtml === undefined ? [] : [UB_URL]), ...(riddleData ? [RIDDLE_URL] : []), ...(routes ? [ROUTES_URL] : [])];
  return {
    data: {
      sources,
      mobs,
      ...(ubHtml === undefined ? {} : { items: applied.items }),
      ...(riddleData ? { riddles: riddleData.riddles, pages: riddleData.pages } : {}),
      ...(routes ? { routes } : {}),
    },
    report,
    problems,
  };
}

module.exports = {
  normalize, parseZapMobHtml, parseNewstartHtml, parseUnknownObjectHtml, applyItemOverrides, mergeSources, applyOverrides, buildData, SOURCES, UB_URL,
  VERBS, extractCommands, parseRiddlePage, parseRiddleIndex, parseRiddleMenu, buildRiddles, RIDDLE_ALIASES, parseRoutesHtml, ROUTES_URL,
};
