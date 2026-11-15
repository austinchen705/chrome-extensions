// 招式動畫：招式列表（skill-moves.js）裡點一招，在那一行下面播一段動畫，並把這一招的原文逐字打出來。
// 不是每招各畫一個：依招式原文（skills-data.js 的 action）裡的關鍵字從 RULES 挑一種動畫（第一條對到的算，都沒對到用最後一種）。
// 人物用「你」「敵」兩個字，全部用 canvas 畫，不用圖檔。讀不到 canvas（jsdom）時只打字。
(() => {
if (globalThis.CatworldMoveFx) return;

const RULES = [
  { fx: 'rain', label: '劍氣雨', re: /暴雨|如雨|凌空|劍氣/g },
  { fx: 'dragon', label: '龍形掌風', re: /龍|風雷|飛砂走石/g },
  { fx: 'net', label: '劍網', re: /劍網|劍芒|光芒|包圍/g },
  { fx: 'points', label: '點穴', re: /指|穴|點/g },
  { fx: 'staff', label: '棍影', re: /棍|棒|杖|籠罩|壟罩/g },
  { fx: 'thrust', label: '突刺', re: /刺|斜飛|直取|劈/g },
];

// 原文 → { fx, label, hits }；hits 是對到的關鍵字（去重）
function pick(text) {
  const source = String(text ?? '');
  for (const rule of RULES) {
    const hits = source.match(rule.re);
    if (hits) return { fx: rule.fx, label: rule.label, hits: [...new Set(hits)] };
  }
  const last = RULES[RULES.length - 1];
  return { fx: last.fx, label: last.label, hits: [] };
}

// 原文裡的「招式名」換成這一招的名字
const actionText = (action, name) => String(action ?? '').replace('招式名', name);

const DURATION_MS = 2600;
const C = { gold: '#f2c14e', hit: '#ff6b5a', qi: '#7fe7ff', fg: '#d8d4c8', dim: '#3a434d' };
const FONT = '"Noto Serif TC", "PMingLiU", "Songti TC", serif';
const ease = x => 1 - Math.pow(1 - Math.min(Math.max(x, 0), 1), 3);
const seg = (p, a, b) => Math.min(Math.max((p - a) / (b - a), 0), 1);

// 每種動畫：draw(g, p, A, T) 畫一格，p 是 0～1 的進度，回傳「你」畫在哪；hit 是命中的時間點，multi 是傷害拆成幾段
function painter(ctx, W, H) {
  let seed = 1;
  const g = {
    W, H,
    reseed: n => { seed = n; },
    rnd: () => (seed = (seed * 16807) % 2147483647) / 2147483647,
    glyph(ch, x, y, color, size = 40, alpha = 1) {
      ctx.save(); ctx.globalAlpha = alpha; ctx.fillStyle = color; ctx.font = `900 ${size}px ${FONT}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(ch, x, y); ctx.restore();
    },
    glow(fn, color, blur = 14) { ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = blur; fn(); ctx.restore(); },
    line(x1, y1, x2, y2, color, w = 2, a = 1) {
      ctx.save(); ctx.globalAlpha = a; ctx.strokeStyle = color; ctx.lineWidth = w; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.restore();
    },
    ctx,
  };
  return g;
}

const FX = {
  thrust: { hit: 0.62, draw(g, p, A, T) {
    const k = ease(seg(p, 0.1, 0.6));
    const pos = s => ({ x: A.x + (T.x - 40 - A.x) * s, y: A.y - 8 * Math.sin(Math.PI * s) + 26 * s });
    for (let i = 5; i >= 1; i--) {
      const q = pos(Math.max(k - i * 0.06, 0));
      g.glyph('你', q.x, q.y, C.qi, 40, 0.12 * (6 - i) / 5 * (1 - seg(p, 0.6, 0.8)));
    }
    const me = pos(k);
    if (p > 0.55) { const s = seg(p, 0.55, 0.7); g.glow(() => g.line(me.x + 20, me.y, me.x + 20 + (T.x + 110 - me.x) * s, me.y - 6, C.gold, 3), C.gold, 18); }
    return me;
  } },
  dragon: { hit: 0.7, draw(g, p, A, T) {
    const { ctx, W, H } = g;
    g.reseed(7);
    for (let i = 0; i < 90; i++) { // 飛砂走石
      const a = g.rnd() * Math.PI * 2 + p * 6 * (g.rnd() + 0.5), r = 30 + g.rnd() * 110 * ease(seg(p, 0, 0.5));
      ctx.fillStyle = `rgba(200,170,110,${0.5 * (1 - seg(p, 0.8, 1))})`;
      ctx.fillRect(W / 2 + Math.cos(a) * r * 1.6, H / 2 + Math.sin(a) * r * 0.6, 2, 2);
    }
    const k = ease(seg(p, 0.2, 0.7)); // 龍形：從上空繞到對手身後撲回
    ctx.save();
    for (let i = 0; i < 40; i++) {
      const s = k - i * 0.012; if (s < 0) break;
      const x = A.x + (T.x + 60 - A.x) * s, y = A.y - Math.sin(s * Math.PI) * (H * 0.45) + Math.sin(s * 18) * 8;
      ctx.globalAlpha = 1 - i / 40; ctx.fillStyle = i === 0 ? C.gold : C.qi;
      ctx.beginPath(); ctx.arc(x, y, i === 0 ? 6 : 5 - i * 0.1, 0, 7); ctx.fill();
    }
    ctx.restore();
    if (p > 0.7) {
      const s = seg(p, 0.7, 1);
      for (let i = 0; i < 3; i++) {
        const r = 18 + s * 80 + i * 16;
        ctx.save(); ctx.globalAlpha = (1 - s) * 0.8; ctx.strokeStyle = C.gold; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(T.x, T.y, r, r * 0.45, 0, 0, 7); ctx.stroke(); ctx.restore();
      }
    }
    return { x: A.x, y: A.y - Math.sin(seg(p, 0.2, 0.7) * Math.PI) * 50 };
  } },
  net: { hit: 0.55, draw(g, p, A, T) {
    const { ctx } = g;
    g.reseed(3);
    const n = Math.floor(ease(seg(p, 0.15, 0.75)) * 46);
    for (let i = 0; i < 46; i++) {
      const a = g.rnd() * Math.PI * 2, r = 36 + g.rnd() * 55, x = T.x + Math.cos(a) * r * 1.3, y = T.y + Math.sin(a) * r * 0.8;
      if (i < n) g.glow(() => g.line(A.x + 22, A.y - 10, x, y, i % 3 ? C.qi : C.gold, 1.2, 0.55 * (1 - seg(p, 0.85, 1) * 0.7)), C.qi, 8);
    }
    const s = seg(p, 0.4, 1);
    ctx.save(); ctx.translate(T.x, T.y); ctx.rotate(s * 1.2); ctx.globalAlpha = 0.6 * Math.sin(s * Math.PI); ctx.strokeStyle = C.gold;
    for (let i = 0; i < 12; i++) { ctx.rotate(Math.PI / 6); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, 85); ctx.stroke(); }
    ctx.restore();
    return A;
  } },
  points: { hit: 0.35, multi: 9, draw(g, p, A, T) {
    const pts = [[0, -34], [-14, -20], [14, -20], [0, -6], [-18, 6], [18, 6], [0, 18], [-10, 32], [10, 32]];
    const tip = { x: A.x + 30 + ease(seg(p, 0, 0.25)) * 40, y: A.y };
    pts.forEach(([dx, dy], i) => {
      const at = 0.25 + i * 0.06, s = seg(p, at, at + 0.08), x = T.x + dx * 1.4, y = T.y + dy * 1.4;
      if (s > 0) {
        g.line(tip.x, tip.y, x, y, C.qi, 1, (1 - s) * 0.9);
        g.glow(() => { g.ctx.fillStyle = C.gold; g.ctx.beginPath(); g.ctx.arc(x, y, 3 + (1 - s) * 5, 0, 7); g.ctx.fill(); }, C.gold, 12);
      }
    });
    g.glyph('指', tip.x, tip.y, C.gold, 16);
    return A;
  } },
  staff: { hit: 0.72, draw(g, p, A, T) {
    const { ctx } = g;
    const s = ease(seg(p, 0.05, 0.65));
    for (let i = 0; i < 7; i++) { // 棍影繞著對手
      const r = 64 - s * 18;
      ctx.save(); ctx.translate(T.x, T.y); ctx.rotate(s * 9 + i * 0.9); ctx.globalAlpha = 0.55 * (1 - seg(p, 0.7, 0.85));
      ctx.strokeStyle = i % 2 ? C.qi : C.gold; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(-r, -6); ctx.lineTo(r, 6); ctx.stroke(); ctx.restore();
    }
    if (p > 0.65) { const k = seg(p, 0.65, 0.75); g.glow(() => g.line(T.x - 64, T.y - 100 + k * 55, T.x + 18, T.y - 10, C.gold, 6, 1 - seg(p, 0.8, 1)), C.gold, 20); }
    return A;
  } },
  rain: { hit: 0.6, multi: 6, draw(g, p, A, T) {
    g.reseed(11);
    for (let i = 0; i < 60; i++) { // 從上空落下的劍氣
      const at = 0.35 + g.rnd() * 0.45, s = seg(p, at, at + 0.12), x = T.x - 80 + g.rnd() * 160, y0 = -20 - g.rnd() * 40;
      if (s > 0 && s < 1) { const y = y0 + (T.y + 26 - y0) * s; g.glow(() => g.line(x - 22, y - 30, x, y, C.qi, 1.6, 0.9 * (1 - s * 0.5)), C.qi, 10); }
    }
    return { x: A.x, y: A.y - Math.sin(seg(p, 0.2, 0.6) * Math.PI) * 60 };
  } },
};

function drawFrame(g, move, chosen, p, reduce) {
  const { ctx, W, H } = g;
  const fx = FX[chosen.fx];
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#07090b'; ctx.fillRect(0, 0, W, H);
  ctx.save(); ctx.setLineDash([3, 6]); g.line(16, H - 30, W - 16, H - 30, C.dim, 1); ctx.restore();
  const A = { x: Math.max(56, W * 0.18), y: H - 62 }, T = { x: Math.min(W - 56, W * 0.74), y: H - 72 };
  const me = fx.draw(g, p, A, T);
  const h = p - fx.hit, shake = h > 0 && h < 0.25 ? Math.sin(h * 120) * 6 * (1 - h / 0.25) : 0;
  g.glyph('敵', T.x + shake, T.y, h > 0 && h < 0.3 ? C.hit : C.fg);
  g.glyph('你', me.x, me.y, C.fg);
  const size = Math.min(28, W / (move.name.length + 3));
  const n = reduce ? 1 : seg(p, 0, 0.25), fade = reduce ? 1 : 1 - seg(p, 0.8, 1);
  g.glyph(`『${move.name}』`, W / 2, 34 - (1 - ease(n)) * 10, C.gold, size, ease(n) * (0.4 + 0.6 * fade));
  if (h > 0 && Number.isFinite(move.damage)) {
    const parts = fx.multi || 1, each = Math.round(move.damage / parts);
    for (let i = 0; i < parts; i++) {
      const hi = h - i * 0.04; if (hi <= 0) continue;
      g.glyph(`-${each}`, T.x + 36 + (i % 3) * 20, T.y - 44 - hi * 100 - Math.floor(i / 3) * 16, C.hit, 16, 1 - seg(hi, 0.25, 0.4));
    }
  }
}

// 在 container 裡放一個播放器並播一次；回傳 { stop, replay, chosen }。move＝{ name, action, damage, type }
function mount(container, move) {
  const doc = container.ownerDocument;
  const win = doc.defaultView;
  const chosen = pick(move.action);
  const reduce = Boolean(win.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
  const wrap = doc.createElement('div');
  wrap.setAttribute('data-catworld-movefx', '');
  Object.assign(wrap.style, { margin: '4px 0 6px 1.5em', maxWidth: '420px', border: '1px solid #232a32', borderRadius: '6px', overflow: 'hidden', background: '#12161b', whiteSpace: 'normal' });
  const canvas = doc.createElement('canvas');
  Object.assign(canvas.style, { display: 'block', width: '100%', height: '180px' });
  const text = doc.createElement('div');
  Object.assign(text.style, { padding: '8px 10px', color: C.fg, minHeight: '3.2em', lineHeight: '1.5' });
  const foot = doc.createElement('div');
  Object.assign(foot.style, { padding: '4px 10px 8px', color: '#7f8892', fontSize: '0.85em' });
  foot.textContent = `動畫：${chosen.label}${chosen.hits.length ? `（關鍵字 ${chosen.hits.join('、')}）` : ''}　點招式名再看一次，點別招換一招`;
  wrap.append(canvas, text, foot);
  container.append(wrap);

  let ctx = null;
  try { ctx = canvas.getContext('2d'); } catch { ctx = null; }
  const full = actionText(move.action, move.name);
  const tail = Number.isFinite(move.damage) ? `（${move.type || '傷害'}，傷害 ${move.damage}）` : '';
  const raf = win.requestAnimationFrame?.bind(win) ?? (fn => win.setTimeout(() => fn(win.performance?.now?.() ?? Date.now()), 16));
  const caf = win.cancelAnimationFrame?.bind(win) ?? (id => win.clearTimeout(id));
  let frame = 0;
  let typer = 0;
  let g = null;

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
      const W = canvas.getBoundingClientRect().width || 360, H = 180;
      canvas.width = W * ratio; canvas.height = H * ratio;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      g = painter(ctx, W, H);
    }
    if (reduce) { if (g) drawFrame(g, move, chosen, 1, true); typeTo(full.length); return; }
    const start = win.performance?.now?.() ?? Date.now();
    const step = now => {
      const p = Math.min((now - start) / DURATION_MS, 1);
      if (g) drawFrame(g, move, chosen, p, false);
      if (p < 1) frame = raf(step);
    };
    frame = raf(step);
    let n = 0;
    typeTo(0);
    typer = win.setInterval(() => { n += 1; typeTo(n); if (n >= full.length) win.clearInterval(typer); }, Math.max(DURATION_MS / Math.max(full.length, 1), 15));
  }

  play();
  return { stop, replay: play, chosen, node: wrap };
}

globalThis.CatworldMoveFx = { RULES, pick, actionText, mount, DURATION_MS };
})();
