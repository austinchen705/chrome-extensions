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

// 依「導師＋整串路線」分組（路線相同，巨集指令與備註也相同，取第一列的）；同一組裡同名的功法只留第一個
function groupRows(rows) {
  const groups = new Map();
  rows.forEach(row => {
    const key = `${row.mentor}\u0000${canonicalRoute(row.route)}`;
    if (!groups.has(key)) groups.set(key, { mentor: row.mentor, route: flat(row.route), command: row.command, rest: row.rest, notes: row.notes, reason: row.reason, skills: [] });
    const group = groups.get(key);
    if (!group.skills.some(skill => skill.skill === row.skill)) group.skills.push({ skill: row.skill, category: row.category, maxLevel: row.maxLevel, heart: row.heart });
  });
  return [...groups.values()];
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

globalThis.CatworldMentorSearch = { canonicalRoute, rowsFromData, groupRows, search, skillLabel };
})();
