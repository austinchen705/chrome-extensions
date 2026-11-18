# 無名物品

- 資料是 `zap-data.json` 的 `items`，由 `tools/gen-zap-data.js` 從 `ub.htm` 解析（`tools/zap-parse.js` 的 `parseUnknownObjectHtml`）。`ub.htm` 有三張表，LV 在帶 `rowspan` 的儲存格往下列沿用：第 1 張只有名稱、第 2 張是名稱＋功能、第 3 張是名稱＋武器效果＋防具效果；解析結果少於 30 筆時產生腳本會失敗、不覆寫。
- `zap-items.js` 不碰 DOM，與 `zap-mobs.js` 一樣要同時加進 manifest、popup.html、popup 備援注入的 `files`，且在 `zap-panel.js` 之前。background 的 `ZAP_ITEM` 與怪物查詢共用同一份懶載入資料。
- 鑑定句只在先看到「你拿著…給衰老頭看了一下」（60 秒內，狀態 `handState` 在 `zap-panel.js`）後才處理 `衰老頭給你<量詞><名稱>。`；比對鍵去掉括號與空白、同鍵多筆全列；建議：相關武器類型（`chrome.storage.local.mainWeapon`）→ 適合你，其餘 LV3 以上留著、LV1～2 賣掉。鑑定後的裝備（「此物名曰」區塊）不處理。
- 比對先用帶洞數的完整名稱，沒命中才用去括號的鍵；名稱必須出現在句子結尾、前面只能是「數詞加至多一個量詞字」（`QUANTIFIER`），否則短名稱會誤配表上沒有的物品。`tools/zap-overrides.json` 帶 `item` 欄位的項目是物品補充（`applyItemOverrides`），其餘是怪物補充。
- 鑑定結果在浮層裡是**累積**的（接在舊結果後面、最多留 8 筆，`addItemResults`），怪物提示則每次整個取代；「提示過」要等查詢成功才記，失敗不能讓同一件被擋 10 秒。
- 查詢失敗不能靜默：背景回 `ok:false` 或 `sendMessage` 丟例外（例如 extension 剛重新載入、頁面還是舊的 content script）都要把原因顯示在浮層（`showFailure`／`addItemNote`），並提示重新整理遊戲頁；雜物鑑定另外在「偵測到交給衰老頭／偵測到鑑定結果」時先顯示小字，沒反應時才分得出是偵測沒動還是查詢失敗。
- 浮層由怪物、雜物鑑定、裝備比較共用，各一個區段、各自的停留時間（`zap-panel.js` 的 `SECTION_MS`：怪物 5 秒、雜物 15 秒、裝備 20 秒），全部區段都空了才隱藏，右上角 ✕ 全部關掉；觀察器每一批新增文字同時交給兩邊，不能因為其中一邊沒內容就跳過另一邊。
