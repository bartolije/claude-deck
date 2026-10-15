'use strict';
// Lecture de l'état des sessions Claude Code, sans hook ni configuration :
// - registre ~/.claude/sessions/<pid>.json, tenu à jour par Claude Code lui-même
//   (status idle | busy | waiting + waitingFor) ;
// - transcripts ~/.claude/projects/<slug>/<sessionId>.jsonl (titre IA, dernier prompt, cwd) ;
// - agents en arrière-plan via `claude agents --json`.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFile } = require('child_process');

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const REGISTRY_DIR = path.join(CLAUDE_DIR, 'sessions');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const TAIL_BYTES = 512 * 1024;
const HEAD_BYTES = 128 * 1024;
// Sessions de sous-agents, scratchpads et tests : jamais utiles dans la liste des sessions fermées.
const IGNORED_CWD = [/^\/private\/(tmp|var)\//, /^\/tmp\//, /^\/var\/folders\//];

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function readRegistry() {
  let names;
  try {
    names = await fsp.readdir(REGISTRY_DIR);
  } catch {
    return [];
  }
  const out = [];
  await Promise.all(
    names
      .filter((n) => /^\d+\.json$/.test(n))
      .map(async (n) => {
        try {
          const e = JSON.parse(await fsp.readFile(path.join(REGISTRY_DIR, n), 'utf8'));
          if (e && e.pid && e.sessionId) out.push(e);
        } catch {
          // fichier en cours de réécriture : il sera relu au prochain tour
        }
      }),
  );
  return out;
}

// pid -> { ppid, tty, args } en un seul appel à ps.
async function processInfo(pids) {
  const map = new Map();
  if (!pids.length) return map;
  const { stdout } = await run('/bin/ps', ['-o', 'pid=,ppid=,tty=,args=', '-p', pids.join(',')]);
  for (const line of stdout.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    map.set(Number(m[1]), { ppid: Number(m[2]), tty: m[3] === '??' ? null : `/dev/${m[3]}`, args: m[4] });
  }
  return map;
}

// --- Transcripts -------------------------------------------------------------

const pathIndex = new Map(); // sessionId -> fichier .jsonl
const metaCache = new Map(); // fichier -> { size, mtimeMs, meta }

function slugFor(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function transcriptFile(sessionId, cwd) {
  const known = pathIndex.get(sessionId);
  if (known) return known;
  if (!cwd) return null;
  const f = path.join(PROJECTS_DIR, slugFor(cwd), `${sessionId}.jsonl`);
  if (!fs.existsSync(f)) return null; // pas encore de premier prompt
  pathIndex.set(sessionId, f);
  return f;
}

async function readSlice(file, start, length) {
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

function parseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function scanLines(lines, meta, fromEnd) {
  const order = fromEnd ? lines.slice().reverse() : lines;
  for (const l of order) {
    if (!l) continue;
    if (!meta.customTitle && l.includes('"custom-title"')) {
      const d = parseJson(l);
      if (d && d.type === 'custom-title' && d.customTitle) meta.customTitle = d.customTitle;
    } else if (!meta.aiTitle && l.includes('"ai-title"')) {
      const d = parseJson(l);
      if (d && d.type === 'ai-title' && d.aiTitle) meta.aiTitle = d.aiTitle;
    } else if (!meta.lastPrompt && l.includes('"last-prompt"')) {
      const d = parseJson(l);
      if (d && d.type === 'last-prompt' && d.lastPrompt) meta.lastPrompt = String(d.lastPrompt).slice(0, 400);
    }
    if (!meta.cwd && l.includes('"cwd"')) {
      const d = parseJson(l);
      if (d && typeof d.cwd === 'string') {
        meta.cwd = d.cwd;
        meta.entrypoint = d.entrypoint || null;
      }
    }
  }
}

// maxAgeMs : pour une session en plein travail, le transcript change sans arrêt ; on ne le relit
// qu'au plus toutes les maxAgeMs.
async function transcriptMeta(file, maxAgeMs = 0) {
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return null;
  }
  const cached = metaCache.get(file);
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.meta;
  if (cached && maxAgeMs && Date.now() - cached.readAt < maxAgeMs) return cached.meta;

  const meta = { mtimeMs: st.mtimeMs, customTitle: null, aiTitle: null, lastPrompt: null, cwd: null, entrypoint: null };
  try {
    const start = Math.max(0, st.size - TAIL_BYTES);
    const lines = (await readSlice(file, start, st.size - start)).split('\n');
    if (start > 0) lines.shift(); // première ligne coupée en deux
    scanLines(lines, meta, true);
    if (start > 0 && (!meta.cwd || !(meta.aiTitle || meta.customTitle))) {
      const head = (await readSlice(file, 0, Math.min(HEAD_BYTES, st.size))).split('\n');
      head.pop();
      scanLines(head, meta, false);
    }
  } catch {
    return cached ? cached.meta : null;
  }
  // Ce qui n'apparaît plus dans la fin du fichier reste valable.
  if (cached) {
    for (const k of ['customTitle', 'aiTitle', 'lastPrompt', 'cwd', 'entrypoint']) if (!meta[k]) meta[k] = cached.meta[k];
  }
  metaCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, readAt: Date.now(), meta });
  return meta;
}

// Tous les transcripts présents sur le disque (Claude Code les garde 30 jours), du plus récent au plus ancien.
async function listTranscripts() {
  let dirs;
  try {
    dirs = await fsp.readdir(PROJECTS_DIR);
  } catch {
    return [];
  }
  const files = [];
  for (const d of dirs) {
    const dir = path.join(PROJECTS_DIR, d);
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const f = path.join(dir, n);
      const sessionId = n.slice(0, -6);
      pathIndex.set(sessionId, f);
      try {
        const st = await fsp.stat(f);
        files.push({ sessionId, file: f, mtimeMs: st.mtimeMs });
      } catch {
        // supprimé entre-temps
      }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

const isIgnoredCwd = (cwd) => !!cwd && IGNORED_CWD.some((r) => r.test(cwd));

// Conversations interactives reprenables (pas de claude -p / SDK, pas de sous-agent ni de scratchpad).
async function describeTranscripts(files, max = Infinity) {
  const out = [];
  for (const x of files) {
    if (out.length >= max) break;
    const meta = await transcriptMeta(x.file);
    if (!meta) continue;
    if (meta.entrypoint && meta.entrypoint !== 'cli') continue;
    if (!meta.lastPrompt && !meta.aiTitle && !meta.customTitle) continue;
    if (isIgnoredCwd(meta.cwd)) continue;
    out.push({ sessionId: x.sessionId, file: x.file, ...meta });
  }
  return out;
}

// Sessions dont le transcript a bougé dans les `days` derniers jours (qu'elles tournent encore ou non).
async function recentTranscripts(days, max = 60) {
  const cutoff = Date.now() - days * 86400000;
  return describeTranscripts((await listTranscripts()).filter((x) => x.mtimeMs >= cutoff), max);
}

// --- Historique des prompts (~/.claude/history.jsonl, en ajout seul) : lu de façon incrémentale ---------

const HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');
const history = { offset: 0, bySession: new Map() };

async function readHistory() {
  let st;
  try {
    st = await fsp.stat(HISTORY_FILE);
  } catch {
    return history.bySession;
  }
  if (st.size < history.offset) {
    history.offset = 0;
    history.bySession = new Map();
  }
  if (st.size === history.offset) return history.bySession;
  const text = await readSlice(HISTORY_FILE, history.offset, st.size - history.offset);
  const end = text.lastIndexOf('\n');
  if (end < 0) return history.bySession;
  const chunk = text.slice(0, end);
  history.offset += Buffer.byteLength(chunk, 'utf8') + 1;
  for (const line of chunk.split('\n')) {
    const d = parseJson(line);
    if (!d || !d.sessionId || !d.display) continue;
    let e = history.bySession.get(d.sessionId);
    if (!e) {
      e = { project: d.project || null, prompts: [] };
      history.bySession.set(d.sessionId, e);
    }
    e.prompts.push({ text: String(d.display).slice(0, 2000), ts: Number(d.timestamp) || 0 });
  }
  return history.bySession;
}

// --- Texte des réponses de Claude, pour la recherche (≈ 2 Mo pour 200 conversations) -----------------------

const ANSWERS_MAX = 400 * 1024;
const answersCache = new Map(); // fichier -> { size, mtimeMs, text }

async function answersText(file) {
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return '';
  }
  const cached = answersCache.get(file);
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.text;
  let text = '';
  try {
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const l of rl) {
      if (!l.includes('"type":"assistant"')) continue;
      const d = parseJson(l);
      if (!d || d.type !== 'assistant' || d.isSidechain) continue;
      const content = d.message && d.message.content;
      for (const b of Array.isArray(content) ? content : []) if (b.type === 'text' && b.text) text += `${b.text}\n`;
    }
  } catch {
    return cached ? cached.text : '';
  }
  if (text.length > ANSWERS_MAX) text = text.slice(-ANSWERS_MAX);
  answersCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, text });
  return text;
}

// --- Aperçu d'une conversation : tes prompts, les réponses de Claude et un résumé des outils utilisés -------

const PREVIEW_BYTES = 3 * 1024 * 1024;
const MESSAGE_MAX = 6000;
const SKIPPED_TAGS = /^<(local-command-std(out|err)|system-reminder|bash-std(out|err)|command-message|task-notification)/;

function clip(s) {
  return s.length > MESSAGE_MAX ? `${s.slice(0, MESSAGE_MAX)}\n…` : s;
}

function userText(content) {
  let s;
  if (typeof content === 'string') s = content;
  else if (Array.isArray(content)) {
    if (content.some((b) => b.type === 'tool_result')) return '';
    s = content.map((b) => (b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n');
  } else return '';
  s = String(s || '').trim();
  const cmd = s.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmd) {
    const args = (s.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1];
    return `${cmd[1].trim()}${args && args.trim() ? ` ${args.trim()}` : ''}`;
  }
  const bash = s.match(/^<bash-input>([\s\S]*?)<\/bash-input>/);
  if (bash) return `! ${bash[1].trim()}`;
  if (SKIPPED_TAGS.test(s)) return '';
  return clip(s);
}

async function conversationPreview(file, max = 60) {
  const st = await fsp.stat(file);
  const start = Math.max(0, st.size - PREVIEW_BYTES);
  const lines = (await readSlice(file, start, st.size - start)).split('\n');
  if (start > 0) lines.shift();
  const out = [];
  let tools = null;
  const flushTools = () => {
    if (tools) out.push({ role: 'tools', total: tools.total, names: tools.names });
    tools = null;
  };
  for (const l of lines) {
    if (!l || !(l.includes('"type":"user"') || l.includes('"type":"assistant"'))) continue;
    const d = parseJson(l);
    if (!d || d.isSidechain || (d.type !== 'user' && d.type !== 'assistant')) continue;
    const ts = Date.parse(d.timestamp) || null;
    const content = d.message && d.message.content;
    if (d.type === 'user') {
      if (d.isMeta) continue;
      const text = userText(content);
      if (!text) continue;
      flushTools();
      out.push({ role: 'user', text, ts });
      continue;
    }
    for (const b of Array.isArray(content) ? content : []) {
      if (b.type === 'text' && b.text && b.text.trim()) {
        flushTools();
        out.push({ role: 'claude', text: clip(b.text.trim()), ts });
      } else if (b.type === 'tool_use') {
        tools = tools || { total: 0, names: {} };
        tools.total += 1;
        tools.names[b.name] = (tools.names[b.name] || 0) + 1;
      }
    }
  }
  flushTools();
  return { messages: out.slice(-max), truncated: start > 0 || out.length > max };
}

// --- Agents en arrière-plan ----------------------------------------------------

function resolveClaudeBin() {
  const local = path.join(os.homedir(), '.local', 'bin', 'claude');
  return fs.existsSync(local) ? local : 'claude';
}

async function backgroundAgents(env) {
  const { err, stdout } = await run(resolveClaudeBin(), ['agents', '--json'], { cwd: os.tmpdir(), env });
  if (err) return null;
  const list = parseJson(stdout);
  return Array.isArray(list) ? list.filter((a) => a.kind === 'background') : null;
}

// --- Terminal hôte d'une session lancée hors de l'appli ---------------------------

// Remonte les processus parents jusqu'à la première application .app (Terminal, iTerm2, VS Code…).
async function hostAppOf(pid) {
  let cur = pid;
  for (let i = 0; i < 15 && cur > 1; i++) {
    const { stdout } = await run('/bin/ps', ['-o', 'ppid=,comm=', '-p', String(cur)]);
    const m = stdout.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) return null;
    const app = m[2].match(/^(.*?\.app)\//);
    if (app) return app[1];
    cur = Number(m[1]);
  }
  return null;
}

const FOCUS_TERMINAL = `on run argv
  set targetTty to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is targetTty then
          set miniaturized of w to false
          set selected tab of w to t
          set index of w to 1
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "notfound"
end run`;

const FOCUS_ITERM = `on run argv
  set targetTty to item 1 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if tty of s is targetTty then
            select s
            select t
            select w
            activate
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "notfound"
end run`;

async function focusExternal(pid, tty) {
  const app = await hostAppOf(pid);
  const appName = app ? path.basename(app, '.app') : null;
  if (tty && appName === 'Terminal') {
    const { stdout } = await run('/usr/bin/osascript', ['-e', FOCUS_TERMINAL, tty]);
    if (stdout.trim() === 'ok') return { ok: true, appName };
  }
  if (tty && appName && /^iTerm/.test(appName)) {
    const { stdout } = await run('/usr/bin/osascript', ['-e', FOCUS_ITERM, tty]);
    if (stdout.trim() === 'ok') return { ok: true, appName };
  }
  if (app) {
    await run('/usr/bin/open', ['-a', app]);
    return { ok: true, appName, approximate: true };
  }
  return { ok: false, appName: null };
}

// Arrêt propre : Claude Code gère SIGTERM (sortie en ~1 s, entrée de registre nettoyée).
async function terminate(pid, timeoutMs = 8000) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return !isAlive(pid);
  }
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    await sleep(150);
    if (!isAlive(pid)) return true;
  }
  return false;
}

module.exports = {
  REGISTRY_DIR,
  isAlive,
  readRegistry,
  processInfo,
  transcriptFile,
  transcriptMeta,
  listTranscripts,
  describeTranscripts,
  recentTranscripts,
  readHistory,
  answersText,
  conversationPreview,
  backgroundAgents,
  hostAppOf,
  focusExternal,
  terminate,
};
