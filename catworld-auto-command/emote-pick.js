// 隨機表情：練功時偶爾做一組相關的表情（semote），不碰 DOM 與 chrome.*。資料是 emote-data.js（由 docs/data/semotes.tsv 產生）。
// 抽法（使用者看過範例後確認，原型在 .scratch/semote/sample-d.js）：
//   1. 第一個亂數 < RARE_CHANCE：從「只能單獨出現」的（太戲劇化、綁場景）抽一個，單獨一組
//   2. 依 WEIGHTS 抽類別；候選＝該類＋鄰近的類（NEAR），思考另外只可接 LIGHT_SIGHS；不用、要對象、只能單獨的都不收
//   3. 第一個從該類抽；耍寶一組一個，其餘 1～3 個，其他的只從順序表上和第一個相差 WINDOW 以內的候選抽，不夠就少做
//   4. 照順序表排（懶懶的在打哈欠前面）
// 前兩組做過的（recent）不用；扣掉之後該類沒有可以當第一個的，就不扣，免得整組做不出來。
// 招呼、加油要有人在旁邊才自然，這版只做「沒人在旁邊」，所以不在 WEIGHTS 裡。
(function () {
  const ROLL_MS = 60 * 1000; // 練功時每分鐘擲一次
  const WARMUP_MS = 5 * 60 * 1000; // 練功組開始後先等這麼久
  const MIN_GAP_MS = 10 * 60 * 1000; // 兩組至少隔這麼久
  const RARE_CHANCE = 0.05;
  const WINDOW = 4;
  const GAP_MIN_SEC = 2;
  const GAP_MAX_SEC = 10;
  const DEFAULT_CHANCE = 5; // 每分鐘幾 %
  const WEIGHTS = [['累', 4], ['動作', 3], ['思考', 3], ['無奈', 2], ['開心', 2], ['大笑', 1], ['耍寶', 1]];
  const NEAR = { 累: ['動作'], 動作: ['累'], 開心: ['大笑'], 大笑: ['開心'], 思考: [], 無奈: [], 耍寶: [] };
  const LIGHT_SIGHS = ['sigh', 'shrug', 'shake', 'headshake'];
  const UNUSABLE = ['不用', '要對象'];

  const entries = data => (data || globalThis.CatworldEmoteData || []).map(([command, category, order, alone]) => ({ command, category, order, alone }));
  const choose = (list, random) => list[Math.min(list.length - 1, Math.floor(random() * list.length))];

  function pick({ data, recent = [], random = Math.random } = {}) {
    const all = entries(data).filter(item => !UNUSABLE.includes(item.category));
    const fresh = list => { const left = list.filter(item => !recent.includes(item.command)); return left.length ? left : list; };
    if (random() < RARE_CHANCE) {
      const rare = all.filter(item => item.alone);
      if (rare.length) { const one = choose(fresh(rare), random); return { category: one.category, commands: [one.command] }; }
    }
    const total = WEIGHTS.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = random() * total;
    const category = (WEIGHTS.find(([, weight]) => (roll -= weight) < 0) || WEIGHTS[WEIGHTS.length - 1])[0];
    const usable = all.filter(item => !item.alone);
    const pool = usable.filter(item => item.category === category || NEAR[category].includes(item.category) || (category === '思考' && LIGHT_SIGHS.includes(item.command)));
    const firsts = fresh(pool.filter(item => item.category === category));
    if (!firsts.length) return { category, commands: [] };
    const first = choose(firsts, random);
    const size = category === '耍寶' ? 1 : 1 + Math.floor(random() * 3);
    const near = pool.filter(item => item !== first && !recent.includes(item.command) && item.order !== null && first.order !== null && Math.abs(item.order - first.order) <= WINDOW);
    const group = [first];
    while (group.length < size && near.length) group.push(near.splice(Math.min(near.length - 1, Math.floor(random() * near.length)), 1)[0]);
    group.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    return { category, commands: group.map(item => item.command) };
  }

  // 組內兩個表情之間隔幾秒（整數，2～10）
  const gapSec = (random = Math.random) => GAP_MIN_SEC + Math.min(GAP_MAX_SEC - GAP_MIN_SEC, Math.floor(random() * (GAP_MAX_SEC - GAP_MIN_SEC + 1)));
  // 一組接成巨集的文字（給 startMacro）：表情之間插 @等待
  const macroText = (commands, random = Math.random) => commands.map((command, i) => (i ? `@等待 ${gapSec(random)};${command}` : command)).join(';');

  // 設定 { enabled, chance }：只有 true 才開；chance 是 0～100 的數字（每分鐘幾 %），其他退回預設
  function normalizeSettings(raw) {
    const value = raw && typeof raw === 'object' ? raw : {};
    const number = typeof value.chance === 'string' && value.chance.trim() !== '' ? Number(value.chance) : value.chance;
    const chance = typeof number === 'number' && Number.isFinite(number) && number >= 0 && number <= 100 ? number : DEFAULT_CHANCE;
    return { enabled: value.enabled === true, chance };
  }

  globalThis.CatworldEmote = { pick, gapSec, macroText, normalizeSettings, ROLL_MS, WARMUP_MS, MIN_GAP_MS, RARE_CHANCE, WINDOW, DEFAULT_CHANCE };
})();
