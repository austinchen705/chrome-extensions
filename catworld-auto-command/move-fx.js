// 招式動畫：招式列表（skill-moves.js）裡點一招，在那一行下面播一段動畫，並把這一招的原文逐字打出來。
// 動畫照原文拼出來，不是每招各畫一個：出招動作看原文裡最早出現的動作字（STRIKES，都沒有就看武功的兵器類別 WEAPON_STRIKE），
// 意象看招式名＋原文裡的字（MOTIFS，依出現先後最多 MAX_LAYERS 層）；顏色、角度、粒子位置由招式名算出來，同一招每次都一樣。
// 人物用「你」「敵」兩個字，全部用 canvas 畫，不用圖檔。點了才播，所以不看系統的「減少動態效果」。讀不到 canvas（jsdom）時只打字。
(() => {
if (globalThis.CatworldMoveFx) return;

const STRIKES = [
  { id: 'qi', label: '劍氣', re: /劍氣|刀氣|氣勁|真氣/ },
  { id: 'sweep', label: '橫掃', re: /橫掃|掃/ },
  { id: 'slash', label: '斬劈', re: /斬|劈|砍|弧線|劃/ },
  { id: 'thrust', label: '突刺', re: /刺|穿透|直取/ },
  { id: 'guard', label: '御劍', re: /擋在|御起/ },
  { id: 'surge', label: '席捲', re: /席捲|巨濤|排空/ },
  { id: 'points', label: '點穴', re: /點穴|點向|指/ },
  { id: 'palm', label: '掌風', re: /掌/ },
  { id: 'fist', label: '拳勁', re: /拳/ },
  { id: 'kick', label: '腿法', re: /腿|踢/ },
  { id: 'staff', label: '棍影', re: /棍|棒|杖/ },
  { id: 'whip', label: '鞭影', re: /鞭/ },
  { id: 'throw', label: '暗器', re: /射|擲|飛鏢|暗器|發出|彈/ },
  { id: 'spin', label: '迴旋', re: /旋|迴轉|圈/ },
];
// 原文裡沒有動作字時，照武功的兵器類別（skills-data.js 的 type）
const WEAPON_STRIKE = { 劍: 'thrust', 刀: 'slash', 杖: 'staff', 鞭: 'whip', 拳掌: 'palm', 暗器: 'throw' };
const DEFAULT_STRIKE = 'thrust';

const MOTIFS = [
  { id: 'snow', label: '飄雪', re: /雪|冰|霜|凍|寒/, z: 'front' },
  { id: 'wind', label: '風', re: /風|嘯/, z: 'front' },
  { id: 'rain', label: '雨', re: /雨/, z: 'front' },
  { id: 'moon', label: '月', re: /月/, z: 'back' },
  { id: 'cloud', label: '雲', re: /雲/, z: 'back' },
  { id: 'mountain', label: '山', re: /山|嶺|峰/, z: 'back' },
  { id: 'light', label: '光', re: /光|晶|皓|芒/, z: 'front' },
  { id: 'wings', label: '羽翼', re: /翼|鴻|鵠|鶴|鷹/, z: 'back' },
  { id: 'wave', label: '浪', re: /濤|浪|海|潮|水/, z: 'front' },
  { id: 'bolt', label: '雷電', re: /雷|電/, z: 'front' },
  { id: 'fire', label: '火', re: /火|焰|炎/, z: 'front' },
  { id: 'blood', label: '血', re: /血/, z: 'front' },
  { id: 'petals', label: '花葉', re: /花|葉/, z: 'front' },
  { id: 'ghost', label: '虛影', re: /影|幻|虛/, z: 'back' },
  { id: 'dragon', label: '龍', re: /龍/, z: 'front' },
  { id: 'claw', label: '爪痕', re: /虎|爪/, z: 'front' },
  { id: 'stars', label: '星', re: /星/, z: 'back' },
];
const MAX_LAYERS = 4;

function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { let a = seed; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const seg = (p, a, b) => clamp((p - a) / (b - a));
const ease = t => 1 - Math.pow(1 - t, 3);
const lerp = (a, b, t) => a + (b - a) * t;

// 一招 → 動畫的組成：{ strike, layers, count, hue, parts, … }；move＝{ name, action, damage, weapon }
function plan(move) {
  const name = String(move?.name ?? '');
  const action = String(move?.action ?? '');
  let strike = null, at = Infinity;
  for (const s of STRIKES) { const i = action.search(s.re); if (i >= 0 && i < at) { at = i; strike = s; } }
  const fallback = WEAPON_STRIKE[move?.weapon] ?? DEFAULT_STRIKE;
  strike = strike || STRIKES.find(s => s.id === fallback);
  const text = `${name}｜${action}`;
  const layers = MOTIFS.map(m => ({ m, i: text.search(m.re) })).filter(f => f.i >= 0).sort((a, b) => a.i - b.i).slice(0, MAX_LAYERS).map(f => f.m);
  const count = /數十|連綿/.test(action) ? 5 : /數劍|數道|幾朵|數招|連環/.test(action) ? 3 : 1;
  const r = rng(hash(name));
  const cold = layers.some(l => l.id === 'snow');
  const base = cold ? 198 : layers.some(l => l.id === 'fire') ? 24 : 44;
  const hue = (base + Math.floor(r() * 40) - 20 + 360) % 360;
  return {
    strike, layers, count, hue, cold, text,
    parts: Array.from({ length: 70 }, () => [r(), r(), r(), r()]),
    tilt: (r() - 0.5) * 0.5, side: r() < 0.5 ? -1 : 1, tempo: 0.9 + r() * 0.25,
    power: clamp((Number.isFinite(move?.damage) ? move.damage : 100) / 470, 0.15, 1),
  };
}

// 原文換成要打出來的字：『招式名』換成名字、『武器』『對手』換成一般的字，拿掉換行
const actionText = (action, name) => String(action ?? '')
  .replace(/『?招式名』?/g, `『${name}』`).replace(/『武器』/g, '兵器').replace(/『對手』/g, '對手').replace(/\\n|\n/g, '');

const DURATION_MS = 3000;
const H = 190;
const FONT = '"Noto Serif TC", "PMingLiU", "Songti TC", serif';
const C = { fg: '#d8d4c8', gold: '#f2c14e', name: '#f3dc96', enemy: '#e2726a', frost: '#cfe3f2', hit: '#ff8a7a' };

// ---------- 畫 ----------
function glyph(S, ch, x, y, color, glow, alpha = 1) {
  const { ctx } = S;
  ctx.save(); ctx.globalAlpha = alpha;
  ctx.font = `900 30px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (glow) { ctx.shadowColor = color; ctx.shadowBlur = glow; }
  ctx.fillStyle = color; ctx.fillText(ch, x, y); ctx.restore();
}
function line(ctx, x1, y1, x2, y2, color, w, blur = 0) {
  ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = w; ctx.lineCap = 'round';
  if (blur) { ctx.shadowColor = color; ctx.shadowBlur = blur; }
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.restore();
}
function crystal(ctx, x, y, r, color, alpha) {
  ctx.save(); ctx.globalAlpha = alpha; ctx.strokeStyle = color; ctx.lineWidth = 1.4;
  for (let k = 0; k < 6; k++) {
    const a = k * Math.PI / 3;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); ctx.stroke();
    const mx = x + Math.cos(a) * r * 0.6, my = y + Math.sin(a) * r * 0.6;
    for (const d of [-0.6, 0.6]) { ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(mx + Math.cos(a + d) * r * 0.3, my + Math.sin(a + d) * r * 0.3); ctx.stroke(); }
  }
  ctx.restore();
}

// 意象層：back 畫在人物後面、front 畫在前面
const LAYER = {
  moon(S, p) {
    const { ctx, W, P } = S; const cx = P.side > 0 ? W * 0.88 : W * 0.12, cy = 34, r = 16;
    ctx.save(); ctx.globalAlpha = seg(p, 0, 0.25);
    ctx.shadowColor = '#fff6d6'; ctx.shadowBlur = 18; ctx.fillStyle = '#f5ecc8';
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0; ctx.fillStyle = '#0d1219';
    ctx.beginPath(); ctx.arc(cx + 7 * P.side, cy - 4, r * 0.92, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  },
  cloud(S, p) {
    const { ctx, W, P } = S;
    ctx.save(); ctx.fillStyle = `rgba(150,165,190,${seg(p, 0, 0.3) * 0.32})`;
    for (let i = 0; i < 4; i++) {
      const q = P.parts[i]; const x = ((q[0] * W + p * 40 * (0.5 + q[1])) % (W + 120)) - 60, y = 18 + q[2] * 40;
      ctx.beginPath(); ctx.ellipse(x, y, 46 + q[3] * 30, 10 + q[1] * 6, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(x + 20, y - 7, 24, 9, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  },
  mountain(S, p) {
    const { ctx, W, P } = S;
    const peaks = [[0.08, 0.38], [0.3, 0.2], [0.55, 0.34], [0.78, 0.16], [1.0, 0.3]].map(([x, y], i) => [x * W + (P.parts[i][0] - 0.5) * 30, H * (y + 0.2 + P.parts[i][1] * 0.1)]);
    ctx.save(); ctx.globalAlpha = seg(p, 0, 0.25); ctx.fillStyle = '#18202b';
    ctx.beginPath(); ctx.moveTo(0, H); peaks.forEach(([x, y]) => ctx.lineTo(x, y)); ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(220,235,255,.18)';
    peaks.forEach(([x, y]) => { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 12, y + 12); ctx.lineTo(x + 12, y + 12); ctx.closePath(); ctx.fill(); });
    ctx.restore();
  },
  wings(S, p) {
    const { ctx, X1, Y } = S; const open = ease(seg(p, 0.08, 0.35)); const flap = Math.sin(seg(p, 0.35, 1) * Math.PI * 3) * 0.12;
    ctx.save(); ctx.strokeStyle = 'rgba(230,240,255,.55)'; ctx.lineWidth = 2; ctx.lineCap = 'round';
    for (const s of [-1, 1]) for (let k = 0; k < 6; k++) {
      const ang = -Math.PI / 2 + s * (0.25 + k * 0.2) * (open + flap), len = 40 + k * 7;
      ctx.beginPath(); ctx.moveTo(X1, Y - 14);
      ctx.quadraticCurveTo(X1 + Math.cos(ang) * len * 0.6 - s * 6, Y - 14 + Math.sin(ang) * len * 0.6, X1 + Math.cos(ang) * len, Y - 14 + Math.sin(ang) * len);
      ctx.stroke();
    }
    ctx.restore();
  },
  ghost(S, p) {
    const { X1, X2, Y } = S; const t = ease(seg(p, 0.15, 0.5)); const fade = 1 - seg(p, 0.55, 0.8);
    if (!t) return;
    for (let k = 1; k <= 3; k++) glyph(S, '你', lerp(X1, X2 - 50, t * k / 3), Y + Math.sin(k * 2.1) * 6, C.gold, 0, 0.22 * fade);
  },
  stars(S, p) {
    const { ctx, W, P } = S; ctx.save(); ctx.fillStyle = '#fff';
    for (let i = 0; i < 18; i++) { const q = P.parts[i]; ctx.globalAlpha = seg(p, 0, 0.3) * (0.3 + 0.7 * Math.abs(Math.sin(p * 9 + q[2] * 6))); ctx.fillRect(q[0] * W, q[1] * 60, 1.6, 1.6); }
    ctx.restore();
  },
  snow(S, p) {
    const { ctx, W, X2, Y, P } = S; const a = seg(p, 0, 0.2);
    ctx.save(); ctx.fillStyle = '#eef7ff';
    for (let i = 0; i < 42; i++) {
      const q = P.parts[i];
      ctx.globalAlpha = a * (0.4 + q[3] * 0.6);
      ctx.beginPath(); ctx.arc(q[0] * W + Math.sin(p * 6 + q[3] * 6) * 8, (q[1] * H + p * H * (0.35 + q[2] * 0.5)) % H, 0.8 + q[2] * 1.8, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    const g = ease(seg(p, 0.56, 0.85));
    if (g > 0) for (let k = 0; k < 3; k++) { const q = P.parts[50 + k]; crystal(ctx, X2 + (q[0] - 0.5) * 46, Y - 6 + (q[1] - 0.5) * 36, g * (6 + q[2] * 6), '#bfe6ff', 0.85); }
  },
  wind(S, p) {
    const { ctx, W, P } = S;
    ctx.save(); ctx.strokeStyle = `rgba(200,225,255,${seg(p, 0.05, 0.25) * 0.4})`; ctx.lineWidth = 1.3; ctx.lineCap = 'round';
    for (let i = 0; i < 12; i++) {
      const q = P.parts[i + 10]; const len = 30 + q[3] * 40;
      const x = ((q[0] * W + p * W * 1.5 * (0.6 + q[2])) % (W + 80)) - 40, y = 14 + q[1] * (H - 40);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + len / 2, y - 4, x + len, y); ctx.stroke();
    }
    ctx.restore();
  },
  rain(S, p) {
    const { ctx, W, P } = S;
    ctx.save(); ctx.strokeStyle = `rgba(160,190,220,${seg(p, 0.1, 0.3) * 0.5})`; ctx.lineWidth = 1;
    for (let i = 0; i < 50; i++) { const q = P.parts[i]; const x = q[0] * W, y = ((q[1] * H + p * H * 3 * (0.7 + q[2])) % (H + 20)) - 10; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 4, y + 12); ctx.stroke(); }
    ctx.restore();
  },
  light(S, p) {
    const { ctx, X1, X2, Y, P } = S; const on = seg(p, 0.3, 0.55);
    if (!on) return;
    ctx.save(); ctx.fillStyle = '#fffbe8'; ctx.globalAlpha = 0.9;
    for (let i = 0; i < 7; i++) {
      const q = P.parts[20 + i]; const x = lerp(X1 + 30, X2, q[0]), y = Y - 30 + q[1] * 40;
      const s = (3 + q[2] * 5) * Math.abs(Math.sin(p * 14 + q[3] * 6)) * on;
      ctx.beginPath();
      ctx.moveTo(x, y - s); ctx.lineTo(x + s * 0.25, y - s * 0.25); ctx.lineTo(x + s, y); ctx.lineTo(x + s * 0.25, y + s * 0.25);
      ctx.lineTo(x, y + s); ctx.lineTo(x - s * 0.25, y + s * 0.25); ctx.lineTo(x - s, y); ctx.lineTo(x - s * 0.25, y - s * 0.25); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  },
  wave(S, p) {
    const { ctx, W } = S; const a = seg(p, 0.05, 0.3);
    const yAt = x => H - 16 + Math.sin(x / 22 + p * 10) * 5 + Math.sin(x / 9 - p * 7) * 2;
    ctx.save(); ctx.globalAlpha = a * 0.45; ctx.fillStyle = '#2f6ea3';
    ctx.beginPath(); ctx.moveTo(0, H); for (let x = 0; x <= W; x += 6) ctx.lineTo(x, yAt(x)); ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = a * 0.6; ctx.strokeStyle = '#cfe8ff'; ctx.lineWidth = 1.2;
    ctx.beginPath(); for (let x = 0; x <= W; x += 6) ctx.lineTo(x, yAt(x)); ctx.stroke();
    ctx.restore();
  },
  bolt(S, p) {
    const { ctx, X2, Y, P } = S; const on = seg(p, 0.5, 0.53) * (1 - seg(p, 0.6, 0.66));
    if (!on) return;
    ctx.save(); ctx.globalAlpha = on; ctx.strokeStyle = '#e4f1ff'; ctx.lineWidth = 2.4; ctx.shadowColor = '#9ccaff'; ctx.shadowBlur = 16;
    ctx.beginPath(); ctx.moveTo(X2 + (P.parts[40][0] - 0.5) * 30, 0);
    for (let k = 1; k <= 6; k++) ctx.lineTo(X2 + (P.parts[40 + k][0] - 0.5) * 34, (Y - 12) * k / 6);
    ctx.stroke(); ctx.restore();
  },
  fire(S, p) {
    const { ctx, X2, Y, P } = S; const a = seg(p, 0.55, 0.62) * (1 - seg(p, 0.85, 1));
    if (!a) return;
    ctx.save(); ctx.globalAlpha = a;
    for (let i = 0; i < 6; i++) {
      const q = P.parts[30 + i]; const x = X2 + (q[0] - 0.5) * 40, h = 14 + q[1] * 18 * (0.6 + Math.abs(Math.sin(p * 30 + i)));
      ctx.fillStyle = i % 2 ? '#ff9a3c' : '#ffd36e';
      ctx.beginPath(); ctx.moveTo(x - 5, Y + 16); ctx.quadraticCurveTo(x, Y + 16 - h * 1.2, x + 5, Y + 16); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  },
  blood(S, p) {
    const { ctx, X2, Y, P } = S; const t = seg(p, 0.56, 0.95);
    if (!t) return;
    ctx.save(); ctx.fillStyle = '#c73b33'; ctx.globalAlpha = 1 - t * 0.5;
    for (let i = 0; i < 7; i++) { const q = P.parts[60 + i]; ctx.beginPath(); ctx.arc(X2 + (q[0] - 0.3) * 60 * t, Y - 6 + (-30 - q[1] * 40) * t + 140 * t * t, 1.6 + q[2] * 1.8, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  },
  petals(S, p) {
    const { ctx, W, P } = S; const a = seg(p, 0.05, 0.3);
    const green = /葉/.test(P.text) && !/花/.test(P.text);
    for (let i = 0; i < 16; i++) {
      const q = P.parts[i + 30];
      ctx.save(); ctx.translate(q[0] * W + Math.sin(p * 5 + q[1] * 6) * 22, (q[1] * H + p * H * 0.5 * (0.6 + q[2])) % H); ctx.rotate(p * 6 + q[3] * 6);
      ctx.globalAlpha = a * 0.8; ctx.fillStyle = green ? '#7fc28a' : (i % 2 ? '#f4b6c8' : '#ffd9e3');
      ctx.beginPath(); ctx.ellipse(0, 0, 4, 2, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
  },
  dragon(S, p) {
    const { ctx, X1, X2, Y } = S; const t = ease(seg(p, 0.2, 0.55));
    if (!t) return;
    ctx.save(); ctx.globalAlpha = 1 - seg(p, 0.7, 1); ctx.strokeStyle = '#7fd1a8'; ctx.lineWidth = 6; ctx.lineCap = 'round'; ctx.shadowColor = '#7fd1a8'; ctx.shadowBlur = 10;
    ctx.beginPath(); for (let x = X1, end = lerp(X1, X2, t); x <= end; x += 4) ctx.lineTo(x, Y - 22 + Math.sin(x / 24 + p * 8) * 16);
    ctx.stroke(); ctx.restore();
  },
  claw(S, p) {
    const { ctx, X2, Y } = S; const t = ease(seg(p, 0.55, 0.65)); const fade = 1 - seg(p, 0.8, 1);
    if (!t) return;
    for (let k = 0; k < 3; k++) line(ctx, X2 - 22 + k * 12, Y - 26, lerp(X2 - 22 + k * 12, X2 - 8 + k * 12, t), lerp(Y - 26, Y + 14, t), `rgba(255,120,110,${fade})`, 2.5, 6);
  },
};

// 出招動作
const STRIKE = {
  thrust(S, p) {
    const { ctx, X1, X2, Y, P } = S;
    for (let k = 0; k < P.count; k++) {
      const off = (k - (P.count - 1) / 2) * 9 + P.tilt * 20, d = k * 0.035;
      const t = ease(seg(p, 0.25 + d, 0.5 + d)), fade = 1 - seg(p, 0.58 + d, 0.8);
      if (!t || !fade) continue;
      const x = lerp(X1 + 20, X2 - 16, t), y = Y - 8 + off * (1 - t * 0.6);
      ctx.save(); ctx.globalAlpha = fade;
      line(ctx, Math.max(X1 + 20, x - 80), y + off * 0.3, x, y, S.soft, 7);
      line(ctx, Math.max(X1 + 20, x - 60), y + off * 0.2, x, y, S.blade, 2.4, 12);
      ctx.restore();
    }
  },
  slash(S, p) {
    const { ctx, X2, Y, P } = S;
    for (let k = 0; k < P.count; k++) {
      const d = k * 0.05, t = ease(seg(p, 0.3 + d, 0.52 + d)), fade = 1 - seg(p, 0.6 + d, 0.85);
      if (!t || !fade) continue;
      const a0 = -2.4 + P.tilt + k * 0.5;
      ctx.save(); ctx.globalAlpha = fade; ctx.strokeStyle = S.blade; ctx.lineWidth = 3.5; ctx.lineCap = 'round'; ctx.shadowColor = S.blade; ctx.shadowBlur = 14;
      ctx.beginPath(); ctx.arc(X2 - 6, Y - 8, 30 + k * 9, a0, lerp(a0, a0 + 2.6, t)); ctx.stroke(); ctx.restore();
    }
  },
  sweep(S, p) {
    const { ctx, X1, X2, Y, P } = S; const t = ease(seg(p, 0.25, 0.55)), fade = 1 - seg(p, 0.6, 0.85);
    if (!t || !fade) return;
    const a0 = -1.15 + P.tilt, a1 = lerp(a0, a0 + 2.3, t);
    ctx.save(); ctx.globalAlpha = fade;
    for (let w = 0; w < 3; w++) {
      ctx.strokeStyle = w ? S.blade : S.soft; ctx.lineWidth = w ? 2.6 - w * 0.6 : 10; ctx.shadowColor = S.blade; ctx.shadowBlur = w ? 12 : 0;
      ctx.beginPath(); ctx.ellipse(X1, Y - 6, X2 - X1 + 4 - w * 6, 48 - w * 4, 0, Math.max(a0, a1 - 1.2), a1); ctx.stroke();
    }
    ctx.restore();
  },
  guard(S, p) {
    const { ctx, X1, X2, Y } = S; const up = ease(seg(p, 0.12, 0.3)), grow = ease(seg(p, 0.36, 0.55));
    ctx.save(); ctx.globalAlpha = 1 - seg(p, 0.75, 1) * 0.6;
    if (up) line(ctx, X1 + 28, Y + 18, X1 + 28, lerp(Y + 18, Y - 40, up), S.blade, 3, 14);
    if (grow) {
      ctx.fillStyle = 'rgba(190,230,255,.75)'; ctx.shadowColor = '#a6dcff'; ctx.shadowBlur = 16;
      ctx.beginPath(); ctx.moveTo(X1 + 30, Y - 18); ctx.lineTo(lerp(X1 + 30, X2 - 14, grow), Y - 8); ctx.lineTo(X1 + 30, Y + 2); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  },
  surge(S, p) {
    const { ctx, X1, X2, Y } = S; const t = ease(seg(p, 0.22, 0.58)), fade = 1 - seg(p, 0.65, 0.95);
    if (!t || !fade) return;
    const front = lerp(X1 + 10, X2 + 30, t);
    ctx.save(); ctx.globalAlpha = fade; ctx.fillStyle = 'rgba(120,180,230,.35)';
    ctx.beginPath(); ctx.moveTo(X1, H);
    for (let x = X1; x <= front; x += 5) ctx.lineTo(x, Y + 20 - (x - X1) / Math.max(1, front - X1) * 60 + Math.sin(x / 14 + p * 12) * 4);
    ctx.lineTo(front, H); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#e8f6ff'; ctx.lineWidth = 2; ctx.shadowColor = '#a6dcff'; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.moveTo(front - 30, Y - 30); ctx.quadraticCurveTo(front + 6, Y - 52, front, Y - 20); ctx.stroke();
    ctx.restore();
  },
  qi(S, p) {
    const { ctx, X1, X2, Y, P } = S;
    for (let i = 0; i < 9; i++) {
      const q = P.parts[i], d = q[0] * 0.15, t = ease(seg(p, 0.25 + d, 0.5 + d)), fade = 1 - seg(p, 0.6, 0.8);
      if (!t || !fade) continue;
      const sx = X1 + 10 + q[1] * 40, sy = 10 + q[2] * 30, ex = X2 + (q[3] - 0.5) * 30, ey = Y - 10;
      const x = lerp(sx, ex, t), y = lerp(sy, ey, t);
      ctx.save(); ctx.globalAlpha = fade; line(ctx, x - (ex - sx) * 0.12, y - (ey - sy) * 0.12, x, y, S.blade, 2, 10); ctx.restore();
    }
  },
  points(S, p) {
    const { ctx, X1, X2, Y, P } = S;
    const reach = ease(seg(p, 0.2, 0.32));
    if (reach && p < 0.6) line(ctx, X1 + 18, Y - 8, lerp(X1 + 18, X2 - 18, reach), Y - 8, S.soft, 1.5, 6);
    for (let i = 0; i < 6; i++) {
      const t = seg(p, 0.3 + i * 0.04, 0.36 + i * 0.04); if (!t) continue;
      const q = P.parts[i];
      ctx.save(); ctx.globalAlpha = 1 - seg(p, 0.7, 0.9); ctx.fillStyle = S.blade; ctx.shadowColor = S.blade; ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.arc(X2 + (q[0] - 0.5) * 30, Y - 8 + (q[1] - 0.5) * 30, 3 * t + 1, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
  },
  palm(S, p) {
    const { ctx, X1, X2, Y } = S;
    for (let k = 0; k < 3; k++) {
      const t = ease(seg(p, 0.25 + k * 0.06, 0.55 + k * 0.06)); if (!t || t >= 1) continue;
      ctx.save(); ctx.globalAlpha = 1 - t * 0.7; ctx.strokeStyle = S.blade; ctx.lineWidth = 3; ctx.shadowColor = S.blade; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(lerp(X1 + 20, X2 - 20, t), Y - 8, 14 + t * 12, -0.9, 0.9); ctx.stroke(); ctx.restore();
    }
  },
  fist(S, p) {
    const { ctx, X1, X2, Y } = S; const t = ease(seg(p, 0.3, 0.52));
    if (t && p < 0.6) {
      const x = lerp(X1 + 20, X2 - 20, t);
      line(ctx, x - 40, Y - 8, x, Y - 8, S.soft, 8);
      ctx.save(); ctx.fillStyle = S.blade; ctx.shadowColor = S.blade; ctx.shadowBlur = 14; ctx.beginPath(); ctx.arc(x, Y - 8, 7, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
    const burst = seg(p, 0.52, 0.7);
    if (burst && burst < 1) for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; line(ctx, X2 + Math.cos(a) * 10, Y - 8 + Math.sin(a) * 10, X2 + Math.cos(a) * (10 + burst * 22), Y - 8 + Math.sin(a) * (10 + burst * 22), S.blade, 2, 6); }
  },
  kick(S, p) {
    const { ctx, X1, X2, Y, P } = S;
    for (let k = 0; k < Math.min(P.count, 3); k++) {
      const t = ease(seg(p, 0.28 + k * 0.06, 0.52 + k * 0.06)), fade = 1 - seg(p, 0.6, 0.85);
      if (!t || !fade) continue;
      ctx.save(); ctx.globalAlpha = fade; ctx.strokeStyle = S.blade; ctx.lineWidth = 4; ctx.lineCap = 'round'; ctx.shadowColor = S.blade; ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.ellipse(lerp(X1, X2, 0.55), Y + 10, (X2 - X1) * 0.48, 40 + k * 8, 0, Math.PI, lerp(Math.PI, Math.PI * 1.9, t)); ctx.stroke(); ctx.restore();
    }
  },
  staff(S, p) {
    const { ctx, X1, X2, Y, P } = S; const t = ease(seg(p, 0.22, 0.55)), fade = 1 - seg(p, 0.65, 0.9);
    if (!t || !fade) return;
    const cx = lerp(X1 + 20, X2 - 30, t), len = 46;
    for (let k = 3; k >= 0; k--) {
      const a = -Math.PI / 2 + lerp(0, Math.PI * (1.5 + P.tilt), t) - k * 0.35;
      ctx.save(); ctx.globalAlpha = fade * (k ? 0.25 : 1);
      line(ctx, cx - Math.cos(a) * len, Y - 8 - Math.sin(a) * len, cx + Math.cos(a) * len, Y - 8 + Math.sin(a) * len, k ? S.soft : S.blade, k ? 4 : 5, k ? 0 : 10);
      ctx.restore();
    }
  },
  whip(S, p) {
    const { ctx, X1, X2, Y, P } = S; const t = ease(seg(p, 0.25, 0.55)), fade = 1 - seg(p, 0.65, 0.9);
    if (!t || !fade) return;
    const end = lerp(X1 + 20, X2 - 4, t);
    ctx.save(); ctx.globalAlpha = fade; ctx.strokeStyle = S.blade; ctx.lineWidth = 2.6; ctx.lineCap = 'round'; ctx.shadowColor = S.blade; ctx.shadowBlur = 10;
    ctx.beginPath();
    for (let x = X1 + 20; x <= end; x += 3) { const k = (x - X1) / (X2 - X1); ctx.lineTo(x, Y - 10 + Math.sin(k * 14 + p * 18 + P.tilt * 6) * 18 * (1 - k * 0.6)); }
    ctx.stroke(); ctx.restore();
    if (t > 0.95 && p < 0.62) { ctx.save(); ctx.fillStyle = '#fff'; ctx.shadowColor = S.blade; ctx.shadowBlur = 14; ctx.beginPath(); ctx.arc(end, Y - 10, 4, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }
  },
  throw(S, p) {
    const { ctx, X1, X2, Y, P } = S;
    for (let i = 0; i < Math.max(P.count, 3); i++) {
      const q = P.parts[i], d = i * 0.03, t = ease(seg(p, 0.28 + d, 0.52 + d));
      if (!t || t >= 1) continue;
      const sy = Y - 20 + (q[0] - 0.5) * 30, x = lerp(X1 + 20, X2 - 10, t), y = lerp(sy, Y - 8 + (q[1] - 0.5) * 20, t) - Math.sin(t * Math.PI) * 18 * q[2];
      line(ctx, x - 18, y, x - 7, y, S.soft, 1.5);
      ctx.save(); ctx.translate(x, y); ctx.fillStyle = S.blade; ctx.shadowColor = S.blade; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(-6, -2.5); ctx.lineTo(-4, 0); ctx.lineTo(-6, 2.5); ctx.closePath(); ctx.fill(); ctx.restore();
    }
  },
  spin(S, p) {
    const { ctx, X1, X2, Y } = S; const t = ease(seg(p, 0.2, 0.55));
    if (!t) return;
    const cx = lerp(X1, X2, t);
    ctx.save(); ctx.globalAlpha = 1 - seg(p, 0.6, 0.85); ctx.strokeStyle = S.blade; ctx.lineWidth = 2.5; ctx.shadowColor = S.blade; ctx.shadowBlur = 10;
    for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.arc(cx, Y - 8, 14 + k * 8, p * 20 + k, p * 20 + k + 2.2); ctx.stroke(); }
    ctx.restore();
  },
};

function drawFrame(ctx, W, P, move, p) {
  const S = { ctx, W, P, X1: W * 0.17, X2: W * 0.8, Y: H * 0.66, blade: `hsl(${P.hue}, 85%, 72%)`, soft: `hsla(${P.hue}, 85%, 72%, 0.35)` };
  const { X1, X2, Y } = S;
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, P.cold ? '#0d1520' : '#14110d'); bg.addColorStop(1, '#0b0e13');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  for (const l of P.layers) if (l.z === 'back') LAYER[l.id](S, p);
  line(ctx, 0, Y + 20, W, Y + 20, 'rgba(255,255,255,.06)', 1);

  glyph(S, '你', X1, Y, C.gold, 6 + seg(p, 0.05, 0.25) * (1 - seg(p, 0.5, 0.7)) * 22);
  STRIKE[P.strike.id](S, p);

  const hit = seg(p, 0.53, 0.57) * (1 - seg(p, 0.6, 0.75));
  if (hit) {
    const r = 18 + P.power * 26;
    const rg = ctx.createRadialGradient(X2, Y - 6, 0, X2, Y - 6, r);
    rg.addColorStop(0, '#ffffff'); rg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.save(); ctx.globalAlpha = hit * (0.5 + P.power * 0.5); ctx.fillStyle = rg;
    ctx.beginPath(); ctx.arc(X2, Y - 6, r, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
  const shake = seg(p, 0.54, 0.56) * (1 - seg(p, 0.56, 0.72));
  const ex = X2 + Math.sin(p * 220) * 6 * P.power * shake + ease(seg(p, 0.55, 0.7)) * 8 * P.power;
  glyph(S, '敵', ex, Y, P.cold && p > 0.6 ? C.frost : C.enemy, hit ? 18 : 0);

  for (const l of P.layers) if (l.z === 'front') LAYER[l.id](S, p);

  const dn = seg(p, 0.56, 0.62);
  if (dn && Number.isFinite(move.damage)) {
    ctx.save(); ctx.globalAlpha = dn;
    ctx.font = `700 ${16 + P.power * 8}px ${FONT}`; ctx.textAlign = 'center';
    ctx.fillStyle = C.hit; ctx.shadowColor = '#000'; ctx.shadowBlur = 4;
    ctx.fillText(`-${move.damage}`, X2 + 4, Y - 30 - ease(seg(p, 0.56, 1)) * 26); ctx.restore();
  }
  const na = seg(p, 0.18, 0.32);
  if (na) {
    ctx.save(); ctx.globalAlpha = na * (1 - seg(p, 0.8, 1) * 0.5);
    ctx.font = `900 20px ${FONT}`; ctx.textAlign = 'center';
    ctx.fillStyle = C.name; ctx.shadowColor = 'rgba(0,0,0,.8)'; ctx.shadowBlur = 6;
    ctx.fillText(`『${move.name}』`, W / 2, 30 + (1 - ease(na)) * 8); ctx.restore();
  }
}

// 原文（加兵器類別）→ { fx（出招動作的 id）, label, layers（意象的名稱）, count }
function pick(text, weapon) {
  const P = plan({ name: '', action: text, weapon });
  return { fx: P.strike.id, label: P.strike.label, layers: P.layers.map(l => l.label), count: P.count };
}

// 在 container 裡放一個播放器並播一次；回傳 { stop, replay, chosen, node }。move＝{ name, action, damage, type, weapon }
function mount(container, move) {
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  const P = plan(move);
  const chosen = { fx: P.strike.id, label: P.strike.label, layers: P.layers.map(l => l.label), count: P.count };
  const wrap = doc.createElement('div');
  wrap.setAttribute('data-catworld-movefx', '');
  Object.assign(wrap.style, { margin: '4px 0 6px 1.5em', maxWidth: '440px', border: '1px solid #232a32', borderRadius: '6px', overflow: 'hidden', background: '#12161b', whiteSpace: 'normal' });
  const canvas = doc.createElement('canvas');
  Object.assign(canvas.style, { display: 'block', width: '100%', height: `${H}px` });
  const text = doc.createElement('div');
  Object.assign(text.style, { padding: '8px 10px', color: C.fg, minHeight: '3.2em', lineHeight: '1.5' });
  const foot = doc.createElement('div');
  Object.assign(foot.style, { padding: '4px 10px 8px', color: '#7f8892', fontSize: '0.85em' });
  foot.textContent = `出招：${chosen.label}${chosen.count > 1 ? ` ×${chosen.count}` : ''}${chosen.layers.length ? `　意象：${chosen.layers.join('、')}` : ''}　點招式名再看一次，點別招換一招`;
  wrap.append(canvas, text, foot);
  container.append(wrap);

  let ctx = null;
  try { ctx = canvas.getContext('2d'); } catch { ctx = null; }
  const full = actionText(move.action, move.name);
  const tail = Number.isFinite(move.damage) ? `（${move.type || '傷害'}，傷害 ${move.damage}）` : '';
  const raf = win.requestAnimationFrame?.bind(win) ?? (fn => win.setTimeout(() => fn(win.performance?.now?.() ?? Date.now()), 16));
  const caf = win.cancelAnimationFrame?.bind(win) ?? (id => win.clearTimeout(id));
  const duration = DURATION_MS * P.tempo;
  let frame = 0;
  let typer = 0;
  let W = 0;

  function typeTo(n) {
    text.textContent = '';
    const shown = full.slice(0, n);
    const at = shown.indexOf(move.name);
    if (at < 0) text.append(shown);
    else {
      const b = doc.createElement('b');
      b.textContent = move.name;
      b.style.color = C.gold;
      text.append(shown.slice(0, at), b, shown.slice(at + move.name.length));
    }
    if (n >= full.length && tail) {
      const d = doc.createElement('span');
      d.textContent = tail;
      d.style.color = C.hit;
      text.append(d);
    }
  }

  function stop() { caf(frame); win.clearInterval(typer); }

  function play() {
    stop();
    if (ctx) {
      const ratio = win.devicePixelRatio || 1;
      W = canvas.getBoundingClientRect().width || 400;
      canvas.width = Math.round(W * ratio); canvas.height = H * ratio;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const start = win.performance?.now?.() ?? Date.now();
      const step = now => {
        const p = Math.min((now - start) / duration, 1);
        drawFrame(ctx, W, P, move, p);
        if (p < 1) frame = raf(step);
      };
      frame = raf(step);
    }
    let n = 0;
    typeTo(0);
    typer = win.setInterval(() => { n += 1; typeTo(n); if (n >= full.length) win.clearInterval(typer); }, Math.max(duration * 0.85 / Math.max(full.length, 1), 15));
  }

  play();
  return { stop, replay: play, chosen, node: wrap };
}

globalThis.CatworldMoveFx = { STRIKES, MOTIFS, WEAPON_STRIKE, plan, pick, actionText, mount, DURATION_MS };
})();
