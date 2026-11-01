'use strict';
// Page web d'une merge request d'après le remote git du dossier d'une session.

const { execFile } = require('child_process');

// git@host:groupe/projet.git, ssh://git@host:2222/groupe/projet.git, https://user@host/groupe/projet.git
// → https://host/groupe/projet (null si format inconnu).
function webBaseFromRemote(remote) {
  const s = String(remote || '').trim();
  let m = s.match(/^https?:\/\/(?:[^@/\s]+@)?([^/\s]+)\/(.+?)(?:\.git)?\/?$/);
  if (m) return `https://${m[1]}/${m[2]}`;
  m = s.match(/^(?:ssh:\/\/)?[^@/\s]+@([^:/\s]+)(?::\d+\/|[:/])(.+?)(?:\.git)?\/?$/);
  if (m) return `https://${m[1]}/${m[2]}`;
  return null;
}

// shortcut: suppose que l'interface web est sur le même hôte que le remote SSH, à revoir si un GitLab les sépare.
function mergeRequestUrl(remote, n) {
  const base = webBaseFromRemote(remote);
  if (!base) return null;
  return /^https:\/\/github\.com\//.test(base) ? `${base}/pull/${n}` : `${base}/-/merge_requests/${n}`;
}

// groupe/projet!8045 : hôte du remote de la session (hors GitHub), sinon celui du modèle de secours des réglages.
function projectMergeRequestUrl(project, n, remote, fallback) {
  const base = webBaseFromRemote(remote);
  let host = null;
  try {
    host = base && !/^https:\/\/github\.com\//.test(base) ? new URL(base).origin : fallback ? new URL(fallback).origin : null;
  } catch {
    // modèle de secours mal formé (config.json modifié à la main)
  }
  return host ? `${host}/${project}/-/merge_requests/${n}` : null;
}

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 3000 }, (err, out) => resolve(err ? '' : String(out).trim()));
  });
}

// Remote « origin », sinon le premier déclaré ; '' hors d'un dépôt git.
async function remoteOf(cwd) {
  const origin = await git(cwd, ['remote', 'get-url', 'origin']);
  if (origin) return origin;
  const first = (await git(cwd, ['remote'])).split('\n')[0];
  return first ? git(cwd, ['remote', 'get-url', first]) : '';
}

// Dossier courant d'un processus (le shell d'un terminal sans session Claude) ; '' si inconnu.
function cwdOfPid(pid) {
  return new Promise((resolve) => {
    execFile('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 3000 }, (err, out) => {
      const line = err ? '' : String(out).split('\n').find((l) => l.startsWith('n'));
      resolve(line ? line.slice(1) : '');
    });
  });
}

module.exports = { webBaseFromRemote, mergeRequestUrl, projectMergeRequestUrl, remoteOf, cwdOfPid };
