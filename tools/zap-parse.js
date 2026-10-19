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
    else problems.push(`補充檔項目${matches.length ? '有歧義（該名稱有多隻，請加 location）' : '找不到對應的怪'}：${override.name}`);
  });
  return { mobs: result, problems };
}

module.exports = { normalize, parseZapMobHtml, parseNewstartHtml, mergeSources, applyOverrides };
