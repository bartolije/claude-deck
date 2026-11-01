'use strict';
// node scripts/test-issue-links.js
const assert = require('assert');
const { findIssueLinks } = require('../renderer/issue-links.js');
const { webBaseFromRemote, mergeRequestUrl, projectMergeRequestUrl } = require('../lib/git-links.js');

const config = { jiraUrl: 'https://jira.example.com/browse/{key}', jiraKeys: 'PROJ, ops' };
const found = (text, c = config) => findIssueLinks(text, c).map((l) => l.url || `${l.project || ''}!${l.mr}`);

// Jira
assert.deepStrictEqual(found('voir PROJ-1234 et OPS-7.'), [
  'https://jira.example.com/browse/PROJ-1234',
  'https://jira.example.com/browse/OPS-7',
]);
assert.deepStrictEqual(found('UTF-8, SHA-256, XPROJ-12, PROJ-12x, PROJ-'), []);
assert.deepStrictEqual(found('PROJ-1', {}), []); // rien tant que l'URL Jira n'est pas réglée

// Merge requests : toujours repérées, l'URL vient du dépôt de la session
assert.deepStrictEqual(found('!MR8045, MR!8046 et (!8047)', {}), ['!8045', '!8046', '!8047']);
assert.deepStrictEqual(found('!!123 a!12 !12ab !12345678', {}), []);
// Références complètes : le projet est écrit, une seule détection (pas de doublon avec !9899)
assert.deepStrictEqual(found('See merge request lya-protect/lya-protect-courtage!9899', {}), ['lya-protect/lya-protect-courtage!9899']);
assert.deepStrictEqual(found('(groupe/sous/projet!12).', {}), ['groupe/sous/projet!12']);
assert.deepStrictEqual(found('https://h.example/g/p!12 projet!12 a/b!12x', {}), []);
const [l] = findIssueLinks('⏺ PROJ-42', config);
assert.strictEqual('⏺ PROJ-42'.slice(l.start, l.end), 'PROJ-42');

// Remote git → page web
const base = 'https://gitlab.example.com/groupe/sous/projet';
for (const r of [
  'git@gitlab.example.com:groupe/sous/projet.git',
  'ssh://git@gitlab.example.com:2222/groupe/sous/projet.git',
  'ssh://git@gitlab.example.com/groupe/sous/projet',
  'https://gitlab.example.com/groupe/sous/projet.git',
  'https://oauth2:jeton@gitlab.example.com/groupe/sous/projet/',
]) assert.strictEqual(webBaseFromRemote(r), base, r);
assert.strictEqual(webBaseFromRemote('/chemin/local/depot'), null);
assert.strictEqual(mergeRequestUrl('git@gitlab.example.com:g/p.git', '8045'), 'https://gitlab.example.com/g/p/-/merge_requests/8045');
assert.strictEqual(mergeRequestUrl('https://github.com/moi/depot.git', '12'), 'https://github.com/moi/depot/pull/12');
const gl = (r, f) => projectMergeRequestUrl('g/p', '12', r, f);
assert.strictEqual(gl('git@gitlab.example.com:x/y.git', ''), 'https://gitlab.example.com/g/p/-/merge_requests/12');
assert.strictEqual(gl('https://github.com/moi/depot.git', 'https://gitlab.example.com/{n}'), 'https://gitlab.example.com/g/p/-/merge_requests/12');
assert.strictEqual(gl('', 'https://gitlab.example.com/'), 'https://gitlab.example.com/g/p/-/merge_requests/12');
assert.strictEqual(gl('', ''), null);
assert.strictEqual(gl('', 'pas une adresse'), null);
console.log('issue-links OK');
