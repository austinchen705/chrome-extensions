# 解謎查詢（zap 第 4 階段）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在遊戲頁面板列出「我現在能解哪些謎」（依經驗與內力分組），看步驟、一步一步把指令送進遊戲、補缺的指令、標記已解過。

**Architecture:** 產生腳本解析 `qu1.htm`（總表）、`list.html`（選單）與約 40 個步驟頁成 `zap-data.json` 的 `riddles` 與 `pages`；DOM 無關的 `zap-riddles.js`（條件解析、分組、指令切割、補充指令）；background 回應 `ZAP_RIDDLES`；`zap-riddle-ui.js` 在面板 shadow DOM 加「解謎」列與清單／步驟檢視；「送出」直接走 `content.js` 既有的 `startMacro`（算 `active()`、驗證碼時取消、面板有停止鈕）。

**Tech Stack:** 同前（MV3、IIFE + `globalThis.X`、`node --test`）。

**Spec:** `docs/superpowers/specs/2026-10-19-zap-riddle-design.md`（第 4 階段；與第 1、2 階段同一分支 `zap-mob-lookup`）

## Global Constraints

- 條件分組：`無` → 夠；可讀的條件（經驗取 `#exp`、內力取 `#max_force`）都達標且沒有讀不到的部分 → 夠；可讀的達標但另含讀不到的部分（`[天賦]`、`技能`、`需為新手`、`未知`、`不一定`、`????`、`[註]`、或完全看不懂）→ 需自行確認；任何可讀的條件未達 → 未達（**未達優先於需自行確認**）；需要的數值讀不到（`NaN`）→ 需自行確認，不當成未達。
- 分組內排序：難度 `極易 易 一般 難 極難`，其他（`????`）最後；同難度依總表原順序。
- 指令自動抽取是**保守的**：一步只要有任何一段不被認得就整步不給自動指令（寧可空白讓使用者補，也不給只有一半的指令）；使用者補的指令優先於網站。
- 解謎步驟內的 `run` 路徑保持網站原樣，不補 `run e 5n 2o`。
- 「送出」只送使用者**看得到**的那一串指令（有補的用補的，否則用網站抽出的），一次一步；走 `startMacro`；沒有指令時按鈕停用。
- 本機儲存：`chrome.storage.local.riddleCommands`＝`{ [頁面檔名]: { n: 編輯時該頁步驟數, cmds: { [步驟序號]: 指令字串 } } }`；`riddleDone`＝`{ [謎 id]: true }`。步驟序號是該頁解析出的步驟的 1 起算位置（不是頁面印的編號，因為共用頁會重新編號）。`n` 與目前步驟數不同時標示「步驟已變動，請確認」。
- 資料併入 `zap-data.json`（新增 `riddles`、`pages`），仍由 background 懶載入；新模組要同時加進 manifest、popup 備援注入 `files`（popup.html 不需要），且在 `zap-panel.js`／`content.js` 之前。
- 依專案 `CLAUDE.md`：版本升 minor → `1.22.0`；`CHANGELOG.md`、README、`CLAUDE.md` 只寫現況；測試用 `npm test`；第 1、2 階段既有測試必須維持通過。

## Review Focus

- 讀不到 `#exp` 或 `#max_force`（狀態視窗被關掉）→ 所有謎歸「需自行確認」並提示，不丟例外（Task 3、Task 5）。
- 總表條件字串逐一分組正確，包含 `內力 ???? [天賦]`、`需為新手`、`未知`、`不一定`、`150 萬 EXP [註]`；未達優先於需自行確認（Task 3）。
- 補的指令在該頁步驟數變動後不能悄悄套到別的步驟（Task 3、Task 5）。
- 指令抽取的保守性：含「、」後接另一個指令、含 `<3>run …` 內嵌指令、前面有中文說明的步驟都不給半截指令（Task 1）。
- 沒有編號步驟的頁面（屠龍刀、拜師表）顯示整頁文字，不是空白（Task 1、Task 5）。
- 匯入了壞掉的 JSON 不能清掉既有的補充指令與已解過標記（Task 5）。
- 步驟指令寫了格式錯誤的 `@等待` → 顯示巨集的錯誤提示，不丟例外、不送出任何指令（Task 5）。
- 產生腳本在總表解析出少於 40 個謎時失敗、不覆寫；總表與選單對不上的項目列在報告（Task 2）。

---

## 檔案結構

| 檔案 | 責任 |
|---|---|
| `tools/zap-parse.js`（改） | `extractCommands`、`parseRiddlePage`、`parseRiddleIndex`、`parseRiddleMenu`、`buildRiddles`；`buildData` 納入 `riddles`、`pages` |
| `tools/gen-zap-data.js`（改） | 讀／抓 `qu1.htm`、`list.html` 與全部步驟頁 |
| `catworld-auto-command/zap-data.json`（重新產生） | 新增 `riddles`、`pages` |
| `catworld-auto-command/zap-riddles.js`（新） | 不碰 DOM：條件解析、分組、搜尋、指令切割、補充指令與步驟變動判斷、`ZAP_RIDDLES` 訊息處理 |
| `catworld-auto-command/background.js`（改） | 分派 `ZAP_RIDDLES` |
| `catworld-auto-command/zap-riddle-ui.js`（新） | 面板「解謎」列、清單、步驟檢視、補指令、送出、已解過、匯出／匯入 |
| `catworld-auto-command/content.js`、`manifest.json`、`popup.js`（改） | 掛上 UI；載入新模組 |
| `tests/zap-riddles.test.js`、`tests/fixtures/riddles/*`（新）與既有測試檔 | 測試與 fixture |

---

### Task 1: 步驟頁解析與保守的指令抽取

**Files:**
- Modify: `tools/zap-parse.js`
- Create: `tests/fixtures/riddles/`（真實頁面快照：`qu1-1.htm qu1-4.htm qu1-5.htm qu2-1.htm qu4-1.htm qu6-1.htm qu6-3.htm`）
- Test: `tests/zap-riddle-parse.test.js`

**Interfaces:**
- Produces（`tools/zap-parse.js` 匯出）：
  - `VERBS: Set<string>` = `run ask give climb jump ride push kill search open enter squeeze get nod say touch fly apprentice setplace wield unlock pay wear diving dig buy wash write knock exert enforce unwield burying recall put worship insert`
  - `extractCommands(stepText: string): string`——見下方規則；回傳以 `;` 連接的指令字串，不認得整步就回 `''`
  - `parseRiddlePage(html: string): { steps: { no: number, text: string, commands: string }[], text: string }`——`text` 是清理後的整頁文字（行以 `\n` 連接，去掉 BOM、`回上頁`、頁面檔名那一行）；`steps` 只含編號步驟：行首符合 `^\s*(\d+)\s*[\.．、]\s*(.*)$` 開新步驟，之後沒有編號的行接到該步驟（以單一空格連接）直到遇到 `回上頁`；沒有編號步驟的頁面 `steps` 為 `[]`
- **`extractCommands` 規則**（先把步驟文字以 `;`／`；` 切段、去空段；任一段不被認得就整步回 `''`）：
  1. 段首要是 `[A-Za-z][A-Za-z0-9-]*`；轉小寫後必須在 `VERBS` 內，或符合方向（`^\d*(n|s|e|w|u|d|ne|nw|se|sw|nu|nd|su|sd|eu|ed|wu|wd)$`），否則不認得。
  2. 指令取「段首起算的 ASCII 前綴」`^[A-Za-z0-9 \-_#'.,:+/@<>~=*]*`；若動詞不是 `run`、也不是方向，且 ASCII 前綴以空白結尾、下一個字元是中文，則再接上一串連續中文（`[一-鿿]+`）當引數（例如 `ask yueh about 令狐沖`、`buy 牛皮酒袋`、`say 是`）。
  3. 去掉指令尾端的 `[\s\-=>~*.,:<]+`，連續空白合成一個。
  4. 指令之後剩下的說明文字若含任何 `VERBS` 內的單字（以非英文字母為界），這一段視為不認得（代表後面還有別的指令）。例：`run e 5n 2o 2se t 7e se 2s e 等[啞僕(YaBa man)]` 的剩餘文字沒有動詞，認得；`ask thief about 鴛鴦五珍膾、give fish to thief` 剩餘含 `give`，不認得。
- Consumes: 檔內既有的 `decode`／`cellText` 風格輔助函式。

- [ ] **Step 1: Save fixtures** — Run: `mkdir -p tests/fixtures/riddles && for f in qu1-1 qu1-4 qu1-5 qu2-1 qu4-1 qu6-1 qu6-3; do curl -sL https://zap.muds.me/$f.htm -o tests/fixtures/riddles/$f.htm; done`；確認每個檔案非空且以 UTF-8 解碼後含中文。

- [ ] **Step 2: Write the failing tests** in `tests/zap-riddle-parse.test.js`：
  - `extractCommands accepts a command followed by an annotation`：`run e 5n 2o 2se t 7e se 2s e 等[啞僕(YaBa man)]` → `run e 5n 2o 2se t 7e se 2s e`；`pay上船到桃花島` → `pay`；`run ne n-->可設點` → `run ne n`。
  - `extractCommands keeps Chinese arguments of text verbs`：`run e 5n o 2s nw w t w 2n 4w 3u;ask yueh about 令狐沖` → 原字串；`run e 5n 2o se t 2e s e t 2s 4w s;buy 牛皮酒袋;s;give pants to master;give skin to master` → 原字串；`say 是` → `say 是`。
  - `extractCommands is conservative`：`殺了葉二娘取得小孩` → `''`；`發呆看洪七公表演黃狗撒尿，然後就有機會領悟` → `''`；`到[楊蓮亭]，ask ting about 自宮;nod ting;ask ting about 手術刀`（前面有中文說明）→ `''`；`ask thief about 鴛鴦五珍膾、give fish to thief` → `''`；`run s 2sw w到[九宮花海青龍界碑] <3>run 2se到[九宮花海白虎界碑]`（內嵌另一個指令）→ `''`；`PS.去之前要先找黃蓉ask master about 家書` → `''`；空字串 → `''`。
  - `parseRiddlePage reads numbered steps and joins hard-wrapped lines`：`qu4-1.htm` 的 `steps.length === 5`；第 1 步 `{ no: 1, text: 'run 2e u;apprentice founder', commands: 'run 2e u;apprentice founder' }`；第 5 步 `commands === ''`。`qu1-1.htm` 第 2 步（原始 HTML 在 `give` 後硬換行）的 `commands` 含 `give wrapper to master`；第 1 步 `commands` 為 `run e 5n o 2s nw w t w 2n 4w 3u;ask yueh about 令狐沖`；第 8 步（「等出現【謠言】…」）`commands === ''`。
  - `parseRiddlePage returns no steps for an unnumbered page but keeps the text`：`qu2-1.htm`（屠龍刀，沒有編號）→ `steps` 為 `[]`、`text` 含「屠龍刀」與「run e 5n 2o 2ne」。
  - `parseRiddlePage ignores the back link and BOM`：`text` 不含 `回上頁`、不含 `﻿`。
  - `parseRiddlePage handles a table page`：`qu6-1.htm`（拜師表）→ `text` 含「王重陽」，`steps` 為 `[]`。
  - `parseRiddlePage keeps same-numbered sections in order`：`qu6-3.htm`（石牢、入古墓、入明教三段各從 1 開始）→ `steps` 依頁面順序、`no` 序列含重複的 1。

- [ ] **Step 3: Run to verify fail** — Run: `node --test tests/zap-riddle-parse.test.js` — Expected: FAIL（`extractCommands is not a function`）。

- [ ] **Step 4: Implement** `VERBS`、`extractCommands`、`parseRiddlePage`（清理 HTML 的做法沿用檔內 `cellText`／解碼：去 `<style>`／`<script>`、`<br>`／`</p>`／`</tr>`／`</div>`／`</li>` 轉換行、去標籤、解碼 `&nbsp; &gt; &lt; &amp;`），並在 `module.exports` 加入。

- [ ] **Step 5: Run to verify pass** — Run: `npm test` — Expected: 全部 PASS。

- [ ] **Step 6: Commit** — 加入 `tools/zap-parse.js tests/zap-riddle-parse.test.js tests/fixtures/riddles/`，訊息「Parse riddle step pages with conservative command extraction」，結尾帶本專案 attribution（`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` 與 `Claude-Session: https://claude.ai/code/session_01Q2ejToY9yyQuqCHLYYDFAx`）。

---

### Task 2: 總表、選單、名稱對應與資料產生

**Files:**
- Modify: `tools/zap-parse.js`、`tools/gen-zap-data.js`
- Create: `tests/fixtures/riddles/qu1.htm`、`tests/fixtures/riddles/list.html`（真實快照）
- Generate: `catworld-auto-command/zap-data.json`
- Test: `tests/zap-riddle-parse.test.js`（新增）、`tests/zap-build.test.js`（新增）

**Interfaces:**
- Consumes: Task 1 的 `parseRiddlePage`。
- Produces：
  - `parseRiddleIndex(html): { category: string, name: string, condition: string, hint: string, difficulty: string, reward: string }[]`——取 `<table>` 內有 ≥ 5 個儲存格、第一格非空且不是「名稱」的列；只有一個非空儲存格且以「類」結尾的列是分類標題，之後的列屬於該分類
  - `parseRiddleMenu(html): { category: string, file: string, name: string }[]`——選單裡 `<span class="t1">分類</span>` 之後的 `href="qu….htm"` 連結；略過 `qu1.htm`（謎列表本身）
  - `RIDDLE_ALIASES`（總表名稱 → 選單名稱）：`鞭子製作→鞭子制作`、`唐伯虎的困擾→新手裝備`、`靈鷲宮的委託→冰翼無痕`、`白駝山莊的毒物→心瓣項鍊`、`瑛姑的困擾→天罡鬥服`、`燕子鄔→水漾之繞`
  - `buildRiddles({ indexHtml, menuHtml, pageHtml: Record<string,string> }): { riddles, pages, report: string[] }`——對應順序：名稱完全相同 → `RIDDLE_ALIASES` → 正規化（去空白、括號、「習得」「之謎」「的」「秘寶」「寶」）後相同或互相包含；`riddles[i] = { id: '<分類>/<名稱>', category, name, condition, hint, difficulty, reward, page: string|null, shared: string[] }`（`shared` 是同一頁上的其他謎名）；`pages[file] = { steps, text }`（每個被對應到的頁面一份）；`report` 列出「總表有、選單沒有」與「選單有、沒被用到」與「對應到的頁面沒有 HTML」
  - `buildData(input, limits)`：`input` 新增選用的 `riddleHtml: { indexHtml, menuHtml, pageHtml }`；有它時 `data.riddles`、`data.pages` 輸出，總表解析出少於 `limits.minRiddles`（預設 40）個謎時丟 `Error('來源解析異常…')`；`data.sources` 多 `https://zap.muds.me/qu1.htm`；沒有時不輸出這兩個欄位
  - CLI：`--from-dir` 另讀 `<dir>/qu1.htm`、`<dir>/list.html` 與選單中每個檔案（同資料夾）；預設連網抓 `https://zap.muds.me/qu1.htm`、`https://zap.muds.me/list.html` 與選單中的每個 `qu*.htm`（同時最多 6 個請求）；任何一個頁面抓不到就整個失敗、不寫檔

- [ ] **Step 1: Save fixtures** — `curl -sL https://zap.muds.me/qu1.htm -o tests/fixtures/riddles/qu1.htm`、`curl -sL https://zap.muds.me/list.html -o tests/fixtures/riddles/list.html`。

- [ ] **Step 2: Write the failing tests.** `tests/zap-riddle-parse.test.js` 新增：
  - `parseRiddleIndex reads every riddle with its category`：回 46 筆；`獨孤九劍` `{ category: '技能類', condition: '內力 300 [天賦]', difficulty: '極易', reward: '學會此技能' }`；`混元魔刀` 的 `condition === '150 萬 EXP [註]'`；`拜師` 的 `difficulty === '????'`；分類計數 技能類 9、治裝類 17、道具類 8、寵物類 2、其他類 10。
  - `parseRiddleMenu reads the menu without the list page`：回 46 筆（47 個選單項目扣掉 `qu1.htm`）；含 `{ category: '技能類', file: 'qu1-1.htm', name: '獨孤九劍' }`；沒有 `file === 'qu1.htm'`；`qu1-5.htm` 出現 3 次。
  - `buildRiddles joins the index to the menu pages with aliases`：只提供 `qu1-1.htm qu1-4.htm qu1-5.htm qu2-1.htm qu4-1.htm qu6-1.htm qu6-3.htm` 的 HTML：`獨孤九劍.page === 'qu1-1.htm'`；`習得凌波微步.page === 'qu1-4.htm'`；`燕子鄔`、`唐伯虎的困擾` 等別名項目的 `page` 是別名對應的檔名（例如 `qu3-3.htm`、`qu3-7.htm`），但因為沒有該頁 HTML，`report` 含「沒有 HTML」；`玉蕭劍法.shared` 等於 `['彈指神通', '糖果']`；`pages['qu4-1.htm'].steps.length === 5`；總表有、選單沒有的項目為 0 個。
  `tests/zap-build.test.js` 新增：`buildData includes riddles when riddleHtml is given`（用 fixtures，`limits: { minZap: 1, minNewstart: 1 }`，`data.riddles.length === 46`、`data.sources` 多一筆）；`buildData rejects an index that parses to too few riddles`（`indexHtml: '<html></html>'` 丟「來源解析異常」）。

- [ ] **Step 3: Run to verify fail** — Run: `node --test tests/zap-riddle-parse.test.js tests/zap-build.test.js` — Expected: 新測試 FAIL，舊測試 PASS。

- [ ] **Step 4: Implement** 上列函式與 `RIDDLE_ALIASES`，擴充 `buildData` 與 `gen-zap-data.js`（`--from-dir` 的說明註解一併更新）。

- [ ] **Step 5: Run to verify pass** — Run: `npm test` — Expected: 全部 PASS。

- [ ] **Step 6: Regenerate real data.** Run: `node tools/gen-zap-data.js`（需連網）。Expected: 結束碼 0、報告印出謎的筆數與「對應不到」清單（預期為空）；用 `node -e` 確認：`riddles.length === 46`；每個謎的 `page` 都不是 `null`；`pages` 有 40 個鍵；`pages['qu4-1.htm'].steps.length === 5`；`mobs` 仍 891、`items` 仍 94。

- [ ] **Step 7: Commit** — 「Parse riddle index, menu and pages into zap data」。

---

### Task 3: `zap-riddles.js`（條件、分組、補充指令）

**Files:**
- Create: `catworld-auto-command/zap-riddles.js`
- Test: `tests/zap-riddles.test.js`

**Interfaces:**
- Produces（`globalThis.CatworldZapRiddles`）：
  - `DIFFICULTY_ORDER = ['極易','易','一般','難','極難']`
  - `parseCondition(text: string): { exp: number | null, force: number | null, unreadable: boolean }`——`無` → 全空、`unreadable: false`；`(\d+(\.\d+)?)\s*萬\s*EXP`（不分大小寫）→ `exp = N × 10000`；`內力\s*(\d+)` → `force`；含 `[天賦]`、`技能`、`需為新手`、`未知`、`不一定`、`????`、`[註]`，或完全沒認出任何東西且不是 `無` → `unreadable: true`
  - `classify(condition: string, stats: { exp: number, force: number }): 'ok' | 'check' | 'unmet'`——規則見 Global Constraints
  - `groupRiddles(riddles: Riddle[], stats): { ok: Riddle[], check: Riddle[], unmet: Riddle[] }`——組內依難度再依原順序
  - `searchRiddles(riddles: Riddle[], query: string): Riddle[]`——名稱、事件提示、獎勵、分類包含關鍵字（不分大小寫、去空白）；空字串回全部
  - `splitCommands(text: string): string[]`——以 `;`／`；` 切、trim、去空段；`joinCommands(list: string[]): string`
  - `effectiveStep(page: { steps }, index: number, edits: Record<string, { n: number, cmds: Record<string, string> }>, file: string): { commands: string, source: 'edited' | 'site' | 'none', stale: boolean }`——`index` 為 1 起算；`edits[file]?.cmds[index]` 為非空字串 → `edited`；否則步驟的 `commands` 非空 → `site`；否則 `none`；`stale` 為 `edits[file]` 存在且 `edits[file].n !== page.steps.length`
  - `setEdit(edits, file, stepCount: number, index: number, text: string): edits`——回傳新物件（不改輸入）；`text` 清空（trim 後為空）就移除該步驟，該頁沒有任何補充時移除整頁；寫入時 `n` 設為 `stepCount`
  - `parseImport(text: string): { ok: true, riddleCommands, riddleDone } | { ok: false, error: string }`——JSON 解析、驗證形狀（`riddleCommands` 是物件、每頁 `{ n: 整數, cmds: 物件、值為字串 }`；`riddleDone` 是物件、值為 `true`），任何一項不合法就 `ok: false`
  - `handleMessage(data: { riddles, pages }, message): { ok: true, riddles, pages } | null`——只處理 `type: 'ZAP_RIDDLES'`
- `Riddle`：`{ id, category, name, condition, hint, difficulty, reward, page, shared }`。

- [ ] **Step 1: Write the failing tests** in `tests/zap-riddles.test.js`（`require` 後讀 `globalThis.CatworldZapRiddles`），測試名稱與斷言：
  - `parseCondition covers every form in the index`：`無` → `{ exp: null, force: null, unreadable: false }`；`2 萬 EXP` → `exp 20000`、`unreadable false`；`80 萬 EXP` → `800000`；`內力 2000` → `force 2000`、`unreadable false`；`內力 300 [天賦]` → `force 300`、`unreadable true`；`內力 ???? [天賦]` → `force null`、`unreadable true`；`龍掌相關技能70`、`製藥學技能 161` → `unreadable true`；`需為新手`、`未知`、`不一定` → `unreadable true`；`50 萬 EXP [註]` → `exp 500000`、`unreadable true`。
  - `classify uses exp and max force`（`stats = { exp: 414748, force: 2022 }`）：`無` → `ok`；`20 萬 EXP` → `ok`；`80 萬 EXP` → `unmet`；`內力 2000` → `ok`；`內力 2500` → `unmet`；`內力 300 [天賦]` → `check`；`150 萬 EXP [註]` → `unmet`（未達優先）；`需為新手` → `check`。
  - `classify treats unreadable stats as check, not unmet`：`stats = { exp: NaN, force: NaN }` 時 `80 萬 EXP`、`內力 2000` → `check`；`無` 仍是 `ok`。
  - `unmet beats check`：`80 萬 EXP`（`exp 100000`）且含 `[天賦]` 的假條件（如 `內力 300 [天賦]` 配 `force 100`）→ `unmet`。
  - `groupRiddles sorts by difficulty then original order`：三個謎難度為 `難`、`極易`、`極易`（原順序 A、B、C），同在 `ok` 組 → 順序 B、C、A；難度 `????` 排最後。
  - `searchRiddles matches name, hint, reward and category`：各一項命中；空字串回全部；比對不分大小寫、忽略空白。
  - `splitCommands drops empty pieces`：`'run e;;give a to b; '` → `['run e', 'give a to b']`；全形 `；` 也切；`joinCommands(splitCommands(x))` 去掉多餘空白。
  - `effectiveStep prefers the edit, then the site, then none`：三種 `source`；`index` 超出範圍回 `none`。
  - `effectiveStep flags stale edits when the step count changed`：`edits['p.htm'] = { n: 5, cmds: { 2: 'x' } }`、頁面有 6 步 → `stale: true`；頁面 5 步 → `stale: false`；沒有該頁的補充 → `stale: false`。
  - `setEdit adds, removes and does not mutate`：加入後 `edits[file].n === stepCount`；清空文字移除該步驟，最後一個步驟移除時整頁鍵消失；輸入物件不被改動。
  - `parseImport rejects malformed input`：非 JSON、缺欄位、`n` 不是整數、`cmds` 值不是字串、`riddleDone` 值不是 `true` → `{ ok: false, error }`；合法輸入 → `ok: true` 並回傳兩個物件。
  - `handleMessage answers ZAP_RIDDLES and ignores other types`。

- [ ] **Step 2: Run to verify fail** — Run: `node --test tests/zap-riddles.test.js` — Expected: FAIL（找不到 `zap-riddles.js`）。
- [ ] **Step 3: Implement `zap-riddles.js`**（`(() => { if (globalThis.CatworldZapRiddles) return; … })()` 風格，檔頭繁中註解說明分組規則與「讀不到就歸需自行確認」）。
- [ ] **Step 4: Run to verify pass** — Run: `npm test` — Expected: 全部 PASS。
- [ ] **Step 5: Commit** — 「Add riddle conditions, grouping and saved-commands module」。

---

### Task 4: background 分派 `ZAP_RIDDLES`

**Files:**
- Modify: `catworld-auto-command/background.js`、`tests/zap-background.test.js`

**Interfaces:**
- Consumes: `CatworldZapRiddles.handleMessage(data, message)`。
- Produces: `{ type: 'ZAP_RIDDLES' }` → `{ ok: true, riddles, pages }`。

- [ ] **Step 1: Write the failing test.** `tests/zap-background.test.js`：stub 的資料多 `riddles: [{ id: '技能類/獨孤九劍', name: '獨孤九劍', page: 'qu1-1.htm' }]`、`pages: { 'qu1-1.htm': { steps: [], text: 't' } }`；新增 `background answers ZAP_RIDDLES from the same loaded data`：`reply.ok === true`、`reply.riddles[0].name === '獨孤九劍'`、`reply.pages['qu1-1.htm'].text === 't'`、`fetchCalls` 不增加。Run: `node --test tests/zap-background.test.js` — Expected: FAIL（`未知的查詢`）。
- [ ] **Step 2: Implement.** `importScripts` 加入 `'zap-riddles.js'`；訊息分派在 `ZapItems` 之後加 `?? CatworldZapRiddles.handleMessage(data, message)`（`data.riddles`、`data.pages` 缺漏時 `handleMessage` 要容忍，回空陣列／空物件）。
- [ ] **Step 3: Run to verify pass** — Run: `npm test` — Expected: 全部 PASS。
- [ ] **Step 4: Commit** — 「Serve ZAP_RIDDLES queries from the background worker」。

---

### Task 5: 面板「解謎」UI 與送出

**Files:**
- Create: `catworld-auto-command/zap-riddle-ui.js`
- Modify: `catworld-auto-command/content.js`、`catworld-auto-command/manifest.json`、`catworld-auto-command/popup.js`（備援注入 `files`）
- Test: DOM 無單元測試；用 repo 外的 jsdom 冒煙（沿用先前做法）與真實頁面手動驗證

**Interfaces:**
- Consumes: `CatworldZapRiddles`、`ZAP_RIDDLES`、`chrome.storage.local`（`riddleCommands`、`riddleDone`）、`startMacro(text)`（`content.js`）。
- Produces: `CatworldZapRiddleUI.attach(root: ShadowRoot, deps: { readStats: () => { exp: number, force: number }, startSteps: (text: string) => void })`。

- [ ] **Step 1: 接線。** manifest content script `js`：`…`、`zap-mobs.js`、`zap-items.js`、`zap-riddles.js`、`zap-panel.js`、`zap-riddle-ui.js`、`content.js`；popup 備援注入 `files` 同步加入 `'zap-riddles.js'`、`'zap-riddle-ui.js'`（順序同上）。`content.js` 在既有 `CatworldZapPanel.attach` 的 `try` 之後另開一個 `try/catch`：`CatworldZapRiddleUI.attach(root, { readStats: () => ({ exp: <#exp 數值>, force: <#max_force 數值> }), startSteps: text => startMacro(text) })`（數值讀法同既有 `readExp`：`textContent` 去逗號與空白後 `Number`，讀不到為 `NaN`）。失敗時 `console.error('[catworld] 解謎列初始化失敗', error)`，不能牽連後面的按鈕綁定。
- [ ] **Step 2: 清單。** 面板 `.body` 末端加一列：標籤「解謎」、狀態文字、按鈕「解謎清單」；展開後的 box 內有搜尋框（輸入後 300 ms 去抖；沿用怪物清單對 `mousedown` 與 `keydown/keyup/keypress` 冒泡的處理）、勾選「顯示已解過」（預設不勾＝隱藏已解過的）、「匯出」「匯入」兩個按鈕。打開時送 `ZAP_RIDDLES`（只取一次並快取在 UI 內），以 `groupRiddles(…)` 顯示三組：「條件夠（n）」「條件需自行確認（n）」「條件未達（n）」，組內每個謎一行：已解過勾選框、名稱（可點）、難度、條件、事件提示、獎勵。讀不到經驗或內力時（`NaN`）狀態文字顯示「讀不到經驗／內力，條件都需自行確認」。載入失敗顯示 `reply.error`。全部用 `textContent`。顏色用難度文字即可，不另做配色。
- [ ] **Step 3: 步驟檢視。** 點名稱進入檢視（有「返回清單」鈕）：標題＝名稱＋條件＋獎勵；`riddle.shared` 非空時顯示「這一頁同時包含：…」；`pages[riddle.page].steps` 逐步列出：序號（頁面印的 `no`）、原文、目前生效的指令（等寬字體；標「已補」或「網站」；`stale` 時標「步驟已變動，請確認」）、按鈕「編輯指令」「送出」。`steps` 為空（沒有編號步驟的頁）時改顯示 `pages[riddle.page].text`（`white-space: pre-wrap`、可捲動）。`riddle.page` 為 `null` 時顯示「沒有步驟頁」。
- [ ] **Step 4: 編輯與送出。** 「編輯指令」展開 textarea（預填目前生效的指令；沿用搜尋框的冒泡處理）與「儲存」「還原」：儲存呼叫 `setEdit(edits, file, steps.length, index, text)` 後寫入 `chrome.storage.local.riddleCommands`；清空等同還原。「送出」呼叫 `deps.startSteps(joinCommands(splitCommands(目前生效的指令)))`；沒有指令時按鈕 `disabled`。送出不標記完成。
- [ ] **Step 5: 已解過與匯出／匯入。** 勾選框寫入 `riddleDone`；匯出把 `{ riddleCommands, riddleDone }` 的 JSON 寫入剪貼簿（`navigator.clipboard.writeText`，失敗時顯示在 textarea 讓使用者自己複製）；匯入在 textarea 貼上 JSON 後按「匯入」，經 `parseImport` 驗證，**合法才覆蓋**並重畫，不合法顯示 `error` 且不改任何既有資料。所有儲存讀寫包 `try/catch`，失敗時顯示簡短錯誤。
- [ ] **Step 6: 冒煙驗證（repo 外）。** 用 jsdom（沿用第 1、2 階段的做法）載入 `zap-riddles.js`、`zap-riddle-ui.js` 與真實 `zap-data.json`，stub `chrome.runtime.sendMessage`（以 `CatworldZapRiddles.handleMessage` 回答）、`chrome.storage.local`（記憶體實作）與 `startSteps`（記錄收到的字串）：(a) 以 `exp 414748、force 2022` 打開清單，三組都有內容、「條件夠」含 `鞭子製作`（條件 `無`）、`內力 2000` 的 `朱果冰蟾` 在「條件夠」、`80 萬 EXP` 的 `習得凌波微步` 在「條件未達」、`內力 300 [天賦]` 的 `獨孤九劍` 在「條件需自行確認」；(b) `exp`、`force` 為 `NaN` 時所有條件非 `無` 的謎都在「需自行確認」；(c) 進入 `王鐵匠的藥` 看到 5 個步驟、第 1 步「送出」後 `startSteps` 收到 `run 2e u;apprentice founder`；(d) 編輯第 5 步填 `look` 後儲存，重新打開顯示「已補」，「送出」送出 `look`；清空後還原；(e) 把該頁步驟數改成不同值再載入，顯示「步驟已變動，請確認」；(f) 進入沒有編號步驟的 `屠龍刀` 顯示整頁文字；(g) 匯入壞 JSON 後既有補充指令與已解過標記不變；(h) 勾「已解過」後清單預設隱藏、勾「顯示已解過」後出現。
- [ ] **Step 7: 驗證落地。** `git diff --stat`、對三個被改的檔案 `node --check`；`Grep` 確認 `startMacro(text)` 是唯一的送出路徑（`zap-riddle-ui.js` 內沒有 `sendMessage` 以外的送指令呼叫、沒有直接操作 `#input`）。請使用者重新載入 extension 後在真實遊戲確認：清單分組、在 `王鐵匠的藥` 按一步「送出」遊戲真的收到指令、遊戲出現驗證碼時該巨集會被取消（面板「巨集」列消失）。
- [ ] **Step 8: Commit** — 「Add riddle list, steps, saved commands and per-step send」。

---

### Task 6: 版本、紀錄與說明

**Files:**
- Modify: `catworld-auto-command/manifest.json`（`version` → `1.22.0`）、`CHANGELOG.md`、`README.md`、`CLAUDE.md`

- [ ] **Step 1:** 版本改 `1.22.0`；`CHANGELOG.md` 最上面加 `## 1.22.0（2026-10-19）`：面板「解謎」列、依經驗與內力分「條件夠／需自行確認／條件未達」、步驟檢視、每步「送出」（走巨集佇列，驗證碼時會取消）、自己補指令（存本機、可匯出匯入）、已解過標記、資料來源（zap 攻略站 46 個謎）與「約四成步驟只有文字、需自己補」。
- [ ] **Step 2:** `README.md` 新增「解謎」小節：怎麼開、三組的意思（讀不到的條件要自己判斷）、步驟檢視、送出（一次一步、可寫 `@等待 3`）、補指令與還原、已解過、匯出匯入、資料更新方式（同怪物查詢）、內力用內力上限比對。
- [ ] **Step 3:** `CLAUDE.md` 新增「解謎」現況：資料是 `zap-data.json` 的 `riddles`／`pages`、解析在 `tools/zap-parse.js`（名稱別名表、共用頁面）；指令抽取是保守的（任一段不認得整步為空）；`zap-riddles.js` 不碰 DOM、要同步加進 manifest 與 popup 備援注入；「送出」只能走 `startMacro`（不要另造送出通道，才會算 `active()`、驗證碼時被取消）；補充指令以頁面檔名＋步驟位置為鍵並記錄當時步驟數；UI 在 shadow DOM 內、輸入框要擋冒泡。
- [ ] **Step 4: 驗證。** Run: `npm test` — Expected: 全部 PASS；`Grep '"version": "1.22.0"'` 有命中；`git diff --stat` 與上列一致。
- [ ] **Step 5: Commit** — 「Release v1.22.0: riddle lookup」。提醒使用者到 `chrome://extensions` 重新載入並重新整理遊戲頁，實際用一個謎測試。
