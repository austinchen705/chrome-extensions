// 從 the-cat-world repo 的 daemon/skill 解析所有「悟招」(my_action) 資料，
// 輸出成 catworld-auto-command/skills-data.js 供 skills.html 顯示。
// 用法：node tools/gen-skills-data.js <the-cat-world repo 路徑>
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const repo = process.argv[2];
if (!repo) {
  console.error('用法：node tools/gen-skills-data.js <the-cat-world repo 路徑>');
  process.exit(1);
}
const skillRoot = path.join(repo, 'daemon', 'skill');
const outFile = path.join(__dirname, '..', 'catworld-auto-command', 'skills-data.js');

const read = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const quoted = text => [...text.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(m => m[1]).join('');

const files = [];
for (const letter of fs.readdirSync(skillRoot)) {
  for (const id of fs.readdirSync(path.join(skillRoot, letter))) {
    const file = path.join(skillRoot, letter, id, 'base.c');
    if (fs.existsSync(file)) files.push({ id, source: read(file) });
  }
}

const nameOf = {};
for (const { id, source } of files) {
  nameOf[id] = /name\s*=\s*"([^"]+)"/.exec(source)?.[1] || id;
}

// 取出 `<header> = ({ ... });` 的內文
function arrayBody(source, header) {
  const start = source.search(header);
  if (start < 0) return null;
  const open = source.indexOf('({', start);
  const close = source.indexOf('\n});', open);
  return source.slice(open + 2, close);
}

const intArray = (source, name) => {
  const body = arrayBody(source, new RegExp(`int \\*${name}\\s*=`));
  return body ? body.split(',').map(s => parseInt(s, 10)).filter(Number.isFinite) : null;
};

const typeLabel = {
  sword: '劍', blade: '刀', staff: '杖', whip: '鞭', unarmed: '拳掌', throwing: '暗器', martial: '其他',
};
const textVars = [[/\$N/g, '你'], [/\$n/g, '對手'], [/\$w/g, '武器'], [/\$l/g, '部位'], [/\$a/g, '招式名']];
const readable = s => textVars.reduce((t, [re, to]) => t.replace(re, to), s);

const skills = [];
for (const { id, source } of files) {
  if (!source.includes('my_action')) continue;

  const inherit = /inherit\s+"\/std\/skill\/(\w+)"/.exec(source)?.[1] || 'martial';
  const attackBody = arrayBody(source, /string \*my_attack_name\s*=/);
  const attackNames = attackBody
    ? attackBody.split('\n').map(quoted).filter(Boolean)
    : [];

  const actionBody = arrayBody(source, /mapping \*my_action\s*=/);
  const moves = actionBody.split(/\n\s*\(\[/).slice(1).map((block, index) => {
    const move = { level: index + 1, extra: {} };
    for (const line of block.split('\n')) {
      const m = /^\s*"(\w+)"\s*:\s*(.+?),?\s*$/.exec(line);
      if (!m) continue;
      const [, key, raw] = m;
      if (key === 'name') {
        const ref = /my_attack_name\[(\d+)\]/.exec(raw);
        move.name = ref ? attackNames[Number(ref[1])] : quoted(raw);
      } else if (key === 'action') {
        move.action = readable(quoted(raw));
      } else if (key === 'damage') {
        move.damage = Number.isFinite(Number(raw)) ? Number(raw) : raw;
      } else if (key === 'damage_type') {
        move.damageType = quoted(raw);
      } else if (key === 'post_action') {
        move.extra.effect = /"(\w+)"\s*:\)/.exec(raw)?.[1] || raw;
      } else {
        move.extra[key] = quoted(raw) || raw;
      }
    }
    return move;
  });

  // 解鎖條件：取 improve_new_action 區塊內的判斷式
  const fnStart = source.indexOf('improve_new_action(');
  const fn = source.slice(fnStart, source.indexOf('inspiration(', fnStart));
  const type = Object.keys(typeLabel).find(t => fn.includes(`query_skill_mapped("${t}")`)) || inherit;

  const selfStd = new RegExp(`query_skill\\("${id}", 1\\) < (\\d+) \\+ \\(action_level \\* (\\d+)\\)`).exec(fn);
  const forceConst = /query_skill\("(\w[\w-]*)", 1\) < (\d+)\) \{\n\s+return 4;/.exec(fn);
  const arrSkill = /query_skill\("(\w[\w-]*)", 1\) < (\w+)\[action_level\]/g;
  const arrays = {};
  for (const m of fn.matchAll(arrSkill)) arrays[m[1]] = intArray(source, m[2]);
  const maxForceArr = /query_attr\("max_force", 1\) < (\w+)\[action_level\]/.exec(fn);
  const expArr = /query_weapon_exp\([^)]*\)\) < (\w+)\[action_level\]/.exec(fn);
  const mappedForce = /query_skill_mapped\("force"\)\)? != "([\w-]+)"/.exec(fn)?.[1];
  const roll = /random\((\d+)\) \+ random/.exec(fn)?.[1];
  const gender = /query\("gender"\) != "([^"]+)"/.exec(fn)?.[1];

  const forceId = forceConst?.[1] || Object.keys(arrays).find(k => k !== id) || mappedForce;
  const levels = moves.map((_, i) => {
    const level = {};
    level.self = selfStd ? Number(selfStd[1]) + Number(selfStd[2]) * i : arrays[id]?.[i];
    level.force = forceConst ? Number(forceConst[2]) : arrays[forceId]?.[i];
    if (maxForceArr) level.maxForce = intArray(source, maxForceArr[1])[i];
    if (expArr) level.weaponExp = intArray(source, expArr[1])[i];
    return level;
  });

  skills.push({
    id,
    name: nameOf[id],
    type: typeLabel[type] || type,
    force: forceId,
    forceName: nameOf[forceId] || forceId,
    mappedType: new RegExp(`query_skill_mapped\\("${type}"\\) != "${id}"`).test(fn) ? type : null,
    roll: Number(roll),
    gender: gender || null,
    levels,
    moves,
  });
}

const commit = execSync('git log -1 --format=%h', { cwd: repo }).toString().trim();
const data = { source: 'jrealm/the-cat-world', commit, skills };
fs.writeFileSync(outFile, `// 由 tools/gen-skills-data.js 產生，請勿手改\nconst SKILLS_DATA = ${JSON.stringify(data, null, 1)};\n`);
console.log(`wrote ${outFile}: ${skills.length} skills, ${skills.reduce((n, s) => n + s.moves.length, 0)} moves @ ${commit}`);
