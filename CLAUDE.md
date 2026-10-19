# chrome-extensions

每個子資料夾是一個獨立的 Chrome extension（Manifest V3，unpacked 載入），資料夾內以 `manifest.json` 為入口。

## 安裝腳本

- 三個安裝入口行為一致（只覆蓋已是 extension 的資料夾或空資料夾、顯示「升級：vX → vY」、嘗試複製路徑並開 `chrome://extensions`），改一個要一起改：
  - `install.ps1`（Windows，`irm … | iex`）、`install.sh`（macOS / Linux，`curl … | sh`）：下載 GitHub 預設分支的 ZIP，不需要 Node / git。用 `iex` 執行所以不能 `exit`，要包在函式裡用 `return`。
  - `bin/install-extension.js`（`package.json` 的 `bin`，`npx github:austinchen705/chrome-extensions`）：給已有 Node 與 git 的人。
- 三者都會安裝任一含 `manifest.json` 的子資料夾，新增 extension 不需要改腳本；安裝方式寫在 `README.md`。

## 狀態觸發

- 規則判斷在 `catworld-auto-command/trigger-engine.js`（不碰 DOM，讀數、時間、送出指令都由呼叫端傳入），content script 與 popup 共用；規則狀態機與安全上限的語意寫在該檔開頭註解。manifest 的 content script 與 popup 的備援注入都要帶上它。
- 驗證碼偵測、看門狗、送出佇列在「定時或觸發任一個在跑」時都要作用（`active()`），新增會送指令的功能要接同一套；遊戲浮動視窗（`#monitor`、`#map_table`、`#macro_table`、`#setting_table`）內的變動不能當成遊戲輸出。
- 觸發分成「戰鬥」「練功」兩組（`trigger-engine.js` 的 `GROUPS`），功能相同、完全獨立：各自的設定存在 `triggerGroupSettings.<id>`、各自一個引擎與計時器，送出佇列來源是 `trigger:<id>`。`START_TRIGGER` / `STOP_TRIGGER` / `REARM_RULE` 一定要帶 `group`（未知或沒帶回 `ok:false`）；`STATUS` 回 `stats`（讀數，共用）與 `triggerGroups.<id>`。popup 用 `<template id="triggerPaneTemplate">` 為每組產生一個分頁，template 內的 id 都帶 `-__G__`；新增一組只要加進 `GROUPS`。舊的 `triggerSettings` 由 `loadGroupSettings` 整份放進練功組。驗證碼、`stopEverything` 對所有組一起作用。
- 關鍵字規則（`kind: 'keyword'`）的新文字由 `captchaObserver` 在驗證碼檢查之後交給 `engine.onText`，只取 `#content` 內新增的內容。防迴圈靠「只看新文字、冷卻中的直接丟掉、`>` 開頭的回聲行略過」三件事，改動時不能拿掉任何一個，對應測試要保留。

## 定時分頁的隨機指令

- 設定格式是 `settings.randomItems: [{ command, minSeconds, maxSeconds }]`，轉換與抽選在 `timer-settings.js`（content script 與 popup 共用，manifest、popup.html、popup 的備援注入都要載入，且要在 `content.js` 之前）。
- 舊格式（`randomCommands` + `randomMinSeconds` / `randomMaxSeconds`）由 `normalizeRandomItems` 轉換；**不能在 `content.js` 的預設設定裡放 `randomItems`**，否則空陣列會蓋掉升級前存下的舊設定（測試 14i、15i 會擋）。

## 遊戲巨集的 @等待

- 遊戲的巨集是 `command.split(/\s*;\s*/)` 同步全送，沒辦法在遊戲裡加等待。`macro-wait.js`（不碰 DOM 以外的東西）負責鍵值、解析、讀 `#macro_list`；`content.js` 在 `window` 捕獲階段攔下「有 `@等待` 的巨集」自己跑，其餘交給遊戲。manifest、popup 的備援注入都要載入 `macro-wait.js`，且在 `content.js` 之前。
- `macro-wait.js` 的 `KEY_VALUES` 抄自遊戲 `web.js` 的 `key_values`，攔截條件（只在目標是 `#input` 或 `body`）也和遊戲 `document.body.onkeydown` 一致；遊戲改了這兩處要同步（測試會逐項比對 `web.js`）。
- 巨集的指令走共用佇列（`source: 'macro'`），執行中算 `active()`；一個巨集要等最後一個指令真的送出才從 `macroRuns` 移除，否則最後一個指令還在排隊時 `active()` 會變 false 而送不出去。新增會送指令的功能要接 `stopEverything`（驗證碼時一起取消）。
- `sendCommand` 代送指令後要還原使用者正在輸入的文字（遊戲送出後會清空或全選輸入框）。

## 巨集備註

- `macro-notes.js` 在遊戲巨集視窗每一列最後多放一個 `input.note`，備註存在 `chrome.storage.local.macroNotes`（綁列號 1～90），樣式在 `macro-notes.css`（manifest 的 `content_scripts[].css`；popup 的備援注入要 `insertCSS`）。備註框一定要放在指令框**後面**：遊戲的 `on_macro_key_down` 讀的是按鍵框的 `nextSibling`（指令框）。
- 遊戲自己的樣式表比 extension 的樣式晚載入，優先權相同會被它蓋掉（`#macro_table { width: 435px }`），所以樣式要加一層 `body`。jsdom 測不出這種問題，樣式相關的改動要用真實頁面驗證。
- `storage.onChanged` 在「寫入的那個頁面」也會觸發，所以寫入時一起存 `macroNotesWriter`（本頁的隨機代號），收到自己寫的通知要忽略，否則會用舊內容蓋掉還沒存的編輯（測試 21a 會擋）。

## 警報提示音

- 驗證碼警報的響鈴有兩種模式，由 popup 的開關 `persistentAlert`（`chrome.storage.local`，預設 false）決定，`content.js` 啟動時讀取並監聽 `storage.onChanged`，改了馬上生效。關閉＝原本的行為（最多 5 分鐘、互動或按開始就停）；開啟＝`ringing` 為 true，只有 `confirmAlert()`（面板「確認」、通知上的按鈕送來的 `CONFIRM_ALERT`）能停。
- 判斷「互動或按開始要不要停提示音」都看 `ringing`（`flashTitle` 的 `clear`、`armDetection`），新增會停提示音的路徑也要遵守；只有 `stopAndAlert`（驗證碼）會進 `ringing`，`alertOnly`（規則被停用）永遠只響一次。

## 怪物查詢

- 資料是 `catworld-auto-command/zap-data.json`，由 `node tools/gen-zap-data.js` 從 zap 攻略站（`ot1.htm`）與 catworld 說明站（`help/newstart.3`）產生，加上 `tools/zap-overrides.json`（手動補充，優先於網站）；不要手改。解析與合併邏輯在 `tools/zap-parse.js`，來源解析出的筆數異常少時產生腳本會失敗、不覆寫。
- `zap-mobs.js` 不碰 DOM，content script、background、popup、測試共用：manifest、popup.html、popup 的備援注入（`files` 清單）都要載入它，且在 `zap-panel.js`、`content.js` 之前；漏了備援注入的清單，`content.js` 會因為找不到 `CatworldZapPanel` 而出錯。
- 資料只在 background 第一次被問到時載入（`ZAP_LOOKUP`、`ZAP_SUITABLE`），不隨每個遊戲分頁載入。分級看 `q = 強度 × 2 ÷ #exp`，門檻存在 `chrome.storage.local.zapThresholds`。
- 怪物出現提示（`zap-panel.js`）自己觀察 `#content` 新增的文字、略過浮動視窗，與 `active()` 無關；怪物行是 `※名稱(ID) <戰鬥中> [fight][kill]`（`<…>` 狀態不一定有，解析時去掉），比對鍵是完整名稱（不分大小寫、忽略所有空白），同名多隻不猜、全部列出。遊戲把一行拆成多個節點（`※`、稱號、名稱各在自己的 `<span>`），所以新增節點的文字要直接相接（`textFromAdded`），不能用換行連接。UI 放在面板 shadow DOM 內，搜尋框要擋掉 `mousedown` 與按鍵事件的冒泡。
- 測試：`npm test`（`node --test`，Node 18 以上；不要寫成 `node --test tests/`，新版 Node 會把資料夾當檔案）。

## 設定頁

- 面板的 ⚙ 由 `background.js` 把 `popup.html?tab=<遊戲分頁 id>` 開成分頁並記在 `storage.session`，再按一次關閉；`popup.js` 看到 `?tab=` 就控制那個遊戲分頁（`getTab`）並加上 `body.page` 樣式。popup 與設定頁是同一份 HTML/JS，改一份兩邊都會變。

## 說明文件

- 安裝、操作、狀態觸發、驗證碼停止時機都只寫在 `README.md`（GitHub 不會渲染 html，所以不另做 html 說明頁）。README 用的截圖放在 `catworld-auto-command/help/`，改了畫面要重拍。

## 產生的資料

- `catworld-auto-command/skills-data.js` 由 `node tools/gen-skills-data.js <the-cat-world repo 路徑>` 從 `jrealm/the-cat-world` 解析產生，不要手改；來源 repo 更新時重新產生。

## 版本號

- 每次改動 extension 的任何檔案，都要同步升該 extension 的 `manifest.json` `version`：小修正升 patch、新功能升 minor；並在根目錄 `CHANGELOG.md` 最上面加一筆（版本、日期、使用者看得到的變化）。同一次 commit 累積了多個版本時，在紀錄裡註明一起發布。
- popup 上的版本顯示一律讀 `chrome.runtime.getManifest().version`，不要另外寫死。
- 改完要提醒使用者：到 `chrome://extensions` 重新載入 extension，並重新整理目標分頁，content script 才會更新。
