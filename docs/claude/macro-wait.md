# 遊戲巨集的 @等待

- 遊戲的巨集是 `command.split(/\s*;\s*/)` 同步全送，沒辦法在遊戲裡加等待。`macro-wait.js`（不碰 DOM 以外的東西）負責鍵值、解析、讀 `#macro_list`；`content.js` 在 `window` 捕獲階段攔下「有 `@等待` 的巨集」自己跑，其餘交給遊戲。manifest、popup 的備援注入都要載入 `macro-wait.js`，且在 `content.js` 之前。
- `macro-wait.js` 的 `KEY_VALUES` 抄自遊戲 `web.js` 的 `key_values`，攔截條件（只在目標是 `#input` 或 `body`）也和遊戲 `document.body.onkeydown` 一致；遊戲改了這兩處要同步（測試會逐項比對 `web.js`）。
- 巨集的指令走共用佇列（`source: 'macro'`），執行中算 `active()`；一個巨集要等最後一個指令真的送出才從 `macroRuns` 移除，否則最後一個指令還在排隊時 `active()` 會變 false 而送不出去。新增會送指令的功能要接 `stopEverything`（驗證碼時一起取消）。
- **送出空白行時不啟動「8 秒沒回應」看門狗**（`sendCommand` 最後的 `armWatchdog` 要 `commandText(command).trim() !== ''`）：遊戲對空白行（指令結尾多的 `;` 讓 `parseSteps` 多出空的段落、或 `<enter>`）只回一個「> 」回聲，`isCommandEcho` 又把它當回聲不算回應，不擋的話 8 秒後會誤判成需要驗證而 `stopAndAlert`。真的指令沒回應照樣會停（`tests/integration/game/blank-line-watchdog.test.js` 兩邊都鎖）。
- 指令裡單獨的 `<enter>` 由 `timer-settings.js` 的 `commandText` 轉成空字串，`sendCommand` 才送出空白行（遊戲收到空字串送純換行＝Enter）；各欄位會濾掉空白指令，所以要用文字代號，新增送指令的入口要走 `sendCommand`。定時（固定、隨機）與觸發的指令經 `content.js` 的 `queueCommand`：含 `;` 或 `@等待`（`CatworldMacro.isSequence`）就交給 `startMacro` 拆開依序送，否則直接排進佇列；巨集記下 `owner`（`timer` 或 `trigger:<組>`），停止定時或該組觸發時只取消自己的（`cancelMacros(owner)`），驗證碼與停止一切才全部取消。新增會送指令的入口要走 `queueCommand`，不要直接 `enqueue` 欄位內容。
- `sendCommand` 代送指令後要還原使用者正在輸入的文字（遊戲送出後會清空或全選輸入框）。
