# 安裝腳本

- 三個安裝入口行為一致（只覆蓋已是 extension 的資料夾或空資料夾、顯示「升級：vX → vY」、嘗試複製路徑並開 `chrome://extensions`），改一個要一起改：
  - `install.ps1`（Windows，`irm … | iex`）、`install.sh`（macOS / Linux，`curl … | sh`）：下載 GitHub 預設分支的 ZIP，不需要 Node / git。用 `iex` 執行所以不能 `exit`，要包在函式裡用 `return`。
  - `bin/install-extension.js`（`package.json` 的 `bin`，`npx github:austinchen705/chrome-extensions`）：給已有 Node 與 git 的人。
- 三者都會安裝任一含 `manifest.json` 的子資料夾，新增 extension 不需要改腳本；安裝方式寫在 `README.md`。
