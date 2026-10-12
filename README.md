# chrome-extensions

個人的 Chrome extension（Manifest V3）。目前有：

- `catworld-auto-command`：小貓的世界自動指令，遇到驗證碼自動停止並提醒。

## 安裝

需要 Node.js 16.7 以上與 git。

```sh
npx github:austinchen705/chrome-extensions
```

會把 extension 複製到 `~/chrome-extensions/<名稱>`（Windows 是 `C:\Users\<你>\chrome-extensions\<名稱>`），並嘗試開啟 `chrome://extensions`。接著在 Chrome 手動做兩步：

1. 右上角打開「開發人員模式」。
2. 第一次按「載入未封裝項目」選擇上面的資料夾（路徑會複製到剪貼簿）；之後更新則按卡片上的「重新載入」。

常用參數：

```sh
npx github:austinchen705/chrome-extensions catworld-auto-command --dir D:\tools\catworld --no-open
```

- `--dir <路徑>`：改裝到指定資料夾。
- `--no-open`：不要自動開啟 `chrome://extensions`。

## 更新

重新執行同一行指令即可，會顯示「升級：vX → vY」。已安裝的資料夾會被整個換成新版，所以不要把自己的檔案放在裡面。更新後要在 `chrome://extensions` 按「重新載入」，並重新整理遊戲分頁。

## 為什麼最後一步要手動

Chrome 沒有給程式靜默安裝未上架 extension 的正式管道，近年的正式版也限制了命令列載入 extension 的旗標，所以安裝腳本只負責「把最新檔案放到固定位置並引導你載入」。

## 不用 Node 的做法

到 GitHub 下載 repo 的 ZIP 或 `git clone`，解壓後在 `chrome://extensions` 用「載入未封裝項目」選 `catworld-auto-command` 資料夾。
