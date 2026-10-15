'use strict';
// Réglages (config.json, éditable à la main) et état persistant (state.json) dans le dossier userData.

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  // Commande d'une nouvelle session, tapée dans un zsh de login interactif : un alias de ton .zshrc
  // fonctionne (par exemple un alias qui fait cd dans ton dossier de travail puis lance claude avec tes options).
  newSessionCommand: 'claude',
  // {cwd} et {sessionId} sont remplacés (cwd protégé par des quotes shell).
  newSessionInFolderCommand: 'cd {cwd} && claude',
  resumeCommand: 'cd {cwd} && claude --resume {sessionId}',
  attachCommand: 'claude attach {id}',
  shell: process.env.SHELL || '/bin/zsh',
  closedSessionsDays: 3,
  staleAfterHours: 6,
  notifications: true,
  showBackgroundAgents: true,
  // Comme le profil « Basic » de Terminal.app : SF Mono 11, interligne 1.
  fontFamily: '"SF Mono", Menlo, Monaco, monospace',
  fontSize: 11,
  lineHeight: 1,
  // Molette dans Claude plein écran : 1 = autant d'événements que Terminal.app, 2 et 3 = plus rapide.
  scrollSpeed: 1,
  // auto = ton réglage Claude Code (/tui) ; classic = historique du terminal et barre de défilement ;
  // fullscreen = rendu plein écran forcé. S'applique aux sessions lancées ensuite.
  claudeDisplay: 'auto',
  // Recherche et installation des nouvelles versions publiées sur GitHub.
  autoUpdate: true,
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

class Store {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.configFile = path.join(dir, 'config.json');
    this.stateFile = path.join(dir, 'state.json');
    this.firstRun = !fs.existsSync(this.stateFile);
    this.config = this._loadConfig();
    this.state = { seen: {}, archived: {}, lastOpen: [], bounds: null, collapsed: {}, ...(readJson(this.stateFile) || {}) };
    this.state.archived = this.state.archived || {};
    this._saveTimer = null;
  }

  _loadConfig() {
    const user = readJson(this.configFile);
    if (!user) fs.writeFileSync(this.configFile, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
    return { ...DEFAULT_CONFIG, ...(user || {}) };
  }

  reloadConfig() {
    this.config = this._loadConfig();
    return this.config;
  }

  saveState() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveStateNow(), 500);
  }

  saveStateNow() {
    clearTimeout(this._saveTimer);
    // On ne garde la trace de lecture que pour les sessions des 30 derniers jours.
    const cutoff = Date.now() - 30 * 86400000;
    for (const [k, v] of Object.entries(this.state.seen)) if (v < cutoff) delete this.state.seen[k];
    // Au-delà de 30 jours, Claude Code a supprimé le transcript : l'archivage n'a plus d'objet.
    for (const [k, v] of Object.entries(this.state.archived)) if (v < cutoff) delete this.state.archived[k];
    fs.writeFileSync(this.stateFile, JSON.stringify(this.state));
  }
}

module.exports = { Store, DEFAULT_CONFIG };
