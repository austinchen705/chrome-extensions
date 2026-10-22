// README 的巨集相關章節（備註、匯出與匯入、調整大小、面板的巨集列）要對得上程式：
// 寫在說明裡的數字（格數、字數上限、按鍵值上限、視窗最小大小）與按鈕上的字，都從程式讀，改了程式沒改說明就會失敗。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
require(path.join(root, 'catworld-auto-command', 'macro-io.js'));
const M = globalThis.CatworldMacroIO;

const README = fs.readFileSync(path.join(root, 'README.md'), 'utf8').replace(/\r\n/g, '\n');
const section = title => {
  const start = README.indexOf(`## ${title}\n`);
  assert.ok(start >= 0, `README has the section ${title}`);
  return README.slice(start, README.indexOf('\n## ', start + 5));
};
const MACRO_TEXT = ['巨集備註', '巨集匯出與匯入', '巨集視窗調整大小'].map(section).join('\n');
const CONTENT = fs.readFileSync(path.join(root, 'catworld-auto-command', 'content.js'), 'utf8');

test('the numbers README gives for the macro features are the ones the code uses', () => {
  [M.COUNT, M.MAX_COMMAND, M.MAX_NOTE, M.MAX_KEY, M.MIN_WINDOW.width, M.MIN_WINDOW.height]
    .forEach(number => assert.ok(MACRO_TEXT.includes(String(number)), `README mentions ${number}`));
});

test('every button of the panel macro row and its import box is named in README with the label it has on screen', () => {
  const labels = [...CONTENT.matchAll(/<button class="(?:mexport|mimport|mstop|macro-import-check|macro-restore|macro-confirm-ok)"[^>]*>([^<]+)<\/button>/g)].map(match => match[1]);
  assert.deepEqual(labels.sort(), ['停止', '匯入', '匯出', '檢查', '確認取代', '還原上一份'].sort(), 'the buttons in the panel are the ones this test expects');
  labels.forEach(label => assert.ok(README.includes(`「${label}」`), `README names the button 「${label}」`));
});

test('README does not say the macro row only shows while a macro runs, now that it is always on the panel', () => {
  assert.doesNotMatch(README, /「巨集」列[^。\n]*才出現/);
  assert.doesNotMatch(README, /平常只顯示「匯出」/);
});

test('README points at the section by the name it has now', () => {
  assert.doesNotMatch(README, /「巨集匯出」/, 'the section is called 巨集匯出與匯入');
  assert.ok(README.includes('「巨集匯出與匯入」'), 'something refers to the section');
});
