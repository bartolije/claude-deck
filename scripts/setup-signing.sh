#!/bin/bash
# Crée (une fois) l'identité de signature locale de Claude Deck : un certificat auto-signé « Code Signing »,
# rangé dans un trousseau dédié (~/.config/claude-deck/signing.keychain-db), jamais dans le dépôt.
# Signée avec une identité stable, l'appli garde ses autorisations macOS (contrôle de Terminal, dossiers,
# données d'autres apps) d'une mise à jour à l'autre ; en signature ad hoc, macOS les oublie à chaque version.
# À sauvegarder avec le reste de ~/.config/claude-deck/ : sans elle, les versions déjà installées refusent les
# mises à jour signées par une autre identité.
set -euo pipefail

DIR="${CLAUDE_DECK_CONFIG:-$HOME/.config/claude-deck}"
KC="$DIR/signing.keychain-db"
PASSFILE="$DIR/signing.pass"
NAME="Claude Deck Local Signing"

if [ -f "$KC" ]; then
  echo "Identité déjà créée : $KC"
  exit 0
fi

mkdir -p "$DIR"
chmod 700 "$DIR"
umask 077
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

PASS=$(/usr/bin/openssl rand -hex 24)
printf '%s' "$PASS" > "$PASSFILE"

cat > "$TMP/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
EOF

/usr/bin/openssl req -x509 -newkey rsa:3072 -nodes -days 3650 -config "$TMP/cert.cnf" \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem" 2>/dev/null
/usr/bin/openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -name "$NAME" \
  -passout "pass:$PASS" -out "$TMP/id.p12"

# create-keychain ajoute le trousseau à la liste de recherche : on la restaure ensuite à l'identique.
SEARCH=()
while IFS= read -r line; do SEARCH+=("$line"); done < <(security list-keychains -d user | sed 's/^ *"//; s/"$//')

security create-keychain -p "$PASS" "$KC"
security set-keychain-settings "$KC" # pas de verrouillage automatique
security unlock-keychain -p "$PASS" "$KC"
security import "$TMP/id.p12" -k "$KC" -P "$PASS" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$PASS" "$KC" >/dev/null
security list-keychains -d user -s "${SEARCH[@]}"

echo "Identité « $NAME » créée dans $KC"
