'use strict';
// node scripts/test-issue-links.js
const assert = require('assert');
const { findIssueLinks } = require('../renderer/issue-links.js');

const config = {
  jiraUrl: 'https://jira.example.com/browse/{key}',
  jiraKeys: 'PROJ, ops',
  mergeRequestUrl: 'https://gitlab.example.com/groupe/projet/-/merge_requests/{n}',
};
const urls = (text, c = config) => findIssueLinks(text, c).map((l) => l.url);

assert.deepStrictEqual(urls('voir PROJ-1234 et OPS-7.'), [
  'https://jira.example.com/browse/PROJ-1234',
  'https://jira.example.com/browse/OPS-7',
]);
assert.deepStrictEqual(urls('UTF-8, SHA-256, XPROJ-12, PROJ-12x, PROJ-'), []);
assert.deepStrictEqual(urls('!MR8045, MR!8046 et (!8047)'), [
  'https://gitlab.example.com/groupe/projet/-/merge_requests/8045',
  'https://gitlab.example.com/groupe/projet/-/merge_requests/8046',
  'https://gitlab.example.com/groupe/projet/-/merge_requests/8047',
]);
assert.deepStrictEqual(urls('!!123 a!12 !12ab'), []);
assert.deepStrictEqual(urls('PROJ-1 !2', {}), []); // rien tant que les URL ne sont pas réglées
const [l] = findIssueLinks('⏺ PROJ-42', config);
assert.strictEqual('⏺ PROJ-42'.slice(l.start, l.end), 'PROJ-42');
console.log('issue-links OK');
