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

// 一行遊戲文字 → { kind, ... } 或 null。kind：appear（房間行 ※落魄書生(dire scholar)）、request（要東西，item＝「誰能給我」與「呢？」中間的原文，line＝整句）、
// vanish、leave（direction＝「往」與「離開」中間）、followed（跟隨）、given（你給落魄書生…）、success（領悟六脈）、failed（沒解成）、already（已經領悟）
function classifyLine(line) {
  const text = String(line ?? '').trim();
  if (!text.includes('落魄書生') && !text.includes('六脈神劍') && !text.includes('可惜啊')) return null;
  let m;
  if ((m = /落魄書生說道[：:]\s*誰能給我(.*?)呢[？?]/.exec(text))) return { kind: 'request', item: m[1], line: m[0] };
  if (text.includes('你已經對六脈有相當的領悟了')) return { kind: 'already' };
  if (text.includes('落魄書生突然身形一晃，便漸漸消逸了')) return { kind: 'vanish' };
  if ((m = /落魄書生往(.+?)離開/.exec(text))) return { kind: 'leave', direction: m[1] };
  if (text.includes('可惜啊！看來我們有緣無份了。')) return { kind: 'failed' };
  if (text.includes('恭喜你對六脈神劍有所領悟了。')) return { kind: 'success' };
  if (text.includes('你決定開始跟隨落魄書生一起行動。')) return { kind: 'followed' };
  if (/你給落魄書生/.test(text)) return { kind: 'given' };
  if (/落魄書生\(dire scholar\)/.test(text)) return { kind: 'appear' };
  return null;
}

// 出沒紀錄（舊的在前、新的在後，最多 CAP 筆）。一筆＝一次相遇：{ at, sinceSpawnSec, area, areaName, room, said, matched, result, ended }。
// 重生是每 15 分鐘整點：sinceSpawnSec 讀得到就用 at 往回推出重生時間，讀不到就只看距上次看到有沒有滿 15 分鐘
const CAP = 200;
const SPAWN_MS = 15 * 60 * 1000;
const spawnPassed = (record, now) => (Number.isFinite(record.sinceSpawnSec)
  ? now >= record.at - record.sinceSpawnSec * 1000 + SPAWN_MS
  : now - record.at >= SPAWN_MS);

// event：{ kind: 'appear' | 'request', sinceSpawnSec, area, areaName, room, line? }；回傳新陣列，不改輸入。
// 最後一筆還沒消失、也沒過下一個重生就併進去（說的話附上去，和上一句一樣的不重複；補上原本讀不到的房間）；否則新開一筆
function addSighting(records, event, now) {
  const list = Array.isArray(records) ? records : [];
  const last = list[list.length - 1];
  const said = event.kind === 'request' && event.line ? [event.line] : [];
  if (last && !last.ended && !spawnPassed(last, now)) {
    const merged = { ...last, said: [...last.said] };
    if (said.length && merged.said[merged.said.length - 1] !== said[0]) merged.said.push(said[0]);
    if (!merged.room && event.room) Object.assign(merged, { area: event.area, areaName: event.areaName, room: event.room });
    return [...list.slice(0, -1), merged];
  }
  const fresh = {
    at: now, sinceSpawnSec: Number.isFinite(event.sinceSpawnSec) ? event.sinceSpawnSec : null,
    area: event.area ?? null, areaName: event.areaName ?? '', room: event.room ?? null, said, matched: null, result: null,
  };
  return [...list, fresh].slice(-CAP);
}

// 書生消失：最後一筆標成結束，之後再看到書生算新的一筆
function endSighting(records) {
  const list = Array.isArray(records) ? records : [];
  const last = list[list.length - 1];
  if (!last || last.ended) return list;
  return [...list.slice(0, -1), { ...last, ended: true }];
}

globalThis.CatworldScholar = { parseSpirit, parseSkillCount, canStart, classifyLine, addSighting, endSighting, SIGHTINGS_KEY: 'scholarSightings', CAP };
})();
