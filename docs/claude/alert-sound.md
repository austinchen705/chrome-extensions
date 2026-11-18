# 警報提示音

- 驗證碼警報的響鈴有兩種模式，由 popup 的開關 `persistentAlert`（`chrome.storage.local`，預設 false）決定，`content.js` 啟動時讀取並監聽 `storage.onChanged`，改了馬上生效。關閉＝原本的行為（最多 5 分鐘、互動或按開始就停）；開啟＝`ringing` 為 true，只有 `confirmAlert()`（面板「確認」、通知上的按鈕送來的 `CONFIRM_ALERT`）能停。
- 判斷「互動或按開始要不要停提示音」都看 `ringing`（`flashTitle` 的 `clear`、`armDetection`），新增會停提示音的路徑也要遵守；只有 `stopAndAlert`（驗證碼）會進 `ringing`，`alertOnly`（規則被停用）永遠只響一次。
