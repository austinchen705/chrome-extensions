#!/usr/bin/env node
// 把一份劇本對話的 CSV 推上共用試算表的「劇本」分頁（經 tools/apps-script/push-chat-scripts.gs 部署成的網頁應用程式）。
// 用法：node tools/push-chat-scripts.js <csv> [--turns 7-8] [--dry-run]
//   先跑 tools/check-chat-scripts.js，沒通過就不送；--dry-run 只問試算表會新增、取代哪些劇本，不寫入。
// 網址與密碼：環境變數 CATWORLD_CHAT_PUSH_URL、CATWORLD_CHAT_PUSH_TOKEN，沒有就讀 .scratch/chat-push.json（{ "url": "…", "token": "…" }，不進 git）。
// 密碼不印出來、不寫進 repo。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
require(path.join(root, 'catworld-auto-command', 'zap-mobs.js'));
require(path.join(root, 'catworld-auto-command', 'shared-data.js'));
const S = globalThis.CatworldSharedData;

const HEADER = ['劇本ID', '順序', '誰', '台詞', '備註', '週'];
const CONFIG_FILE = path.join(root, '.scratch', 'chat-push.json');
const URL_PREFIX = 'https://script.google.com/macros/';
const TIMEOUT_MS = 30000;

// CSV → 要送的列（6 格文字，略過空的劇本ID）；標題列不對回 error
function loadRows(text) {
  const records = S.parseCsv(String(text).replace(/\r\n/g, '\n'));
  const head = (records[0] || []).map(cell => cell.trim());
  if (HEADER.some((name, i) => head[i] !== name)) return { error: `標題列要是 ${HEADER.join(',')}` };
  const rows = records.slice(1)
    .filter(record => record[0])
    .map(record => HEADER.map((_, i) => String(record[i] ?? '')));
  return rows.length ? { rows } : { error: '沒有任何劇本列' };
}

// 網址與密碼：環境變數優先，其次設定檔；網址只收 Apps Script 網頁應用程式
function readConfig(env = process.env, file = CONFIG_FILE) {
  let saved = {};
  if (fs.existsSync(file)) {
    try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { error: `${file} 不是 JSON` }; }
  }
  const url = env.CATWORLD_CHAT_PUSH_URL || saved.url || '';
  const token = env.CATWORLD_CHAT_PUSH_TOKEN || saved.token || '';
  if (!url || !token) return { error: `沒有網址或密碼：設定環境變數 CATWORLD_CHAT_PUSH_URL、CATWORLD_CHAT_PUSH_TOKEN，或寫 ${path.relative(root, file)}` };
  if (!url.startsWith(URL_PREFIX)) return { error: `網址要是 ${URL_PREFIX} 開頭的網頁應用程式網址` };
  return { url, token };
}

// 試算表的回覆 → 給人看的幾行
function describe(result) {
  if (!result || result.ok !== true) return [`沒有寫入：${result?.error || '試算表沒有回應'}`];
  const list = ids => (ids.length ? `${ids.length} 份（${ids.join('、')}）` : '0 份');
  const lines = [
    result.dryRun ? '試跑（沒有寫入）：' : '已寫入試算表「劇本」分頁：',
    `新增 ${list(result.added || [])}`,
    `取代 ${list(result.replaced || [])}`,
    `分頁現在共 ${result.rows} 列（不含標題）`
  ];
  if (result.warning) lines.push(`注意：${result.warning}`);
  return lines;
}

async function push({ url, token, rows, dryRun }) {
  const response = await fetch(url, {
    method: 'POST',
    // text/plain：Apps Script 不回應 CORS 預檢，和驗證碼樣本收集同一種送法；POST 會 302 到 googleusercontent，fetch 會跟過去
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ token, rows, dryRun }),
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: `回應不是 JSON（HTTP ${response.status}）：部署時「誰可以存取」要選「所有人」，網址要用 /exec 結尾的那個` };
  }
}

async function main(argv) {
  const file = argv.find((arg, i) => !arg.startsWith('--') && argv[i - 1] !== '--turns');
  if (!file) {
    console.error('用法：node tools/push-chat-scripts.js <csv> [--turns 7-8] [--dry-run]');
    return 2;
  }
  const turns = argv.includes('--turns') ? ['--turns', argv[argv.indexOf('--turns') + 1]] : [];
  const check = spawnSync(process.execPath, [path.join(__dirname, 'check-chat-scripts.js'), file, ...turns], { stdio: 'inherit' });
  if (check.status !== 0) {
    console.error('檢查沒通過，不送。');
    return 1;
  }
  const loaded = loadRows(fs.readFileSync(file, 'utf8'));
  if (loaded.error) { console.error(loaded.error); return 1; }
  const config = readConfig();
  if (config.error) { console.error(config.error); return 1; }
  let result;
  try {
    result = await push({ url: config.url, token: config.token, rows: loaded.rows, dryRun: argv.includes('--dry-run') });
  } catch (err) {
    result = { ok: false, error: `送不出去：${err.message}` };
  }
  describe(result).forEach(line => console.log(line));
  return result?.ok === true ? 0 : 1;
}

if (require.main === module) main(process.argv.slice(2)).then(code => process.exit(code));

module.exports = { loadRows, readConfig, describe, HEADER };
