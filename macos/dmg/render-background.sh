#!/bin/bash
# Renders background.html into background.tiff (1x + 2x for Retina) with headless Google Chrome.
# Only needed after editing background.html; the result is committed.
set -euo pipefail
cd "$(dirname "$0")"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
for scale in 1 2; do
  "$CHROME" --headless --disable-gpu --hide-scrollbars --window-size=640,420 \
    --force-device-scale-factor=$scale --screenshot="$TMP/bg$scale.png" "file://$PWD/background.html" 2>/dev/null
done
tiffutil -cathidpicheck "$TMP/bg1.png" "$TMP/bg2.png" -out background.tiff
echo "Rendered $(pwd)/background.tiff"
