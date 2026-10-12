#!/usr/bin/env node
// 把本 repo 裡的 extension 複製到固定資料夾，並引導在 Chrome 載入。
// Chrome 沒有可靠的免操作安裝方式，所以「載入未封裝項目」這一步仍需手動點。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const extensions = fs.readdirSync(root, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, 'manifest.json')))
  .map(entry => entry.name);

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const valueOf = name => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const positional = args.filter((arg, i) => !arg.startsWith('-') && args[i - 1] !== '--dir');

if (flag('--help') || flag('-h')) {
  console.log(`用法：install-extension [extension 名稱] [--dir <安裝資料夾>] [--no-open]

可安裝的 extension：${extensions.join('、')}
預設安裝到：${path.join(os.homedir(), 'chrome-extensions', '<名稱>')}
  --dir <路徑>  指定安裝資料夾
  --no-open     不要自動開啟 chrome://extensions`);
  process.exit(0);
}

const name = positional[0] || (extensions.length === 1 ? extensions[0] : undefined);
if (!name || !extensions.includes(name)) {
  console.error(`請指定要安裝的 extension：${extensions.join('、')}`);
  process.exit(1);
}

const versionOf = dir => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version;
  } catch {
    return null;
  }
};

const source = path.join(root, name);
const target = path.resolve(valueOf('--dir') || path.join(os.homedir(), 'chrome-extensions', name));
const oldVersion = versionOf(target);

// 只覆蓋「已經是 extension 的資料夾」或空資料夾，避免 --dir 指錯位置時刪到別的東西
if (fs.existsSync(target)) {
  if (oldVersion) fs.rmSync(target, { recursive: true, force: true });
  else if (fs.readdirSync(target).length) {
    console.error(`${target} 不是空資料夾，也不是 extension，已停止。請改用 --dir 指定其他位置。`);
    process.exit(1);
  }
}
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.cpSync(source, target, { recursive: true });

const newVersion = versionOf(target);
console.log(`已安裝 ${name} v${newVersion} → ${target}`);
if (oldVersion) console.log(`升級：v${oldVersion} → v${newVersion}`);

// 以下兩個動作只是方便，失敗不影響安裝結果
const quietly = (command, commandArgs, input) => {
  try {
    const child = spawn(command, commandArgs, { stdio: ['pipe', 'ignore', 'ignore'], detached: !input });
    child.on('error', () => {});
    if (input) child.stdin.end(input);
    else child.unref();
  } catch {
    // 找不到指令就略過
  }
};

const copyTool = { win32: ['clip', []], darwin: ['pbcopy', []], linux: ['xclip', ['-selection', 'clipboard']] }[process.platform];
// Windows 的 clip 只認本機字碼頁，路徑含非 ASCII 字元時會變亂碼，這種情況不複製
const copyable = process.platform !== 'win32' || /^[\x20-\x7e]+$/.test(target);
if (copyTool && copyable) quietly(copyTool[0], copyTool[1], target);

if (!flag('--no-open')) {
  const url = 'chrome://extensions';
  if (process.platform === 'win32') quietly('cmd', ['/c', 'start', '', 'chrome', url]);
  else if (process.platform === 'darwin') quietly('open', ['-a', 'Google Chrome', url]);
  else quietly('google-chrome', [url]);
}

console.log(`
接下來在 Chrome：
  1. 開啟 chrome://extensions${flag('--no-open') ? '' : '（已嘗試自動開啟，沒開的話請手動輸入網址）'}
  2. 右上角打開「開發人員模式」
  3. ${oldVersion
    ? '已安裝過：按該 extension 卡片上的「重新載入」'
    : `第一次安裝：按「載入未封裝項目」，選擇資料夾\n     ${target}${copyable ? '\n     （路徑已複製到剪貼簿）' : ''}`}
  4. 重新整理遊戲分頁，新版才會生效`);
