// 六脈神劍（落魄書生）的判讀（純函式）：sc 的靈性、sk 的技能數、能不能開始。樣本是遊戲的真實輸出（tests/fixtures/scholar/）。不碰 DOM 與 chrome.*。
(() => {
if (globalThis.CatworldScholar) return;

// sc：「靈性： 31」→ 31，讀不到回 null
function parseSpirit(scText) {
  const match = /靈性\s*[：:]\s*(\d+)/.exec(String(scText ?? ''));
  return match ? Number(match[1]) : null;
}

// sk 第一行「你目前所學過的技能：(28)」→ { count, hasSixVein }；讀不到回 null。hasSixVein 只看讀到的這段文字有沒有 six-vein-sword
function parseSkillCount(skText) {
  const text = String(skText ?? '');
  const match = /你目前所學過的技能\s*[：:]\s*\(\s*(\d+)\s*\)/.exec(text);
  return match ? { count: Number(match[1]), hasSixVein: /six-vein-sword/.test(text) } : null;
}

// 還沒有六脈：技能數上限＝靈性；已經有六脈：上限＝靈性＋1。abandon＝超過上限要先丟掉幾個
function canStart({ spirit, skills, hasSixVein }) {
  const limit = spirit + (hasSixVein ? 1 : 0);
  const abandon = Math.max(0, skills - limit);
  return { ok: abandon === 0, limit, abandon };
}

globalThis.CatworldScholar = { parseSpirit, parseSkillCount, canStart };
})();
