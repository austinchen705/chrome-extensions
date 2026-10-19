# 無名物品鑑定提示（zap 第 2 階段）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 雜物拿給衰老頭鑑定、拿到真名時，在遊戲頁浮層顯示它的等級、功能與「賣掉／留著／適合你」建議。

**Architecture:** 產生腳本多解析 `ub.htm`（三張表）成 `zap-data.json` 的 `items`；DOM 不相關的 `zap-items.js`（比對、建議、鑑定句偵測，content script／background／popup／測試共用）；background 回應 `ZAP_ITEM`；`zap-panel.js` 的觀察器同時偵測怪物行與鑑定句，兩者共用同一個浮層（各一個區段）；popup 設定「主要武器類型」。

**Tech Stack:** 同第 1 階段（MV3、IIFE + `globalThis.X`、`node --test`）。

**Spec:** `docs/superpowers/specs/2026-10-19-zap-unknown-item-design.md`（上層：`2026-10-19-zap-lookup-design.md`；第 1 階段已完成並在同一分支 `zap-mob-lookup`）

## Global Constraints

- 觸發句：`衰老頭給你<量詞><名稱>。`，且 60 秒內先看到過 `你拿著…給衰老頭看了一下`；只看 `#content` 新增文字（`textFromAdded` 直接相接）、略過浮動視窗，與 `active()` 無關。
- 比對鍵：NFKC、小寫、去掉所有括號及其內容（半形全形）、去掉所有空白；在句子（觸發詞之後）中找「被包含的最長名稱」；去括號後同鍵有多筆時全部列出，不猜。
- 建議規則：`item.weapon` 等於使用者 `mainWeapon` → `fit`（適合你，建議留著，不論等級）；否則 LV ≥ 3 → `keep`；LV1、LV2 → `sell`。表上查不到 → 顯示「表上沒有這個物品」與原句，不給建議。
- 武器類型：`劍 刀 杖 鞭 拳套 暗器`；對應只看表上實際有的詞：劍→名稱含「劍鑄模」、刀→「刀鑄模」、杖→「杖鑄模」、暗器→「鏢鑄模」、鞭→名稱或功能含「鞭」；拳套沒有相關物品；指環鑄模不算武器。
- 浮層與怪物提示共用，任何區段更新重設 10 秒計時；第 1 階段既有測試（32 項）必須維持通過。
- 資料併入 `zap-data.json`（新增 `items`），仍由 background 懶載入；`mainWeapon` 存 `chrome.storage.local.mainWeapon`，改了馬上生效。
- 依專案 `CLAUDE.md`：新模組要同時加進 manifest、popup.html、popup 備援注入 `files`（都在 `zap-panel.js`／`content.js`／`popup.js` 之前）；版本升 minor → `1.21.0`；`CHANGELOG.md`、README、`CLAUDE.md` 只寫現況；測試用 `npm test`。

## Review Focus

- 鑑定句查不到 → 顯示「表上沒有這個物品」與原句，**不給建議**，不丟例外（Task 1、Task 4）。
- 沒有先看到「你拿著…給衰老頭看了一下」的 `衰老頭給你…`、或超過 60 秒後的 → 不處理（Task 1）。
- 遊戲只印「劍鑄模」沒有洞數 → 去括號後命中三筆（一～三洞），各自標示等級與建議（Task 1）。
- `mainWeapon` 未設定、設成拳套、或存了不合法的值 → 一律只套用等級規則，不當成相關（Task 1、Task 5）。
- 一次鑑定多件：一批新增文字裡有多個 `衰老頭給你…` 各自處理；超過 8 件只列 8 件加「…還有 N 件」（Task 4）。
- 來源 `ub.htm` 改版導致解析出 0～極少筆 → 產生腳本非 0 結束、不覆寫 `zap-data.json`（Task 2）。

---

## 檔案結構

| 檔案 | 責任 |
|---|---|
| `catworld-auto-command/zap-items.js`（新） | 不碰 DOM：鑑定句偵測、名稱鍵、比對、建議、`ZAP_ITEM` 訊息處理、`WEAPON_TYPES` |
| `tools/zap-parse.js`（改） | 新增 `parseUnknownObjectHtml`；`buildData` 納入 `items` |
| `tools/gen-zap-data.js`（改） | 讀／抓 `ub.htm` |
| `catworld-auto-command/zap-data.json`（重新產生） | 多一個 `items` 欄位 |
| `catworld-auto-command/background.js`（改） | 載入整份資料、分派 `ZAP_ITEM` |
| `catworld-auto-command/zap-panel.js`（改） | 共用浮層的區段、鑑定句偵測、`mainWeapon` |
| `catworld-auto-command/popup.html`／`popup.js`（改） | 「主要武器類型」下拉 |
| `catworld-auto-command/manifest.json`（改） | content script 加入 `zap-items.js` |
| `tests/zap-items.test.js`、`tests/fixtures/ub-sample.html`（新） | 測試與 fixture |

---

### Task 1: `zap-items.js` 鑑定句偵測、比對、建議

**Files:**
- Create: `catworld-auto-command/zap-items.js`
- Test: `tests/zap-items.test.js`

**Interfaces:**
- Produces（`globalThis.CatworldZapItems`）：
  - `WEAPON_TYPES: string[]` = `['劍','刀','杖','鞭','拳套','暗器']`
  - `HAND_WINDOW_MS = 60000`
  - `itemKey(text: string): string`——NFKC、小寫、去掉所有 `(...)`／`（...）` 及其內容、去掉所有空白
  - `findIdentified(text: string, now: number, state: { handedAt: number | null }): string[]`——文字含 `你拿著…給衰老頭看了一下` 時設 `state.handedAt = now`；回傳所有 `衰老頭給你(.+?)。` 的捕捉內容，僅限 `state.handedAt` 不為 null 且 `now - handedAt <= HAND_WINDOW_MS`
  - `matchItems(items: Item[], sentence: string): Item[]`——回傳 `itemKey` 被包含在 `itemKey(sentence)` 中的**最長鍵**的所有項目；沒有則 `[]`
  - `advise(item: Item, mainWeapon: string): { action: 'sell'|'keep'|'fit', text: string }`——文字：`fit`＝「適合你，建議留著」、`keep`＝「建議留著」、`sell`＝「建議賣掉」
  - `describeIdentified(items, sentences: string[], mainWeapon: string): { sentence: string, candidates: { item: Item, advice: Advice }[] }[]`
  - `handleMessage(items: Item[], message): { ok: true, results: ReturnType<describeIdentified> } | null`——只處理 `type: 'ZAP_ITEM'`（`sentences`、`mainWeapon`），其他回 `null`
- `Item`：`{ name: string, level: 1|2|3|4|5, note: string, weapon: string }`（`weapon` 為 `WEAPON_TYPES` 之一或 `''`）。

- [ ] **Step 1: Write the failing tests** in `tests/zap-items.test.js`（`require('../catworld-auto-command/zap-items.js')` 後用 `globalThis.CatworldZapItems`），測試名稱與斷言：
  - `findIdentified reads the sentences after the hand-over line`：`text = '你拿著奇形怪狀的物品給衰老頭看了一下...\n衰老頭給你一隻奶茶兔吊飾。\n'`、`state = { handedAt: null }`、`now = 1000` → `['一隻奶茶兔吊飾']`，`state.handedAt === 1000`。
  - `findIdentified ignores the sentence without the hand-over line`：`'衰老頭給你一尊明朝古董木雕。'` 且 `state.handedAt` 為 `null` → `[]`。
  - `findIdentified remembers the hand-over across batches and expires after 60s`：第一批只有 `你拿著老舊物品給衰老頭看了一下...`（`now = 0`）回 `[]`；第二批 `衰老頭給你一尊明朝古董木雕。`（`now = 30000`）回 `['一尊明朝古董木雕']`；第三批同句（`now = 70000`）回 `[]`。
  - `findIdentified handles several sentences in one batch`：兩句 `衰老頭給你…。` 各一行，回兩筆、順序同出現順序。
  - `itemKey`：`itemKey('劍鑄模 (二洞)') === itemKey('劍鑄模')`；全形括號 `劍鑄模（二洞）` 相同；`itemKey('千年 雪蛛 岩') === '千年雪蛛岩'`。
  - `matchItems picks the longest contained name`：項目 `[{name:'木雕',…},{name:'明朝古董木雕',…}]`，句子 `一尊明朝古董木雕` → 只回「明朝古董木雕」那筆。
  - `matchItems lists every variant when the game omits the hole count`：三筆 `劍鑄模 (一洞)` LV2、`(二洞)` LV3、`(三洞)` LV4，句子 `一個劍鑄模` → 回 3 筆。
  - `matchItems returns nothing for an unknown item`：句子 `一個不存在的東西` → `[]`。
  - `advise by level`：`level 1`、`2` → `sell`；`3`、`5` → `keep`（`mainWeapon` 為 `''`）。
  - `advise fit beats level`：`{ level: 2, weapon: '劍' }` 配 `mainWeapon '劍'` → `fit`、`text === '適合你，建議留著'`；配 `'刀'` → `sell`。
  - `advise ignores an unset or invalid mainWeapon`：`mainWeapon` 為 `''`、`undefined`、`'法師'` 時，`{ level: 2, weapon: '劍' }` 皆 `sell`；`mainWeapon '拳套'` 配 `weapon: ''` 的 LV4 → `keep`（`weapon` 為空永不算 `fit`）。
  - `describeIdentified marks an unknown item with no candidates`：未知句子 → `candidates` 為 `[]`、`sentence` 保留原句。
  - `handleMessage`：`ZAP_ITEM` 回 `{ ok: true, results }`；未知 type 回 `null`。

- [ ] **Step 2: Run to verify fail** — Run: `node --test tests/zap-items.test.js` — Expected: FAIL（找不到 `zap-items.js`）。

- [ ] **Step 3: Implement `zap-items.js`** 依 Interfaces。檔頭繁中註解說明規則；包成 `(() => { if (globalThis.CatworldZapItems) return; … })()` 並帶 `globalThis.CatworldZapItems = {…}`，同其他模組風格。`findIdentified` 用 `/你拿著[^\n]{0,40}給衰老頭看了一下/` 與 `/衰老頭給你([^。\n]+)。/g`。`matchItems` 先算每個項目的鍵，過濾「非空且被句子鍵包含」，取最長鍵長度，回傳該長度的所有項目。

- [ ] **Step 4: Run to verify pass** — Run: `node --test tests/zap-items.test.js` — Expected: 全部 PASS；再跑 `npm test`，Expected: 全部 PASS（含第 1 階段 32 項）。

- [ ] **Step 5: Commit** — 加入 `catworld-auto-command/zap-items.js tests/zap-items.test.js`，訊息「Add zap item matching and advice module」，結尾帶本專案 attribution。

---

### Task 2: 解析 `ub.htm`、納入資料檔

**Files:**
- Modify: `tools/zap-parse.js`、`tools/gen-zap-data.js`
- Create: `tests/fixtures/ub-sample.html`（直接存 `https://zap.muds.me/ub.htm` 目前的完整內容，約 26KB）
- Modify: `catworld-auto-command/zap-data.json`（重新產生）
- Test: `tests/zap-parse.test.js`（新增項目）、`tests/zap-build.test.js`（新增項目）

**Interfaces:**
- Consumes: Task 1 的 `Item` 形狀。
- Produces:
  - `parseUnknownObjectHtml(html: string): Item[]`——見下方版面規則；`weapon` 欄依 Global Constraints 的對應推算
  - `buildData(input: { zapHtml, newstartHtml, overrides, ubHtml? }, limits?: { minZap?, minNewstart?, minItems? })`——有 `ubHtml` 時 `data.items = parseUnknownObjectHtml(ubHtml)`，少於 `minItems`（預設 30）筆丟 `Error('來源解析異常…')`；沒有 `ubHtml` 時 `data.items = []` 且不檢查；`data.sources` 多一筆 `https://zap.muds.me/ub.htm`
  - 產生腳本：`--from-dir` 另讀 `<dir>/ub.htm`；預設連網抓 `https://zap.muds.me/ub.htm`

**`ub.htm` 版面（已查證）**：資料部分有三張 `<table>`，LV 在帶 `rowspan` 的儲存格（文字符合 `/^LV\s*\d$/`），往下列沿用。
1. 第 1 張：每列 LV 之後的所有非空儲存格都是**純名稱**（LV1 是販賣品、無功能），`note` 為空。
2. 第 2 張（鑄模與材料）：每列 `[LV?] 名稱, 功能`，功能文字當 `note`。
3. 第 3 張（寶石）：每列 `[LV?] 名稱, 武器效果, 防具效果`，`note` 為「武器：<效果>　防具：<效果>」（空的略過）。
- 表頭列（含「等級」「物品名稱」「功能」「鑲於」字樣）略過；名稱取儲存格純文字（`<span>` 拆開的要相接，連續空白合併成一個）；空儲存格略過。

- [ ] **Step 1: Save the fixture** — Run: `curl -sL https://zap.muds.me/ub.htm -o tests/fixtures/ub-sample.html`；確認檔案以 UTF-8 解碼後含「明朝古董木雕」。

- [ ] **Step 2: Write the failing tests.** `tests/zap-parse.test.js` 新增：
  - `parseUnknownObjectHtml reads junk names from the first table`：回傳中有 `{ name: '明朝古董木雕', level: 1, note: '', weapon: '' }` 與 `奶茶兔吊飾` LV1。
  - `parseUnknownObjectHtml reads moulds with their function`：有 `{ name: '劍鑄模 (二洞)', level: 3, note: '鑄造所需使用的模子', weapon: '劍' }`；`杖鑄模 (四洞)` LV4 `weapon: '杖'`；`鏢鑄模 (一洞)` `weapon: '暗器'`；`指環鑄模 (一洞)` `weapon: ''`。
  - `parseUnknownObjectHtml maps whip materials by name or function`：`海龍皮` LV2 `weapon: '鞭'`、`note` 含「鞭子」；`獸骨鞭柄 (二洞)` `weapon: '鞭'`。
  - `parseUnknownObjectHtml reads gems with effects`：`龍宮舍利` LV5 的 `note` 含「內功 +12」；`瑪瑙皇` LV3 的 `note` 含「會心 +1」。
  - `parseUnknownObjectHtml has no fist items`：沒有任何 `weapon === '拳套'`。
  - `parseUnknownObjectHtml joins names split by spans`：有名稱含「雪蛛」且不含 `|` 或換行。
  - `parseUnknownObjectHtml covers all five levels`：`level` 集合為 1～5 且總筆數 ≥ 150。
  `tests/zap-build.test.js` 新增：`buildData includes items when ubHtml is given`（用 fixture、`limits: { minZap: 1, minNewstart: 1 }`，`data.items.length > 100`、`data.sources.length === 3`）；`buildData rejects an ub page that parses to too few items`（`ubHtml: '<html></html>'` 丟「來源解析異常」）。

- [ ] **Step 3: Run to verify fail** — Run: `node --test tests/zap-parse.test.js tests/zap-build.test.js` — Expected: 新增的測試 FAIL（`parseUnknownObjectHtml` 未定義），舊測試 PASS。

- [ ] **Step 4: Implement** `parseUnknownObjectHtml`（regex 取每張 `<table>` 與其 `<tr>`／`<td>`，沿用檔內既有的 `cellText`／解碼函式；`weapon` 推算寫成一個小函式 `weaponOf(name, note)`）、擴充 `buildData` 與 `SOURCES`（加入 `ub.htm`，`buildData` 的 `data.sources` 在無 `ubHtml` 時仍回前兩個）、更新 `gen-zap-data.js`。

- [ ] **Step 5: Run to verify pass** — Run: `npm test` — Expected: 全部 PASS。

- [ ] **Step 6: Regenerate real data.** Run: `node tools/gen-zap-data.js`（需連網）。Expected: 結束碼 0、報告多一行 items 筆數；用 `node -e` 確認 `zap-data.json` 的 `items` 含 `明朝古董木雕`（LV1）、`劍鑄模 (二洞)`（LV3、weapon 劍）、`龍宮舍利`（LV5），且 `mobs` 數量仍為 891。

- [ ] **Step 7: Commit** — 「Parse unknown-object table into zap data」。

---

### Task 3: background 分派 `ZAP_ITEM`

**Files:**
- Modify: `catworld-auto-command/background.js`、`tests/zap-background.test.js`

**Interfaces:**
- Consumes: `CatworldZapItems.handleMessage(items, message)`、`CatworldZapMobs.handleMessage(mobs, message)`。
- Produces: 對 `{ type: 'ZAP_ITEM', sentences, mainWeapon }` 回 `{ ok: true, results }`；資料載入改為回傳整份 `{ mobs, items }`（`items` 缺漏時當 `[]`）。

- [ ] **Step 1: Write the failing tests**（改 `tests/zap-background.test.js`）：stub 的 `fetch` 回傳 `{ mobs, items: [{ name: '明朝古董木雕', level: 1, note: '', weapon: '' }] }`；新增 `background answers ZAP_ITEM`：`await ask({ type: 'ZAP_ITEM', sentences: ['一尊明朝古董木雕'], mainWeapon: '劍' })` → `reply.ok === true`、`reply.results[0].candidates[0].advice.action === 'sell'`；並確認同一份資料沒有重複載入（`fetchCalls` 仍為 1）。`background ignores messages that are not ZAP_*` 仍要通過。

- [ ] **Step 2: Run to verify fail** — Run: `node --test tests/zap-background.test.js` — Expected: 新測試 FAIL（`未知的查詢`）。

- [ ] **Step 3: Implement.** `importScripts('zap-mobs.js', 'zap-items.js')`；`loadZapMobs` 改名 `loadZapData` 並回傳 `data`（維持懶載入與失敗不快取）；監聽器改為 `CatworldZapMobs.handleMessage(data.mobs, message) ?? CatworldZapItems.handleMessage(data.items ?? [], message) ?? { ok: false, error: '未知的查詢' }`。

- [ ] **Step 4: Run to verify pass** — Run: `npm test` — Expected: 全部 PASS。

- [ ] **Step 5: Commit** — 「Serve ZAP_ITEM queries from the background worker」。

---

### Task 4: 共用浮層、鑑定句偵測、`mainWeapon`

**Files:**
- Modify: `catworld-auto-command/zap-panel.js`、`catworld-auto-command/manifest.json`
- Test: DOM 無單元測試；以 jsdom 冒煙（放在 repo 外的暫存資料夾）與真實頁面手動驗證

**Interfaces:**
- Consumes: `CatworldZapItems.findIdentified`、`CatworldZapMobs.limitHints`、`ZAP_ITEM`、`chrome.storage.local.mainWeapon`。
- Produces: 浮層容器內兩個區段（怪物、鑑定結果），任一區段更新都重設 10 秒計時，兩區段都空才隱藏。

- [ ] **Step 1: 重構浮層。** `zap-panel.js` 內把目前直接操作 `hint` 的 `showHints` 改成：`hint` 容器內固定兩個子 div（`.zap-sec-mobs`、`.zap-sec-items`）；`setSection(section, nodes)` 先清空該區段再放入 `nodes`，然後 `hint.hidden = false` 並重設 `hideTimer`（10 秒後兩區段清空並隱藏）。怪物提示改呼叫 `setSection(mobSection, nodes)`，輸出內容與第 1 階段相同。Run: `npm test`，Expected: 全部 PASS（重構不改行為）。

- [ ] **Step 2: 鑑定句偵測與顯示。**
  - 在同一個 `MutationObserver` 回呼裡，`text` 算出後除了 `parseMobLines`，也呼叫 `CatworldZapItems.findIdentified(text, Date.now(), handState)`（`handState = { handedAt: null }` 放在 `attach` 範圍）。一次回呼內兩邊獨立處理，不能因為沒有怪物行就提早 `return`。
  - 有鑑定句時：用 `CatworldZapMobs.limitHints` 限制 8 件，送 `{ type: 'ZAP_ITEM', sentences, mainWeapon }`（`mainWeapon` 變數啟動時讀 `chrome.storage.local.mainWeapon`，並監聽 `storage.onChanged` 更新；不在 `WEAPON_TYPES` 內的值當 `''`）。
  - 回應用與怪物相同的「只採用最後一次」序號保護；顯示：區段標題「鑑定結果」；每個 `result` 一行（`result.sentence`），其下每個候選一行：`LV n`、表上完整名稱、建議文字（顏色：`sell` `#ff8a7a`、`keep` `#3ecf6e`、`fit` `#6ec1ff`）、`note`（有的話）；`candidates` 為空時顯示「表上沒有這個物品」；超過 8 件加「…還有 N 件」。全部用 `textContent`。
  - 同一件物品名稱 10 秒內不重複提示（用 `CatworldZapMobs.recentFilter` 對 `sentence` 去重）。
- [ ] **Step 3: manifest。** content script `js` 順序：`…`、`zap-mobs.js`、`zap-items.js`、`zap-panel.js`、`content.js`。
- [ ] **Step 4: 冒煙驗證（repo 外）。** 在暫存資料夾用 jsdom（沿用第 1 階段的做法）載入 `zap-mobs.js`、`zap-items.js`、`zap-panel.js` 與真實 `zap-data.json`，以 `createContextualFragment` 附加真實遊戲片段（`D:/Repository/catworld.txt` 內「你拿著奇形怪狀的物品給衰老頭看了一下...」與「衰老頭給你一隻<span>奶茶兔</span><span>吊飾</span>。」），確認：浮層出現「鑑定結果」、奶茶兔吊飾 LV1「建議賣掉」；`mainWeapon` 設 `劍` 後再鑑定一個 `劍鑄模` 顯示「適合你，建議留著」；沒有 `你拿著` 句子的 `衰老頭給你…` 不顯示；怪物行與鑑定句同批出現時兩個區段都在；查不到的句子顯示「表上沒有這個物品」。
- [ ] **Step 5: 驗證落地。** `git diff --stat`、`node --check` 兩個檔案；請使用者重新載入 extension 後，在真實遊戲鑑定一件雜物確認浮層（無法在此環境登入遊戲）。
- [ ] **Step 6: Commit** — 「Show unknown-item advice in the shared overlay」。

---

### Task 5: popup「主要武器類型」

**Files:**
- Modify: `catworld-auto-command/popup.html`、`catworld-auto-command/popup.js`

**Interfaces:**
- Consumes: `CatworldZapItems.WEAPON_TYPES`。
- Produces: `chrome.storage.local.mainWeapon`（`''` 或 `WEAPON_TYPES` 之一）。

- [ ] **Step 1: 設定欄位。** `popup.html` 在「怪物分級」區塊旁新增一個 `.alertbox`，內有 `<select id="mainWeapon">`（第一個選項值 `''`、文字「未設定」，其餘選項由 JS 依 `WEAPON_TYPES` 產生）與一行說明「用來判斷鑑定後的鑄模與材料是否適合你；未設定時只依等級建議」；`popup.html` 在 `popup.js` 之前載入 `zap-items.js`。
- [ ] **Step 2: 邏輯。** `popup.js`：載入時讀 `mainWeapon`（不合法值當 `''`）填入下拉；`change` 時寫回 `chrome.storage.local.set({ mainWeapon })`。popup 的備援注入 `files` 清單加入 `'zap-items.js'`（在 `'zap-mobs.js'` 之後、`'zap-panel.js'` 之前）。
- [ ] **Step 3: 驗證。** jsdom 載入真實 `popup.html`（沿用第 1 階段的冒煙做法，stub `chrome`）：下拉有 7 個選項；選「劍」後 `storage.set` 收到 `{ mainWeapon: '劍' }`；儲存了不合法值時下拉顯示「未設定」；無腳本錯誤。`git diff` 確認備援注入清單已含 `zap-items.js`。
- [ ] **Step 4: Commit** — 「Add main weapon type setting」。

---

### Task 6: 版本、紀錄與說明

**Files:**
- Modify: `catworld-auto-command/manifest.json`（`version` → `1.21.0`）、`CHANGELOG.md`、`README.md`、`CLAUDE.md`

- [ ] **Step 1:** `manifest.json` 版本改 `1.21.0`；`CHANGELOG.md` 最上面加 `## 1.21.0（2026-10-19）`：無名物品鑑定提示（鑑定出真名時顯示 LV 與「賣掉／留著／適合你」建議、LV1～2 賣掉、LV3 以上留著、與主要武器類型相關的鑄模／材料標「適合你」）、popup 新增「主要武器類型」、資料來源為 zap 的無名物品表。
- [ ] **Step 2:** `README.md` 在「怪物查詢」之後新增「無名物品」小節：怎麼觸發（拿給衰老頭鑑定）、建議規則、設定主要武器類型、拳套在表上沒有相關物品、表上沒有的物品會顯示「表上沒有這個物品」、重新產生資料的方式（同怪物查詢）。
- [ ] **Step 3:** `CLAUDE.md` 在「怪物查詢」小節旁新增現況：`zap-items.js` 不碰 DOM、與 `zap-mobs.js` 同樣需同步加進 manifest／popup.html／備援注入且在 `zap-panel.js` 之前；鑑定句偵測需先看到「你拿著…給衰老頭看了一下」（60 秒內）；比對鍵去括號去空白、同鍵多筆全列；浮層兩區段共用一個計時；`ub.htm` 是三張表的版面規則（寫一行即可）。
- [ ] **Step 4: 驗證。** Run: `npm test` — Expected: 全部 PASS；`Grep '"version": "1.21.0"' catworld-auto-command/manifest.json` 有命中；`git diff --stat` 與上列檔案一致。
- [ ] **Step 5: Commit** — 「Release v1.21.0: unknown-item hints」。提醒使用者到 `chrome://extensions` 重新載入並重新整理遊戲頁，在遊戲內鑑定一件雜物確認。
