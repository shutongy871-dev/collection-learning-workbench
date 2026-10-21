#!/bin/bash
# 每天北京时间09:00启动新本地执行器；分钟检查负责唤醒后的补跑。
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node)"
export DYLD_LIBRARY_PATH="${DYLD_LIBRARY_PATH:-/opt/homebrew/opt/node/lib}"
"$NODE_BIN" "$PROJECT_ROOT/scripts/prepare-daily.mjs"
SOURCE="$PROJECT_ROOT/.data/daily/com.collection-tidy-agent.daily.plist"
/usr/bin/plutil -lint "$SOURCE"
if [[ "${1:-}" == "--prepare" ]]; then exit 0; fi
LOG_PATH="$(/usr/bin/plutil -extract StandardOutPath raw -o - "$SOURCE")"
# launchd/xpcproxy打开日志时尚未启动Node，先在标准用户日志目录准备好文件。
mkdir -p "$(dirname "$LOG_PATH")"
touch "$LOG_PATH"
chmod 600 "$LOG_PATH"
TARGET="$HOME/Library/LaunchAgents/com.collection-tidy-agent.daily.plist"
DOMAIN="gui/$(id -u)"
LABEL="com.collection-tidy-agent.daily"
mkdir -p "$HOME/Library/LaunchAgents"
if /bin/launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  /bin/launchctl bootout "$DOMAIN/$LABEL"
fi
install -m 600 "$SOURCE" "$TARGET"
/bin/launchctl enable "$DOMAIN/$LABEL"
/bin/launchctl bootstrap "$DOMAIN" "$TARGET"
echo "已注册每日09:00（北京时间）抖音收藏整理：$TARGET"
echo "后台启动日志：$LOG_PATH"
