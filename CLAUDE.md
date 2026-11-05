# chrome-extensions

每個子資料夾是一個獨立的 Chrome extension（Manifest V3，unpacked 載入），資料夾內以 `manifest.json` 為入口。

## 安裝腳本

- 三個安裝入口行為一致（只覆蓋已是 extension 的資料夾或空資料夾、顯示「升級：vX → vY」、嘗試複製路徑並開 `chrome://extensions`），改一個要一起改：
  - `install.ps1`（Windows，`irm … | iex`）、`install.sh`（macOS / Linux，`curl … | sh`）：下載 GitHub 預設分支的 ZIP，不需要 Node / git。用 `iex` 執行所以不能 `exit`，要包在函式裡用 `return`。
  - `bin/install-extension.js`（`package.json` 的 `bin`，`npx github:austinchen705/chrome-extensions`）：給已有 Node 與 git 的人。
- 三者都會安裝任一含 `manifest.json` 的子資料夾，新增 extension 不需要改腳本；安裝方式寫在 `README.md`。

## 狀態觸發

- 規則判斷在 `catworld-auto-command/trigger-engine.js`（不碰 DOM，讀數、時間、送出指令都由呼叫端傳入），content script 與 popup 共用；規則狀態機與安全上限的語意寫在該檔開頭註解。manifest 的 content script 與 popup 的備援注入都要帶上它。
- 看門狗、送出佇列、關鍵字在「定時或觸發任一個在跑」時都要作用（`active()`），驗證碼偵測與自動辨識則閒置時也作用（手動 `reward` 領獎也要幫忙輸入），新增會送指令的功能要接同一套；只有輸出區 `#content` 裡的變動算遊戲輸出（`inContent`），右上角每秒跳的時鐘 `#uptime`、`#monitor`、地圖、巨集、設定視窗、重連倒數 `#notice` 都不算，時鐘每秒一跳、漏掉它看門狗永遠不會響。
- 觸發分成「戰鬥」「練功」兩組（`trigger-engine.js` 的 `GROUPS`），功能相同、完全獨立：各自的設定存在 `triggerGroupSettings.<id>`、各自一個引擎與計時器，送出佇列來源是 `trigger:<id>`。`START_TRIGGER` / `STOP_TRIGGER` / `REARM_RULE` 一定要帶 `group`（未知或沒帶回 `ok:false`）；`STATUS` 回 `stats`（讀數，共用）與 `triggerGroups.<id>`。popup 用 `<template id="triggerPaneTemplate">` 為每組產生一個分頁，template 內的 id 都帶 `-__G__`；新增一組只要加進 `GROUPS`。舊的 `triggerSettings` 由 `loadGroupSettings` 整份放進練功組。驗證碼、`stopEverything` 對所有組一起作用。規則的 `stopGroup`（規則卡片裡的「命中送出後停止○○觸發」，數值與關鍵字規則都有）在 `content.js` 的 `send` 回呼處理：**先** `stopTriggers` 再把這次的指令用 `startMacro(commands.join(';'), 'trigger:<id>')` 送出（順序反過來指令會被 `stopTriggers` 的 `dropQueue` 丟掉；用巨集送是因為巨集執行中算 `active()`，定時與另一組都沒在跑時最後一個指令才送得出去；同一輪好幾條規則一起送出時只在 `group.on` 還是 true 時停一次，再停會把前一條剛啟動的巨集取消掉；停了之後同一輪才送出的其他規則也走巨集）；引擎的 `io.send(commands, index)` 帶規則索引，停止原因才寫得出是哪條規則；勾了 `stopGroup` 的規則指令可以留空（`normalizeRule` 以「有指令或有勾停止」判斷規則有效，`send` 沒指令就不起巨集），沒勾的指令留空仍是未啟用。測試在 `tests/trigger-stop-after-fire.test.js`。
- 規則的 `priority`（最優先）由 `content.js` 處理：命中時指令用 `startMacro(…, { priority: true })` 包成 priority 巨集；`currentPriority`（最早的那個）放行，`nextQueued` 只送它的佇列項目，`syncHold` 把其他巨集的 `@等待` 凍結（`frozen`、`remaining`）、放行後接著算；`finishMacroIfDone` 要看 `frozen`，否則被凍結的巨集會被誤判結束。測試在 `tests/trigger-priority.test.js`。
- 關鍵字規則（`kind: 'keyword'`）的新文字由 `captchaObserver` 在驗證碼檢查之後交給 `engine.onText`，只取 `#content` 內新增的內容。防迴圈靠「只看新文字、冷卻中的直接丟掉、`>` 開頭的回聲行略過」三件事，改動時不能拿掉任何一個，對應測試（`tests/trigger-keyword.test.js`）要保留。輸出分批到、關鍵字也可以有好幾行（設定頁的欄位是 `<textarea>`，`<input>` 會吃掉貼上的換行），所以 `onText` 不是只比對這一批：引擎留最近 `KEYWORD_WINDOW_MS`（5 秒）的每批文字（`recent`，帶遞增的 `seq`，已壓掉空白、已濾掉回聲行），每條規則自己的 `consumed` 記它用到哪一批，只拿 `consumed` 之後的接起來比對；沒命中不推進（留給下一批），命中或這條規則不是待命（冷卻中、停用）時推進到最新，所以冷卻期間來的文字不會在冷卻結束後補送、同一段文字也不會再觸發第二次。

## 停止關鍵字

- `stop-keywords.js`（純函式，content script 與設定頁共用；manifest、popup.html、popup 備援注入都要載入，在 `content.js`／`popup.js` 之前）：`normalize`（缺值＝開、清單 `jrealm`；清單被清空就是真的沒有詞）、`list`（`、` 或空行分隔，單純換行算同一個詞，所以多行的輸出可以整段貼成一個詞；逗號、分號不分隔，因為貼進來的輸出裡常有；去重、最多 `MAX_WORDS` 個、每個最多 `MAX_LENGTH` 字，不算空白）、`find`（不分大小寫的子字串，比對時忽略所有空白與換行；以 `>` 開頭的行是自己指令的回聲，不算）、`createWatcher`（和驗證碼的 `artWatcher` 同一種處理：輸出分批到、詞在行中間換行，所以把最近 `WINDOW_MS`＝5 秒的新增文字接起來再比對，最多留 `MAX_CHARS`，命中後清空；`now` 可注入）。設定存在 `chrome.storage.local.stopKeywords`（`{ enabled, words }`，words 是字串），設定頁的欄位是 `<textarea id="stopKeywordsList">`（`<input>` 會把貼上的換行吃掉）；改了馬上生效（`storage.onChanged`）。
- `content.js` 的 `captchaObserver` 在 `watchReward` 之後、驗證碼分支與 `active()` 判斷**之前**檢查（所以閒置時也提醒）：一律先餵 `stopKeywordWatcher.feed`（閒置時也餵，視窗才接得起來），命中就 `stopForKeyword`＝`alertOnly`（響一次、不進 `ringing`）加 `stopEverything`；原因不含「驗證」，停了之後可以直接再按開始。`STOP_KEYWORD_COOLDOWN_MS`（10 秒）內同一批後續的命中不重複。測試在 `tests/stop-keywords.test.js`。

## 孤兒程式與重複面板

- 擴充功能在 `chrome://extensions` 重新載入後，遊戲分頁沒重新整理的話，**舊版 content script 還留在頁面上**（連不上擴充功能的「孤兒」）：它的面板、計時器、送指令的佇列都還活著；而設定頁在 `sendMessage` 收到 `Receiving end does not exist` 時會備援注入一份新的（`popup.js`），新的隔離環境看不到舊的防重複旗標，所以頁面上會有兩個面板、兩份程式同時送指令，驗證碼也可能停不下來（`chrome.runtime.sendMessage` 在孤兒裡會直接丟例外）。
- 對策在 `instance-guard.js`（manifest 與 popup 備援注入都要載入、在 `content.js` 之前）：`contextAlive(chrome)` 看 `chrome.runtime.id` 還在不在，`content.js` 在 `sendCommand`、`renderPanel`、驗證碼觀察器三處檢查，失效就 `retire()`（停掉計時器、觸發與巨集、清佇列、斷開觀察器、關置頂視窗、拿掉面板）；新程式 `initPanel` 一開始 `removeStalePanels` 把殘留的面板（`data-catworld-panel`）與置頂提示條拿掉並關掉殘留的置頂視窗。`stopAndAlert`、`alertOnly` 送通知一律包 try/catch：**停止絕對不能因為通知送不出去而被跳過**。新增會送指令的入口要走 `sendCommand`（已有檢查）。
- 測試：`tests/content-instance.test.js` 在 jsdom 載入整個 content script（manifest 列的所有檔案、假的 `chrome`）；底座要等啟動時的非同步初始化跑完才操作、結束時清掉頁面的計時器（視窗不能 `close()`）。三個檢查入口彼此冗餘，拿掉單一個不會讓測試失敗，這是刻意的雙重保護。

## 驗證碼圖形偵測

- 偵測規則在 `captcha-art.js`（`artText`、`looksLikeAsciiArt`、`looksLikeNoiseCaptcha`、`createWatcher`；content script 與測試共用，manifest 與 popup 的備援注入都要載入、且在 `content.js` 之前）。偵測規則都是看「連續好幾行」，而遊戲輸出常分成好幾批新增文字到達（一張圖可能被切成一行一批），所以 `content.js` 的 `captchaObserver` 不能只看單一批：一律經 `artWatcher.feed`（把最近 5 秒的新增文字接在一起、最多 120 行，偵測到就清空；`armDetection` 重新開始時也清）。
- 診斷：驗證碼偵測沒反應時看遊戲頁 console（篩 `[catworld]`）：`疑似驗證碼的批次`（印這一批的行數、長行數、背景色標記數與是否偵測到）、`驗證碼自動辨識：送出 …`／`通過`／`失敗，字形矩陣`。不要為了這個把規則放寬到會誤判一般輸出。
- 測試：`tests/captcha-art.test.js`（jsdom，用 `tests/fixtures/captcha/` 的真實樣本：英數亂碼塊、B3 背景空白拼的數字圖、一般輸出；分批大小 1～4 行都要抓到、一般輸出逐行餵也不能誤判、隔太久的片段不能接在一起）。新增驗證碼樣式時先把真實輸出放進 fixtures 再改偵測。
- 自動辨識在 `captcha-grid.js`（`decodeHtml` 吃遊戲輸出的 HTML：背景色 `B1～B9` span 裡的每個字元都是方塊，空白或亂碼文字都算，沒有 span 時 `@ $ # % & * █` 符號本身是方塊但只限整行同一種符號的行（一般輸出的 `(100%)` 不算），數字可能是方塊本身也可能是方塊間的空洞；圖是「連續有填色的列」的某一段：依填色多寡逐段試，第一段每個字形都認得的就是圖（圖前幾秒的狀態卡、背景色物品名，以及圖印完後 1 秒內接著印、比圖還大的整片底色公告橫幅，都不會影響反相判定或被當成圖），全都認不出就回填色最多那段的結果；模糊比對門檻 0.9，沒把握回 `?`，曾以 0.86 把 5 猜成 6；`LIBRARY` 是以整個字形矩陣為鍵的精確模板庫，查不到才做 5x7 模糊比對；content script、測試與 `tools/captcha-grid.js` CLI 共用，manifest 與 popup 備援注入都要載入、排在 `captcha-art.js` 之後）。`content.js` 的流程：偵測到圖或提示 → `beginCaptcha` 暫停送出佇列、把後續批次的 HTML 接上去（偵測看 artText，辨識要原始 HTML，`artWatcher.feed` 兩個都收）→ `CAPTCHA_QUIET_MS` 沒新輸出才 `solveCaptcha`，讀到數字後再隨機等 `CAPTCHA_SEND_DELAY_MS` 範圍內（3～10 秒）才送出（等的期間 `answer` 仍是空的，新輸出照樣接上去重新等靜默）→ 看門狗的 `NO_REPLY_MS` 沒回應＝答錯（遊戲答錯不回應）→ `retryCaptcha` 重送同一答案到 `CAPTCHA_MAX_ATTEMPTS` 次才 `stopAndAlert`；有回應就 `endCaptcha` 恢復送出。讀不出數字直接停，矩陣印在 console。偵測器在第 5～8 行就命中而圖有 10～16 行，所以不能在命中那一刻解；偵測器命中那一刻的視窗已含當批，再接一次會讓圖重複。
- 測試：`tests/captcha-grid.test.js`（解碼：合成字形、八種真實版面）、`tests/captcha-solve.test.js`（整個 content script 在 jsdom 裡跑、計時器縮小 `SCALE` 倍：答案送出、有回應恢復、沒回應重送 3 次後停、通知送不出去也要停、領獎提示併進同一輪、讀不出就停）。底座在 `tests/helpers/game-page.js`。新字形：先把真實輸出放進 fixtures，用 `node tools/captcha-grid.js <檔> --debug` 看矩陣，確認後貼進 `LIBRARY`。
- 樣本收集：`content.js` 的 `reportSample` 在每回合結束（`endCaptcha`＝passed、`retryCaptcha` 滿次數＝silent、`solveCaptcha` 讀不出＝unknown）送 `CAPTCHA_SAMPLE`（`{ outcome, answer, attempts, html }`），不等結果、送不出去不影響流程。`background.js` 的 `uploadCaptchaSample` 讀 `chrome.storage.local.captchaSampleUrl`（`onInstalled` 在這個鍵從沒設定過時帶入 `CAPTCHA_SAMPLE_DEFAULT_URL`＝作者的收集表，和 `sharedSources` 同一個 handler；空的就不碰網路；**content script 不讀這個鍵**），補上 `version` 後以 `text/plain` POST 到 Apps Script（JSON 會觸發 CORS 預檢而 Apps Script 不回應預檢；POST 會 302 到 `script.googleusercontent.com`，所以 `host_permissions` 要同時有 `script.google.com` 與 `*.googleusercontent.com`），15 秒逾時、不重試，結果存 `storage.session.captchaSampleLastResult` 給設定頁顯示；設定頁只收 `https://script.google.com/macros/` 開頭的網址（別的主機沒權限、會悄悄失敗）。Apps Script 的 `doPost` 範例與部署步驟只寫在 README「驗證碼樣本收集」。測試：`tests/captcha-solve.test.js`（三種結果各送一筆、樣本的 HTML 可直接解碼）、`tests/captcha-sample-background.test.js`（vm 執行 background：安裝時帶入預設網址、有網址才打、只收遊戲頁、失敗不丟例外且不影響警報、逾時）、`tests/captcha-sample-ui.test.js`（設定頁欄位與結果列）。

## 定時分頁的固定指令與隨機指令

- 設定格式是 `settings.fixedItems` 與 `settings.randomItems`，都是 `[{ command, minSeconds, maxSeconds }]`，轉換與抽選在 `timer-settings.js`（content script 與 popup 共用，manifest、popup.html、popup 的備援注入都要載入，且要在 `content.js` 之前）。固定指令每一項各自循環（`content.js` 的 `fixedRuns`：開始時先送一次，之後在自己的秒數內隨機等再送，彼此不等；`STATUS` 回 `fixed: [{ command, at }]`）；隨機指令先挑一個再等它自己的秒數。
- 舊格式由 `normalizeFixedItems`（`commands` + `minSeconds` / `maxSeconds`：轉成一項、指令用 `;` 接起來，才維持「每輪全部依序送出」；`commands` 也沒有時給預設的 `ps;px`）與 `normalizeRandomItems`（`randomCommands` + `randomMinSeconds` / `randomMaxSeconds`）轉換；**不能在 `content.js` 的預設設定裡放 `fixedItems`、`randomItems`**，否則空陣列會蓋掉升級前存下的舊設定（測試 14i、15i 與 `tests/timer-settings.test.js` 會擋）。

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
- 附屬能力門檻（設定頁「附屬能力達到門檻就建議留下」，`chrome.storage.local.equipmentKeep`＝`{ enabled, min }`，預設關閉、門檻 10，`normalizeKeepRule` 在 `zap-equipment.js`，popup.html 因此要載入它）：開著時 `compareEquipment` 在一般比較之後，候選只要有一條計分的屬性（`IGNORED_ATTRS` 以外、正值）達到門檻就改判 `keep`（「屬性達門檻，建議留下」，理由第一句寫哪條屬性達門檻、後面保留原本的理由），沒基準、還不能穿也算；本來是 `better` 的不改。`keep` 的 `VERDICT_RANK` 與顏色和 `better` 相同。沒設定時行為必須和以前完全一樣。
- 追蹤器把「你想請…鑑定所有無名物」到「共鑑定…樣無名物」之間的區塊當候選，之外的區塊只用來更新基準（名稱必須是穿著名單內唯一一件）；區塊可能跨封包，所以新增文字先緩衝，靜止 `FLUSH_MS` 後才 `flush`（連續輸出最多延後 `FLUSH_MAX_WAIT_MS`）。開始／結束句也可能被切在兩個封包之間，追蹤器保留上一批最後 40 個字一起比對；結束句一直沒來時超過逾時就關閉這次鑑定，之後的區塊算被動更新。基準依角色分開存（`wornEquipment: { [角色]: Store }`，角色取分頁標題「角色名 - …」），讀取目前穿著用 `mergeBaseline`（沒回應但還在穿的保留舊的、已經沒穿的丟掉），不能整份換掉。
- 鑑定結果在浮層裡依判斷排序（`VERDICT_RANK`：好與屬性達門檻同級、相當、沒基準、差，同級照來的順序，每件插進該級最後面），最多 `RESULT_MAX` 件，超過時移掉最差一級裡最舊的；`blocks` 只依來的順序存，顯示順序每次從 `rank` 重算。
- 「讀取目前穿著」只能走 `startMacro`（`zap-equipment-ui.js` 的 `deps.startSteps`）：先送 `i`，從穿著行（`ˇ` 標記與同一行的 `view #編號`，需要 DOM 節點的 HTML，不是只有文字）拿到編號，再送 `view` 巨集；鑑定每次都不送指令。UI 借用 `zap-panel.js` 回傳的浮層區段與計時；失敗（沒讀到背包、指令被拒、解析不到）都要顯示原因。

## 招式列表

- `skill-moves.js`（manifest 與 popup 備援注入的 `files` 都要載入，在 `content.js` 之前；也在 background 的 `importScripts`）：純函式 `parseLearned`（只讀「你所領悟的招式數目為」之後的「名稱 : N 招」，不靠行首，所以輸出沒有換行也讀得到）、`lookup(data, names)`（background 用，只回被問到的武功）、`describe`、`moveText`；加上遊戲頁的觀察器：標題出現後 `ARM_MS` 內的新文字都接上去（輸出可能分批），靜止 `SETTLE_MS` 後解析，向 background 送 `SKILL_MOVES`（`{ names }`）拿資料，在最後一個新增節點後面插一塊 `data-catworld-skills`（自己插入的節點要從觀察器排除）。偵測到標題時一定印一行 `[catworld] 招式列表：偵測到…` 到 console（沒勾開關時會寫明），方便分辨是沒偵測到還是沒開。查詢失敗要把原因顯示在方塊裡。
- 開關是 `chrome.storage.local.zapFeatures.skills`（缺值＝關閉，設定頁 `featureSkills`，和其他輔助功能同一個 `FEATURE_BOXES`），flush 時才讀。`skills-data.js`（約 170 KB）只在 background 載入、不隨每個遊戲分頁載入。已悟 N 招＝資料裡 `moves` 的前 N 招（和 `skills.js` 的「30 × 已悟招數」門檻解讀一致），下一招的門檻取 `levels[N]`。傷害分級的顏色在 `TIERS`（每級 `color` 與 `second` 兩個色系，招式名用 `nameChunks` 兩個字一段、兩色輪流，數字部分用 `color`），傷害類型欄混著說明時只留第一句。
- 測試：`tests/skill-moves.test.js`（純函式用真實資料；遊戲頁用整個 content script 在 jsdom 裡跑、假 background 用 `lookup` 回真實資料）。**真實的 careers 輸出文字（節點與換行的切法）只用使用者貼的樣本驗證**。

## 拜師導師搜尋

- 規格與票在 `.scratch/mentor-search/`（不進 git）。資料來源是 `docs/data/mentors.tsv`（欄位：導師、功法、路線原文、類別、最高等級、配合心法、來源；來源「最高」＝試算表「最高功法導師」分頁，「配合」＝「功法配合表」分頁），由 `tools/gen-mentor-data.js` 產生 `catworld-auto-command/mentor-data.js`（`globalThis.CatworldMentorData`，每列 `[導師, 功法, 路線原文, 類別, 最高等級, 配合心法, 巨集指令, 解謎之後的路線, 備註[], 不能自動走的原因]`），**不要手改產生的檔案**。產生規則：導師欄用 `/` 分隔的拆成各自一列、共用路線（路線欄裡用 `//` 隔開兩位導師各自的路線的，整理來源檔時就要拆成兩列，產生腳本不會拆）；同一位導師的同一個功法兩個分頁都有時，路線、類別、配合心法以「配合」為準，最高等級取「最高」的，路線不同的列在產生報告；格式不對或少於 30 列時失敗、不覆寫。沒有導師可找的列（「(玩家)」「(解謎)」）整理來源檔時就不收。產生報告也列出「不能自動走」的列與原因。
- 路線轉巨集指令在 `tools/mentor-route.js`（`parseRoute`，只在產生資料時用，不隨擴充功能載入）：只有從醉仙樓出發（開頭是 `run e 5n`，離開城鎮可以是 `o`、`o o` 或 `2o`）而且每個字都認得的才轉（`run` 後面只收已知的方向字與 `t`，打錯的字不送），否則 `command` 是空字串、附原因，面板沒有「走過去」。括號裡的英文指令（動詞白名單 `push`／`open`／`worship`／`enter`／`touch` 加一個對象，括號外也認得）轉成分號隔開的獨立指令，錯字在 `TYPOS` 修正（`oepn`）；括號裡的中文與 `//` 之後是備註，不送出。「謎」是截斷點：`command` 只到第一個謎之前，`rest` 是謎與後面的原文。「謎」只用同一位導師**另一個分頁**、骨架相同（`skeleton`：指令與謎都當謎、備註丟掉）而且謎比較少的路線來補，所以另一個分頁寫明指令的（小龍女的 `worship tomb`）能把整條走完；同一個分頁裡骨架相同的不補（看不出那個謎是不是那個指令，例如洪七公的降龍十八掌）。補過的在備註寫「已用另一條路線補上謎：…」，原文照舊顯示。要新增能轉的指令，加進 `VERBS`，並用真實列驗證。
- `mentor-search.js`（純函式）：`groupRows` 依「導師＋整串路線」分組（`canonicalRoute` 把空白壓成一個、相鄰相同的方向合併，`nu nu` ＝ `2nu`；`t`、`run` 這類不是方向的字不合併，群組帶第一列的巨集指令與備註），`search` 比對導師名、功法名、配合心法（子字串、不分大小寫、忽略所有空白），導師名符合的排前面、同級依導師名，空白時全部列出。`mentor-ui.js` 是面板的「拜師」列（`attach(root, { startSteps })` 回傳 `setEnabled`），不經 background；「走過去」只能走 `startMacro`（`startSteps`，遵守指令間隔、驗證碼偵測、停止一切會取消），指令原樣送、不自動 `recall`，有 `rest` 時按鈕叫「走到解謎處」並顯示後面的路線。開關是 `zapFeatures.masters`（缺值＝關閉，設定頁 `featureMasters`，和其他輔助功能同一個 `FEATURE_BOXES`）。資料檔、查詢模組、UI 模組都要加進 manifest 與 popup 備援注入的 `files`（`zap-riddle-ui.js` 之後、`pip-panel.js` 之前），`injection-lists` 測試會比對。
- 個人修改：存在 `chrome.storage.local.mentorRoutes`（`{ "導師|功法": 指令 }`，鍵用 `routeKey`，忽略空白與大小寫），一個功法一筆、優先於內建，**內建資料絕不被改、也不寫回儲存**；`parseEdits` 讀回時只留形狀對的（鍵含 `|`、值是非空字串），壞資料不丟例外；`applyEdits` 在讀取時把路線與巨集指令換成改的那條（備註、解謎之後的路線、不能自動走的原因不再適用），`groupRows` 再依改完後的路線分組，所以改成跟別筆一樣的路線會自動併過去（同組有沒改過的列就沿用它的欄位），群組帶 `edited`。編輯框在 `mentor-ui.js`：路線文字（沿用 `startMacro` 吃的格式，存之前用 `CatworldMacro.parseSteps` 檢查，空的、看不懂的、沒勾功法都不存並顯示紅字原因）、要套用的功法勾選（預設這一筆全部）、儲存、改回內建、取消；編輯只放在清單裡（浮層會消失），編輯按鈕與編輯框的 click 要擋住不傳給遊戲，改了馬上生效（`storage.onChanged`）。
- 測試：`tests/mentor-search.test.js`（整個 content script 在 jsdom；`boot({ initialStore })` 放啟動前就在儲存裡的設定；假資料用 `boot({ preload })` 放在所有腳本之前，走過去用 `scale` 縮小計時器、檢查實際送出的指令；有測試用 `builtin: true` 的真實資料）、`tests/mentor-data.test.js`（產生腳本與路線轉換的規則，以及 `mentor-data.js` 和 TSV 一致）。測試底座預設不載入 `mentor-data.js`。

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

## 地圖怪物蒐集

- `map-collect.js`（manifest 與 popup 備援注入都要載入，要在 `zap-mobs.js` 之後，用它的 `parseMobLines`、`textFromAdded`）監聽 `#content` 新增的文字，進房間時遊戲印的怪物行（`※名稱(ID)`）記給「目前的房間」：地圖視窗 `#map_wrapper` 沒有「你在這裡」的樣式（`emap` 的輸出與地圖房間的 `title` 都沒有怪物資訊，`title` 通常是空的），但遊戲會把所在房間捲到 `#map_anchor`（和一格同大的空方塊）的位置，所以蓋住 anchor 中心點的那個顯示中（沒有 `.invisible`）的 `<a id="m-區域-房間代號">` 就是目前的房間（`currentRoom`）。怪物行出現後等 `SETTLE_MS` 才判斷房間（地圖捲動與印文字不是同一瞬間；這段時間內又走到別間會記錯房間，已知限制）。合併進 `chrome.storage.local.mapMonsters`（鍵 `區域代號/房間代號`，`{ area, room, areaName, mobs, seen }`，`mobs` 是 `名稱(ID)` 字串）：取聯集、只增不減，區域名稱讀地圖標題。收集與設定頁的顯示、複製只認帶括號的 `名稱(ID)`（`isMob`、`rows`；1.58.0 讀地圖 `title` 記下的是房間裡的玩家、只有英文 ID，要濾掉；popup.html 因此要載入 `map-collect.js`）。連不上儲存（孤兒程式）就停止監聽。怪物提示（`zap-panel.js` 的 `showHints`）用 `whereIs` 在怪名下多一行「蒐集到：區域 房間…」（擴充功能的面板與浮層不畫地圖，位置視覺化只做在遊戲的地圖視窗上）。地圖視窗標題列（`#map_header`，遊戲的拖曳把手）右側有 `map-collect.js` 放的下拉選單 `#catworld-mark-select`：列出目前顯示區域（`#map_wrapper` 底下沒有 `.invisible` 的 `div#m-區域`）蒐集到的怪，選一隻就由 `markRooms` 把 `m-區域-房間` 加 inline 紅底（`!important`，比遊戲樣式表優先）與 `data-catworld-mark`，同時只標一隻；選單絕對定位靠右、寬度由 `fitSelect` 依區域名稱右邊剩下的空間算（標題是置中的；不能靠加寬地圖視窗解決，`#map_anchor` 是以 400 寬視窗置中寫死的位置）、事件不傳給遊戲，每 `MARK_TICK_MS` 重讀儲存並重標（換區域與遊戲重畫地圖都靠這個），這個區域沒有蒐集到的怪就藏起來，與怪物查詢開關無關；以上只顯示，不碰路線與分級；`zap-panel.js` 要讀 `mapMonsters` 並聽 `storage.onChanged`，popup 備援注入與 manifest 的 `map-collect.js` 都要排在 `zap-panel.js` 之前）。設定頁「地圖怪物蒐集」只顯示筆數、複製 Tab 分隔文字、清除；不含強度與路線，併進共用表的格式還沒定。jsdom 算不出排版，測試用假的 `getBoundingClientRect` 擺房間與 anchor，真實頁面的置中行為只能手動驗證。測試在 `tests/map-collect.test.js`。

## 地圖巡怪

- 規格與票在 `.scratch/map-hunt/`（不進 git）：`spec.md`、`issues/01～08`；已完成 01（路線）、02（輸出解析）、03（骨架與走路）、04（看房間、略過有別人的房間、NPC 學習）、05（打怪）、06（補氣）、07（自動學習出口）、08（輪與輪之間）。這和 `.scratch/auto-hunt/`（依重生時間、從醉仙樓出發）是**不同的功能**。
- `map-route.js`（不碰 DOM）：`parseArea(html)` 把地圖視窗裡一個區域（`m-區域`）的 innerHTML 還原成房間與方向指令（一字元一格，`─│╲╱` 雙向、`→←↑↓↘↖↙↗` 單向、中間隔很多連線字元仍算一步、`class="N6"` 的 `<a>` 是通往別區的標記不是房間），`route(graph, from, to)` 用 BFS 回指令陣列（不可達回 null）。房間鍵是 `區域/房間`，和 `map-collect.js` 一致；樣本在 `tests/fixtures/map/`。
- `hunt-parse.js`（不碰 DOM）：`parseLook`（出口轉成指令、`※` 怪物行一行一筆並保留 `<狀態>`、「別人」＝沒有 `※`、有 `(英文ID)` 並帶 `<狀態>`、不是屍體；物品沒有狀態所以不算）、`parseFinger`（`(player)`／找不到／unknown，unknown 一律當玩家）、`parseTime`（台北時間視為 UTC+8）。輸出文字要有換行才讀得出怪物與別人（遊戲輸出若被拆成節點直接相接，呼叫端要先處理），`content.js` 的 `askGame` 收的是 `#content` 新增節點的文字，節點文字本身要有換行（和 `map-collect.js` 讀怪物行的前提相同）。
- `map-hunt.js`：`create(deps)` 的引擎不碰 DOM 與 `chrome.*`，讀房間、送指令、讀儲存都由 `content.js` 注入；`FIELDS` 決定設定頁欄位、預設值與檢查（`normalizeSettings`，設定存在 `chrome.storage.local.mapHuntSettings`，設定頁用同一份表產生欄位）。`start()` 固定「面板「選怪」勾選的怪（可多隻）＋目前顯示的區域」，目標＝每隻被勾的怪的 `CatworldMapCollect.locate` 在該區域的房間聯集、且在地圖上的；每個 tick（200ms）檢查目前房間（`CatworldMapCollect.currentRoom`）：沒走成就重送一次、再沒走成略過該目標、連續 3 次略過停止並警報；**逾時用 tick 數算，不用 `Date.now()`**（測試底座只縮小計時器、不縮小時鐘）。到的房間要等於路線上的下一間才算成功，走到別間就重算，同一個目標走錯 3 次略過（`wrong` 只在略過時歸零，不然兩間之間來回會永遠不停）；連續讀不到房間要超過逾時才停（`blind`）；`start()` 有 await，`starting` 期間 `on()` 為真（開始鈕停用、再按開始被擋、按停止會取消這次開始，`finally` 之後要再通知面板重畫，否則開始鈕要等下一秒才恢復）；略過的房間（不在地圖上、走不到、走錯）顯示在面板與停止訊息裡。
- 到達目標房間後（`map-hunt.js` 的 `arrive`／`inspect`）：送 `l`（`deps.ask(command, 'look')`，`content.js` 的 `askGame` 收 `#content` 新增的文字，出現 `ASK_PATTERN` 之後再安靜一小段才交出去；一直等不到 8 秒後交出目前收到的）→ `parseLook`（輸出可能含抵達時印的與 `l` 印的兩份描述，只算最後一份）→ 沒讀到出口算「讀不到房間」（當成走不過去，算進連續略過）→ 不在白名單（設定頁 `npcWhitelist`）與已學到 NPC（`chrome.storage.local.mapHuntNpcs`，名稱陣列，只由 `learnHuntNpc` 寫、設定頁只顯示與清除）裡的 ID 逐一送 `finger <ID>`：`(player)` 或沒回應、讀不懂都當玩家、略過這間且不記；找不到才記成 NPC。有別人的房間算「處理過」但寫在略過清單裡（原因「有別人 ID」），不算移動失敗；所有目標處理完＝一輪結束（見「輪與輪之間」；不等重生時停止並寫「這一輪巡完了」）。`l`／`finger` 的指令走共用送出佇列（來源 `hunt`）；**回應要等指令真的送出之後才開始收**（佇列項目的 `onSent` 回呼，之前印的——例如走進房間時印的抵達描述——不算這個指令的回應，不然 `l` 還在排隊時就會拿抵達描述當答案、漏掉後到的人物行）；房間裡沒有勾選的怪就不問人直接換下一間；ID 要符合 `SAFE_ID`（英數、空白、底線、點、單引號、連字號）才會放進 `finger` 指令，其他當玩家、不送也不學；白名單與已學到的 NPC 都用小寫比對；`inspect` 每個 `await` 之後都要確認這一次巡怪還在（`state !== token`），停止或重新開始後舊的檢查不能再動狀態或送指令。
- 打怪（`fightRoom`／`fightOne`／`onText`／`fightTick`／`lookCheck`／`healInFight`；結束的字裡 `knockoutKeywords` 代表昏迷：`fight.knockedOut` 為真時 `fightOne` 回 `knockedOut`，`finishKnockedOut` 開著就再 `fightOne(…, { finishing: true })` 補一個 `kill`——補刀只認死亡的字（結束字扣掉昏迷的）、不送特攻，結束後才送 `afterKillCommand`；`lookCheck` 看到那隻怪是 `<昏迷不醒>` 也算昏迷）：房間裡有任何一隻被勾的怪就一隻一隻打：`fight <ID>`（ID 要符合 `SAFE_ID`）→ `deps.watch` 餵進來的遊戲輸出裡出現拒戰句就改 `kill`、出現結束句（`endKeywords`）就算這隻打完 → 送 `afterKillCommand` → 再 `l` 重數；連續 `MAX_STUCK` 次數量沒減少略過（原因「打不動」）。逾時（`fightTimeoutSec`）沒結束句就 `lookCheck`：`<戰鬥中>` 繼續等、昏迷或不見了當結束、在但沒在打就重送 `fight`（最多 3 次）。特攻（`specialCommand`）只在怪還活著、距開打或上次已過 `specialIntervalSec` 才送（`#busy` 的 DOM 還沒有樣本，不看狀態列，只靠間隔；忙碌拒絕句不用處理，被拒的不重排）；「你要對誰施展這個招式」這場不再送，但改送 `kill` 時清掉這個旗標（前面的特攻是對著還沒開打的怪）。逾時重送沿用 `kill`（已被拒戰過）或 `fight`。戰鬥中補氣每秒檢查：吃藥模式低於 `eatBelow` 送 `eatCommand`（至少間隔 5 秒），自己回模式低於 `dangerBelow` 就 `finish` 後用 `deps.sendAfterStop`（巨集，owner 為 `hunt-home`，停止巡怪不會取消它）送回家指令。`deps.send` 走 `queueCommand`（含 `;` 的交給巨集，owner 為 `hunt`，停止時 `dropQueue('hunt')` 加 `cancelMacros('hunt')`）。輪與輪之間見下一條。昏迷不醒的怪不當目標（房間裡只剩昏迷的就當打完）；設定在 `start()` 那一刻讀一次，之後改要重新開始才生效。
- 補氣（`vitals`／`eat`／`goHomeAndStop`／`restStep`／`restGate`）：`start()` 檢查必填欄位（吃藥模式要吃藥指令、沒藥關鍵字，兩種模式都要回家指令，缺的在面板說明）；`tick` 在不戰鬥時每秒（`(ticks-1) % TICKS_PER_SEC === 0`，所以開始的第一個 tick 就先看）讀氣：讀不到就停並警報；吃藥模式低於 `eatBelow` 送 `eatCommand`（間隔 5 秒，和戰鬥中共用 `lastEat`），指令**真的送出後**（`deps.send(命令, onSent)`，`queueCommand` 的 `onSent`；巨集在開始時就呼叫）`NO_MEDICINE_WINDOW_TICKS` 內 `onText` 看到 `noMedicineKeyword` 就 `finish` 後用 `sendAfterStop` 送回家；自己回模式低於 `restBelow` 設 `resting`（`tick` 每次 `plan` 之前也再讀一次氣），`tick` 不再呼叫 `plan`（走路中的那一步照常走完），每 5 秒送 `restCommand`（看房間等回應時不送，`restGate` 等待時才送，避免輸出混進 `l` 的回應），回到 `restResume` 才解除；`fightRoom` 在打下一隻前 `restGate` 等到解除（打完這一隻才休息，`state.wake`，`finish` 會叫醒）。`normalizeSettings` 保證 `dangerBelow` 低於 `restBelow`（`restBelow` 最小 2）；戰鬥中氣讀不到一樣停止並警報。測試底座 `world()` 預設氣滿，`boot` 預設填好必填欄位。
- 自動學習出口（設定 `learnExits` 為 on 才作用，預設 off，關著時路線與指令和以前完全一樣）：`state.learned` 是 `mapHuntExits`（`{ "區域/房間": { exits: [指令]|null, to: { 指令: 房間鍵|"out" } } }`，`deps.exits`／`deps.saveExits` 讀寫，`normalizeLearned` 過濾壞資料）。`inspect` 的 `l` 與 `learnHere`（路線要走的邊沒實測、房間出口沒讀過時先 `l` 一次，每個房間每次巡怪一次）`learnExits`；每次移動到的房間 `learnEdge` 記 `to`（落在地圖外的房間記 `out` 並 `backOut` 用 `OPPOSITE` 走回來，沒有反方向就停止並警報）。`buildGraph(strict)` 組路線用的圖：實測的邊覆蓋圖示、`out` 的邊拿掉、strict 時已知出口的房間只留出口裡有的指令；`plan` 先用 strict 圖，只有 loose 圖（純圖示的猜測）走得到、而第一步在已知出口裡找不到時才 `startTrial`，`trialTick` 在 `state.tried` 沒試過的出口裡一個一個試（`enoughQi` 氣夠才試，不主動試路線以外的出口），走到地圖上的任何房間就記 `to` 並重算，全試完 `skipTarget(…, '試不出路')`。讀不到房間要多等一倍的逾時才當成走到地圖外（地圖捲動可能慢）；`out` 只在記下它的那一輪有效（`forgetOut` 在 `start()` 清掉）；移動逾時重送過（`state.tries > 0`）就不記連線（第一次可能只是慢到）；`save` 逐房間合併進當下的儲存（`state.dirty`、排隊），不整份蓋過；試出口與走回來每一步前都要 `enoughQi`，`pick` 等氣超過 `QI_WAIT_TICKS` 就略過目標。這個流程只在 jsdom 假的世界驗證過，真實遊戲的出口行文字與走出本區後 `#map_anchor` 的行為要實測。
- 輪與輪之間（`endRound`／`calibrate`／`beginRound`／`waitTick`，設定 `loopRounds` 預設 on；off 或這一輪什麼都沒處理就照舊 `finish`（第 2 輪以後沒處理要警報），測試的 `REQUIRED` 預設 off 才不用改既有的測試）：開著時 `start()` 先 `readOffset`（`deps.ask('time', 'time')`、`Parse.parseTime`，偏差＝伺服器時間 − `deps.now()`；`content.js` 注入 `Date.now`，測試可換掉視窗的 `Date.now` 做假時鐘），讀不到就不開始。時間都是伺服器時間：`state.after` 是「這一輪打下來的怪從什麼時候起重生」——馬上開始的（按開始、或掃描太久已過）＝現在加提早秒數，等待之後開始的＝它等的那個重生本身（精確的整點，不能用算出來的時間，否則偏差差一點就把同一個重生又算一次）；下一個重生＝`after` 之後的第一個 15 分鐘整點，開始時間＝它減提早秒數。`plan` 找不到目標時 `endRound`：送 `standbyCommand`，`phase` 為 `standby`，待命指令是巨集就等 `deps.macroRunning()` 為 false 才 `calibrate`（送 `time`、讀不到停止並警報）；開始時間已過就直接 `beginRound`（重設目標、略過清單、計數，`allTargets`／`baseSkipped` 是開始時固定下來的），否則 `phase === 'wait'` 等待，`waitTick` 在 `vitals` 之後看時鐘。等待中距開始時間不到 30 秒（或電腦時鐘被調過、估計已經到了）而上次校準超過 20 秒，就重新校準，開始前最近一次校準不能超過 60 秒，所以時鐘被校正也不會提早或延後。等待沒有送指令，不會觸發無回應看門狗（它只在送出指令後才計時）。`time` 的輸出格式在真實遊戲驗證過（`tests/fixtures/hunt/time.txt`），等待的長度只在假時鐘下驗證。
- 自動修正位置（`inspect` 的 `learnPlaces`、`map-collect.js` 的 `visit`／`MISS_LIMIT`，`deps.learnVisit` 由 `content.js` 注入、直接讀寫 `mapMonsters`）：第一次 `l`（到房間時那次，不是打完之後重數的）看到的怪補進這間；勾選的怪記在這間卻沒看到，`miss` 累計一次，連續 `MISS_LIMIT`（3）次就從 `mobs` 拿掉，內建資料裡有的另外記進 `gone`（`withBuiltin` 讀取時扣掉，內建資料仍不寫回）；看到會恢復、`merge`（手動蒐集）也會清掉 `gone`／`miss`。房間是巡怪確認走到的，不會有手動蒐集時地圖還沒捲動的誤判。只數勾選的怪，其他怪沒被驗證。停止時 `state.fixed` 寫進面板訊息；存不進去不影響巡怪。
- 功能開關：`chrome.storage.local.zapFeatures.hunt`（缺值＝關閉，設定頁 `featureHunt`，和其他輔助功能同一個 `FEATURE_BOXES`）。`content.js` 的 `applyZapFeatures` 控制 `.hunt-line` 的 `hidden`（關著時整列藏起來、選怪清單 `.hunt-pick` 也收起來；從開變關時正在巡的 `hunt.stop`）。引擎與 `deps` 不看這個開關，只有面板的入口被藏起來；測試底座不需要打開它（藏起來的按鈕仍可程式點）。
- 負重（`checkLoad`／`unloadTick`，設定 `loadMaxPercent` 預設 90、0＝不檢查，`unloadCommand` 由使用者自己寫成巨集，工具不內建回去、驗無名、賣東西的流程）：`fightRoom` 每打完一隻設 `state.loadDue`，`plan` 開頭看到就 `checkLoad`（`deps.ask('i', 'inventory')`，`ASK` 表多一個 `inventory`，`Parse.parseLoad` 讀「載重 N%」，讀不到就不檢查）；超過就 `deps.send(unloadCommand, onSent)`（走 `queueCommand`，含 `;`／`@等待` 是 `hunt` 的巨集，停止時會取消），`phase` 為 `unload`，`unloadTick` 等 `onSent` 之後且 `deps.macroRunning()` 為 false 再看一次；`unloadTries` 連續兩次還是超過、或沒寫指令，就 `finish` 警報。檢查在「整個房間」打完之後（同房間還有怪會先打完）。測試底座的 `REQUIRED` 預設 `loadMaxPercent: 0`。
- `map-hunt-ui.js`：面板「巡怪」列的「選怪」按鈕與勾選清單（`attach(root, deps)`，列出 `mobsOfArea`＝目前顯示區域蒐集到的怪），勾選依區域存在 `chrome.storage.local.mapHuntPicks`（`{ 區域代號: [名稱(ID)…] }`），`pickedFor`、`visibleArea` 給 `content.js` 的 `target` 用；地圖視窗的下拉選單（`map-collect.js`）不參與選怪。這個模組要加進 manifest 與 popup 備援注入的 `files`（在 `map-hunt.js` 之後）。
- 接線在 `content.js`：`hunt` 要在 `active()` 裡算（送出佇列與看門狗才會作用）、`stopEverything` 與 `retire` 都要停它、指令用 `queueCommand(命令, 'hunt')`（停止時 `dropQueue('hunt')` 加 `cancelMacros('hunt')`）、`STATUS` 回 `hunt`；面板「巡怪」列的錯誤用 `alert` 顏色。測試在 `tests/map-hunt.test.js`（整個 content script 在 jsdom，假地圖與假遊戲）與 `tests/map-hunt-settings-ui.test.js`；jsdom 算不出排版，真實的房間判斷（anchor 置中）只能在真實頁面驗證。
- **改檔案行尾要小心**：`content.js`、`popup.js`、`popup.html`、`CLAUDE.md`、`README.md`、`CHANGELOG.md` 都是 CRLF，用 `sed -i` 或只比對 LF 的字串取代會把整個檔案轉成 LF（diff 變成上千行）；改完要看 `git diff --stat`，用 Node 取代時要先偵測並保留原本的行尾。

## 聊天回覆

- 規格與票在 `.scratch/chat-reply/`（不進 git）。`chat-reply.js`（純函式，manifest 與 popup 備援注入都要載入，在 `content.js` 之前）：`parseLine` 認三種私聊行——來訊 `[P]暱稱回答你：內容`、我的回覆 `[P]你告訴暱稱：…`（tell）與 `[P]你回答暱稱：…`（reply）；`>` 開頭的回聲與公開 `[P]你說道：` 不算。`createRecorder` 只處理已收到換行的完整行（輸出分批到、行會被切開），沒有換行的最後一行留到下一批（行被切開時不會記下半句）；每個暱稱記最後一句來訊，`PAIR_WINDOW_MS`（2 分鐘）內我回同一個暱稱就配成 `{ said, reply, at }`，回覆含分號或 `@等待` 的不收（會被當巨集；不安全的回覆不會吃掉待配對的來訊，之後乾淨的回覆仍配得上；空的來訊會清掉這個人之前那句）。回覆是打指令時的單行文字，不另外處理換行。`addPair` 同一組 said+reply 不重複、只留最新 `MAX_PAIRS`（500）筆。
- 資料管理（設定頁同一區塊）：`exportText`／`parseImport`／`mergeImported` 是純函式（在 `chat-reply.js`）。格式一行一筆「說 Tab 回」、舊的在前；`parseImport` 整份通過才回 `{ ok: true, pairs }`（兩段都和 `exportText` 一樣把連續空白壓成一個，往返才一致），否則回說明第幾行的 `error`，設定頁不通過就什麼都不寫；`mergeImported` 把匯入的接在後面當最新（`at` 從匯入時刻遞增）、重複的組略過、超過 `MAX_PAIRS` 丟最舊，`dropped` 是被擠掉的原本資料、`trimmed` 是匯入的比上限還多而沒收的（`added` 不含它），兩者分開回報。設定頁的刪除、匯入、清除是讀改寫 `chatPairs`，沒有和遊戲頁的寫入佇列協調：兩次動作之間遊戲頁剛好記了一筆，那筆可能被蓋掉、剛刪的也可能復活（Chrome 儲存沒有原子的讀改寫，視窗很小），這是已知限制。清單新的在前，刪單筆以 said＋reply 比對（不用索引，清單可能剛被遊戲頁更新），清除前 `confirm`；popup 監聽 `storage.onChanged` 重畫，所以遊戲頁新記的會即時出現。
- 設定頁「聊天回覆」區塊（`sec-chat`，欄位 `chatReplyOn`／`chatThreshold`／`chatCooldown`／`chatPerHour`，popup.html 要載入 `chat-reply.js`）每次 `change` 把四欄位交給 `normalizeSettings` 存成一個 `chatReply` 物件並把正規化後的值寫回欄位；測試在 `tests/chat-reply-settings-ui.test.js`。
- 自動回覆：設定 `chrome.storage.local.chatReply`＝`{ enabled, threshold, cooldownSec, perHour }`（`normalizeSettings`：預設關、只有 `true` 才開、門檻預設 0.5 限制在 0.1～1），`content.js` 啟動時讀、`storage.onChanged` 即時生效。`createRecorder` 的 `onIncoming` 每收到一句非空的來訊就呼叫 `answerChat`：`worthAnswering`（至少兩個字、不是 `>` 回聲）→ `bestReply`（`similarity`＝去標點空白後相鄰兩字的 Dice 係數；只看回覆安全的資料，最高分達門檻才回，同分隨機）→ `replyDelayMs`（3～10 秒）後用 `startMacro('reply 文字', 'chat')` 送出（巨集在跑算 `active()`，閒置時也送得出去，停止一切與驗證碼會取消它）。回覆含 `;` 或 `@等待` 的資料一律不送。等待中的回覆記在 `chatTimers`，關掉開關、`stopEverything`（含驗證碼）、`retire` 都會取消；要在閒置時送得出去所以不走 `queueCommand`。

- 限制（`createLimiter`，`take`／`confirm`／`refund`／`noteSent`／`isOwn`；`now` 可注入）：設定多 `cooldownSec`（同一個人的冷卻，預設 60，上限 3600）、`perHour`（全部滾動一小時上限，預設 10）；`take(名字, 文字, 設定)` 依序檢查每小時上限、同一個人的冷卻、同一個人同一句話 `REPEAT_MS`（10 分鐘，比對去標點空白），可以回就預約（同一個人緊接著來的第二句才擋得住）並回票，不行回 null（被拒絕的不占額度）；在 `bestReply` 找到回覆之後才 `take`。送出的那一刻 `confirm`（冷卻與額度改從送出算起），沒送出（被取消、驗證碼辨識中或 `stopReason` 含「驗證」、`startMacro` 回 false）就 `refund` 把額度還回去；等待中的回覆記在 `chatTimers`（計時器 → 票），取消時一併還。送出成功才 `noteSent`，遊戲回印的「你回答…」行由 `createRecorder` 的 `isOwn` 認出（去標點空白後比對、只認一次、`OWN_MS` 5 分鐘內），不記成資料，那個人的來訊也清掉。驗證碼辨識中那一刻的檢查沒有單獨的測試（要模擬整個驗證碼流程）。

- `content.js` 的 `feedChat` 在 `captchaObserver` 的停止關鍵字之後呼叫（閒置時也記），寫 `chrome.storage.local.chatPairs`，寫入排成一條佇列（讀改寫不能交錯）、連不上儲存就當沒記到；記錄一律進行，不受自動回覆的開關影響。測試在 `tests/chat-reply.test.js`。

## 在線獎勵

- `content.js` 的 `watchReward` 由 `captchaObserver` 在每一批新增文字（驗證碼分支之前）呼叫：看到「在線獎勵： N分鐘後可領取」（自己打 `sc` 的輸出）就用 `setTimeout` 排 N+1 分鐘後 `sendCommand('reward')`；`rewardTimer` 有值就忽略新的（等待與重試期間都算）。**不走送出佇列**：佇列只在 `active()` 時送，閒置時會卡住；`sendCommand` 自己會擋驗證碼辨識中與因驗證停止，送不出去隔 `REWARD_RETRY_MS` 再試、最多 `REWARD_TRIES` 次。開關是 `chrome.storage.local.autoReward`（缺值＝開，設定頁「在線獎勵自動領取」，`storage.onChanged` 即時生效、關掉會取消等待中的）；`retire()` 會取消。面板「獎勵」那一行（`rewardView`、`rewardSummary`，每秒隨 `renderPanel` 更新，沒有排計時就隱藏）顯示倒數與重試狀態。領獎出現的驗證碼由既有的自動辨識處理。計時只存在頁面裡，重新整理就沒了。測試在 `tests/online-reward.test.js`。

## 商人裝備資料庫

- `shop-collect.js`（和 `map-collect.js` 一樣自成一體：純函式匯出加遊戲頁的觀察器；manifest 與 popup 備援注入都要載入，在 `zap-equipment.js` 之後；popup.html 也載入它來取 `rows`）：**check 要付錢，只由玩家自己打，工具絕不代送**。觀察 `#content` 新增文字：出現「你付了一筆錢給商人」就把之後 `ARM_MS` 內的新文字都接上去（輸出可能分批），靜止 `SETTLE_MS` 後用 `zap-equipment.js` 的 `parseEquipmentBlocks`（check 輸出和鑑定後的裝備同一種「此物名曰」區塊）解析，以名稱為鍵存進 `chrome.storage.local.shopItems`（不分店、同名後讀的覆蓋；沒有那句話的「此物名曰」區塊不記，避免把自己穿的、鑑定出來的裝備當成商品）。
- **整個功能（蒐集、回報、摘要）由 `zapFeatures.shop` 控制，缺值＝關閉**（開關放在設定頁「裝備資料庫（商人 check）」那一塊的最上面，id 是 `featureShop`，和另外三個輔助功能一樣靠 `FEATURE_BOXES` 存進 `zapFeatures`）；check 之後在輸出下面插一行 `showRecorded` 回報記了哪件、沒記到也要說（不然看不出是沒記還是沒反應）。
- **資料庫裡可靠的只有類別與佩帶經驗（等級）**：同名裝備的傷害、屬性不一定相同（使用者指出），所以 list 的推薦（`evaluate`）只看等級——穿得了（`needExp` ≤ 目前經驗）、且比現在穿的同類別裡佩帶經驗最低的那件高的放 `suggest`（建議 check，高到低排），經驗不夠、不比現在高、沒有基準的只計數；**不要再用資料庫裡的傷害／屬性判斷好壞**。實際好壞靠 check 之後 `judge` 用「那次 check 的區塊」和身上的比（`compareEquipment`），並用 `sameStats` 提醒同名數值和舊資料不同。批次 check 有「建議的」與「還沒蒐集的」兩個按鈕。
- 值得換的裝備旁的「買 編號」（`buyOne`）：批次彙整的每件 good、手動 check 後 `classify` 為 good 的，附一顆點了直接送 `buy 編號` 的按鈕（不再確認，和快速購買同一個決定，不能放寬）；編號靠 `listed(name)` 從累計的 list（`session`）以名稱找，找不到就不附（手動 check 沒打過 list 時沒有按鈕）。
- 快速購買（`buyAll`）：list 裡名稱和 `chrome.storage.local.shopBuyNames`（字串，用、、逗號或分號分隔，缺值＝`DEFAULT_BUY_NAMES`，空字串＝不出現）一樣的商品，在摘要下面一顆「買全部符合的 N 件」按鈕（累計的各頁一起算，沒有數量欄），**點了就用 sender 一次送 `buy 編號;buy 編號…`（每個符合的編號買一次），不再確認（使用者明確要求「一按 buy」，這是少數不經確認就花錢的入口，改動時不能再放寬）**；遊戲的 buy 不能帶數量，所以每個編號買一次，一次最多 `BUY_MAX` 個編號（超過的註明沒包含），用 `;` 接起來交給巨集。
- 不 check 名單（`chrome.storage.local.shopSkipNames`，字串，缺值＝`DEFAULT_SKIP_NAMES`＝赤兔馬、白馬、烏黑駒、自由行走的花的赤兔馬，空字串＝都不略過）：名稱**含有**其中任何一個詞的商品（`evaluate` 的 `skip`）整個排除——不進批次、不算沒蒐集、不算 `total`，只在摘要加一行「略過 N 件」；整頁都被略過時摘要只剩那一行。比對用 `includes`（所以填「赤兔馬」就涵蓋「自由行走的花的赤兔馬」），和快速購買名單的「完全相同」不同。
- 沒資料的商品價格低於 `chrome.storage.local.shopMinPrice`（單位 S，缺值＝`DEFAULT_MIN_SILVER`＝5，0＝都 check，設定頁「裝備資料庫」那一塊的輸入框）就不進批次與費用預估（`evaluate` 的 `minPrice`、`cheap`；`unknown` 仍含全部沒蒐集的，`unknownItems` 才是過濾後要 check 的）；只過濾「還沒蒐集的」，被建議的與讀不到價格的不過濾。
- 批次 check 彙整（`beginBatch`／`collectBatch`／`finishBatch`）：玩家按「確認送出」才登記一批（`batchRun`），之後收到的 check 照常記進資料庫，但**不回報每一條**（`showRecorded` 只給手動 check；上一批還沒收完又按「下一批」就併成同一份彙整，不提早結束前一批），用 `classify`（`judge` 的結構化版本，kind 是 good／blocked／nobase／other）累計，全部到齊或 `BATCH_QUIET_MS` 沒新的回應就印一塊彙整，只列 good（編號、名稱、價格、比較行），其他只計數；check 輸出和清單項目用名稱對回編號與價格。
- list 好幾頁累計（`session`）：輸出有「商人現在有賣以下貨物」開頭就重新開始，沒有開頭的頁（編號接著數）併進目前這一次（以編號為鍵），超過 `SESSION_MS` 沒新的頁也重新開始；每一頁的摘要是累計的，新的出現時舊的那塊拿掉（批次按鈕只留最新一組，才不會重複送）。`batchControls` 超過 `BATCH_MAX` 時分批，記住 `offset`，送完一批出現「下一批」。
- 出現 `價格：` 的 list 輸出由 `parseList` 解析（一行兩項，名稱沒有空白，`[百勝刀]` 的方括號保留），在 list 那一頁（最後新增的節點）後面插一個 `data-catworld-shop` 的摘要方塊（`evaluate`＋`summaryLines`）：用目前經驗（`#exp`）與 `wornEquipment[角色]` 的基準（見上一條）比等級；資料庫沒有的列為「還沒蒐集」，批次 check 按鈕送它們（沒有複製指令的按鈕，已拿掉）。摘要與蒐集同一個開關；「批次 check」按鈕（`batchControls`）先顯示個數與預估費用，玩家按「確認送出」才呼叫 `sender`（`content.js` 啟動時用 `setSender` 注入 `startMacro(text, 'shop')`，所以遵守指令間隔、驗證碼偵測、`cancelMacros` 停止），一次最多 `BATCH_MAX` 個；**check 要付錢，沒有玩家按確認絕不能呼叫 sender**。遊戲一般的指令列不收分號，`checkCommand` 的 `;` 串只有交給巨集執行器（`sender`）才送得出去；自己插入的節點要從觀察器排除（`isOwn`），否則會無限循環。連不上儲存（孤兒程式）就停止觀察。
- 摘要的「還沒蒐集」下面有 check 預估費用（`parsePrice` 讀 `1G40S`／`16S50C`／`30C`，1G＝100S、1S＝100C；`checkCost`：下限是價格 5% 的總和、上限再多 5%，因為實測 30C→1C、2S→10C、19S→1S、1G40S→7S、某 86S 的→4S50C，大致 5% 但有幾筆多一點、進位規則不明，只能當範圍，改估法要先有新的實測）。設定頁「裝備資料庫（商人 check）」只顯示件數、複製 Tab 分隔文字（名稱、類別、主要數值、佩帶經驗、屬性）、清除；併進共用表的格式還沒定。非裝備的商品（食物、雜物）check 後不會有區塊：`flush` 用 `nonEquipmentNumbers`（編號取自指令回聲 `> check N`，第一個找不到時用 buffer 開始前最後一次回聲 `priorEcho`；找不到編號不學）加上累計 list 的編號對回名稱，記進 `chrome.storage.local.shopNonEquip`（名稱陣列）；內建的 `BUILTIN_NON_EQUIPMENT` 與它合併成 `nonEquipSet`，`evaluate` 的 `nonEquip` 精確比對名稱排除（不算件數與沒蒐集，摘要多一行略過）；同名之後 check 出裝備區塊就從陣列移除。測試在 `tests/shop-collect.test.js`。

## 內建資料（地圖怪物、商人裝備）

- `docs/data/map-monsters.tsv`、`shop-items.tsv` 是來源，由 `tools/gen-map-data.js`、`tools/gen-shop-data.js` 產生 `catworld-auto-command/map-data.js`（`globalThis.CatworldMapData`）與 `shop-data.js`（`CatworldShopData`），**不要手改產生的檔案**；產生腳本在筆數異常少（< 50）或格式不對時失敗、不覆寫。兩個檔案都要加進 manifest 與 popup 備援注入的 `files`（各排在 `map-collect.js`、`shop-collect.js` 之前）與 popup.html。
- 內建資料**只在讀取時**和個人資料合併（`CatworldMapCollect.withBuiltin`、`CatworldShopCollect.withBuiltin`，個人優先／取聯集），**絕不寫回 `chrome.storage.local`**（寫回會讓「清除」清不乾淨、內建資料更新後被舊的蓋住）：讀 `mapMonsters` 的地方（地圖下拉選單、`zap-panel.js` 的怪物提示）與商人 `flush` 裡交給 `showSummary` 的 `db` 都要包 `withBuiltin`，寫入與 `showRecorded`、設定頁的列數與複製仍只用個人的那份。商人內建資料只有類別與佩帶經驗可靠，list 的建議只看這兩個（同名裝備數值可能不同）。
- 測試底座 `boot()` 預設**不載入**這兩個資料檔（其他測試要自己決定房間與商品），`boot({ builtin: true })` 才載入；`tests/builtin-data.test.js` 比對產生的檔案與 TSV 一致。

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
- 設定頁的項目多，全部用摺疊收起來：下方各個設定區塊、定時分頁的固定／隨機指令、各組的「命中後隨機延遲」與「安全機制」都是帶 `id` 的 `<details class="fold">`（預設收起；`id` 是記住展開狀態的鍵，新增區塊一定要帶）；展開狀態存在 `chrome.storage.local.popupFolds`（`{ id: 是否展開 }`，`toggle` 事件不冒泡，所以在 document 用捕獲階段聽，每次存全部）。固定／隨機指令的標題由 `updateItemSummary` 寫成「固定指令（N 項）：指令…」。觸發規則卡片（`ruleCard`、`keywordCard`）收成標頭加一行摘要，其餘欄位放在 `.rule-body`（`foldRule`）：**`#rules-<組>` 的子節點必須仍然是卡片本身，`readSettings` 靠 `data-f` 在卡片裡找欄位，收起來的欄位照樣會被讀與存**；沒填內容的規則（`isBlank`）與按「＋」新增的規則直接展開。測試在 `tests/settings-fold-ui.test.js`。
- 設定頁沒有儲存鈕，每改一個欄位就存進 storage（`root.addEventListener('change', save)`）；遊戲頁的 `settings` 與 `group.config` 只在載入時讀一次，所以面板的「開始」（定時、各組觸發）按下去要先重新讀 storage 再開始，不然跑的是改之前的舊設定（測試 `tests/panel-start-fresh-settings.test.js`）。

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
