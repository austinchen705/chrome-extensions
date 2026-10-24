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

## 孤兒程式與重複面板

- 擴充功能在 `chrome://extensions` 重新載入後，遊戲分頁沒重新整理的話，**舊版 content script 還留在頁面上**（連不上擴充功能的「孤兒」）：它的面板、計時器、送指令的佇列都還活著；而設定頁在 `sendMessage` 收到 `Receiving end does not exist` 時會備援注入一份新的（`popup.js`），新的隔離環境看不到舊的防重複旗標，所以頁面上會有兩個面板、兩份程式同時送指令，驗證碼也可能停不下來（`chrome.runtime.sendMessage` 在孤兒裡會直接丟例外）。
- 對策在 `instance-guard.js`（manifest 與 popup 備援注入都要載入、在 `content.js` 之前）：`contextAlive(chrome)` 看 `chrome.runtime.id` 還在不在，`content.js` 在 `sendCommand`、`renderPanel`、驗證碼觀察器三處檢查，失效就 `retire()`（停掉計時器、觸發與巨集、清佇列、斷開觀察器、關置頂視窗、拿掉面板）；新程式 `initPanel` 一開始 `removeStalePanels` 把殘留的面板（`data-catworld-panel`）與置頂提示條拿掉並關掉殘留的置頂視窗。`stopAndAlert`、`alertOnly` 送通知一律包 try/catch：**停止絕對不能因為通知送不出去而被跳過**。新增會送指令的入口要走 `sendCommand`（已有檢查）。
- 測試：`tests/content-instance.test.js` 在 jsdom 載入整個 content script（manifest 列的所有檔案、假的 `chrome`）；底座要等啟動時的非同步初始化跑完才操作、結束時清掉頁面的計時器（視窗不能 `close()`）。三個檢查入口彼此冗餘，拿掉單一個不會讓測試失敗，這是刻意的雙重保護。

## 驗證碼圖形偵測

- 偵測規則在 `captcha-art.js`（`artText`、`looksLikeAsciiArt`、`looksLikeNoiseCaptcha`、`createWatcher`；content script 與測試共用，manifest 與 popup 的備援注入都要載入、且在 `content.js` 之前）。偵測規則都是看「連續好幾行」，而遊戲輸出常分成好幾批新增文字到達（一張圖可能被切成一行一批），所以 `content.js` 的 `captchaObserver` 不能只看單一批：一律經 `artWatcher.feed`（把最近 5 秒的新增文字接在一起、最多 120 行，偵測到就清空；`armDetection` 重新開始時也清）。
- 診斷：驗證碼偵測沒反應時看遊戲頁 console（篩 `[catworld]`）：`疑似驗證碼的批次`（有在跑，印這一批的行數、長行數、背景色標記數與是否偵測到）、`看到疑似驗證碼，但定時、觸發、巨集都沒有在跑`（沒功能在跑本來就不偵測，每 5 秒最多印一次）。不要為了這個把規則放寬到會誤判一般輸出。
- 測試：`tests/captcha-art.test.js`（jsdom，用 `tests/fixtures/captcha/` 的真實樣本：英數亂碼塊、B3 背景空白拼的數字圖、一般輸出；分批大小 1～4 行都要抓到、一般輸出逐行餵也不能誤判、隔太久的片段不能接在一起）。新增驗證碼樣式時先把真實輸出放進 fixtures 再改偵測。

## 定時分頁的隨機指令

- 設定格式是 `settings.randomItems: [{ command, minSeconds, maxSeconds }]`，轉換與抽選在 `timer-settings.js`（content script 與 popup 共用，manifest、popup.html、popup 的備援注入都要載入，且要在 `content.js` 之前）。
- 舊格式（`randomCommands` + `randomMinSeconds` / `randomMaxSeconds`）由 `normalizeRandomItems` 轉換；**不能在 `content.js` 的預設設定裡放 `randomItems`**，否則空陣列會蓋掉升級前存下的舊設定（測試 14i、15i 會擋）。

## 遊戲巨集的 @等待

- 遊戲的巨集是 `command.split(/\s*;\s*/)` 同步全送，沒辦法在遊戲裡加等待。`macro-wait.js`（不碰 DOM 以外的東西）負責鍵值、解析、讀 `#macro_list`；`content.js` 在 `window` 捕獲階段攔下「有 `@等待` 的巨集」自己跑，其餘交給遊戲。manifest、popup 的備援注入都要載入 `macro-wait.js`，且在 `content.js` 之前。
- `macro-wait.js` 的 `KEY_VALUES` 抄自遊戲 `web.js` 的 `key_values`，攔截條件（只在目標是 `#input` 或 `body`）也和遊戲 `document.body.onkeydown` 一致；遊戲改了這兩處要同步（測試會逐項比對 `web.js`）。
- 巨集的指令走共用佇列（`source: 'macro'`），執行中算 `active()`；一個巨集要等最後一個指令真的送出才從 `macroRuns` 移除，否則最後一個指令還在排隊時 `active()` 會變 false 而送不出去。新增會送指令的功能要接 `stopEverything`（驗證碼時一起取消）。
- 指令裡單獨的 `<enter>` 由 `timer-settings.js` 的 `commandText` 轉成空字串，`sendCommand` 才送出空白行（遊戲收到空字串送純換行＝Enter）；各欄位會濾掉空白指令，所以要用文字代號，新增送指令的入口要走 `sendCommand`。定時（固定、隨機）與觸發的指令經 `content.js` 的 `queueCommand`：含 `;` 或 `@等待`（`CatworldMacro.isSequence`）就交給 `startMacro` 拆開依序送，否則直接排進佇列；巨集記下 `owner`（`timer` 或 `trigger:<組>`），停止定時或該組觸發時只取消自己的（`cancelMacros(owner)`），驗證碼與停止一切才全部取消。新增會送指令的入口要走 `queueCommand`，不要直接 `enqueue` 欄位內容。
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
- 怪物位置對「總路徑」表（`zap-data.json` 的 `routes`，由 `tools/zap-parse.js` 的 `parseRoutesHtml` 從 `help/map.15` 解析）在 `zap-mobs.js` 的 `routeFor`：完全同名優先，否則只接受「一方以另一方開頭」（天魔塔2f↔天魔塔），地名夾在別的字中間不猜（例如「往黑木崖渡口」不會自動對到黑木崖，要靠別名）；「走過去」只能走 `startMacro`（`startSteps`），指令是 `routeCommand`＝`run e 5n 2o <路線>`，不自動 `recall`。對不上的地點可在 `tools/zap-route-aliases.json` 補別名（產生資料時併入 `routeAliases`，指向不存在的路線名會讓產生腳本失敗），別名命中一律當約略對應。使用者在面板補的路線存在 `chrome.storage.local.mobRoutes`（`customKey` 化的怪物名稱 → 指令），由 `zap-mobs.js` 的 `applyCustomRoute`／`setCustomRoute`／`parseCustomRoutes` 處理，優先於所有內建路線；編輯只放在清單（浮層會消失），編輯按鈕的 click 要擋住不傳給遊戲（否則游標被搶回遊戲輸入框、編輯框打不了字），匯入先驗證形狀。內建的整段指令寫在 `tools/zap-route-commands.json`（`locations` 以位置為名、`mobs` 以怪物全名為名），產生資料時當成帶 `command` 的路線併進 `routes`，`mobs` 的項目帶 `mob:true`（`routeFor` 比對位置時要略過，`routeForMob` 先找單隻怪物的指令；`routeCommand` 優先用 `command`，不加 `run e 5n 2o`）。指定的怪物不在資料裡時產生腳本會失敗。
- 測試：`npm test`（`node --test`，Node 18 以上；不要寫成 `node --test tests/`，新版 Node 會把資料夾當檔案）。介面測試（`tests/zap-equipment-ui.test.js`、`tests/zap-route-ui.test.js`）需要 jsdom（devDependency，`npm install`），沒裝會自動跳過；測試裡把介面的等待時間縮小 `SCALE` 倍。

## 裝備比較

- `zap-equipment.js` 不碰 DOM（解析、屬性正規化與計分、比較、基準存放、穿著清單解析、鑑定追蹤器）。「此物名曰」區塊的欄位標籤中間有空白，不認得的行（文字圖案、`特殊物品非無名裝備…`、`共鑑定…`）一律略過；改解析要用 `tests/fixtures/equipment/` 的真實樣本驗證。
- 比較規則與權重集中在 `zap-equipment.js`（`PRIMARY_GAP`、`PRIMARY_WEIGHT`、`IGNORED_ATTRS`、`ALWAYS_RELATED`、相關屬性別名）：同類別才比、同類別多件時和最弱的比；主要數值相差不到 `PRIMARY_GAP` 只比屬性分數，相差 `PRIMARY_GAP` 以上則把差距乘 `PRIMARY_WEIGHT` 加上屬性分數差，總分大於 0 才算好（主要數值少一點、屬性補得回來也推薦，理由帶「屬性補回」）；`攻擊`、`輔助氣恢復`、`內功` 對任何人都算相關屬性，劍＝劍術、刀＝刀法、拳套＝拳術是使用者指定的名稱。
- 追蹤器把「你想請…鑑定所有無名物」到「共鑑定…樣無名物」之間的區塊當候選，之外的區塊只用來更新基準（名稱必須是穿著名單內唯一一件）；區塊可能跨封包，所以新增文字先緩衝，靜止 `FLUSH_MS` 後才 `flush`（連續輸出最多延後 `FLUSH_MAX_WAIT_MS`）。開始／結束句也可能被切在兩個封包之間，追蹤器保留上一批最後 40 個字一起比對；結束句一直沒來時超過逾時就關閉這次鑑定，之後的區塊算被動更新。基準依角色分開存（`wornEquipment: { [角色]: Store }`，角色取分頁標題「角色名 - …」），讀取目前穿著用 `mergeBaseline`（沒回應但還在穿的保留舊的、已經沒穿的丟掉），不能整份換掉。
- 鑑定結果在浮層裡依判斷排序（`VERDICT_RANK`：好、相當、沒基準、差，同級照來的順序，每件插進該級最後面），最多 `RESULT_MAX` 件，超過時移掉最差一級裡最舊的；`blocks` 只依來的順序存，顯示順序每次從 `rank` 重算。
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

## 開發流程

新功能或較大的改動固定照這個順序走，每一步用對應的 skill，步驟之間的結果都要經過使用者確認；小修正（改字、單點 bug）可以直接做，不必走全程：

1. `/grill-me`：一輪一輪訪談把想法釐清，使用者確認「已有共識」才往下。
2. `/to-spec`：把共識整理成規格，不再訪談；先跟使用者確認測試接縫（盡量只用一個、用最高層）。規格放 `.scratch/<功能>/spec.md`。
3. `/to-tickets`：把規格切成垂直切片的票，標明誰擋住誰，使用者批准後寫成 `.scratch/<功能>/issues/<NN>-<名稱>.md`。
4. `/implement`：依票實作，盡量 TDD；常跑單檔測試，最後跑一次 `npm test`；完成後自動進 `/code-review`；commit 到目前分支。
5. `/code-review`：以固定點（分支或 commit）到 HEAD 做兩軸審查（Standards、Spec），兩份報告分開看，由使用者決定哪些要修。

- 這套取代 superpowers 的 brainstorming／writing-plans／executing-plans，兩套不混用，規格只留一份。
- 專案其他規則仍然優先：改了 extension 的任何檔案都要升 `manifest.json` 版本並在 `CHANGELOG.md` 加一筆；commit 之後要不要 push 一律先問使用者。
- 這些 skill 只能由使用者用 `/名稱` 觸發；使用者要先跑過一次 `/setup-matt-pocock-skills`，沒有 `docs/agents/` 時 `/to-spec`、`/to-tickets`、`/code-review` 會要求先設定。

## 手機通知（LINE）

- 所有警報都走同一個出口（現在有驗證碼、看門狗、規則被停用；之後新增的警報也要走這裡）：content script 送 `ALERT`，background 建系統通知，**同時**呼叫 `notifyLine`（先啟動它，再建系統通知，這樣系統通知同步丟錯也不會連帶丟掉手機通知；LINE 失敗也不能影響系統通知）。新增警報只要照舊送 `ALERT`，不要另開推播出口。
- 判斷邏輯在 `line-notify.js`（不碰 DOM、不碰 `chrome.*`，`fetch` 與時間由呼叫端注入）：總開關開著且 token 與 userId 都有填才算要發；再依去重（同原因 N 分鐘內只推一次）與滾動一小時的上限決定發或略過，被略過的累計在 `skipped`；開關關閉不算略過。去重紀錄放 `chrome.storage.session` 的 `lineThrottle`，最近一次結果放 `lineLastResult`（帶 `source`：test 或 alert）；兩則警報要排隊依序讀寫紀錄，否則會同時讀到舊紀錄；紀錄在請求送出**前**就存（worker 在請求途中被回收也記得）、發送失敗再還原（失敗不佔用視窗與額度）；請求有 15 秒逾時，不然一個掛住的請求會讓後面所有警報永遠排不出去；設定值有上限（去重最多 1440 分鐘、每小時最多 100 則）、每個原因的記憶鍵數有上限、時間在未來的紀錄（時鐘往回調）會被丟掉。「發送測試訊息」只在設定頁，不受開關、去重、上限影響也不計數，只接受擴充功能自己的頁面（設定頁是開成分頁的，所以看 `sender.id` 與 `sender.url`，不能看 `sender.tab`）。
- **token 與 userId 是機密**：只存 `chrome.storage.local.lineNotify`（不用 `storage.sync`、不進任何匯出）。`storage.local` 預設 content script 也讀得到，而且 `storage.onChanged` 會把新值送給每個監聽者，所以**任何 content script 都不得讀取、監聽或印出它**（`tests/line-notify.test.js` 的守門測試會擋）；結果、錯誤訊息、console 都不得出現 token 與 userId，`send` 會把它們從回應與網路錯誤文字中遮掉。設定頁載入完成前欄位停用，載入失敗維持停用，否則打字會蓋掉已存的憑證。
- 測試分三個接縫：`tests/line-notify.test.js`（核心模組，假 `fetch`、假時鐘）、`tests/line-notify-ui.test.js`（設定頁 jsdom）、`tests/line-background.test.js`（在 vm 裡實際執行 `background.js`，假 `chrome` 與 `fetch`，檢查發了幾次請求、系統通知有沒有建、`storage.session` 存了什麼）。改 background 的警報處理要在最後一個檔案補行為測試，不要只比對原始碼文字。

## 共用資料

- 怪物路線有三層：個人（`chrome.storage.local.mobRoutes`）> 共用（Google 試算表發布的 CSV）> 內建。共用層的解析、白名單、連結檢查在 `shared-data.js`（不碰 DOM、不碰 `chrome.*`；background 與設定頁載入，**content script 不載入它**）。鍵一律用 `CatworldZapMobs.customKey`，和個人層同一個函式，否則個人層蓋不掉共用層。
- 抓取與快取只在 `background.js`（`refreshShared`）：連結在 `chrome.storage.local.sharedSources`（`{ mob, riddle }`，只存本機、不進匯出；設定頁存一個連結時要和另一個合併，不能整份覆蓋），快取在 `sharedCache`（含最近一次失敗的原因）；一小時內不重抓、失敗後 5 分鐘內不重試、連結改了丟掉舊快取、怪物查詢與解謎都關著不抓、請求 15 秒逾時；「立即更新」（`SHARED_REFRESH`）只接受擴充功能自己的頁面。查詢回覆（`ZAP_LOOKUP`／`ZAP_SUITABLE`）在 background 用 `overlayReply` 疊上共用路線並帶 `shared: { by, note }`，面板只負責顯示，個人層在面板端再蓋過去。
- 怪物路線分頁欄位是 `怪物名稱 | 位置（選填） | 強度（選填） | 指令 | 備註 | 更新者 | 更新時間`（強度欄的用法見下面「共用表新增怪物」「共用表修正內建怪強度」；沒有強度欄的舊表照常可用，欄位依標題文字找、不看位置），主鍵是「名稱」或「名稱|位置」（同名的怪常在不同地方，名稱不是唯一的；位置整串或其中一個地點相符就算，有填位置的列先比、沒有才用沒填位置的列；「位置挑不到怪」的列（位置不屬於任何同名的怪、內建怪本來就沒有位置、共用表新怪自己填的位置也只是標籤），`buildMobRoutes` 的 `collapseToName` 當成沒填位置，以名稱鍵放進共用層、輸給真正沒填位置的列，這種列之間取最新的；位置挑不到怪的仍列在 `unmatched`（原因寫「已改用名稱套用」），內建怪沒有位置的則不列；位置挑得到某隻怪（含共用表新怪）的列只給那個位置的怪，不會被同名的其他怪借用；內建怪沒有位置時，有填位置又有強度的列也不算新怪；程式並不知道怪實際在哪裡，位置只是文字比對）；同名且同位置的怪（約 5 組）分不開，這是資料本身的限制。指令欄寫 `停用`（要整個詞）代表這隻怪不要路線：查詢回覆的路線變 null、帶 `sharedDisabled: { by, note }`，面板顯示「共用（更新者）已停用路線」，個人層仍能蓋過；共用表只能新增、修改、刪列，刪列只會退回內建，要隱藏內建路線就要用 `停用`。
- 解謎指令分頁欄位是 `謎名稱 | 步驟 | 指令 | 備註 | 更新者 | 更新時間 | 步驟數（選填）`：「步驟」欄是「這個謎的第幾步」（面板每個步驟旁標「共用表步驟欄填：N」，從 1 起算、一定唯一；**不能用頁面印的 `no`**，19 個謎的印的編號會重複），對到該謎自己那一段（`sectionSteps`）的第 N 個步驟，換算成步驟在該頁的位置當鍵；共用層是 `steps: { 頁面檔名: { 位置: 項目 } }`，存在 `sharedCache.riddle`。謎或步驟對不到的列沒有位置可放，只列在報告（不進共用層）。`zap-riddles.js` 的 `effectiveStep(page, index, edits, file, shared)` 的優先順序是個人補的 > 共用 > 網站（共用寫 `停用` 的步驟沒有指令、也不採用網站的）；步驟數有填且和現在不同才標「步驟已變動」。面板每次打開解謎清單時用 `ZAP_RIDDLE_SHARED` 要共用步驟（背景一小時內不重抓）。
- 共用表新增怪物與修正強度的資料流：`shared-data.js` 的 `buildMobRoutes` 從 CSV 產生共用層（`routes`、`mobs`、`fixes`）與報告，存進 `sharedCache.mob`；`applySharedMobs` 是併進怪物表的純函式；`background.js` 先併再算 `ZAP_LOOKUP`／`ZAP_SUITABLE`、最後 `overlayReply` 疊路線，面板不需要知道共用表。使用者面向的說明（強度寫法、括號 ID 的原因、備註用法、風險）寫在 README「新增怪物、修正強度」，改規則要一起改，`tests/shared-data.test.js` 會對照 README 的標題列與強度寫法。
- 共用表新增怪物：怪物路線分頁多一個選填的「強度」欄。有填強度、而且名稱＋位置不在**內建**怪物資料裡的列＝新怪（`buildMobRoutes` 回傳的 `mobs`，鍵和路線一樣是名稱或名稱|位置）：名稱必須是 `稱號 名稱(ID)`（怪物出現提示靠遊戲輸出的 `※名稱(ID)` 比對，缺括號 ID 的新怪認不出來）、強度走 `parseStrength`（純數字、`N萬`、`NW`、`1W5`，1 到 1 億），不合法整列丟掉並寫原因（被丟掉的列路線與新怪都不留）；新怪可以沒有指令；沒填強度又不在內建資料的列維持「對不到」（打錯字的偵測要留著）。`applySharedMobs` 把新怪併進內建怪物表（回傳新陣列、不改輸入、內建後來已有同一隻就以內建為準），background 先併再算 `ZAP_LOOKUP`／`ZAP_SUITABLE`，所以清單、搜尋、分級、出現提示都一致；怪物的 `source: 'shared'` 與 `by` 讓 `metaText` 標「共用新增（更新者）」。快取（`sharedCache.mob`）多一個 `mobs` 欄位，舊快取沒有時視為沒有新怪。
- 同一個鍵（名稱或名稱|位置）在共用表有多列時，路線（`best`）、新怪（`bestMob`）、修正強度（`bestFix`）**各自取最新**：路線取最新有指令的列、強度取最新有強度的列，所以後來只改路線的列不會讓前面定義的新怪或強度消失，反之亦然；更新時間讀不到的列當最舊、時間相同取表上較後面的；被丟掉的列（白名單、格式、強度規則）不參與，不會遮住較舊的合法列。共用層每次抓取整份重算，**刪掉某一列＝撤銷它的貢獻**（新怪消失、修正還原成內建強度）；指令寫 `停用` 對新怪只是沒有路線，怪仍在。對應測試在 `tests/shared-data.test.js`（各欄取最新、無時間、時間相同、丟掉的列不參與、刪列）與 `tests/shared-background.test.js`（兩次抓取之間刪列）。
- 共用表修正內建怪強度：有填強度、名稱＋位置**對得上內建怪**的列＝修正強度（`buildMobRoutes` 回傳的 `fixes`，鍵同路線）：強度驗證與新怪相同，不合法整列丟掉（路線也不留）；只改強度，名稱、ID、位置、怪物備註都不動，這一列的備註只當路線備註；位置留空時同名的內建怪都修正，有填時整串或其中一個地點相符才修正，內建怪沒有位置時位置不挑（`looseFix`，輸給真正沒填位置的列）；`applySharedMobs(mobs, shared, fixes)` 先修正再併新怪，被修正的怪帶 `fixed: { by, original }`，`metaText` 標「共用修正強度（更新者）　內建原值 N」（原值未知寫「內建原值未知」；內建怪的來源不一定是 zap 站，所以不寫死站名），分級用修正後的強度；共用層比對怪用 `entryFor`（路線、修正共用同一套位置規則），位置挑不到怪時退回名稱的邏輯在 `collapseToName`（路線與修正共用）。快取（`sharedCache.mob`）的 `mobs`、`fixes` 欄位，舊快取沒有時視為沒有。
- 報告（`report`）：`rows`（有資料的列數）、`used`、`created`／`fixed`（怪物路線分頁才有：共用表新增的怪數、修正強度的怪數，設定頁摘要「生效 N 隻，新增 A 隻、修正強度 B 隻，丟掉…」只在大於 0 時寫，舊快取沒有這兩個數字視為 0，解謎摘要不受影響）、`dropped: [{row, reason}]`、`unmatched: [{row, name, location?, step?, reason}]`、`overflow`／`overflowFrom`。每個分頁最多讀前 `MAX_ROWS`（2000）列，其餘不讀只計入 `overflow`。設定頁用 `reportLines(report)` 逐列顯示（依列號排序，長清單截斷，**超過上限的提示永遠要顯示**）；怪物查詢與解謎都關著時 background 不抓，設定頁要說明，不然像壞掉；只開一個時兩份表都會抓，但沒勾那個功能對應的表面板用不到，`describeSheet` 的 `features`（`{ mobs, riddles }`）要讓那一份寫「沒勾，面板不會用到」。快取（`sharedCache`）一變，各分頁的怪物清單與解謎面板都要重新要一次（`storage.onChanged`），共用資料不存在 content script 裡。
- 共用來的指令只收白名單動詞（走路與互動類，清單在 `shared-data.js` 的 `ALLOWED_VERBS`）；個人層與內建層不受限。會轉移財物的 `give`、`buy`、`pay` 另外限制參數（`refuseArguments`：不收 `all`／`*`、`buy` 最多 20、`pay` 最多 100），這只擋得住明顯的亂填，擋不住看起來正常的 `give 某物 to 某人`，所以編輯者要限定互信的朋友。
- 預設連結：`shared-data.js` 的 `DEFAULT_SOURCES`（作者這群朋友的兩份表）。`background.js` 在 `onInstalled`（安裝、更新、重新載入）時，**只有 `sharedSources` 從來沒有被設定過（儲存裡沒有這個欄位）**才寫入預設值；設定頁清空會存成空字串，之後不會再帶入，自己填過的也不動。功能開關預設關閉，所以預設連結不會讓沒開功能的人連 Google。預設值要和 README「現在在用的共用表連結」一樣（測試會對照）。
- README「共用資料」一節和模組要一致，`tests/shared-data.test.js` 會對照：「允許的動詞」那一行要和 `ALLOWED_VERBS` 一樣（改清單要同步改 README），兩個標題列程式碼區塊要保留 Tab 且欄位位置解析器吃得進去。連結沒有 `gid=` 仍然收（單一分頁的表沒問題），但設定頁會提醒「讀到的是第一個分頁」。
- 任何儲存或網路問題都不能弄壞內建資料的查詢（`sharedLayer` 失敗回空的共用層）。
- 測試：`tests/shared-data.test.js`（CSV → 共用層與報告）、`tests/shared-background.test.js`（在記憶體裡執行 `background.js`，假 `chrome.storage.local` 與 `fetch`，檢查請求次數、快取、回覆）、`tests/zap-route-ui.test.js`（面板標示）、`tests/shared-settings-ui.test.js`（jsdom 載入真正的 popup.html 與 popup.js，假的 `chrome`，檢查設定頁結果行與逐列清單的文字和 `msg-error`／`msg-warn` 顏色）。範本檔在 `docs/templates/`（`shared-mobs.csv`、`shared-riddles.csv`，標題列要和 README 一致，測試會對照）。

## 巨集匯入匯出

- 遊戲把巨集存在頁面的 `localStorage.MACROS`（長度 90 的陣列，每格 0 或 `[按鍵值字串, 指令字串]`；來源是遊戲的 `/js/web.js`，遊戲頁 `/web` 對使用者可能回 403，但 `web.js` 讀得到）。遊戲用閉包裡的私有陣列管理巨集視窗，外部改輸入框值寫不進去，所以要改巨集只能直接寫 `localStorage.MACROS`，遊戲要重新整理才會重讀（而且重新整理前在遊戲視窗改任何巨集，遊戲會用記憶體裡的舊內容整份存回去、蓋掉寫入），不能靠模擬輸入事件。
- `macro-io.js` 不碰 DOM 與 `chrome.*`（`readMacros` 讀遊戲存的巨集一律回 90 格並帶 `status`：`ok`／`missing`／`damaged`，壞資料不丟例外，空字串遊戲也當作沒有；`exportText` 產生 `{ version, macros, notes }`，備註只收 1～90 列有字的文字；`parseImport` 檢查匯入文字，`countFilled` 數有內容的列），`macro-io-ui.js` 管面板「巨集」列的按鈕與訊息；兩個都要加進 manifest 的 content script 與 popup 備援注入的 `files`，在 `content.js` 之前。`content.js` 把 `localStorage` 與備註（`chrome.storage.local.macroNotes`）用 `deps.readRaw`、`deps.readNotes` 注入，初始化要包 try/catch，壞了不能牽連後面按鈕的綁定。
- 匯入檢查（`parseImport`，整份通過才回正規化的 90 格與備註，否則回說明哪裡不對的錯誤）：JSON 物件、`version` 是 1、`macros` 最多 90 格（少的補空格）、每格 0 或 `[按鍵值, 指令]` 兩段文字、按鍵值**可以是空字串**（遊戲真的會存「按鍵空、指令有字」，往返一定要能過）或 1～4095 的整數、指令最多 1000 字、兩列不能用同一個按鍵值（空的不算）、備註鍵 1～90 值最多 200 字（只有空白的略過）、不認得的欄位忽略，不套指令白名單（這是自己的巨集）。**按鍵值只檢查範圍，不保證按得出來**（遊戲真正能產生的組合比 1～4095 少，寫進按不出來的值不會弄壞遊戲，所以不收緊，也避免依賴 `macro-wait.js` 的按鍵表）。
- 備份與還原：確認匯入時，**先**用 `makeBackup(原始文字, 備註, 時間)` 把遊戲現在的巨集（原樣的字串，壞掉也原樣留，沒存過就留 90 個空格）與備註存進 `chrome.storage.local.macroBackup`（只留一層，匯入一次覆蓋上一份，不進匯出），**備份寫不進去就不匯入**（讀不到目前的巨集或備註就沒有完整的備份，同樣不匯入）；寫遊戲的 `localStorage.MACROS` 失敗時把**原本那份備份放回去**（新備份只是「現在的樣子」，匯入沒發生就不能讓它蓋掉舊備份），只有備註寫失敗時不放回（巨集已經換了，新備份才是回頭的路）；「還原上一份」按鈕在匯入框裡（面板「巨集」列寬度只有 310px，放不下第四顆按鈕），有備份才可按（壞掉的備份也讓它按得下去，按了才說明哪裡壞），讀回後走 `parseBackup` 檢查，壞掉（不是物件、巨集文字不見）就說明原因、什麼都不動；巨集文字本身遊戲讀不懂（`readMacros` 判 `damaged`）仍可還原（那是唯一的原樣備份，由玩家決定），但確認文字要先警告遊戲可能載入失敗（遊戲載入時 `JSON.parse(localStorage.MACROS)` 外面沒有 try/catch）；確認後用匯入同一條寫入路徑（`apply`：先 `localStorage.MACROS`、再備註）寫回，還原後備份保留。
- 匯入流程在 `macro-io-ui.js`（`attach` 拆成 `setupExport`、`setupImport`，訊息區是 `createMessage`；匯入與還原只有確認文字開頭、失敗與完成訊息、要不要先留備份、要不要清貼上框不同，集中在 `KINDS` 表，匯入前留備份在 `backupCurrent`）：貼文字 → `parseImport` → 通過才顯示確認（「將取代 N 列」與重新整理、403、蓋掉匯入、多分頁的警告）→ 確認後先寫遊戲的 `localStorage.MACROS`（寫不進去就停，什麼都沒動）再寫備註；備註用 `macroNotesWriter: 'macro-io'` 寫，**寫入者不能是備註模組自己的隨機代號**，備註模組才會把它當成別處的改動、直接更新畫面上的備註框（`storage.onChanged` 在寫入的那個頁面也會觸發，備註模組靠代號忽略自己的寫入）。待確認的檢查結果在貼的文字一改、收起匯入框或取消時作廢，確認鈕只套用「檢查當下」的結果，不重新解析。匯入的成功訊息與錯誤要一直留著（不自動收起），因為要提醒重新整理；匯出成功的訊息才會自動收起。檢查通過時要先收掉上一則訊息，免得舊的錯誤和確認框並存。
- 「巨集」列常駐顯示（按鈕在列上），狀態文字沒有巨集在跑時要清成空的；剪貼簿一律用按鈕所在 document 的視窗（面板可能在置頂浮窗），複製失敗要把文字放進可手動複製的框；文字框要擋掉 `mousedown`、`click` 與按鍵事件的冒泡。
- 測試：`tests/macro-io.test.js`（純函式，邊界案例都放這裡）、`tests/macro-io-ui.test.js`（jsdom 載入整個 content script，假的 `chrome`、`localStorage.MACROS` 與剪貼簿）；真實排版、遊戲重新整理後是否讀到新巨集只能在真實頁面驗證。

## 額外的遊戲網址（臨時網站）

- manifest 的 `content_scripts.matches` 是靜態的，只認遊戲網站；其他網站要用動態註冊。清單在 `chrome.storage.local.extraGameUrls`（match pattern 的陣列，每一項是整個主機 `https://主機/*`，**不帶 port**：Chrome 的 match pattern 不認 port），由設定頁的「額外的遊戲網址」管理。不要把某個臨時網址（尤其是 ngrok 這種含 IP 的）寫進 manifest 或程式、commit 進公開 repo。
- `game-urls.js`（純函式，不碰 DOM 與 `chrome.*`，設定頁與 background 載入，**content script 不載入**）：`parse` 把使用者貼的網址變成 pattern 並拒絕不合格的（非 http／https、帳號密碼、`*`、IPv6、內建遊戲網站、Chrome 不收的主機名稱如 `a..b`、`-x`、尾端的點：`hostOk`，不收的在問授權之前就擋下，因為 `permissions.request` 對無效的樣式會丟例外），`add`／`remove` 管清單（去重、最多 `MAX_EXTRA` 個、不改輸入），`isExtraPattern` 只相信這個功能自己產生的樣子（讀回儲存的值時一律過濾，免得儲存裡被放進 `<all_urls>` 之類的值就讓程式在每個網頁上執行），`isGameUrl`／`tabPatterns` 判斷與搜尋遊戲分頁（內建的 `https://catworld.muds.tw/web…` 加清單）。**程式裡任何「這個分頁是不是遊戲」的判斷都要走 `isGameUrl`，不要再寫死遊戲網址**。
- 權限：manifest 的 `optional_host_permissions`（`https://*/*`、`http://*/*`）只是「可以去問」，沒有使用者按「允許」extension 什麼都拿不到；`host_permissions` 不放任何廣泛的網址（測試會擋）。設定頁新增時：先檢查格式與重複（在記憶體裡的清單擋，授權詢問要在使用者按下去的當下問）→ `chrome.permissions.request` → 允許才寫進清單；移除時 `chrome.permissions.remove` 並從清單拿掉；授權被收回的網站標「未授權，不會生效」並提供「授權」按鈕；新增、授權、移除三個動作都包在 `guarded` 裡，Chrome 丟的例外要顯示成紅色訊息，不能讓使用者按了沒反應；移除時先還權限、成功才從清單拿掉。設定頁的 `extraSites`（畫面上的清單）是為了在授權詢問前只做同步檢查（詢問要在按下去的手勢裡），不要為了少一個變數改成先 await storage。
- `background.js` 的 `syncExtraGameSites` 把「清單裡而且已授權」的網站用 `chrome.scripting.registerContentScripts` 註冊成**和 manifest 同一份 js 與 css**（從 `getManifest().content_scripts[0]` 讀，不另外寫一份清單），先 `unregisterContentScripts` 再註冊（沒註冊過會丟例外，要吞掉）；載入時、`onInstalled`（擴充功能更新會清掉動態註冊的 script）、清單改變（`storage.onChanged`）、授權改變（`permissions.onAdded`／`onRemoved`）都同步，同步排成一條佇列（`extraSitesQueue`）一個接一個做，失敗只記 `console.error`、不影響之後的同步。已經開著的分頁要重新整理才會有面板。
- 測試：`tests/game-urls.test.js`（純函式）、`tests/extra-sites-background.test.js`（在記憶體裡執行 `background.js`，假的 `permissions`、`scripting`、`storage`）、`tests/extra-urls-ui.test.js`（jsdom 載入真正的設定頁）、`tests/injection-lists.test.js`（載入與權限的守門）。其他載入 `background.js` 的測試（`line-background`、`shared-background`、`zap-background`）的假 `chrome` 要有 `permissions`、`scripting`、`storage.onChanged`、`runtime.onInstalled`。**Chrome 真正的授權詢問與動態註冊的行為只能在真實瀏覽器驗證**。

## 巨集視窗調整大小

- 遊戲的巨集視窗（`#macro_table`）是 CSS 固定大小（寬 435、高 463，遊戲 `web.css`），遊戲完全沒有調整大小的機制；位置用 `right` 與 `top` 定位（右邊緣固定），只有標題列（`#macro_header`）能拖曳，拖曳邊界在按下滑鼠時才用 `offsetWidth`／`offsetHeight` 現算，所以改大小不會弄壞遊戲自己的拖曳。內層列表（`#macro_list_wrapper`）用固定的上下邊界加內部捲動，視窗變高時自然顯示更多列。
- `macro-resize.js`（和 `macro-notes.js` 一樣自成一體，要加進 manifest 的 content script 與 popup 備援注入的 `files`，在 `macro-io.js` 之後，因為夾限與檢查用 `CatworldMacroIO` 的 `clampWindowSize`、`sanitizeSize`、`MIN_WINDOW`）在 `#macro_table` 內加一個 `.macro-resize` 把手。**把手放在左下角，不是右下角**：視窗右邊緣固定，往左拖才是變寬，把手才會跟著滑鼠；放在右下角往右拖時右邊緣不動，視窗會往左長、把手離開滑鼠。拖曳時 `mousedown` 要 `preventDefault` 並 `stopPropagation`（不讓遊戲的 `onmousedown` 看到、不選到文字）。拖曳在放開滑鼠、頁面失去焦點、或 `mousemove` 發現 `buttons === 0`（放開的事件沒送到，例如在右鍵選單上放開）時結束並存大小，再按下把手會先收掉上一次沒收尾的拖曳，結束後不留任何監聽。拖出來的寬高直接設在 `#macro_table` 的 inline style（比遊戲的樣式表優先），並設 `--macro-extra`（寬度比 690 多的部分）。
- 樣式在 `macro-notes.css`（和備註欄同一份，manifest 與 popup 備援注入都已載入）：多出來的寬度只給指令欄（遊戲輸入框的 class 就是 `command`，`#macro_table .command` 固定 250px，要多一層 `body` 才贏得過遊戲的樣式表），備註欄維持 250px。
- 大小記在 `chrome.storage.local.macroWindowSize`（`{ width, height }`）：放開滑鼠才存，存不進去不影響視窗；讀回來用 `sanitizeSize` 檢查（兩個數字都是有限的正數、不超過 10000，否則當作沒記過、不設任何 inline style），套用前用 `clampWindowSize` 夾在最小視窗與「瀏覽器視窗扣掉視窗現在的 `right`、`top`」之間（視窗用這兩個值定位，左緣與下緣才不會出畫面；遊戲的 `set_right`／`set_top` 寫的是 inline 的 px 值）；玩家在讀取回來之前真的拖動過的話，晚回來的讀取不能蓋掉（`dragged` 在第一次 `mousemove` 才設，只點一下把手不算）；擴充功能重新載入後頁面上舊程式留下的把手，新程式啟動時換掉。
- 新增模組要同時進 manifest 與 popup 備援注入的 `files`，`tests/injection-lists.test.js` 會比對兩份清單（檔案與順序都要一樣，樣式也是）。
- 測試：`tests/macro-io.test.js`（夾限與檢查的邊界案例）、`tests/macro-resize.test.js`（jsdom 載入整個 content script，檢查把手、拖曳後的寬高與 `--macro-extra`、存起來、載入時沿用、壞資料、晚到的讀取、事件不傳給遊戲）。jsdom 算不出排版，真實手感、把手有沒有被遮住、指令欄是否變長只能在真實遊戲頁驗證。

## 數值區塊

- 面板最上方的「數值」區塊由兩個模組組成：`stats-view.js`（不碰 DOM，`rows(readings, exp)` 決定每列顯示什麼）與 `stats-block.js`（畫面，`attach(root)` 回傳 `render(readings, exp)`）。兩個都要加進 manifest 的 content script 與 popup 備援注入清單，`stats-view.js` 在 `stats-block.js` 之前、都在 `content.js` 之前；`content.js` 建立區塊要包 try/catch，壞了不能牽連後面按鈕的綁定。
- 每秒由 `renderPanel` 餵 `readAllStats()` 與 `readGameNumber('exp')`。**數值必須和觸發規則讀同一份**：`readAllStats` 是用引擎的 `readStat` 組出來的，不要另寫一套讀法，否則面板上看到的數字會和觸發判斷用的不一致。順序跟 `trigger-engine.js` 的 `STATS` 一致，經驗排第一。
- 顯示規則：`目前值/上限（百分比）`，百分比照實顯示可超過 100%（內力、靈力、法力的目前值可以超過上限，原因與公式遊戲說明站沒寫，只顯示不解讀），但目前值小於上限時最多顯示 99%（四捨五入會讓 1451/1452 變 100%，誤導成滿了）；讀不到顯示 `—`，上限為 0、負數或讀不到時不顯示百分比；經驗只有目前值。每一項數字的顏色不自己算門檻，由 `content.js` 的 `STAT_COLOR_IDS` 讀遊戲各欄位外層元素（`gin_w1`、`kee_w1`…）此刻生效的顏色（遊戲 `vitals.js` 依滿度換色），經 `themeFrom` 的 `values` 套用；讀不到就沿用文字色。
- 收合狀態記在 `chrome.storage.local.statsCollapsed`，預設展開；讀到的狀態只在玩家還沒動過時才套用（晚到的讀取不能蓋掉玩家剛點的），讀不到維持展開，存不進去不影響收合。面板可能被搬進置頂浮窗（另一個 document），事件綁在節點上、樣式在 shadow root 裡，搬過去仍然有效。**不要搬或改遊戲的狀態視窗（`#monitor`）**，這裡只是另外顯示一份。
- **只在置頂浮窗裡顯示**：樣式 `:host(:not([data-pip])) .stats { display: none; }`，主面板看不到（遊戲的狀態視窗本來就有）；只用樣式隱藏，所以收合狀態與每秒更新照舊，按「置頂」的當下數字就是最新的。
- **配色跟遊戲的狀態視窗（`#monitor`）一樣**：深色底、虛線淺色邊框、遊戲的文字色、經驗用 `#exp` 自己的顏色。遊戲的顏色是由 `html` 上的主題 class（`XTerm`、`VGA`、`Mac`…，定義在遊戲的 `ansi.css`）決定的，會隨使用者設定的色彩主題與「半透明」變，**不能把某個主題的色碼寫死**：`content.js` 的 `readMonitorTheme` 每秒讀 `#monitor` 與 `#exp` 的 `getComputedStyle`，經 `themeFrom`（只收 `rgb()`／`rgba()`／十六進位，其他字串、空的、全透明都退回預設，因為它會被放進 style）算出配色，再 `setTheme` 放進 CSS 變數（`--stats-bg`、`--stats-border`、`--stats-fg`、`--stats-exp`）；預設值是遊戲預設的 XTerm 主題。找不到元素要給空的讓它退回預設，不能讓更新出錯。
- 測試：`tests/stats-view.test.js`（格式化）、`tests/stats-block.test.js`（jsdom 畫面、配色與串接檢查；jsdom 算不出 shadow DOM 的 `:host` 樣式，「主面板看不到、置頂才看得到」只能手動驗證）。

## 置頂浮窗

- 面板的置頂浮窗（Document Picture-in-Picture）邏輯在 `pip-panel.js`（不碰 `chrome.*`，浮窗 API、宿主節點、儲存、提示都由 `content.js` 注入）。面板是被「**搬**」進浮窗（同一個節點、事件與 shadow DOM 跟著走），不是複製；放回原位靠留在宿主位置的提示條，提示條被頁面刪掉就放回主頁面根節點，**浮窗被關掉時面板一定要回來**（`pagehide` 與收回都走同一個 `restore`，可重複呼叫）。開到一半失敗要關掉半開的浮窗、放回面板、清掉殘留。
- **不得搬遊戲自己的狀態視窗（`#monitor`）**：搬走之後遊戲與我們用 `getElementById` 讀數值的程式都找不到它。要顯示數值就另外顯示一份。
- 面板在浮窗裡時宿主帶 `data-pip` 屬性，面板的樣式用 `:host([data-pip])` 隱藏拖曳與收合（收合過的面板在浮窗裡要展開）；`content.js` 裡所有用 `document` 算主頁面位置的程式（`replace`、`avoidMap`、拖曳開始）都要先確認 `host.ownerDocument === document`，否則會把浮窗座標存成面板位置。收回後要重新排位置。**新增面板內容時要想到它可能在另一個 document 裡**：別用主頁面的 `document` 找面板內的元素，別假設事件會傳到主頁面的 `window`。
- 玩家的互動要同時聽遊戲視窗與浮窗：警報提示（標題閃爍、提示音）靠 `createInteractionHub`（`watch`、`addWindow`、`removeWindow`），浮窗開啟時 `addWindow`、關閉時 `removeWindow`；新增「靠互動停止」的功能要走同一個 hub，不要直接在 `window` 上掛監聽。
- 浮窗大小：沒有記住的大小時預設寬 360、高度以**展開後**的面板為準（量的當下暫時掛上 `data-pip`、量完立刻拿掉，等瀏覽器建立視窗期間主頁面的面板不能先變成浮窗的樣子）；玩家調整過、收回或關閉浮窗時記在 `chrome.storage.local.pipSize`（只記範圍內的數字，壞掉、零、負數、超大都當作沒記過；用的時候再夾在螢幕可用範圍內；拖回開窗時的大小不記；這次存過就不讓晚到的讀取蓋掉）。重新整理或關閉遊戲分頁時瀏覽器直接關浮窗，這一次的大小可能沒存到，這是已知限制。**Chrome 開置頂視窗時會把請求的大小等比縮小（約螢幕面積四分之一），拖拉卻可以更大，開窗後也不能用 `resizeTo` 放大（實測）**，所以判斷「玩家有沒有調整」的基準是視窗開起來之後的**實際大小**（量不到才退回請求的大小），不能用請求的大小，否則瀏覽器自己縮的會被當成玩家調整、蓋掉玩家記的大小。開窗必須在使用者點擊之後馬上呼叫，所以大小在建立控制器時就先讀好（`ready`），不能在開窗前才等儲存。儲存壞了不能影響開窗與收回。位置交給瀏覽器。
- 測試：`tests/pip-panel.test.js`（jsdom，假的 `documentPictureInPicture` 回傳第二個 jsdom 視窗，假的儲存）。**斷言不要拿 jsdom 視窗物件互相比較（`assert.equal(win, other)`）**：失敗時 node 會把整個視窗印出來比對，測試會卡住，改用 `assert.ok(a === b)`。真正的 Chrome 行為（要點擊才能開、置頂、焦點）只能手動驗證。

## 驗證、錯誤、警告訊息的顯示

- 所有驗證、錯誤、警告的訊息都要用同一組顏色標出來：**error 紅、warn 琥珀、info 不上色**（成功與一般訊息不上色）。設定頁用 `popup.html` 的 `.msg-error`／`.msg-warn`（顏色沿用規則狀態 `.pill` 那組：紅 `#fde2df／#b42318`、琥珀 `#fdecc8／#8a5a00`）；遊戲頁面板（shadow DOM）用 `#ff8a7a`（`alert`、`zap-bad`、`rd-bad`）與 `#ffb347`（`warn`、`zap-caution`、`rd-note`）。
- 新增會顯示給使用者的訊息時要想「這是驗證／錯誤／警告嗎」，是的話帶等級：設定頁的狀態列用 `setStatus(text, level)`／`markLevel`，一行一行的訊息用 `showParts`；LINE 區用 `say(text, level)`；怪物面板的狀態列用 `say`、浮層與裝備的訊息列用 `zap-bad`／`zap-caution`；解謎用 `say(text, level)`。**換新訊息時舊的上色要一起清掉**（用 `classList.toggle`，不要只加不減）。
- 共用資料的訊息等級由 `shared-data.js` 決定（有測試）：`describeSheetParts`、`reportEntries` 回傳 `{ level, text }`（更新失敗與被丟掉的列是 error；有被丟掉或對不到的列、超過上限、沒勾、沒有 gid、不會抓取是 warn）；`describeSheet`、`reportLines` 是它們的純文字版。

## 設定頁

- 面板的 ⚙ 由 `background.js` 把 `popup.html?tab=<遊戲分頁 id>` 開成分頁並記在 `storage.session`，再按一次關閉；`popup.js` 看到 `?tab=` 就控制那個遊戲分頁（`getTab`）並加上 `body.page` 樣式。popup 與設定頁是同一份 HTML/JS，改一份兩邊都會變。設定頁開在背景分頁時，自己的 `setInterval(refreshLive, 1000)` 會被 Chrome 降頻，所以遊戲頁的 `renderPanel` 在「定時開關、任一組觸發開關、巨集有沒有在跑」變了時會送 `STATE_CHANGED`（只送給擴充功能的頁面），設定頁收到（且來自它控制的那個遊戲分頁）就立刻 `refreshLive()`；定時那一頁的狀態文字平常只在按自己的按鈕時改，`refreshLive` 在開始／停止翻轉時才跟著改（不蓋掉錯誤訊息）。

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
