// 把 docs/data/mentors.tsv（試算表「最高功法導師」與「功法配合表」兩個分頁整理出來的導師資料）轉成 catworld-auto-command/mentor-data.js，
// 當作內建的拜師導師資料（mentor-search.js 分組與搜尋）。
// 用法：node tools/gen-mentor-data.js；不要手改產生的檔案，改 TSV 再重新產生。
// TSV 欄位：導師、功法、路線（原文）、類別、最高等級、配合心法、來源（最高＝最高功法導師分頁，配合＝功法配合表分頁）。
// 導師欄用 / 分隔多位導師時拆成各自一列、共用同一條路線；同一位導師的同一個功法兩個分頁都有時，路線、類別、配合心法以「配合」為準，最高等級取「最高」的。
const fs = require('fs');
const path = require('path');

const MIN_ROWS = 30;
const COLUMNS = 7;
const flat = text => text.replace(/\s+/g, ' ').trim();

function build(text, { minRows = MIN_ROWS } = {}) {
  const lines = text.split('\n').filter(Boolean).slice(1);
  const merged = new Map();
  const report = { conflicts: [] };
  lines.forEach((line, i) => {
    const cells = line.split('\t');
    if (cells.length !== COLUMNS) throw new Error(`第 ${i + 2} 列欄位數不對（要 ${COLUMNS} 欄）：${line}`);
    const [mentors, skill, route, category, maxLevel, heart, source] = cells.map(flat);
    if (!mentors || !skill || !route || !['最高', '配合'].includes(source)) throw new Error(`第 ${i + 2} 列格式不對：${line}`);
    mentors.split('/').map(flat).filter(Boolean).forEach(mentor => {
      const key = `${mentor}\u0000${skill}`;
      const row = { mentor, skill, route, category, maxLevel, heart };
      const old = merged.get(key);
      if (!old) {
        merged.set(key, { ...row, source });
        return;
      }
      if (old.source === source) throw new Error(`第 ${i + 2} 列：${mentor} 的 ${skill} 在同一個分頁重複出現`);
      const [high, match] = source === '最高' ? [row, old] : [old, row];
      if (high.route !== match.route) report.conflicts.push({ mentor, skill, 最高: high.route, 配合: match.route });
      merged.set(key, { ...match, maxLevel: high.maxLevel, source: '兩者' });
    });
  });
  const rows = [...merged.values()].map(({ mentor, skill, route, category, maxLevel, heart }) => [mentor, skill, route, category, maxLevel, heart]);
  if (rows.length < minRows) throw new Error(`只解析出 ${rows.length} 列，資料檔可能壞了，不覆寫`);
  return { rows, report };
}

function render(rows) {
  return `// 由 tools/gen-mentor-data.js 從 docs/data/mentors.tsv 產生，不要手改。每列：[導師, 功法, 路線（原文）, 類別, 最高等級, 配合心法]
globalThis.CatworldMentorData = [
${rows.map(row => '  ' + JSON.stringify(row)).join(',\n')},
];
`;
}

module.exports = { build, render };

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const { rows, report } = build(fs.readFileSync(path.join(root, 'docs/data/mentors.tsv'), 'utf8'));
  fs.writeFileSync(path.join(root, 'catworld-auto-command/mentor-data.js'), render(rows));
  console.log(`mentor-data.js：${rows.length} 列（導師與功法）`);
  report.conflicts.forEach(c => console.log(`兩個分頁路線不同：${c.mentor} ${c.skill}\n  最高：${c.最高}\n  配合：${c.配合}`));
}
