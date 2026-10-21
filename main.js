'use strict';

const { app, BrowserWindow, ipcMain, Menu, Tray, Notification, dialog, shell, clipboard, nativeImage, screen, session, systemPreferences, globalShortcut } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sessions = require('./lib/sessions');
const { PtyManager, shellQuote } = require('./lib/ptys');
const { Store, DEFAULT_CONFIG } = require('./lib/store');
const { Updater, RELEASES_URL } = require('./lib/updater');
const { Usage } = require('./lib/usage');

app.setName('Claude Deck');

// L'appli pilote des terminaux : dans la version installée, on refuse tout point d'entrée de débogage
// qui permettrait à un autre programme de taper dedans.
if (app.isPackaged && ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk'].some((s) => app.commandLine.hasSwitch(s))) {
  app.exit(1);
}

const REFRESH_MS = 1000;
const CLOSED_SCAN_MS = 20000;
const BACKGROUND_SCAN_MS = 60000;
const LIVE_META_MAX_AGE_MS = 2500;
const SESSION_ID_RE = /^[0-9a-f-]{36}$/i;
const BG_ID_RE = /^[\w-]{4,64}$/;

let win = null;
let tray = null;
let store = null;
let quitting = false;
const ptys = new PtyManager();
const updater = new Updater({ isEnabled: () => store && store.config.autoUpdate !== false });

let items = [];
let lastPayload = '';
let usage = null; // usage du forfait + barre d'état « pont »
let usageNow = null;
let lastUsagePayload = '';
let closedCache = [];
let bgCache = [];
let lastBgScan = 0;
let selectedKey = null;
let primed = false;
const prevStates = new Map();
const hostApps = new Map(); // pid -> nom de l'appli hôte (Terminal, iTerm2, Code…)
const liveNotifications = new Set();

// --- Utilitaires ---------------------------------------------------------------

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function ptyEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Variables d'Electron, du terminal parent ou d'une session Claude parente : à ne pas transmettre.
    if (/^(ELECTRON_|CHROME_|TERM_PROGRAM|TERM_SESSION_ID$|ITERM_|VSCODE_|CLAUDECODE$|CLAUDE_CODE_|CLAUDE_PID$|CLAUDE_EFFORT$)/.test(k)) continue;
    env[k] = v;
  }
  env.HOME = env.HOME || os.homedir();
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.TERM_PROGRAM = 'ClaudeDeck';
  env.TERM_PROGRAM_VERSION = app.getVersion();
  if (!env.LANG) env.LANG = 'fr_FR.UTF-8';
  // Rendu de Claude Code : CLAUDE_CODE_NO_FLICKER=0 → classique (historique + barre de défilement), 1 → plein écran.
  const display = store && store.config.claudeDisplay;
  if (display === 'classic') env.CLAUDE_CODE_NO_FLICKER = '0';
  else if (display === 'fullscreen') env.CLAUDE_CODE_NO_FLICKER = '1';
  return env;
}

function setConfig(patch) {
  Object.assign(store.config, patch);
  writeConfig();
  send('deck:config', store.config);
}

function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (m, k) => {
    if (!(k in vars)) return m;
    return k === 'cwd' ? shellQuote(vars[k]) : String(vars[k]);
  });
}

function cleanTitle(t) {
  const s = (t || '').replace(/^[^\p{L}\p{N}]+/u, '').trim();
  return /^claude( code)?$/i.test(s) ? '' : s;
}

function shorten(s, n = 90) {
  if (!s) return '';
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

function titleOf(e, meta, p) {
  return (
    (meta && meta.customTitle) ||
    (e.nameSource === 'user' && e.name) ||
    (meta && meta.aiTitle) ||
    cleanTitle(p && p.title) ||
    shorten(meta && meta.lastPrompt) ||
    (p && p.label) ||
    e.name ||
    'Session Claude'
  );
}

// Contexte occupé : la barre d'état « pont » donne la valeur exacte de Claude Code ; sinon on la calcule
// depuis le transcript (jetons du dernier appel / taille de la fenêtre).
function contextOf(meta, st, sessionId) {
  const cw = st && st.context_window;
  if (cw && cw.used_percentage != null && (!meta || st.ts >= meta.mtimeMs - 30000)) {
    return { pct: Math.round(cw.used_percentage), tokens: cw.total_input_tokens || null, window: cw.context_window_size || null };
  }
  if (meta && meta.contextTokens != null && meta.contextWindow) {
    const window = contextWindowOf(meta, sessionId);
    return { pct: Math.round((100 * meta.contextTokens) / window), tokens: meta.contextTokens, window };
  }
  return null;
}

// Le transcript ne donne la fenêtre que pour la bêta context-1m (200 000 supposés sinon), alors que les
// modèles récents ont 1 M de jetons sans bêta : la taille transmise par Claude Code à la barre d'état
// (pour la session, ou à défaut pour le modèle) prime, et un contexte plus grand que 200 000 prouve 1 M.
function contextWindowOf(meta, sessionId) {
  const beta = meta.contextWindow >= 1000000;
  const known = usage ? usage.contextWindow(sessionId, beta ? null : meta.model) : null;
  const window = known || meta.contextWindow;
  return meta.contextTokens > window ? 1000000 : window;
}

// Ce que Claude fait pendant un tour : dernier outil appelé, ou rédaction de la réponse.
function activityOf(meta) {
  if (!meta) return null;
  if (meta.lastBlock === 'text') return 'rédige la réponse';
  if (meta.lastBlock === 'thinking') return 'réfléchit';
  if (meta.lastTool) {
    const name = meta.lastTool.name || '';
    const label = name.startsWith('mcp__') ? meta.lastTool.detail : meta.lastTool.detail ? `${name} · ${meta.lastTool.detail}` : name;
    return label || null;
  }
  return null;
}

// waiting / busy viennent directement de Claude Code ; « terminé » = au repos avec du nouveau depuis
// la dernière fois que tu as regardé la session.
function liveState(e, meta, seenAt) {
  if (e.status === 'waiting') return 'waiting';
  if (e.status === 'busy') return 'busy';
  if (!meta) return 'ready'; // pas encore de premier prompt
  const changedAt = e.statusUpdatedAt || e.updatedAt || 0;
  return changedAt > seenAt ? 'done' : 'idle';
}

// --- Rafraîchissement ------------------------------------------------------------

let refreshing = false;
let refreshQueued = false;
let soonTimer = null;

function refreshSoon(delay = 100) {
  clearTimeout(soonTimer);
  soonTimer = setTimeout(refresh, delay);
}

async function refresh() {
  if (refreshing) {
    refreshQueued = true;
    return;
  }
  refreshing = true;
  try {
    await buildItems();
  } catch (err) {
    console.error('refresh', err);
  } finally {
    refreshing = false;
    if (refreshQueued) {
      refreshQueued = false;
      setTimeout(refresh, 50);
    }
  }
}

async function buildItems() {
  const now = Date.now();
  const cfg = store.config;
  const reg = (await sessions.readRegistry()).filter((e) => sessions.isAlive(e.pid));
  const status = usage ? await usage.sessionStatus() : new Map();
  const info = await sessions.processInfo(reg.map((e) => e.pid));
  const ptyByTty = new Map(ptys.list().map((p) => [p.tty, p]));
  const focused = !!(win && !win.isDestroyed() && win.isVisible() && win.isFocused());

  // Une session reprise peut brièvement apparaître deux fois : on garde l'entrée la plus récente.
  const bySession = new Map();
  for (const e of reg) {
    const pi = info.get(e.pid);
    if (!pi || !/claude/i.test(pi.args)) continue; // pid recyclé par un autre programme
    if (e.kind && e.kind !== 'interactive') continue;
    const prev = bySession.get(e.sessionId);
    if (!prev || (e.statusUpdatedAt || 0) > (prev.e.statusUpdatedAt || 0)) bySession.set(e.sessionId, { e, pi });
  }

  const out = [];
  const matched = new Set();
  const liveIds = new Set();
  let seenChanged = false;

  // Archivée jusqu'à nouvelle activité : une session qui se remet à bouger réapparaît d'elle-même.
  const archived = store.state.archived;
  let archiveChanged = false;
  const isArchived = (sessionId, since) => {
    const at = sessionId && archived[sessionId];
    if (!at) return false;
    if (since > at + 1000) {
      delete archived[sessionId];
      archiveChanged = true;
      return false;
    }
    return true;
  };

  for (const { e, pi } of bySession.values()) {
    const p = pi.tty ? ptyByTty.get(pi.tty) : null;
    if (p) matched.add(p.id);
    liveIds.add(e.sessionId);
    const key = p ? `pty:${p.id}` : `sid:${e.sessionId}`;
    const file = sessions.transcriptFile(e.sessionId, e.cwd);
    const meta = file ? await sessions.transcriptMeta(file, LIVE_META_MAX_AGE_MS) : null;
    const changedAt = e.statusUpdatedAt || e.updatedAt || e.startedAt || 0;

    // Premier lancement de l'appli : tout ce qui est déjà au repos est considéré comme lu.
    if (store.firstRun && !primed && e.status === 'idle') store.state.seen[e.sessionId] = now;
    // Session affichée (terminal ou aperçu de la conversation) et fenêtre au premier plan : elle est lue.
    if (key === selectedKey && focused && changedAt > (store.state.seen[e.sessionId] || 0)) {
      store.state.seen[e.sessionId] = now;
      seenChanged = true;
    }

    const state = liveState(e, meta, store.state.seen[e.sessionId] || 0);
    const title = titleOf(e, meta, p);
    if (p) {
      // Mémorisé pour le moment où Claude s'arrête et que le terminal retombe sur le shell.
      p.lastSessionId = meta ? e.sessionId : null; // sans transcript, il n'y a rien à reprendre
      p.lastTitle = title;
      p.lastCwd = e.cwd || (meta && meta.cwd) || null;
    }
    if (!p && !hostApps.has(e.pid)) {
      hostApps.set(e.pid, null);
      sessions.hostAppOf(e.pid).then((a) => {
        hostApps.set(e.pid, a ? path.basename(a, '.app') : null);
        refreshSoon();
      });
    }
    out.push({
      key,
      kind: 'live',
      host: p ? 'app' : 'external',
      ptyId: p ? p.id : null,
      sessionId: e.sessionId,
      pid: e.pid,
      tty: pi.tty,
      hostApp: p ? null : hostApps.get(e.pid) || null,
      cwd: e.cwd || (meta && meta.cwd) || null,
      title,
      lastPrompt: (meta && meta.lastPrompt) || null,
      state,
      waitingFor: e.status === 'waiting' ? e.waitingFor || 'action requise' : null,
      since: changedAt,
      startedAt: e.startedAt || null,
      stale: (state === 'idle' || state === 'ready') && now - changedAt > cfg.staleAfterHours * 3600000,
      archived: p ? false : isArchived(e.sessionId, changedAt),
      context: contextOf(meta, status.get(e.sessionId), e.sessionId),
      activity: e.status === 'busy' ? activityOf(meta) : null,
      turnActions: meta ? meta.turnActions || 0 : 0,
      turnPartial: meta ? !!meta.turnPartial : false,
      branch: meta ? meta.gitBranch || null : null,
    });
  }

  // Terminaux de l'appli où Claude ne tourne pas (encore, ou plus).
  for (const p of ptys.list()) {
    if (matched.has(p.id)) continue;
    const starting = !p.lastSessionId && now - p.createdAt < 20000;
    out.push({
      key: `pty:${p.id}`,
      kind: 'shell',
      host: 'app',
      ptyId: p.id,
      sessionId: null,
      lastSessionId: p.lastSessionId || null,
      cwd: p.lastCwd || null,
      title: p.lastTitle || (starting ? p.label : cleanTitle(p.title) || p.label || 'Shell'),
      lastPrompt: null,
      state: starting ? 'starting' : 'shell',
      waitingFor: null,
      since: p.createdAt,
      stale: false,
    });
  }

  // Sessions déjà rattachées à un terminal de l'appli (en reprise, ou shell où Claude vient de s'arrêter).
  const resuming = new Set(ptys.list().flatMap((p) => [p.resumeOf, p.lastSessionId]).filter(Boolean));
  for (const c of closedCache) {
    if (liveIds.has(c.sessionId) || resuming.has(c.sessionId)) continue;
    out.push({
      key: `old:${c.sessionId}`,
      kind: 'closed',
      host: null,
      ptyId: null,
      sessionId: c.sessionId,
      cwd: c.cwd,
      title: c.customTitle || c.aiTitle || shorten(c.lastPrompt) || c.sessionId.slice(0, 8),
      lastPrompt: c.lastPrompt,
      context: contextOf(c, null, c.sessionId),
      branch: c.gitBranch || null,
      state: 'closed',
      waitingFor: null,
      since: c.mtimeMs,
      stale: false,
      archived: isArchived(c.sessionId, c.mtimeMs),
    });
  }

  if (cfg.showBackgroundAgents) {
    for (const b of bgCache) {
      if (liveIds.has(b.sessionId)) continue;
      out.push({
        key: `bg:${b.id}`,
        kind: 'background',
        host: null,
        ptyId: null,
        bgId: b.id,
        sessionId: b.sessionId || null,
        cwd: b.cwd || null,
        title: b.name || b.id,
        lastPrompt: null,
        state: 'background',
        bgState: b.state || b.status || null,
        waitingFor: null,
        since: b.startedAt || 0,
        stale: false,
        archived: isArchived(b.sessionId, b.startedAt || 0),
      });
    }
  }

  if (seenChanged || archiveChanged) store.saveState();
  if (store.firstRun && !primed) store.saveState();
  notifyTransitions(out, focused);
  primed = true;

  const u = usage ? usage.current(status) : null;
  const up = JSON.stringify(u);
  if (up !== lastUsagePayload) {
    lastUsagePayload = up;
    usageNow = u;
    send('deck:usage', u);
  }

  const payload = JSON.stringify(out);
  if (payload !== lastPayload) {
    lastPayload = payload;
    items = out;
    send('deck:items', out);
    updateIndicators();
  }
}

async function scanClosed() {
  try {
    closedCache = await sessions.recentTranscripts(store.config.closedSessionsDays);
    refreshSoon();
  } catch (err) {
    console.error('scanClosed', err);
  }
}

async function scanBackground() {
  lastBgScan = Date.now();
  if (!store.config.showBackgroundAgents) return;
  const list = await sessions.backgroundAgents(ptyEnv());
  if (list) {
    bgCache = list;
    refreshSoon();
  }
}

// --- Notifications, badge du Dock, barre des menus --------------------------------------

function notifyTransitions(list, focused) {
  for (const it of list) {
    if (it.kind !== 'live') continue;
    const prev = prevStates.get(it.sessionId);
    prevStates.set(it.sessionId, it.state);
    if (!primed || !store.config.notifications || prev === undefined || prev === it.state) continue;
    if (focused && it.key === selectedKey) continue;
    if (it.state === 'waiting') {
      notify('Claude attend ta réponse', it.waitingFor ? `${it.title} — ${it.waitingFor}` : it.title, it.key);
    } else if (it.state === 'done' && (prev === 'busy' || prev === 'waiting')) {
      notify('Claude a terminé', it.title, it.key);
    }
  }
}

function notify(title, body, key) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: store.config.notificationSound === false });
  liveNotifications.add(n);
  n.on('click', () => {
    liveNotifications.delete(n);
    openItem(key);
  });
  n.on('close', () => liveNotifications.delete(n));
  n.show();
}

const STATE_EMOJI = {
  waiting: '🟠',
  busy: '🔵',
  done: '🟢',
  idle: '⚪️',
  ready: '⚪️',
  starting: '🔵',
  shell: '⚫️',
};

function counts() {
  const c = { waiting: 0, done: 0, busy: 0 };
  for (const it of items) if (it.kind === 'live' && !it.archived && it.state in c) c[it.state] += 1;
  return c;
}

function updateIndicators() {
  const c = counts();
  const todo = c.waiting + c.done;
  if (app.dock) app.dock.setBadge(todo && store.config.showDockBadge !== false ? String(todo) : '');
  if (!tray) return;
  const parts = [];
  if (c.waiting) parts.push(`🟠${c.waiting}`);
  if (c.done) parts.push(`🟢${c.done}`);
  if (c.busy) parts.push(`🔵${c.busy}`);
  tray.setTitle(parts.length ? ` ${parts.join(' ')}` : '', { fontType: 'monospacedDigit' });
  const pctText = (w) => (w && w.pct != null ? `${Math.round(w.pct)} %` : '—');
  const usageText = usageNow ? ` · forfait : session ${pctText(usageNow.session)}, semaine ${pctText(usageNow.week)}` : '';
  tray.setToolTip(`Claude Deck — ${c.waiting} en attente, ${c.done} terminée(s), ${c.busy} en cours${usageText}`);

  const live = items.filter((i) => (i.kind === 'live' || i.kind === 'shell') && !i.archived);
  const order = { waiting: 0, done: 1, busy: 2, starting: 2, ready: 3, idle: 3, shell: 4 };
  live.sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9) || b.since - a.since);
  const template = live.map((i) => ({
    label: `${STATE_EMOJI[i.state] || '⚪️'}  ${shorten(i.title, 60)}`,
    sublabel: i.host === 'external' ? i.hostApp || 'Terminal externe' : undefined,
    click: () => openItem(i.key),
  }));
  if (template.length) template.push({ type: 'separator' });
  if (updater.state.status === 'ready') {
    template.push({ label: `Redémarrer pour installer la version ${updater.state.latest}`, click: () => installUpdateNow() }, { type: 'separator' });
  }
  template.push(
    { label: 'Nouvelle session', click: () => startNew() },
    { label: 'Afficher Claude Deck', click: showWindow },
    { type: 'separator' },
    { label: 'Quitter Claude Deck', click: () => app.quit() },
  );
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Claude Deck');
}

// --- Actions ------------------------------------------------------------------------

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function select(key) {
  showWindow();
  selectedKey = key;
  send('deck:select', key);
}

function startPty(command, label, resumeOf = null) {
  const p = ptys.create({ command, shell: store.config.shell, env: ptyEnv(), label, resumeOf });
  if (resumeOf) {
    // La reprise n'est pas « du nouveau » : on évite qu'elle s'affiche comme terminée au démarrage.
    store.state.seen[resumeOf] = Date.now() + 20000;
    store.saveState();
  }
  selectedKey = `pty:${p.id}`;
  refreshSoon(50);
  return selectedKey;
}

function startNew() {
  const key = startPty(store.config.newSessionCommand, 'Nouvelle session');
  select(key);
  return key;
}

async function startNewInFolder() {
  const r = await dialog.showOpenDialog(win, {
    title: 'Dossier de travail de la nouvelle session',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: os.homedir(),
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const cwd = r.filePaths[0];
  return startPty(fill(store.config.newSessionInFolderCommand, { cwd }), `Nouvelle session — ${path.basename(cwd)}`);
}

function findSession(sessionId) {
  return (
    items.find((i) => i.sessionId === sessionId) ||
    closedCache.find((c) => c.sessionId === sessionId) ||
    searchIndex.entries.find((e) => e.sessionId === sessionId) ||
    null
  );
}

// fork : nouvelle conversation qui repart de celle-ci (--fork-session) ; l'originale reste intacte.
function resume(sessionId, { fork = false } = {}) {
  if (!SESSION_ID_RE.test(sessionId || '')) return null;
  const known = findSession(sessionId);
  const cwd = (known && known.cwd) || os.homedir();
  const title = (known && (known.title || known.customTitle || known.aiTitle)) || `Reprise ${sessionId.slice(0, 8)}`;
  delete store.state.archived[sessionId];
  store.saveState();
  let command = fill(store.config.resumeCommand, { cwd, sessionId });
  if (fork) command += ' --fork-session';
  return startPty(command, fork ? `Copie — ${title}` : title, fork ? null : sessionId);
}

// --- Recherche dans toutes les conversations reprenables ------------------------------------------
// Titres et dossiers viennent des transcripts, le texte de tous tes prompts de ~/.claude/history.jsonl.

let searchIndex = { builtAt: 0, entries: [] };
let indexing = null;

const norm = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

function buildSearchIndex() {
  if (indexing) return indexing;
  indexing = (async () => {
    const list = await sessions.describeTranscripts(await sessions.listTranscripts());
    const hist = await sessions.readHistory();
    const entries = [];
    for (const m of list) {
      const h = hist.get(m.sessionId);
      const prompts = h && h.prompts.length ? h.prompts : m.lastPrompt ? [{ text: m.lastPrompt, ts: m.mtimeMs }] : [];
      const title = m.customTitle || m.aiTitle || shorten(m.lastPrompt) || m.sessionId.slice(0, 8);
      const cwd = m.cwd || (h && h.project) || null;
      const digest = await sessions.transcriptDigest(m.file);
      const answers = digest.answers;
      entries.push({
        sessionId: m.sessionId,
        cwd,
        title,
        lastPrompt: m.lastPrompt,
        mtimeMs: m.mtimeMs,
        prompts,
        answers,
        days: digest.days,
        n: { title: norm(title), cwd: norm(cwd), prompts: prompts.map((p) => norm(p.text)), answers: norm(answers) },
      });
    }
    searchIndex = { builtAt: Date.now(), entries };
  })()
    .catch((err) => console.error('index', err))
    .finally(() => {
      indexing = null;
    });
  return indexing;
}

function excerpt(text, normText, tokens) {
  let idx = -1;
  for (const t of tokens) {
    const i = normText.indexOf(t);
    if (i >= 0 && (idx < 0 || i < idx)) idx = i;
  }
  if (idx < 0) return shorten(text, 140);
  const start = Math.max(0, idx - 50);
  const end = Math.min(text.length, idx + 110);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

function occurrences(haystack, needle, max = 12) {
  let n = 0;
  for (let i = haystack.indexOf(needle); i >= 0 && n < max; i = haystack.indexOf(needle, i + needle.length)) n += 1;
  return n;
}

async function search(query) {
  const tokens = norm(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  if (!searchIndex.builtAt) await buildSearchIndex();
  else if (Date.now() - searchIndex.builtAt > 30000) buildSearchIndex(); // rafraîchi en arrière-plan
  const found = [];
  for (const e of searchIndex.entries) {
    let score = 0;
    let ok = true;
    for (const t of tokens) {
      const inTitle = e.n.title.includes(t);
      const inPrompt = e.n.prompts.some((p) => p.includes(t));
      const inCwd = e.n.cwd.includes(t);
      const inId = e.sessionId.startsWith(t);
      const inAnswer = e.n.answers.includes(t);
      if (!inTitle && !inPrompt && !inCwd && !inId && !inAnswer) {
        ok = false;
        break;
      }
      // Un mot qui revient souvent dans les réponses désigne plutôt le sujet de la conversation.
      const answerScore = inAnswer ? 1 + Math.min(2, Math.floor(occurrences(e.n.answers, t) / 4)) : 0;
      score += (inTitle ? 4 : 0) + (inPrompt ? 2 : 0) + (inCwd ? 1 : 0) + (inId ? 6 : 0) + answerScore;
    }
    if (!ok) continue;
    let best = -1;
    let bestHits = 0;
    e.n.prompts.forEach((p, i) => {
      const hits = tokens.filter((t) => p.includes(t)).length;
      if (hits > bestHits) {
        best = i;
        bestHits = hits;
      }
    });
    let snippet = null;
    if (best >= 0) snippet = excerpt(e.prompts[best].text, e.n.prompts[best], tokens);
    else if (tokens.some((t) => e.n.answers.includes(t))) snippet = `Claude : ${excerpt(e.answers, e.n.answers, tokens)}`;
    found.push({ e, score, snippet });
  }
  found.sort((a, b) => b.score - a.score || b.e.mtimeMs - a.e.mtimeMs);
  return found.slice(0, 100).map(({ e, snippet }) => {
    const known = items.find((i) => i.sessionId === e.sessionId);
    if (known) return { ...known, snippet };
    const at = store.state.archived[e.sessionId];
    return {
      key: `old:${e.sessionId}`,
      kind: 'closed',
      host: null,
      ptyId: null,
      sessionId: e.sessionId,
      cwd: e.cwd,
      title: e.title,
      lastPrompt: e.lastPrompt,
      state: 'closed',
      waitingFor: null,
      since: e.mtimeMs,
      stale: false,
      archived: !!(at && e.mtimeMs <= at + 1000),
      snippet,
    };
  });
}

async function focusExternalItem(it) {
  if (!it || it.host !== 'external') return { ok: false };
  store.state.seen[it.sessionId] = Date.now();
  store.saveState();
  const res = await sessions.focusExternal(it.pid, it.tty);
  refreshSoon();
  return res;
}

function openItem(key) {
  const it = items.find((i) => i.key === key);
  if (it && it.host === 'external') focusExternalItem(it);
  else select(key);
}

function confirmBox(options) {
  const parent = win && !win.isDestroyed() && win.isVisible() ? win : undefined;
  return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
}

// --- Fenêtre et menus ------------------------------------------------------------------

function validBounds(b) {
  if (!b || !b.width || !b.height) return null;
  if (b.x === undefined || b.y === undefined) return { width: b.width, height: b.height };
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y >= a.y - 20 && b.y < a.y + a.height - 80;
  });
  return visible ? b : { width: b.width, height: b.height };
}

function createWindow() {
  const b = validBounds(store.state.bounds) || { width: 1440, height: 900 };
  win = new BrowserWindow({
    ...b,
    minWidth: 820,
    minHeight: 480,
    title: 'Claude Deck',
    backgroundColor: '#111317',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  let boundsTimer = null;
  const saveBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!win || win.isDestroyed() || win.isFullScreen() || win.isMinimized()) return;
      store.state.bounds = win.getBounds();
      store.saveState();
    }, 400);
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.on('focus', () => {
    refreshSoon(30);
    if (Date.now() - lastBgScan > 20000) scanBackground();
  });
  // Fermer la fenêtre ne tue pas les sessions : l'appli reste dans le Dock et la barre des menus.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function command(name) {
  return () => {
    showWindow();
    send('deck:command', name);
  };
}

// --- Mises à jour -------------------------------------------------------------------------

function installUpdateNow() {
  updater.relaunch = true;
  app.quit(); // la confirmation habituelle s'affiche si des sessions tournent dans l'appli
}

async function checkUpdatesManually() {
  const s = await updater.check({ manual: true });
  if (s.status === 'ready') {
    const { response } = await confirmBox({
      type: 'info',
      buttons: ['Redémarrer maintenant', 'Plus tard'],
      defaultId: 0,
      cancelId: 1,
      message: `Claude Deck ${s.latest} est prête à installer`,
      detail: `${s.notes ? `${s.notes}\n\n` : ''}Sinon, elle s’installera à la prochaine fermeture de l’appli.`,
    });
    if (response === 0) installUpdateNow();
  } else if (s.status === 'uptodate') {
    await confirmBox({ type: 'info', message: 'Claude Deck est à jour', detail: `Version ${app.getVersion()}.` });
  } else if (s.status === 'error') {
    await confirmBox({ type: 'warning', message: 'Vérification des mises à jour impossible', detail: s.error });
  }
}

// --- Usage du forfait et statistiques ---------------------------------------------------------

async function toggleBridge(enable) {
  if (!usage) return null;
  try {
    if (enable) {
      const st = usage.bridgeState();
      if (st.error) throw new Error(st.error);
      const { response } = await confirmBox({
        type: 'question',
        buttons: ['Activer', 'Annuler'],
        defaultId: 0,
        cancelId: 1,
        message: 'Afficher l’usage de ton forfait en direct ?',
        detail:
          'Claude Deck ajoute une barre d’état à Claude Code, dans ~/.claude/settings.json (sauvegardé avant modification). ' +
          'Après chaque réponse, Claude Code lui transmet le contexte utilisé et tes limites d’usage (session de 5 h, semaine). ' +
          'Elle les enregistre sur ton Mac pour Claude Deck et affiche une ligne « Contexte · Session · Semaine » en bas de tes sessions Claude, ' +
          'y compris dans Terminal.' +
          (st.other ? '\n\nTa barre d’état actuelle reste affichée à la place de cette ligne.' : '') +
          '\n\nLes sessions déjà ouvertes la prendront au plus tard à leur prochain lancement. Désactivable dans le menu Présentation.',
      });
      if (response === 0) usage.installBridge();
    } else {
      usage.uninstallBridge();
    }
  } catch (err) {
    await confirmBox({ type: 'error', message: 'Modification de la barre d’état impossible', detail: err.message });
  }
  buildMenu(); // remet la coche du menu à jour (y compris après « Annuler »)
  const state = usage.bridgeState();
  send('deck:bridge', state);
  return state;
}

// --- Réglages (vue Réglages de l'appli) -------------------------------------------------------

const ACCELERATOR_RE =
  /^((CmdOrCtrl|CommandOrControl|Command|Cmd|Control|Ctrl|Alt|Option|Shift|Super)\+)*([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Space|Tab|Backspace|Delete|Enter|Return|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|[=\-[\];',./`\\])$/;
const isAccelerator = (v) => v === '' || (typeof v === 'string' && v.length < 60 && ACCELERATOR_RE.test(v));

// Type attendu de chaque réglage modifiable depuis l'interface : rien d'autre n'est accepté.
const SETTINGS_SCHEMA = {
  newSessionCommand: 'command',
  newSessionInFolderCommand: 'command',
  resumeCommand: 'command',
  shell: 'path',
  closedSessionsDays: [1, 30],
  staleAfterHours: [1, 168],
  notifications: 'boolean',
  notificationSound: 'boolean',
  showTray: 'boolean',
  showDockBadge: 'boolean',
  showBackgroundAgents: 'boolean',
  autoUpdate: 'boolean',
  fontFamily: 'font',
  fontSize: [9, 28],
  lineHeight: [0.8, 2],
  scrollSpeed: [1, 5],
  claudeDisplay: ['auto', 'classic', 'fullscreen'],
  globalShortcut: 'accelerator',
  shortcuts: 'shortcuts',
};

function sanitizeSettings(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch || {})) {
    const rule = SETTINGS_SCHEMA[k];
    if (!rule) continue;
    if (rule === 'boolean' && typeof v === 'boolean') out[k] = v;
    else if (rule === 'command' && typeof v === 'string' && v.trim() && v.length < 500 && !/[\r\n]/.test(v)) out[k] = v.trim();
    else if (rule === 'path' && typeof v === 'string' && path.isAbsolute(v) && fs.existsSync(v)) out[k] = v;
    else if (rule === 'font' && typeof v === 'string' && v.trim() && v.length < 200 && !/[;{}<>]/.test(v)) out[k] = v.trim();
    else if (rule === 'accelerator' && isAccelerator(v)) out[k] = v;
    else if (Array.isArray(rule) && typeof rule[0] === 'string' && rule.includes(v)) out[k] = v;
    else if (Array.isArray(rule) && typeof v === 'number' && Number.isFinite(v)) out[k] = Math.min(rule[1], Math.max(rule[0], v));
    else if (rule === 'shortcuts' && v && typeof v === 'object') {
      const sc2 = {};
      for (const [name, acc] of Object.entries(v)) if (name in DEFAULT_CONFIG.shortcuts && isAccelerator(acc)) sc2[name] = acc;
      out.shortcuts = { ...store.config.shortcuts, ...sc2 };
    }
  }
  return out;
}

let registeredGlobal = null;
let globalShortcutOk = true;
function applyGlobalShortcut() {
  if (registeredGlobal) globalShortcut.unregister(registeredGlobal);
  registeredGlobal = null;
  globalShortcutOk = true;
  const acc = store.config.globalShortcut;
  if (!acc) return;
  try {
    // Afficher l'appli, ou la masquer si elle est déjà devant.
    globalShortcutOk = globalShortcut.register(acc, () => {
      if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) app.hide();
      else showWindow();
    });
  } catch {
    globalShortcutOk = false;
  }
  if (globalShortcutOk) registeredGlobal = acc;
}

function applyTray() {
  if (store.config.showTray === false) {
    if (tray) tray.destroy();
    tray = null;
  } else if (!tray) {
    if (store.config.showTray !== false) createTray();
    applyGlobalShortcut();
    updateIndicators();
  }
}

function settingsPayload() {
  return {
    config: store.config,
    defaults: DEFAULT_CONFIG,
    version: app.getVersion(),
    packaged: app.isPackaged,
    loginItem: app.isPackaged ? app.getLoginItemSettings().openAtLogin : null,
    bridge: usage ? usage.bridgeState() : null,
    globalShortcutOk,
    update: updater.state,
  };
}

function applySettings(patch) {
  const clean = sanitizeSettings(patch);
  if (!Object.keys(clean).length) return settingsPayload();
  Object.assign(store.config, clean);
  writeConfig();
  buildMenu();
  if ('globalShortcut' in clean) applyGlobalShortcut();
  if ('showTray' in clean) applyTray();
  updateIndicators();
  if ('closedSessionsDays' in clean) scanClosed();
  send('deck:config', store.config);
  refreshSoon(50);
  return settingsPayload();
}

// --- Autorisations macOS ---------------------------------------------------------------------
// Une appli ne peut pas s'accorder elle-même ces droits : on affiche leur état, on déclenche les demandes
// qui existent (dossiers, micro) et on ouvre la bonne page des Réglages pour le reste.

const SETTINGS_PANES = {
  fullDisk: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles',
  files: 'x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  notifications: 'x-apple.systempreferences:com.apple.preference.notifications',
};
const PROTECTED_FOLDERS = [
  ['documents', 'Documents'],
  ['desktop', 'Bureau'],
  ['downloads', 'Téléchargements'],
];
const folderAccess = {}; // résultat de la dernière demande, par dossier

// L'accès complet au disque ouvre la base des autorisations de macOS ; sans lui, macOS refuse sans rien demander.
async function hasFullDiskAccess() {
  try {
    const fh = await fs.promises.open(path.join(os.homedir(), 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db'), 'r');
    await fh.close();
    return true;
  } catch {
    return false;
  }
}

async function permissionsStatus() {
  const fullDisk = await hasFullDiskAccess();
  return {
    fullDisk,
    microphone: systemPreferences.getMediaAccessStatus('microphone'),
    folders: PROTECTED_FOLDERS.map(([id, label]) => ({ id, label, status: fullDisk ? 'granted' : folderAccess[id] || 'unknown' })),
  };
}

async function permissionAction(action) {
  if (action === 'folders') {
    // Lire un dossier protégé déclenche la demande de macOS (une fois par dossier).
    for (const [id] of PROTECTED_FOLDERS) {
      folderAccess[id] = await fs.promises.readdir(app.getPath(id)).then(() => 'granted', () => 'denied');
    }
  } else if (action === 'microphone') {
    const status = systemPreferences.getMediaAccessStatus('microphone');
    if (status === 'not-determined') await systemPreferences.askForMediaAccess('microphone');
    else if (status !== 'granted') shell.openExternal(SETTINGS_PANES.microphone);
  } else if (action === 'relaunch') {
    app.relaunch();
    app.quit(); // la confirmation habituelle s'affiche si des sessions tournent dans l'appli
  } else if (SETTINGS_PANES[action]) {
    shell.openExternal(SETTINGS_PANES[action]);
  }
  return permissionsStatus();
}

// Activité des 30 derniers jours (transcripts encore présents) + historique des pourcentages d'usage.
async function computeStats() {
  if (!searchIndex.builtAt || Date.now() - searchIndex.builtAt > 60000) await buildSearchIndex();
  const since = Date.now() - 30 * 86400000;
  const days = {};
  const projects = {};
  for (const e of searchIndex.entries) {
    const name = e.cwd ? path.basename(e.cwd) : '—';
    for (const [day, v] of Object.entries(e.days || {})) {
      if (new Date(`${day}T12:00:00`).getTime() < since) continue;
      const d = (days[day] ||= { requests: 0, output: 0, input: 0, sessions: 0 });
      d.requests += v.requests;
      d.output += v.output;
      d.input += v.input;
      d.sessions += 1;
      const p = (projects[name] ||= { requests: 0, sessions: new Set() });
      p.requests += v.requests;
      p.sessions.add(e.sessionId);
    }
  }
  return {
    usage: usageNow,
    bridge: usage ? usage.bridgeState() : null,
    history: usage ? usage.history : [],
    days,
    projects: Object.entries(projects)
      .map(([name, p]) => ({ name, requests: p.requests, sessions: p.sessions.size }))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 8),
  };
}

updater.on('state', (s) => {
  send('deck:update', s);
  if (s.status === 'ready' && tray) updateIndicators();
});

// Raccourci configuré pour une action ('' = désactivé, absent = valeur par défaut).
let recordingShortcut = false; // pendant qu'on tape une combinaison dans les Réglages, les menus ne la captent pas
const A = (acc) => (recordingShortcut ? undefined : acc);

function sc(name) {
  if (recordingShortcut) return undefined;
  const v = store.config.shortcuts && store.config.shortcuts[name];
  if (v === '') return undefined;
  return v || DEFAULT_CONFIG.shortcuts[name];
}

function buildMenu() {
  const template = [
    {
      label: 'Claude Deck',
      submenu: [
        { role: 'about', label: 'À propos de Claude Deck' },
        { label: 'Rechercher les mises à jour…', click: () => checkUpdatesManually() },
        { label: 'Autorisations macOS…', click: command('settings:perms') },
        { type: 'separator' },
        { label: 'Réglages…', accelerator: sc('settings'), click: command('settings') },
        {
          label: 'Ouvrir à l’ouverture de session',
          type: 'checkbox',
          visible: app.isPackaged,
          checked: app.isPackaged && app.getLoginItemSettings().openAtLogin,
          click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
        },
        { type: 'separator' },
        { role: 'hide', label: 'Masquer Claude Deck' },
        { role: 'hideOthers', label: 'Masquer les autres' },
        { role: 'unhide', label: 'Tout afficher' },
        { type: 'separator' },
        { role: 'quit', label: 'Quitter Claude Deck' },
      ],
    },
    {
      label: 'Session',
      submenu: [
        { label: 'Nouvelle session', accelerator: sc('newSession'), click: () => startNew() },
        {
          label: 'Nouvelle session dans un dossier…',
          accelerator: sc('newSessionInFolder'),
          click: async () => {
            const key = await startNewInFolder();
            if (key) select(key);
          },
        },
        { type: 'separator' },
        { label: 'Rechercher dans les conversations…', accelerator: sc('search'), click: command('search') },
        { label: 'Archiver la session', accelerator: sc('archive'), click: command('archive') },
        { type: 'separator' },
        { label: 'Statistiques et usage', accelerator: sc('stats'), click: command('stats') },
        { label: 'Prochaine session à traiter', accelerator: sc('nextAttention'), click: command('nextAttention') },
        { label: 'Session suivante', accelerator: sc('nextSession'), click: command('next') },
        { label: 'Session précédente', accelerator: sc('prevSession'), click: command('prev') },
        ...Array.from({ length: 9 }, (_, i) => ({
          label: `Session ${i + 1}`,
          accelerator: A(`CmdOrCtrl+${i + 1}`),
          visible: false,
          click: command(`goto:${i}`),
        })),
        { type: 'separator' },
        { label: 'Fermer la session', accelerator: sc('closeSession'), click: command('closeCurrent') },
      ],
    },
    {
      label: 'Édition',
      submenu: [
        { role: 'undo', label: 'Annuler' },
        { role: 'redo', label: 'Rétablir' },
        { type: 'separator' },
        { role: 'cut', label: 'Couper' },
        { role: 'copy', label: 'Copier' },
        { role: 'paste', label: 'Coller' },
        { label: 'Tout sélectionner', accelerator: A('CmdOrCtrl+A'), click: command('selectAll') },
        { label: 'Effacer le défilement', accelerator: A('CmdOrCtrl+K'), click: command('clear') },
      ],
    },
    {
      label: 'Présentation',
      submenu: [
        { label: 'Agrandir le texte', accelerator: A('CmdOrCtrl+='), click: command('font:+1') },
        { label: 'Réduire le texte', accelerator: A('CmdOrCtrl+-'), click: command('font:-1') },
        { label: 'Taille réelle', accelerator: A('CmdOrCtrl+0'), click: command('font:0') },
        { type: 'separator' },
        {
          label: 'Vitesse de défilement (molette)',
          submenu: [
            [1, 'Normale (comme Terminal)'],
            [2, 'Rapide (×2)'],
            [3, 'Très rapide (×3)'],
          ].map(([v, label]) => ({
            label,
            type: 'radio',
            checked: (store.config.scrollSpeed || 1) === v,
            click: () => setConfig({ scrollSpeed: v }),
          })),
        },
        {
          label: 'Barre d’état Claude Code (usage en direct)',
          type: 'checkbox',
          checked: !!(usage && usage.bridgeState().installed),
          click: (item) => toggleBridge(item.checked),
        },
        {
          label: 'Affichage de Claude (sessions lancées ensuite)',
          submenu: [
            ['auto', 'Selon ton réglage Claude Code (/tui)'],
            ['classic', 'Classique : historique et barre de défilement'],
            ['fullscreen', 'Plein écran'],
          ].map(([v, label]) => ({
            label,
            type: 'radio',
            checked: (store.config.claudeDisplay || 'auto') === v,
            click: () => setConfig({ claudeDisplay: v }),
          })),
        },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Plein écran' },
        { type: 'separator' },
        { role: 'reload', label: "Recharger l'interface", accelerator: A('CmdOrCtrl+Shift+R') },
        { role: 'toggleDevTools', label: 'Outils de développement' },
      ],
    },
    { role: 'windowMenu', label: 'Fenêtre' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- IPC --------------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('deck:checkUpdate', () => checkUpdatesManually());
  ipcMain.handle('deck:stats', () => computeStats());
  ipcMain.handle('deck:perms', () => permissionsStatus());
  ipcMain.handle('deck:settings', () => settingsPayload());
  ipcMain.handle('deck:settings:set', (_e, patch) => applySettings(patch));
  ipcMain.handle('deck:loginItem', (_e, enable) => {
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!enable });
    buildMenu();
    return settingsPayload();
  });
  ipcMain.on('deck:openConfigFile', () => shell.openPath(store.configFile));
  ipcMain.on('deck:recordingShortcut', (_e, on) => {
    recordingShortcut = !!on;
    buildMenu();
    if (recordingShortcut) globalShortcut.unregisterAll();
    else applyGlobalShortcut();
  });
  ipcMain.on('deck:openDataDir', () => shell.openPath(app.getPath('userData')));
  ipcMain.handle('deck:permAction', (_e, action) => permissionAction(String(action || '')));
  ipcMain.handle('deck:bridge', (_e, enable) => toggleBridge(!!enable));
  ipcMain.on('deck:bridgeDismiss', () => {
    store.state.bridgeDismissed = true;
    store.saveState();
  });
  ipcMain.on('deck:installUpdate', () => installUpdateNow());
  ipcMain.on('deck:openReleases', () => shell.openExternal(`${RELEASES_URL}/latest`));
  ipcMain.handle('deck:init', () => ({
    config: store.config,
    update: updater.state,
    usage: usageNow,
    bridge: usage ? usage.bridgeState() : null,
    bridgeDismissed: !!store.state.bridgeDismissed,
    items,
    selectedKey,
    collapsed: store.state.collapsed || {},
    lastOpen: store.state.lastOpen || [],
    ptys: ptys.list().map((p) => ({ ...ptys.describe(p), replay: ptys.replay(p.id) })),
  }));
  ipcMain.handle('deck:new', () => startNew());
  ipcMain.handle('deck:newInFolder', () => startNewInFolder());
  ipcMain.handle('deck:resume', (_e, sessionId, opts) => resume(sessionId, { fork: !!(opts && opts.fork) }));
  ipcMain.handle('deck:search', (_e, query) => search(String(query || '').slice(0, 200)));
  ipcMain.handle('deck:preview', async (_e, sessionId) => {
    if (!SESSION_ID_RE.test(sessionId || '')) return null;
    const known = findSession(sessionId);
    const file = sessions.transcriptFile(sessionId, known && known.cwd);
    if (!file) return { messages: [], truncated: false, missing: true };
    try {
      return await sessions.conversationPreview(file);
    } catch {
      return { messages: [], truncated: false, missing: true };
    }
  });
  ipcMain.handle('deck:archive', (_e, ids) => {
    const now = Date.now();
    let n = 0;
    for (const id of Array.isArray(ids) ? ids : []) {
      if (!SESSION_ID_RE.test(id || '')) continue;
      if (items.some((i) => i.sessionId === id && i.host === 'app')) continue; // un terminal de l'appli se ferme, il ne s'archive pas
      store.state.archived[id] = now;
      store.state.seen[id] = now;
      n += 1;
    }
    store.saveState();
    refreshSoon(30);
    return n;
  });
  ipcMain.handle('deck:unarchive', (_e, ids) => {
    let n = 0;
    for (const id of Array.isArray(ids) ? ids : []) {
      if (store.state.archived[id]) {
        delete store.state.archived[id];
        n += 1;
      }
    }
    store.saveState();
    refreshSoon(30);
    return n;
  });
  ipcMain.handle('deck:resumeAll', (_e, ids) => {
    let key = null;
    for (const id of Array.isArray(ids) ? ids : []) key = resume(id) || key;
    store.state.lastOpen = [];
    store.saveState();
    return key;
  });
  ipcMain.on('deck:dismissLastOpen', () => {
    store.state.lastOpen = [];
    store.saveState();
  });
  ipcMain.handle('deck:attach', (_e, bgId) => {
    if (!BG_ID_RE.test(bgId || '')) return null;
    const bg = bgCache.find((b) => b.id === bgId);
    return startPty(fill(store.config.attachCommand, { id: bgId }), (bg && bg.name) || `Agent ${bgId}`);
  });
  // Terminal retombé sur le shell : on tape la commande de reprise dedans, comme on le ferait à la main.
  ipcMain.handle('deck:relaunchHere', (_e, ptyId) => {
    const p = ptys.get(ptyId);
    const it = items.find((i) => i.ptyId === ptyId);
    if (!p || !it || it.kind !== 'shell') return false;
    let cmd = store.config.newSessionCommand;
    if (p.lastSessionId) {
      cmd = fill(store.config.resumeCommand, { cwd: p.lastCwd || os.homedir(), sessionId: p.lastSessionId });
      p.resumeOf = p.lastSessionId;
      store.state.seen[p.lastSessionId] = Date.now() + 20000;
      store.saveState();
    }
    ptys.write(ptyId, `${cmd}\r`);
    refreshSoon(300);
    return true;
  });
  ipcMain.handle('deck:focusExternal', (_e, sessionId) => {
    return focusExternalItem(items.find((i) => i.sessionId === sessionId && i.host === 'external'));
  });
  ipcMain.handle('deck:adopt', async (_e, sessionId) => {
    const it = items.find((i) => i.sessionId === sessionId && i.host === 'external');
    if (!it) return null;
    if (it.state === 'busy' || it.state === 'waiting') {
      await confirmBox({
        type: 'info',
        message: 'Session occupée',
        detail: 'Claude est en train de travailler (ou attend une réponse) dans cette session. Attends qu’elle soit au repos pour la rapatrier.',
      });
      return null;
    }
    const where = it.hostApp || 'son terminal';
    const { response } = await confirmBox({
      type: 'question',
      buttons: ['Rapatrier', 'Annuler'],
      defaultId: 0,
      cancelId: 1,
      message: `Rapatrier « ${shorten(it.title, 60)} » dans Claude Deck ?`,
      detail: `La session sera arrêtée dans ${where}, puis reprise ici avec --resume (même conversation, même dossier). L’onglet d’origine retombera sur le shell.`,
    });
    if (response !== 0) return null;
    const ok = await sessions.terminate(it.pid);
    if (!ok) {
      await confirmBox({ type: 'error', message: 'La session ne s’est pas arrêtée', detail: `Le processus ${it.pid} tourne toujours.` });
      return null;
    }
    return resume(sessionId);
  });
  ipcMain.handle('deck:close', async (_e, ptyId) => {
    const p = ptys.get(ptyId);
    if (!p) return false;
    const it = items.find((i) => i.ptyId === ptyId);
    if (it && it.kind === 'live') {
      const busy = it.state === 'busy' || it.state === 'waiting';
      const { response } = await confirmBox({
        type: busy ? 'warning' : 'question',
        buttons: ['Fermer', 'Annuler'],
        defaultId: busy ? 1 : 0,
        cancelId: 1,
        message: busy ? 'Claude est encore en train de travailler' : 'Fermer cette session ?',
        detail: `« ${shorten(it.title, 70)} » sera arrêtée. Tu pourras la reprendre depuis « Fermées récemment ».`,
      });
      if (response !== 0) return false;
    }
    ptys.kill(ptyId);
    return true;
  });
  ipcMain.on('deck:select', (_e, key) => {
    selectedKey = key;
    const it = items.find((i) => i.key === key);
    // Un clic sur une session suffit à la marquer comme lue, qu'elle tourne ici ou dans Terminal.
    if (it && it.sessionId && it.kind === 'live') {
      store.state.seen[it.sessionId] = Date.now();
      store.saveState();
    }
    refreshSoon(30);
  });
  ipcMain.on('deck:markSeen', (_e, sessionId) => {
    if (!SESSION_ID_RE.test(sessionId || '')) return;
    store.state.seen[sessionId] = Date.now();
    store.saveState();
    refreshSoon(30);
  });
  ipcMain.on('deck:collapsed', (_e, group, value) => {
    store.state.collapsed = { ...(store.state.collapsed || {}), [group]: !!value };
    store.saveState();
  });
  ipcMain.on('deck:fontSize', (_e, size) => {
    const n = Math.max(9, Math.min(28, Number(size) || 13));
    store.config.fontSize = n;
    writeConfig();
  });
  ipcMain.on('deck:openExternal', (_e, url) => {
    if (/^https?:\/\//.test(url || '')) shell.openExternal(url);
  });
  ipcMain.on('deck:openPath', (_e, p) => {
    if (typeof p === 'string' && path.isAbsolute(p) && fs.existsSync(p)) shell.openPath(p);
  });
  ipcMain.on('deck:copy', (_e, text) => clipboard.writeText(String(text || '')));
  ipcMain.on('pty:write', (_e, id, data) => ptys.write(id, data));
  ipcMain.on('pty:resize', (_e, id, cols, rows) => ptys.resize(id, cols, rows));
  ipcMain.on('pty:title', (_e, id, title) => {
    ptys.setTitle(id, String(title || '').slice(0, 200));
    refreshSoon(200);
  });
}

let configWriteGuard = 0;
function writeConfig() {
  configWriteGuard = Date.now();
  fs.writeFileSync(store.configFile, `${JSON.stringify(store.config, null, 2)}\n`);
}

function watchFiles() {
  try {
    fs.watch(sessions.REGISTRY_DIR, () => refreshSoon(80));
  } catch {
    // le dossier n'existe pas encore : le polling prend le relais
  }
  let t = null;
  try {
    fs.watch(store.configFile, () => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (Date.now() - configWriteGuard < 1000) return;
        store.reloadConfig();
        buildMenu(); // coches des menus Présentation
        send('deck:config', store.config);
        scanClosed();
      }, 200);
    });
  } catch {
    // pas bloquant
  }
}

// --- Cycle de vie -------------------------------------------------------------------------

ptys.on('created', (d) => send('pty:created', d));
ptys.on('data', (id, data) => send('pty:data', id, data));
ptys.on('exit', (id, code) => {
  send('pty:exit', id, code);
  refreshSoon(50);
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', showWindow);

  app.whenReady().then(() => {
    // Contenu 100 % local : aucune permission web (micro, caméra, géolocalisation…) sauf l'écriture du
    // presse-papiers utilisée par les terminaux (OSC 52).
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write');
    app.setAboutPanelOptions({
      applicationName: 'Claude Deck',
      applicationVersion: app.getVersion(),
      website: RELEASES_URL.replace(/\/releases$/, ''),
      credits: 'Projet indépendant, non affilié à Anthropic.',
    });
    store = new Store(app.getPath('userData'));
    usage = new Usage(app.getPath('userData'));
    if (usage.bridgeState().installed) usage.writeScript(); // garde le script en phase avec cette version
    if (app.dock) {
      const icon = path.join(__dirname, 'assets', 'icon.png');
      if (fs.existsSync(icon)) app.dock.setIcon(icon);
    }
    registerIpc();
    buildMenu();
    createWindow();
    createTray();
    watchFiles();
    scanClosed();
    scanBackground();
    setTimeout(buildSearchIndex, 3000);
    refresh();
    setInterval(refresh, REFRESH_MS);
    setInterval(scanClosed, CLOSED_SCAN_MS);
    setInterval(scanBackground, BACKGROUND_SCAN_MS);
    updater.start();
  });

  // Mise à jour téléchargée : le bundle est remplacé juste après la fermeture (et relancé si demandé).
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (updater.staged) updater.installOnExit();
  });

  app.on('activate', showWindow);

  app.on('before-quit', (e) => {
    if (quitting) return;
    const open = ptys.list().length;
    const inApp = items.filter((i) => i.host === 'app' && i.kind === 'live');
    if (open) {
      const busy = inApp.filter((i) => i.state === 'busy' || i.state === 'waiting').length;
      const options = {
        type: busy ? 'warning' : 'question',
        buttons: ['Quitter', 'Annuler'],
        defaultId: busy ? 1 : 0,
        cancelId: 1,
        message: 'Quitter Claude Deck ?',
        detail:
          `${open} terminal${open > 1 ? 'aux' : ''} ouvert${open > 1 ? 's' : ''} dans l’appli` +
          (busy ? `, dont ${busy} session${busy > 1 ? 's' : ''} Claude en plein travail` : '') +
          '. Les sessions seront arrêtées et proposées en reprise au prochain lancement.',
      };
      const parent = win && !win.isDestroyed() && win.isVisible() ? win : null;
      const r = parent ? dialog.showMessageBoxSync(parent, options) : dialog.showMessageBoxSync(options);
      if (r !== 0) {
        updater.relaunch = false;
        e.preventDefault();
        return;
      }
    }
    quitting = true;
    store.state.lastOpen = inApp.map((i) => i.sessionId);
    store.saveStateNow();
    ptys.killAll();
  });

  app.on('window-all-closed', () => {
    // macOS : on reste actif (Dock + barre des menus) tant que l'utilisateur ne quitte pas.
  });
}
