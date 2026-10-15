'use strict';
// Fusibles Electron : l'appli a des autorisations macOS (contrôle de Terminal, micro) qu'un autre programme ne
// doit pas pouvoir réutiliser en la lançant comme un simple Node.js ou avec un débogueur.
//   node scripts/fuses.js "dist/Claude Deck-darwin-arm64/Claude Deck.app"

const path = require('path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

const appPath = process.argv[2];
if (!appPath || !appPath.endsWith('.app')) {
  console.error('Usage : node scripts/fuses.js <chemin du .app>');
  process.exit(1);
}

flipFuses(path.join(appPath, 'Contents', 'MacOS', 'Claude Deck'), {
  version: FuseVersion.V1,
  resetAdHocDarwinSignature: true,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
})
  .then(() => console.log('Fusibles appliqués'))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
