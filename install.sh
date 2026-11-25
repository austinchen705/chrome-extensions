#!/bin/sh
# 不需要 Node / git 的安裝與更新腳本（macOS / Linux）：
#   curl -fsSL https://raw.githubusercontent.com/austinchen705/chrome-extensions/main/install.sh | sh
# 指定版本：curl -fsSL … | sh -s -- 1.168.0（或 v1.168.0），也可用環境變數 CATWORLD_VERSION；不指定就裝最新版
# 環境變數（可省略）：CHROME_EXT_NAME 指定 extension、CHROME_EXT_DIR 指定安裝資料夾、CHROME_EXT_NO_OPEN=1 不自動開啟 chrome://extensions
set -eu

name="${CHROME_EXT_NAME:-catworld-auto-command}"
case "$name" in
  *[!A-Za-z0-9._-]*|'') echo "extension 名稱不合法：$name"; exit 1 ;;
esac
target="${CHROME_EXT_DIR:-$HOME/chrome-extensions/$name}"

version="${1:-${CATWORLD_VERSION:-}}"
if [ -n "$version" ]; then
  if ! printf '%s' "$version" | grep -Eq '^[vV]?[0-9]+(\.[0-9]+)*$'; then
    echo "版本格式不合法：$version（例：1.168.0 或 v1.168.0）"; exit 1
  fi
  version="${version#[vV]}"
  zip_url="https://github.com/austinchen705/chrome-extensions/archive/refs/tags/v$version.zip"
else
  zip_url='https://github.com/austinchen705/chrome-extensions/archive/refs/heads/main.zip'
fi

# 印出 -1／0／1：第一個版本小於／等於／大於第二個（逐段比數字）
compare_versions() {
  awk -v a="$1" -v b="$2" 'BEGIN { na = split(a, x, "."); nb = split(b, y, "."); n = (na > nb ? na : nb)
    for (i = 1; i <= n; i++) { p = x[i] + 0; q = y[i] + 0; if (p < q) { print -1; exit } if (p > q) { print 1; exit } }
    print 0 }'
}

version_of() {
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1/manifest.json" 2>/dev/null | head -n 1
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if [ -n "$version" ]; then echo "下載 v$version…"; else echo '下載最新版本…'; fi
status="$(curl -sSL -o "$work/repo.zip" -w '%{http_code}' "$zip_url")" || { echo '下載失敗，請檢查網路。'; exit 1; }
if [ "$status" = "404" ] && [ -n "$version" ]; then
  echo "找不到版本 v$version，可用的版本見 https://github.com/austinchen705/chrome-extensions/tags"; exit 1
elif [ "$status" != "200" ]; then
  echo "下載失敗（HTTP $status）"; exit 1
fi
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
if [ -n "$old_version" ]; then
  case "$(compare_versions "$new_version" "$old_version")" in
    1) echo "升級：v$old_version → v$new_version" ;;
    -1) echo "降版：v$old_version → v$new_version" ;;
    *) echo "重新安裝 v$new_version" ;;
  esac
fi

# 以下兩個動作只是方便，失敗不影響安裝結果
if command -v pbcopy >/dev/null 2>&1; then printf '%s' "$target" | pbcopy || true
elif command -v xclip >/dev/null 2>&1; then printf '%s' "$target" | xclip -selection clipboard || true
fi
if [ "${CHROME_EXT_NO_OPEN:-}" != "1" ]; then
  if [ "$(uname)" = "Darwin" ]; then open -a "Google Chrome" chrome://extensions >/dev/null 2>&1 || true
  else google-chrome chrome://extensions >/dev/null 2>&1 || true
  fi
fi

hi_on=''; hi_off=''
if [ -t 1 ]; then hi_on="$(printf '\033[30;43m')"; hi_off="$(printf '\033[0m')"; fi
echo
echo '接下來在 Chrome：'
echo '  1. 開啟 chrome://extensions（沒自動開的話請手動輸入網址）'
echo '  2. 右上角打開「開發人員模式」'
if [ -n "$old_version" ]; then
  echo '  3. 已安裝過：按該 extension 卡片上的「重新載入」'
else
  echo '  3. 第一次安裝：按「載入未封裝項目」，選擇這個資料夾（可把路徑直接貼到選擇視窗）：'
  echo
  echo "     ${hi_on} $target ${hi_off}"
  echo
  echo '     （路徑已複製到剪貼簿）'
fi
echo '  4. 重新整理遊戲分頁，新版才會生效'
