'use strict';
/* global esc, permsHtml */
// Vue Réglages : chaque modification est enregistrée aussitôt (validée côté processus principal).

const SETTINGS_TABS = [
  ['general', 'Général'],
  ['sessions', 'Sessions'],
  ['terminal', 'Terminal'],
  ['shortcuts', 'Raccourcis'],
  ['perms', 'Autorisations'],
  ['advanced', 'Avancé'],
];

const SHORTCUT_LABELS = [
  ['newSession', 'Nouvelle session'],
  ['newSessionInFolder', 'Nouvelle session dans un dossier'],
  ['search', 'Rechercher dans les conversations'],
  ['nextAttention', 'Prochaine session qui t’attend'],
  ['nextSession', 'Session suivante'],
  ['prevSession', 'Session précédente'],
  ['archive', 'Archiver la session'],
  ['stats', 'Statistiques et usage'],
  ['closeSession', 'Fermer la session'],
  ['settings', 'Réglages'],
];

// « CmdOrCtrl+Shift+T » → « ⇧⌘T », dans l'ordre des menus macOS.
function prettyAccelerator(acc) {
  if (!acc) return 'aucun';
  const parts = acc.split('+');
  const key = parts.pop();
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const sym = [
    mods.has('control') || mods.has('ctrl') ? '⌃' : '',
    mods.has('alt') || mods.has('option') ? '⌥' : '',
    mods.has('shift') ? '⇧' : '',
    mods.has('command') || mods.has('cmd') || mods.has('cmdorctrl') || mods.has('commandorcontrol') ? '⌘' : '',
  ].join('');
  const keys = { Space: 'Espace', Up: '↑', Down: '↓', Left: '←', Right: '→', Enter: '↩', Return: '↩', Backspace: '⌫', Delete: '⌦', Escape: 'Échap', Tab: '⇥' };
  return sym + (keys[key] || key);
}

// Combinaison tapée → accélérateur Electron (null si incomplète).
function acceleratorFromEvent(e) {
  const named = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Enter: 'Enter', Backspace: 'Backspace', Delete: 'Delete', Tab: 'Tab', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown' };
  let key = null;
  if (/^Key[A-Z]$/.test(e.code)) key = /^[a-z]$/i.test(e.key) ? e.key.toUpperCase() : e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.key)) key = e.key;
  else if (named[e.key]) key = named[e.key];
  else if (/^[=\-[\];',./`\\]$/.test(e.key)) key = e.key;
  if (!key) return null;
  const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Command'].filter(Boolean);
  if (!mods.length && !/^F\d+$/.test(key)) return null; // une touche seule déclencherait l'action en tapant du texte
  return [...mods, key].join('+');
}

function normalizeAcc(acc) {
  return prettyAccelerator(acc || '');
}

function toggleRow(key, title, desc, checked, special = '') {
  const attr = special ? `data-special="${special}"` : `data-key="${key}"`;
  return `<label class="setting">
    <span class="s-text"><b>${title}</b>${desc ? `<small>${desc}</small>` : ''}</span>
    <input type="checkbox" class="switch" ${attr} ${checked ? 'checked' : ''}>
  </label>`;
}

function textRow(key, title, desc, value, placeholder = '') {
  return `<label class="setting col">
    <span class="s-text"><b>${title}</b>${desc ? `<small>${desc}</small>` : ''}</span>
    <input type="text" class="field mono" data-key="${key}" value="${esc(value)}" placeholder="${esc(placeholder)}" spellcheck="false" autocomplete="off">
  </label>`;
}

function numberRow(key, title, desc, value, min, max, step = 1, unit = '') {
  return `<label class="setting">
    <span class="s-text"><b>${title}</b>${desc ? `<small>${desc}</small>` : ''}</span>
    <span class="num-field"><input type="number" class="field" data-key="${key}" value="${esc(value)}" min="${min}" max="${max}" step="${step}">${unit ? `<span>${unit}</span>` : ''}</span>
  </label>`;
}

function selectRow(key, title, desc, value, options) {
  return `<label class="setting">
    <span class="s-text"><b>${title}</b>${desc ? `<small>${desc}</small>` : ''}</span>
    <select class="field" data-key="${key}">${options.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
  </label>`;
}

function shortcutButton(name, acc, recording) {
  const label = recording ? 'Tape la combinaison… (Échap : annuler, ⌫ : aucun)' : prettyAccelerator(acc);
  return `<button class="shortcut${recording ? ' recording' : ''}" data-shortcut="${name}">${esc(label)}</button>`;
}

function settingsHtml(payload, tab, perms, recording) {
  if (!payload) return '<div class="stats"><p class="msgs-note">Chargement des réglages…</p></div>';
  const c = payload.config;
  const tabs = SETTINGS_TABS.map(([id, label]) => `<button class="tab${id === tab ? ' active' : ''}" data-tab="${id}">${label}</button>`).join('');
  let body = '';

  if (tab === 'general') {
    const loginDesc = payload.packaged ? 'Claude Deck démarre avec ta session macOS.' : 'Disponible dans l’appli installée.';
    const u = payload.update || {};
    const updateText = u.status === 'ready' ? `version ${esc(u.latest)} prête, installée à la prochaine fermeture` : u.status === 'error' ? esc(u.error || '') : 'à jour';
    body = `
      <section class="s-group"><h3>Démarrage</h3>
        ${toggleRow('', 'Ouvrir à l’ouverture de session', loginDesc, !!payload.loginItem, payload.packaged ? 'loginItem' : 'loginItemDisabled')}
      </section>
      <section class="s-group"><h3>Indicateurs</h3>
        ${toggleRow('showTray', 'Compteur dans la barre des menus', 'Sessions en attente, terminées, en cours.', c.showTray !== false)}
        ${toggleRow('showDockBadge', 'Badge sur l’icône du Dock', 'Nombre de sessions à traiter.', c.showDockBadge !== false)}
      </section>
      <section class="s-group"><h3>Notifications</h3>
        ${toggleRow('notifications', 'Prévenir quand une session termine ou t’attend', 'Sauf si tu regardes déjà cette session.', c.notifications !== false)}
        ${toggleRow('notificationSound', 'Avec un son', '', c.notificationSound !== false)}
      </section>
      <section class="s-group"><h3>Forfait Claude</h3>
        ${toggleRow('', 'Suivre l’usage en direct (barre d’état Claude Code)', 'Session et semaine mises à jour après chaque réponse ; ajoute une ligne en bas de tes sessions.', !!(payload.bridge && payload.bridge.installed), 'bridge')}
      </section>
      <section class="s-group"><h3>Mises à jour</h3>
        ${toggleRow('autoUpdate', 'Installer les nouvelles versions automatiquement', 'Vérifiées au démarrage puis toutes les 6 h, installées à la fermeture.', c.autoUpdate !== false)}
        <div class="setting"><span class="s-text"><b>Version ${esc(payload.version)}</b><small>${updateText}</small></span><button class="btn small" data-act="checkUpdate">Vérifier maintenant</button></div>
      </section>`;
  } else if (tab === 'sessions') {
    body = `
      <section class="s-group"><h3>Commandes</h3>
        <p class="s-hint">Tapées dans un zsh de login interactif, comme dans Terminal : tes alias fonctionnent. {cwd} est remplacé par le dossier, {sessionId} par la session.</p>
        ${textRow('newSessionCommand', 'Nouvelle session', 'Bouton « Nouvelle session ».', c.newSessionCommand, payload.defaults.newSessionCommand)}
        ${textRow('newSessionInFolderCommand', 'Nouvelle session dans un dossier', 'Doit contenir {cwd}.', c.newSessionInFolderCommand, payload.defaults.newSessionInFolderCommand)}
        ${textRow('resumeCommand', 'Reprise d’une conversation', 'Doit contenir {sessionId}.', c.resumeCommand, payload.defaults.resumeCommand)}
        ${textRow('shell', 'Shell', 'Chemin complet.', c.shell, payload.defaults.shell)}
      </section>
      <section class="s-group"><h3>Liste</h3>
        ${numberRow('closedSessionsDays', '« Fermées récemment »', 'Les plus anciennes restent trouvables par la recherche.', c.closedSessionsDays, 1, 30, 1, 'jours')}
        ${numberRow('staleAfterHours', 'Griser une session au repos après', '', c.staleAfterHours, 1, 168, 1, 'h')}
        ${toggleRow('showBackgroundAgents', 'Afficher les agents en arrière-plan', 'Sessions lancées avec claude --bg.', c.showBackgroundAgents !== false)}
      </section>`;
  } else if (tab === 'terminal') {
    body = `
      <section class="s-group"><h3>Texte</h3>
        ${selectRow('fontFamily', 'Police', '', c.fontFamily, [
          ['"SF Mono", Menlo, Monaco, monospace', 'SF Mono (comme Terminal)'],
          ['Menlo, monospace', 'Menlo'],
          ['Monaco, monospace', 'Monaco'],
          ['"JetBrains Mono", "SF Mono", Menlo, monospace', 'JetBrains Mono (si installée)'],
          ['"Fira Code", "SF Mono", Menlo, monospace', 'Fira Code (si installée)'],
        ].concat([[c.fontFamily, c.fontFamily]].filter(([v]) => !/^("SF Mono"|Menlo|Monaco|"JetBrains Mono"|"Fira Code")/.test(v))))}
        ${numberRow('fontSize', 'Taille', 'Aussi avec ⌘+ et ⌘−.', c.fontSize, 9, 28, 1, 'pt')}
        ${numberRow('lineHeight', 'Interligne', '', c.lineHeight, 0.8, 2, 0.05, '')}
      </section>
      <section class="s-group"><h3>Claude</h3>
        ${selectRow('claudeDisplay', 'Affichage', 'Pour les sessions lancées ensuite.', c.claudeDisplay, [
          ['auto', 'Selon ton réglage Claude Code (/tui)'],
          ['classic', 'Classique : historique et barre de défilement'],
          ['fullscreen', 'Plein écran'],
        ])}
        ${selectRow('scrollSpeed', 'Vitesse de la molette', '', c.scrollSpeed, [
          [1, 'Normale (comme Terminal)'],
          [2, 'Rapide (×2)'],
          [3, 'Très rapide (×3)'],
        ])}
      </section>`;
  } else if (tab === 'shortcuts') {
    const counts = {};
    for (const [name] of SHORTCUT_LABELS) {
      const acc = normalizeAcc(c.shortcuts[name]);
      if (c.shortcuts[name]) counts[acc] = (counts[acc] || 0) + 1;
    }
    const rows = SHORTCUT_LABELS.map(([name, label]) => {
      const acc = c.shortcuts[name];
      const dup = acc && counts[normalizeAcc(acc)] > 1 ? '<small class="s-warn">même combinaison qu’une autre action</small>' : '';
      const reset = acc !== payload.defaults.shortcuts[name] ? `<button class="btn small ghost" data-reset-shortcut="${name}">Par défaut</button>` : '';
      return `<div class="setting"><span class="s-text"><b>${label}</b>${dup}</span><span class="sc-actions">${reset}${shortcutButton(name, acc, recording === name)}</span></div>`;
    }).join('');
    const g = c.globalShortcut;
    const gWarn = g && !payload.globalShortcutOk ? '<small class="s-warn">déjà utilisée par une autre appli : choisis-en une autre</small>' : '<small>Fonctionne depuis n’importe quelle appli ; masque Claude Deck s’il est déjà devant. Par exemple ⌥Espace.</small>';
    body = `
      <section class="s-group"><h3>Partout</h3>
        <div class="setting"><span class="s-text"><b>Afficher Claude Deck</b>${gWarn}</span><span class="sc-actions">${g ? '<button class="btn small ghost" data-clear-global>Désactiver</button>' : ''}${shortcutButton('__global', g, recording === '__global')}</span></div>
      </section>
      <section class="s-group"><h3>Dans l’appli</h3>${rows}
        <p class="s-hint">Fixes : ⌘1 … ⌘9 (aller à une session), ⌘+ ⌘− ⌘0 (taille du texte), ⇧↩ (retour à la ligne dans le prompt).</p>
      </section>`;
  } else if (tab === 'perms') {
    body = permsHtml(perms);
  } else if (tab === 'advanced') {
    body = `
      <section class="s-group"><h3>Fichiers</h3>
        <div class="setting"><span class="s-text"><b>config.json</b><small>Tous les réglages, au format texte.</small></span><button class="btn small" data-act="openConfigFile">Ouvrir</button></div>
        <div class="setting"><span class="s-text"><b>Dossier des données</b><small>Réglages, sessions lues et archivées, historique de l’usage.</small></span><button class="btn small" data-act="openDataDir">Ouvrir dans le Finder</button></div>
      </section>`;
  }
  return `<div class="settings"><nav class="tabs">${tabs}</nav><div class="tab-body">${body}</div></div>`;
}
