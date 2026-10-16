# 不需要 Node / git 的安裝與更新腳本（Windows PowerShell 5.1 以上）：
#   irm https://raw.githubusercontent.com/austinchen705/chrome-extensions/main/install.ps1 | iex
# 環境變數（可省略）：CHROME_EXT_NAME 指定 extension、CHROME_EXT_DIR 指定安裝資料夾、CHROME_EXT_NO_OPEN=1 不自動開啟 chrome://extensions
# 用 iex 執行時不能 exit（會關掉使用者的終端機），所以全部包在函式裡，用 return 結束。
function Install-ChromeExtension {
  $ErrorActionPreference = 'Stop'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

  $name = if ($env:CHROME_EXT_NAME) { $env:CHROME_EXT_NAME } else { 'catworld-auto-command' }
  if ($name -notmatch '^[A-Za-z0-9._-]+$') { Write-Host "extension 名稱不合法：$name"; return }
  $target = if ($env:CHROME_EXT_DIR) { $env:CHROME_EXT_DIR } else { Join-Path $HOME "chrome-extensions\$name" }
  $target = [IO.Path]::GetFullPath($target)

  $versionOf = {
    param($dir)
    try { (Get-Content -Raw -Encoding UTF8 (Join-Path $dir 'manifest.json') | ConvertFrom-Json).version } catch { $null }
  }

  $work = Join-Path ([IO.Path]::GetTempPath()) ("chrome-ext-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $work | Out-Null
  try {
    $zip = Join-Path $work 'repo.zip'
    Write-Host '下載最新版本…'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/austinchen705/chrome-extensions/archive/refs/heads/main.zip' -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $work
    $source = Get-ChildItem -Path $work -Directory | ForEach-Object { Join-Path $_.FullName $name } | Where-Object { Test-Path (Join-Path $_ 'manifest.json') } | Select-Object -First 1
    if (-not $source) { Write-Host "找不到 extension：$name"; return }

    $oldVersion = & $versionOf $target
    # 只覆蓋「已經是 extension 的資料夾」或空資料夾，避免 CHROME_EXT_DIR 指錯位置時刪到別的東西
    if (Test-Path $target) {
      if ($oldVersion) { Remove-Item -Recurse -Force $target }
      elseif (@(Get-ChildItem -Force $target).Count -gt 0) { Write-Host "$target 不是空資料夾，也不是 extension，已停止。請改用 CHROME_EXT_DIR 指定其他位置。"; return }
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
    Copy-Item -Recurse -Path $source -Destination $target
  } finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
  }

  $newVersion = & $versionOf $target
  Write-Host "已安裝 $name v$newVersion → $target"
  if ($oldVersion) { Write-Host "升級：v$oldVersion → v$newVersion" }

  # 以下兩個動作只是方便，失敗不影響安裝結果
  try { Set-Clipboard -Value $target } catch { }
  if ($env:CHROME_EXT_NO_OPEN -ne '1') { try { Start-Process chrome 'chrome://extensions' } catch { } }

  Write-Host ''
  Write-Host '接下來在 Chrome：'
  Write-Host '  1. 開啟 chrome://extensions（沒自動開的話請手動輸入網址）'
  Write-Host '  2. 右上角打開「開發人員模式」'
  if ($oldVersion) {
    Write-Host '  3. 已安裝過：按該 extension 卡片上的「重新載入」'
  } else {
    Write-Host '  3. 第一次安裝：按「載入未封裝項目」，選擇這個資料夾（可把路徑直接貼到選擇視窗）：'
    Write-Host ''
    Write-Host "     $target " -ForegroundColor Black -BackgroundColor Yellow
    Write-Host ''
    Write-Host '     （路徑已複製到剪貼簿）'
  }
  Write-Host '  4. 重新整理遊戲分頁，新版才會生效'
}
Install-ChromeExtension
