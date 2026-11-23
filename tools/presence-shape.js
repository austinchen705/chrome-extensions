// 圖形辨識核心與 extension 共用；這裡保留 PNG 解碼與 CLI。
require('../catworld-auto-command/presence-shape');
const { matchImage, foreground, exampleBox } = globalThis.CatworldPresenceShape;

// ---------- Node 專用：PNG 解碼、收集表 ----------

// 8 位元、非交錯的 PNG（灰階、RGB、調色盤、RGBA）→ { width, height, data: RGBA }
function decodePng(buffer) {
  const zlib = require('node:zlib');
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let width = 0, height = 0, colorType = 0, palette = null;
  const idat = [];
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      colorType = body[9];
      if (body[8] !== 8 || body[12] !== 0 || ![0, 2, 3, 6].includes(colorType)) throw new Error('只支援 8 位元、非交錯的 PNG');
    } else if (type === 'PLTE') palette = body;
    else if (type === 'IDAT') idat.push(body);
    offset += 12 + length;
  }
  const bpp = { 0: 1, 2: 3, 3: 1, 6: 4 }[colorType];
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? pixels[y * stride + i - bpp] : 0;
      const up = y ? pixels[(y - 1) * stride + i] : 0;
      const upLeft = y && i >= bpp ? pixels[(y - 1) * stride + i - bpp] : 0;
      let predict = 0;
      if (filter === 1) predict = left;
      else if (filter === 2) predict = up;
      else if (filter === 3) predict = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        predict = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      pixels[y * stride + i] = (raw[y * (stride + 1) + 1 + i] + predict) & 255;
    }
  }
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const src = colorType === 3 ? palette.subarray(pixels[p] * 3, pixels[p] * 3 + 3) : pixels.subarray(p * bpp, p * bpp + bpp);
    data[p * 4] = src[0];
    data[p * 4 + 1] = colorType === 0 ? src[0] : src[1];
    data[p * 4 + 2] = colorType === 0 ? src[0] : src[2];
    data[p * 4 + 3] = colorType === 6 ? src[3] : 255;
  }
  return { width, height, data };
}

// Google 試算表的網址換成該分頁（gid）的 CSV 匯出網址
function sheetCsvUrl(url) {
  const doc = /\/spreadsheets\/d\/([\w-]+)/.exec(url);
  if (!doc) return url;
  const gid = /[?&#]gid=(\d+)/.exec(url);
  return `https://docs.google.com/spreadsheets/d/${doc[1]}/export?format=csv${gid ? `&gid=${gid[1]}` : ''}`;
}

// 收集表 CSV 裡結果為 presence 的列內嵌的驗證圖：[{ name, image }]，name 是試算表的列號
function imagesFromSheet(csvText) {
  require('../catworld-auto-command/shared-data');
  const [header, ...rows] = globalThis.CatworldSharedData.parseCsv(csvText);
  const outcome = header.indexOf('結果'), html = header.indexOf('HTML');
  const out = [];
  rows.forEach((row, i) => {
    if (row[outcome] !== 'presence') return;
    const found = /id="presence_image"[^>]*?src="data:image\/png;base64,([A-Za-z0-9+/=]+)"/.exec(row[html] || '');
    if (found) out.push({ name: `row${i + 2}`, image: decodePng(Buffer.from(found[1], 'base64')) });
  });
  return out;
}

async function main(args) {
  const fs = require('node:fs');
  const debug = args.includes('--debug');
  const sources = args.filter(a => !a.startsWith('--'));
  if (!sources.length) {
    console.error('用法：node tools/presence-shape.js <png 檔｜csv 檔｜試算表網址> [...] [--debug]');
    return 2;
  }
  for (const source of sources) {
    let images;
    if (/^https?:\/\//.test(source)) {
      const res = await fetch(sheetCsvUrl(source));
      if (!res.ok) throw new Error(`下載失敗（${res.status}）：${source}`);
      images = imagesFromSheet(await res.text());
    } else if (/\.csv$/i.test(source)) images = imagesFromSheet(fs.readFileSync(source, 'utf8'));
    else images = [{ name: source, image: decodePng(fs.readFileSync(source)) }];
    for (const { name, image } of images) {
      const { example, candidates, best } = matchImage(image);
      const second = candidates[1] ? `、次近 ${candidates[1].distance.toFixed(3)}` : '';
      console.log(`${name}\t點 (${best.center.join(', ')})\t範例在 (${example.center.join(', ')})\t最近 ${best.distance.toFixed(3)}${second}`);
      if (debug) for (const c of candidates) console.error(`  (${c.center.join(', ')})\t${c.distance.toFixed(3)}`);
    }
  }
  return 0;
}

module.exports = { matchImage, foreground, exampleBox, decodePng, sheetCsvUrl, imagesFromSheet };

if (require.main === module) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, err => { console.error(err.message); process.exitCode = 1; });
}
