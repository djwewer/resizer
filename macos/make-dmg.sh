#!/bin/bash
# Builds dist/Resizer.dmg: the "drag Resizer to Applications" installer with a gradient background.
# Uses dmgbuild (installed into a temporary virtualenv), so no Finder windows open during the build.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
OUT="$ROOT/dist/Resizer.dmg"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

codesign --verify --deep --strict Resizer.app || { echo "Resizer.app signature is stale: run macos/build.sh first"; exit 1; }

python3 -m venv "$TMP/venv"
"$TMP/venv/bin/pip" install -q dmgbuild==1.6.2

mkdir -p "$ROOT/dist"
rm -f "$OUT"
"$TMP/venv/bin/dmgbuild" -s macos/dmg/settings.py -D format=UDRW \
  -D app="$ROOT/Resizer.app" -D background="$ROOT/macos/dmg/background.tiff" \
  "Resizer" "$TMP/rw.dmg"

# macOS 26 Finder tries the background's bookmark (pBBk) first, cannot resolve the one dmgbuild
# writes, and then shows no background at all. Without it Finder uses the alias, which works on
# every macOS version.
hdiutil attach -quiet -nobrowse -noautoopen -readwrite -mountpoint "$TMP/mnt" "$TMP/rw.dmg"
"$TMP/venv/bin/python3" -I -c '
import sys
from ds_store import DSStore
with DSStore.open(sys.argv[1], "r+") as d:
    d.delete(".", b"pBBk")
' "$TMP/mnt/.DS_Store"
hdiutil detach -quiet "$TMP/mnt"
hdiutil convert -quiet "$TMP/rw.dmg" -format UDZO -imagekey zlib-level=9 -o "$OUT"
echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
