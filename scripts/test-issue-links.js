'use strict';
// node scripts/test-issue-links.js
const assert = require('assert');
const { findIssueLinks } = require('../renderer/issue-links.js');
const { webBaseFromRemote, mergeRequestUrl } = require('../lib/git-links.js');

const config = { jiraUrl: 'https://jira.example.com/browse/{key}', jiraKeys: 'PROJ, ops' };
const found = (text, c = config) => findIssueLinks(text, c).map((l) => l.url || `!${l.mr}`);

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
console.log('issue-links OK');
