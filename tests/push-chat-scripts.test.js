'use strict';
// 推劇本上試算表：Apps Script（在 vm 裡用假的 SpreadsheetApp 執行）與推送腳本的純函式
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const GS = fs.readFileSync(path.join(root, 'tools', 'apps-script', 'push-chat-scripts.gs'), 'utf8');
const { loadRows, readConfig, describe, HEADER } = require(path.join(root, 'tools', 'push-chat-scripts.js'));

const plain = value => JSON.parse(JSON.stringify(value));

// 假的試算表：cells 是二維文字陣列；記下每次 setNumberFormat 的範圍
function script({ cells, token = 'secret', tab = '劇本' }) {
  const sheet = {
    cells: cells.map(row => row.slice()),
    formats: [],
    getDataRange() {
      const width = Math.max(1, ...sheet.cells.map(row => row.length));
      const rows = sheet.cells.length ? sheet.cells : [[]];
      return { getDisplayValues: () => rows.map(row => Array.from({ length: width }, (_, i) => row[i] ?? '')) };
    },
    getRange(row, col, rows, cols) {
      const range = {
        setNumberFormat(format) { sheet.formats.push([row, col, rows, cols, format]); return range; },
        setValues(values) {
          values.forEach((line, r) => line.forEach((cell, c) => {
            while (sheet.cells.length < row + r) sheet.cells.push([]);
            sheet.cells[row + r - 1][col + c - 1] = cell;
          }));
          return range;
        },
        clearContent() {
          for (let r = 0; r < rows; r += 1) for (let c = 0; c < cols; c += 1) {
            const line = sheet.cells[row + r - 1];
            if (line) line[col + c - 1] = '';
          }
          return range;
        }
      };
      return range;
    }
  };
  const context = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => ({ TOKEN: token, SHEET_ID: 'sheet-1' })[key] }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    SpreadsheetApp: { openById: id => ({ getSheetByName: name => (id === 'sheet-1' && name === tab ? sheet : null) }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: text => ({ setMimeType: () => JSON.parse(text) }) }
  };
  vm.createContext(context);
  vm.runInContext(GS, context);
  const post = body => plain(context.doPost({ postData: { contents: JSON.stringify(body) } }));
  // 分頁的內容（去掉結尾的空列）
  const rows = () => {
    const lines = sheet.cells.map(row => row.slice(0, 6).map(cell => cell ?? ''));
    while (lines.length && lines[lines.length - 1].every(cell => cell === '')) lines.pop();
    return lines;
  };
  return { post, rows, sheet };
}

const line = (id, n, who, text, note = '', week = '') => [id, String(n), who, text, note, week];

test('apps script: new scripts are appended, a script whose ID is already there is replaced in full, others stay', () => {
  const s = script({ cells: [HEADER, line('a', 1, 'A', '舊一'), line('a', 2, 'B', '舊二'), line('a', 3, 'A', '舊三'), line('b', 1, 'A', '別的')] });
  const result = s.post({ token: 'secret', rows: [line('a', 1, 'A', '新一'), line('a', 2, 'B', '新二'), line('c', 1, 'A', '全新', '', '2026-11-16')] });
  assert.deepEqual(result, { ok: true, dryRun: false, added: ['c'], replaced: ['a'], rows: 4 });
  assert.deepEqual(s.rows(), [HEADER, line('b', 1, 'A', '別的'), line('a', 1, 'A', '新一'), line('a', 2, 'B', '新二'), line('c', 1, 'A', '全新', '', '2026-11-16')]);
  // 寫回的範圍是純文字，週才不會被轉成日期
  assert.ok(s.sheet.formats.some(([row, col, rows, cols, format]) => row === 2 && col === 1 && rows === 4 && cols === 6 && format === '@'));
});

test('apps script: a dry run reports what would change and writes nothing', () => {
  const before = [HEADER, line('a', 1, 'A', '舊')];
  const s = script({ cells: before });
  const result = s.post({ token: 'secret', dryRun: true, rows: [line('a', 1, 'A', '新'), line('b', 1, 'A', '新的')] });
  assert.deepEqual(result, { ok: true, dryRun: true, added: ['b'], replaced: ['a'], rows: 2 });
  assert.deepEqual(s.rows(), before);
});

test('apps script: refuses a wrong token, bad rows, a missing tab, a different header and data past column 6', () => {
  const rows = [line('a', 1, 'A', '新')];
  assert.match(script({ cells: [HEADER] }).post({ token: 'nope', rows }).error, /密碼/);
  assert.match(script({ cells: [HEADER], token: '' }).post({ token: '', rows }).error, /沒有指令碼屬性 TOKEN/);
  assert.match(script({ cells: [HEADER], token: null }).post({ token: 'secret', rows }).error, /沒有指令碼屬性 TOKEN/);
  // 屬性值前後多帶的空白不算
  assert.equal(script({ cells: [HEADER], token: '  secret\n' }).post({ token: 'secret', rows }).ok, true);
  assert.match(script({ cells: [HEADER] }).post({ token: 'secret', rows: [] }).error, /沒有任何列/);
  assert.match(script({ cells: [HEADER] }).post({ token: 'secret', rows: [['a', 1, 'A', 'x', '', '']] }).error, /第 1 列/);
  assert.match(script({ cells: [HEADER] }).post({ token: 'secret', rows: [line('', 1, 'A', 'x')] }).error, /劇本ID/);
  assert.match(script({ cells: [HEADER], tab: '樣本' }).post({ token: 'secret', rows }).error, /找不到/);
  const other = script({ cells: [['名稱', '指令'], ['x', 'y']] });
  assert.match(other.post({ token: 'secret', rows }).error, /第一列/);
  assert.deepEqual(other.rows(), [['名稱', '指令'], ['x', 'y']]);
  const wide = script({ cells: [HEADER, [...line('b', 1, 'A', '別的'), '多的']] });
  assert.match(wide.post({ token: 'secret', rows }).error, /第 7 欄/);
});

test('apps script: an empty tab gets the header and the rows', () => {
  const s = script({ cells: [] });
  const result = s.post({ token: 'secret', rows: [line('a', 1, 'A', '一')] });
  assert.equal(result.ok, true);
  assert.deepEqual(s.rows(), [HEADER, line('a', 1, 'A', '一')]);
});

test('apps script: warns when the tab grows past the 2000 rows the extension reads', () => {
  const many = Array.from({ length: 2000 }, (_, i) => line(`old-${i}`, 1, 'A', '舊'));
  const result = script({ cells: [HEADER, ...many] }).post({ token: 'secret', rows: [line('new', 1, 'A', '新')] });
  assert.match(result.warning, /2001 列/);
});

test('push: loadRows reads the batch CSV into six text cells per row', () => {
  const loaded = loadRows(fs.readFileSync(path.join(root, 'docs', 'data', 'chat-scripts-food.csv'), 'utf8'));
  assert.equal(loaded.rows.length, 80);
  assert.ok(loaded.rows.every(row => row.length === 6 && row.every(cell => typeof cell === 'string') && row[0]));
  assert.deepEqual(loaded.rows[0].slice(0, 3), ['food-eg-1', '1', 'A']);
  assert.match(loadRows('名稱,指令\nx,y\n').error, /標題列/);
  assert.match(loadRows(`${HEADER.join(',')}\n`).error, /沒有任何/);
});

test('push: readConfig takes env first, then the local file, and only accepts an Apps Script web app URL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-push-'));
  const file = path.join(dir, 'chat-push.json');
  const url = 'https://script.google.com/macros/s/abc/exec';
  assert.match(readConfig({}, file).error, /沒有網址或密碼/);
  fs.writeFileSync(file, JSON.stringify({ url, token: 't1' }));
  assert.deepEqual(readConfig({}, file), { url, token: 't1' });
  assert.deepEqual(readConfig({ CATWORLD_CHAT_PUSH_TOKEN: 't2' }, file), { url, token: 't2' });
  assert.match(readConfig({ CATWORLD_CHAT_PUSH_URL: 'https://example.com/x' }, file).error, /script\.google\.com/);
  fs.writeFileSync(file, '{');
  assert.match(readConfig({}, file).error, /不是 JSON/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('push: describe says what was added and replaced, and never prints the token', () => {
  const text = describe({ ok: true, dryRun: false, added: ['c'], replaced: ['a', 'b'], rows: 30, warning: '太多' }).join('\n');
  assert.match(text, /新增 1 份（c）/);
  assert.match(text, /取代 2 份（a、b）/);
  assert.match(text, /共 30 列/);
  assert.match(text, /注意：太多/);
  assert.match(describe({ ok: true, dryRun: true, added: [], replaced: [], rows: 0 }).join('\n'), /試跑/);
  assert.match(describe({ ok: false, error: '密碼不對（TOKEN）' })[0], /沒有寫入：密碼不對/);
});
