'use strict';
// Génère la paire de clés Ed25519 qui signe les mises à jour (à faire une seule fois).
// La clé privée reste sur la machine de publication, hors du dépôt ; la clé publique est embarquée dans l'appli.
//   node scripts/gen-update-key.js

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const privatePath = process.env.CLAUDE_DECK_SIGNING_KEY || path.join(os.homedir(), '.config', 'claude-deck', 'update-signing-key.pem');
const publicPath = path.join(__dirname, '..', 'assets', 'update-public-key.pem');

if (fs.existsSync(privatePath)) {
  console.error(`Une clé privée existe déjà (${privatePath}) : rien n'est écrasé.`);
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.mkdirSync(path.dirname(privatePath), { recursive: true, mode: 0o700 });
fs.writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
fs.writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }));
console.log(`Clé privée : ${privatePath} (à sauvegarder, par exemple dans un gestionnaire de mots de passe)`);
console.log(`Clé publique : ${publicPath}`);
