# 孤兒程式與重複面板

- 擴充功能在 `chrome://extensions` 重新載入後，遊戲分頁沒重新整理的話，**舊版 content script 還留在頁面上**（連不上擴充功能的「孤兒」）：它的面板、計時器、送指令的佇列都還活著；而設定頁在 `sendMessage` 收到 `Receiving end does not exist` 時會備援注入一份新的（`popup.js`），新的隔離環境看不到舊的防重複旗標，所以頁面上會有兩個面板、兩份程式同時送指令，驗證碼也可能停不下來（`chrome.runtime.sendMessage` 在孤兒裡會直接丟例外）。
- 對策在 `instance-guard.js`（manifest 與 popup 備援注入都要載入、在 `content.js` 之前）：`contextAlive(chrome)` 看 `chrome.runtime.id` 還在不在，`content.js` 在 `sendCommand`、`renderPanel`、驗證碼觀察器三處檢查，失效就 `retire()`（停掉計時器、觸發與巨集、清佇列、斷開觀察器、關置頂視窗、拿掉面板）；新程式 `initPanel` 一開始 `removeStalePanels` 把殘留的面板（`data-catworld-panel`）與置頂提示條拿掉並關掉殘留的置頂視窗。`stopAndAlert`、`alertOnly` 送通知一律包 try/catch：**停止絕對不能因為通知送不出去而被跳過**。新增會送指令的入口要走 `sendCommand`（已有檢查）。
- 測試：`tests/content-instance.test.js` 在 jsdom 載入整個 content script（manifest 列的所有檔案、假的 `chrome`）；底座要等啟動時的非同步初始化跑完才操作、結束時清掉頁面的計時器（視窗不能 `close()`）。三個檢查入口彼此冗餘，拿掉單一個不會讓測試失敗，這是刻意的雙重保護。
