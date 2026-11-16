// 把 docs/data/semotes.tsv（使用者在沒人的房間把每個表情不帶對象做一次的輸出，作者標的類別）轉成
// catworld-auto-command/emote-data.js，給隨機表情（emote-pick.js）用。
// 用法：node tools/gen-emote-data.js；不要手改產生的檔案，改 TSV 再重新產生。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const CATEGORIES = ['開心', '大笑', '累', '思考', '無奈', '耍寶', '招呼', '加油', '動作', '不用', '要對象'];
const lines = fs.readFileSync(path.join(root, 'docs/data/semotes.tsv'), 'utf8').replace(/\r\n/g, '\n').split('\n').filter(Boolean).slice(1);
const seen = new Set();
const rows = lines.map((line, i) => {
  const parts = line.split('\t');
  if (parts.length !== 5) throw new Error(`第 ${i + 2} 列欄位數不對：${line}`);
  const [command, , category, order, alone] = parts;
  if (!/^\S+$/.test(command) || seen.has(command)) throw new Error(`第 ${i + 2} 列的指令不對或重複：${command}`);
  if (!CATEGORIES.includes(category)) throw new Error(`第 ${i + 2} 列的類別不認得：${category}`);
  if (order !== '' && !/^\d+$/.test(order)) throw new Error(`第 ${i + 2} 列的順序不是整數：${order}`);
  if (alone !== '' && alone !== '是') throw new Error(`第 ${i + 2} 列的單獨只能是「是」或空白：${alone}`);
  seen.add(command);
  return [command, category, order === '' ? null : Number(order), alone === '是'];
});
if (rows.length < 100) throw new Error(`只解析出 ${rows.length} 列，資料檔可能壞了，不覆寫`);

fs.writeFileSync(path.join(root, 'catworld-auto-command/emote-data.js'), `// 由 tools/gen-emote-data.js 從 docs/data/semotes.tsv 產生，不要手改。每列：[指令, 類別, 順序或 null, 只能單獨出現]
globalThis.CatworldEmoteData = [
${rows.map(row => '  ' + JSON.stringify(row)).join(',\n')},
];
`);
console.log(`emote-data.js：${rows.length} 個表情`);
