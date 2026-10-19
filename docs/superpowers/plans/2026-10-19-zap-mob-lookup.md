# 打怪查詢（zap 攻略資料 第 1 階段）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在遊戲頁面板讀目前經驗（`#exp`），一鍵列出適合打的怪，並在遊戲輸出出現怪物時顯示它的數值、顏色分級、位置與備註。

**Architecture:** 一支 Node 產生腳本把 zap 的 MOB 表、`newstart.3` 新手怪與手動補充檔合併成 `zap-data.json`。extension 內一個不碰 DOM 的模組 `zap-mobs.js` 負責比對與分級（content script、background、測試共用）；background 在第一次被問到時才載入資料並回答查詢；content script 的 `zap-panel.js` 在既有面板的 shadow DOM 加一列「怪物」並監看 `#content` 新增文字。

**Tech Stack:** Chrome MV3、純 JS（IIFE + `globalThis.X`，同現有模組）、Node ≥ 18 的 `node --test`（產生腳本與測試用；不改 `package.json` 的 `engines`，那是安裝腳本的需求）。

**Spec:** `docs/superpowers/specs/2026-10-19-zap-lookup-design.md`（只做其中第 1 階段「打怪」；無名物品、解謎各自另開計畫）

## Global Constraints

- 分級：`q = S × 2 / E`（`S` 怪物強度數字、`E` 為 `#exp`）；`q ≤ 1` 白、`q > 1` 有潛能；預設門檻 `greenMax = 1.5`、`yellowMax = 3`（`1 < q ≤ greenMax` 綠、`≤ yellowMax` 黃、其餘紅），可在設定調。校準點：`E = 414748`，忽必烈 `S = 250000` ＝ 綠，蒙古將軍 `S = 500000` ＝ 黃。
- 比對鍵是完整顯示名稱 `名稱(ID)`，不分大小寫；不用房間名篩選。查無則顯示「表上無此怪」、不給顏色。
- 怪物行格式：`  ※第四代全真弟子(alltruth taoist) [fight][kill]`——去掉 `※` 與行尾 `[…]` 標籤；同房間重複行合併成一筆加數量。
- 只看 `#content` 新增的文字，略過 `#monitor, #map_table, #macro_table, #setting_table`；與自動化是否在跑（`active()`）無關。
- 資料只在 background 第一次被問到時才載入，不隨每個遊戲分頁載入；面板的 UI 放在既有 shadow DOM 內。
- 兩來源合併：以完整名稱（不分大小寫）比對；範圍數值取上限；兩邊數值不同取較大者（僅限該名稱在 zap 只有一列時，多列則保留各列並記錄差異）；補充檔優先於網站。
- 依專案 `CLAUDE.md`：升 `manifest.json` 版本（新功能 minor → `1.20.0`）、`CHANGELOG.md` 最上面加一筆、README 補操作說明；註解用繁中、只寫現況。

## Review Focus

- `#exp` 讀不到或 ≤ 0 → 分級回 `unknown`，面板顯示「讀不到經驗」，不丟例外（Task 1、Task 5）。
- 怪物行的變體：全形括號、多餘空白、`[fight][kill][look]` 任意標籤組合（Task 1）。
- 沒有 `※` 開頭的行（謠言、聊天、含怪名的敘述）不能被當成怪物（Task 1）。
- 房間裡同一隻怪 20 行 → 一筆加 `×20`；不同怪太多時浮層最多顯示 8 筆，其餘「…還有 N 隻」（Task 1、Task 5）。
- MOB 表有數值缺漏／非數字的列 → `exp: null` → 灰色「經驗未知」，不是白色（Task 2）。
- 來源頁面改版導致解析出 0 筆 → 產生腳本非 0 結束、不覆寫既有 `zap-data.json`（Task 3）。

---

## 檔案結構

| 檔案 | 責任 |
|---|---|
| `catworld-auto-command/zap-mobs.js`（新） | 不碰 DOM：名稱正規化、怪物行解析、分級、比對、適合的怪、背景訊息處理 |
| `tools/zap-parse.js`（新） | 不碰網路與檔案：解析兩個來源、合併、套用補充檔 |
| `tools/gen-zap-data.js`（新） | CLI：讀（或抓）來源 → `zap-parse` → 寫 `zap-data.json` |
| `tools/zap-overrides.json`（新） | 使用者維護的補充／覆蓋 |
| `catworld-auto-command/zap-data.json`（產生） | 內建怪物資料，不手改 |
| `catworld-auto-command/zap-panel.js`（新） | 遊戲頁：面板「怪物」列、適合的怪清單、怪物出現浮層 |
| `catworld-auto-command/background.js`（改） | 懶載入資料並回應 `ZAP_LOOKUP`、`ZAP_SUITABLE` |
| `catworld-auto-command/content.js`（改） | 面板加一列容器並呼叫 `CatworldZapPanel.attach` |
| `catworld-auto-command/popup.html`／`popup.js`（改） | 兩個分級門檻的設定 |
| `tests/*.test.js`、`tests/fixtures/*`（新） | `node --test tests/` |

---

### Task 1: `zap-mobs.js` 比對與分級

**Files:**
- Create: `catworld-auto-command/zap-mobs.js`
- Test: `tests/zap-mobs.test.js`（以 `require('../catworld-auto-command/zap-mobs.js')` 載入後讀 `globalThis.CatworldZapMobs`）

**Interfaces:**
- Produces（`globalThis.CatworldZapMobs`）：
  - `DEFAULT_THRESHOLDS = { greenMax: 1.5, yellowMax: 3 }`
  - `normalizeThresholds(raw: unknown): { greenMax: number, yellowMax: number }`——須 `1 < greenMax < yellowMax` 且皆有限數字，否則回預設
  - `normalizeName(text: string): string`——NFKC、轉小寫、空白合併、trim
  - `parseMobLines(text: string): { name: string, count: number }[]`——`name` 是去掉 `※` 與標籤後的 `名稱(ID)`（保留原大小寫），依首次出現順序
  - `gradeOf(strength: number | null, exp: number, thresholds?): { q: number | null, grade: 'white'|'green'|'yellow'|'red'|'unknown' }`
  - `findMobs(mobs: Mob[], name: string): { mob: Mob, idOnly: boolean }[]`——先比完整名稱；沒命中才用括號內 ID，`idOnly: true`
  - `describe(mobs, items: {name, count}[], exp, thresholds?): { name, count, candidates: { mob, q, grade, idOnly }[] }[]`
  - `suitable(mobs, exp, thresholds?, opts?: { grades?: string[], query?: string }): { mob, q, grade }[]`——預設只回 `green`，依 `mob.exp` 由大到小；`query` 比對名稱與位置（不分大小寫）
  - `handleMessage(mobs, message): { ok: true, items: unknown[], total?: number } | null`——`ZAP_LOOKUP`（`names: {name,count}[]`、`exp`、`thresholds`）回 `describe`；`ZAP_SUITABLE`（`exp`、`thresholds`、`grades`、`query`）回前 200 筆並帶 `total`；其他 type 回 `null`
- `Mob`：`{ name: string, id: string, exp: number | null, expMin?: number, expMax?: number, location: string, note: string, source: 'zap'|'newstart'|'override', otherExp?: number[] }`，`id` 是最後一組括號內文字的小寫，`exp` 是分級用的值。

- [ ] **Step 1: Write the failing tests** in `tests/zap-mobs.test.js`，`test` 名稱與斷言如下（`E = 414748`）：
  - `gradeOf calibration`：`gradeOf(250000, 414748).grade === 'green'`、`q` 約 `1.2056`；`gradeOf(500000, 414748).grade === 'yellow'`；`gradeOf(207374, 414748).grade === 'white'`（`q ≤ 1`）；`gradeOf(2000000, 414748).grade === 'red'`。
  - `gradeOf unknown`：`strength` 為 `null`、`exp` 為 `NaN`／`0`／負數，皆回 `{ q: null, grade: 'unknown' }`。
  - `normalizeThresholds`：`{greenMax: 0.5, yellowMax: 3}`、`{greenMax: 3, yellowMax: 2}`、`undefined`、`{greenMax: 'a'}` 皆回 `DEFAULT_THRESHOLDS`；`{greenMax: 2, yellowMax: 4}` 原樣回傳。
  - `parseMobLines sample`：輸入 spec 的房間樣本（三行 `※第四代全真弟子(alltruth taoist) [fight][kill]`，前面有 `迴廊 -`、描述、出口三行）→ `[{ name: '第四代全真弟子(alltruth taoist)', count: 3 }]`。
  - `parseMobLines variants`：`※護衛團 蒙古兵（Guard）  [fight][kill][look]`（全形括號、兩個空白）→ `name` 的 `normalizeName` 等於 `normalizeName('護衛團 蒙古兵(Guard)')`；20 行相同怪 → 一筆 `count: 20`；兩種怪依首次出現順序。
  - `parseMobLines ignores non-mob lines`：`【謠言】某人﹕老虎(tiger)出現了`、`你說道：※老虎(tiger)`、不以 `※` 開頭的 `老虎(tiger) [fight][kill]` → `[]`。
  - `findMobs`：兩筆 `老虎(tiger)`（`location` 桃花島 105000、長安城 500）→ 查 `老虎(TIGER)` 回 2 筆、`idOnly: false`；查 `某前綴 老虎(tiger)` 完整名稱無命中，回 2 筆且 `idOnly: true`；查 `不存在(nobody)` 回 `[]`。
  - `describe unknown`：查無的怪 `candidates` 為 `[]`。
  - `suitable`：給三筆 `exp` 為 250000、60000、`null` 的怪與 `E = 414748`，預設只回 250000 那筆（綠）；`grades: ['green','yellow','white']` 依 `exp` 由大到小；`query: '蒙古'` 只留名稱或位置含「蒙古」的；`exp` 為 `NaN` 時回 `[]`。
  - `handleMessage`：`ZAP_SUITABLE` 回 `{ ok: true, items, total }`；未知 type 回 `null`。

- [ ] **Step 2: Run to verify fail** — Run: `node --test tests/zap-mobs.test.js` — Expected: FAIL（找不到 `zap-mobs.js`）。

- [ ] **Step 3: Implement `zap-mobs.js`** 依上列 Interfaces。檔案開頭用繁中註解說明分級公式與「不碰 DOM」，包成 `(() => { if (globalThis.CatworldZapMobs) return; … })()`，同 `timer-settings.js` 風格。`parseMobLines` 逐行處理：`/^\s*※\s*(.+?)\s*(?:\[[^\]]*\]\s*)*$/`，先 `normalize('NFKC')` 再套用，但回傳的 `name` 取自正規化後文字。分級：`q = strength*2/exp`；`q ≤ 1` 白、`≤ greenMax` 綠、`≤ yellowMax` 黃、其餘紅。

- [ ] **Step 4: Run to verify pass** — Run: `node --test tests/zap-mobs.test.js` — Expected: 全部 PASS。

- [ ] **Step 5: Commit** — `git add catworld-auto-command/zap-mobs.js tests/zap-mobs.test.js` 後 commit「Add zap mob matching and grading module」。

---

### Task 2: `tools/zap-parse.js` 解析、合併、補充檔

**Files:**
- Create: `tools/zap-parse.js`（`module.exports`）
- Create: `tests/fixtures/ot1-sample.html`、`tests/fixtures/newstart3-sample.html`
- Test: `tests/zap-parse.test.js`

**Interfaces:**
- Consumes: `Mob` 形狀（Task 1）。
- Produces:
  - `parseZapMobHtml(html: string): Mob[]`——取有 ≥ 4 個 `<td>` 的 `<tr>`（表頭是 `<th>` 會被略過）；欄位依序為名稱(ID)、強度、位置、備註；解碼 `&nbsp;`、`&amp;`；強度非純數字 → `exp: null`；`source: 'zap'`
  - `parseNewstartHtml(html: string): Mob[]`——去掉 `<script>` 與標籤後逐行以 `/^(.*\([^)]*\))\s*(\d+(?:~+\d+)?)\s*(.*)$/` 解析；範圍 `a~b` 記 `expMin: a`、`expMax: b`、`exp: b`；`location: ''`；備註放 `note`；`source: 'newstart'`
  - `mergeSources(zap: Mob[], newstart: Mob[]): { mobs: Mob[], conflicts: string[] }`——見 Global Constraints 的合併規則；只在 newstart 的怪直接加入；有數值差異時 `conflicts` 加一行「名稱：zap X／newstart Y」
  - `applyOverrides(mobs: Mob[], overrides: { name: string, location?: string, exp?: number, note?: string }[]): { mobs: Mob[], problems: string[] }`——有 `location`：以「名稱＋位置」對得上就覆蓋、對不上就新增（`source: 'override'`）；沒有 `location`：該名稱剛好一隻才覆蓋，否則 `problems` 記錄；名稱完全不存在且無 `location` → `problems`

- [ ] **Step 1: Create fixtures.** `ot1-sample.html`：與原站同樣的 `<table class="order-table">`，一列 `<thead>` 表頭（`<th>`）加下列 `<tr>`（每列四個 `<td>`，空備註用 `&nbsp;`）：`橫霸四方 忽必烈(king)`｜250000｜蒙古｜`&nbsp;`；`猛虎大將軍蒙古將軍(General)`｜500000｜蒙古｜全真劍、太乙先天功；`老虎(tiger)`｜105000｜桃花島｜`&nbsp;`；`後宮之最 貴夫人(lady)`｜100000｜長安｜`&nbsp;`；`虎頭人(tiger man)`｜45000｜`某地`｜`&nbsp;`；`食魂獸(eat ghost)`｜70000｜甲｜`&nbsp;` 與｜75000｜乙｜`&nbsp;`（兩列同名）；`怪異(weird)`｜`？？？`｜丙｜`&nbsp;`。`newstart3-sample.html`：含 `<script>` 與標籤的簡化頁面，內容行（`名稱(ID)` 與數值之間為多個空白）：`第四代全真弟子(Alltruth taoist)   2000肉腳，練好玩的`、`老虎(tiger)   500不好打`、`後宮之最 貴夫人(lady)   20000`、`虎頭人(tiger man)   40000`、`火龜(fire turtle)   40000~50000`、`土匪(bandit)   3000~~~~6000`、`食魂獸(eat ghost)   75000~80000`、`備註:相關資料,請前往 http://catworld.muds.me/ 查詢..`（最後一行不是怪，不能被解析）。

- [ ] **Step 2: Write the failing tests** in `tests/zap-parse.test.js`：
  - `parseZapMobHtml`：回 8 筆；忽必烈 `{ exp: 250000, location: '蒙古', id: 'king' }`；`怪異(weird)` `exp: null`；備註 `&nbsp;` 解成 `''`。
  - `parseNewstartHtml`：回 6 筆（備註行不算）；`第四代全真弟子(Alltruth taoist)` `exp: 2000`、`note` 為「肉腳，練好玩的」；`火龜(fire turtle)` `{ expMin: 40000, expMax: 50000, exp: 50000 }`；`土匪(bandit)` `{ expMin: 3000, expMax: 6000 }`。
  - `mergeSources`：`Alltruth taoist` 只在 newstart → 保留、`location: ''`；`老虎(tiger)` zap 105000 vs newstart 500 → 一筆、`exp: 105000`、`otherExp: [500]`、`conflicts` 含「老虎」；`貴夫人` → `exp: 100000`；`虎頭人` → `exp: 45000`；`火龜` 只在 newstart；`食魂獸` zap 有兩列（70000、75000）→ 兩列各自保留、`conflicts` 含「食魂獸」；名稱比對不分大小寫（造一筆 zap `Alltruth taoist`、newstart 小寫，只留一筆）。
  - `applyOverrides`：`{ name: '老虎(tiger)', location: '長安城', exp: 500 }` → 新增一筆，`老虎(tiger)` 共兩筆，`桃花島` 那筆不變；`{ name: '虎頭人(tiger man)', exp: 45000 }` 覆蓋唯一那筆；對有兩列的 `食魂獸(eat ghost)` 不帶 `location` → `problems` 非空且不改任何列；`{ name: '不存在(nobody)', exp: 1 }` → `problems` 非空。

- [ ] **Step 3: Run to verify fail** — Run: `node --test tests/zap-parse.test.js` — Expected: FAIL。

- [ ] **Step 4: Implement `tools/zap-parse.js`** 依 Interfaces；用 regex 解析即可，不加相依套件；比對用與 Task 1 相同的正規化（NFKC、小寫、空白合併）——在檔內自己寫一份小函式，不 `require` extension 檔。

- [ ] **Step 5: Run to verify pass** — Run: `node --test tests/zap-parse.test.js` — Expected: 全部 PASS。

- [ ] **Step 6: Commit** — 加入 `tools/zap-parse.js tests/zap-parse.test.js tests/fixtures/`，commit「Add zap source parsers, merge and overrides」。

---

### Task 3: 產生腳本、補充檔與 `zap-data.json`

**Files:**
- Create: `tools/gen-zap-data.js`、`tools/zap-overrides.json`
- Modify: `tools/zap-parse.js`（新增 `buildData`）
- Generate: `catworld-auto-command/zap-data.json`
- Modify: `package.json`（加 `"scripts": { "test": "node --test tests/" }`）
- Test: `tests/zap-build.test.js`

**Interfaces:**
- Consumes: Task 2 的三個函式。
- Produces:
  - `buildData(input: { zapHtml, newstartHtml, overrides }, limits?: { minZap?: number, minNewstart?: number }): { data: { sources: string[], mobs: Mob[] }, report: string[], problems: string[] }`——zap 解析出少於 `minZap`（預設 100）筆或 newstart 少於 `minNewstart`（預設 20）筆時 `throw new Error('來源解析異常…')`；`report` 含來源筆數、conflicts；`problems` 來自 `applyOverrides`
  - CLI：`node tools/gen-zap-data.js [--from-dir <dir>]`。有 `--from-dir` 時讀 `<dir>/ot1.htm`、`<dir>/newstart.3.html`；否則用 `fetch` 抓 `https://zap.muds.me/ot1.htm` 與 `https://catworld.muds.tw/help/newstart.3`（皆 UTF-8）。印出 `report`；`problems` 非空或 `buildData` 丟例外時 `process.exitCode = 1` 且**不寫檔**。

- [ ] **Step 1: Write the failing test** in `tests/zap-build.test.js`：
  - `buildData with fixtures`：用 Task 2 的 fixtures（`ot1-sample` 只有 8 列、不足 100 筆）時應丟例外 → 斷言 `throws`（訊息含「來源解析異常」）；另提供一個測試用參數 `buildData(input, { minZap: 1, minNewstart: 1 })`（第二個參數覆寫門檻），以 fixtures 成功時 `mobs` 含 `第四代全真弟子(Alltruth taoist)` 與兩筆 `老虎(tiger)`（帶 overrides `長安城` 500）。
  - `buildData rejects empty source`：`zapHtml: '<html></html>'` 丟例外。

- [ ] **Step 2: Run to verify fail** — Run: `node --test tests/zap-build.test.js` — Expected: FAIL（`buildData` 未定義）。

- [ ] **Step 3: Implement `buildData` and `tools/gen-zap-data.js`.** 寫檔前先序列化成字串，成功才一次寫入 `catworld-auto-command/zap-data.json`（縮排 1 空白，與 `skills-data.js` 風格相近）。

- [ ] **Step 4: Write `tools/zap-overrides.json`**（陣列，規格「已定案的手動補充」）：`老虎(tiger)`＋`長安城`＋500；`後宮之最 貴夫人(lady)` 100000；`虎頭人(tiger man)` 45000；`天南段家第十七代直傳弟子 書生(scholar)` 750000（後三筆不帶 `location`）。

- [ ] **Step 5: Run to verify pass** — Run: `node --test tests/zap-build.test.js` — Expected: PASS。

- [ ] **Step 6: Generate real data.** Run: `node tools/gen-zap-data.js`（需連網）。Expected: 結束碼 0；`report` 列出差異（老虎、貴夫人、虎頭人、書生、食魂獸等）；`problems` 為空。用 `node -e` 讀 `zap-data.json` 確認：含 `第四代全真弟子(Alltruth taoist)` 且 `exp === 2000`；`老虎(tiger)` 共兩筆，位置含「桃花島」`exp 105000`、位置「長安城」`exp 500`（若 zap 原列位置文字不含「桃花島」，在補充檔補一筆 `老虎(tiger)`＋`桃花島`＋105000 並重新產生）；`忽必烈` 的 `exp === 250000`、`蒙古將軍` 的 500000 那筆存在。

- [ ] **Step 7: Commit** — 加入 `tools/ tests/zap-build.test.js package.json catworld-auto-command/zap-data.json`，commit「Add zap data generator, overrides and generated mob data」。

---

### Task 4: background 懶載入與訊息

**Files:**
- Modify: `catworld-auto-command/background.js`
- Test: `tests/zap-mobs.test.js`（`handleMessage` 已在 Task 1 測；此 task 只做接線，無新單元測試）

**Interfaces:**
- Consumes: `CatworldZapMobs.handleMessage(mobs, message)`；`zap-data.json` 的 `{ mobs }`。
- Produces: 對 content script 的 `chrome.runtime.sendMessage({ type: 'ZAP_LOOKUP' | 'ZAP_SUITABLE', … })` 回應 `{ ok: true, items, total? }`，載入失敗回 `{ ok: false, error: string }`。

- [ ] **Step 1: 接線。** `background.js` 開頭加 `importScripts('zap-mobs.js')`（classic service worker）；新增 `let zapMobsPromise = null` 與 `loadZapMobs()`（第一次呼叫才 `fetch(chrome.runtime.getURL('zap-data.json'))` 並快取 Promise，失敗要清掉快取以便重試）；新增一個獨立的 `chrome.runtime.onMessage.addListener`，只處理 `message.type` 以 `ZAP_` 開頭者：`loadZapMobs().then(mobs => sendResponse(CatworldZapMobs.handleMessage(mobs, message) ?? { ok: false, error: '未知的查詢' }))`，`catch` 回 `{ ok: false, error: e.message }`，並 `return true`。不能動既有監聽器的 `if (!sender.tab) return;`。

- [ ] **Step 2: 驗證落地。** Run: `git diff --stat catworld-auto-command/background.js` 與 `Grep "importScripts|ZAP_" catworld-auto-command/background.js`，Expected: 看得到新增行；既有 `TOGGLE_SETTINGS`、`ALERT` 處理未被改動。真正行為在 Task 5 於載入的 extension 內驗證。

- [ ] **Step 3: Commit** — 「Serve zap mob queries from the background worker」。

---

### Task 5: 遊戲頁面板「怪物」列、適合的怪、出現浮層

**Files:**
- Create: `catworld-auto-command/zap-panel.js`
- Modify: `catworld-auto-command/manifest.json`（content script 的 `js` 在 `content.js` 之前加入 `zap-mobs.js`、`zap-panel.js`）、`catworld-auto-command/content.js`（`initPanel` 加一列容器並呼叫 `attach`）
- Test: 顯示邏輯的純函式放進 `zap-mobs.js` 並在 `tests/zap-mobs.test.js` 補測；DOM 部分手動驗證

**Interfaces:**
- Consumes: `CatworldZapMobs`；`ZAP_LOOKUP`／`ZAP_SUITABLE` 訊息；`chrome.storage.local` 鍵 `zapThresholds`（Task 6 寫入）。
- Produces:
  - `CatworldZapPanel.attach(root: ShadowRoot, deps: { readExp: () => number })`——在 `root` 內 `.body` 末端加「怪物」列（按鈕「適合的怪」）與浮層／清單區並綁定事件
  - 新增純函式（放 `zap-mobs.js`）`limitHints(items: { name, count }[], max: number): { shown: { name, count }[], hidden: number }`、`recentFilter(names: string[], now: number, lastShown: Record<string, number>, windowMs: number): string[]`（回傳視窗內沒提示過的名稱，並更新 `lastShown`）

- [ ] **Step 1: Write the failing tests**（補在 `tests/zap-mobs.test.js`）：`limitHints` 對 12 筆、`max = 8` 回 `shown.length === 8`、`hidden === 4`；`recentFilter(['a'], 1000, last, 10000)` 第一次回 `['a']`，`now = 5000` 再呼叫回 `[]`，`now = 12000` 再呼叫回 `['a']`。Run: `node --test tests/zap-mobs.test.js` — Expected: 新增的測試 FAIL。

- [ ] **Step 2: Implement** `limitHints`、`recentFilter` 並讓測試 PASS（Run 同上，Expected: PASS）。

- [ ] **Step 3: Implement `zap-panel.js`.**
  - 讀經驗：`readExp()` 由 `content.js` 傳入，讀 `#exp` 的 `textContent`（去掉逗號與空白，轉 `Number`）；回 `NaN` 時按鈕下方顯示「讀不到經驗」，不送訊息。
  - 「適合的怪」按鈕：點擊切換清單區；展開時送 `ZAP_SUITABLE { exp, thresholds, grades: ['green'], query }`，清單每列顯示：名稱、強度、位置、備註（缺的欄位略過）；有搜尋框（輸入即重送查詢，300 ms 去抖）與「含黃色」勾選（`grades` 變成 `['green','yellow']`）；`ok: false` 時顯示 `error`。顏色：白 `#555555`、綠 `#3ecf6e`、黃 `#e6c029`、紅 `#ff5c4d`、未知灰 `#999`。清單內容超過 200 筆時顯示「共 N 筆，只列前 200」。
  - 怪物出現：自己建一個 `MutationObserver`（觀察 `document.body`，`subtree + childList + characterData`），只取 `closest('#content')` 內新增節點／文字，排除 `#monitor, #map_table, #macro_table, #setting_table`（同 `content.js` 的 `inGameWindow`，這裡自帶一份選擇器字串，不 import `content.js` 的私有函式）；不看 `active()`。新文字交 `parseMobLines`，`recentFilter(…, 10000)` 過濾後送 `ZAP_LOOKUP`；浮層用 `limitHints(…, 8)`，每筆顯示 `名稱 ×數量`、顏色、`q`（兩位小數）、位置；`candidates` 多筆時全部列出（標出 `idOnly` 者為「僅 ID 命中」）；查無顯示「表上無此怪」；浮層 10 秒後自動消失，新的提示取代舊的。
  - 所有 `chrome.runtime.sendMessage` 都 `catch` 並顯示簡短錯誤（背景可能剛被收掉）。

- [ ] **Step 4: Wire `content.js` and manifest.** `initPanel` 的模板不動結構，只在建立 `root` 之後（`panel = {…}` 前後皆可）呼叫 `CatworldZapPanel.attach(root, { readExp: () => Number((document.getElementById('exp')?.textContent || '').replace(/[,\s]/g, '')) })`。manifest 的 `js` 順序：`trigger-engine.js`、`timer-settings.js`、`macro-wait.js`、`macro-notes.js`、`zap-mobs.js`、`zap-panel.js`、`content.js`。

- [ ] **Step 5: 驗證落地與手動驗證。** 先 `git diff` 確認 manifest、`content.js` 有改。接著請使用者在 `chrome://extensions` 重新載入 extension 並重新整理遊戲頁，逐項確認：(a) 面板多一列「怪物」；(b) 按「適合的怪」列出綠色怪，`exp` 為目前 `#exp`，數值依強度由大到小；(c) 走進有怪的房間，出現浮層且顏色與遊戲內名稱顏色一致；(d) 走進「第四代全真弟子」房間顯示白色並合併成 `×N`；(e) 沒有任何自動化在跑時以上仍有效；(f) 新增或重畫 `#monitor` 數字不會觸發浮層。DOM 與樣式測不出的問題以真實頁面為準（見專案 `CLAUDE.md`）。

- [ ] **Step 6: Commit** — 「Add monster panel row, suitable-mob list and appearance hints」。

---

### Task 6: 分級門檻設定

**Files:**
- Modify: `catworld-auto-command/popup.html`、`catworld-auto-command/popup.js`、`catworld-auto-command/zap-panel.js`
- Test: `tests/zap-mobs.test.js`（`normalizeThresholds` 已在 Task 1 測）

**Interfaces:**
- Consumes: `CatworldZapMobs.normalizeThresholds`、`DEFAULT_THRESHOLDS`。
- Produces: `chrome.storage.local.zapThresholds: { greenMax, yellowMax }`；`zap-panel.js` 啟動時讀取並監聽 `storage.onChanged`，改了馬上生效（做法同 `persistentAlert`）。

- [ ] **Step 1: popup 設定。** `popup.html` 在 `.alertbox` 之後新增一個區塊「怪物分級門檻」，兩個數字欄 `zapGreenMax`、`zapYellowMax`（`step=0.1`）與一行說明：`q = 怪物數值×2 ÷ 目前經驗；q ≤ 1 白；綠 ≤ 綠上限；黃 ≤ 黃上限；其餘紅`；`popup.html` 載入 `zap-mobs.js`（在 `popup.js` 之前）。`popup.js`：載入時以 `normalizeThresholds(stored)` 填欄位；`change` 時以 `normalizeThresholds` 檢查，無效就把欄位還原成目前有效值並在 `setStatus` 顯示「門檻需 1 < 綠上限 < 黃上限」，有效才 `chrome.storage.local.set({ zapThresholds })`。

- [ ] **Step 2: panel 套用。** `zap-panel.js` 的 `thresholds` 變數啟動時 `normalizeThresholds((await storage.get('zapThresholds')).zapThresholds)`，`onChanged` 時更新並在清單展開中重新查詢。

- [ ] **Step 3: 驗證。** `git diff` 確認三個檔案都有改；手動：在設定頁把綠上限改成 `1.1`，面板「適合的怪」清單變短、重新載入後仍保留；輸入 `0.5` 被還原並顯示提示。

- [ ] **Step 4: Commit** — 「Add configurable grading thresholds」。

---

### Task 7: 版本、紀錄與說明

**Files:**
- Modify: `catworld-auto-command/manifest.json`（`version` → `1.20.0`）、`CHANGELOG.md`、`README.md`、`CLAUDE.md`、`.gitignore`（不需要改則略過）

- [ ] **Step 1:** `manifest.json` 的 `version` 改 `1.20.0`；`CHANGELOG.md` 最上面加 `## 1.20.0（2026-10-19）`，寫使用者看得到的變化：面板「怪物」列、適合的怪、怪物出現浮層與顏色、門檻設定、資料來源（zap 攻略站、新手怪列表）與「資料是內建的，來源更新需重新產生」。
- [ ] **Step 2:** `README.md` 新增「怪物查詢」小節：顏色意義、`q` 公式、「查無此怪」的意思、怎麼調門檻、怎麼補資料（編輯 `tools/zap-overrides.json` 後執行 `node tools/gen-zap-data.js`）。
- [ ] **Step 3:** `CLAUDE.md` 新增「怪物查詢」小節（只寫現況）：資料由 `tools/gen-zap-data.js` 產生、不手改 `zap-data.json`；`zap-mobs.js` 不碰 DOM、content script／background／測試共用，manifest 要在 `content.js` 之前載入；資料只由 background 懶載入；怪物浮層的觀察與 `active()` 無關、只看 `#content` 新增文字並略過浮動視窗；測試用 `npm test`。
- [ ] **Step 4: 驗證。** Run: `npm test` — Expected: 全部 PASS；`Grep '"version": "1.20.0"' catworld-auto-command/manifest.json` 有命中；`git diff --stat` 列出的檔案與上列一致。
- [ ] **Step 5: Commit** — 「Release v1.20.0: monster lookup」。提醒使用者到 `chrome://extensions` 重新載入並重新整理遊戲頁。
