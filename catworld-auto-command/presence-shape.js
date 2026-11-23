(() => {
// 真人驗證圖（「請點選和左側範例相同的圖形」）的形狀比對：找出和範例同形狀的是哪一個候選圖形，回傳它的中心座標。只算位置，不點擊。
// 核心函式（matchImage 以上）只吃 { width, height, data }（data 是 RGBA，和 canvas 的 ImageData 同格式），不碰 DOM、檔案與網路；
// 檔尾是 CLI：讀 PNG 檔，或讀驗證碼收集表（CSV 檔／Google 試算表分頁網址）裡結果為 presence 的列內嵌的圖。
//
// 圖的版面：淺色底，左側一個 1px 細線方框裡是範例圖形，框外散著幾個候選圖形（顏色、大小、角度都和範例不同），另有 1px 的雜訊線與雜訊點。
// 「相同」指形狀相同，不看顏色與角度。
// 流程：和底色差得夠多的像素當前景 → 開運算清掉細線、雜點與方框 → 連通區塊就是各個圖形 → 方框內的是範例、其餘是候選
//   → 每個圖形算「質心到邊界的距離隨角度的變化」的頻譜振幅（不受旋轉、大小影響）加上實心度（面積／凸包面積）→ 和範例最接近的候選就是答案。
// 用法：node tools/presence-shape.js <png 檔｜csv 檔｜試算表網址> [...] [--debug]
//   每張圖印一行：名稱、該點的座標（圖片像素）、範例位置、最近與次近的距離；--debug 另外印出每個候選的中心與距離。

const BG_DISTANCE = 60; // 和底色的 RGB 距離超過這個值才算前景
// 開運算的 5x5 橢圓核：雜訊線、方框線都是 1px，圖形邊長 25px 以上
const OPEN_KERNEL = [[0, -2], [-2, -1], [-1, -1], [0, -1], [1, -1], [2, -1], [-2, 0], [-1, 0], [0, 0], [1, 0], [2, 0], [-2, 1], [-1, 1], [0, 1], [1, 1], [2, 1], [0, 2]];
const MIN_AREA = 150; // 開運算後殘留的碎片面積遠小於圖形
const BOX_DARK = 110; // 方框線是深灰色：RGB 三個值都低於這個才算
const BOX_LINE_RATIO = 0.6; // 方框的直線：整欄有這個比例以上是深色像素
const ANGLE_BINS = 72;
const HARMONICS = 12;
const SOLIDITY_WEIGHT = 2; // 星形、十字的實心度明顯低於凸多邊形，和頻譜一起比才分得開

// ---------- 前景遮罩 ----------

// 底色取整張圖每個色版的中位數
function backgroundColor({ width, height, data }) {
  const half = (width * height) / 2;
  return [0, 1, 2].map(channel => {
    const hist = new Uint32Array(256);
    for (let i = channel; i < data.length; i += 4) hist[data[i]] += 1;
    let seen = 0;
    for (let v = 0; v < 256; v++) { seen += hist[v]; if (seen >= half) return v; }
    return 255;
  });
}

// 腐蝕（keep = true：核內全是前景才留）或膨脹（核內有前景就算）。圖外的格子不影響結果
function morph(mask, width, height, erode) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let hit = erode;
      for (const [dx, dy] of OPEN_KERNEL) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        if (mask[ny * width + nx] !== (erode ? 1 : 0)) { hit = !erode; break; }
      }
      out[y * width + x] = hit ? 1 : 0;
    }
  }
  return out;
}

// 回傳 Uint8Array 遮罩（1 = 圖形）
function foreground(img) {
  const { width, height, data } = img;
  const [br, bg, bb] = backgroundColor(img);
  const mask = new Uint8Array(width * height);
  for (let p = 0; p < mask.length; p++) {
    const dr = data[p * 4] - br, dg = data[p * 4 + 1] - bg, db = data[p * 4 + 2] - bb;
    mask[p] = Math.sqrt(dr * dr + dg * dg + db * db) > BG_DISTANCE ? 1 : 0;
  }
  return morph(morph(mask, width, height, true), width, height, false);
}

// 範例方框左右兩條直線的 x 座標
function exampleBox({ width, height, data }) {
  const cols = [];
  for (let x = 0; x < width; x++) {
    let dark = 0;
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 4;
      if (Math.max(data[i], data[i + 1], data[i + 2]) < BOX_DARK) dark += 1;
    }
    if (dark / height >= BOX_LINE_RATIO) cols.push(x);
  }
  if (cols.length < 2) throw new Error('找不到範例方框的兩條直線');
  return [cols[0], cols[cols.length - 1]];
}

// ---------- 圖形與特徵 ----------

// 八方向連通區塊，回傳每個區塊的像素索引陣列
function components(mask, width, height) {
  const seen = new Uint8Array(mask.length);
  const out = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const pixels = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop();
      pixels.push(p);
      const x = p % width, y = (p - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const q = ny * width + nx;
          if (mask[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
        }
      }
    }
    out.push(pixels);
  }
  return out;
}

// 凸包面積（Andrew monotone chain + 鞋帶公式）
function hullArea(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = list => {
    const chain = [];
    for (const p of list) {
      while (chain.length >= 2 && cross(chain[chain.length - 2], chain[chain.length - 1], p) <= 0) chain.pop();
      chain.push(p);
    }
    chain.pop();
    return chain;
  };
  const hull = [...half(pts), ...half(pts.reverse())];
  let area = 0;
  hull.forEach((p, i) => { const q = hull[(i + 1) % hull.length]; area += p[0] * q[1] - q[0] * p[1]; });
  return Math.abs(area) / 2;
}

// 一個連通區塊 → { center, area, feature }。
// feature 不受旋轉、大小影響：各角度最遠邊界距離（除以平均）的頻譜振幅（第 1～HARMONICS 諧波），再接上加權的實心度
function describeShape(pixels, mask, width, height) {
  let sx = 0, sy = 0;
  for (const p of pixels) { sx += p % width; sy += Math.floor(p / width); }
  const cx = sx / pixels.length, cy = sy / pixels.length;

  const profile = new Array(ANGLE_BINS).fill(0);
  const corners = [];
  for (const p of pixels) {
    const x = p % width, y = (p - x) / width;
    const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1
      || !mask[p - 1] || !mask[p + 1] || !mask[p - width] || !mask[p + width];
    if (!edge) continue;
    const bin = Math.floor(((Math.atan2(y - cy, x - cx) + Math.PI) / (2 * Math.PI)) * ANGLE_BINS) % ANGLE_BINS;
    profile[bin] = Math.max(profile[bin], Math.hypot(x - cx, y - cy));
    corners.push([x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]); // 用像素的四個角算凸包，面積才和像素數同一個基準
  }
  // 邊界點稀疏的角度用左右最近的有值角度內插
  const filled = profile.map((value, bin) => {
    if (value) return value;
    let left = 1, right = 1;
    while (!profile[(bin - left + ANGLE_BINS) % ANGLE_BINS]) left += 1;
    while (!profile[(bin + right) % ANGLE_BINS]) right += 1;
    const a = profile[(bin - left + ANGLE_BINS) % ANGLE_BINS], b = profile[(bin + right) % ANGLE_BINS];
    return a + ((b - a) * left) / (left + right);
  });
  const mean = filled.reduce((a, b) => a + b, 0) / ANGLE_BINS;
  const feature = [];
  for (let k = 1; k <= HARMONICS; k++) {
    let re = 0, im = 0;
    filled.forEach((value, n) => {
      const angle = (-2 * Math.PI * k * n) / ANGLE_BINS;
      re += (value / mean) * Math.cos(angle);
      im += (value / mean) * Math.sin(angle);
    });
    feature.push(Math.hypot(re, im) / ANGLE_BINS);
  }
  feature.push((SOLIDITY_WEIGHT * pixels.length) / hullArea(corners));
  return { center: [Math.round(cx), Math.round(cy)], area: pixels.length, feature };
}

const distance = (a, b) => Math.sqrt(a.reduce((sum, value, i) => sum + (value - b[i]) ** 2, 0));

// 結果：{ example:{ center }, candidates:[{ center, distance }]（距離小的在前）, best:{ center, distance } }。
// 座標是圖片像素；方框內不是剛好一個圖形、或框外沒有圖形時丟例外（不是這種驗證圖，或版面變了）
function matchImage(img) {
  const { width, height } = img;
  const [x0, x1] = exampleBox(img);
  const mask = foreground(img);
  const shapes = components(mask, width, height)
    .filter(pixels => pixels.length >= MIN_AREA)
    .map(pixels => describeShape(pixels, mask, width, height));
  const inBox = shape => shape.center[0] > x0 && shape.center[0] < x1;
  const inside = shapes.filter(inBox);
  const outside = shapes.filter(shape => !inBox(shape));
  if (inside.length !== 1 || !outside.length) {
    throw new Error(`方框內要剛好一個範例、框外至少一個候選（框內 ${inside.length}、框外 ${outside.length}）`);
  }
  const candidates = outside
    .map(shape => ({ center: shape.center, distance: distance(shape.feature, inside[0].feature) }))
    .sort((a, b) => a.distance - b.distance);
  return { example: { center: inside[0].center }, candidates, best: candidates[0] };
}

globalThis.CatworldPresenceShape = { matchImage, foreground, exampleBox };
})();
