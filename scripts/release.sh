#!/bin/bash
# Publie une version sur GitHub. Avant : mettre à jour "version" dans package.json et ajouter la section
# correspondante en tête de CHANGELOG.md, committer. Puis : npm run release
#   --dry-run : construit et signe dans dist/release sans tagger ni publier.
set -euo pipefail
cd "$(dirname "$0")/.."

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1
VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"
OUT="dist/release"
NAME="Claude-Deck-$VERSION-arm64"
APP="dist/Claude Deck-darwin-arm64/Claude Deck.app"

if [ $DRY = 0 ]; then
  [ -z "$(git status --porcelain)" ] || { echo "Des modifications ne sont pas committées."; exit 1; }
  [ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || { echo "Publier depuis la branche main."; exit 1; }
  if git rev-parse "$TAG" >/dev/null 2>&1; then echo "Le tag $TAG existe déjà : changer la version."; exit 1; fi
fi

# Notes de version : section « ## <version> » du CHANGELOG.
rm -rf "$OUT" && mkdir -p "$OUT"
awk -v v="$VERSION" '$0 ~ "^## " { if (found) exit; if ($2 == v) { found = 1; next } } found' CHANGELOG.md > "$OUT/notes.md"
[ -s "$OUT/notes.md" ] || { echo "Pas de section « ## $VERSION » dans CHANGELOG.md."; exit 1; }

bash scripts/package.sh

ditto -c -k --keepParent "$APP" "$OUT/$NAME.zip"
STAGE=$(mktemp -d)
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Claude Deck" -srcfolder "$STAGE" -ov -format UDZO "$OUT/$NAME.dmg" >/dev/null
rm -rf "$STAGE"
node scripts/sign-manifest.js "$VERSION" "$OUT/$NAME.zip" "$OUT/notes.md" "$OUT/latest.json"
(cd "$OUT" && shasum -a 256 "$NAME.zip" "$NAME.dmg" > SHA256SUMS.txt)

if [ $DRY = 1 ]; then
  echo "Essai à blanc terminé : $OUT"
  exit 0
fi

git tag -a "$TAG" -m "Claude Deck $VERSION"
git push origin main "$TAG"
gh release create "$TAG" --title "Claude Deck $VERSION" --notes-file "$OUT/notes.md" \
  "$OUT/$NAME.dmg" "$OUT/$NAME.zip" "$OUT/latest.json" "$OUT/SHA256SUMS.txt"
echo "Publié : $TAG"
