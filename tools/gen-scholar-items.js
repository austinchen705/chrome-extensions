// 從 zap 攻略站的 qu1-7（六脈神劍的書生物品表）產生 catworld-auto-command/scholar-items-data.js，當作內建的書生物品清單。
// 用法：node tools/gen-scholar-items.js                  （連網抓來源）
//       node tools/gen-scholar-items.js --from-file <qu1-7.htm>
// 不要手改產生的檔案。
const fs = require('fs');
const path = require('path');

const URL = 'https://zap.muds.me/qu1-7.htm';
const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const cellText = html => html.replace(/<[^>]*>/g, '').replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&([a-z]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole).replace(/\s+/g, ' ').trim();

// 取得方式的文字 → 類別：買（販賣也算）、解謎、鑑定、撿、其餘殺怪
function categoryOf(how) {
  if (/買|販賣/.test(how)) return 'buy';
  if (/\[解謎\]/.test(how)) return 'riddle';
  if (/鑑定/.test(how)) return 'identify';
  if (/撿|敲下|箱子/.test(how)) return 'pick';
  return 'kill';
}
// 同一個物品有好幾種取得方式時，整列的類別取最容易的那一種
const EASIEST = ['buy', 'pick', 'kill', 'identify', 'riddle'];

// 表格：只有一格（colspan）的列是地區標題，其餘每列兩組「物品名、取得方式」。回傳 [{ name, category, ways: [[地區, 取得方式]] }]，同名合併、依第一次出現的順序
function parseScholarItems(html) {
  const items = new Map();
  let region = '';
  String(html).split(/<tr[\s>]/i).slice(1).forEach(row => {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(match => cellText(match[1]));
    if (cells.length === 1) {
      region = cells[0];
      return;
    }
    for (let i = 0; i + 1 < cells.length; i += 2) {
      const [name, how] = [cells[i], cells[i + 1]];
      if (!name || !how || name === '物品名') continue;
      if (!items.has(name)) items.set(name, []);
      items.get(name).push([region, how]);
    }
  });
  return [...items].map(([name, ways]) => ({
    name, ways, category: EASIEST.find(key => ways.some(([, how]) => categoryOf(how) === key)),
  }));
}

async function main() {
  const fileIndex = process.argv.indexOf('--from-file');
  let html;
  if (fileIndex >= 0) html = fs.readFileSync(process.argv[fileIndex + 1], 'utf8');
  else {
    const response = await fetch(URL);
    if (!response.ok) throw new Error(`${URL} 回應 ${response.status}`);
    html = await response.text();
  }
  const items = parseScholarItems(html);
  if (items.length < 50) throw new Error(`只解析出 ${items.length} 樣物品，來源可能壞了，不覆寫`);
  fs.writeFileSync(path.join(__dirname, '..', 'catworld-auto-command/scholar-items-data.js'), `// 由 tools/gen-scholar-items.js 從 ${URL} 產生，不要手改。每列：[物品名, 類別（buy／pick／kill／identify／riddle）, [[地區, 取得方式]…]]
globalThis.CatworldScholarItems = [
${items.map(item => '  ' + JSON.stringify([item.name, item.category, item.ways])).join(',\n')},
];
`);
  console.log(`scholar-items-data.js：${items.length} 樣`);
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exit(1); });
module.exports = { parseScholarItems, categoryOf };
