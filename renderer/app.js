'use strict';
/* global deck, Terminal, FitAddon, Unicode11Addon, WebLinksAddon, ClipboardAddon */

const $ = (sel) => document.querySelector(sel);
const listEl = $('#list');
const summaryEl = $('#summary');
const restoreEl = $('#restore');
const updateEl = $('#update');
const bridgeEl = $('#bridge');
const usageEl = $('#usage');
const searchEl = $('#search');
const headEl = $('#pane-head');
const termHost = $('#term-host');
const cardEl = $('#card');
const emptyEl = $('#empty');
const toastEl = $('#toast');

const S = {
  items: [],
  selected: null,
  selectedSessionId: null,
  snapshot: null, // dernière version connue de l'élément sélectionné (résultat de recherche ancien)
  config: {},
  collapsed: {},
  lastOpen: [],
  showAll: {},
  query: '',
  results: null, // null = pas de recherche en cours
  previews: new Map(), // sessionId -> { since, data, loading }
  terms: new Map(), // ptyId -> { term, fit, el }
  visiblePty: null,
  headSig: '',
  bodySig: '',
  update: null,
  updateDismissed: null,
  usage: null,
  bridge: null,
  bridgeDismissed: false,
  stats: null,
  statsAt: 0,
  settings: null,
  settingsTab: 'general',
  perms: null,
  recording: null, // raccourci en cours d'enregistrement
};

// --- Libellés -------------------------------------------------------------------------

const ICONS = {
  folder: '<path d="M2 4.5h4l1.5 1.5H14v6.5H2z"/>',
  close: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
  external: '<path d="M9 3h4v4M13 3L7.5 8.5M11 9.5V13H3V5h3.5"/>',
  adopt: '<path d="M8 2.5v7M5 6.5l3 3 3-3M3 11.5v2h10v-2"/>',
  play: '<path d="M5 3.5l7 4.5-7 4.5z"/>',
  fork: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="11.5" cy="3.5" r="1.5"/><circle cx="8" cy="12.5" r="1.5"/><path d="M4.5 5v1.5A2 2 0 0 0 6.5 8.5h3a2 2 0 0 0 2-2V5M8 8.5V11"/>',
  copy: '<rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.5"/><path d="M10.5 3h-6A1.5 1.5 0 0 0 3 4.5v6"/>',
  check: '<path d="M3.5 8.5l3 3 6-7"/>',
  chev: '<path d="M4 6l4 4 4-4"/>',
  attach: '<path d="M3 8h7M7 5l3 3-3 3M13 3v10"/>',
  archive: '<rect x="2.5" y="3" width="11" height="3" rx="1"/><path d="M3.5 6v6.5h9V6M6.5 8.5h3"/>',
  unarchive: '<rect x="2.5" y="3" width="11" height="3" rx="1"/><path d="M3.5 6v6.5h9V6M8 12V8.5M6.3 10L8 8.3 9.7 10"/>',
};
const icon = (name, cls = '') => `<svg viewBox="0 0 16 16" class="${cls}" aria-hidden="true">${ICONS[name]}</svg>`;

const WAITING_FR = {
  'dialog open': 'boîte de dialogue ouverte',
  'input needed': 'réponse attendue',
  'sandbox request': 'autorisation réseau demandée',
  'goal proposal': 'objectif à valider',
  'worker request': 'demande d’un agent',
};
const waitingFr = (w) => WAITING_FR[w] || w || 'action requise';

const PILL = {
  waiting: (it) => `En attente — ${waitingFr(it.waitingFor)}`,
  busy: () => 'En cours',
  done: () => 'Terminée',
  idle: (it) => (it.stale ? 'Inactive' : 'Au repos'),
  ready: () => 'Prête',
  starting: () => 'Démarrage…',
  shell: () => 'Shell (Claude arrêté)',
  closed: () => 'Fermée',
  background: (it) => `Agent en arrière-plan${it.bgState ? ` — ${it.bgState}` : ''}`,
};

const COLOR = {
  waiting: 'waiting',
  busy: 'busy',
  starting: 'busy',
  done: 'done',
  idle: 'idle',
  ready: 'idle',
  shell: 'idle',
  closed: 'closed',
  background: 'bg',
};

function statusText(it) {
  switch (it.state) {
    case 'waiting':
      return `attend : ${waitingFr(it.waitingFor)}`;
    case 'busy':
      return 'en cours';
    case 'done':
      return 'terminée — à lire';
    case 'idle':
      return it.stale ? 'inactive' : 'au repos';
    case 'ready':
      return 'prête — aucun prompt';
    case 'starting':
      return 'démarrage…';
    case 'shell':
      return 'Claude arrêté — shell ouvert';
    case 'closed':
      return 'fermée';
    case 'background':
      return `agent${it.bgState ? ` · ${it.bgState}` : ''}`;
    default:
      return it.state;
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return 'à l’instant';
  const m = s / 60;
  if (m < 60) return `${Math.round(m)} min`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)} h`;
  return `${Math.floor(h / 24)} j`;
}

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const homeify = (p) => (p || '').replace(/^\/Users\/[^/]+/, '~');
const folderName = (p) => (p ? p.split('/').filter(Boolean).pop() || '/' : '');
const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const shellEscape = (p) => p.replace(/([\s'"\\$`!*?#&;|<>(){}[\]])/g, '\\$1');
const norm = (s) =>
  String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

function fillTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? (k === 'cwd' ? shellQuote(vars[k]) : vars[k]) : m));
}

// Surligne les mots cherchés, sans tenir compte des accents ni de la casse.
function highlight(text, tokens) {
  const src = String(text || '');
  if (!tokens.length) return esc(src);
  const n = norm(src);
  if (n.length !== src.length) return esc(src);
  const marks = [];
  for (const t of tokens) {
    let i = n.indexOf(t);
    while (i >= 0) {
      marks.push([i, i + t.length]);
      i = n.indexOf(t, i + t.length);
    }
  }
  if (!marks.length) return esc(src);
  marks.sort((a, b) => a[0] - b[0]);
  let html = '';
  let pos = 0;
  for (const [a, b] of marks) {
    if (a < pos) continue;
    html += `${esc(src.slice(pos, a))}<mark>${esc(src.slice(a, b))}</mark>`;
    pos = b;
  }
  return html + esc(src.slice(pos));
}

// Markdown minimal pour les réponses de Claude : blocs de code, `code`, **gras**, titres.
function mdLite(s) {
  const parts = String(s).split('```');
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return `<pre>${esc(part.replace(/^[\w+-]*\n/, '').replace(/\n$/, ''))}</pre>`;
      // Le bloc de code a ses propres marges : pas de lignes vides en plus autour.
      let text = part;
      if (i > 0) text = text.replace(/^\n+/, '');
      if (i < parts.length - 1) text = text.replace(/\n+$/, '');
      return esc(text)
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        .replace(/^#{1,6} (.+)$/gm, '<strong>$1</strong>');
    })
    .join('');
}

let toastTimer = null;
let toastAction = null;
function toast(msg, action = null) {
  toastAction = action;
  toastEl.innerHTML = `<span>${esc(msg)}</span>${action ? `<button class="toast-btn">${esc(action.label)}</button>` : ''}`;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.hidden = true), action ? 6000 : 2600);
}
toastEl.addEventListener('click', (e) => {
  if (!e.target.closest('.toast-btn') || !toastAction) return;
  toastAction.run();
  toastAction = null;
  toastEl.hidden = true;
});

// --- Groupes et ordre --------------------------------------------------------------------

const byStart = (a, b) => (a.startedAt || a.since) - (b.startedAt || b.since);
const byRecent = (a, b) => b.since - a.since;

const GROUPS = [
  {
    id: 'todo',
    label: 'À traiter',
    match: (i) => i.kind === 'live' && (i.state === 'waiting' || i.state === 'done'),
    sort: (a, b) => (a.state === 'waiting' ? 0 : 1) - (b.state === 'waiting' ? 0 : 1) || b.since - a.since,
    alwaysShow: true,
    empty: 'Rien ne t’attend.',
  },
  {
    id: 'busy',
    label: 'En cours',
    match: (i) => (i.kind === 'live' && i.state === 'busy') || i.state === 'starting',
    sort: byStart,
  },
  {
    id: 'idle',
    label: 'Au repos',
    match: (i) => (i.kind === 'live' && (i.state === 'idle' || i.state === 'ready')) || i.state === 'shell',
    sort: (a, b) => Number(a.stale) - Number(b.stale) || b.since - a.since,
  },
  { id: 'closed', label: 'Fermées récemment', match: (i) => i.kind === 'closed', sort: byRecent, collapsible: true, limit: 10, bulkArchive: true },
  { id: 'background', label: 'Agents en arrière-plan', match: (i) => i.kind === 'background', sort: byRecent, collapsible: true, defaultCollapsed: true },
];
const ARCHIVED_GROUP = { id: 'archived', label: 'Archivées', sort: byRecent, collapsible: true, defaultCollapsed: true, limit: 10 };

function grouped() {
  const visible = S.items.filter((i) => !i.archived);
  const out = GROUPS.map((g) => ({ g, list: visible.filter(g.match).sort(g.sort) }));
  out.push({ g: ARCHIVED_GROUP, list: S.items.filter((i) => i.archived).sort(byRecent) });
  return out;
}

// Ordre de navigation clavier (⌘1…9, suivante / précédente) : sessions vivantes uniquement.
function navOrder(groups = grouped()) {
  return groups.filter(({ g }) => ['todo', 'busy', 'idle'].includes(g.id)).flatMap(({ list }) => list);
}

function itemByKey(key) {
  if (!key) return null;
  if (key === 'view:stats') return { key, kind: 'view', title: 'Statistiques et usage' };
  if (key === 'view:settings') return { key, kind: 'view', title: 'Réglages' };
  const it = S.items.find((i) => i.key === key) || (S.results && S.results.find((i) => i.key === key));
  if (it) return it;
  if (S.snapshot && S.snapshot.key === key) return S.snapshot;
  // Terminal tout juste créé, pas encore remonté par le rafraîchissement.
  const m = /^pty:(\d+)$/.exec(key);
  if (m && S.terms.has(Number(m[1]))) {
    return { key, kind: 'shell', host: 'app', ptyId: Number(m[1]), state: 'starting', title: 'Démarrage…', since: Date.now() };
  }
  return null;
}

const canArchive = (it) => !!it && !!it.sessionId && it.host !== 'app';

// --- Rendu -----------------------------------------------------------------------------------

function render() {
  renderSummary();
  renderUpdate();
  renderBridge();
  renderUsage();
  renderRestore();
  renderList();
  renderPane();
}

function counts() {
  const c = { waiting: 0, done: 0, busy: 0 };
  for (const i of S.items) if (i.kind === 'live' && !i.archived && i.state in c) c[i.state] += 1;
  return c;
}

function renderSummary() {
  const c = counts();
  const labels = { waiting: 'en attente de toi', done: 'terminée(s), à lire', busy: 'en cours' };
  summaryEl.innerHTML = ['waiting', 'done', 'busy']
    .filter((k) => c[k])
    .map((k) => `<span class="chip" data-state="${k}" title="${c[k]} ${labels[k]}"><i class="dot s-${k}"></i>${c[k]}</span>`)
    .join('');
  const todo = c.waiting + c.done;
  document.title = todo ? `Claude Deck — ${todo} à traiter` : 'Claude Deck';
}

function renderUpdate() {
  const u = S.update;
  if (!u || u.status !== 'ready' || S.updateDismissed === u.latest) {
    updateEl.hidden = true;
    return;
  }
  updateEl.hidden = false;
  const notes = u.notes ? `<div class="update-notes">${esc(u.notes)}</div>` : '';
  updateEl.innerHTML = `<strong>Claude Deck ${esc(u.latest)} est prête à installer</strong>${notes}
    <div class="actions">
      <button class="btn primary" data-act="installUpdate">Redémarrer</button>
      <button class="btn ghost" data-act="releaseNotes">Nouveautés</button>
      <button class="btn ghost" data-act="dismissUpdate">Plus tard</button>
    </div>`;
}

function renderUsage() {
  usageEl.innerHTML = usageFooterHtml(S.usage, S.bridge);
  usageEl.classList.toggle('selected', S.selected === 'view:stats');
}

function renderBridge() {
  const b = S.bridge;
  if (!b || b.installed || b.error || S.bridgeDismissed) {
    bridgeEl.hidden = true;
    return;
  }
  bridgeEl.hidden = false;
  bridgeEl.innerHTML = `<strong>Suivre ton forfait en direct</strong>
    <div class="update-notes">Session et semaine comme /usage, mis à jour après chaque réponse de Claude.</div>
    <div class="actions">
      <button class="btn primary" data-act="enableBridge">Activer</button>
      <button class="btn ghost" data-act="dismissBridge">Plus tard</button>
    </div>`;
}

function renderRestore() {
  const ids = S.lastOpen.filter((id) => S.items.some((i) => i.kind === 'closed' && i.sessionId === id));
  if (!ids.length || S.results) {
    restoreEl.hidden = true;
    return;
  }
  const n = ids.length;
  const s = n > 1 ? 's' : '';
  restoreEl.hidden = false;
  restoreEl.innerHTML = `<strong>${n} session${s} ouverte${s} dans l’appli à la dernière fermeture</strong>
    <div class="actions">
      <button class="btn primary" data-act="resumeAll">Tout reprendre</button>
      <button class="btn ghost" data-act="dismissRestore">Ignorer</button>
    </div>`;
}

function rowActions(it) {
  const b = (act, ic, title) => `<button class="mini" data-act="${act}" title="${esc(title)}">${icon(ic)}</button>`;
  const arch = canArchive(it) ? (it.archived ? b('unarchive', 'unarchive', 'Désarchiver') : b('archive', 'archive', 'Archiver (⌃⌘A)')) : '';
  if (it.host === 'external') {
    const canAdopt = !['busy', 'waiting'].includes(it.state);
    return b('focus', 'external', `Afficher dans ${it.hostApp || 'son terminal'}`) + (canAdopt ? b('adopt', 'adopt', 'Rapatrier dans Claude Deck') : '') + arch;
  }
  if (it.kind === 'closed') return b('resume', 'play', 'Reprendre dans l’appli') + arch;
  if (it.kind === 'background') return b('attach', 'attach', 'Ouvrir (claude attach)') + arch;
  if (it.state === 'shell') return b('relaunch', 'play', it.lastSessionId ? 'Reprendre la session ici' : 'Relancer Claude ici') + b('close', 'close', 'Fermer');
  if (it.ptyId != null) return b('close', 'close', 'Fermer');
  return '';
}

function rowHtml(it, idx, tokens = []) {
  const attention = !it.archived && (it.state === 'waiting' || it.state === 'done');
  const cls = ['row', `s-${it.state}`, it.key === S.selected ? 'selected' : '', attention ? 'attention' : '', it.stale ? 'stale' : '', it.archived ? 'archived' : '']
    .filter(Boolean)
    .join(' ');
  const badges =
    (it.host === 'external' ? `<span class="badge">${esc(it.hostApp || 'externe')}</span>` : '') +
    (it.archived && S.results ? '<span class="badge">archivée</span>' : '');
  const folder = it.cwd ? `<span>${esc(folderName(it.cwd))}</span><span>·</span>` : '';
  const branch = it.branch ? `<span class="branch">⎇ ${esc(it.branch)}</span><span>·</span>` : '';
  const num = idx >= 0 && idx < 9 ? `<span class="num">⌘${idx + 1}</span>` : '';
  const when = S.results && it.kind === 'closed' ? fmtTime(it.since) : ago(it.since);
  const snippet = it.snippet ? `<div class="row-snippet">${highlight(it.snippet, tokens)}</div>` : '';
  return `<div class="${cls}" data-key="${esc(it.key)}" style="--row-color: var(--s-${COLOR[it.state] || 'idle'})" title="${esc(it.title)}">
    <i class="dot s-${it.state}"></i>
    <div class="row-main">
      <div class="row-title">${highlight(it.title, tokens)}</div>
      <div class="row-sub">${badges}${folder}${branch}<span class="status">${esc(statusText(it))}</span></div>
    </div>
    <div class="row-side"><span class="row-time">${esc(when)}</span>${num}${ctxMini(it)}<span class="row-actions">${rowActions(it)}</span></div>
    ${it.state === 'busy' && it.activity ? `<div class="row-activity">↳ ${esc(it.activity)}</div>` : ''}
    ${snippet}
  </div>`;
}

function renderList() {
  const scroll = listEl.scrollTop;
  listEl.innerHTML = S.results ? resultsHtml() : groupsHtml();
  listEl.scrollTop = scroll;
}

function resultsHtml() {
  const tokens = norm(S.query).split(/\s+/).filter(Boolean);
  let html = `<div class="group-head"><span>Résultats</span><span class="count">${S.results.length || ''}</span></div>`;
  if (!S.results.length) return `${html}<div class="group-empty">Aucune conversation ne correspond. La recherche couvre les titres, les dossiers et tous tes prompts des 30 derniers jours.</div>`;
  for (const it of S.results) html += rowHtml(it, -1, tokens);
  return html;
}

function groupsHtml() {
  const groups = grouped();
  const nav = navOrder(groups);
  let html = '';
  for (const { g, list } of groups) {
    if (!list.length && !g.alwaysShow) continue;
    const collapsed = g.collapsible && (S.collapsed[g.id] ?? !!g.defaultCollapsed);
    const bulk = g.bulkArchive && !collapsed && list.length ? '<button class="group-act" data-group-act="archiveAll" title="Archiver toutes les sessions fermées">Tout archiver</button>' : '';
    html += `<div class="group-head${g.collapsible ? ' collapsible' : ''}${collapsed ? ' collapsed' : ''}" data-group="${g.id}">
      <span>${g.label}</span><span class="count">${list.length || ''}</span>${bulk}${g.collapsible ? icon('chev', 'chev') : ''}</div>`;
    if (collapsed) continue;
    if (!list.length) {
      html += `<div class="group-empty">${g.empty}</div>`;
      continue;
    }
    const shown = g.limit && !S.showAll[g.id] ? list.slice(0, g.limit) : list;
    for (const it of shown) html += rowHtml(it, nav.indexOf(it));
    if (shown.length < list.length) html += `<button class="more" data-more="${g.id}">Afficher les ${list.length - shown.length} autres</button>`;
  }
  return html;
}

function btn(act, ic, label, cls = '', disabled = false, title = '') {
  return `<button class="btn ${cls}" data-act="${act}"${disabled ? ' disabled' : ''}${title ? ` title="${esc(title)}"` : ''}>${ic ? icon(ic) : ''}${esc(label)}</button>`;
}

function iconBtn(act, ic, title) {
  return `<button class="btn icon-only" data-act="${act}" title="${esc(title)}">${icon(ic)}</button>`;
}

function pillHtml(it) {
  return `<span class="pill s-${it.state}"><i class="dot s-${it.state}"></i>${esc(PILL[it.state] ? PILL[it.state](it) : it.state)}</span>`;
}

function headActions(it) {
  const arch = canArchive(it) ? (it.archived ? btn('unarchive', 'unarchive', 'Désarchiver') : iconBtn('archive', 'archive', 'Archiver (⌃⌘A)')) : '';
  const folder = it.cwd ? iconBtn('openFolder', 'folder', `Ouvrir le dossier ${homeify(it.cwd)}`) : '';
  const copy = it.sessionId || it.lastSessionId ? iconBtn('copyResume', 'copy', 'Copier la commande de reprise') : '';
  if (it.ptyId != null) {
    const relaunch =
      it.state === 'shell'
        ? btn('relaunch', 'play', it.lastSessionId ? 'Reprendre la session' : 'Relancer Claude', 'primary', false, 'Tape la commande dans ce terminal')
        : '';
    return relaunch + folder + copy + btn('close', 'close', 'Fermer', '', false, 'Fermer ce terminal (⌘W)');
  }
  if (it.host === 'external') {
    const busy = it.state === 'busy' || it.state === 'waiting';
    return (
      btn('focus', 'external', `Afficher dans ${it.hostApp || 'son terminal'}`, 'primary', false, 'Entrée') +
      btn('adopt', 'adopt', 'Rapatrier ici', '', busy, busy ? 'Possible quand la session est au repos' : 'Arrête la session dans son terminal et la reprend ici') +
      arch +
      folder +
      copy
    );
  }
  if (it.kind === 'closed') {
    return (
      btn('resume', 'play', 'Reprendre', 'primary', false, 'Relance cette conversation dans un terminal de l’appli (Entrée)') +
      btn('fork', 'fork', 'Reprendre en copie', '', false, 'Nouvelle conversation qui repart de celle-ci ; l’originale reste intacte') +
      arch +
      folder +
      copy
    );
  }
  if (it.kind === 'background') return btn('attach', 'attach', 'Ouvrir', 'primary', false, 'claude attach (Entrée)') + arch;
  return '';
}

function headHtml(it) {
  return `${pillHtml(it)}
    <div class="title"><h1>${esc(it.title)}</h1><span class="meta">${esc(homeify(it.cwd))}</span></div>
    ${headStats(it)}
    <div class="actions">${headActions(it)}</div>`;
}

// Vue « conversation » d'une session qui ne tourne pas dans l'appli : aperçu + contexte.
function bodyHtml(it) {
  const meta = [
    it.cwd ? `<code>${esc(homeify(it.cwd))}</code>` : '',
    it.sessionId ? `<code title="Identifiant de session">${esc(it.sessionId.slice(0, 8))}</code>` : '',
    it.kind === 'live' ? `${esc(it.hostApp || 'terminal externe')} · ${esc((it.tty || '').replace('/dev/', ''))}` : '',
    it.kind === 'live' && it.startedAt ? `lancée ${esc(fmtDate(it.startedAt))}` : '',
    `dernière activité ${esc(fmtDate(it.since))}`,
  ].filter(Boolean);

  let banner = '';
  if (it.archived) {
    banner = `<div class="banner">Archivée : elle n’apparaît plus dans la liste (la recherche la retrouve). Elle revient d’elle-même si elle reprend vie. ${btn('unarchive', 'unarchive', 'Désarchiver', 'small')}</div>`;
  } else if (it.kind === 'closed') {
    banner = `<div class="banner">Conversation fermée. <strong>Reprendre</strong> (ou Entrée) la relance ici dans un terminal, avec <code>--resume</code> dans son dossier ; <strong>Reprendre en copie</strong> repart de ce point sans modifier l’originale.</div>`;
  } else if (it.host === 'external') {
    banner = `<div class="banner">Cette session tourne dans ${esc(it.hostApp || 'un terminal externe')}. <strong>Afficher</strong> sélectionne son onglet ; <strong>Rapatrier ici</strong> l’arrête là-bas et la reprend dans Claude Deck.</div>`;
  } else if (it.kind === 'background') {
    banner = `<div class="banner">Agent lancé en arrière-plan (<code>claude --bg</code>). <strong>Ouvrir</strong> l’attache dans un terminal de l’appli.</div>`;
  }

  return `<div class="convo">
    <div class="convo-meta">${meta.join('<span>·</span>')}</div>
    ${banner}
    <div class="msgs">${messagesHtml(it)}</div>
  </div>`;
}

function messagesHtml(it) {
  if (!it.sessionId) return '';
  const p = S.previews.get(it.sessionId);
  if (!p || !p.data) return '<p class="msgs-note">Chargement de la conversation…</p>';
  const { messages, truncated, missing } = p.data;
  if (missing) return '<p class="msgs-note">Pas encore de transcript pour cette session.</p>';
  if (!messages.length) return '<p class="msgs-note">Aucun message à afficher.</p>';
  let html = truncated ? '<p class="msgs-note">… seuls les derniers échanges sont affichés</p>' : '';
  for (const m of messages) {
    if (m.role === 'tools') {
      const names = Object.entries(m.names)
        .sort((a, b) => b[1] - a[1])
        .map(([n, c]) => `${n.replace(/^mcp__/, '').replace(/__/g, ' › ')}${c > 1 ? ` ×${c}` : ''}`)
        .join(' · ');
      html += `<div class="msg tools">${m.total} action${m.total > 1 ? 's' : ''} — ${esc(names)}</div>`;
    } else if (m.role === 'user') {
      html += `<div class="msg user"><div class="who">Toi <time>${esc(fmtTime(m.ts))}</time></div><div class="text">${esc(m.text)}</div></div>`;
    } else {
      html += `<div class="msg claude"><div class="who">Claude <time>${esc(fmtTime(m.ts))}</time></div><div class="text">${mdLite(m.text)}</div></div>`;
    }
  }
  return html;
}

async function ensurePreview(it) {
  if (!it.sessionId) return;
  const cur = S.previews.get(it.sessionId);
  if (cur && (cur.loading || cur.since === it.since)) return;
  S.previews.set(it.sessionId, { since: it.since, data: cur && cur.data, loading: true });
  const data = await deck.preview(it.sessionId);
  S.previews.set(it.sessionId, { since: it.since, data, loading: false });
  if (S.selectedSessionId === it.sessionId) renderPane(true);
}

const kbd = (name) => prettyAccelerator((S.config.shortcuts || {})[name] || '');

// Libellés de raccourcis visibles en permanence : ils suivent les Réglages.
function updateShortcutHints() {
  const newKbd = document.querySelector('#btn-new kbd');
  if (newKbd) newKbd.textContent = kbd('newSession');
  const searchKbd = document.querySelector('.search-row kbd');
  if (searchKbd) searchKbd.textContent = kbd('search');
}

function emptyHtml() {
  return `<div class="empty-inner">
    <h2>Toutes tes sessions Claude Code au même endroit</h2>
    <p>Les sessions lancées dans Terminal apparaissent automatiquement à gauche, avec leur statut. Celles lancées ici tournent dans de vrais terminaux intégrés. Clique une conversation fermée pour la relire et la reprendre.</p>
    <div class="actions">
      ${btn('new', '', 'Nouvelle session', 'primary')}
      ${btn('newFolder', 'folder', 'Dans un autre dossier…')}
    </div>
    <div class="shortcuts">
      <kbd>${esc(kbd('newSession'))}</kbd><span>Nouvelle session</span>
      <kbd>${esc(kbd('search'))}</kbd><span>Rechercher dans toutes les conversations</span>
      <kbd>↩</kbd><span>Reprendre la conversation sélectionnée</span>
      <kbd>${esc(kbd('archive'))}</kbd><span>Archiver la conversation sélectionnée</span>
      <kbd>${esc(kbd('nextAttention'))}</kbd><span>Prochaine session qui t’attend</span>
      <kbd>⌘1 … ⌘9</kbd><span>Aller à une session (maintiens ⌘ pour voir les numéros)</span>
      <kbd>${esc(kbd('nextSession'))} ${esc(kbd('prevSession'))}</kbd><span>Session suivante / précédente</span>
      <kbd>${esc(kbd('closeSession'))}</kbd><span>Fermer la session</span>
      <kbd>⇧↩ ou ⌥↩</kbd><span>Retour à la ligne dans le prompt</span>
    </div>
  </div>`;
}

function renderPane(force = false) {
  const it = itemByKey(S.selected);
  if (!it) {
    headEl.hidden = true;
    termHost.hidden = true;
    cardEl.hidden = true;
    emptyEl.hidden = false;
    if (S.headSig !== 'empty') emptyEl.innerHTML = emptyHtml();
    S.headSig = 'empty';
    S.bodySig = '';
    S.visiblePty = null;
    return;
  }
  emptyEl.hidden = true;
  headEl.hidden = false;
  if (it.key === 'view:settings') {
    termHost.hidden = true;
    cardEl.hidden = false;
    S.visiblePty = null;
    if (force || S.headSig !== 'view:settings') {
      headEl.innerHTML = `<span class="pill"><i class="dot s-idle"></i>Réglages</span>
        <div class="title"><h1>Réglages</h1><span class="meta">enregistrés aussitôt</span></div>
        <div class="actions"></div>`;
    }
    S.headSig = 'view:settings';
    if (!S.settings) loadSettings();
    if (S.settingsTab === 'perms' && !S.perms) loadPerms();
    const bodySig = `settings:${S.settingsTab}:${S.recording}:${JSON.stringify(S.settings)}:${JSON.stringify(S.perms)}`;
    if (force || bodySig !== S.bodySig) {
      const top = cardEl.scrollTop;
      cardEl.innerHTML = settingsHtml(S.settings, S.settingsTab, S.perms, S.recording);
      cardEl.scrollTop = S.bodySig.startsWith(`settings:${S.settingsTab}:`) ? top : 0;
    }
    S.bodySig = bodySig;
    return;
  }
  if (it.kind === 'view') {
    termHost.hidden = true;
    cardEl.hidden = false;
    S.visiblePty = null;
    if (force || S.headSig !== 'view:stats') {
      headEl.innerHTML = `<span class="pill"><i class="dot s-idle"></i>Statistiques</span>
        <div class="title"><h1>Usage et activité</h1><span class="meta">30 derniers jours</span></div>
        <div class="actions">${btn('refreshStats', '', 'Actualiser')}</div>`;
    }
    S.headSig = 'view:stats';
    if (!S.stats || Date.now() - S.statsAt > 60000) loadStats();
    const bodySig = `stats:${S.statsAt}`;
    if (force || bodySig !== S.bodySig) {
      const entering = !S.bodySig.startsWith('stats:');
      cardEl.innerHTML = statsHtml(S.stats, cardEl.clientWidth - 64);
      if (entering) cardEl.scrollTop = 0;
    }
    S.bodySig = bodySig;
    return;
  }
  // On ne réécrit que ce qui change (préserve la sélection de texte et le défilement).
  const headSig = JSON.stringify([it.key, it.state, it.title, it.cwd, it.archived, it.waitingFor, it.stale, it.hostApp, it.lastSessionId, it.context, it.branch, it.turnActions, it.state === 'busy' ? ago(it.since) : 0]);
  if (force || headSig !== S.headSig) headEl.innerHTML = headHtml(it);
  S.headSig = headSig;

  if (it.ptyId != null) {
    cardEl.hidden = true;
    termHost.hidden = false;
    S.bodySig = '';
    if (S.visiblePty !== it.ptyId) showTerm(it.ptyId);
    return;
  }
  termHost.hidden = true;
  cardEl.hidden = false;
  S.visiblePty = null;
  ensurePreview(it);
  const p = S.previews.get(it.sessionId);
  const bodySig = JSON.stringify([it.key, it.since, it.archived, it.state, p && p.data ? p.since : 'loading']);
  if (force || bodySig !== S.bodySig) {
    cardEl.innerHTML = bodyHtml(it);
    const msgs = cardEl.querySelector('.convo');
    if (msgs) cardEl.scrollTop = cardEl.scrollHeight; // les derniers échanges d'abord
  }
  S.bodySig = bodySig;
}

// --- Sélection et actions -----------------------------------------------------------------------

function select(key, { focus = true } = {}) {
  if (key !== 'view:settings' && S.recording) stopRecording();
  S.selected = key;
  const it = itemByKey(key);
  S.selectedSessionId = it ? it.sessionId || null : null;
  S.snapshot = it && it.kind === 'closed' ? it : null;
  deck.select(key);
  render();
  if (focus && it && it.ptyId != null) focusTerm(it.ptyId);
}

function step(dir) {
  const nav = navOrder();
  if (!nav.length) return;
  const i = nav.findIndex((it) => it.key === S.selected);
  const next = nav[(i + dir + nav.length) % nav.length] || nav[0];
  select(next.key);
}

function nextAttention() {
  const todo = grouped().find(({ g }) => g.id === 'todo').list;
  if (!todo.length) {
    toast('Aucune session ne t’attend');
    return;
  }
  const i = todo.findIndex((it) => it.key === S.selected);
  select(todo[(i + 1) % todo.length].key);
}

function clearSearch() {
  searchEl.value = '';
  S.query = '';
  S.results = null;
}

async function archive(ids) {
  const n = await deck.archive(ids);
  if (!n) return;
  if (ids.includes(S.selectedSessionId) && !S.results) {
    // On passe à la suivante pour ne pas rester sur une session qui vient de disparaître.
    const next = grouped().find(({ g }) => g.id === 'closed').list.find((i) => !ids.includes(i.sessionId));
    if (next) select(next.key, { focus: false });
  }
  toast(n > 1 ? `${n} conversations archivées` : 'Conversation archivée', {
    label: 'Annuler',
    run: () => deck.unarchive(ids),
  });
}

async function runAction(act, it) {
  switch (act) {
    case 'new':
      clearSearch();
      return select(await deck.newSession());
    case 'newFolder': {
      const key = await deck.newSessionInFolder();
      if (key) {
        clearSearch();
        select(key);
      }
      return;
    }
    case 'resumeAll': {
      const ids = S.lastOpen.filter((id) => S.items.some((i) => i.kind === 'closed' && i.sessionId === id));
      S.lastOpen = [];
      const key = await deck.resumeAll(ids);
      if (key) select(key);
      else render();
      return;
    }
    case 'dismissRestore':
      S.lastOpen = [];
      deck.dismissLastOpen();
      return render();
    case 'installUpdate':
      return deck.installUpdate();
    case 'releaseNotes':
      return deck.openReleases();
    case 'enableBridge':
      S.bridge = await deck.setBridge(true);
      if (S.selected === 'view:stats') loadStats();
      return render();
    case 'disableBridge':
      S.bridge = await deck.setBridge(false);
      loadStats();
      return render();
    case 'dismissBridge':
      S.bridgeDismissed = true;
      deck.dismissBridge();
      toast('Activable plus tard dans le menu Présentation › Barre d’état Claude Code');
      return render();
    case 'refreshStats':
      return loadStats();
    case 'checkUpdate':
      await deck.checkUpdate();
      return loadSettings();
    case 'openConfigFile':
      return deck.openConfigFile();
    case 'openDataDir':
      return deck.openDataDir();
    case 'perm:refresh':
      return loadPerms();
    case 'perm:folders':
    case 'perm:microphone':
    case 'perm:relaunch':
    case 'perm:fullDisk':
    case 'perm:files':
    case 'perm:automation':
    case 'perm:notifications':
      S.perms = await deck.permAction(act.slice(5));
      return renderPane();
    case 'dismissUpdate':
      S.updateDismissed = S.update && S.update.latest;
      toast('La mise à jour s’installera à la prochaine fermeture de l’appli');
      return render();
    default:
      break;
  }
  if (!it) return;
  switch (act) {
    case 'focus': {
      const r = await deck.focusExternal(it.sessionId);
      if (!r || !r.ok) toast('Impossible de retrouver le terminal de cette session');
      else if (r.approximate) toast(`${r.appName} activé — l’onglet exact n’a pas pu être sélectionné`);
      return;
    }
    case 'adopt': {
      const key = await deck.adopt(it.sessionId);
      if (key) select(key);
      return;
    }
    case 'resume':
    case 'fork': {
      const key = await deck.resume(it.sessionId, { fork: act === 'fork' });
      if (key) {
        clearSearch();
        select(key);
      }
      return;
    }
    case 'attach': {
      const key = await deck.attach(it.bgId);
      if (key) select(key);
      return;
    }
    case 'close':
      if (it.ptyId != null) await deck.close(it.ptyId);
      return;
    case 'relaunch':
      await deck.relaunchHere(it.ptyId);
      if (S.selected !== it.key) select(it.key);
      else focusTerm(it.ptyId);
      return;
    case 'archive':
      return archive([it.sessionId]);
    case 'unarchive':
      await deck.unarchive([it.sessionId]);
      return toast('Conversation désarchivée');
    case 'seen':
      return deck.markSeen(it.sessionId);
    case 'copyResume':
      deck.copy(fillTemplate(S.config.resumeCommand, { cwd: it.cwd || '~', sessionId: it.sessionId || it.lastSessionId }));
      return toast('Commande de reprise copiée');
    case 'openFolder':
      return deck.openPath(it.cwd);
    default:
      return undefined;
  }
}

// Entrée = l'action principale de l'élément sélectionné.
function primaryAction(it) {
  if (!it) return;
  if (it.ptyId != null) focusTerm(it.ptyId);
  else if (it.kind === 'closed') runAction('resume', it);
  else if (it.kind === 'background') runAction('attach', it);
  else if (it.host === 'external') runAction('focus', it);
}

async function loadPerms() {
  S.perms = await deck.perms();
  if (S.selected === 'view:settings') renderPane();
}

async function loadSettings() {
  S.settings = await deck.settings();
  if (S.selected === 'view:settings') renderPane();
}

function openSettings(tab = 'general') {
  S.settingsTab = tab;
  if (tab === 'perms') S.perms = null;
  S.settings = null; // relu à l'ouverture (version, mises à jour, barre d'état…)
  select('view:settings');
}

async function saveSetting(patch, check) {
  S.settings = await deck.setSettings(patch);
  const ok = check ? check(S.settings.config) : true;
  toast(ok ? 'Réglage enregistré' : 'Valeur refusée : réglage inchangé');
  renderPane(true);
}

function stopRecording() {
  if (!S.recording) return;
  S.recording = null;
  deck.recordingShortcut(false);
  renderPane(true);
}

async function finishRecording(acc) {
  const name = S.recording;
  S.recording = null;
  deck.recordingShortcut(false);
  if (name === '__global') await saveSetting({ globalShortcut: acc }, (c) => c.globalShortcut === acc);
  else await saveSetting({ shortcuts: { [name]: acc } }, (c) => c.shortcuts[name] === acc);
  if (name === '__global' && acc && S.settings && !S.settings.globalShortcutOk) toast('Combinaison déjà utilisée par une autre appli');
}

let statsLoading = false;
async function loadStats() {
  if (statsLoading) return;
  statsLoading = true;
  try {
    S.stats = await deck.stats();
    S.statsAt = Date.now();
    if (S.bridge == null && S.stats) S.bridge = S.stats.bridge;
  } finally {
    statsLoading = false;
  }
  if (S.selected === 'view:stats') renderPane();
}

// --- Recherche -------------------------------------------------------------------------------------

let searchTimer = null;
let searchSeq = 0;
async function runSearch() {
  const q = searchEl.value.trim();
  S.query = q;
  if (!q) {
    S.results = null;
    render();
    return;
  }
  const seq = ++searchSeq;
  const results = await deck.search(q);
  if (seq !== searchSeq || S.query !== q) return; // une frappe plus récente a pris le relais
  S.results = results;
  render();
}

searchEl.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 120);
});

searchEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    clearSearch();
    searchEl.blur();
    render();
    return;
  }
  const list = S.results || navOrder();
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!list.length) return;
    const i = list.findIndex((it) => it.key === S.selected);
    const next = e.key === 'ArrowDown' ? (i < 0 ? 0 : Math.min(list.length - 1, i + 1)) : Math.max(0, i - 1);
    select(list[next].key, { focus: false });
    const row = listEl.querySelector(`.row[data-key="${CSS.escape(list[next].key)}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const cur = itemByKey(S.selected);
    const it = cur && list.some((x) => x.key === cur.key) ? cur : list[0];
    if (!it) return;
    if (it.key !== S.selected) select(it.key, { focus: false });
    else primaryAction(it);
  }
});

// --- Terminaux ----------------------------------------------------------------------------------

const THEME = {
  background: '#0f1115',
  foreground: '#e7e9ee',
  cursor: '#e7e9ee',
  cursorAccent: '#0f1115',
  selectionBackground: 'rgba(79, 140, 255, 0.35)',
  black: '#1c1f26',
  red: '#f0717a',
  green: '#5cc98f',
  yellow: '#e8c26b',
  blue: '#5f9dff',
  magenta: '#c48cf5',
  cyan: '#4fc9d8',
  white: '#d5d9df',
  brightBlack: '#5b6370',
  brightRed: '#ff8f97',
  brightGreen: '#7ee0a9',
  brightYellow: '#f3d58f',
  brightBlue: '#86b6ff',
  brightMagenta: '#d6a9ff',
  brightCyan: '#79dce8',
  brightWhite: '#ffffff',
  scrollbarSliderBackground: 'rgba(150, 160, 175, 0.28)',
  scrollbarSliderHoverBackground: 'rgba(150, 160, 175, 0.45)',
  scrollbarSliderActiveBackground: 'rgba(150, 160, 175, 0.6)',
};

// Molette quand Claude occupe l'écran (plein écran, souris activée) : xterm.js n'envoie qu'un événement
// par mouvement de molette, et amortit de 70 % un cran de souris Mac (40 px, pris pour un pavé tactile).
// Terminal.app envoie un événement par « ligne » macOS, accélération comprise : on fait pareil.
const PIXELS_PER_WHEEL_LINE = 40; // Chromium sur macOS : 40 px par cran de molette
const WHEEL_BURST_MAX = 60;

function cellAt(rec, ev) {
  const screen = rec.el.querySelector('.xterm-screen') || rec.el;
  const r = screen.getBoundingClientRect();
  const { cols, rows } = rec.term;
  const col = Math.min(cols, Math.max(1, Math.floor(((ev.clientX - r.left) / Math.max(1, r.width)) * cols) + 1));
  const row = Math.min(rows, Math.max(1, Math.floor(((ev.clientY - r.top) / Math.max(1, r.height)) * rows) + 1));
  return { col, row };
}

function wheelHandler(ev, rec, ptyId) {
  const { term } = rec;
  const tracking = term.modes.mouseTrackingMode !== 'none';
  const alt = term.buffer.active.type === 'alternate';
  if ((!tracking && !alt) || ev.deltaY === 0 || ev.shiftKey) return true; // historique normal : défilement natif
  let lines = ev.deltaY / PIXELS_PER_WHEEL_LINE;
  if (ev.deltaMode === WheelEvent.DOM_DELTA_LINE) lines = ev.deltaY;
  else if (ev.deltaMode === WheelEvent.DOM_DELTA_PAGE) lines = ev.deltaY * term.rows;
  rec.wheelAcc += lines * (Number(S.config.scrollSpeed) || 1);
  const n = Math.trunc(rec.wheelAcc);
  rec.wheelAcc -= n;
  ev.preventDefault();
  if (!n) return false;
  const up = n < 0;
  let seq;
  if (tracking) {
    const { col, row } = cellAt(rec, ev);
    const button = up ? 64 : 65;
    seq = rec.sgrMouse
      ? `\x1b[<${button};${col};${row}M`
      : `\x1b[M${String.fromCharCode(32 + button, 32 + Math.min(col, 223), 32 + Math.min(row, 223))}`;
  } else {
    seq = `\x1b${term.modes.applicationCursorKeysMode ? 'O' : '['}${up ? 'A' : 'B'}`;
  }
  deck.ptyWrite(ptyId, seq.repeat(Math.min(Math.abs(n), WHEEL_BURST_MAX)));
  return false;
}

const hasParam = (params, value) => params.some((p) => p === value || (Array.isArray(p) && p.includes(value)));

function openLink(event, uri) {
  // Comme dans Terminal.app : ⌘-clic pour ouvrir un lien.
  if (event && event.metaKey && /^https?:\/\//.test(uri)) deck.openExternal(uri);
}

function keyHandler(e, ptyId) {
  if (e.type !== 'keydown') return true;
  const send = (s) => {
    e.preventDefault();
    deck.ptyWrite(ptyId, s);
    return false;
  };
  if (e.metaKey) {
    if (e.key === 'Backspace') return send('\x15'); // efface la ligne
    if (e.key === 'ArrowLeft') return send('\x01'); // début de ligne
    if (e.key === 'ArrowRight') return send('\x05'); // fin de ligne
    return false; // ⌘ = raccourcis de l'appli (menus), rien n'est envoyé au terminal
  }
  if (e.key === 'Enter' && (e.shiftKey || e.altKey) && !e.ctrlKey) return send('\x1b\r'); // retour à la ligne dans le prompt Claude
  if (e.altKey && !e.ctrlKey && !e.shiftKey) {
    if (e.key === 'ArrowLeft') return send('\x1bb');
    if (e.key === 'ArrowRight') return send('\x1bf');
    if (e.key === 'Backspace') return send('\x1b\x7f');
  }
  return true;
}

function createTerm(ptyId, replay) {
  if (S.terms.has(ptyId)) return S.terms.get(ptyId);
  const el = document.createElement('div');
  el.className = 'term';
  el.hidden = true;
  termHost.appendChild(el);
  const term = new Terminal({
    fontFamily: S.config.fontFamily,
    fontSize: S.config.fontSize || 11,
    lineHeight: Number(S.config.lineHeight) || 1,
    scrollSensitivity: Number(S.config.scrollSpeed) || 1,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true,
    macOptionIsMeta: false, // ⌥ reste utilisable pour { } [ ] | ~ sur clavier français
    macOptionClickForcesSelection: true,
    theme: THEME,
    linkHandler: { activate: openLink, allowNonHttpProtocols: false },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.loadAddon(new WebLinksAddon.WebLinksAddon(openLink));
  // OSC 52 : un programme du terminal peut écrire dans le presse-papiers, jamais le lire.
  term.loadAddon(
    new ClipboardAddon.ClipboardAddon(undefined, {
      readText: () => '',
      writeText: (_selection, text) => navigator.clipboard.writeText(text),
    }),
  );
  term.open(el);
  term.onData((d) => deck.ptyWrite(ptyId, d));
  term.onResize(({ cols, rows }) => deck.ptyResize(ptyId, cols, rows));
  term.onTitleChange((t) => deck.ptyTitle(ptyId, t));
  term.attachCustomKeyEventHandler((e) => keyHandler(e, ptyId));
  const rec = { term, fit, el, sgrMouse: false, wheelAcc: 0, sbPending: false };
  term.attachCustomWheelEventHandler((ev) => wheelHandler(ev, rec, ptyId));
  // Encodage SGR des événements souris (DECSET 1006), demandé par Claude en plein écran.
  term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
    if (hasParam(params, 1006)) rec.sgrMouse = true;
    return false;
  });
  term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
    if (hasParam(params, 1006)) rec.sgrMouse = false;
    return false;
  });
  // Barre de défilement affichée en permanence dès qu'il y a un historique (rendu classique, shell).
  const updateScrollback = () => {
    const b = term.buffer.active;
    el.classList.toggle('has-scrollback', b.type === 'normal' && b.baseY > 0);
  };
  term.onWriteParsed(() => {
    if (rec.sbPending) return;
    rec.sbPending = true;
    requestAnimationFrame(() => {
      rec.sbPending = false;
      updateScrollback();
    });
  });
  term.buffer.onBufferChange(updateScrollback);
  if (replay) term.write(replay);
  S.terms.set(ptyId, rec);
  return rec;
}

function showTerm(ptyId) {
  if (!S.terms.has(ptyId)) createTerm(ptyId, '');
  for (const [id, r] of S.terms) r.el.hidden = id !== ptyId;
  S.visiblePty = ptyId;
  requestAnimationFrame(fitVisible);
}

function fitVisible() {
  const rec = S.terms.get(S.visiblePty);
  if (!rec || termHost.hidden || rec.el.hidden) return;
  try {
    rec.fit.fit();
  } catch {
    // dimensions pas encore disponibles
  }
}

function focusTerm(ptyId) {
  requestAnimationFrame(() => {
    const r = S.terms.get(ptyId);
    if (r) r.term.focus();
  });
}

function removeTerm(ptyId) {
  const r = S.terms.get(ptyId);
  if (!r) return;
  r.term.dispose();
  r.el.remove();
  S.terms.delete(ptyId);
  if (S.visiblePty === ptyId) S.visiblePty = null;
}

function applyFont() {
  for (const { term } of S.terms.values()) {
    term.options.fontSize = S.config.fontSize;
    term.options.fontFamily = S.config.fontFamily;
    term.options.lineHeight = Number(S.config.lineHeight) || 1;
    term.options.scrollSensitivity = Number(S.config.scrollSpeed) || 1;
  }
  requestAnimationFrame(fitVisible);
}

function changeFont(arg) {
  const base = 11; // taille du profil Terminal.app
  const cur = S.config.fontSize || base;
  S.config.fontSize = arg === '0' ? base : Math.max(9, Math.min(28, cur + Number(arg)));
  applyFont();
  deck.setFontSize(S.config.fontSize);
}

// --- Événements ----------------------------------------------------------------------------------

listEl.addEventListener('click', (e) => {
  const groupAct = e.target.closest('[data-group-act]');
  if (groupAct) {
    e.stopPropagation();
    const ids = grouped()
      .find(({ g }) => g.id === 'closed')
      .list.map((i) => i.sessionId)
      .filter(Boolean);
    if (ids.length) archive(ids);
    return;
  }
  const head = e.target.closest('.group-head.collapsible');
  if (head) {
    const id = head.dataset.group;
    const g = GROUPS.find((x) => x.id === id) || ARCHIVED_GROUP;
    const cur = S.collapsed[id] ?? !!g.defaultCollapsed;
    S.collapsed[id] = !cur;
    deck.setCollapsed(id, !cur);
    renderList();
    return;
  }
  const more = e.target.closest('[data-more]');
  if (more) {
    S.showAll[more.dataset.more] = true;
    renderList();
    return;
  }
  const row = e.target.closest('.row');
  if (!row) return;
  const it = itemByKey(row.dataset.key);
  const act = e.target.closest('[data-act]');
  if (act) {
    runAction(act.dataset.act, it);
    return;
  }
  select(row.dataset.key);
});

listEl.addEventListener('dblclick', (e) => {
  if (e.target.closest('[data-act]')) return;
  const row = e.target.closest('.row');
  primaryAction(row && itemByKey(row.dataset.key));
});

usageEl.addEventListener('click', () => select('view:stats'));
// Les graphiques sont dessinés à la largeur affichée : on les redessine quand la fenêtre change de taille.
let statsResizeTimer = null;
new ResizeObserver(() => {
  if (S.selected !== 'view:stats') return;
  clearTimeout(statsResizeTimer);
  statsResizeTimer = setTimeout(() => renderPane(true), 150);
}).observe(cardEl);
bindVizTips(cardEl);

for (const el of [headEl, cardEl, emptyEl, restoreEl, updateEl, bridgeEl]) {
  el.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (act && !act.disabled) runAction(act.dataset.act, itemByKey(S.selected));
  });
}

summaryEl.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const nav = navOrder().filter((i) => i.state === chip.dataset.state);
  if (!nav.length) return;
  const i = nav.findIndex((it) => it.key === S.selected);
  select(nav[(i + 1) % nav.length].key);
});

$('#btn-new').addEventListener('click', () => runAction('new'));
$('#btn-new-folder').addEventListener('click', () => runAction('newFolder'));

// Entrée hors du terminal et de la recherche : action principale (reprendre, afficher…).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
  const a = document.activeElement;
  if (a && (a.closest('.term') || a.tagName === 'INPUT' || a.tagName === 'BUTTON')) return;
  e.preventDefault();
  primaryAction(itemByKey(S.selected));
});

// Retour des Réglages système : l'état des autorisations a pu changer.
window.addEventListener('focus', () => {
  if (S.selected === 'view:settings' && S.settingsTab === 'perms') loadPerms();
});

// --- Réglages : onglets, champs, raccourcis ---------------------------------------------------

cardEl.addEventListener('click', async (e) => {
  if (S.selected !== 'view:settings') return;
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    stopRecording();
    S.settingsTab = tab.dataset.tab;
    if (S.settingsTab === 'perms') loadPerms();
    renderPane(true);
    return;
  }
  const shortcut = e.target.closest('[data-shortcut]');
  if (shortcut) {
    S.recording = S.recording === shortcut.dataset.shortcut ? null : shortcut.dataset.shortcut;
    deck.recordingShortcut(!!S.recording);
    renderPane(true);
    return;
  }
  const reset = e.target.closest('[data-reset-shortcut]');
  if (reset) {
    const name = reset.dataset.resetShortcut;
    await saveSetting({ shortcuts: { [name]: S.settings.defaults.shortcuts[name] } });
    return;
  }
  if (e.target.closest('[data-clear-global]')) await saveSetting({ globalShortcut: '' });
});

cardEl.addEventListener('change', async (e) => {
  if (S.selected !== 'view:settings') return;
  const el = e.target;
  if (el.dataset.special === 'loginItem') {
    S.settings = await deck.setLoginItem(el.checked);
    toast(el.checked ? 'Claude Deck s’ouvrira avec ta session' : 'Ouverture automatique désactivée');
    renderPane(true);
    return;
  }
  if (el.dataset.special === 'bridge') {
    S.bridge = await deck.setBridge(el.checked); // fenêtre de confirmation côté système
    await loadSettings();
    render();
    return;
  }
  const key = el.dataset.key;
  if (!key) return;
  let value = el.value;
  if (el.type === 'checkbox') value = el.checked;
  else if (el.type === 'number' || key === 'scrollSpeed') value = Number(value);
  await saveSetting({ [key]: value }, (c) => c[key] === value);
});

// Enregistrement d'un raccourci : la combinaison tapée est capturée avant tout le reste.
window.addEventListener(
  'keydown',
  (e) => {
    if (!S.recording) return;
    e.preventDefault();
    e.stopPropagation();
    if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return; // on attend la touche principale
    if (e.key === 'Escape') return stopRecording();
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.metaKey && !e.ctrlKey && !e.altKey) return finishRecording('');
    const acc = acceleratorFromEvent(e);
    if (acc) finishRecording(acc);
    else toast('Ajoute au moins une touche ⌘, ⌃ ou ⌥');
  },
  true,
);

// Maintenir ⌘ affiche les numéros des sessions.
window.addEventListener('keydown', (e) => e.key === 'Meta' && document.body.classList.add('show-numbers'), true);
window.addEventListener('keyup', (e) => e.key === 'Meta' && document.body.classList.remove('show-numbers'), true);
window.addEventListener('blur', () => document.body.classList.remove('show-numbers'));

// Glisser-déposer de fichiers dans le terminal : insère les chemins, comme Terminal.app.
let dragDepth = 0;
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());
termHost.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragDepth += 1;
  termHost.classList.add('dragover');
});
termHost.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) termHost.classList.remove('dragover');
});
termHost.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  termHost.classList.remove('dragover');
  const paths = [...e.dataTransfer.files].map((f) => deck.pathForFile(f)).filter(Boolean);
  if (!paths.length || S.visiblePty == null) return;
  deck.ptyWrite(S.visiblePty, `${paths.map(shellEscape).join(' ')} `);
  focusTerm(S.visiblePty);
});

let fitTimer = null;
new ResizeObserver(() => {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(fitVisible, 30);
}).observe(termHost);

deck.on('deck:items', (items) => {
  S.items = items;
  // La session sélectionnée a changé de forme (fermée, rapatriée, reprise) : on la suit par son id.
  if (S.selected && !items.some((i) => i.key === S.selected) && S.selectedSessionId) {
    const same = items.find((i) => i.sessionId === S.selectedSessionId);
    if (same) {
      S.selected = same.key;
      S.snapshot = same.kind === 'closed' ? same : null;
      deck.select(same.key);
    } else if (!itemByKey(S.selected)) S.selected = null;
  }
  const cur = itemByKey(S.selected);
  if (cur && cur.sessionId) S.selectedSessionId = cur.sessionId;
  if (S.results) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 300); // états à jour dans les résultats
  }
  render();
});

deck.on('deck:usage', (u) => {
  S.usage = u;
  renderUsage();
  if (S.selected === 'view:stats' && S.stats) {
    S.stats.usage = u;
    S.statsAt = Date.now();
    renderPane();
  }
});

deck.on('deck:bridge', (b) => {
  S.bridge = b;
  render();
});

deck.on('deck:update', (u) => {
  S.update = u;
  renderUpdate();
});

deck.on('deck:select', (key) => {
  clearSearch();
  select(key);
});

deck.on('deck:config', (config) => {
  S.config = config;
  updateShortcutHints();
  if (S.headSig === 'empty') S.headSig = ''; // écran d'accueil : raccourcis à jour
  applyFont();
  render();
});

deck.on('deck:command', (name) => {
  if (name === 'next') step(1);
  else if (name === 'prev') step(-1);
  else if (name === 'nextAttention') nextAttention();
  else if (name === 'search') {
    searchEl.focus();
    searchEl.select();
  } else if (name === 'stats') {
    select('view:stats');
  } else if (name === 'settings') {
    openSettings('general');
  } else if (name === 'settings:perms') {
    openSettings('perms');
  } else if (name === 'archive') {
    const it = itemByKey(S.selected);
    if (canArchive(it) && !it.archived) archive([it.sessionId]);
    else if (it && it.host === 'app') toast('Un terminal de l’appli se ferme (⌘W), il ne s’archive pas');
  } else if (name.startsWith('goto:')) {
    const it = navOrder()[Number(name.slice(5))];
    if (it) select(it.key);
  } else if (name === 'closeCurrent') {
    const it = itemByKey(S.selected);
    if (it && it.ptyId != null) deck.close(it.ptyId);
  } else if (name === 'selectAll') {
    const r = S.terms.get(S.visiblePty);
    if (r) r.term.selectAll();
  } else if (name === 'clear') {
    const r = S.terms.get(S.visiblePty);
    if (r) r.term.clear();
  } else if (name.startsWith('font:')) changeFont(name.slice(5));
});

deck.on('pty:created', (p) => createTerm(p.id, ''));
deck.on('pty:data', (id, data) => (S.terms.get(id) || createTerm(id, '')).term.write(data));
deck.on('pty:exit', (id) => {
  removeTerm(id);
  if (S.selected === `pty:${id}`) {
    const next = navOrder()[0];
    S.selected = null;
    if (next) select(next.key, { focus: true });
    else render();
  }
});

setInterval(render, 30000); // durées relatives

(async function init() {
  const st = await deck.init();
  S.config = st.config;
  updateShortcutHints();
  S.update = st.update || null;
  S.usage = st.usage || null;
  S.bridge = st.bridge || null;
  S.bridgeDismissed = !!st.bridgeDismissed;
  S.collapsed = st.collapsed || {};
  S.lastOpen = st.lastOpen || [];
  S.items = st.items || [];
  for (const p of st.ptys) createTerm(p.id, p.replay);
  if (st.selectedKey && itemByKey(st.selectedKey)) select(st.selectedKey);
  else render();
})();
