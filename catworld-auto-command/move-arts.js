// 悟招圖：玩家悟出新招時，遊戲會印一塊字元圖（蛇、人、牛…）加上「<人名(id)悟出了新武功>」「<之中的一招:『招式名』>」。
// 這裡把那一塊解析出來存起來（chrome.storage.local.moveArts），招式列表與招式動畫再拿去上色與播放；也能匯出給別人、匯入別人的。
// 純函式（解析、檢查、合併）不碰 DOM 與 chrome.*，設定頁與遊戲頁共用；遊戲頁的觀察器在檔案最後，只在有 #content 的頁面啟動。
// 解析吃的是片段 [{ text, classes }]（遊戲頁由 DOM 的 span 轉、測試由 HTML 轉），顏色碼取第一個 H0–H7／N0–N7 的 class。
(() => {
const FORMAT = 'catworld-move-arts';
const VERSION = 1;
const CODE = /^[HN][0-7]$/;
const MARK = '悟出了新';
const MAX_NAME = 30; // 武功名、招式名最多這麼多字
const MAX_LINES = 12; // 字元圖最多幾行
const MAX_SEGMENTS = 24; // 一行最多幾段顏色
const MAX_TEXT = 120; // 一段最多幾個字
const MAX_ENTRIES = 500;
const MAX_FILE = 2 * 1024 * 1024;
const MAX_SPANS = 40; // 遊戲頁：從觸發的 span 往前、往後各最多接這麼多個
const SETTLE_MS = 500; // 觸發後等這麼久才讀（輸出可能分批到）

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keyOf = (skill, move) => `${skill}/${move}`;
const codeOf = classes => [].concat(classes ?? []).find(name => CODE.test(name)) ?? 'N7';

// 單一一筆：形狀與大小都檢查，只留認得的欄位。回 { ok: true, entry } 或 { ok: false, error }
function checkEntry(key, entry) {
  const bad = why => ({ ok: false, error: `「${String(key).slice(0, 40)}」${why}` });
  if (!isObject(entry)) return bad('不是物件');
  const { skill, move, lines, nameCodes } = entry;
  const name = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_NAME && !value.includes('/');
  if (!name(skill) || !name(move)) return bad('的 skill、move 要是 1 到 30 字的文字（不含 /）');
  if (key !== keyOf(skill, move)) return bad('的鍵要是 skill/move');
  if (!Array.isArray(lines) || !lines.length || lines.length > MAX_LINES) return bad(`的 lines 要是 1 到 ${MAX_LINES} 行`);
  const cleanLines = [];
  for (const line of lines) {
    if (!Array.isArray(line) || !line.length || line.length > MAX_SEGMENTS) return bad(`的每一行要是 1 到 ${MAX_SEGMENTS} 段`);
    const segments = [];
    for (const segment of line) {
      if (!Array.isArray(segment) || segment.length !== 2 || typeof segment[0] !== 'string' || segment[0].length > MAX_TEXT || !CODE.test(segment[1])) return bad('的片段要是 [文字, 顏色碼（H0–H7、N0–N7）]');
      segments.push([segment[0], segment[1]]);
    }
    cleanLines.push(segments);
  }
  if (!Array.isArray(nameCodes) || nameCodes.length !== [...move].length || !nameCodes.every(code => typeof code === 'string' && CODE.test(code))) return bad('的 nameCodes 要和招式名同樣長、每個是顏色碼');
  return { ok: true, entry: { skill, move, lines: cleanLines, nameCodes: [...nameCodes], at: Number.isFinite(entry.at) && entry.at >= 0 ? entry.at : 0 } };
}

// 片段 → 悟招圖 { skill, move, lines, nameCodes } 或 null（不是悟招訊息、找不到招式名、悟招人名換不掉都回 null：人名絕不存）
function parseLearn(spans) {
  const lines = [[]];
  for (const span of spans ?? []) {
    const code = codeOf(span.classes);
    const pieces = String(span.text ?? '').split(/\r?\n/);
    pieces.forEach((piece, index) => {
      if (index) lines.push([]);
      if (piece) lines.at(-1).push([piece, code]);
    });
  }
  const text = line => line.map(segment => segment[0]).join('');
  const start = lines.findIndex(line => text(line).includes(MARK));
  if (start < 0) return null;
  let end = lines.findIndex((line, index) => index > start && text(line).includes(MARK));
  if (end < 0) end = lines.length;
  const block = lines.slice(start, Math.min(end, start + MAX_LINES));
  while (block.length && !block.at(-1).length) block.pop();

  // 第一行：<人名(id)悟出了新武功> → <你悟出了新武功>；人名與 id 可能分在好幾個 span
  const first = block[0];
  const markAt = first.findIndex(segment => segment[0].includes(MARK));
  let openAt = -1;
  for (let i = markAt; i >= 0; i -= 1) if (first[i][0].includes('<')) { openAt = i; break; }
  if (openAt < 0) return null;
  const skill = /悟出了新(.+?)>/.exec(text(first))?.[1];
  if (!skill) return null;
  const head = first[openAt][0].slice(0, first[openAt][0].indexOf('<'));
  const tail = first[markAt][0].slice(first[markAt][0].indexOf(MARK));
  block[0] = [
    ...first.slice(0, openAt),
    ...(head ? [[head, first[openAt][1]]] : []),
    [`<你${tail}`, first[openAt][1]],
    ...first.slice(markAt + 1),
  ];

  // 招式名：「之中的一招:『…』」那一行，逐字記顏色
  const moveLine = block.find(line => text(line).includes('之中的一招'));
  if (!moveLine) return null;
  const chars = moveLine.flatMap(([chunk, code]) => [...chunk].map(char => ({ char, code })));
  const open = chars.findIndex(item => item.char === '『');
  const close = chars.findIndex((item, index) => index > open && item.char === '』');
  if (open < 0 || close <= open + 1) return null;
  const named = chars.slice(open + 1, close);
  const move = named.map(item => item.char).join('');
  const entry = { skill, move, lines: block, nameCodes: named.map(item => item.code) };
  const checked = checkEntry(keyOf(skill, move), entry);
  return checked.ok ? { skill, move, lines: checked.entry.lines, nameCodes: checked.entry.nameCodes } : null;
}

// 新抓到的一筆放進現有的：已有同一招就回 null（圖都一樣，留第一次的）
function addCapture(existing, entry, at = Date.now()) {
  const store = isObject(existing) ? existing : {};
  const key = keyOf(entry.skill, entry.move);
  if (Object.hasOwn(store, key)) return null;
  return { ...store, [key]: { ...entry, at } };
}

// 匯出檔
function exportText(arts, { version = '', now = Date.now() } = {}) {
  return JSON.stringify({ format: FORMAT, version: VERSION, exportedWith: String(version), exportedAt: new Date(now).toISOString(), arts: isObject(arts) ? arts : {} }, null, 2);
}

// 整份檢查匯入的文字；任何一筆不合就整份拒絕。通過回 { ok: true, arts }（只留認得的欄位）
function checkImport(text) {
  if (typeof text !== 'string' || !text.trim()) return { ok: false, error: '沒有內容' };
  if (text.length > MAX_FILE) return { ok: false, error: '檔案太大，不像是悟招圖' };
  let file;
  try { file = JSON.parse(text); } catch (e) { return { ok: false, error: `不是有效的 JSON：${e.message}` }; }
  if (!isObject(file) || file.format !== FORMAT) return { ok: false, error: `這不是悟招圖檔（format 要是 ${FORMAT}）` };
  if (!Number.isInteger(file.version) || file.version < 1) return { ok: false, error: 'version 要是 1 以上的整數' };
  if (file.version > VERSION) return { ok: false, error: `這份檔案是較新的格式（version ${file.version}），請先更新擴充功能` };
  if (!isObject(file.arts)) return { ok: false, error: 'arts 要是物件' };
  const keys = Object.keys(file.arts);
  if (keys.length > MAX_ENTRIES) return { ok: false, error: `最多 ${MAX_ENTRIES} 招` };
  const arts = {};
  for (const key of keys) {
    const checked = checkEntry(key, file.arts[key]);
    if (!checked.ok) return { ok: false, error: checked.error };
    Object.defineProperty(arts, key, { value: checked.entry, enumerable: true, writable: true, configurable: true });
  }
  return { ok: true, arts };
}

// 合併：現有的鍵跳過。回 { next, added, skipped }；超過上限的新招不收（算跳過）
function mergeArts(existing, incoming) {
  const next = { ...(isObject(existing) ? existing : {}) };
  let added = 0;
  let skipped = 0;
  for (const [key, entry] of Object.entries(incoming)) {
    if (Object.hasOwn(next, key) || Object.keys(next).length >= MAX_ENTRIES) { skipped += 1; continue; }
    Object.defineProperty(next, key, { value: entry, enumerable: true, writable: true, configurable: true });
    added += 1;
  }
  return { next, added, skipped };
}

globalThis.CatworldMoveArts = { FORMAT, VERSION, MAX_ENTRIES, keyOf, checkEntry, parseLearn, addCapture, exportText, checkImport, mergeArts };

const content = typeof document === 'undefined' ? null : document.getElementById('content');
if (!content || !globalThis.chrome?.storage?.local) return;

// ---- 遊戲頁：看到悟招訊息就抓 ----
const OWN = '[data-catworld-skills], [data-catworld-moveart], [data-catworld-movefx]';
const isOwn = node => Boolean((node.nodeType === 1 ? node : node.parentElement)?.closest?.(OWN));
const isX = node => node?.nodeType === 1 && node.classList.contains('X');
const done = new WeakSet();
let timer = null;

// 以觸發的 span 為中心，往前、往後接上連續帶 X 的 span
function runAround(trigger) {
  const before = [];
  for (let node = trigger.previousSibling; isX(node) && before.length < MAX_SPANS; node = node.previousSibling) before.unshift(node);
  const after = [];
  for (let node = trigger.nextSibling; isX(node) && after.length < MAX_SPANS; node = node.nextSibling) after.push(node);
  return [...before, trigger, ...after];
}

async function scan() {
  const found = [...content.querySelectorAll('span.X')].filter(span => !done.has(span) && !isOwn(span) && span.textContent.includes(MARK));
  if (!found.length) return;
  found.forEach(span => done.add(span));
  try {
    for (const trigger of found) {
      const learned = parseLearn(runAround(trigger).map(span => ({ text: span.textContent, classes: [...span.classList] })));
      if (!learned) continue;
      const { moveArts } = await chrome.storage.local.get('moveArts');
      const next = addCapture(moveArts, learned);
      if (next) await chrome.storage.local.set({ moveArts: next });
    }
  } catch {
    // 連不上儲存（孤兒程式）：什麼都不做
  }
}

new MutationObserver(records => {
  const hit = records.some(record => Array.from(record.addedNodes).some(node => !isOwn(node) && (node.textContent || '').includes(MARK)));
  if (!hit) return;
  clearTimeout(timer);
  timer = setTimeout(scan, SETTLE_MS);
}).observe(content, { subtree: true, childList: true });
})();
