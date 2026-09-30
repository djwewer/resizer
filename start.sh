#!/bin/bash
# macOS: подвійний клік запускає Resizer
cd "$(dirname "$0")"
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg не знайдено. Встановіть: brew install ffmpeg"; read -r; exit 1
fi
exec python3 resizer.py
