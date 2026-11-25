# 安裝腳本

- 三個安裝入口行為一致（只覆蓋已是 extension 的資料夾或空資料夾、顯示「升級：vX → vY」（新版較低是「降版」、同版是「重新安裝」，逐段比數字）、嘗試複製路徑並開 `chrome://extensions`），改一個要一起改：
  - `install.ps1`（Windows，`irm … | iex`）、`install.sh`（macOS / Linux，`curl … | sh`）：下載 ZIP，不需要 Node / git。用 `iex` 執行所以不能 `exit`，要包在函式裡用 `return`。沒指定版本下載 GitHub 預設分支（`archive/refs/heads/main.zip`）；指定版本下載 tag（`archive/refs/tags/v<版本>.zip`，tag 名稱是 `v<manifest 版本>`）。
  - `bin/install-extension.js`（`package.json` 的 `bin`，`npx github:austinchen705/chrome-extensions`）：給已有 Node 與 git 的人，複製的是 npx 取得的那份程式碼，所以指定版本靠網址 `#v<版本>`，腳本本身沒有版本參數。
- 指定版本（`install.ps1` 讀環境變數 `CATWORLD_VERSION`，因為 `iex` 收不到參數；`install.sh` 讀第一個參數 `sh -s -- 1.168.0`，沒給再讀 `CATWORLD_VERSION`）：接受 `1.168.0` 或 `v1.168.0`，放進網址前先驗證只有數字與點（可有開頭 `v`），不合法就停。tag 不存在（HTTP 404）報「找不到版本」並停止，不退回最新版。ZIP 解開後的最上層資料夾名稱 GitHub 會去掉 tag 的 `v`（`chrome-extensions-1.168.0`），腳本不寫死資料夾名，找「底下有該 extension 的 `manifest.json`」的那一個。
- 三者都會安裝任一含 `manifest.json` 的子資料夾，新增 extension 不需要改腳本；安裝方式寫在 `README.md`。
