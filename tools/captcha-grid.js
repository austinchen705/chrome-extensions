// 驗證碼數字的格子模板比對：解「背景色空白 span 拼成數字」的驗證碼 HTML，直接讀出數字，不用 OCR。
// 不碰 DOM 與網路，輸入是遊戲輸出的 HTML 字串，輸出數字字串；與 captcha-art.js 的「偵測」分工，這裡只管「辨識」。
// 這是 Node 端的 CommonJS 工具；extension 載入的是純 script（captcha-art.js 的 globalThis IIFE 寫法），要進 extension 得照那個模式包一層、
// 加進 manifest 與 popup 備援注入的清單（tests/injection-lists.test.js 會比對）。
//
// 流程：span 內的空白是背景色方塊、每個字元佔一格 → 填色面積過半視為反相（整片填色、數字是空洞）
//   → 以空欄切出每個數字 → 整數倍縮減 → 先查精確模板庫（LIBRARY），查不到再用 5x7 標準字型做模糊比對。
// 數字字形尺寸會變（同一個 6 看過 5x5、4x7、5x8、6x7），所以模板庫以整個矩陣為鍵、不限尺寸。
// 認不出的字形回 `?`；CLI 加 --debug 會印出矩陣，確認後貼進 LIBRARY 就能擴充（樣本照 CLAUDE.md 先放進 tests/fixtures/captcha/）。
//
// 用法：node tools/captcha-grid.js <html 檔> [...] [--debug]

const row = s => s.split('').map(c => c === 'X');
const key = rows => rows.join('\n');

// 精確模板庫：鍵是 ASCII 列（X＝有方塊）以換行相接，值是數字
const LIBRARY = new Map([
  [key(['.XXX.', 'X....', 'XXXX.', 'X...X', '.XXX.']), '6'],
  [key(['.XXX.', 'X...X', '.XXX.', 'X...X', '.XXX.']), '8'],
  [key(['.XX.', 'X..X', '...X', '.XX.', '...X', 'X..X', '.XX.']), '3'],
  [key(['.XXXX.', 'X....X', '.....X', '..XXX.', '.....X', 'X....X', '.XXXX.']), '3'],
  [key(['..XXX.', '.X....', 'X.....', 'XXXXX.', 'X....X', 'X....X', '.XXXX.']), '6'],
  [key(['.XXXX.', '.X..X.', 'X....X', 'X....X', 'X....X', 'X....X', '.X..X.', '.XXXX.']), '0'],
  [key(['.XXXX.', 'X....X', 'X....X', '.XXXX.', 'X....X', 'X....X', 'X....X', '.XXXX.']), '8'],
  [key(['..XXX', '.X...', '.X...', 'XXXX.', 'X...X', 'X...X', 'X...X', '.XXX.']), '6'],
  [key(['.XXXX.', 'X....X', 'X....X', 'X....X', '.XXXXX', '.....X', '....X.', '.XXX..']), '9'],
  [key(['.XX.', 'X..X', 'X...', 'XXX.', 'X..X', 'X..X', '.XX.']), '6'],
  [key(['.XXXXX.', 'X.....X', '......X', '.XXXXX.', 'X......', 'X......', 'XXXXXXX']), '2'],
  [key(['.XXXX.', 'X....X', 'X....X', 'X....X', 'X....X', 'X....X', '.XXXX.']), '0'],
  [key(['...XX.', '..X.X.', '.X..X.', 'XXXXXX', '....X.']), '4'],
  [key(['..XX.', '.XXX.', 'X.XX.', 'X.XX.', 'XXXXX', '..XX.', '..XX.']), '4'],
]);

// 模糊比對用的 5x7 標準像素字型（圓角風格，與觀察到的字形同一家族）
const CANONICAL_5x7 = {
  0: ['.XXX.', 'X...X', 'X...X', 'X...X', 'X...X', 'X...X', '.XXX.'],
  1: ['..X..', '.XX..', '..X..', '..X..', '..X..', '..X..', '.XXX.'],
  2: ['.XXX.', 'X...X', '....X', '..XX.', '.X...', 'X....', 'XXXXX'],
  3: ['.XXX.', 'X...X', '....X', '..XX.', '....X', 'X...X', '.XXX.'],
  4: ['...X.', '..XX.', '.X.X.', 'X..X.', 'XXXXX', '...X.', '...X.'],
  5: ['XXXXX', 'X....', 'XXXX.', '....X', '....X', 'X...X', '.XXX.'],
  6: ['.XXX.', 'X....', 'X....', 'XXXX.', 'X...X', 'X...X', '.XXX.'],
  7: ['XXXXX', '....X', '...X.', '..X..', '.X...', '.X...', '.X...'],
  8: ['.XXX.', 'X...X', 'X...X', '.XXX.', 'X...X', 'X...X', '.XXX.'],
  9: ['.XXX.', 'X...X', 'X...X', '.XXXX', '....X', '....X', '.XXX.'],
};

const FUZZY_MIN_SCORE = 0.8;
const FUZZY_MIN_MARGIN = 0.04;

// ---------- HTML 解析 ----------

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

// span 內的空白是背景色方塊、每個字元佔一格；span 可能跨行，所以走整份 token 流。回傳補齊寬度的 bool[][]
function filledCellsFromHtml(html) {
  const rows = [[]];
  let inside = false;
  for (const tok of html.split(/(<[^>]+>)/)) {
    if (tok.startsWith('<')) {
      if (tok.startsWith('<span')) inside = true;
      else if (tok.startsWith('</span')) inside = false;
      continue;
    }
    for (const ch of decode(tok)) {
      if (ch === '\n') rows.push([]);
      else rows[rows.length - 1].push(inside && /\s/.test(ch));
    }
  }
  const width = Math.max(0, ...rows.map(r => r.length));
  return rows.map(r => Array.from({ length: width }, (_, i) => r[i] === true));
}

// 數字方塊的佔用矩陣。填色面積超過外框一半視為反相（整片背景填色、數字是空洞）
function occupancyFromHtml(html) {
  const filled = filledCellsFromHtml(html);
  let y0 = Infinity, y1 = -1, x0 = Infinity, x1 = -1, count = 0;
  filled.forEach((r, y) => r.forEach((v, x) => {
    if (!v) return;
    count++;
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
  }));
  if (count === 0 || count / ((y1 - y0 + 1) * (x1 - x0 + 1)) <= 0.5) return filled;
  // 反相：只取同一列左右兩側都有填色的空格，複製的片段若被截斷、框外的空白才不會被算進去
  return filled.map(r => {
    const hasLeft = [];
    let acc = false;
    for (let i = 0; i < r.length; i++) { acc = acc || r[i]; hasLeft.push(acc); }
    const out = new Array(r.length).fill(false);
    acc = false;
    for (let i = r.length - 1; i >= 0; i--) { acc = acc || r[i]; out[i] = !r[i] && hasLeft[i] && acc; }
    return out;
  });
}

// ---------- 矩陣處理 ----------

function runs(arr) {
  const out = [];
  let start = null;
  for (let i = 0; i <= arr.length; i++) {
    const v = i < arr.length && arr[i];
    if (v && start === null) start = i;
    if (!v && start !== null) { out.push([start, i]); start = null; }
  }
  return out;
}

// 以空欄切出每個數字的佔用矩陣（未縮減）。字形內部若有整欄空白會被切開，目前樣本沒有
function glyphsFromOccupancy(occ) {
  if (!occ.length) return [];
  const colAny = occ[0].map((_, i) => occ.some(r => r[i]));
  return runs(colAny).map(([s, e]) => {
    const sub = occ.map(r => r.slice(s, e));
    const rowAny = sub.map(r => r.some(Boolean));
    return sub.slice(rowAny.indexOf(true), rowAny.lastIndexOf(true) + 1);
  });
}

// 若矩陣是某個小矩陣的 k 倍放大（每個 k×k 區塊同值），縮回原尺寸
function reduceScale(m) {
  const h = m.length, w = m[0].length;
  for (let k = Math.min(h, w); k > 1; k--) {
    if (h % k || w % k) continue;
    let uniform = true;
    for (let y = 0; y < h && uniform; y++) {
      for (let x = 0; x < w; x++) if (m[y][x] !== m[y - (y % k)][x - (x % k)]) { uniform = false; break; }
    }
    if (uniform) {
      const out = [];
      for (let y = 0; y < h; y += k) out.push(m[y].filter((_, x) => x % k === 0));
      return out;
    }
  }
  return m;
}

const toAscii = m => m.map(r => r.map(v => (v ? 'X' : '.')).join(''));

// 面積平均縮放（等同 PIL 的 BOX）：把 5x7 模板縮放到觀察矩陣的尺寸，每格是被覆蓋面積的比例
function boxResize(tpl, w, h) {
  const th = tpl.length, tw = tpl[0].length;
  const out = [];
  for (let j = 0; j < h; j++) {
    const r = [];
    const ya = (j * th) / h, yb = ((j + 1) * th) / h;
    for (let i = 0; i < w; i++) {
      const xa = (i * tw) / w, xb = ((i + 1) * tw) / w;
      let sum = 0;
      for (let ty = Math.floor(ya); ty < Math.ceil(yb); ty++) {
        const oy = Math.min(yb, ty + 1) - Math.max(ya, ty);
        for (let tx = Math.floor(xa); tx < Math.ceil(xb); tx++) {
          if (tpl[ty][tx]) sum += oy * (Math.min(xb, tx + 1) - Math.max(xa, tx));
        }
      }
      r.push(sum / ((yb - ya) * (xb - xa)));
    }
    out.push(r);
  }
  return out;
}

// 回傳 { digit, score, margin }：最佳數字、相似分數（1 為完全相同）、與第二名的差距
function fuzzyMatch(m) {
  const h = m.length, w = m[0].length;
  const scores = Object.entries(CANONICAL_5x7).map(([digit, rows]) => {
    const tpl = boxResize(rows.map(row), w, h);
    let diff = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) diff += Math.abs((m[y][x] ? 1 : 0) - tpl[y][x]);
    return { digit, score: 1 - diff / (w * h) };
  });
  scores.sort((a, b) => b.score - a.score);
  return { digit: scores[0].digit, score: scores[0].score, margin: scores[0].score - scores[1].score };
}

function classify(matrix, useLibrary = true) {
  const m = reduceScale(matrix);
  if (useLibrary) {
    const hit = LIBRARY.get(key(toAscii(m)));
    if (hit !== undefined) return { char: hit, matrix: m, confident: true, score: 1 };
  }
  const { digit, score, margin } = fuzzyMatch(m);
  const confident = score >= FUZZY_MIN_SCORE && margin >= FUZZY_MIN_MARGIN;
  return { char: confident ? digit : '?', matrix: m, confident, score };
}

// 主要入口：{ text, digits:[{ char, matrix, confident, score }] }；text 裡的 `?` 代表認不出的字形
function decodeHtml(html, { useLibrary = true } = {}) {
  const digits = glyphsFromOccupancy(occupancyFromHtml(html)).map(g => classify(g, useLibrary));
  return { text: digits.map(d => d.char).join(''), digits };
}

module.exports = {
  LIBRARY, CANONICAL_5x7, FUZZY_MIN_SCORE, FUZZY_MIN_MARGIN,
  filledCellsFromHtml, occupancyFromHtml, glyphsFromOccupancy, reduceScale, toAscii, fuzzyMatch, classify, decodeHtml,
};

if (require.main === module) {
  const fs = require('fs');
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
}
