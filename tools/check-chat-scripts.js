#!/usr/bin/env node
// 檢查一份劇本對話的 CSV（docs/data/chat-scripts-*.csv 的格式，和 docs/templates/shared-chat.csv 一樣）能不能貼進共用試算表。
// 用法：node tools/check-chat-scripts.js <csv> [--turns 7-8]
// 規則和 tests/unit/chat-script-content.test.js 對各批劇本的檢查一致：試算表的驗證規則（buildChatScripts）、遊戲頁的 usableScripts、
// 輪數、A 先說、每則最多 40 字、不碰禁區字眼、不寫相對的週、問句結尾的輪不超過一半、時事劇本（有週）第一列備註有日期與連結、
// 週是星期一，以及開場句和 docs/data 裡其他所有劇本與內建劇本的相似度都低於 MATCH_THRESHOLD（B 才認得出是哪一份）、劇本ID 不重複。
// 全部通過印「OK」並以 0 結束；有問題逐條列出並以 1 結束。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const ext = path.join(root, 'catworld-auto-command');
['zap-mobs.js', 'shared-data.js', 'chat-reply.js', 'chat-script.js', 'chat-script-data.js'].forEach(file => require(path.join(ext, file)));
const S = globalThis.CatworldSharedData;
const C = globalThis.CatworldChatScript;
const similarity = globalThis.CatworldChatReply.similarity;
const BUILTIN = globalThis.CatworldChatScriptData.scripts;

const FORBIDDEN = ['政治', '選舉', '總統', '政府', '戰爭', '死', '傷', '災', '颱風', '地震', '火災', '車禍', '事故'];
const RELATIVE_WEEK = ['這禮拜', '這個禮拜', '下禮拜', '下個禮拜', '上禮拜', '上個禮拜', '這週', '下週', '上週'];
const MAX_PART = 40;

const args = process.argv.slice(2);
const file = args.find(arg => !arg.startsWith('--') && args[args.indexOf(arg) - 1] !== '--turns');
const turnsArg = args.includes('--turns') ? args[args.indexOf('--turns') + 1] : '7-8';
const [minTurns, maxTurns = minTurns] = String(turnsArg).split('-').map(Number);
if (!file || !Number.isInteger(minTurns) || !Number.isInteger(maxTurns)) {
  console.error('用法：node tools/check-chat-scripts.js <csv> [--turns 7-8]');
  process.exit(2);
}

const read = target => fs.readFileSync(target, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
const records = text => S.parseCsv(text).slice(1).filter(record => record[0]);
// 在這份檔的週（第一個有填的週）之內建，過期的也拿得到；都沒有週就用現在
const build = text => {
  const week = records(text).map(record => record[5]).find(Boolean);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(week || '');
  const now = match ? new Date(+match[1], match[2] - 1, +match[3] + 1, 12).getTime() : Date.now();
  return S.buildChatScripts(text, now);
};

const target = path.resolve(file);
const text = read(target);
const built = build(text);
const problems = [];
const say = message => problems.push(message);

if (!built.ok) say(`讀不了：${built.error || '格式不對'}`);
(built.report?.dropped || []).forEach(({ row, reason }) => say(`第 ${row} 列被丟掉：${reason}`));
(built.report?.unmatched || []).forEach(({ row, name, reason }) => say(`第 ${row} 列 ${name} 不會被採用：${reason}`));
const scripts = built.scripts || [];
if (!scripts.length) say('沒有任何能用的劇本');
const usable = C.usableScripts(scripts).length;
if (usable !== scripts.length) say(`遊戲頁只收 ${usable}／${scripts.length} 份（usableScripts）`);

scripts.forEach(script => {
  const turns = C.toTurns(script);
  if (turns.length < minTurns || turns.length > maxTurns) say(`${script.id}：${turns.length} 輪，要 ${minTurns}～${maxTurns} 輪`);
  if (script.lines[0].who !== 'A') say(`${script.id}：第一句不是 A`);
  script.lines.forEach(({ text: line }) => {
    line.split('／').forEach(part => { if ([...part].length > MAX_PART) say(`${script.id}：一則超過 ${MAX_PART} 字：${part}`); });
    FORBIDDEN.forEach(word => { if (line.includes(word)) say(`${script.id}：碰到禁區字眼「${word}」：${line}`); });
    RELATIVE_WEEK.forEach(word => { if (line.includes(word)) say(`${script.id}：寫了「${word}」，過幾天就不對：${line}`); });
  });
  const questions = turns.filter(turn => /[嗎？?沒]$|你呢$/.test(turn.parts[turn.parts.length - 1])).length;
  if (questions * 2 > turns.length) say(`${script.id}：${turns.length} 輪裡有 ${questions} 輪用問句結尾，太像問卷`);
});

// 時事劇本：第一列備註要有日期與連結，週要是星期一
const firstRows = new Map();
records(text).forEach(record => { if (!firstRows.has(record[0])) firstRows.set(record[0], record); });
firstRows.forEach((record, id) => {
  const week = record[5];
  if (!week) return;
  if (!/20\d\d-\d\d-\d\d/.test(record[4])) say(`${id}：時事劇本第一列的備註沒寫新聞日期`);
  if (!/https?:\/\//.test(record[4])) say(`${id}：時事劇本第一列的備註沒寫來源連結`);
  const [y, m, d] = week.split('-').map(Number);
  if (new Date(y, m - 1, d).getDay() !== 1) say(`${id}：週 ${week} 不是星期一`);
});

// 其他所有劇本：docs/data 的其他批次加內建
const dataDir = path.join(root, 'docs', 'data');
const others = [];
fs.readdirSync(dataDir).filter(name => /^chat-scripts-.*\.csv$/.test(name)).map(name => path.join(dataDir, name))
  .filter(other => path.resolve(other) !== target)
  .forEach(other => (build(read(other)).scripts || []).forEach(script => others.push({ script, from: path.basename(other) })));
BUILTIN.forEach(script => others.push({ script, from: '內建' }));

const ownIds = new Set();
scripts.forEach(script => {
  if (ownIds.has(script.id)) say(`${script.id}：劇本ID 重複`);
  ownIds.add(script.id);
  const clash = others.find(other => other.script.id === script.id);
  if (clash) say(`${script.id}：和 ${clash.from} 的劇本ID 重複`);
});

const openers = script => C.toTurns(script)[0].parts;
const all = [...scripts.map(script => ({ script, from: '這份' })), ...others];
scripts.forEach((one, i) => all.forEach((other, j) => {
  if (j <= i && other.from === '這份') return;
  openers(one).forEach(a => openers(other.script).forEach(b => {
    const score = similarity(a, b);
    if (score >= C.MATCH_THRESHOLD) say(`${one.id} 的開場和 ${other.from} 的 ${other.script.id} 太像（${score.toFixed(2)}）：${a}／${b}`);
  }));
}));

if (problems.length) {
  console.log(`${path.basename(target)}：${problems.length} 個問題`);
  problems.forEach(problem => console.log(`- ${problem}`));
  process.exit(1);
}
console.log(`OK：${path.basename(target)} ${scripts.length} 份劇本全部通過（${minTurns}～${maxTurns} 輪，開場句和其他 ${others.length} 份都分得開）`);
