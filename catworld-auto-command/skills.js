const { source, commit, skills } = SKILLS_DATA;
const $ = id => document.getElementById(id);

const state = { query: '', type: '全部', sort: 'default', expandAll: false };
const typeOrder = ['劍', '刀', '杖', '鞭', '拳掌', '暗器', '其他'];

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  children.flat().forEach(child => node.append(child));
  return node;
}

const peakOf = skill => {
  const damages = skill.moves.map(m => m.damage).filter(Number.isFinite);
  if (damages.length) return { label: '最高傷害', value: Math.max(...damages) };
  const forces = skill.moves.map(m => Number(m.extra.force)).filter(Number.isFinite);
  return { label: '最高內力加成', value: forces.length ? Math.max(...forces) : null };
};

function matches(skill) {
  if (state.type !== '全部' && skill.type !== state.type) return false;
  const q = state.query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [skill.name, skill.id, skill.forceName, skill.force, ...skill.moves.map(m => m.name)]
    .join('\n').toLowerCase();
  return haystack.includes(q);
}

function sorted(list) {
  const copy = [...list];
  if (state.sort === 'roll') return copy.sort((a, b) => a.roll - b.roll || a.name.localeCompare(b.name, 'zh-Hant'));
  if (state.sort === 'power') {
    const damage = s => (s.moves.some(m => Number.isFinite(m.damage)) ? peakOf(s).value : -1);
    return copy.sort((a, b) => damage(b) - damage(a));
  }
  return copy.sort((a, b) => typeOrder.indexOf(a.type) - typeOrder.indexOf(b.type) || a.name.localeCompare(b.name, 'zh-Hant'));
}

function requirementText(skill) {
  const first = skill.levels[0];
  const last = skill.levels.at(-1);
  const standard = skill.levels.every((level, i) => level.self === first.self + 30 * i) && !skill.levels.some(l => l.maxForce);
  const parts = [];
  parts.push(standard
    ? `${skill.name} ≥ ${first.self} + 30 × 已悟招數（第 1 招 ${first.self}，第 ${skill.moves.length} 招 ${last.self}）`
    : `${skill.name} 逐級門檻 ${first.self} → ${last.self}`);
  parts.push(first.force === last.force
    ? `${skill.forceName} ≥ ${first.force}`
    : `${skill.forceName} 逐級門檻 ${first.force} → ${last.force}`);
  parts.push(skill.mappedType
    ? `裝備：force＝${skill.forceName}、${skill.mappedType}＝${skill.name}`
    : `裝備：force＝${skill.forceName}`);
  return parts.join('；');
}

function movesTable(skill) {
  const hasMaxForce = skill.levels.some(l => l.maxForce);
  const hasExp = skill.levels.some(l => l.weaponExp);
  const hasDamage = skill.moves.some(m => Number.isFinite(m.damage));
  const hasForce = skill.moves.some(m => m.extra.force !== undefined);
  const hasEffect = skill.moves.some(m => m.extra.effect);

  const heads = ['#', '招式名', '武功需求', '內功需求'];
  if (hasMaxForce) heads.push('最大內力');
  if (hasExp) heads.push('武器經驗');
  if (hasDamage) heads.push('傷害');
  if (hasForce) heads.push('內力加成');
  heads.push('傷害類型');
  if (hasEffect) heads.push('特效');
  heads.push('描述');
  const numeric = new Set(['#', '武功需求', '內功需求', '最大內力', '武器經驗', '傷害', '內力加成']);

  const thead = el('thead', {}, el('tr', {}, heads.map(h => el('th', { className: numeric.has(h) ? 'num' : '', textContent: h }))));
  const rows = skill.moves.map((move, i) => {
    const level = skill.levels[i];
    const cells = [
      el('td', { className: 'num', textContent: move.level }),
      el('td', { className: 'name', textContent: move.name }),
      el('td', { className: 'num', textContent: level.self }),
      el('td', { className: 'num', textContent: level.force }),
    ];
    if (hasMaxForce) cells.push(el('td', { className: 'num', textContent: level.maxForce ?? '' }));
    if (hasExp) cells.push(el('td', { className: 'num', textContent: level.weaponExp?.toLocaleString() ?? '' }));
    if (hasDamage) cells.push(el('td', { className: 'num', textContent: Number.isFinite(move.damage) ? move.damage : '' }));
    if (hasForce) cells.push(el('td', { className: 'num', textContent: move.extra.force ?? '' }));
    cells.push(el('td', { textContent: move.damageType || '' }));
    if (hasEffect) cells.push(el('td', {}, move.extra.effect ? el('code', { textContent: move.extra.effect }) : ''));
    cells.push(el('td', { className: 'desc', textContent: (move.action || '').replace('招式名', move.name) }));
    return el('tr', {}, cells);
  });
  return el('div', { className: 'scroll' }, el('table', {}, thead, el('tbody', {}, rows)));
}

function card(skill) {
  const peak = peakOf(skill);
  const summary = el('summary', {},
    el('span', { className: 'title', textContent: skill.name }),
    el('span', { className: 'badge', textContent: skill.type }),
    skill.gender ? el('span', { className: 'badge warn', textContent: `限${skill.gender}` }) : '',
    el('span', { className: 'meta', textContent: `內功 ${skill.forceName}` }),
    el('span', { className: 'meta', textContent: `悟招判定 N=${skill.roll}` }),
    el('span', { className: 'meta', textContent: `${skill.moves.length} 招` }),
    peak.value === null ? '' : el('span', { className: 'meta', textContent: `${peak.label} ${peak.value}` }));
  const details = el('details', { open: state.expandAll }, summary,
    el('div', { className: 'body' },
      el('p', { className: 'req', textContent: requirementText(skill) }),
      movesTable(skill)));
  details.id = skill.id;
  return details;
}

function render() {
  const visible = sorted(skills.filter(matches));
  $('count').textContent = `${visible.length} / ${skills.length} 套`;
  const list = $('list');
  list.replaceChildren(...(visible.length ? visible.map(card) : [el('div', { className: 'empty', textContent: '沒有符合的武功' })]));
}

$('source').textContent = `資料來源：${source} @ ${commit}，共 ${skills.length} 套武功、${skills.reduce((n, s) => n + s.moves.length, 0)} 招悟招`;

const typeBox = $('types');
['全部', ...typeOrder.filter(t => skills.some(s => s.type === t))].forEach(type => {
  const chip = el('button', { className: 'chip', type: 'button', textContent: type });
  chip.setAttribute('aria-pressed', String(type === state.type));
  chip.addEventListener('click', () => {
    state.type = type;
    typeBox.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', String(c === chip)));
    render();
  });
  typeBox.append(chip);
});

$('q').addEventListener('input', e => { state.query = e.target.value; render(); });
$('sort').addEventListener('change', e => { state.sort = e.target.value; render(); });
$('toggle').addEventListener('click', e => {
  state.expandAll = !state.expandAll;
  e.target.textContent = state.expandAll ? '全部收合' : '全部展開';
  render();
});

render();
