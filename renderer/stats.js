'use strict';
/* global esc, ago */
// Usage du forfait (bloc de la barre latérale), jauges de contexte et vue « Statistiques et usage ».
// Chargé avant app.js : les fonctions ne sont appelées qu'une fois tout chargé.

const HOUR = 3600000;
const DAY = 24 * HOUR;
const SESSION_WINDOW = 5 * HOUR;
const WEEK_WINDOW = 7 * DAY;

const fmtInt = (n) => new Intl.NumberFormat('fr-FR').format(Math.round(n || 0));
const fmtCompact = (n) => new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
const level = (p) => (p >= 90 ? 'crit' : p >= 70 ? 'warn' : 'ok');
const clampPct = (p) => Math.max(0, Math.min(100, Math.round(p)));

function fmtReset(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString('fr-FR', { weekday: 'short' })} ${time}`;
}

function fmtDuration(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${String(m % 60).padStart(2, '0')}`;
  return `${Math.floor(h / 24)} j ${h % 24} h`;
}

function meter(p, cls = '') {
  return `<span class="meter ${cls} lvl-${level(p)}"><i style="width:${clampPct(p)}%"></i></span>`;
}

// --- Jauge de contexte (liste et en-tête) -----------------------------------------------------

function ctxTitle(c) {
  const of = c.window ? ` (${fmtCompact(c.tokens)} sur ${fmtCompact(c.window)} jetons)` : '';
  return `Contexte utilisé : ${c.pct} %${of}`;
}

function ctxMini(it) {
  const c = it.context;
  if (!c || c.pct == null) return '';
  return `<span class="ctx" title="${esc(ctxTitle(c))}">${meter(c.pct, 'mini')}${clampPct(c.pct)} %</span>`;
}

function headStats(it) {
  const parts = [];
  if (it.branch) parts.push(`<span class="hstat" title="Branche git">⎇ ${esc(it.branch)}</span>`);
  if (it.state === 'busy') {
    const n = it.turnActions || 0;
    const actions = n ? ` · ${n}${it.turnPartial ? '+' : ''} action${n > 1 ? 's' : ''}` : '';
    parts.push(`<span class="hstat" title="Tour en cours">${esc(ago(it.since))}${actions}</span>`);
  }
  if (it.context && it.context.pct != null) {
    const c = it.context;
    parts.push(`<span class="hstat ctx" title="${esc(ctxTitle(c))}">${meter(c.pct)}Contexte ${clampPct(c.pct)} %</span>`);
  }
  return parts.length ? `<div class="hstats">${parts.join('')}</div>` : '';
}

// --- Forfait : bloc de la barre latérale --------------------------------------------------------

function usageSource(u) {
  const age = Date.now() - u.updatedAt;
  if (u.source === 'statusline' && age < 15 * 60000) return 'en direct';
  return `relevé ${ago(u.updatedAt) === 'à l’instant' ? 'à l’instant' : `il y a ${ago(u.updatedAt)}`}${u.source === 'usage' ? ' (/usage)' : ''}`;
}

function usageRow(label, w) {
  if (!w) return '';
  if (w.pct == null) {
    return `<div class="usage-row"><span class="usage-label">${label}</span><span class="usage-reset-done">remise à zéro à ${esc(fmtReset(w.resetsAt))}</span></div>`;
  }
  const p = clampPct(w.pct);
  const warn = level(p) === 'crit' ? ' — presque épuisé' : level(p) === 'warn' ? ' — élevé' : '';
  return `<div class="usage-row" title="${label} : ${p} % utilisés${warn}, remise à zéro ${esc(fmtReset(w.resetsAt))}">
    <span class="usage-label">${label}</span>${meter(p)}<span class="usage-pct">${p} %</span><span class="usage-reset">${esc(fmtReset(w.resetsAt))}</span>
  </div>`;
}

function usageFooterHtml(u, bridge) {
  if (!u) {
    const hint = bridge && bridge.installed ? 'Les pourcentages arrivent après la prochaine réponse de Claude.' : 'Lance /usage dans une session, ou active la barre d’état pour suivre ton forfait en direct.';
    return `<div class="usage-head"><span>Forfait Claude</span></div><div class="usage-empty">${hint}</div>`;
  }
  return `<div class="usage-head"><span>Forfait Claude</span><span class="usage-src">${esc(usageSource(u))}</span></div>
    ${usageRow('Session', u.session)}${usageRow('Semaine', u.week)}`;
}

// Rythme : part consommée comparée à la part de la fenêtre déjà écoulée.
function paceText(w, length) {
  if (!w || w.pct == null || !w.resetsAt) return '';
  const now = Date.now();
  const start = w.resetsAt - length;
  const elapsed = (now - start) / length;
  if (elapsed <= 0.03 || elapsed >= 1) return '';
  const used = w.pct / 100;
  if (used <= 0) return 'Rien de consommé pour l’instant.';
  const t100 = start + (now - start) / used;
  if (t100 < w.resetsAt) {
    return `À ce rythme, 100 % vers ${fmtReset(t100)}, soit ${fmtDuration(w.resetsAt - t100)} avant la remise à zéro.`;
  }
  const atReset = Math.round(100 * Math.min(used / elapsed, 9.99));
  return `À ce rythme, environ ${atReset} % à la remise à zéro : tu as de la marge.`;
}

function usageCard(title, w, length) {
  if (!w) return `<div class="ucard"><div class="ucard-title">${title}</div><div class="ucard-empty">Pas de donnée</div></div>`;
  if (w.pct == null) {
    return `<div class="ucard"><div class="ucard-title">${title}</div><div class="ucard-big">0 %</div><div class="ucard-sub">Remise à zéro à ${esc(fmtReset(w.resetsAt))}, pas encore de nouvelle mesure.</div></div>`;
  }
  const p = clampPct(w.pct);
  const lvl = level(p);
  const badge = lvl === 'crit' ? '<span class="lvl-badge lvl-crit">⚠ presque épuisé</span>' : lvl === 'warn' ? '<span class="lvl-badge lvl-warn">▲ élevé</span>' : '';
  return `<div class="ucard">
    <div class="ucard-title">${title}${badge}</div>
    <div class="ucard-big">${p} %</div>
    ${meter(p, 'big')}
    <div class="ucard-sub">Remise à zéro ${esc(fmtReset(w.resetsAt))}, dans ${esc(fmtDuration(w.resetsAt - Date.now()))}</div>
    <div class="ucard-pace">${esc(paceText(w, length))}</div>
  </div>`;
}

// --- Graphiques (SVG, une seule série par graphique) -------------------------------------------

// Largeur du repère SVG = largeur affichée : 1 unité = 1 px, le texte garde sa taille.
let VB_W = 760;

function niceMax(v) {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * pow).find((m) => m >= v) || 10 * pow;
}

function roundTopBar(x, y, w, h, base) {
  const r = Math.min(4, w / 2, h);
  if (h <= 0) return '';
  return `M${x},${base} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${base} Z`;
}

function barChart(days) {
  const H = 170;
  const pad = { l: 40, r: 8, t: 10, b: 24 };
  const plotW = VB_W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const max = niceMax(Math.max(...days.map((d) => d.requests), 0));
  const step = plotW / days.length;
  const barW = Math.max(2, step - 2); // 2 px d'écart entre barres
  const base = pad.t + plotH;
  let grid = '';
  for (const f of [0, 0.5, 1]) {
    const y = base - f * plotH;
    grid += `<line class="grid" x1="${pad.l}" x2="${VB_W - pad.r}" y1="${y}" y2="${y}"/><text class="axis" x="${pad.l - 6}" y="${y + 4}" text-anchor="end">${fmtCompact(max * f)}</text>`;
  }
  let bars = '';
  let hits = '';
  let labels = '';
  days.forEach((d, i) => {
    const x = pad.l + i * step + 1;
    const h = (d.requests / max) * plotH;
    bars += `<path class="bar" d="${roundTopBar(x, base - h, barW, h, base)}"/>`;
    const tip = `${d.label} — ${fmtInt(d.requests)} requête${d.requests > 1 ? 's' : ''}, ${d.sessions} conversation${d.sessions > 1 ? 's' : ''}, ${fmtCompact(d.output)} jetons générés`;
    hits += `<rect class="hit" x="${x - 1}" y="${pad.t}" width="${step}" height="${plotH}" data-tip="${esc(tip)}"/>`;
    if ((days.length - 1 - i) % 7 === 0) {
      const anchor = i === days.length - 1 ? 'end' : 'middle';
      labels += `<text class="axis" x="${anchor === 'end' ? x + barW : x + barW / 2}" y="${H - 6}" text-anchor="${anchor}">${esc(d.short)}</text>`;
    }
  });
  return `<svg class="chart" viewBox="0 0 ${VB_W} ${H}" role="img" aria-label="Requêtes par jour sur 30 jours">${grid}${bars}${labels}${hits}</svg>`;
}

function lineChart(points, t0, t1, ticks) {
  const H = 150;
  const pad = { l: 40, r: 12, t: 10, b: 24 };
  const plotW = VB_W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const x = (t) => pad.l + ((t - t0) / (t1 - t0)) * plotW;
  const y = (v) => pad.t + plotH - (v / 100) * plotH;
  let grid = '';
  for (const v of [0, 50, 100]) grid += `<line class="grid" x1="${pad.l}" x2="${VB_W - pad.r}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${v} %</text>`;
  let labels = '';
  for (const tk of ticks) {
    const tx = x(tk.t);
    const anchor = tx < pad.l + 24 ? 'start' : tx > VB_W - pad.r - 24 ? 'end' : 'middle'; // pas d'étiquette coupée au bord
    labels += `<text class="axis" x="${tx}" y="${H - 6}" text-anchor="${anchor}">${esc(tk.label)}</text>`;
  }
  const now = Date.now();
  const nowLine = now > t0 && now < t1 ? `<line class="now" x1="${x(now)}" x2="${x(now)}" y1="${pad.t}" y2="${pad.t + plotH}"/>` : '';
  if (points.length < 1) {
    return `<svg class="chart" viewBox="0 0 ${VB_W} ${H}">${grid}${labels}${nowLine}<text class="empty-note" x="${VB_W / 2}" y="${H / 2}" text-anchor="middle">L’historique se construit au fil de l’eau</text></svg>`;
  }
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const last = points[points.length - 1];
  const data = esc(JSON.stringify(points.map((p) => [Math.round(x(p.t)), Math.round(y(p.v)), p.v, p.label])));
  return `<svg class="chart" viewBox="0 0 ${VB_W} ${H}" role="img">${grid}${labels}${nowLine}
    <path class="line" d="${d}"/>
    <circle class="dot-end" cx="${x(last.t)}" cy="${y(last.v)}" r="4"/>
    <line class="xhair" x1="0" x2="0" y1="${pad.t}" y2="${pad.t + plotH}" visibility="hidden"/>
    <circle class="xhair-dot" r="4" visibility="hidden"/>
    <rect class="hit line-hit" x="${pad.l}" y="${pad.t}" width="${plotW}" height="${plotH}" data-points="${data}"/>
  </svg>`;
}

function historySeries(history, key, t0, t1) {
  return history
    .filter((h) => h[key] != null && h.t >= t0 && h.t <= t1)
    .map((h) => ({ t: h.t, v: h[key], label: `${new Date(h.t).toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })} — ${h[key]} %` }));
}

function lastDays(daysMap, n = 30) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * DAY);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const v = daysMap[key] || { requests: 0, output: 0, input: 0, sessions: 0 };
    out.push({
      ...v,
      label: d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }),
      short: d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'numeric' }),
    });
  }
  return out;
}

function statsHtml(data, width) {
  if (!data) return '<div class="stats"><p class="msgs-note">Calcul des statistiques…</p></div>';
  VB_W = Math.max(420, Math.min(900, Math.round(width || 760)));
  const u = data.usage;
  const now = Date.now();
  const bridgeLine = data.bridge && data.bridge.installed
    ? `Barre d’état active : les pourcentages se mettent à jour après chaque réponse de Claude. <button class="btn small ghost" data-act="disableBridge">Désactiver</button>`
    : `Sans barre d’état, les pourcentages viennent de ton dernier /usage. <button class="btn small primary" data-act="enableBridge">Suivre en direct</button>`;

  // Fenêtres courantes : semaine (de la remise à zéro précédente à la prochaine) et 24 dernières heures.
  const weekEnd = u && u.week && u.week.resetsAt ? u.week.resetsAt : now + DAY;
  const weekStart = weekEnd - WEEK_WINDOW;
  const weekTicks = [];
  for (let t = weekStart; t <= weekEnd; t += DAY) weekTicks.push({ t, label: new Date(t).toLocaleDateString('fr-FR', { weekday: 'short' }) });
  const dayStart = now - DAY;
  const dayTicks = [];
  for (let t = dayStart; t <= now; t += 6 * HOUR) dayTicks.push({ t, label: new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) });

  const days = lastDays(data.days || {});
  const totals = days.reduce((a, d) => ({ requests: a.requests + d.requests, output: a.output + d.output }), { requests: 0, output: 0 });
  const activeDays = days.filter((d) => d.requests > 0).length;
  const maxProject = Math.max(1, ...(data.projects || []).map((p) => p.requests));
  const projects = (data.projects || [])
    .map((p) => `<div class="hbar" title="${esc(`${p.name} : ${fmtInt(p.requests)} requêtes, ${p.sessions} conversations`)}">
      <span class="hbar-name">${esc(p.name)}</span>
      <span class="hbar-track"><i style="width:${(100 * p.requests) / maxProject}%"></i></span>
      <span class="hbar-val">${fmtInt(p.requests)}</span></div>`)
    .join('');

  return `<div class="stats">
    <div class="stats-note">${bridgeLine}</div>
    <div class="ucards">
      ${usageCard('Session (5 h)', u && u.session, SESSION_WINDOW)}
      ${usageCard('Semaine', u && u.week, WEEK_WINDOW)}
    </div>
    <section class="viz">
      <h3>Semaine en cours <span>part du forfait hebdomadaire utilisée</span></h3>
      ${lineChart(historySeries(data.history || [], 'w', weekStart, weekEnd), weekStart, weekEnd, weekTicks)}
    </section>
    <section class="viz">
      <h3>Dernières 24 h <span>part de la fenêtre de 5 h utilisée</span></h3>
      ${lineChart(historySeries(data.history || [], 's', dayStart, now), dayStart, now, dayTicks)}
    </section>
    <section class="viz">
      <h3>Activité sur 30 jours <span>${fmtInt(totals.requests)} requêtes · ${activeDays} jours actifs · ${fmtCompact(totals.output)} jetons générés</span></h3>
      ${barChart(days)}
    </section>
    <section class="viz">
      <h3>Par dossier <span>requêtes sur 30 jours</span></h3>
      <div class="hbars">${projects || '<p class="msgs-note">Pas encore d’activité.</p>'}</div>
    </section>
    <p class="stats-foot">Activité calculée depuis les conversations encore présentes (Claude Code les garde 30 jours). Les pourcentages du forfait viennent de Claude Code ; leur historique s’enregistre à partir de maintenant.</p>
  </div>`;
}

// --- Infobulles : barres (data-tip) et courbes (réticule) ----------------------------------------

function bindVizTips(container) {
  const tip = document.createElement('div');
  tip.className = 'viz-tip';
  tip.hidden = true;
  document.body.appendChild(tip);
  const place = (ev, text) => {
    tip.textContent = text;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.min(window.innerWidth - r.width - 8, ev.clientX + 12)}px`;
    tip.style.top = `${Math.max(8, ev.clientY - r.height - 10)}px`;
  };
  container.addEventListener('mousemove', (ev) => {
    const bar = ev.target.closest('[data-tip]');
    if (bar) {
      place(ev, bar.dataset.tip);
      return;
    }
    const hit = ev.target.closest('.line-hit');
    if (!hit) {
      tip.hidden = true;
      return;
    }
    const svg = hit.ownerSVGElement;
    const box = svg.getBoundingClientRect();
    const vx = ((ev.clientX - box.left) / box.width) * VB_W;
    const pts = JSON.parse(hit.dataset.points);
    let best = pts[0];
    for (const p of pts) if (Math.abs(p[0] - vx) < Math.abs(best[0] - vx)) best = p;
    const line = svg.querySelector('.xhair');
    const dot = svg.querySelector('.xhair-dot');
    line.setAttribute('x1', best[0]);
    line.setAttribute('x2', best[0]);
    line.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', best[0]);
    dot.setAttribute('cy', best[1]);
    dot.setAttribute('visibility', 'visible');
    place(ev, best[3]);
  });
  container.addEventListener('mouseleave', () => {
    tip.hidden = true;
    for (const el of container.querySelectorAll('.xhair, .xhair-dot')) el.setAttribute('visibility', 'hidden');
  });
}

// --- Autorisations macOS ------------------------------------------------------------------------

function permBadge(state) {
  const map = {
    granted: ['ok', '✓ accordé'],
    denied: ['no', '✕ refusé'],
    restricted: ['no', '✕ bloqué'],
    'not-determined': ['wait', '? pas encore demandé'],
    unknown: ['wait', '? pas encore vérifié'],
  };
  const [cls, label] = map[state] || map.unknown;
  return `<span class="perm-badge perm-${cls}">${label}</span>`;
}

function permsHtml(p) {
  if (!p) return '<div class="stats"><p class="msgs-note">Vérification des autorisations…</p></div>';
  const b = (act, label, cls = '') => `<button class="btn small ${cls}" data-act="perm:${act}">${esc(label)}</button>`;
  const folders = p.folders.map((f) => `<span class="perm-folder">${esc(f.label)} ${permBadge(f.status)}</span>`).join('');
  const mic = p.microphone;
  return `<div class="stats perms">
    <p class="stats-note">Une appli ne peut pas s’accorder ces droits elle-même : macOS les demande, ou il faut les activer dans les Réglages. Une fois accordés, ils restent valables d’une mise à jour à l’autre. Les programmes lancés dans les terminaux de Claude Deck (Claude Code, serveurs MCP, scripts) en profitent, comme ils profitaient de ceux de Terminal.</p>

    <section class="perm">
      <div class="perm-head"><h3>Dossiers protégés</h3>${p.fullDisk ? permBadge('granted') : ''}</div>
      <p>Documents, Bureau et Téléchargements : macOS demande une fois par dossier quand Claude lit un fichier. Tu peux faire toutes les demandes d’un coup maintenant.</p>
      <div class="perm-folders">${folders}</div>
      <div class="actions">${p.fullDisk ? '' : b('folders', 'Demander maintenant', 'primary')}${b('files', 'Ouvrir les réglages')}</div>
    </section>

    <section class="perm">
      <div class="perm-head"><h3>Accès complet au disque</h3>${permBadge(p.fullDisk ? 'granted' : 'unknown').replace('? pas encore vérifié', '— non activé')}</div>
      <p>Plus aucune demande pour les fichiers : dossiers protégés, disques externes, données des autres apps. À activer dans les Réglages (bouton +, puis Claude Deck), puis redémarrer Claude Deck.</p>
      <p class="perm-warn">⚠ Tout ce qui tourne dans tes terminaux pourra alors lire tout le disque, y compris Mail, Messages ou l’historique Safari, sans rien te demander. Avec <code>--dangerously-skip-permissions</code>, Claude le fera sans confirmation. Les autorisations par dossier suffisent en général.</p>
      <div class="actions">${b('fullDisk', 'Ouvrir les réglages')}${p.fullDisk ? '' : b('relaunch', 'Redémarrer Claude Deck')}</div>
    </section>

    <section class="perm">
      <div class="perm-head"><h3>Micro</h3>${permBadge(mic)}</div>
      <p>Pour le mode vocal de Claude Code dans les terminaux de l’appli.</p>
      <div class="actions">${mic === 'granted' ? '' : b('microphone', mic === 'not-determined' ? 'Autoriser' : 'Ouvrir les réglages', mic === 'not-determined' ? 'primary' : '')}</div>
    </section>

    <section class="perm">
      <div class="perm-head"><h3>Contrôle de Terminal et iTerm2</h3></div>
      <p>Pour « Afficher dans Terminal » (sélection du bon onglet) : macOS le demande à la première utilisation.</p>
      <div class="actions">${b('automation', 'Ouvrir les réglages')}</div>
    </section>

    <section class="perm">
      <div class="perm-head"><h3>Notifications</h3></div>
      <p>Pour être prévenu quand une session termine ou t’attend.</p>
      <div class="actions">${b('notifications', 'Ouvrir les réglages')}</div>
    </section>
  </div>`;
}
