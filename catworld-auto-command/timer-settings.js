// 定時分頁「固定指令」「隨機指令」的設定與抽選：不碰 DOM，content script 與 popup 共用。
//
// 兩種都是每個指令各有一組最短～最長秒數。
// 固定指令：每一項各自循環，開始時先送一次，之後在「它自己的」秒數之間隨機等一段時間再送，彼此不等。
// 隨機指令：先從所有隨機指令裡均勻隨機挑一個，再在「它自己的」最短～最長秒數之間隨機等一段時間，到時間才送出，送出後再挑下一個。
// 所以每個隨機指令被挑中的機率一樣，秒數只決定「挑中它之後要等多久」。
//
// 舊格式：固定指令是 commands 一行一個 + 共用的 minSeconds / maxSeconds（每輪全部依序送出），轉成一項、指令用 ; 接起來
//（; 會像巨集一樣依序送出），行為才和以前一樣；隨機指令是 randomCommands 一行一個 + 共用的 randomMinSeconds / randomMaxSeconds，
// 轉成每個指令都用那組共用秒數。
(() => {
if (globalThis.CatworldTimer) return;

const DEFAULT_MIN = 30;
const DEFAULT_MAX = 40;
const DEFAULT_COMMANDS = ['ps', 'px'];

function cleanItem(raw) {
  const command = String(raw?.command ?? '').trim();
  if (!command) return null;
  const minSeconds = Math.max(1, Number(raw.minSeconds) || DEFAULT_MIN);
  const maxSeconds = Math.max(minSeconds, Number(raw.maxSeconds) || minSeconds);
  return { command, minSeconds, maxSeconds };
}

// 回傳 [{ command, minSeconds, maxSeconds }]，沒有指令的列會被濾掉
function normalizeRandomItems(settings = {}) {
  if (Array.isArray(settings.randomItems)) return settings.randomItems.map(cleanItem).filter(Boolean);
  const minSeconds = Number(settings.randomMinSeconds) || DEFAULT_MIN;
  const maxSeconds = Number(settings.randomMaxSeconds) || DEFAULT_MAX;
  return (settings.randomCommands || []).map(command => cleanItem({ command, minSeconds, maxSeconds })).filter(Boolean);
}

// 回傳 [{ command, minSeconds, maxSeconds }]：有 fixedItems 就用它（清空的列表維持空的）；沒有就讀舊格式，從沒設定過時給預設的 ps;px
function normalizeFixedItems(settings = {}) {
  if (Array.isArray(settings.fixedItems)) return settings.fixedItems.map(cleanItem).filter(Boolean);
  const commands = (Array.isArray(settings.commands) ? settings.commands : DEFAULT_COMMANDS).map(command => String(command).trim()).filter(Boolean);
  if (!commands.length) return [];
  const minSeconds = Number(settings.minSeconds) || DEFAULT_MIN;
  const maxSeconds = Number(settings.maxSeconds) || DEFAULT_MAX;
  return [cleanItem({ command: commands.join(';'), minSeconds, maxSeconds })];
}

// 均勻隨機挑一個；沒有指令回 null
function pickRandomItem(items, random = Math.random) {
  return items.length ? items[Math.min(items.length - 1, Math.floor(random() * items.length))] : null;
}

// 這個指令從「被挑中」到「送出」要等幾毫秒
function delayMs(item, random = Math.random) {
  return (item.minSeconds + random() * (item.maxSeconds - item.minSeconds)) * 1000;
}

// 指令欄位裡的 <enter>（整個指令就只有它）＝送一個空白行，等於在遊戲輸入框按 Enter（翻下一頁）；
// 遊戲收到空字串會送純換行。各處的欄位會把空白指令濾掉，所以要用文字代號表示
const commandText = command => (/^\s*<enter>\s*$/i.test(String(command ?? '')) ? '' : String(command ?? ''));

globalThis.CatworldTimer = { DEFAULT_MIN, DEFAULT_MAX, normalizeFixedItems, normalizeRandomItems, pickRandomItem, delayMs, commandText };
})();
