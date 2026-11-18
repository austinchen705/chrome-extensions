# chrome-extensions

每個子資料夾是一個獨立的 Chrome extension（Manifest V3，unpacked 載入），資料夾內以 `manifest.json` 為入口。

## 行尾

- **改檔案行尾要小心**：`content.js`、`popup.js`、`popup.html`、`CLAUDE.md`、`README.md`、`CHANGELOG.md` 都是 CRLF，用 `sed -i` 或只比對 LF 的字串取代會把整個檔案轉成 LF（diff 變成上千行）；改完要看 `git diff --stat`，用 Node 取代時要先偵測並保留原本的行尾。

## 各功能的說明（用到才讀）

每個功能的設計、限制與測試寫在 `docs/claude/<主題>.md`，**改到某個功能的檔案之前，先讀它那一份**（下表「改到這些就讀」）；跨好幾個功能的改動，相關的幾份都要讀。新增功能時另開一份並加進這張表；一個事實只寫在一份，別份要提到時寫檔案路徑。

| 主題 | 文件 | 改到這些就讀 |
|---|---|---|
| 安裝腳本 | `docs/claude/install-scripts.md` | `install.ps1`、`install.sh`、`bin/install-extension.js` |
| 狀態觸發（規則、安全機制、`@巨集 N`、最優先、聊天與其他指令的切換間隔） | `docs/claude/triggers.md` | `trigger-engine.js`、`content.js` 的送出佇列與觸發、觸發分頁 |
| 停止關鍵字 | `docs/claude/stop-keywords.md` | `stop-keywords.js` |
| 新版本提示、更新說明 | `docs/claude/update-check.md` | `update-check.js`、`background.js` 的更新檢查 |
| 內力可練上限 | `docs/claude/force-cap.md` | `force-cap.js` |
| 孤兒程式與重複面板 | `docs/claude/orphan-instances.md` | `instance-guard.js`、新增會送指令的入口 |
| 驗證碼偵測與自動辨識、真人驗證 | `docs/claude/captcha.md` | `captcha-art.js`、`captcha-grid.js`、`content.js` 的驗證碼流程 |
| 定時（固定、隨機）與 Idle | `docs/claude/timer-random.md` | `timer-settings.js`、定時與隨機分頁 |
| 遊戲巨集的 `@等待`、空白行 | `docs/claude/macro-wait.md` | `macro-wait.js`、`sendCommand`、`queueCommand` |
| 巨集備註 | `docs/claude/macro-notes.md` | `macro-notes.js`、`macro-notes.css` |
| 警報提示音 | `docs/claude/alert-sound.md` | `content.js` 的響鈴 |
| 怪物查詢 | `docs/claude/zap-mobs.md` | `zap-mobs.js`、`zap-panel.js`、`tools/gen-zap-data.js` |
| 裝備比較 | `docs/claude/zap-equipment.md` | `zap-equipment.js`、`zap-equipment-ui.js` |
| 招式列表、招式動畫 | `docs/claude/skill-moves.md` | `skill-moves.js`、`move-fx.js` |
| 拜師導師搜尋 | `docs/claude/mentor-search.md` | `mentor-*.js`、`tools/gen-mentor-data.js` |
| 無名物品 | `docs/claude/zap-items.md` | `zap-items.js` |
| 解謎 | `docs/claude/zap-riddles.md` | `zap-riddles.js`、`zap-riddle-ui.js` |
| 手機通知（LINE） | `docs/claude/line-notify.md` | `line-notify.js`、`background.js` 的 `ALERT` |
| 共用資料（試算表） | `docs/claude/shared-data.md` | `shared-data.js`、`background.js` 的 `refreshShared` |
| 巨集匯入匯出 | `docs/claude/macro-io.md` | `macro-io.js`、`macro-io-ui.js` |
| 設定備份（新增儲存鍵也要讀） | `docs/claude/settings-backup.md` | `settings-backup.js`、任何新的 `chrome.storage` 鍵 |
| 額外的遊戲網址 | `docs/claude/extra-game-urls.md` | `game-urls.js`、manifest 權限 |
| 巨集視窗調整大小 | `docs/claude/macro-resize.md` | `macro-resize.js` |
| 地圖怪物蒐集 | `docs/claude/map-collect.md` | `map-collect.js` |
| 地圖巡怪（核心：路線、看房間、打怪、補氣、輪與重生、設定欄位、面板） | `docs/claude/map-hunt.md` | `map-hunt.js`、`hunt-parse.js`、`map-route.js`、`map-hunt-ui.js`、`content.js` 的巡怪接線 |
| 地圖巡怪：街景模式（掃描） | `docs/claude/map-hunt-scan.md` | 掃描、打怪前補掃 |
| 地圖巡怪：負重、自動整理、可 ride 的格子 | `docs/claude/map-hunt-sort.md` | `checkLoad`、`sortOut`、`retreat` |
| 地圖巡怪：巡怪紀錄、手動紀錄、擬人化 | `docs/claude/map-hunt-log-humanize.md` | `record`、`summaryLines`、`humanize`、手動紀錄、`hunt-profile.js`、`mapHuntProfile` |
| 地圖巡怪：跨區巡怪 | `docs/claude/map-hunt-chain.md` | `chain`、`map-hunt-chain-ui.js` |
| 聊天回覆 | `docs/claude/chat-reply.md` | `chat-reply.js` |
| 劇本對話 | `docs/claude/chat-script.md` | `chat-script*.js`、`tools/*chat-scripts*` |
| 隨機表情 | `docs/claude/semote.md` | `emote-*.js`、`tools/gen-emote-data.js` |
| 在線獎勵 | `docs/claude/online-reward.md` | `content.js` 的 `watchReward`、`sc` |
| 商人裝備資料庫 | `docs/claude/shop-collect.md` | `shop-collect.js` |
| 內建資料（地圖怪物、商人裝備） | `docs/claude/builtin-data.md` | `map-data.js`、`shop-data.js`、`docs/data/*.tsv` |
| 數值區塊 | `docs/claude/stats-block.md` | `stats-view.js`、`stats-block.js` |
| 置頂浮窗、密語 | `docs/claude/pip-panel.md` | `pip-panel.js`、`whisper-block.js`、面板內容 |
| 設定頁（摺疊、分頁、依賴提示、寬螢幕版面、自動存檔） | `docs/claude/settings-page.md` | `popup.html`、`popup.js` |

## 開發流程

新功能或較大的改動固定照這個順序走，每一步用對應的 skill，步驟之間的結果都要經過使用者確認；小修正（改字、單點 bug）可以直接做，不必走全程：

1. `/grill-me`：一輪一輪訪談把想法釐清，使用者確認「已有共識」才往下。
2. `/to-spec`：把共識整理成規格，不再訪談；先跟使用者確認測試接縫（盡量只用一個、用最高層）。規格放 `.scratch/<功能>/spec.md`。
3. `/to-tickets`：把規格切成垂直切片的票，標明誰擋住誰，使用者批准後寫成 `.scratch/<功能>/issues/<NN>-<名稱>.md`。
4. `/implement`：依票實作，盡量 TDD；常跑單檔測試；完成後自動進 `/code-review`；commit 到目前分支。測試範圍見下面「測試範圍」。
5. `/code-review`：以固定點（分支或 commit）到 HEAD 做兩軸審查（Standards、Spec），兩份報告分開看，由使用者決定哪些要修。

- **測試範圍**（使用者指定）：測試依需要的環境分資料夾，資料夾決定怎麼跑。`tests/unit/`（純函式、讀檔比對，不起 jsdom、不執行 background、不載入 popup.html，整批約 2 秒）：日常一律跑 `npm run test:unit`。`tests/integration/`（慢，平常不跑）：只跑「載入或執行了這次改到的程式」的整合測試檔，分三個資料夾：`tests/integration/game/`（整個 content script 在 jsdom，`npm run test:game`）、`tests/integration/settings/`（jsdom 載入真正的 popup.html，`npm run test:settings`）、`tests/integration/background/`（執行 background.js，`npm run test:background`）；`npm run test:integration` 是三個全部。挑法是 grep 改到的檔名看哪些測試載入它，例如改 `map-hunt.js` 的整理（sort）程式就跑 `tests/integration/game/map-hunt-sort.test.js`，改 `popup.html`／`popup.js` 就跑 `tests/integration/settings/` 裡相關的 `*-ui.test.js`；單檔用 `node --test <路徑>`。地圖巡怪的整合測試按主題分檔（`tests/integration/game/map-hunt-` 加 `core`、`fight`、`rest`、`sort`、`chain`、`scan`、`rounds`、`human`），共用的假地圖與假遊戲在 `tests/helpers/map-hunt-world.js`，新測試放進對應主題的檔案。新測試依環境放：用不到 jsdom 與 background 的放 `tests/unit/`；同一個檔案混著純函式與 jsdom 的放它需要的整合資料夾。整套 `npm test`（Node 22 以上，各檔平行跑）只在改到很多功能共用的核心（`content.js` 的送出佇列與看門狗、manifest 與備援注入的載入清單、`trigger-engine.js`）時才自己判斷要不要跑；大功能切成好幾張票時也一樣，每張票只跑相關的。`tests/integration/settings/force-extras-settings-ui.test.js` 在整套一起跑、機器忙時會偶發失敗（載入後固定只等 100 毫秒），單獨跑會過，不是改動造成的。
- **各步驟用哪個模型**（使用者指定）：規劃（`/grill-me`、`/to-spec`、`/to-tickets`）用 Fable；開發（`/implement`）用 Sonnet，由主對話用 Agent 工具開 `model: sonnet` 的 agent 照票實作；測試與驗收（跑測試、看截圖、`/code-review`、確認 agent 的改動）用 Opus。主對話自己在哪個模型上要看 `/model`，派 agent 時照這個分工指定模型。
- 這套取代 superpowers 的 brainstorming／writing-plans／executing-plans，兩套不混用，規格只留一份。
- 專案其他規則仍然優先：改了 extension 的任何檔案都要升 `manifest.json` 版本並在 `CHANGELOG.md` 加一筆；commit 之後要不要 push 一律先問使用者。
- 這些 skill 只能由使用者用 `/名稱` 觸發；使用者要先跑過一次 `/setup-matt-pocock-skills`，沒有 `docs/agents/` 時 `/to-spec`、`/to-tickets`、`/code-review` 會要求先設定。

## 驗證、錯誤、警告訊息的顯示

- 所有驗證、錯誤、警告的訊息都要用同一組顏色標出來：**error 紅、warn 琥珀、info 不上色**（成功與一般訊息不上色）。設定頁用 `popup.html` 的 `.msg-error`／`.msg-warn`（顏色沿用規則狀態 `.pill` 那組：紅 `#fde2df／#b42318`、琥珀 `#fdecc8／#8a5a00`）；遊戲頁面板（shadow DOM）用 `#ff8a7a`（`alert`、`zap-bad`、`rd-bad`）與 `#ffb347`（`warn`、`zap-caution`、`rd-note`）。
- 新增會顯示給使用者的訊息時要想「這是驗證／錯誤／警告嗎」，是的話帶等級：設定頁的狀態列用 `setStatus(text, level)`／`markLevel`，一行一行的訊息用 `showParts`；LINE 區用 `say(text, level)`；怪物面板的狀態列用 `say`、浮層與裝備的訊息列用 `zap-bad`／`zap-caution`；解謎用 `say(text, level)`。**換新訊息時舊的上色要一起清掉**（用 `classList.toggle`，不要只加不減）。
- 共用資料的訊息等級由 `shared-data.js` 決定（有測試）：`describeSheetParts`、`reportEntries` 回傳 `{ level, text }`（更新失敗與被丟掉的列是 error；有被丟掉或對不到的列、超過上限、沒勾、沒有 gid、不會抓取是 warn）；`describeSheet`、`reportLines` 是它們的純文字版。

## 說明文件

- 安裝、操作、狀態觸發、驗證碼停止時機都只寫在 `README.md`（GitHub 不會渲染 html，所以不另做 html 說明頁）。README 用的截圖放在 `catworld-auto-command/help/`，改了畫面要重拍。

## 產生的資料

- `catworld-auto-command/skills-data.js` 由 `node tools/gen-skills-data.js <the-cat-world repo 路徑>` 從 `jrealm/the-cat-world` 解析產生，不要手改；來源 repo 更新時重新產生。

## 版本號

- 每次改動 extension 的任何檔案，都要同步升該 extension 的 `manifest.json` `version`：小修正升 patch、新功能升 minor；並在根目錄 `CHANGELOG.md` 最上面加一筆（版本、日期、使用者看得到的變化）。同一次 commit 累積了多個版本時，在紀錄裡註明一起發布。
- popup 上的版本顯示一律讀 `chrome.runtime.getManifest().version`，不要另外寫死。
- 改完要提醒使用者：到 `chrome://extensions` 重新載入 extension，並重新整理目標分頁，content script 才會更新。

## Agent skills

### Issue tracker

Issues and specs live as local markdown files under `.scratch/<feature-slug>/`（不進 git）. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix), recorded as a `Status:` line in each issue file. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context. See `docs/agents/domain.md`.
