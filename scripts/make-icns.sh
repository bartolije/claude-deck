#!/bin/bash
# assets/icon.png (1024 px) -> assets/icon.icns
set -euo pipefail
cd "$(dirname "$0")/.."
SET=$(mktemp -d)/icon.iconset
mkdir -p "$SET"
for s in 16 32 128 256 512; do
  sips -z $s $s assets/icon.png --out "$SET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) assets/icon.png --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$SET" -o assets/icon.icns
echo "assets/icon.icns généré"
