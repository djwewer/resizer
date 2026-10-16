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
"$TMP/venv/bin/dmgbuild" -s macos/dmg/settings.py \
  -D app="$ROOT/Resizer.app" -D background="$ROOT/macos/dmg/background.tiff" \
  "Resizer" "$OUT"
echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
