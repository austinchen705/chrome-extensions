// 把 docs/data/map-monsters.tsv（設定頁「地圖怪物蒐集」複製出來的資料）轉成 catworld-auto-command/map-data.js，
// 當作內建的地圖怪物資料（map-collect.js 的 withBuiltin 與個人蒐集的紀錄合併）。
// 用法：node tools/gen-map-data.js；不要手改產生的檔案，改 TSV 再重新產生。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const lines = fs.readFileSync(path.join(root, 'docs/data/map-monsters.tsv'), 'utf8').split('\n').filter(Boolean).slice(1);
const rows = lines.map((line, i) => {
  const [area, areaName, room, mobs, ...extra] = line.split('\t');
  const list = (mobs || '').split(',').filter(mob => /\(.+\)$/.test(mob));
  if (!area || !room || extra.length || !list.length) throw new Error(`第 ${i + 2} 列格式不對：${line}`);
  return [area, areaName || '', room, list];
});
if (rows.length < 50) throw new Error(`只解析出 ${rows.length} 列，資料檔可能壞了，不覆寫`);

const out = path.join(root, 'catworld-auto-command/map-data.js');
fs.writeFileSync(out, `// 由 tools/gen-map-data.js 從 docs/data/map-monsters.tsv 產生，不要手改。每列：[區域代號, 區域名稱, 房間代號, [怪物名稱(ID)…]]
globalThis.CatworldMapData = [
${rows.map(row => '  ' + JSON.stringify(row)).join(',\n')},
];
`);
console.log(`map-data.js：${rows.length} 個房間`);
