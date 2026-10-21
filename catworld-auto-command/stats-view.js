// 面板的「數值」區塊要顯示什麼：不碰 DOM，讀數由呼叫端傳入（和觸發規則讀的是同一份：content.js 的 readAllStats）。
// 每一列是「目前值／上限（百分比）」，經驗只有目前值；讀不到的顯示 —，不影響其他列。
// 內力、靈力、法力的目前值可以超過上限（遊戲裡看過是上限的兩倍），百分比照實顯示，不夾在 100%；
// 為什麼可以超過、公式是什麼，遊戲說明站沒有寫，所以只顯示、不解讀。
(() => {
if (globalThis.CatworldStatsView) return;

// 順序和觸發引擎讀數值的順序一致（trigger-engine.js 的 STATS）
const STAT_NAMES = ['精', '氣', '神', '靈力', '內力', '法力', '食物', '飲水'];
const DASH = '—';

const readable = value => typeof value === 'number' && Number.isFinite(value);

function statRow(label, reading) {
  if (!readable(reading?.value)) return { label, text: DASH, percent: null };
  const { value, max } = reading;
  if (!readable(max) || max < 0) return { label, text: `${value}/${DASH}`, percent: null };
  if (max === 0) return { label, text: `${value}/0`, percent: null };
  const percent = Math.round((value / max) * 100);
  return { label, text: `${value}/${max}（${percent}%）`, percent };
}

// readings：{ 精: { value, max } | null, … }；exp：數字或 NaN。回傳 [{ label, text, percent }]
function rows(readings, exp) {
  const experience = { label: '經驗', text: readable(exp) ? String(exp) : DASH, percent: null };
  return [experience, ...STAT_NAMES.map(name => statRow(name, readings?.[name]))];
}

globalThis.CatworldStatsView = { STAT_NAMES, rows };
})();
