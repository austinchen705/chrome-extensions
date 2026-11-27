// 悟招圖：玩家悟出新招時，遊戲會印一塊帶 class X 的字元圖（蛇、人、牛…）加上招式名；各武功的句型不同，所以不靠句型，
// 而是把整塊的文字交給 background 比對 skills-data 裡的招式名，比到唯一一招才存。這裡把那一塊整理起來存起來（chrome.storage.local.moveArts），招式列表與招式動畫再拿去上色與播放；也能匯出給別人、匯入別人的。
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

// 片段 → 行 [[文字, 顏色碼]…]：換行在片段裡面，頭尾的空行去掉
function linesOf(spans) {
  const lines = [[]];
  for (const span of spans ?? []) {
    const code = codeOf(span.classes);
    String(span.text ?? '').split(/\r?\n/).forEach((piece, index) => {
      if (index) lines.push([]);
      if (piece) lines.at(-1).push([piece, code]);
    });
  }
  while (lines.length && !lines.at(-1).length) lines.pop();
  while (lines.length && !lines[0].length) lines.shift();
  return lines;
}
const textOf = line => line.map(segment => segment[0]).join('');

// 一整塊的純文字，與 『…』「…」 裡的字串（給 background 比對招式名用，招式名多半在引號裡）
const blockText = spans => linesOf(spans).map(textOf).join('\n');
function quotedIn(text) {
  return [...String(text ?? '').matchAll(/『([^』\n]*)』|「([^」\n]*)」/g)].map(match => match[1] ?? match[2]).filter(Boolean);
}

// 一行裡把 [from, from + length) 的字換成 repl，換掉的字用起點那段的顏色
function replaceRange(line, from, length, repl) {
  const units = line.flatMap(([chunk, code]) => [...chunk].map(char => [char, code]));
  units.splice(from, length, [repl, units[from][1]]);
  const out = [];
  for (const [char, code] of units) {
    if (out.length && out.at(-1)[1] === code) out.at(-1)[0] += char;
    else out.push([char, code]);
  }
  return out;
}

// 悟招人名換成「你」：先看「<人名(id)悟出了新武功>」那一行（人名與 id 可能分在好幾個 span）；
// 沒有那一行就找至少兩行開頭（跳過左邊的字元圖）相同的 2–8 字，換掉那些行的人名。換成功或沒有人名回 lines，換不掉回 null（人名絕不存）
const WORDY = /^[^\p{L}\p{N}_]*/u;
function anonymise(lines) {
  const at = lines.findIndex(line => textOf(line).includes(MARK));
  if (at >= 0) {
    const first = lines[at];
    const markAt = first.findIndex(segment => segment[0].includes(MARK));
    let openAt = -1;
    for (let i = markAt; i >= 0; i -= 1) if (first[i][0].includes('<')) { openAt = i; break; }
    if (openAt < 0) return null;
    const head = first[openAt][0].slice(0, first[openAt][0].indexOf('<'));
    const tail = first[markAt][0].slice(first[markAt][0].indexOf(MARK));
    return lines.map((line, index) => (index !== at ? line : [
      ...first.slice(0, openAt),
      ...(head ? [[head, first[openAt][1]]] : []),
      [`<你${tail}`, first[openAt][1]],
      ...first.slice(markAt + 1),
    ]));
  }
  const starts = lines.map(line => {
    const text = textOf(line);
    const offset = WORDY.exec(text)[0].length;
    return { offset, rest: text.slice(offset) };
  });
  for (let i = 0; i < starts.length; i += 1) {
    for (let j = i + 1; j < starts.length; j += 1) {
      let n = 0;
      while (n < starts[i].rest.length && n < starts[j].rest.length && starts[i].rest[n] === starts[j].rest[n]) n += 1;
      if (n < 2 || n > 8 || !/^[\p{L}\p{N}_]+$/u.test(starts[i].rest.slice(0, n)) || n >= starts[i].rest.length || n >= starts[j].rest.length) continue;
      const name = starts[i].rest.slice(0, n);
      return lines.map((line, index) => (starts[index].rest.startsWith(name) ? replaceRange(line, starts[index].offset, n, '你') : line));
    }
  }
  return lines;
}

// 片段 + 比對到的招式 → 悟招圖 { skill, move, lines, nameCodes } 或 null（招式名不在這一塊裡、人名換不掉、超過行數與大小限制）
function buildArt(spans, skill, move) {
  const lines = anonymise(linesOf(spans));
  if (!lines || !move) return null;
  const want = [...move];
  const found = [];
  for (const line of lines) {
    const chars = line.flatMap(([chunk, code]) => [...chunk].map(char => ({ char, code })));
    for (let i = 0; i + want.length <= chars.length; i += 1) {
      if (want.every((char, k) => chars[i + k].char === char)) found.push({ quoted: '『「'.includes(chars[i - 1]?.char ?? ''), codes: chars.slice(i, i + want.length).map(item => item.code) });
    }
  }
  const pick = found.find(item => item.quoted) ?? found[0];
  if (!pick) return null;
  const checked = checkEntry(keyOf(skill, move), { skill, move, lines, nameCodes: pick.codes });
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

globalThis.CatworldMoveArts = { FORMAT, VERSION, MAX_ENTRIES, keyOf, checkEntry, blockText, quotedIn, buildArt, addCapture, exportText, checkImport, mergeArts };

const content = typeof document === 'undefined' ? null : document.getElementById('content');
if (!content || !globalThis.chrome?.storage?.local || !globalThis.chrome?.runtime?.sendMessage) return;

// ---- 遊戲頁：看到一塊帶 X 的字元圖，問 background 裡面是哪一招，是的話就抓 ----
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
  const found = [...content.querySelectorAll('span.X')].filter(span => !done.has(span) && !isOwn(span));
  try {
    for (const trigger of found) {
      if (done.has(trigger)) continue;
      const run = runAround(trigger);
      run.forEach(span => done.add(span));
      const spans = run.map(span => ({ text: span.textContent, classes: [...span.classList] }));
      const text = blockText(spans);
      const reply = await chrome.runtime.sendMessage({ type: 'MOVE_FIND', text, quoted: quotedIn(text) });
      if (!reply?.ok || !reply.found) continue;
      const learned = buildArt(spans, reply.found.skill, reply.found.move);
      if (!learned) continue;
      const { moveArts } = await chrome.storage.local.get('moveArts');
      const next = addCapture(moveArts, learned);
      if (next) await chrome.storage.local.set({ moveArts: next });
    }
  } catch {
    // 連不上 background 或儲存（孤兒程式）：什麼都不做
  }
}

const hasX = node => node.nodeType === 1 && !isOwn(node) && (isX(node) || Boolean(node.querySelector?.('span.X')));
new MutationObserver(records => {
  if (!records.some(record => Array.from(record.addedNodes).some(hasX))) return;
  clearTimeout(timer);
  timer = setTimeout(scan, SETTLE_MS);
}).observe(content, { subtree: true, childList: true });
})();
