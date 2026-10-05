# chrome-extensions

每個子資料夾是一個獨立的 Chrome extension（Manifest V3，unpacked 載入），資料夾內以 `manifest.json` 為入口。

## 版本號

- 每次改動 extension 的任何檔案，都要同步升該 extension 的 `manifest.json` `version`：小修正升 patch、新功能升 minor。
- popup 上的版本顯示一律讀 `chrome.runtime.getManifest().version`，不要另外寫死。
- 改完要提醒使用者：到 `chrome://extensions` 重新載入 extension，並重新整理目標分頁，content script 才會更新。
