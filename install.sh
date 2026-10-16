#!/bin/sh
# 不需要 Node / git 的安裝與更新腳本（macOS / Linux）：
#   curl -fsSL https://raw.githubusercontent.com/austinchen705/chrome-extensions/main/install.sh | sh
# 環境變數（可省略）：CHROME_EXT_NAME 指定 extension、CHROME_EXT_DIR 指定安裝資料夾、CHROME_EXT_NO_OPEN=1 不自動開啟 chrome://extensions
set -eu

name="${CHROME_EXT_NAME:-catworld-auto-command}"
case "$name" in
  *[!A-Za-z0-9._-]*|'') echo "extension 名稱不合法：$name"; exit 1 ;;
esac
target="${CHROME_EXT_DIR:-$HOME/chrome-extensions/$name}"

version_of() {
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1/manifest.json" 2>/dev/null | head -n 1
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo '下載最新版本…'
curl -fsSL -o "$work/repo.zip" 'https://github.com/austinchen705/chrome-extensions/archive/refs/heads/main.zip'
if command -v unzip >/dev/null 2>&1; then
  unzip -q "$work/repo.zip" -d "$work"
else
  # 沒有 unzip 時改用 bsdtar（macOS、Windows 內建的 tar 能解 zip）
  tar -xf "$work/repo.zip" -C "$work"
fi

source=''
for dir in "$work"/*/; do
  if [ -f "${dir}${name}/manifest.json" ]; then source="${dir}${name}"; break; fi
done
if [ -z "$source" ]; then echo "找不到 extension：$name"; exit 1; fi

old_version="$(version_of "$target")"
# 只覆蓋「已經是 extension 的資料夾」或空資料夾，避免 CHROME_EXT_DIR 指錯位置時刪到別的東西
if [ -e "$target" ]; then
  if [ -n "$old_version" ]; then
    rm -rf "$target"
  elif [ -n "$(ls -A "$target" 2>/dev/null)" ]; then
    echo "$target 不是空資料夾，也不是 extension，已停止。請改用 CHROME_EXT_DIR 指定其他位置。"
    exit 1
  fi
fi
mkdir -p "$(dirname "$target")"
cp -R "$source" "$target"

new_version="$(version_of "$target")"
echo "已安裝 $name v$new_version → $target"
if [ -n "$old_version" ]; then echo "升級：v$old_version → v$new_version"; fi

# 以下兩個動作只是方便，失敗不影響安裝結果
if command -v pbcopy >/dev/null 2>&1; then printf '%s' "$target" | pbcopy || true
elif command -v xclip >/dev/null 2>&1; then printf '%s' "$target" | xclip -selection clipboard || true
fi
if [ "${CHROME_EXT_NO_OPEN:-}" != "1" ]; then
  if [ "$(uname)" = "Darwin" ]; then open -a "Google Chrome" chrome://extensions >/dev/null 2>&1 || true
  else google-chrome chrome://extensions >/dev/null 2>&1 || true
  fi
fi

if [ -n "$old_version" ]; then
  step3='已安裝過：按該 extension 卡片上的「重新載入」'
else
  step3="第一次安裝：按「載入未封裝項目」，選擇資料夾
     $target
     （路徑已複製到剪貼簿）"
fi
cat <<EOF

接下來在 Chrome：
  1. 開啟 chrome://extensions（沒自動開的話請手動輸入網址）
  2. 右上角打開「開發人員模式」
  3. $step3
  4. 重新整理遊戲分頁，新版才會生效
EOF
