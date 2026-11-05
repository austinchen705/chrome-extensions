// 拜師導師搜尋的純函式（不碰 DOM 與 chrome.*）：把內建資料（mentor-data.js）的每一列「導師、功法、路線」依導師與路線分組、搜尋、排序。
// 路線寫法不同但等價（nu nu 與 2nu）的視為同一條；多位導師共用一條路線的列在產生資料時就已經拆成各自一列；
// 路線轉成巨集指令（走過去用）也是產生資料時做的（tools/mentor-route.js），這裡只帶著用。
(() => {
if (globalThis.CatworldMentorSearch) return;

// 可以重複的走路方向：相鄰的同一個方向合併成 N 倍（nu nu ＝ 2nu）。t、run 這類不是方向的字不合併
const DIRECTIONS = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'nu', 'nd', 'su', 'sd', 'eu', 'ed', 'wu', 'wd', 'u', 'd', 'o']);

const flat = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const norm = text => String(text ?? '').replace(/\s+/g, '').toLowerCase();

// 用來比較兩條路線是不是同一條：空白壓成一個，連續相同的方向合併（nu nu → 2nu）
function canonicalRoute(route) {
  const out = [];
  let last = null;
  flat(route).split(' ').filter(Boolean).forEach(token => {
    const match = /^(\d*)([a-z]+)$/.exec(token);
    if (match && DIRECTIONS.has(match[2])) {
      const count = match[1] ? Number(match[1]) : 1;
      if (last && last.word === match[2]) {
        last.count += count;
        out[out.length - 1] = `${last.count}${last.word}`;
      } else {
        last = { word: match[2], count };
        out.push(count === 1 ? last.word : `${count}${last.word}`);
      }
      return;
    }
    last = null;
    out.push(token);
  });
  return out.join(' ');
}

// 內建資料每一列是 [導師, 功法, 路線, 類別, 最高等級, 配合心法, 巨集指令, 解謎之後的路線, 備註[], 不能自動走的原因]
const rowsFromData = data => (Array.isArray(data) ? data : [])
  .filter(row => Array.isArray(row) && row[0] && row[1] && row[2])
  .map(([mentor, skill, route, category, maxLevel, heart, command, rest, notes, reason]) => ({
    mentor: String(mentor), skill: String(skill), route: String(route), category: String(category ?? ''), maxLevel: String(maxLevel ?? ''), heart: String(heart ?? ''),
    command: String(command ?? ''), rest: String(rest ?? ''), notes: Array.isArray(notes) ? notes.map(String) : [], reason: String(reason ?? ''),
  }));

// 使用者自己改的路線（chrome.storage.local.mentorRoutes：「導師|功法」（忽略空白與大小寫）→ 完整指令，分號隔開的巨集），
// 一個功法一筆、優先於內建資料。內建資料本身不會被改，修改只在讀取時套上去
const routeKey = (mentor, skill) => `${norm(mentor)}|${norm(skill)}`;

// 讀回儲存的修改：只留形狀對的（鍵含 |、值是非空字串），壞資料整筆丟掉、不丟例外
function parseEdits(value) {
  const edits = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return edits;
  Object.entries(value).forEach(([key, command]) => {
    if (key.includes('|') && typeof command === 'string' && command.trim()) edits[key] = command.trim();
  });
  return edits;
}

// 回傳新物件：每個鍵設成 command，command 是空的就移除（改回內建）
function setEdits(edits, keys, command) {
  const next = { ...edits };
  const text = String(command ?? '').trim();
  keys.forEach(key => { if (text) next[key] = text; else delete next[key]; });
  return next;
}

// 匯出成貼進試算表的文字：一行一筆「導師 Tab 功法 Tab 指令」（和 mentors.tsv 前三欄同格式）。
// 儲存的鍵已經壓掉空白與大小寫，名稱從內建資料找回來；內建資料已經沒有的就用鍵上的字
function exportEdits(edits, rows) {
  const names = new Map(rows.map(row => [routeKey(row.mentor, row.skill), [row.mentor, row.skill]]));
  return Object.entries(edits).map(([key, command]) => {
    const [mentor, skill] = names.get(key) || [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
    return [mentor, skill, command.replace(/\s+/g, ' ')].join('\t');
  }).join('\n');
}

// 檢查貼回來的文字，整份通過才回 { ok: true, edits }，否則回說明第幾行的 error。
// 指令格式用 parseSteps 檢查（和編輯框同一個）；多的欄位（mentors.tsv 後面的欄）忽略，空行略過
function parseImport(text, parseSteps) {
  const edits = {};
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const [mentor, skill, command] = lines[i].split('\t').map(field => field.trim());
    const fail = reason => ({ ok: false, error: `第 ${i + 1} 行：${reason}` });
    if (!mentor || !skill || !command) return fail('要是「導師 [Tab] 功法 [Tab] 指令」三欄');
    const checked = parseSteps ? parseSteps(command) : { error: '無法檢查指令格式' };
    if (checked.error) return fail(checked.error);
    edits[routeKey(mentor, skill)] = command;
  }
  if (!Object.keys(edits).length) return { ok: false, error: '沒有內容' };
  return { ok: true, edits };
}

// 把修改套到每一列：路線與巨集指令換成改的那一條（原樣送出），解謎之後的路線、備註、不能自動走的原因都不再適用
function applyEdits(rows, edits) {
  return rows.map(row => {
    const command = edits?.[routeKey(row.mentor, row.skill)];
    return command ? { ...row, route: command, command, rest: '', notes: [], reason: '', edited: true } : row;
  });
}

// 依「導師＋整串路線」分組（路線相同，巨集指令與備註也相同，取第一列的；同組裡有沒改過的就優先取它的）；同一組裡同名的功法只留第一個
function groupRows(rows) {
  const groups = new Map();
  rows.forEach(row => {
    const key = JSON.stringify([row.mentor, canonicalRoute(row.route)]);
    const fields = { route: flat(row.route), command: row.command, rest: row.rest, notes: row.notes, reason: row.reason };
    if (!groups.has(key)) groups.set(key, { mentor: row.mentor, ...fields, fromData: !row.edited, skills: [] });
    const group = groups.get(key);
    if (!group.fromData && !row.edited) Object.assign(group, fields, { fromData: true });
    if (!group.skills.some(skill => skill.skill === row.skill)) group.skills.push({ skill: row.skill, category: row.category, maxLevel: row.maxLevel, heart: row.heart, edited: Boolean(row.edited) });
  });
  return [...groups.values()].map(({ fromData, ...group }) => ({ ...group, edited: group.skills.some(skill => skill.edited) }));
}

// 導師名符合的排前面（0），功法名或配合心法符合的其次（1），同級依導師名；空白時全部列出
function search(groups, query) {
  const needle = norm(query);
  const ranked = [];
  groups.forEach(group => {
    let rank = null;
    if (!needle) rank = 0;
    else if (norm(group.mentor).includes(needle)) rank = 0;
    else if (group.skills.some(skill => norm(skill.skill).includes(needle) || norm(skill.heart).includes(needle))) rank = 1;
    if (rank !== null) ranked.push({ rank, group });
  });
  ranked.sort((a, b) => a.rank - b.rank || (a.group.mentor < b.group.mentor ? -1 : a.group.mentor > b.group.mentor ? 1 : 0));
  return ranked.map(item => item.group);
}

// 一個功法在清單裡的樣子：功法（類別、最高等級、配合心法）
function skillLabel({ skill, category, maxLevel, heart }) {
  const extra = [category, maxLevel ? `最高 ${maxLevel}` : '', heart ? `心法 ${heart}` : ''].filter(Boolean);
  return extra.length ? `${skill}（${extra.join('、')}）` : skill;
}

globalThis.CatworldMentorSearch = { canonicalRoute, rowsFromData, routeKey, parseEdits, setEdits, applyEdits, exportEdits, parseImport, groupRows, search, skillLabel };
})();
