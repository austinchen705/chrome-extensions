// 遊戲巨集裡的等待：不碰遊戲的程式，只讀遊戲畫面上的巨集視窗，不依賴 extension 其他模組。
//
// 遊戲的巨集是 command.split(/\s*;\s*/) 然後同步一次全部送出，沒有等待。
// 在巨集指令裡寫 `@等待 3`（或 `@wait 3`、範圍 `@wait 3-6`），extension 在遊戲處理按鍵之前攔下這個巨集，
// 自己照順序執行：送完前面的指令、等指定秒數、再送後面的。沒有等待的巨集完全交給遊戲。
(() => {
if (globalThis.CatworldMacro) return;

const MAX_WAIT_SECONDS = 600;

// 遊戲的 key_values：keyCode → 巨集用的鍵值。除了 59→186（;）、61→187（=）、173→189（-）之外都等於 keyCode 本身
const RANGES = [[27, 27], [33, 40], [45, 46], [48, 57], [65, 90], [96, 107], [109, 123], [186, 192], [219, 222]];
const OVERRIDES = { 59: 186, 61: 187, 173: 189 };
const KEY_VALUES = {};
RANGES.forEach(([from, to]) => { for (let code = from; code <= to; code += 1) KEY_VALUES[code] = code; });
Object.assign(KEY_VALUES, OVERRIDES);

// 和遊戲的 get_key_value 一樣：修飾鍵（Meta 2048、Ctrl 1024、Alt 512、Shift 256）加上鍵值；不是巨集能用的鍵回傳 undefined
function keyValue(event) {
  const base = KEY_VALUES[event.which];
  if (!base) return undefined;
  return (event.metaKey ? 2048 : 0) | (event.ctrlKey ? 1024 : 0) | (event.altKey ? 512 : 0) | (event.shiftKey ? 256 : 0) | base;
}

// 巨集視窗裡每一列是 <input class="key" name="鍵值"> 後面接 <input class="command">；沒有這個鍵或指令是空的回傳 null
function findMacroCommand(doc, value) {
  const key = [...doc.querySelectorAll('#macro_list input.key')].find(input => input.name === String(value));
  const command = key?.nextElementSibling?.value;
  return command ? command : null;
}

const WAIT_PREFIX = /^@(?:wait|等待)/i;
const WAIT_FORMAT = /^@(?:wait|等待)\s*(\d+(?:\.\d+)?)(?:\s*[-~～]\s*(\d+(?:\.\d+)?))?\s*(?:秒|s)?$/i;

// 指令裡有沒有等待行（只看開頭是 @wait / @等待 的段落）
const hasWait = text => String(text ?? '').split(/\s*;\s*/).some(piece => WAIT_PREFIX.test(piece));

// 和遊戲一樣用 ; 切開。回傳 { steps }：steps 是 { command } 或 { wait: { min, max } }（秒），
// 或 { error }：有 @wait 開頭但格式不對（例如 @wait abc、最短大於最長、超過上限）時整個巨集不執行
function parseSteps(text) {
  const steps = [];
  for (const piece of String(text ?? '').split(/\s*;\s*/)) {
    if (!WAIT_PREFIX.test(piece)) { steps.push({ command: piece }); continue; }
    const match = WAIT_FORMAT.exec(piece);
    if (!match) return { error: `看不懂「${piece}」，等待要寫成 @等待 3 或 @等待 3-6` };
    const min = Number(match[1]);
    const max = match[2] === undefined ? min : Number(match[2]);
    if (max < min) return { error: `「${piece}」的最長秒數不能小於最短秒數` };
    if (max > MAX_WAIT_SECONDS) return { error: `「${piece}」超過上限 ${MAX_WAIT_SECONDS} 秒` };
    steps.push({ wait: { min, max } });
  }
  return { steps };
}

const waitMs = (wait, random = Math.random) => (wait.min + random() * (wait.max - wait.min)) * 1000;

globalThis.CatworldMacro = { MAX_WAIT_SECONDS, KEY_VALUES, keyValue, findMacroCommand, hasWait, parseSteps, waitMs };
})();
