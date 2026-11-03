// 把 docs/data/shop-items.tsv（設定頁「裝備資料庫」複製出來的資料）轉成 catworld-auto-command/shop-data.js，
// 當作內建的商人裝備資料（shop-collect.js 的 withBuiltin 與個人 check 的紀錄合併）。
// 用法：node tools/gen-shop-data.js；不要手改產生的檔案，改 TSV 再重新產生。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const lines = fs.readFileSync(path.join(root, 'docs/data/shop-items.tsv'), 'utf8').split('\n').filter(Boolean).slice(1);
const ATTR = /^(.+?)([+-]\d+(?:\.\d+)?)$/;
const rows = lines.map((line, i) => {
  const parts = line.split('\t');
  if (parts.length !== 5) throw new Error(`第 ${i + 2} 列欄位數不對：${line}`);
  const [name, category, primary, needExp, attrs] = parts;
  const parsed = attrs.split(' ').filter(Boolean).map(text => {
    const match = ATTR.exec(text);
    if (!match) throw new Error(`第 ${i + 2} 列的屬性看不懂：${text}`);
    return [match[1], Number(match[2])];
  });
  if (!name || !category || !Number.isFinite(Number(needExp))) throw new Error(`第 ${i + 2} 列格式不對：${line}`);
  return [name, category, primary === '' ? null : Number(primary), Number(needExp), parsed];
});
if (rows.length < 50) throw new Error(`只解析出 ${rows.length} 列，資料檔可能壞了，不覆寫`);

fs.writeFileSync(path.join(root, 'catworld-auto-command/shop-data.js'), `// 由 tools/gen-shop-data.js 從 docs/data/shop-items.tsv 產生，不要手改。每列：[名稱, 類別, 主要數值或 null, 佩帶經驗, [[屬性, 數值]…]]
globalThis.CatworldShopData = [
${rows.map(row => '  ' + JSON.stringify(row)).join(',\n')},
];
`);
console.log(`shop-data.js：${rows.length} 件`);
