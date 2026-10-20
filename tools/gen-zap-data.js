// 從 zap 攻略站的 MOB 表、無名物品表、解謎總表與步驟頁，以及 catworld 說明站的新手怪列表，加上 tools/zap-overrides.json，
// 產生 catworld-auto-command/zap-data.json。
// 用法：node tools/gen-zap-data.js            （連網抓來源）
//       node tools/gen-zap-data.js --from-dir <資料夾>   （讀 <資料夾>/ot1.htm、newstart.3.html、ub.htm、map.15.html、qu1.htm、list.html 與選單裡的每個 qu*.htm）
const fs = require('fs');
const path = require('path');
const { buildData, SOURCES, UB_URL, ROUTES_URL, parseRiddleMenu } = require('./zap-parse');

const SITE = 'https://zap.muds.me/';
const CONCURRENCY = 6;

const outFile = path.join(__dirname, '..', 'catworld-auto-command', 'zap-data.json');
const commandsFile = path.join(__dirname, 'zap-route-commands.json');
const aliasesFile = path.join(__dirname, 'zap-route-aliases.json');
const overridesFile = path.join(__dirname, 'zap-overrides.json');

const get = async url => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} 回應 ${response.status}`);
  return response.text();
};

// 選單裡每個步驟頁都要抓到；任何一個抓不到就整個失敗（不寫出缺頁的資料）
async function loadRiddles(read) {
  const indexHtml = await read('qu1.htm');
  const menuHtml = await read('list.html');
  const files = [...new Set(parseRiddleMenu(menuHtml).map(entry => entry.file))];
  const pageHtml = {};
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    const htmls = await Promise.all(batch.map(read));
    batch.forEach((file, k) => { pageHtml[file] = htmls[k]; });
  }
  return { indexHtml, menuHtml, pageHtml };
}

async function loadSources(dir) {
  if (dir) {
    const read = async name => fs.readFileSync(path.join(dir, name), 'utf8');
    return {
      zapHtml: await read('ot1.htm'),
      newstartHtml: await read('newstart.3.html'),
      ubHtml: await read('ub.htm'),
      riddleHtml: await loadRiddles(read),
      routesHtml: await read('map.15.html'),
    };
  }
  const [zapHtml, newstartHtml, ubHtml] = await Promise.all([...SOURCES, UB_URL].map(get));
  return { zapHtml, newstartHtml, ubHtml, riddleHtml: await loadRiddles(name => get(`${SITE}${name}`)), routesHtml: await get(ROUTES_URL) };
}

async function main() {
  const dirIndex = process.argv.indexOf('--from-dir');
  const dir = dirIndex >= 0 ? process.argv[dirIndex + 1] : null;
  const overrides = JSON.parse(fs.readFileSync(overridesFile, 'utf8'));
  const { data, report, problems } = buildData({ ...(await loadSources(dir)), overrides });
  const routeAliases = JSON.parse(fs.readFileSync(aliasesFile, 'utf8'));
  if (data.routes) {
    Object.entries(routeAliases).forEach(([place, target]) => {
      if (!data.routes.some(route => route.name === target)) problems.push(`路線別名指向不存在的地點：${place} → ${target}`);
    });
    data.routeAliases = routeAliases;
    // 手動指定的完整指令：當成一筆路線放進 routes（名稱就是怪物位置），送出時不再加 run e 5n 2o 前綴
    Object.entries(JSON.parse(fs.readFileSync(commandsFile, 'utf8'))).forEach(([place, command]) => {
      data.routes = data.routes.filter(route => route.name !== place).concat({ name: place, path: '', command, npc: '', riddle: false });
    });
  }
  report.forEach(line => console.log(line));
  if (problems.length) {
    problems.forEach(line => console.error(line));
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(outFile, `${JSON.stringify(data, null, 1)}\n`);
  console.log(`已寫入 ${path.relative(process.cwd(), outFile)}`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
