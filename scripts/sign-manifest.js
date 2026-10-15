'use strict';
// Écrit latest.json, le manifeste signé (Ed25519) que l'appli lit pour se mettre à jour.
//   node scripts/sign-manifest.js <version> <zip> <fichier de notes> <sortie>
// Clé privée : $CLAUDE_DECK_SIGNING_KEY ou ~/.config/claude-deck/update-signing-key.pem

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const [version, zipPath, notesPath, outPath] = process.argv.slice(2);
if (!version || !zipPath || !outPath) {
  console.error('Usage : node scripts/sign-manifest.js <version> <zip> <notes> <sortie>');
  process.exit(1);
}
const keyPath = process.env.CLAUDE_DECK_SIGNING_KEY || path.join(os.homedir(), '.config', 'claude-deck', 'update-signing-key.pem');
const privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
const publicKey = crypto.createPublicKey(fs.readFileSync(path.join(__dirname, '..', 'assets', 'update-public-key.pem')));

const zip = fs.readFileSync(zipPath);
const payload = Buffer.from(
  JSON.stringify({
    version,
    date: new Date().toISOString(),
    bundleId: 'io.github.bartolije.claude-deck',
    notes: notesPath && fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf8').trim() : '',
    assets: {
      arm64: { file: path.basename(zipPath), sha256: crypto.createHash('sha256').update(zip).digest('hex'), size: zip.length },
    },
  }),
);
const signature = crypto.sign(null, payload, privateKey);
// La clé privée doit correspondre à la clé publique embarquée, sinon aucune appli n'acceptera la mise à jour.
if (!crypto.verify(null, payload, publicKey, signature)) {
  console.error('La clé privée ne correspond pas à assets/update-public-key.pem');
  process.exit(1);
}
fs.writeFileSync(outPath, `${JSON.stringify({ payload: payload.toString('base64'), signature: signature.toString('base64') }, null, 2)}\n`);
console.log(`Manifeste signé : ${outPath}`);
