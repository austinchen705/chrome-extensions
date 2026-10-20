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
- 指令裡單獨的 `<enter>` 由 `timer-settings.js` 的 `commandText` 轉成空字串，`sendCommand` 才送出空白行（遊戲收到空字串送純換行＝Enter）；各欄位會濾掉空白指令，所以要用文字代號，新增送指令的入口要走 `sendCommand`。
- `sendCommand` 代送指令後要還原使用者正在輸入的文字（遊戲送出後會清空或全選輸入框）。

## 巨集備註

- `macro-notes.js` 在遊戲巨集視窗每一列最後多放一個 `input.note`，備註存在 `chrome.storage.local.macroNotes`（綁列號 1～90），樣式在 `macro-notes.css`（manifest 的 `content_scripts[].css`；popup 的備援注入要 `insertCSS`）。備註框一定要放在指令框**後面**：遊戲的 `on_macro_key_down` 讀的是按鍵框的 `nextSibling`（指令框）。
- 遊戲自己的樣式表比 extension 的樣式晚載入，優先權相同會被它蓋掉（`#macro_table { width: 435px }`），所以樣式要加一層 `body`。jsdom 測不出這種問題，樣式相關的改動要用真實頁面驗證。
- `storage.onChanged` 在「寫入的那個頁面」也會觸發，所以寫入時一起存 `macroNotesWriter`（本頁的隨機代號），收到自己寫的通知要忽略，否則會用舊內容蓋掉還沒存的編輯（測試 21a 會擋）。

## 警報提示音

- 驗證碼警報的響鈴有兩種模式，由 popup 的開關 `persistentAlert`（`chrome.storage.local`，預設 false）決定，`content.js` 啟動時讀取並監聽 `storage.onChanged`，改了馬上生效。關閉＝原本的行為（最多 5 分鐘、互動或按開始就停）；開啟＝`ringing` 為 true，只有 `confirmAlert()`（面板「確認」、通知上的按鈕送來的 `CONFIRM_ALERT`）能停。
- 判斷「互動或按開始要不要停提示音」都看 `ringing`（`flashTitle` 的 `clear`、`armDetection`），新增會停提示音的路徑也要遵守；只有 `stopAndAlert`（驗證碼）會進 `ringing`，`alertOnly`（規則被停用）永遠只響一次。

## 怪物查詢

- 怪物、無名物品（含裝備比較）、解謎三組功能有開關，存在 `chrome.storage.local.zapFeatures`（`{ mobs, items, riddles }`，缺值＝關閉，預設全關）；`content.js` 的 `applyZapFeatures` 呼叫各 UI 的 `setEnabled`：關掉就隱藏列、清掉浮層區段、觀察器不再處理文字（`zap-panel.js` 的怪物／鑑定共用一個觀察器，各自看自己的開關）。新增這類功能要接同一個開關。

- 資料是 `catworld-auto-command/zap-data.json`，由 `node tools/gen-zap-data.js` 從 zap 攻略站（`ot1.htm`）與 catworld 說明站（`help/newstart.3`）產生，加上 `tools/zap-overrides.json`（手動補充，優先於網站）；不要手改。解析與合併邏輯在 `tools/zap-parse.js`，來源解析出的筆數異常少時產生腳本會失敗、不覆寫。
- `zap-mobs.js` 不碰 DOM，content script、background、popup、測試共用：manifest、popup.html、popup 的備援注入（`files` 清單）都要載入它，且在 `zap-panel.js`、`content.js` 之前；漏了備援注入的清單，`content.js` 會因為找不到 `CatworldZapPanel` 而出錯。
- 資料只在 background 第一次被問到時載入（`ZAP_LOOKUP`、`ZAP_SUITABLE`），不隨每個遊戲分頁載入。分級看 `q = 強度 × 2 ÷ #exp`，門檻存在 `chrome.storage.local.zapThresholds`。
- 怪物出現提示（`zap-panel.js`）自己觀察 `#content` 新增的文字、略過浮動視窗，與 `active()` 無關；怪物行是 `※名稱(ID) <戰鬥中> [fight][kill]`（`<…>` 狀態不一定有，解析時去掉），比對鍵是完整名稱（不分大小寫、忽略所有空白），同名多隻不猜、全部列出。遊戲把一行拆成多個節點（`※`、稱號、名稱各在自己的 `<span>`），所以新增節點的文字要直接相接（`textFromAdded`），不能用換行連接。UI 放在面板 shadow DOM 內，搜尋框要擋掉 `mousedown` 與按鍵事件的冒泡。
- 怪物位置對「總路徑」表（`zap-data.json` 的 `routes`，由 `tools/zap-parse.js` 的 `parseRoutesHtml` 從 `help/map.15` 解析）在 `zap-mobs.js` 的 `routeFor`：完全同名優先，否則只接受「一方以另一方開頭」（天魔塔2f↔天魔塔），地名夾在別的字中間不猜（往黑木崖渡口、金礦坑南方小鎮）；「走過去」只能走 `startMacro`（`startSteps`），指令是 `routeCommand`＝`run e 5n 2o <路線>`，不自動 `recall`。對不上的地點可在 `tools/zap-route-aliases.json` 補別名（產生資料時併入 `routeAliases`，指向不存在的路線名會讓產生腳本失敗），別名命中一律當約略對應。要自己指定整段指令的寫在 `tools/zap-route-commands.json`（`locations` 以位置為名、`mobs` 以怪物全名為名），產生資料時當成帶 `command` 的路線併進 `routes`，`mobs` 的項目帶 `mob:true`（`routeFor` 比對位置時要略過，`routeForMob` 先找單隻怪物的指令；`routeCommand` 優先用 `command`，不加 `run e 5n 2o`）。指定的怪物不在資料裡時產生腳本會失敗。
- 測試：`npm test`（`node --test`，Node 18 以上；不要寫成 `node --test tests/`，新版 Node 會把資料夾當檔案）。介面測試（`tests/zap-equipment-ui.test.js`、`tests/zap-route-ui.test.js`）需要 jsdom（devDependency，`npm install`），沒裝會自動跳過；測試裡把介面的等待時間縮小 `SCALE` 倍。

## 裝備比較

- `zap-equipment.js` 不碰 DOM（解析、屬性正規化與計分、比較、基準存放、穿著清單解析、鑑定追蹤器）。「此物名曰」區塊的欄位標籤中間有空白，不認得的行（文字圖案、`特殊物品非無名裝備…`、`共鑑定…`）一律略過；改解析要用 `tests/fixtures/equipment/` 的真實樣本驗證。
- 比較規則與權重集中在 `zap-equipment.js`（`PRIMARY_GAP`、`IGNORED_ATTRS`、相關屬性別名）：同類別才比、同類別多件時和最弱的比、主要數值相差 `PRIMARY_GAP` 以上以高者為準、否則比屬性分數。
- 追蹤器把「你想請…鑑定所有無名物」到「共鑑定…樣無名物」之間的區塊當候選，之外的區塊只用來更新基準（名稱必須是穿著名單內唯一一件）；區塊可能跨封包，所以新增文字先緩衝，靜止 `FLUSH_MS` 後才 `flush`（連續輸出最多延後 `FLUSH_MAX_WAIT_MS`）。開始／結束句也可能被切在兩個封包之間，追蹤器保留上一批最後 40 個字一起比對；結束句一直沒來時超過逾時就關閉這次鑑定，之後的區塊算被動更新。基準依角色分開存（`wornEquipment: { [角色]: Store }`，角色取分頁標題「角色名 - …」），讀取目前穿著用 `mergeBaseline`（沒回應但還在穿的保留舊的、已經沒穿的丟掉），不能整份換掉。
- 「讀取目前穿著」只能走 `startMacro`（`zap-equipment-ui.js` 的 `deps.startSteps`）：先送 `i`，從穿著行（`ˇ` 標記與同一行的 `view #編號`，需要 DOM 節點的 HTML，不是只有文字）拿到編號，再送 `view` 巨集；鑑定每次都不送指令。UI 借用 `zap-panel.js` 回傳的浮層區段與計時；失敗（沒讀到背包、指令被拒、解析不到）都要顯示原因。

## 無名物品

- 資料是 `zap-data.json` 的 `items`，由 `tools/gen-zap-data.js` 從 `ub.htm` 解析（`tools/zap-parse.js` 的 `parseUnknownObjectHtml`）。`ub.htm` 有三張表，LV 在帶 `rowspan` 的儲存格往下列沿用：第 1 張只有名稱、第 2 張是名稱＋功能、第 3 張是名稱＋武器效果＋防具效果；解析結果少於 30 筆時產生腳本會失敗、不覆寫。
- `zap-items.js` 不碰 DOM，與 `zap-mobs.js` 一樣要同時加進 manifest、popup.html、popup 備援注入的 `files`，且在 `zap-panel.js` 之前。background 的 `ZAP_ITEM` 與怪物查詢共用同一份懶載入資料。
- 鑑定句只在先看到「你拿著…給衰老頭看了一下」（60 秒內，狀態 `handState` 在 `zap-panel.js`）後才處理 `衰老頭給你<量詞><名稱>。`；比對鍵去掉括號與空白、同鍵多筆全列；建議：相關武器類型（`chrome.storage.local.mainWeapon`）→ 適合你，其餘 LV3 以上留著、LV1～2 賣掉。鑑定後的裝備（「此物名曰」區塊）不處理。
- 比對先用帶洞數的完整名稱，沒命中才用去括號的鍵；名稱必須出現在句子結尾、前面只能是「數詞加至多一個量詞字」（`QUANTIFIER`），否則短名稱會誤配表上沒有的物品。`tools/zap-overrides.json` 帶 `item` 欄位的項目是物品補充（`applyItemOverrides`），其餘是怪物補充。
- 鑑定結果在浮層裡是**累積**的（接在舊結果後面、最多留 8 筆，`addItemResults`），怪物提示則每次整個取代；「提示過」要等查詢成功才記，失敗不能讓同一件被擋 10 秒。
- 查詢失敗不能靜默：背景回 `ok:false` 或 `sendMessage` 丟例外（例如 extension 剛重新載入、頁面還是舊的 content script）都要把原因顯示在浮層（`showFailure`／`addItemNote`），並提示重新整理遊戲頁；雜物鑑定另外在「偵測到交給衰老頭／偵測到鑑定結果」時先顯示小字，沒反應時才分得出是偵測沒動還是查詢失敗。
- 浮層由怪物、雜物鑑定、裝備比較共用，各一個區段、各自的停留時間（`zap-panel.js` 的 `SECTION_MS`：怪物 5 秒、雜物 15 秒、裝備 20 秒），全部區段都空了才隱藏，右上角 ✕ 全部關掉；觀察器每一批新增文字同時交給兩邊，不能因為其中一邊沒內容就跳過另一邊。

## 解謎

- 資料是 `zap-data.json` 的 `riddles`（總表）與 `pages`（步驟頁），由 `tools/zap-parse.js` 產生：總表沒有連結，靠選單名稱對應（`RIDDLE_ALIASES` 列出 6 個對不上的別名），共用頁面（玉蕭劍法／彈指神通／糖果等）整頁共用步驟；總表少於 40 個謎時產生腳本失敗、不覆寫。
- 步驟的指令抽取是保守的（`extractCommands`／`recognizeSegment`）：一步只要有任何一段不認得就整步為空，不給只有一半的指令。「不認得」包含：段首不是 `VERBS`（從真實頁面統計的動詞白名單）或方向；指令本身又出現別的動詞（兩個指令黏在一起，例如 `run … n give woman letter`）；指令後面的說明裡還有動詞、方向或 `about`（代表有東西被丟掉）；中文引數只在 `ask … about`、`buy/say/search/push/touch` 後面才算，其他動詞後面的中文是說明；`ps.` 以後都是說明。改規則要用真實頁面（唐門 `qu3-2` 第 7 步、`qu2-4` 第 3 步）驗證。
- 共用頁（同一頁有好幾個謎）用 `sectionSteps` 依步驟的 `heading` 分段，只顯示被點的謎自己的那一段；認不出分段就回傳整頁（寧可多顯示），步驟序號仍是該頁的位置（編輯與儲存用）。`startsAtInn` 判斷路徑是不是從醉仙樓出發（只認 `run e 5n o`／`2o` 開頭）。
- `parseRiddlePage` 另外輸出 `preamble`（第一步之前的文字）與步驟的 `heading`（「入古墓：」「男：」這類小標題或標籤，不接到上一步）；UI 兩者都要顯示。
- `zap-riddles.js` 不碰 DOM，要同時加進 manifest 與 popup 備援注入、且在 `zap-panel.js`／`zap-riddle-ui.js` 之前。條件分組：未達優先於需自行確認；讀不到的狀態要傳 `NaN`（不是 0，0 會被當成「不夠」）。
- 「送出」只能走 `content.js` 的 `startMacro`（`zap-riddle-ui.js` 的 `deps.startSteps`）：這樣才算 `active()`、驗證碼時被 `cancelMacros` 取消；不要另造送出通道、也不要直接操作 `#input`。
- 補的指令存在 `chrome.storage.local.riddleCommands`，以「頁面檔名＋步驟在該頁的位置」為鍵並逐步記錄存檔當時的步驟數（`ns`，舊資料用整頁的 `n`；不用頁面印的編號，共用頁會重新編號）；「步驟已變動」逐步判斷，改一步不能讓其他補過的步驟的警告消失。匯入先驗證形狀，不合法不能動既有資料；`storage.onChanged` 要同步另一個分頁的改動，否則會用舊資料蓋掉對方。`startMacro` 回傳是否真的啟動（格式錯誤回 `false`），UI 據此決定說不說「已送出」。UI 在 shadow DOM 內，輸入框要擋掉冒泡。

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
