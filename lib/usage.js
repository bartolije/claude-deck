'use strict';
// Usage du forfait Claude (fenêtre de 5 h et semaine, comme /usage) et état détaillé des sessions.
// Sans jamais toucher aux identifiants de Claude Code, deux sources :
//   1. le cache que Claude Code écrit dans ~/.claude.json (clé cachedUsageUtilization) quand il interroge
//      le serveur, typiquement sur /usage ;
//   2. si tu l'actives, une barre d'état « pont » : après chaque réponse, Claude Code lui transmet un JSON
//      (contexte, limites d'usage, modèle…) qu'elle enregistre pour Claude Deck et résume en une ligne.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');
const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const STATUS_MAX_AGE_MS = 15 * 60 * 1000;
const HISTORY_DAYS = 35;

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// resets_at : secondes depuis l'époque (barre d'état) ou date ISO (cache de /usage).
function toMs(v) {
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v || '');
  return Number.isFinite(t) ? t : null;
}

function bridgeScript(statusDir, prevFile) {
  return `#!/bin/sh
# Barre d'état Claude Code installée par Claude Deck (menu Présentation pour la retirer).
# Enregistre ce que Claude Code transmet (contexte, limites d'usage) pour Claude Deck, puis affiche une ligne courte.
status_dir=${shQuote(statusDir)}
prev_file=${shQuote(prevFile)}
input=$(cat)
id=$(printf '%s' "$input" | grep -o '"session_id" *: *"[0-9a-fA-F-]*"' | head -n 1 | sed 's/.*"\\([0-9a-fA-F-]*\\)"$/\\1/')
if [ -n "$id" ]; then
  mkdir -p "$status_dir" && printf '%s' "$input" > "$status_dir/.$id.$$" && mv -f "$status_dir/.$id.$$" "$status_dir/$id.json"
fi
if [ -s "$prev_file" ]; then
  printf '%s' "$input" | /bin/sh -c "$(cat "$prev_file")"
  exit 0
fi
command -v jq >/dev/null 2>&1 || exit 0
printf '%s' "$input" | jq -r '
  def pct: (. // 0 | floor | tostring) + " %";
  [ (.context_window.used_percentage | select(. != null) | "Contexte " + pct),
    (.rate_limits.five_hour | select(. != null)
      | "Session " + (.used_percentage | pct)
      + (if (.resets_at | type) == "number" then " (→ " + (.resets_at | strflocaltime("%H:%M")) + ")" else "" end)),
    (.rate_limits.seven_day | select(. != null) | "Semaine " + (.used_percentage | pct))
  ] | join("  ·  ")' 2>/dev/null
`;
}

class Usage {
  constructor(dir) {
    this.dir = dir;
    this.statusDir = path.join(dir, 'status');
    this.script = path.join(dir, 'statusline.sh');
    this.prevFile = path.join(dir, 'statusline.prev');
    this.historyFile = path.join(dir, 'usage-history.json');
    this.claudeJson = { mtimeMs: 0, value: null };
    this.statusCache = new Map(); // fichier -> { mtimeMs, data }
    this.history = (readJson(this.historyFile) || []).filter((h) => h && h.t);
    this.historyTimer = null;
  }

  // --- Barre d'état « pont » ---------------------------------------------------------------

  isOurs(statusLine) {
    return !!statusLine && typeof statusLine.command === 'string' && statusLine.command.includes(this.script);
  }

  readSettings() {
    if (!fs.existsSync(SETTINGS)) return {};
    const raw = fs.readFileSync(SETTINGS, 'utf8');
    if (!raw.trim()) return {};
    return JSON.parse(raw); // une erreur ici bloque la modification : on n'écrase jamais un fichier illisible
  }

  writeSettings(settings) {
    const tmp = `${SETTINGS}.claude-deck.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, SETTINGS);
  }

  bridgeState() {
    try {
      const sl = this.readSettings().statusLine;
      return { installed: this.isOurs(sl), other: !!sl && !this.isOurs(sl) };
    } catch (err) {
      return { installed: false, other: false, error: `~/.claude/settings.json illisible : ${err.message}` };
    }
  }

  // Réécrit le script à chaque lancement : il reste cohérent avec la version installée de l'appli.
  writeScript() {
    fs.mkdirSync(this.statusDir, { recursive: true });
    fs.writeFileSync(this.script, bridgeScript(this.statusDir, this.prevFile), { mode: 0o755 });
  }

  installBridge() {
    const settings = this.readSettings();
    const current = settings.statusLine;
    if (current && !this.isOurs(current) && current.type === 'command' && typeof current.command === 'string') {
      fs.writeFileSync(this.prevFile, current.command, { mode: 0o600 }); // ta barre d'état existante reste affichée
    }
    const backup = `${SETTINGS}.claude-deck-backup`;
    if (fs.existsSync(SETTINGS) && !fs.existsSync(backup)) fs.copyFileSync(SETTINGS, backup);
    this.writeScript();
    settings.statusLine = { type: 'command', command: shQuote(this.script), padding: 0 };
    this.writeSettings(settings);
  }

  uninstallBridge() {
    const settings = this.readSettings();
    if (!this.isOurs(settings.statusLine)) return;
    const prev = fs.existsSync(this.prevFile) ? fs.readFileSync(this.prevFile, 'utf8').trim() : '';
    if (prev) settings.statusLine = { type: 'command', command: prev };
    else delete settings.statusLine;
    this.writeSettings(settings);
    fs.rmSync(this.prevFile, { force: true });
  }

  // --- Lecture ---------------------------------------------------------------------------------

  // État transmis par Claude Code à la barre d'état, par session (fichiers de moins de 15 min).
  async sessionStatus() {
    const out = new Map();
    let names;
    try {
      names = await fsp.readdir(this.statusDir);
    } catch {
      return out;
    }
    const now = Date.now();
    for (const n of names) {
      if (!n.endsWith('.json') || n.startsWith('.')) continue;
      const file = path.join(this.statusDir, n);
      let st;
      try {
        st = await fsp.stat(file);
      } catch {
        continue;
      }
      if (now - st.mtimeMs > STATUS_MAX_AGE_MS) {
        if (now - st.mtimeMs > 2 * 86400000) fsp.rm(file, { force: true }).catch(() => {});
        continue;
      }
      let entry = this.statusCache.get(file);
      if (!entry || entry.mtimeMs !== st.mtimeMs) {
        entry = { mtimeMs: st.mtimeMs, data: readJson(file) };
        this.statusCache.set(file, entry);
      }
      if (entry.data && entry.data.session_id) out.set(entry.data.session_id, { ...entry.data, ts: st.mtimeMs });
    }
    return out;
  }

  cachedUtilization() {
    let st;
    try {
      st = fs.statSync(CLAUDE_JSON);
    } catch {
      return null;
    }
    if (st.mtimeMs !== this.claudeJson.mtimeMs) {
      const d = readJson(CLAUDE_JSON);
      this.claudeJson = { mtimeMs: st.mtimeMs, value: d && d.cachedUsageUtilization ? d.cachedUsageUtilization : null };
    }
    return this.claudeJson.value;
  }

  // Le plus récent des deux : barre d'état (après chaque réponse) ou cache de /usage.
  current(statusBySession) {
    let best = null;
    for (const s of statusBySession.values()) {
      const r = s.rate_limits;
      if (!r || (!r.five_hour && !r.seven_day)) continue;
      if (!best || s.ts > best.updatedAt) {
        best = {
          source: 'statusline',
          updatedAt: s.ts,
          session: r.five_hour ? { pct: r.five_hour.used_percentage, resetsAt: toMs(r.five_hour.resets_at) } : null,
          week: r.seven_day ? { pct: r.seven_day.used_percentage, resetsAt: toMs(r.seven_day.resets_at) } : null,
        };
      }
    }
    const cached = this.cachedUtilization();
    const u = cached && cached.utilization;
    if (u && (u.five_hour || u.seven_day) && (!best || cached.fetchedAtMs > best.updatedAt)) {
      best = {
        source: 'usage',
        updatedAt: cached.fetchedAtMs,
        session: u.five_hour ? { pct: u.five_hour.utilization, resetsAt: toMs(u.five_hour.resets_at) } : null,
        week: u.seven_day ? { pct: u.seven_day.utilization, resetsAt: toMs(u.seven_day.resets_at) } : null,
      };
    }
    if (!best) return null;
    // Une fenêtre déjà remise à zéro : l'ancien pourcentage ne veut plus rien dire.
    const now = Date.now();
    for (const k of ['session', 'week']) {
      const w = best[k];
      if (w && w.resetsAt && w.resetsAt <= now) best[k] = { pct: null, resetsAt: w.resetsAt, reset: true };
    }
    this.record(best);
    return best;
  }

  // Historique pour les graphiques : un point à chaque changement, au plus un toutes les 5 min sinon.
  record(u) {
    const s = u.session && u.session.pct != null ? Math.round(u.session.pct) : null;
    const w = u.week && u.week.pct != null ? Math.round(u.week.pct) : null;
    if (s == null && w == null) return;
    const last = this.history[this.history.length - 1];
    if (last && last.s === s && last.w === w && Date.now() - last.t < 5 * 60000) return;
    if (last && u.updatedAt <= last.src) return; // rien de neuf depuis le dernier point
    this.history.push({ t: Date.now(), src: u.updatedAt, s, w, sr: u.session && u.session.resetsAt, wr: u.week && u.week.resetsAt });
    const cutoff = Date.now() - HISTORY_DAYS * 86400000;
    while (this.history.length && this.history[0].t < cutoff) this.history.shift();
    clearTimeout(this.historyTimer);
    this.historyTimer = setTimeout(() => {
      try {
        fs.writeFileSync(this.historyFile, JSON.stringify(this.history));
      } catch {
        // pas bloquant
      }
    }, 2000);
  }
}

module.exports = { Usage };
