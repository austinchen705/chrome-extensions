# 無名裝備鑑定比較（zap 第 3 階段）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 鑑定出裝備（「此物名曰」區塊）後，在面板浮層標出每件相對於「現在穿的同類別裝備」是比較好、比較差、相當，或沒有基準可比；基準由「讀取目前穿著」按鈕一次取得，之後被動更新。

**Architecture:** DOM 無關的 `zap-equipment.js`（區塊解析、屬性正規化與計分、比較、基準存放、穿著清單解析、鑑定過程追蹤器）；`zap-equipment-ui.js` 在面板加「裝備」列、監看新增文字、送出 `i` 與 `view #編號`（走 `startMacro`）、把結果畫進共用浮層的新區段；`zap-panel.js` 把浮層的區段與計時暴露給它。

**Tech Stack:** 同前（MV3、IIFE + `globalThis.X`、`node --test`）。

**Spec:** `docs/superpowers/specs/2026-10-19-zap-equipment-design.md`（與第 1、2、4 階段同一分支 `zap-mob-lookup`）

## Global Constraints

- 區塊格式：標題 `此物名曰 ：名稱，○○類武器／防具`；欄位標籤中間可有空白（`防 禦 力`、`傷 害 力`、`屬    性`）；`品階`、`潛能`、`屬性` 可有可無；`屬性` 可多行、值可為負；`佩帶條件 ：[使用者 xxx，]經驗 N`；其他行（文字圖案、`特殊物品非無名裝備…`）一律略過。
- 比較規則：同類別（標題的類別字串相同）才比；基準清單中取**最弱的一件**當對象；主要數值（武器取傷害力、防具取防禦力，`/` 前的數字）相差 ≥ 3 → 高者較好；相差 ≤ 2 → 比屬性分數（相關屬性每點 2 分、其他正向屬性每點 1 分、負值照扣；`重量`、`硬度`、`潛能`、`損修` 不計分），高者較好，相同則「相當」；沒有同類別基準或主要數值讀不到 → 「沒有基準可比」。需求經驗 > 目前經驗 → 加註「你還不能穿」。門檻 3 放在一個常數 `PRIMARY_GAP`。
- 相關屬性：`攻擊` ＋ 主要武器類型的別名（劍→`劍術`、`劍法`；刀→`刀術`、`刀法`；杖→`棒法`、`杖法`；鞭→`鞭法`；拳套→`拳腳`；暗器→`暗器`、`暗器使用`）；未設定主要武器類型時只有 `攻擊`。屬性名先正規化（`補助`→`輔助`、`回復`→`恢復`）。
- 鑑定每次**不送任何指令**；只有按「讀取目前穿著」才送：`i`，再把穿著行的 `view #編號` 組成一個巨集（`startMacro`，與解謎相同的佇列、間隔、驗證碼取消）。
- 鑑定過程邊界：`你想請…鑑定所有無名物` 開始、`共鑑定…樣無名物` 結束（30 秒沒有新區塊也結束）；期間的區塊是候選；之外的區塊只用來更新基準（名稱必須是穿著名單內、且該名稱在穿著名單裡只有一件）。進行中時「讀取目前穿著」停用。
- 基準存 `chrome.storage.local.wornEquipment`：`{ [類別]: [ { name, primary, attrs: [{name,value}], needExp, readAt } ] }`；顯示時註明「基準讀取於 N 分鐘前」。
- 區塊可能跨封包：追蹤器要緩衝，最後一個標題的區塊要等「下一個標題／結束句／flush」才算完整；UI 在最後一次新增文字後 600 ms 呼叫 `flush()`。
- 失敗不能靜默（延續 1.22.2）：`i` 逾時沒讀到、送指令被拒、解析不出任何區塊都要顯示原因。
- 依專案 `CLAUDE.md`：新模組同步加進 manifest 與 popup 備援注入（`zap-riddles.js` 之後、`zap-panel.js` 之前放 `zap-equipment.js`；`zap-equipment-ui.js` 放在 `zap-riddle-ui.js` 之後、`content.js` 之前）；版本升 minor → `1.23.0`；`CHANGELOG.md`、README、`CLAUDE.md` 只寫現況；測試用 `npm test`；既有測試必須維持通過。

## Review Focus

- 文字圖案、`特殊物品非無名裝備…`、`共鑑定…`、`馬鑑定師說道：…` 夾在區塊之間時不能把區塊切壞或當成屬性（Task 1）。
- 沒有品階／沒有屬性／沒有潛能的區塊（時光的河流、銅棒）仍解析出類別與主要數值（Task 1）。
- 不同類別（銅棒 vs 紫皇劍、披風 vs 盔甲）不比較，顯示「沒有基準可比」而不是亂比（Task 2）。
- 兩枚戒指：候選與較弱那枚比；比較弱的還差就不可能顯示「比現在好」（Task 2）。
- 屬性分數：負的 `重量` 不扣分、`攻擊` 對任何主要武器類型都算相關、未設定主要武器類型不丟例外（Task 2）。
- 區塊被切成兩個封包：標題在前一批、屬性在後一批仍解析成同一件（Task 3）。
- 鑑定進行中的區塊不得更新基準；鑑定之外的區塊只在名稱是穿著名單內唯一一件時才更新基準（Task 3）。
- `i` 輸出裡 `ˇ` 標記與 `view #編號` 要依「同一行」配對；名稱被 `<span>` 拆開（「金線」＋「手套」）要接回（Task 3）。
- 沒讀到 `i`（逾時）不送任何 `view`；按鈕在鑑定進行中停用（Task 4）。

---

## 檔案結構

| 檔案 | 責任 |
|---|---|
| `catworld-auto-command/zap-equipment.js`（新） | 不碰 DOM：解析、正規化、計分、比較、基準存放、穿著清單解析、追蹤器 |
| `catworld-auto-command/zap-equipment-ui.js`（新） | 面板「裝備」列、觀察器、讀取目前穿著的流程、浮層區段 |
| `catworld-auto-command/zap-panel.js`（改） | 浮層新增 `equipment` 區段、回傳 `{ sections, touchHint, el }` |
| `catworld-auto-command/content.js`、`manifest.json`、`popup.js`（改） | 掛上 UI；載入新模組 |
| `tests/zap-equipment.test.js`、`tests/fixtures/equipment/*`（新） | 測試與 fixture（已備齊） |

---

### Task 1: 區塊解析與屬性正規化

**Files:** Create `catworld-auto-command/zap-equipment.js`；Test `tests/zap-equipment.test.js`（`require` 後讀 `globalThis.CatworldZapEquipment`；fixtures 在 `tests/fixtures/equipment/`）

**Interfaces — Produces（`globalThis.CatworldZapEquipment`）：**
- `normalizeAttrName(name: string): string`——trim、`補助`→`輔助`、`回復`→`恢復`
- `parseEquipmentBlocks(text: string): Block[]`——`Block = { name, category, kind: 'weapon'|'armor', primary: number|null, attrs: { name: string, value: number }[], needExp: number|null, raw: string }`；`kind` 由類別結尾（`武器`／`防具`）決定；`primary` 是 `傷害力` 或 `防禦力` 的第一個數字；`attrs` 的 `name` 已正規化；`硬度`、`品階`、`潛能` 不放進 `attrs`

- [ ] **Step 1: Write the failing tests.**
  - `parseEquipmentBlocks reads the real identify sample`：解析 `identify-sample.txt` → 10 件，名稱依序 `霧起時、鋼盔甲、時光的河流、銅棒、鉗鐵護手、星河、護身符、粗麻拳套、殘缺的白鐵刀、骷髏戒指`。
  - `霧起時`：`{ category: '披風類防具', kind: 'armor', primary: 21, needExp: 100000 }`，`attrs` 為 `[{ name: '精傷害減少', value: 1 }]`（潛能與硬度不在其中）。
  - `鋼盔甲`：`primary 37`、`attrs` 為 `行動 +2、攻擊 +5、重量 -8`（含負值）。
  - `時光的河流`（沒有品階、沒有屬性）：`primary 23`、`attrs` 為 `[]`、`needExp 150000`。
  - `銅棒`：`category '杖類武器'`、`kind 'weapon'`、`primary 48`、`needExp 0`。
  - `殘缺的白鐵刀`：`attrs` 為 `輔助精恢復 +5、招架 +2`（`輔助精恢復` 保持；來源若寫 `補助精回復` 也會正規化成它）。
  - `parseEquipmentBlocks ignores noise between blocks`：文字圖案（`╔▆▆…`、`╭☆`）、`特殊物品非無名裝備, 無法幫你鑑定。`、`馬鑑定師說道：共鑑定十樣無名物…`、`> 你想請李修理師…` 都不產生區塊、也不被算進前一個區塊的屬性（`護身符` 的 `attrs` 為 `[]`）。
  - `parseEquipmentBlocks reads the view samples`：`view-samples.txt` → `暮歌`：`category '披風類防具'`、`primary 31`、`attrs` 為 `棒法 +4、拳腳 +9`、`needExp 400000`（「使用者 tester，」前綴被略過）；`view-sample-armor.txt` → `黑羽長風鎧`：`primary 48`、`攻擊 +22`、`needExp 150000`。
  - `normalizeAttrName`：`補助精回復` → `輔助精恢復`；`輔助氣恢復` 不變；` 劍術 ` → `劍術`。
  - `parseEquipmentBlocks returns nothing for plain text`：`'你拿著無名物品給衰老頭看了一下...'`、`''` → `[]`。
- [ ] **Step 2: Run to verify fail** — `node --test tests/zap-equipment.test.js` — Expected: FAIL（找不到模組）。
- [ ] **Step 3: Implement.** 逐行掃描；標題 `/此物名曰\s*[：:]\s*(.+?)\s*[，,]\s*(\S+類(?:武器|防具))/` 開新區塊；欄位用容忍空白的正規式：`/傷\s*害\s*力\s*[：:]\s*(\d+)\s*\/\s*\d+/`、`/防\s*禦\s*力…/`、`/屬\s*性\s*[：:]\s*([+-]?\d+)\s+(\S+)/`、`/佩帶條件\s*[：:](?:\s*使用者\s*\S+?[，,])?\s*經驗\s*(\d+)/`；不符合任何欄位的行略過；`raw` 是該區塊的原文行。檔頭繁中註解寫清楚格式與「不認得就略過」。
- [ ] **Step 4: Run to verify pass** — `npm test` — Expected: 全部 PASS。
- [ ] **Step 5: Commit** — 「Add equipment block parser」（結尾帶 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` 與 `Claude-Session: https://claude.ai/code/session_01Q2ejToY9yyQuqCHLYYDFAx`）。

---

### Task 2: 計分與比較

**Files:** Modify `catworld-auto-command/zap-equipment.js`；Test `tests/zap-equipment.test.js`（新增）

**Interfaces — Produces：**
- `PRIMARY_GAP = 3`、`IGNORED_ATTRS = ['重量','硬度','潛能','損修']`
- `relatedAttrNames(mainWeapon: string): string[]`——見 Global Constraints；不認得的值只回 `['攻擊']`
- `scoreAttrs(attrs: {name,value}[], related: string[]): number`
- `compareEquipment(candidate: Block, baseline: BaselineItem[], opts: { mainWeapon?: string, exp?: number }): { verdict: 'better'|'worse'|'equal'|'none', text: string, reasons: string[], against: string|null, blocked: boolean }`——`baseline` 是同類別的基準清單（呼叫端先以類別取出）；`BaselineItem = { name, primary, attrs, needExp, readAt }`；`text` 是「比現在好，建議留下」「比現在差」「相當」「沒有基準可比」；`blocked` 為需求經驗 > `opts.exp`（`exp` 為 `NaN`／缺漏時不 blocked）；`reasons` 例如 `防禦 +6`、`多了 攻擊 +5`

- [ ] **Step 1: Write the failing tests**（`mainWeapon: '劍'`、`exp: 414748`）：
  - `relatedAttrNames`：`劍` → 含 `攻擊`、`劍術`、`劍法`；`拳套` → 含 `拳腳`；`''`、`undefined`、`'法師'` → `['攻擊']`。
  - `scoreAttrs`：`[{攻擊 +5}, {行動 +2}, {重量 -8}]` 配 `['攻擊']` → `12`（攻擊 2×5＋行動 2×1，重量不計）；負的其他屬性（`{抵抗 -3}`）→ `-3`。
  - `compareEquipment worse by a large primary gap`：候選 `霧起時`（防 21）對基準 `[暮歌 防 31，棒法+4 拳腳+9]` → `verdict 'worse'`、`against '暮歌'`、`reasons` 含 `防禦 -10`。
  - `compareEquipment worse armor`：`鋼盔甲`（防 37，攻擊 +5…）對基準 `[黑羽長風鎧 防 48，攻擊 +22]` → `worse`。
  - `compareEquipment better by a large primary gap`：候選防 40 對基準防 31 → `better`，`text === '比現在好，建議留下'`。
  - `compareEquipment decides by attributes when the primary is close`：候選防 31、`攻擊 +5` 對基準防 30、無屬性 → `better`、`reasons` 含 `多了 攻擊 +5`；候選防 30、無屬性對基準防 31、`攻擊 +5` → `worse`；兩邊同值同屬性 → `equal`、`text '相當'`。
  - `compareEquipment returns none without a same-category baseline`：基準為 `[]` → `none`、`text '沒有基準可比'`、`against null`；候選或基準的 `primary` 為 `null` → `none`。
  - `compareEquipment compares against the weakest of several`：基準 `[戒指 A 防 5、戒指 B 防 20]`，候選防 12 → `better`、`against 'A'`；候選防 3 → `worse`；候選防 4 對 A 防 5（差 1）屬性相同 → `equal`。
  - `compareEquipment flags an item the user cannot wear yet`：候選 `needExp 500000`、`exp 414748` → `blocked true`，其他結果照常；`exp: NaN` → `blocked false`。
  - `compareEquipment never crashes on an unset main weapon`：`mainWeapon: undefined` 仍回正常結果。
- [ ] **Step 2: Run to verify fail**（Expected: FAIL，函式未定義）。
- [ ] **Step 3: Implement.** 最弱的一件：以 `(primary, 屬性分數)` 由小到大排序取第一件。屬性分數用同一份 `related`。`reasons` 只列有差異的：主要數值差（`防禦`／`傷害` ± N）、候選有而基準沒有（或較大）的屬性 `多了 名稱 +N`、基準有而候選沒有（或較小）的 `少了 名稱 +N`。
- [ ] **Step 4: Run to verify pass** — `npm test` — Expected: 全部 PASS。
- [ ] **Step 5: Commit** — 「Add equipment scoring and comparison」。

---

### Task 3: 基準存放、穿著清單解析、鑑定追蹤器

**Files:** Modify `catworld-auto-command/zap-equipment.js`；Test `tests/zap-equipment.test.js`（新增）

**Interfaces — Produces：**
- `toBaselineItem(block: Block, now: number): BaselineItem`
- `replaceBaseline(blocks: Block[], now: number): Store`——整份重建（按鈕讀取後用）；`Store = { [category]: BaselineItem[] }`
- `upsertBaseline(store: Store, block: Block, now: number): Store`——同類別同名稱就覆蓋、否則加入；不改輸入
- `parseWornHtml(html: string): { name: string, id: string, weapon: boolean }[]`——只回「有 `ˇ` 標記」的行；`id` 取該行 `target="view #…"` 的編號；`weapon` 為該行有 `unwield`；名稱是該行去標籤後、去掉開頭的 ` *ˇ`、取到 `(英文 id)` 之前，`<span>` 拆開的接回（「金線」＋「手套」→ `金線手套`）
- `createTracker(opts?: { runTimeoutMs?: number }): Tracker`：
  - `tracker.feed(text: string, now: number): void`——追加緩衝文字；偵測鑑定開始／結束句並維護 `running`
  - `tracker.flush(now: number): { candidates: Block[], passive: Block[] }`——取出已完整的區塊（最後一個標題的區塊在 `flush()` 或結束句或下一個標題時才算完整）；鑑定進行中產生的是 `candidates`，其餘是 `passive`
  - `tracker.running(now: number): boolean`——進行中；最後一個區塊之後超過 `runTimeoutMs`（預設 30000）自動算結束
  - `tracker.setWorn(list: { name, id, weapon }[]): void`、`tracker.wornNames(): string[]`
  - `tracker.isPassiveUpdatable(name: string): boolean`——名稱在穿著名單且該名稱只有一件

- [ ] **Step 1: Write the failing tests.**
  - `parseWornHtml reads the real inventory`：`inventory.html` → 11 件；含 `{ name: '吳鉤劍', weapon: true }`、`{ name: '金線手套', weapon: false }`、`{ name: '青絲頭巾' }`；每件有數字 `id`；沒有未穿著的物品（`蜆精`、`在線獎勵禮盒`）。
  - `parseWornHtml needs the mark on the same line`：只有一行有 `ˇ`、旁邊另一行有 `view #` 連結但沒有 `ˇ` → 只回有 `ˇ` 的那一行。
  - `baseline helpers`：`replaceBaseline` 把 3 個區塊依類別分組；`upsertBaseline` 對同類別同名稱覆蓋、不同名稱加入、輸入物件不被改動；`toBaselineItem` 的 `readAt` 等於 `now`。
  - `tracker splits a run into candidates and passive blocks`：依序 `feed('> 你想請馬鑑定師鑑定所有無名物。\n' + identify-sample 的區塊…, t)` 與結束句 → `flush` 回 10 個 `candidates`、`passive` 為 `[]`；之後 `feed(view-samples 的暮歌區塊)` → `flush` 回 `candidates []`、`passive` 1 件。
  - `tracker handles a block split across two feeds`：第一批只有標題與主要數值行、第二批才有 `屬性` 與 `佩帶條件` → 兩次 `feed` 之後 `flush` 得到的是**一個**區塊且屬性完整。
  - `tracker run state`：開始句後 `running(now)` 為 `true`；結束句後為 `false`；沒有結束句但最後一個區塊之後 31 秒 → `false`。
  - `tracker passive update rule`：`setWorn([{name:'暮歌',…},{name:'暮歌',…},{name:'勁衣',…}])` → `isPassiveUpdatable('勁衣')` 為 `true`、`isPassiveUpdatable('暮歌')` 為 `false`（同名兩件）、`isPassiveUpdatable('銅棒')` 為 `false`。
- [ ] **Step 2: Run to verify fail**。
- [ ] **Step 3: Implement.** 追蹤器內部保留 `buffer`；`flush` 用 `parseEquipmentBlocks` 的標題位置切分：除最後一個標題之外的區塊視為完整；最後一個標題的區塊在遇到結束句、或呼叫 `flush`（傳入 `final` 語意由 `flush` 本身代表「靜止了」）時才一併輸出，輸出後從緩衝移除。`parseWornHtml` 以換行切行、用 `ˇ` 與正規式 `target="view #(\d+)"` 取值。
- [ ] **Step 4: Run to verify pass** — `npm test` — Expected: 全部 PASS。
- [ ] **Step 5: Commit** — 「Add equipment baseline store, worn parser and identify tracker」。

---

### Task 4: 面板「裝備」列、浮層區段與讀取流程

**Files:** Create `catworld-auto-command/zap-equipment-ui.js`；Modify `catworld-auto-command/zap-panel.js`、`content.js`、`manifest.json`、`popup.js`；Test：repo 外的 jsdom 冒煙（沿用前幾個階段的做法）

**Interfaces：**
- `CatworldZapPanel.attach(root, deps)` 回傳 `{ sections, touchHint, el }`（`sections` 新增 `equipment`；隱藏計時結束時也清空 `equipment` 區段）
- `CatworldZapEquipmentUI.attach(root, { overlay, readExp, startSteps })`，`overlay = { section, touchHint, el }`；`startSteps(text)` 同解謎（回 `false` 代表沒執行）
- `content.js`：`const zapPanel = CatworldZapPanel.attach(…)`（保留既有 `try/catch`），再另開 `try/catch` 呼叫 `CatworldZapEquipmentUI.attach(root, { overlay: { section: zapPanel.sections.equipment, touchHint: zapPanel.touchHint, el: zapPanel.el }, readExp, startSteps: text => startMacro(text) })`

- [ ] **Step 1: 浮層區段。** `zap-panel.js` 的 `sections` 加 `equipment`（與 `mobs`、`items` 並列放在浮層容器內）；`attach` 結尾 `return { sections, touchHint, el }`；`hideTimer` 到期時一併 `sections.equipment.replaceChildren()`。Run `npm test`，Expected: 全部 PASS；重跑前幾階段的 jsdom 冒煙（`smoke3`、`smoke4`、`smoke8`）確認浮層行為不變。
- [ ] **Step 2: 「裝備」列與讀取流程。** `zap-equipment-ui.js`：面板 `.body` 末端加一列「裝備」：狀態文字（「尚未讀取」或「已讀取 N 件，M 分鐘前」）與按鈕「讀取目前穿著」。按下：(a) 若 `tracker.running(Date.now())`，顯示「鑑定進行中，請稍後」並不送；(b) 否則 `startSteps('i')`，設狀態 `waitingInventory`（10 秒逾時，逾時顯示「沒有讀到背包，沒有送出任何 view」）；(c) 觀察器看到穿著清單（`parseWornHtml` 回非空）時，把清單交給 `tracker.setWorn`，並 `startSteps(清單.map(w => 'view #' + w.id).join(';'))`，狀態改 `reading`，進度「讀取中 n/N」；(d) 每個回來的 `passive` 區塊若名稱在穿著名單內，依順序收進讀取結果；全部收齊或 20 秒逾時時，`replaceBaseline(收到的區塊, Date.now())` 存入 `chrome.storage.local.wornEquipment` 並更新狀態（有缺的顯示「讀到 n/N 件」）。按鈕在 `reading`、`waitingInventory`、鑑定進行中停用。
- [ ] **Step 3: 觀察器與顯示。** 自己的 `MutationObserver`（觀察 `document.body`，只取 `closest('#content')` 內且不在遊戲浮動視窗內的新增節點，過濾規則同 `zap-panel.js`）：文字 = 新增節點 `textContent` 直接相接；HTML = 新增節點 `outerHTML ?? textContent` 直接相接。每批：`tracker.feed(text, now)`、掃描 HTML 的穿著清單、`600 ms` 去抖後 `tracker.flush`。`candidates` → 對每件取 `wornEquipment[類別] ?? []` 呼叫 `compareEquipment`（`mainWeapon` 讀 `chrome.storage.local.mainWeapon` 並監聽變更，不合法值當 `''`；`exp` 用 `readExp()`），畫進 `overlay.section`（標題「鑑定裝備」；每件一行：名稱（類別）、主要數值、屬性摘要、需求經驗、`text`＋`reasons`、`against`、`blocked` 時「你還不能穿」、基準讀取時間；顏色：better `#3ecf6e`、worse `#999`、equal `#e6c029`、none `#7a7a7a`；累積最多 12 件，新的接在後面）。`passive` 區塊且 `isPassiveUpdatable(name)` 時 `upsertBaseline` 並存入 storage。沒有解析出任何區塊但偵測到鑑定結束句時顯示「鑑定結束，但沒有解析到裝備（格式可能不同）」。所有儲存讀寫包 `try/catch`，失敗顯示簡短錯誤。
- [ ] **Step 4: 接線。** manifest `js` 順序：`…`、`zap-mobs.js`、`zap-items.js`、`zap-riddles.js`、`zap-equipment.js`、`zap-panel.js`、`zap-riddle-ui.js`、`zap-equipment-ui.js`、`content.js`；popup 備援注入 `files` 同步；`content.js` 依 Interfaces 修改（兩段都要有各自的 `try/catch`，失敗只 `console.error`，不能牽連後面的按鈕綁定）。
- [ ] **Step 5: 冒煙驗證（repo 外）。** jsdom 載入 `zap-mobs.js`、`zap-items.js`、`zap-equipment.js`、`zap-panel.js`、`zap-equipment-ui.js`，stub `chrome.storage`（記憶體）、`startSteps`（記錄收到的字串）；`#content` 內以 `createContextualFragment` 附加真實片段：(a) 先附加 `inventory.html`（按過「讀取目前穿著」之後）→ `startSteps` 依序收到 `i`、再收到 11 個 `view #…` 以 `;` 連接的字串；(b) 依序附加 `view-samples.txt`、`view-sample-armor.txt` 的區塊（名稱對得上穿著清單才算）→ 基準有 `披風類防具`、`盔甲類防具`；(c) 附加 `identify-sample.txt` 全文（分成 2～3 批）→ 浮層出現 10 件；`霧起時`（披風）比 `暮歌` 差、`鋼盔甲`比 `黑羽長風鎧` 差、`銅棒` 沒有基準、`時光的河流` 與 `暮歌` 比（防 23 vs 31）→ 差；(d) 鑑定進行中按鈕停用；(e) 逾時沒收到 `i` → 顯示「沒有讀到背包」且 `startSteps` 只被呼叫過 `i` 一次；(f) 各種失敗訊息可見。
- [ ] **Step 6: 驗證落地。** `git diff --stat`、`node --check` 被改的檔案；`Grep` 確認 `zap-equipment-ui.js` 內沒有直接操作 `#input` 或 `sendMessage` 以外的送指令呼叫（只有 `deps.startSteps`）。請使用者重新載入 extension 並重新整理遊戲頁後，在真實遊戲：先按「讀取目前穿著」，再去鑑定一批裝備確認標示。
- [ ] **Step 7: Commit** — 「Add equipment row, worn-gear reading and identify comparison overlay」。

---

### Task 5: 版本、紀錄與說明

**Files:** Modify `catworld-auto-command/manifest.json`（`version` → `1.23.0`）、`CHANGELOG.md`、`README.md`、`CLAUDE.md`

- [ ] **Step 1:** 版本改 `1.23.0`；`CHANGELOG.md` 最上面加 `## 1.23.0（2026-10-19）`：面板「裝備」列與「讀取目前穿著」、鑑定裝備後標出比現在好／差／相當／沒有基準可比與理由、規則（先比攻防、差 3 以上以高者為準、差不多再比屬性分數、相關屬性加分、同類別有多件和最弱的比、你還不能穿的標出來）、基準被動更新與讀取時間、鑑定時不送指令（只有按讀取才送約 12 個指令）。
- [ ] **Step 2:** `README.md` 新增「裝備比較」小節（含：先按「讀取目前穿著」、換裝後再按、規則白話、結果文字意思、限制：其他類別格式沒樣本、規則與分數是猜測、換裝要重讀）。
- [ ] **Step 3:** `CLAUDE.md` 新增「裝備比較」現況：`zap-equipment.js` 不碰 DOM、解析容忍欄位標籤空白與雜訊行、追蹤器緩衝與 `flush`、鑑定進行中不更新基準、`PRIMARY_GAP` 與屬性權重在 `zap-equipment.js`；讀取目前穿著只能走 `startMacro`；浮層第三個區段與計時共用；失敗不能靜默。
- [ ] **Step 4: 驗證。** Run: `npm test` — Expected: 全部 PASS；`Grep '"version": "1.23.0"'` 有命中；`git diff --stat` 與上列一致。
- [ ] **Step 5: Commit** — 「Release v1.23.0: equipment comparison」。提醒使用者重新載入並重新整理遊戲頁。
