#!/bin/bash
# Construit dist/build.noindex/Claude Deck-darwin-arm64/Claude Deck.app : packaging Electron, fusibles de sécurité,
# signature ad hoc (obligatoire sur Apple Silicon).
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="dist/build.noindex" # .noindex : Spotlight et le Launchpad ignorent cette copie de travail
APP="$OUT/Claude Deck-darwin-arm64/Claude Deck.app"
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

npx electron-packager . 'Claude Deck' \
  --platform=darwin --arch=arm64 --out="$OUT" --overwrite \
  --icon=assets/icon.icns \
  --app-bundle-id=io.github.bartolije.claude-deck \
  --extend-info=assets/Info.extra.plist \
  --asar.unpackDir=node_modules/node-pty \
  --ignore='^/(dist|scripts|docs|\.github)(/|$)' \
  --ignore='^/(README\.md|CHANGELOG\.md|LICENSE)$' \
  --ignore='node-pty/prebuilds/(win32|darwin-x64)'

node scripts/fuses.js "$APP"

# Signature : identité locale stable si elle existe (scripts/setup-signing.sh), sinon ad hoc.
# Avec l'identité stable, macOS garde les autorisations de l'appli d'une version à l'autre.
SIGN_DIR="${CLAUDE_DECK_CONFIG:-$HOME/.config/claude-deck}"
if [ -f "$SIGN_DIR/signing.keychain-db" ] && [ -f "$SIGN_DIR/signing.pass" ]; then
  security unlock-keychain -p "$(cat "$SIGN_DIR/signing.pass")" "$SIGN_DIR/signing.keychain-db"
  codesign --force --deep --keychain "$SIGN_DIR/signing.keychain-db" --sign "Claude Deck Local Signing" "$APP"
else
  echo "Pas d'identité locale : signature ad hoc (les autorisations macOS ne survivront pas aux mises à jour)."
  codesign --force --deep --sign - "$APP"
fi
codesign --verify --deep --strict "$APP"
# Seule la copie installée doit être connue de macOS (Dock, Spotlight, « Ouvrir avec »).
"$LSREGISTER" -u "$APP" 2>/dev/null || true
echo "OK : $APP"
