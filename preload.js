'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const EVENTS = [
  'deck:items',
  'deck:select',
  'deck:command',
  'deck:config',
  'deck:update',
  'deck:usage',
  'deck:bridge',
  'pty:created',
  'pty:data',
  'pty:exit',
];

contextBridge.exposeInMainWorld('deck', {
  init: () => ipcRenderer.invoke('deck:init'),
  newSession: () => ipcRenderer.invoke('deck:new'),
  newSessionInFolder: () => ipcRenderer.invoke('deck:newInFolder'),
  resume: (sessionId, opts) => ipcRenderer.invoke('deck:resume', sessionId, opts),
  search: (query) => ipcRenderer.invoke('deck:search', query),
  preview: (sessionId) => ipcRenderer.invoke('deck:preview', sessionId),
  archive: (ids) => ipcRenderer.invoke('deck:archive', ids),
  unarchive: (ids) => ipcRenderer.invoke('deck:unarchive', ids),
  resumeAll: (ids) => ipcRenderer.invoke('deck:resumeAll', ids),
  dismissLastOpen: () => ipcRenderer.send('deck:dismissLastOpen'),
  attach: (bgId) => ipcRenderer.invoke('deck:attach', bgId),
  relaunchHere: (ptyId) => ipcRenderer.invoke('deck:relaunchHere', ptyId),
  focusExternal: (sessionId) => ipcRenderer.invoke('deck:focusExternal', sessionId),
  adopt: (sessionId) => ipcRenderer.invoke('deck:adopt', sessionId),
  close: (ptyId) => ipcRenderer.invoke('deck:close', ptyId),
  select: (key) => ipcRenderer.send('deck:select', key),
  markSeen: (sessionId) => ipcRenderer.send('deck:markSeen', sessionId),
  setCollapsed: (group, value) => ipcRenderer.send('deck:collapsed', group, value),
  setFontSize: (size) => ipcRenderer.send('deck:fontSize', size),
  openExternal: (url) => ipcRenderer.send('deck:openExternal', url),
  openPath: (p) => ipcRenderer.send('deck:openPath', p),
  copy: (text) => ipcRenderer.send('deck:copy', text),
  checkUpdate: () => ipcRenderer.invoke('deck:checkUpdate'),
  stats: () => ipcRenderer.invoke('deck:stats'),
  perms: () => ipcRenderer.invoke('deck:perms'),
  settings: () => ipcRenderer.invoke('deck:settings'),
  setSettings: (patch) => ipcRenderer.invoke('deck:settings:set', patch),
  setLoginItem: (enable) => ipcRenderer.invoke('deck:loginItem', enable),
  recordingShortcut: (on) => ipcRenderer.send('deck:recordingShortcut', on),
  openConfigFile: () => ipcRenderer.send('deck:openConfigFile'),
  openDataDir: () => ipcRenderer.send('deck:openDataDir'),
  permAction: (action) => ipcRenderer.invoke('deck:permAction', action),
  setBridge: (enable) => ipcRenderer.invoke('deck:bridge', enable),
  dismissBridge: () => ipcRenderer.send('deck:bridgeDismiss'),
  installUpdate: () => ipcRenderer.send('deck:installUpdate'),
  openReleases: () => ipcRenderer.send('deck:openReleases'),
  ptyWrite: (id, data) => ipcRenderer.send('pty:write', id, data),
  ptyResize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
  ptyTitle: (id, title) => ipcRenderer.send('pty:title', id, title),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  on: (channel, fn) => {
    if (!EVENTS.includes(channel)) return () => {};
    const handler = (_e, ...args) => fn(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
