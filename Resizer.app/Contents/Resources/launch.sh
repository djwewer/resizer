#!/bin/bash
# Resizer.app: checks Python and starts the local server in the background.
# Called by the app window (Contents/MacOS/Resizer). On success prints "URL PID" (PID 0 if the
# server was already running); on failure shows a dialog itself and exits 1.

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
APP="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$APP/Contents/Resources/resizer.py"
PORT=8765
URL="http://127.0.0.1:$PORT"
LOG="$HOME/Library/Logs/Resizer.log"
OUT="$HOME/Movies/Resizer"
WORK="$HOME/Library/Caches/Resizer"

alert() {
  osascript -e "display dialog \"$1\" with title \"Resizer\" buttons {\"OK\"} default button 1 with icon caution" >/dev/null 2>&1
}

# Already running -> just reuse it.
if curl -s --max-time 1 "$URL/api/ping" | grep -q resizer; then
  echo "$URL 0"
  exit 0
fi

if [ ! -f "$SCRIPT" ]; then
  alert "Застосунок пошкоджено: немає Contents/Resources/resizer.py. Скачайте Resizer ще раз."
  exit 1
fi

PY=""
for c in /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
  if [ -x "$c" ] && "$c" -c 'import sys; sys.exit(sys.version_info < (3, 9))' >/dev/null 2>&1; then
    PY="$c"
    break
  fi
done
if [ -z "$PY" ]; then
  alert "Потрібен Python 3. Якщо macOS запропонувала встановити інструменти розробника — погодьтесь, дочекайтесь завершення і запустіть Resizer ще раз."
  exit 1
fi

# No ffmpeg check here: the window shows an install screen when it is missing.

mkdir -p "$(dirname "$LOG")" "$OUT"
# --idle-exit is a safety net: the window stops the server itself when it closes.
nohup "$PY" "$SCRIPT" --port "$PORT" --out "$OUT" --work "$WORK" --idle-exit 300 --no-browser \
  >"$LOG" 2>&1 </dev/null &
PID=$!
disown

# The server picks the next free port if $PORT is taken by another app, so read its real URL.
for _ in $(seq 1 50); do
  REAL=$(grep -o 'http://127\.0\.0\.1:[0-9]*' "$LOG" | head -n 1)
  if [ -n "$REAL" ] && curl -s --max-time 1 "$REAL/api/ping" | grep -q resizer; then
    echo "$REAL $PID"
    exit 0
  fi
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.2
done
ERR=$(tail -n 5 "$LOG" | tr '"' "'" )
alert "Resizer не запустився. $ERR  (Лог: ~/Library/Logs/Resizer.log)"
kill "$PID" 2>/dev/null
exit 1
