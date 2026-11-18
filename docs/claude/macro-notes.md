# 巨集備註

- `macro-notes.js` 在遊戲巨集視窗每一列最後多放一個 `input.note`，備註存在 `chrome.storage.local.macroNotes`（綁列號 1～90），樣式在 `macro-notes.css`（manifest 的 `content_scripts[].css`；popup 的備援注入要 `insertCSS`）。備註框一定要放在指令框**後面**：遊戲的 `on_macro_key_down` 讀的是按鍵框的 `nextSibling`（指令框）。
- 遊戲自己的樣式表比 extension 的樣式晚載入，優先權相同會被它蓋掉（`#macro_table { width: 435px }`），所以樣式要加一層 `body`。jsdom 測不出這種問題，樣式相關的改動要用真實頁面驗證。
- `storage.onChanged` 在「寫入的那個頁面」也會觸發，所以寫入時一起存 `macroNotesWriter`（本頁的隨機代號），收到自己寫的通知要忽略，否則會用舊內容蓋掉還沒存的編輯（測試 21a 會擋）。
