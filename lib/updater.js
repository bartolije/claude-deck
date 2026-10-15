'use strict';
// Mises à jour automatiques depuis les releases GitHub.
//
// L'autoUpdater d'Electron (Squirrel.Mac) exige une signature Apple Developer ID ; l'appli est signée ad hoc,
// on fait donc le travail nous-mêmes, sans rien relâcher sur la sécurité :
//   1. latest.json est signé en Ed25519 ; la clé publique est embarquée, la clé privée ne quitte pas la machine
//      de publication. Un manifeste non signé par elle est refusé, même servi par GitHub.
//   2. L'URL du zip est construite ici (dépôt + tag + nom de fichier), jamais lue du manifeste.
//   3. Le zip doit avoir le SHA-256 annoncé ; l'appli extraite doit porter le même identifiant de bundle,
//      la version annoncée et une signature de code valide.
//   4. Le bundle n'est remplacé qu'une fois l'appli quittée (script détaché), avec retour arrière en cas d'échec.

const { app, net } = require('electron');
const crypto = require('crypto');
const EventEmitter = require('events');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const REPO = 'bartolije/claude-deck';
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const PUBLIC_KEY = fs.readFileSync(path.join(__dirname, '..', 'assets', 'update-public-key.pem'), 'utf8');
const CHECK_EVERY_MS = 6 * 3600 * 1000;
const FIRST_CHECK_MS = 15000;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${path.basename(cmd)} : ${String(stderr || err.message).trim()}`));
      else resolve(String(stdout).trim());
    });
  });
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

// Pour tester une mise à jour en local : CLAUDE_DECK_UPDATE_BASE=http://127.0.0.1:<port>. Seule une adresse
// locale est acceptée, et la signature reste obligatoire.
function sources() {
  const local = process.env.CLAUDE_DECK_UPDATE_BASE;
  if (local && /^http:\/\/127\.0\.0\.1:\d+$/.test(local)) {
    return { manifest: `${local}/latest.json`, asset: (version, file) => `${local}/${file}` };
  }
  return {
    manifest: `${RELEASES_URL}/latest/download/latest.json`,
    asset: (version, file) => `${RELEASES_URL}/download/v${version}/${encodeURIComponent(file)}`,
  };
}

function plistValue(appPath, key) {
  return run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(appPath, 'Contents', 'Info.plist')]);
}

// Bundle de l'appli en cours d'exécution : …/Claude Deck.app/Contents/MacOS/Claude Deck
function currentBundle() {
  const bundle = path.resolve(process.execPath, '..', '..', '..');
  return bundle.endsWith('.app') ? bundle : null;
}

class Updater extends EventEmitter {
  constructor({ isEnabled }) {
    super();
    this.isEnabled = isEnabled;
    this.state = { status: 'idle', current: app.getVersion() };
    this.staged = null;
    this.relaunch = false;
    this.busy = null;
    this.timer = null;
  }

  start() {
    if (!app.isPackaged && !process.env.CLAUDE_DECK_UPDATE_BASE) return;
    setTimeout(() => this.check(), FIRST_CHECK_MS);
    this.timer = setInterval(() => this.check(), CHECK_EVERY_MS);
  }

  setState(patch) {
    this.state = { ...this.state, ...patch, current: app.getVersion() };
    this.emit('state', this.state);
  }

  check({ manual = false } = {}) {
    if (!manual && !this.isEnabled()) return Promise.resolve(this.state);
    if (!this.busy) {
      this.busy = this._check(manual)
        .catch((err) => {
          this.setState({ status: 'error', error: err.message });
          return this.state;
        })
        .finally(() => {
          this.busy = null;
        });
    }
    return this.busy;
  }

  async _check(manual) {
    if (this.staged) return this.state; // déjà prête : installée à la prochaine fermeture
    const bundle = currentBundle();
    if (!app.isPackaged && !process.env.CLAUDE_DECK_UPDATE_BASE) {
      throw new Error('Mises à jour désactivées en mode développement.');
    }
    if (!bundle || bundle.includes('/AppTranslocation/') || bundle.startsWith('/Volumes/')) {
      throw new Error('Déplace Claude Deck dans le dossier Applications pour activer les mises à jour.');
    }
    await fsp.access(path.dirname(bundle), fs.constants.W_OK).catch(() => {
      throw new Error(`Pas les droits d'écriture sur ${path.dirname(bundle)} : mise à jour impossible.`);
    });

    this.setState({ status: 'checking', error: null });
    const src = sources();
    const res = await net.fetch(src.manifest, { cache: 'no-store' });
    if (res.status === 404) {
      this.setState({ status: 'uptodate', latest: app.getVersion(), checkedAt: Date.now() });
      return this.state;
    }
    if (!res.ok) throw new Error(`Manifeste de mise à jour inaccessible (HTTP ${res.status}).`);
    const manifest = this.verifyManifest(await res.json());

    if (compareVersions(manifest.version, app.getVersion()) <= 0) {
      this.setState({ status: 'uptodate', latest: manifest.version, checkedAt: Date.now() });
      return this.state;
    }
    const asset = manifest.assets && manifest.assets[process.arch];
    if (!asset || !/^[\w.-]+\.zip$/.test(asset.file || '') || !/^[0-9a-f]{64}$/.test(asset.sha256 || '')) {
      throw new Error(`Pas de version ${manifest.version} pour cette architecture (${process.arch}).`);
    }
    const ownId = await plistValue(bundle, 'CFBundleIdentifier');
    if (manifest.bundleId !== ownId) throw new Error('Manifeste destiné à une autre application.');

    this.setState({ status: 'downloading', latest: manifest.version, notes: manifest.notes || '', progress: 0 });
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-deck-update-'));
    try {
      const zip = path.join(dir, asset.file);
      await this.download(src.asset(manifest.version, asset.file), zip, asset);
      const out = path.join(dir, 'app');
      await fsp.mkdir(out);
      await run('/usr/bin/ditto', ['-x', '-k', zip, out]);
      const name = (await fsp.readdir(out)).find((n) => n.endsWith('.app'));
      if (!name) throw new Error("L'archive ne contient pas d'application.");
      const staged = path.join(out, name);
      if ((await plistValue(staged, 'CFBundleIdentifier')) !== ownId) throw new Error("Identifiant d'application inattendu.");
      if ((await plistValue(staged, 'CFBundleShortVersionString')) !== manifest.version) throw new Error('Version inattendue dans l’archive.');
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged]);
      await run('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', staged]).catch(() => {});
      await fsp.rm(zip, { force: true });
      this.staged = { dir, app: staged, version: manifest.version };
      this.setState({ status: 'ready', latest: manifest.version, notes: manifest.notes || '', progress: 1, manual });
    } catch (err) {
      await fsp.rm(dir, { recursive: true, force: true });
      throw err;
    }
    return this.state;
  }

  verifyManifest(doc) {
    if (!doc || typeof doc.payload !== 'string' || typeof doc.signature !== 'string') throw new Error('Manifeste de mise à jour invalide.');
    const payload = Buffer.from(doc.payload, 'base64');
    const ok = crypto.verify(null, payload, PUBLIC_KEY, Buffer.from(doc.signature, 'base64'));
    if (!ok) throw new Error('Signature de la mise à jour invalide : mise à jour refusée.');
    const manifest = JSON.parse(payload.toString('utf8'));
    if (!/^\d+\.\d+\.\d+$/.test(manifest.version || '')) throw new Error('Numéro de version invalide dans le manifeste.');
    return manifest;
  }

  async download(url, file, asset) {
    const res = await net.fetch(url, { cache: 'no-store' });
    if (!res.ok || !res.body) throw new Error(`Téléchargement impossible (HTTP ${res.status}).`);
    const hash = crypto.createHash('sha256');
    let received = 0;
    let lastEmit = 0;
    const meter = new Transform({
      transform: (chunk, _enc, cb) => {
        hash.update(chunk);
        received += chunk.length;
        if (asset.size && Date.now() - lastEmit > 250) {
          lastEmit = Date.now();
          this.setState({ progress: Math.min(0.99, received / asset.size) });
        }
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(file, { mode: 0o600 }));
    if (asset.size && received !== asset.size) throw new Error('Téléchargement incomplet.');
    if (hash.digest('hex') !== asset.sha256) throw new Error('Empreinte SHA-256 inattendue : mise à jour refusée.');
  }

  // Appelé quand l'appli quitte : remplace le bundle une fois le processus terminé, puis relance si demandé.
  installOnExit() {
    const bundle = currentBundle();
    if (!this.staged || !bundle) return false;
    const args = process.argv.slice(1).filter((a) => a.startsWith('--user-data-dir='));
    const script = [
      'pid="$1"; target="$2"; staged="$3"; relaunch="$4"; dir="$5"; shift 5',
      'while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done',
      'if mv "$target" "$dir/previous.app"; then',
      '  if mv "$staged" "$target"; then rm -rf "$dir"; else mv "$dir/previous.app" "$target"; fi',
      'fi',
      'if [ "$relaunch" = 1 ]; then /usr/bin/open -n "$target" --args "$@"; fi',
    ].join('\n');
    const child = spawn('/bin/sh', ['-c', script, 'sh', String(process.pid), bundle, this.staged.app, this.relaunch ? '1' : '0', this.staged.dir, ...args], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return true;
  }
}

module.exports = { Updater, RELEASES_URL, compareVersions };
