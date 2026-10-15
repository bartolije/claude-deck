'use strict';
// Terminaux intégrés : chaque session de l'appli est un vrai pseudo-terminal (node-pty, comme VS Code)
// qui exécute la commande dans un zsh de login interactif — alias, PATH et .zshrc identiques à Terminal.app.
// Quand Claude se termine, on retombe sur un shell, exactement comme dans un onglet de terminal.

const EventEmitter = require('events');
const pty = require('node-pty');

const BUFFER_MAX = 2 * 1024 * 1024; // relecture après rechargement de la fenêtre

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

class PtyManager extends EventEmitter {
  constructor() {
    super();
    this.ptys = new Map();
    this.nextId = 1;
  }

  create({ command, shell, env, label, resumeOf = null, cols = 120, rows = 36 }) {
    const id = this.nextId++;
    const script = `${command}; exec ${shellQuote(shell)} -l`;
    const proc = pty.spawn(shell, ['-l', '-i', '-c', script], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: env.HOME,
      env,
    });
    const entry = {
      id,
      proc,
      pid: proc.pid,
      tty: proc.ptsName,
      command,
      label,
      resumeOf,
      createdAt: Date.now(),
      title: '',
      chunks: [],
      size: 0,
      pending: '',
      timer: null,
    };
    proc.onData((d) => this._onData(entry, d));
    proc.onExit(({ exitCode }) => {
      this._flush(entry);
      this.ptys.delete(id);
      this.emit('exit', id, exitCode);
    });
    this.ptys.set(id, entry);
    this.emit('created', this.describe(entry));
    return entry;
  }

  _onData(entry, data) {
    entry.chunks.push(data);
    entry.size += data.length;
    while (entry.size > BUFFER_MAX && entry.chunks.length > 1) entry.size -= entry.chunks.shift().length;
    // Regroupe les petits paquets pour limiter le trafic IPC.
    entry.pending += data;
    if (!entry.timer) entry.timer = setTimeout(() => this._flush(entry), 4);
  }

  _flush(entry) {
    clearTimeout(entry.timer);
    entry.timer = null;
    if (!entry.pending) return;
    const data = entry.pending;
    entry.pending = '';
    this.emit('data', entry.id, data);
  }

  describe(entry) {
    return { id: entry.id, label: entry.label, title: entry.title, createdAt: entry.createdAt, resumeOf: entry.resumeOf };
  }

  get(id) {
    return this.ptys.get(id);
  }

  list() {
    return [...this.ptys.values()];
  }

  replay(id) {
    const e = this.ptys.get(id);
    return e ? e.chunks.join('') : '';
  }

  write(id, data) {
    const e = this.ptys.get(id);
    if (e) e.proc.write(data);
  }

  resize(id, cols, rows) {
    const e = this.ptys.get(id);
    if (!e || !(cols > 0 && rows > 0)) return;
    try {
      e.proc.resize(cols, rows);
    } catch {
      // le pty vient de se fermer
    }
  }

  setTitle(id, title) {
    const e = this.ptys.get(id);
    if (e) e.title = title;
  }

  kill(id) {
    const e = this.ptys.get(id);
    if (e) e.proc.kill(); // SIGHUP : le shell le relaie à Claude, qui s'arrête proprement
  }

  killAll() {
    for (const e of this.ptys.values()) e.proc.kill();
  }
}

module.exports = { PtyManager, shellQuote };
