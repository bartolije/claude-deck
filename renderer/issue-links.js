'use strict';
// Tickets Jira (PROJ-1234) et merge requests GitLab (!8045, !MR8045, MR!8045) cliquables dans le terminal.

// Liens trouvés dans un texte : [{ start, end (exclu), url }], selon les modèles d'URL des réglages.
function findIssueLinks(text, config) {
  const links = [];
  const keys = String(config.jiraKeys || '')
    .split(',')
    .map((k) => k.trim().toUpperCase())
    .filter((k) => /^[A-Z][A-Z0-9]*$/.test(k));
  if (config.jiraUrl && keys.length) {
    const re = new RegExp(`(?<![\\w-])(?:${keys.join('|')})-\\d+(?![\\w-])`, 'g');
    for (const m of text.matchAll(re)) {
      links.push({ start: m.index, end: m.index + m[0].length, url: config.jiraUrl.replace('{key}', m[0]) });
    }
  }
  if (config.mergeRequestUrl) {
    for (const m of text.matchAll(/(?<![\w!])(?:!MR|MR!|!)(\d+)(?!\w)/g)) {
      links.push({ start: m.index, end: m.index + m[0].length, url: config.mergeRequestUrl.replace('{n}', m[1]) });
    }
  }
  return links;
}

// Fournisseur de liens xterm : une ligne à la fois (shortcut: un ticket coupé par le retour à la ligne n'est pas détecté).
function issueLinkProvider(term, getConfig, activate) {
  return {
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1);
      if (!line) return callback(undefined);
      // Texte de la ligne et colonne de chaque caractère (les emojis occupent deux cellules).
      let text = '';
      const cols = [];
      for (let x = 0; x < line.length; x++) {
        const cell = line.getCell(x);
        if (!cell || cell.getWidth() === 0) continue;
        const ch = cell.getChars() || ' ';
        text += ch;
        for (let i = 0; i < ch.length; i++) cols.push(x + 1);
      }
      const links = findIssueLinks(text, getConfig()).map((l) => ({
        range: { start: { x: cols[l.start], y }, end: { x: cols[l.end - 1], y } },
        text: text.slice(l.start, l.end),
        activate: (event) => activate(event, l.url),
      }));
      callback(links.length ? links : undefined);
    },
  };
}

if (typeof module !== 'undefined') module.exports = { findIssueLinks };
