// 驗證碼數字的格子模板比對：「背景色 span 拼成數字」的驗證碼，直接讀出數字，不用 OCR。
// content script 與測試、tools/captcha-grid.js（CLI）共用，不碰 DOM 與網路；與 captcha-art.js 的「偵測」分工，這裡只管「辨識」。
// 輸入是遊戲輸出的 HTML 字串（content.js 把新增節點的 outerHTML 接起來）。
//
// 流程：背景色（class 含 B1～B9）span 裡的每個字元是一格方塊，不管是空白還是亂碼文字 → 填色面積過半視為反相（整片填色、數字是空洞）
//   → 以空欄切出每個數字 → 整數倍縮減 → 先查精確模板庫（LIBRARY），查不到再用 5x7 標準字型做模糊比對。
// 數字字形尺寸會變（同一個 6 看過 5x5、4x7、5x8、6x7、7x7），所以模板庫以整個矩陣為鍵、不限尺寸。
// 認不出的字形回 `?`；CLI 加 --debug 會印出矩陣，確認後貼進 LIBRARY 就能擴充（樣本照 CLAUDE.md 先放進 tests/fixtures/captcha/）。
(() => {
if (!globalThis.CatworldCaptchaGrid) {
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
    [key(['.XXXX.', 'X....X', '.....X', '..XXX.', '.....X', '.....X', 'X....X', '.XXXX.']), '3'],
    [key(['.XXX.', 'X...X', 'X...X', 'X...X', '.XXX.']), '0'],
    [key(['.XXXXX.', 'X......', 'X......', 'XXXXXX.', 'X.....X', 'X.....X', '.XXXXX.']), '6'],
    [key(['.XXXX.', 'X....X', 'X....X', 'X....X', 'X....X', 'X....X', 'X....X', '.XXXX.']), '0'],
    [key(['XXXXXX', 'X.....', 'X.....', 'XXXXX.', '.....X', '.....X', 'X....X', '.XXXX.']), '5'],
    [key(['..XX.', '..XX.', '.X.X.', 'X..X.', 'XXXXX', '...X.', '...X.', '..XXX']), '4'],
    [key(['.X.', 'XX.', '.X.', '.X.', '.X.', '.X.', 'XXX']), '1'],
    [key(['..XXX.', '.X...X', '.X...X', '.X...X', '..XXXX', '....X.', 'X...X.', '.XXX..']), '9'],
    [key(['XXXX', 'X..X', '..XX', '.XX.', 'XX..', 'XXXX']), '2'],
    [key(['XXXXX', 'XX...', 'XX...', 'XXXX.', '....X', 'X...X', '.XXX.']), '5'],
    [key(['..XXX..', '.X...X.', 'X.....X', 'X.....X', 'X.....X', '.X...X.', '..XXX..']), '0'],
    [key(['X......', 'X....X.', 'X....X.', 'X....X.', 'XXXXXXX', '.....X.', '.....X.']), '4'],
    [key(['XXXXXX', 'X.....', 'X.....', 'XXXXX.', '.....X', '.....X', 'XXXXX.']), '5'],
    [key(['.....X', '....XX', '...X.X', '..X.X.', '.X..X.', 'XXXXXX', '...X..', '...X..']), '4'],
    // 94227 那一輪領獎（三種畫法互相印證）：2 的 4x7／5x5／6x7、7 的 4x7（左上有短撇）／5x8／6x7、9 的 7x7、4 的 5x6
    [key(['.XX.', 'X..X', '...X', '..X.', '.X..', 'X...', 'XXXX']), '2'],
    [key(['XXXX.', '....X', '.XXX.', 'X....', 'XXXXX']), '2'],
    [key(['.XXXX.', 'X....X', '....X.', '...X..', '..X...', '.X....', 'XXXXXX']), '2'],
    [key(['XXXX', 'X..X', '..X.', '..X.', '.X..', '.X..', '.X..']), '7'],
    [key(['XXXXX', '....X', '...X.', '..X..', '..X..', '.X...', 'X....', 'X....']), '7'],
    [key(['XXXXXX', '.....X', '....X.', '....X.', '...X..', '...X..', '..X...']), '7'],
    [key(['.XXXXX.', 'X.....X', 'X.....X', '.XXXXXX', '......X', 'X.....X', '.XXXXX.']), '9'],
    [key(['..XX.', '.XXX.', 'XX.X.', 'XXXXX', '...X.', '...X.']), '4'],
    // 1595 那一輪領獎（反相圖）：1 的 2x7，只有一撇加直豎、沒有底橫
    [key(['.X', 'XX', '.X', '.X', '.X', '.X', '.X']), '1'],
    // 648 那一輪領獎（反相亂碼圖與 $ 符號圖互相印證）：4 的 6x8（底部有短橫腳）／6x7、8 的 7x7／6x8（斜體）
    [key(['....X.', '...XX.', '..X.X.', '..X.X.', '.X..X.', 'XXXXXX', '....X.', '...XXX']), '4'],
    [key(['....X.', '...XX.', '..X.X.', '.X..X.', 'XXXXXX', '....X.', '...XXX']), '4'],
    [key(['.XXXXX.', 'X.....X', 'X.....X', '.XXXXX.', 'X.....X', 'X.....X', '.XXXXX.']), '8'],
    [key(['..XXX.', '.X...X', '.X...X', '.XXXX.', '.X..X.', 'X...X.', 'X...X.', '.XXX..']), '8'],
    // 394 那一輪領獎（四種畫法互相印證）：3 的 6x8（斜體）／7x7／5x5、9 的 5x8（斜體）／5x5、4 的 4x7；381（亂碼圖）：8 的 4x7
    [key(['..XXX.', '.X...X', '.....X', '..XXX.', '....X.', '....X.', 'X...X.', '.XXX..']), '3'],
    [key(['.XXXXX.', 'X.....X', '......X', '.XXXXX.', '......X', 'X.....X', '.XXXXX.']), '3'],
    [key(['XXXX.', '....X', '.XXX.', '....X', 'XXXX.']), '3'],
    [key(['.XXX.', 'X..XX', 'X...X', 'X...X', '.XXXX', '....X', 'X..X.', 'XXX..']), '9'],
    [key(['.XXX.', 'X...X', '.XXXX', '....X', '.XXX.']), '9'],
    [key(['..X.', '.XX.', '.XX.', 'X.X.', 'XXXX', '..X.', '.XXX']), '4'],
    [key(['.XX.', 'X..X', 'X..X', '.XX.', 'X..X', 'X..X', '.XX.']), '8'],
    // 058 那一輪（一般的 B6 方塊圖）：5 的 4x8、8 的 5x8（右下角多一格）
    [key(['XXXX', 'X...', 'X...', 'XXX.', '..XX', '...X', 'X..X', 'XXX.']), '5'],
    [key(['.XXX.', 'X...X', 'X...X', '.XXX.', 'X..XX', 'X...X', 'X...X', '.XXX.']), '8'],
    // 03865／01565／42965 三輪領獎：3 的 4x8、1 的 2x8（沒有底橫）、5 的 7x7、2 的 5x7（粗體）
    [key(['XXX.', 'X..X', '...X', '.XX.', '...X', '...X', 'X..X', 'XXX.']), '3'],
    [key(['.X', 'XX', '.X', '.X', '.X', '.X', '.X', '.X']), '1'],
    [key(['XXXXXXX', 'X......', 'X......', 'XXXXXX.', '......X', 'X.....X', '.XXXXX.']), '5'],
    [key(['.XXX.', 'XX.XX', '...XX', '..XX.', '.XX..', 'XX...', 'XXXXX']), '2'],
    // 2713／52082／671／7576／032 五輪領獎（收集表）：1 的 5x7（之前只靠模糊比對）、5 的 4x6（52082 第一張圖與 7576 互相印證）、
    // 2 的 6x8（斜體）、6 的 6x8（斜體）、1 的 4x7（粗體）、7 的 6x8（第二列右端多一格）、0 的 6x8（中間有斜線）
    [key(['..X..', '.XX..', 'X.X..', '..X..', '..X..', '..X..', 'XXXXX']), '1'],
    [key(['XXXX', 'X...', 'XXXX', '...X', '...X', 'XXX.']), '5'],
    [key(['..XXX.', '.X...X', '.....X', '....X.', '..XX..', '.X....', 'X.....', 'XXXXX.']), '2'],
    [key(['..XXX.', '.X....', 'X.....', 'XXXXX.', 'X....X', 'X....X', 'X....X', '.XXXX.']), '6'],
    [key(['..XX', 'XXXX', '..XX', '..XX', '..XX', '..XX', '..XX']), '1'],
    [key(['XXXXXX', 'X....X', '....X.', '....X.', '...X..', '...X..', '..X...', '..X...']), '7'],
    [key(['..XXX.', '.XX..X', '.X...X', 'X....X', 'X....X', 'X...X.', 'X..XX.', '.XXX..']), '0'],
    // 2425／814 兩輪（亂碼圖，收集表）：5 的 6x8（斜體）、1 的 4x6
    [key(['..XXXX', '..X...', '.X....', '.XXXX.', '.....X', 'X....X', 'X...X.', '.XXX..']), '5'],
    [key(['..X.', 'XXX.', '..X.', '..X.', '..X.', 'XXXX']), '1'],
    // 496（@ 符號圖）／82705 兩輪領獎（收集表）：9 的 6x7、7 的 5x8（斜線在左半）
    [key(['.XXXX.', 'X....X', 'X....X', '.XXXXX', '.....X', '....X.', '.XXX..']), '9'],
    [key(['XXXXX', '....X', '...X.', '..X..', '.XX..', '.X...', 'XX...', 'X....']), '7'],
    // 93920（亂碼標亮圖）／51301（同一個答案畫了亂碼標亮圖和 @ 符號圖各一張，互相印證）：9 的 4x7、1 的 3x8（有底橫）、5 的 5x5、1 的 2x5（只有 5 列高）
    [key(['.XX.', 'X..X', 'X..X', '.XXX', '...X', 'X..X', '.XX.']), '9'],
    [key(['XX.', '.X.', '.X.', '.X.', '.X.', '.X.', '.X.', 'XXX']), '1'],
    [key(['XXXXX', 'X....', 'XXXX.', '....X', 'XXXX.']), '5'],
    [key(['.X', 'XX', '.X', '.X', '.X']), '1'],
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

  // 模糊比對的門檻偏嚴：分數 0.86 曾把 5 猜成 6，送錯答案比印 `?` 立刻停更糟（錯的答案會送三次）。沒把握就回 `?`，由模板庫補字形
  const FUZZY_MIN_SCORE = 0.9;
  const FUZZY_MIN_MARGIN = 0.04;

  // ---------- 輸入解析：先變成「哪些格子有填色」的 bool[][] ----------

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

  const padRows = rows => {
    const width = Math.max(0, ...rows.map(r => r.length));
    return rows.map(r => Array.from({ length: width }, (_, i) => r[i] === true));
  };

  // 背景色 span 裡的每個字元是一格方塊（空白或亂碼文字都算）；沒有 span、直接用符號畫的圖（@ $ # % & * █，和 captcha-art.js 偵測的同一組）
  // 符號本身是方塊，但只限「整行只有同一種符號和空白」的行，一般輸出裡的 (100%)、+104 才不會變成孤立的方塊。
  // span 可能跨行，所以走整份 token 流。
  // 遊戲輸出整段包在 <span id="message"> 裡、顏色文字也是 span，所以用一個堆疊記每層 span 是不是背景色，只有最內層是背景色才算填色。
  // <br> 與區塊元素的結尾當換行（和 artText 一致）
  const SYMBOL_LINE = /^\s*([@$#%&*█])(?:\s|\1)*$/;
  function filledCellsFromHtml(html) {
    const rows = [{ chars: [], inside: [] }];
    const stack = [];
    for (const tok of html.split(/(<[^>]+>)/)) {
      if (tok.startsWith('<')) {
        if (/^<span\b/i.test(tok)) stack.push(/\bB\d\b/.test(tok));
        else if (/^<\/span\b/i.test(tok)) stack.pop();
        else if (/^<br\b/i.test(tok) || /^<\/(div|p|pre)\b/i.test(tok)) rows.push({ chars: [], inside: [] });
        continue;
      }
      const inside = stack.length > 0 && stack[stack.length - 1];
      for (const ch of decode(tok)) {
        if (ch === '\n') rows.push({ chars: [], inside: [] });
        else {
          rows[rows.length - 1].chars.push(ch);
          rows[rows.length - 1].inside.push(inside);
        }
      }
    }
    return padRows(rows.map(({ chars, inside }) => {
      const outside = chars.map((ch, i) => (inside[i] ? ' ' : ch)).join('');
      const symbol = SYMBOL_LINE.exec(outside)?.[1];
      return chars.map((ch, i) => inside[i] || ch === symbol);
    }));
  }

  // 圖的候選列帶：連續「有填色的列」的各段，填色格多的在前。圖前後幾秒的一般輸出偶爾也有填色格
  // （背景色標出的物品名稱、符號、整片底色的公告橫幅），和圖之間隔著沒有填色的列，不能讓它們影響反相判定或變成假的數字；
  // 填色最多的那段通常就是圖，但圖印完後 1 秒內接著印的公告橫幅會比圖大，所以 decodeHtml 會依序試到有一段整段都認得
  function imageBands(filled) {
    const counts = filled.map(r => r.filter(Boolean).length);
    const bands = [];
    let start = null;
    for (let y = 0; y <= counts.length; y++) {
      if (y < counts.length && counts[y] > 0) { start ??= y; continue; }
      if (start !== null) {
        bands.push({ y0: start, y1: y - 1, total: counts.slice(start, y).reduce((a, b) => a + b, 0) });
        start = null;
      }
    }
    return bands.sort((a, b) => b.total - a.total);
  }

  // 數字方塊的佔用矩陣（預設取填色最多的列帶）。列帶內填色面積超過外框一半視為反相（整片背景填色、數字是空洞）
  function occupancyFrom(filled, band = imageBands(filled)[0]) {
    if (!band) return filled;
    const inBand = filled.map((r, y) => (y >= band.y0 && y <= band.y1 ? r : r.map(() => false)));
    let x0 = Infinity, x1 = -1;
    inBand.forEach(r => r.forEach((v, x) => { if (v) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); } }));
    if (band.total / ((band.y1 - band.y0 + 1) * (x1 - x0 + 1)) <= 0.5) return inBand;
    // 反相：只取同一列左右兩側都有填色的空格，複製的片段若被截斷、框外的空白才不會被算進去
    return inBand.map(r => {
      const hasLeft = [];
      let acc = false;
      for (let i = 0; i < r.length; i++) { acc = acc || r[i]; hasLeft.push(acc); }
      const out = new Array(r.length).fill(false);
      acc = false;
      for (let i = r.length - 1; i >= 0; i--) { acc = acc || r[i]; out[i] = !r[i] && hasLeft[i] && acc; }
      return out;
    });
  }
  const occupancyFromHtml = html => occupancyFrom(filledCellsFromHtml(html));

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

  // 結果：{ text, digits:[{ char, matrix, confident, score }] }；text 裡的 `?` 代表認不出的字形
  function decodeOccupancy(occ, useLibrary) {
    const digits = glyphsFromOccupancy(occ).map(g => classify(g, useLibrary));
    return { text: digits.map(d => d.char).join(''), digits };
  }
  // 依填色多寡試每一段列帶，第一段每個字形都認得的就是圖；都認不出就回填色最多那段的結果（讓呼叫端印出 `?` 的矩陣）
  function decodeHtml(html, { useLibrary = true } = {}) {
    const filled = filledCellsFromHtml(html);
    let first = null;
    for (const band of imageBands(filled)) {
      const result = decodeOccupancy(occupancyFrom(filled, band), useLibrary);
      first ??= result;
      if (result.digits.length && result.digits.every(d => d.confident)) return result;
    }
    return first ?? decodeOccupancy(filled, useLibrary);
  }

  // 認不出時給 console 看的字形矩陣，貼進 LIBRARY 就能擴充
  const describeDigits = digits => digits.map(d => `${d.char} ${d.matrix[0].length}x${d.matrix.length}\n${toAscii(d.matrix).join('\n')}`).join('\n\n');

  globalThis.CatworldCaptchaGrid = {
    LIBRARY, CANONICAL_5x7, FUZZY_MIN_SCORE, FUZZY_MIN_MARGIN,
    filledCellsFromHtml, occupancyFromHtml, glyphsFromOccupancy, reduceScale, toAscii, fuzzyMatch, classify,
    decodeHtml, describeDigits,
  };
}
if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.CatworldCaptchaGrid;
})();
