# 數值區塊

- 面板最上方的「數值」區塊由兩個模組組成：`stats-view.js`（不碰 DOM，`rows(readings, exp)` 決定每列顯示什麼）與 `stats-block.js`（畫面，`attach(root)` 回傳 `render(readings, exp)`）。兩個都要加進 manifest 的 content script 與 popup 備援注入清單，`stats-view.js` 在 `stats-block.js` 之前、都在 `content.js` 之前；`content.js` 建立區塊要包 try/catch，壞了不能牽連後面按鈕的綁定。
- 每秒由 `renderPanel` 餵 `readAllStats()` 與 `readGameNumber('exp')`。**數值必須和觸發規則讀同一份**：`readAllStats` 是用引擎的 `readStat` 組出來的，不要另寫一套讀法，否則面板上看到的數字會和觸發判斷用的不一致。順序跟 `trigger-engine.js` 的 `STATS` 一致，經驗排第一。
- 顯示規則：`目前值/上限（百分比）`，百分比照實顯示可超過 100%（內力、靈力、法力的目前值可以超過上限，原因與公式遊戲說明站沒寫，只顯示不解讀），但目前值小於上限時最多顯示 99%（四捨五入會讓 1451/1452 變 100%，誤導成滿了）；讀不到顯示 `—`，上限為 0、負數或讀不到時不顯示百分比；經驗只有目前值。每一項數字的顏色不自己算門檻，由 `content.js` 的 `STAT_COLOR_IDS` 讀遊戲各欄位外層元素（`gin_w1`、`kee_w1`…）此刻生效的顏色（遊戲 `vitals.js` 依滿度換色），經 `themeFrom` 的 `values` 套用；讀不到就沿用文字色。
- 收合狀態記在 `chrome.storage.local.statsCollapsed`，預設展開；讀到的狀態只在玩家還沒動過時才套用（晚到的讀取不能蓋掉玩家剛點的），讀不到維持展開，存不進去不影響收合。面板可能被搬進置頂浮窗（另一個 document），事件綁在節點上、樣式在 shadow root 裡，搬過去仍然有效。**不要搬或改遊戲的狀態視窗（`#monitor`）**，這裡只是另外顯示一份。
- **只在置頂浮窗裡顯示**：樣式 `:host(:not([data-pip])) .stats { display: none; }`，主面板看不到（遊戲的狀態視窗本來就有）；只用樣式隱藏，所以收合狀態與每秒更新照舊，按「置頂」的當下數字就是最新的。
- **配色跟遊戲的狀態視窗（`#monitor`）一樣**：深色底、虛線淺色邊框、遊戲的文字色、經驗用 `#exp` 自己的顏色。遊戲的顏色是由 `html` 上的主題 class（`XTerm`、`VGA`、`Mac`…，定義在遊戲的 `ansi.css`）決定的，會隨使用者設定的色彩主題與「半透明」變，**不能把某個主題的色碼寫死**：`content.js` 的 `readMonitorTheme` 每秒讀 `#monitor` 與 `#exp` 的 `getComputedStyle`，經 `themeFrom`（只收 `rgb()`／`rgba()`／十六進位，其他字串、空的、全透明都退回預設，因為它會被放進 style）算出配色，再 `setTheme` 放進 CSS 變數（`--stats-bg`、`--stats-border`、`--stats-fg`、`--stats-exp`）；預設值是遊戲預設的 XTerm 主題。找不到元素要給空的讓它退回預設，不能讓更新出錯。
- 測試：`tests/stats-view.test.js`（格式化）、`tests/stats-block.test.js`（jsdom 畫面、配色與串接檢查；jsdom 算不出 shadow DOM 的 `:host` 樣式，「主面板看不到、置頂才看得到」只能手動驗證）。
