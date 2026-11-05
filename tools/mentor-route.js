// 把試算表上的導師路線原文轉成可以用巨集送出的指令（分號隔開），只在產生資料（tools/gen-mentor-data.js）時用，不隨擴充功能載入。
// 路線原文常夾著說明：括號裡的英文指令（push stone、worship tomb…）是要一起送出的步驟，括號裡的中文是只給人看的提示，
// 「謎」表示這裡要先解謎（工具不替你解），// 之後是備註。只有從醉仙樓出發（run e 5n 2o 起頭）而且每個字都認得的路線才轉，
// 其餘一律回「不能自動走」，寧可不走也不送出猜的指令。
require('../catworld-auto-command/mentor-search.js');

const { canonicalRoute } = globalThis.CatworldMentorSearch;

const FROM_INN = 'run e 5n 2o';
// 括號裡或括號外可以送的動詞：每個動詞後面接一個對象；試算表上的錯字在 TYPOS 修正
const VERBS = new Set(['push', 'open', 'worship', 'enter', 'touch']);
const TYPOS = { oepn: 'open' };
const DIRECTION_WORD = /^\d*[a-z]+$/;
const RIDDLE = '謎';

const flat = text => String(text ?? '').replace(/\s+/g, ' ').trim();

// 括號裡的字是不是可以送的指令（動詞加一個對象），是就回修正錯字後的指令
function commandText(text) {
  const parts = flat(text).split(' ');
  if (parts.length !== 2) return null;
  const verb = TYPOS[parts[0]] ?? parts[0];
  return VERBS.has(verb) ? `${verb} ${parts[1]}` : null;
}

// 把原文切成項目：word（括號外的字）、command（括號裡的指令）、note（括號裡的提示）、riddle（謎，記下它在原文的位置）、tail（// 之後的備註）
function tokenize(route) {
  const text = String(route ?? '');
  const items = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '/' && text[i + 1] === '/') {
      items.push({ type: 'tail', text: flat(text.slice(i + 2)) });
      break;
    }
    if (c === RIDDLE) {
      items.push({ type: 'riddle', at: i });
      i += 1;
      continue;
    }
    if (c === '(' || c === '（') {
      let depth = 0;
      let j = i;
      for (; j < text.length; j += 1) {
        if (text[j] === '(' || text[j] === '（') depth += 1;
        if (text[j] === ')' || text[j] === '）') { depth -= 1; if (depth === 0) break; }
      }
      const inner = text.slice(i + 1, j);
      const command = commandText(inner);
      items.push(command ? { type: 'command', text: command } : { type: 'note', text: flat(inner) });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < text.length && !/[\s(（]/.test(text[j]) && !(text[j] === '/' && text[j + 1] === '/')) j += 1;
    items.push({ type: 'word', text: text.slice(i, j) });
    i = j;
  }
  return items;
}

// 比對用的骨架：括號裡的指令與謎都換成謎、提示與備註丟掉；骨架相同的路線走的是同一條路，只是有的寫了謎有的寫明了指令
function skeleton(route) {
  const items = tokenize(route);
  const parts = [];
  for (let k = 0; k < items.length; k += 1) {
    const item = items[k];
    if (item.type === 'word' && VERBS.has(TYPOS[item.text] ?? item.text) && items[k + 1]?.type === 'word') {
      parts.push(RIDDLE);
      k += 1;
    } else parts.push(item.type === 'word' ? item.text : item.type === 'command' || item.type === 'riddle' ? RIDDLE : '');
  }
  return canonicalRoute(parts.join(' '));
}

const riddles = route => tokenize(route).filter(item => item.type === 'riddle').length;

// 回 { command, rest, notes, reason }：command 是分號隔開的指令（空字串＝不能自動走，原因在 reason）；
// 遇到謎就只轉到謎之前，rest 是謎與後面的原文（沒有謎就是空字串）；notes 是括號裡的中文提示與 // 之後的備註
function parseRoute(route) {
  const fail = reason => ({ command: '', rest: '', notes: [], reason });
  if (!canonicalRoute(route).startsWith(FROM_INN)) return fail('不是從醉仙樓出發');
  const items = tokenize(route);
  const commands = [];
  const notes = [];
  let run = null;
  const closeRun = () => { if (run) commands.push(run.join(' ')); run = null; };
  let rest = '';
  for (let k = 0; k < items.length; k += 1) {
    const item = items[k];
    if (item.type === 'riddle') {
      closeRun();
      rest = flat(String(route).slice(item.at));
      break;
    }
    if (item.type === 'note' || item.type === 'tail') {
      if (item.text) notes.push(item.text);
      continue;
    }
    if (item.type === 'command') {
      closeRun();
      commands.push(item.text);
      continue;
    }
    const word = TYPOS[item.text] ?? item.text;
    if (word === 'run') {
      closeRun();
      run = ['run'];
    } else if (VERBS.has(word)) {
      closeRun();
      const next = items[k + 1];
      if (next?.type !== 'word') return fail('路線寫法無法判讀');
      commands.push(`${word} ${next.text}`);
      k += 1;
    } else if (run && DIRECTION_WORD.test(word)) {
      run.push(word);
    } else {
      return fail('路線寫法無法判讀');
    }
  }
  closeRun();
  return { command: commands.join(';'), rest, notes, reason: '' };
}

module.exports = { parseRoute, skeleton, riddles, tokenize };
