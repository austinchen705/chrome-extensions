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
  const end = README.indexOf('\n## ', start + 5);
  return end < 0 ? README.slice(start) : README.slice(start, end);
};
const MACRO_TEXT = ['巨集備註', '巨集匯出與匯入', '巨集視窗調整大小'].map(section).join('\n');
const CONTENT = fs.readFileSync(path.join(root, 'catworld-auto-command', 'content.js'), 'utf8');

// 數字連同它的語境一起比對：只看數字有沒有出現在某處，別處剛好有 90 或 200 也會放行
test('the numbers README gives for the macro features are the ones the code uses, each with what it limits', () => {
  [
    `${M.COUNT} 格`,
    `指令超過 ${M.MAX_COMMAND} 字`,
    `超過 ${M.MAX_NOTE} 字`,
    `1 到 ${M.MAX_KEY}`,
    `寬 ${M.MIN_WINDOW.width}、高 ${M.MIN_WINDOW.height}`,
  ].forEach(phrase => assert.ok(MACRO_TEXT.includes(phrase), `README says "${phrase}"`));
});

test('the limit README gives for a remembered window size is where the code stops believing it', () => {
  assert.ok(M.sanitizeSize({ width: 10000, height: 500 }), '10000 is still believed');
  assert.equal(M.sanitizeSize({ width: 10001, height: 500 }), null, '10001 is not');
  assert.ok(section('巨集視窗調整大小').includes('超過 10000'), 'README says over 10000 counts as broken');
});

test('README says when a drag ends and that the success message goes away by itself', () => {
  const resize = section('巨集視窗調整大小');
  assert.ok(resize.includes('失去焦點') && resize.includes('滑鼠鍵'), 'a drag also ends on losing focus or when the button is already up');
  assert.ok(section('巨集匯出與匯入').includes('8 秒後自動收起'));
});

test('README says the restore button stays pressable when the backup is broken, and why it is in the import box', () => {
  const io = section('巨集匯出與匯入');
  assert.ok(io.includes('仍然可以按'));
  assert.ok(io.includes('310px'));
});

test('every button of the panel macro row and its import box is named in README with the label it has on screen', () => {
  const labels = [...CONTENT.matchAll(/<button class="(?:mexport|mimport|mstop|macro-import-check|macro-restore|macro-confirm-ok)"[^>]*>([^<]+)<\/button>/g)].map(match => match[1]);
  assert.deepEqual(labels.sort(), ['停止', '匯入', '匯出', '檢查', '確認取代', '還原上一份'].sort(), 'the buttons in the panel are the ones this test expects');
  labels.forEach(label => assert.ok(README.includes(`「${label}」`), `README names the button 「${label}」`));
});

test('README does not say the macro row only shows while a macro runs, now that it is always on the panel', () => {
  assert.doesNotMatch(README, /「巨集」列[^\n]{0,40}才(?:會)?(?:出現|顯示)/);
  assert.doesNotMatch(README, /有巨集在跑(?:時)?才(?:會)?(?:出現|顯示)/);
  assert.doesNotMatch(README, /平常只顯示「匯出」/);
});

test('README points at the section by the name it has now', () => {
  assert.doesNotMatch(README, /「巨集匯出」/, 'the section is called 巨集匯出與匯入');
  assert.ok(README.includes('「巨集匯出與匯入」'), 'something refers to the section');
});
