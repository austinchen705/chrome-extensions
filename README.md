# chrome-extensions

個人的 Chrome extension（Manifest V3）。目前有：

- `catworld-auto-command`：小貓的世界自動指令，遇到驗證碼自動停止並提醒。

## 安裝（不需要 Node / git）

Windows 打開 PowerShell，貼上：

```powershell
irm https://raw.githubusercontent.com/austinchen705/chrome-extensions/main/install.ps1 | iex
```

macOS / Linux 打開終端機，貼上：

```sh
curl -fsSL https://raw.githubusercontent.com/austinchen705/chrome-extensions/main/install.sh | sh
```

腳本會下載最新版、複製到 `~/chrome-extensions/<名稱>`（Windows 是 `C:\Users\<你>\chrome-extensions\<名稱>`），並嘗試開啟 `chrome://extensions`。接著在 Chrome 手動做兩步：

1. 右上角打開「開發人員模式」。
2. 第一次按「載入未封裝項目」選擇上面的資料夾（路徑會複製到剪貼簿）；之後更新則按卡片上的「重新載入」。

`irm ... | iex` 與 `curl ... | sh` 都是下載後直接執行，只對你信任的來源這樣用；不放心的話先把 `install.ps1`／`install.sh` 打開看過再跑。

環境變數（都可省略）：

| 變數 | 作用 |
|---|---|
| `CHROME_EXT_DIR` | 改裝到指定資料夾 |
| `CHROME_EXT_NAME` | 指定 extension（預設 `catworld-auto-command`） |
| `CHROME_EXT_NO_OPEN=1` | 不要自動開啟 `chrome://extensions` |

PowerShell 設定方式：`$env:CHROME_EXT_DIR = 'D:\tools\catworld'` 之後再貼上面那行；macOS / Linux：`CHROME_EXT_DIR=~/tools/catworld curl -fsSL … | sh`。

## 更新

重新貼同一行指令即可，會顯示「升級：vX → vY」。已安裝的資料夾會被整個換成新版，所以不要把自己的檔案放在裡面。更新後要在 `chrome://extensions` 按「重新載入」，並重新整理遊戲分頁。

## 為什麼最後一步要手動

Chrome 沒有給程式靜默安裝未上架 extension 的正式管道，近年的正式版也限制了命令列載入 extension 的旗標，所以安裝腳本只負責「把最新檔案放到固定位置並引導你載入」。

## 其他安裝方式

### 已經有 Node.js 與 git：npx

```sh
npx github:austinchen705/chrome-extensions
```

參數 `--dir <路徑>` 指定資料夾、`--no-open` 不開 `chrome://extensions`。更新時重跑同一行；若顯示的版本號沒變，是 npx 用了快取的舊版，到 `npm config get cache` 顯示的資料夾，刪掉 `_npx` 底下 `package.json` 含 `austinchen705/chrome-extensions` 的那個資料夾再重跑。

沒有 Node.js 與 git 時：

```sh
# Windows（PowerShell）
winget install OpenJS.NodeJS.LTS
winget install Git.Git

# macOS
brew install node
xcode-select --install
```

裝完關掉再重開終端機，用 `node -v`、`npx -v`、`git --version` 確認（Node 16.7 以上）。

### 完全手動

到 GitHub 下載 repo 的 ZIP，解壓後在 `chrome://extensions` 用「載入未封裝項目」選 `catworld-auto-command` 資料夾。更新時重新下載並覆蓋舊資料夾，再按「重新載入」。
