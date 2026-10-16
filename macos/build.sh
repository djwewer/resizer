#!/bin/bash
# Builds the Resizer.app window (Contents/MacOS/Resizer) as a universal binary: Apple Silicon + Intel.
# Needs Xcode Command Line Tools (xcode-select --install). The built binary is committed to git,
# so users do not have to run this.
set -euo pipefail
cd "$(dirname "$0")"
OUT="../Resizer.app/Contents/MacOS/Resizer"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

swiftc -O -swift-version 5 -target arm64-apple-macos11 ResizerApp.swift -o "$TMP/arm64"
swiftc -O -swift-version 5 -target x86_64-apple-macos10.15 ResizerApp.swift -o "$TMP/x86_64"
mkdir -p "$(dirname "$OUT")"
lipo -create "$TMP/arm64" "$TMP/x86_64" -output "$OUT"
codesign --force --sign - "$OUT"   # ad-hoc signature: Apple Silicon refuses to run unsigned code
echo "Built $OUT"
lipo -info "$OUT"
