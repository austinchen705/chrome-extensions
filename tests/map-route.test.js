// 區域地圖的還原與最短路線（純函式，不碰 DOM）：樣本是遊戲地圖視窗裡 m-區域 那一塊的內文（tests/fixtures/map/）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require(path.join(__dirname, '..', 'catworld-auto-command', 'map-route.js'));
const R = globalThis.CatworldMapRoute;

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', 'map', `${name}.html`), 'utf8');
const room = (area, id) => `<a class="H7" id="m-${area}-${id}">□</a>`;
// 把物件（cmd → 房間）轉成一般物件，避免跨 realm 的 deepStrictEqual
const exitsOf = (graph, key) => JSON.parse(JSON.stringify(graph.rooms[key].exits));

test('rooms joined by ─ and │ are linked both ways with n/s/e/w commands', () => {
  const html = [`${room('t', 'a')}─${room('t', 'b')}`, '│　│', `${room('t', 'c')}　${room('t', 'd')}`].join('\n');
  const graph = R.parseArea(html);
  assert.deepEqual(exitsOf(graph, 't/a'), { e: 't/b', s: 't/c' });
  assert.deepEqual(exitsOf(graph, 't/b'), { w: 't/a', s: 't/d' });
  assert.deepEqual(exitsOf(graph, 't/c'), { n: 't/a' });
});

const link = (graph, from, cmd) => graph.rooms[from]?.exits[cmd];

test('diagonal links ╱ ╲ join rooms two cells apart, in both directions', () => {
  const graph = R.parseArea(fixture('emei'));
  assert.equal(link(graph, 'emei/52', 'ne'), 'emei/53');
  assert.equal(link(graph, 'emei/53', 'sw'), 'emei/52');
  const chonyang = R.parseArea(fixture('chonyang'));
  assert.equal(link(chonyang, 'chonyang/14', 'sw'), 'chonyang/rr', 'a chain of single ╱ is one step each');
  assert.equal(link(chonyang, 'chonyang/rr', 'sw'), 'chonyang/l7');
  assert.equal(link(chonyang, 'chonyang/l6', 'ne'), 'chonyang/l7');
});

test('a one-way arrow only lets you go the way it points', () => {
  const graph = R.parseArea(fixture('emei'));
  assert.equal(link(graph, 'emei/53', 'n'), 'emei/54', '↑ from 53 up to 54');
  assert.equal(link(graph, 'emei/54', 's'), undefined, 'and not back down');
  const god = R.parseArea(fixture('godforest'));
  assert.equal(link(god, 'godforest/w2', 'e'), 'godforest/w3');
  assert.equal(link(god, 'godforest/w3', 'w'), undefined);
  const chonyang = R.parseArea(fixture('chonyang'));
  assert.equal(link(chonyang, 'chonyang/l6', 's'), 'chonyang/l5', '↓');
  assert.equal(link(chonyang, 'chonyang/l5', 'n'), undefined);
  assert.equal(link(chonyang, 'chonyang/l3', 'sw'), 'chonyang/l2', '↙ is a one-way diagonal');
  assert.equal(link(chonyang, 'chonyang/l2', 'ne'), undefined);
});

test('a long link is one step: ──, →→→, ←←←, and a column of ↑ over several rows', () => {
  const god = R.parseArea(fixture('godforest'));
  assert.equal(link(god, 'godforest/f1', 'e'), 'godforest/f2', '──');
  assert.equal(link(god, 'godforest/f2', 'w'), 'godforest/f1');
  assert.equal(link(god, 'godforest/w7', 'e'), 'godforest/w4', '→→→');
  assert.equal(link(god, 'godforest/w4', 'w'), undefined);
  assert.equal(link(god, 'godforest/w4', 'e'), 'godforest/w8', 'and ─ right after it goes both ways');
  assert.equal(link(god, 'godforest/m0', 'e'), 'godforest/m1');
  assert.equal(link(god, 'godforest/m2', 'w'), 'godforest/m1', '←←←');
  assert.equal(link(god, 'godforest/m1', 'e'), undefined);
  assert.equal(link(god, 'godforest/f7', 'n'), 'godforest/f8', 'six rows of ↑ in the left column');
  assert.equal(link(god, 'godforest/f8', 's'), undefined);
  const chonyang = R.parseArea(fixture('chonyang'));
  assert.equal(link(chonyang, 'chonyang/l3', 's'), 'chonyang/m1', 'a │ column that passes several rows');
  assert.equal(link(chonyang, 'chonyang/m1', 'n'), 'chonyang/l3');
});

test('an anchor marked N6 is an exit to another area, not a room, and joins nothing', () => {
  const graph = R.parseArea(fixture('snow'));
  assert.equal(graph.rooms['snow/z0'], undefined);
  assert.equal(link(graph, 'snow/0r', 'e'), 'snow/0q');
  assert.equal(Object.keys(graph.rooms).length, 72, "73 anchors in the sample, one of them is the N6 marker");
});

test('an area code that contains a hyphen is read whole', () => {
  const graph = R.parseArea(`${room('oldtomb-corridor', 't6')}─${room('oldtomb-corridor', 't5')}`);
  assert.deepEqual(exitsOf(graph, 'oldtomb-corridor/t6'), { e: 'oldtomb-corridor/t5' });
});

// 照指令真的走一遍，回傳最後到的房間（不用和程式同一套邏輯算期望值）
const walk = (graph, from, commands) => commands.reduce((at, cmd) => graph.rooms[at]?.exits[cmd], from);

test('route: same room is an empty route, an unknown room has none', () => {
  const graph = R.parseArea(`${room('t', 'a')}─${room('t', 'b')}`);
  assert.deepEqual([...R.route(graph, 't/a', 't/a')], []);
  assert.equal(R.route(graph, 't/a', 't/zzz'), null);
  assert.equal(R.route(graph, 't/zzz', 't/a'), null);
});

test('route: takes a shortest way and the commands really lead there', () => {
  // a─b、a 下面 c、b 下面 d、c─d：a 到 d 兩步（e,s 或 s,e）；再接一條長路 d─e─f，f 到 a 要多繞
  const html = [`${room('t', 'a')}─${room('t', 'b')}`, '│　│', `${room('t', 'c')}─${room('t', 'd')}─${room('t', 'e')}`].join('\n');
  const graph = R.parseArea(html);
  const way = R.route(graph, 't/a', 't/d');
  assert.equal(way.length, 2);
  assert.equal(walk(graph, 't/a', way), 't/d');
  const far = R.route(graph, 't/a', 't/e');
  assert.equal(far.length, 3);
  assert.equal(walk(graph, 't/a', far), 't/e');
});

test('route: a one-way link cannot be walked backwards, an unreachable room gives null', () => {
  const graph = R.parseArea(`${room('t', 'a')}→${room('t', 'b')}`);
  assert.deepEqual([...R.route(graph, 't/a', 't/b')], ['e']);
  assert.equal(R.route(graph, 't/b', 't/a'), null);
});

test('route on a real map: the diagonal and the straight way near the foot of emei', () => {
  const graph = R.parseArea(fixture('emei'));
  assert.deepEqual([...R.route(graph, 'emei/00', 'emei/01')], ['n']);
  assert.deepEqual([...R.route(graph, 'emei/00', 'emei/mp')], ['ne']);
  const up = R.route(graph, 'emei/00', 'emei/48');
  assert.ok(up && walk(graph, 'emei/00', up) === 'emei/48', 'the far corner of the map is reachable');
});

test('the other three one-way diagonals ↘ ↖ ↗ point the way they say', () => {
  const se = R.parseArea([room('t', 'a'), '　↘', `　　${room('t', 'b')}`].join('\n'));
  assert.equal(link(se, 't/a', 'se'), 't/b');
  assert.equal(link(se, 't/b', 'nw'), undefined);
  const nw = R.parseArea([room('t', 'a'), '　↖', `　　${room('t', 'b')}`].join('\n'));
  assert.equal(link(nw, 't/a', 'se'), undefined);
  assert.equal(link(nw, 't/b', 'nw'), 't/a');
  const ne = R.parseArea([`　　${room('t', 'a')}`, '　↗', room('t', 'b')].join('\n'));
  assert.equal(link(ne, 't/b', 'ne'), 't/a');
  assert.equal(link(ne, 't/a', 'sw'), undefined);
});

test('the N6 marker between two rooms does not turn into a link between them', () => {
  const graph = R.parseArea(fixture('snow'));
  // 0r 下面隔著 N6 的 ↓ 才是 0t：標記不是連線，所以 0r 只有往上與往右
  assert.deepEqual(Object.keys(graph.rooms['snow/0r'].exits).sort(), ['e', 'n']);
  assert.equal(link(graph, 'snow/0t', 'n'), undefined);
});

test('rooms in separate pieces have no route, and conflicting arrows make no link', () => {
  const apart = R.parseArea(`${room('t', 'a')}\n\n\n${room('t', 'b')}`);
  assert.equal(R.route(apart, 't/a', 't/b'), null);
  const clash = R.parseArea(`${room('t', 'a')}→←${room('t', 'b')}`);
  assert.deepEqual(exitsOf(clash, 't/a'), {});
  assert.deepEqual(exitsOf(clash, 't/b'), {});
  assert.deepEqual(Object.keys(R.parseArea('').rooms), []);
});
