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

// 認得就回傳指令文字，不認得回 null
function recognizeSegment(segment) {
  const head = /^[A-Za-z][A-Za-z0-9-]*/.exec(segment);
  if (!head) return null;
  const verb = head[0].toLowerCase();
  const isDirection = DIRECTION.test(verb);
  if (!VERBS.has(verb) && !isDirection) return null;
  let command = ASCII_PREFIX.exec(segment)[0];
  let consumed = command.length;
  // 會帶中文引數的指令（ask X about 令狐沖、buy 牛皮酒袋、say 是）；run 與方向後面的中文是說明
  if (verb !== 'run' && !isDirection && /\s$/.test(command)) {
    const cjk = /^[\u4e00-\u9fff]+/.exec(segment.slice(consumed));
    if (cjk) {
      command += cjk[0];
      consumed += cjk[0].length;
    }
  }
  // 後面的說明裡還有別的指令動詞，代表這一段不只一個指令，不能只取前半
  if ((segment.slice(consumed).match(/[A-Za-z]+/g) || []).some(word => VERBS.has(word.toLowerCase()))) return null;
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

// 編號步驟（行首「1.」）；沒有編號的行接到前一步（硬換行），沒有編號步驟的頁面 steps 為 []
function parseRiddlePage(html) {
  const lines = pageLines(html);
  const raw = [];
  for (const line of lines) {
    const match = /^(\d+)\s*[.．、]\s*(.*)$/.exec(line);
    if (match) raw.push({ no: Number(match[1]), parts: [match[2]] });
    else if (raw.length) raw[raw.length - 1].parts.push(line);
  }
  const steps = raw.map(({ no, parts }) => {
    const text = parts.join(' ').replace(/\s+/g, ' ').trim();
    return { no, text, commands: extractCommands(text) };
  });
  return { steps, text: lines.join('\n') };
}

const SOURCES = ['https://zap.muds.me/ot1.htm', 'https://catworld.muds.tw/help/newstart.3'];
const UB_URL = 'https://zap.muds.me/ub.htm';

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
function buildData({ zapHtml, newstartHtml, overrides, ubHtml }, { minZap = 100, minNewstart = 20, minItems = 30 } = {}) {
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
  ];
  const sources = ubHtml === undefined ? SOURCES : [...SOURCES, UB_URL];
  return { data: { sources, mobs, ...(ubHtml === undefined ? {} : { items: applied.items }) }, report, problems };
}

module.exports = {
  normalize, parseZapMobHtml, parseNewstartHtml, parseUnknownObjectHtml, applyItemOverrides, mergeSources, applyOverrides, buildData, SOURCES, UB_URL,
  VERBS, extractCommands, parseRiddlePage,
};
