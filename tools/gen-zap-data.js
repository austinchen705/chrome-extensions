// 從 zap 攻略站的 MOB 表與 catworld 說明站的新手怪列表，加上 tools/zap-overrides.json，
// 產生 catworld-auto-command/zap-data.json。
// 用法：node tools/gen-zap-data.js            （連網抓來源）
//       node tools/gen-zap-data.js --from-dir <資料夾>   （讀 <資料夾>/ot1.htm 與 newstart.3.html）
const fs = require('fs');
const path = require('path');
const { buildData, SOURCES } = require('./zap-parse');

const outFile = path.join(__dirname, '..', 'catworld-auto-command', 'zap-data.json');
const overridesFile = path.join(__dirname, 'zap-overrides.json');

async function loadSources(dir) {
  if (dir) {
    return {
      zapHtml: fs.readFileSync(path.join(dir, 'ot1.htm'), 'utf8'),
      newstartHtml: fs.readFileSync(path.join(dir, 'newstart.3.html'), 'utf8'),
    };
  }
  const get = async url => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} 回應 ${response.status}`);
    return response.text();
  };
  const [zapHtml, newstartHtml] = await Promise.all(SOURCES.map(get));
  return { zapHtml, newstartHtml };
}

async function main() {
  const dirIndex = process.argv.indexOf('--from-dir');
  const dir = dirIndex >= 0 ? process.argv[dirIndex + 1] : null;
  const overrides = JSON.parse(fs.readFileSync(overridesFile, 'utf8'));
  const { data, report, problems } = buildData({ ...(await loadSources(dir)), overrides });
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
