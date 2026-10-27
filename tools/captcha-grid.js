// 驗證碼數字辨識的 CLI：把遊戲輸出的 HTML 檔交給 catworld-auto-command/captcha-grid.js 解出數字。
// 認不出的字形印 `?`，矩陣輸出到 stderr；加 --debug 印出每個數字的矩陣。
// 用法：node tools/captcha-grid.js <html 檔> [...] [--debug]
const fs = require('fs');
const { decodeHtml, toAscii } = require('../catworld-auto-command/captcha-grid');

const args = process.argv.slice(2);
const debug = args.includes('--debug');
const paths = args.filter(a => !a.startsWith('--'));
if (!paths.length) {
  console.error('用法：node tools/captcha-grid.js <html 檔> [...] [--debug]');
  process.exit(2);
}
for (const p of paths) {
  const result = decodeHtml(fs.readFileSync(p, 'utf8'));
  console.log(`${p}\t${result.text}`);
  result.digits.forEach((d, idx) => {
    if (!debug && d.confident) return;
    console.error(`  [${idx}] ${d.char} ${d.matrix[0].length}x${d.matrix.length} score=${d.score.toFixed(2)}`);
    for (const line of toAscii(d.matrix)) console.error(`      ${line}`);
  });
}
