# 設定雲端同步

- 規格與票在 `.scratch/cloud-settings-sync/`（不進 git）。伺服器是獨立的 Apps Script 網頁應用程式 `tools/apps-script/settings-sync.gs`（作者部署，步驟在 `README.md`「設定雲端同步（作者部署）」），每個遊戲角色在作者的 Google Drive 存一個 `<角色>.json`。
- 請求：`POST` JSON `{ action: 'upload' | 'download' | 'info', account, password, payload? }`。回應一律 HTTP 200：`{ ok: true, ... }` 或 `{ ok: false, error }`，`error` 是 `bad-password`、`not-found`、`too-large`、`bad-request`、`server-error`（Drive 讀寫失敗、存檔壞掉）。`upload` 回 `{ updatedAt, claimed }`，`download` 回 `{ payload, updatedAt, exportedWith }`，`info` 回 `{ updatedAt, exportedWith }`；`updatedAt` 是 ISO 字串，`exportedWith` 取自 `payload.settings.exportedWith`。
- `payload` 是 `{ settings, macros? }`：`settings` 是 `catworld-settings` 格式的物件（見設定備份，`format` 必須是 `catworld-settings`），`macros` 可省略、有的話是物件。請求本文超過 1 MB（1048576 字元）回 `too-large`，在解析 JSON 之前檢查。
- 角色名稱：去前後空白、英文大寫轉小寫，只收文字（含中文）、數字、`_`、`-`，長度 1～40，其他一律 `bad-request`。密碼是 1～200 字元的字串。
- 認領：角色檔不存在時 `upload` 建立並存 `salt`（`Utilities.getUuid()`）與 `hash`（SHA-256(salt + 密碼) 的十六進位）；之後 `upload`／`download`／`info` 都比對 `hash`，不對回 `bad-password`。`download`／`info` 對沒有的角色回 `not-found`，不建檔。忘記密碼就由作者在 Drive 刪掉那個角色的檔。
- 資料夾：指令碼屬性 `FOLDER_ID` 有值且開得到（沒被丟進垃圾桶）就用；否則找／建 My Drive 根目錄的 `catworld-settings-sync`，並把它的 ID 存進 `FOLDER_ID`（改名、搬家後仍找得到）。通過檢查的請求整段在 `LockService.getScriptLock()` 下執行。
- 測試：`tests/unit/settings-sync-gs.test.js`（在 vm 用假的 Drive 等服務執行 .gs）。部署後的網址與權限只能由作者實際呼叫驗證。
