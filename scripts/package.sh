#!/bin/bash
# Construit dist/Claude Deck-darwin-arm64/Claude Deck.app : packaging Electron, fusibles de sécurité,
# signature ad hoc (obligatoire sur Apple Silicon).
set -euo pipefail
cd "$(dirname "$0")/.."

APP="dist/Claude Deck-darwin-arm64/Claude Deck.app"

npx electron-packager . 'Claude Deck' \
  --platform=darwin --arch=arm64 --out=dist --overwrite \
  --icon=assets/icon.icns \
  --app-bundle-id=io.github.bartolije.claude-deck \
  --extend-info=assets/Info.extra.plist \
  --asar.unpackDir=node_modules/node-pty \
  --ignore='^/(dist|scripts|docs|\.github)(/|$)' \
  --ignore='^/(README\.md|CHANGELOG\.md|LICENSE)$' \
  --ignore='node-pty/prebuilds/(win32|darwin-x64)'

node scripts/fuses.js "$APP"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"
echo "OK : $APP"
