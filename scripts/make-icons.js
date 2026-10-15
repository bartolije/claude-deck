'use strict';
// Génère assets/icon.png (1024 px) et l'icône de barre des menus (template) en rendant du SVG
// dans une fenêtre hors écran. Lancer avec : npx electron scripts/make-icons.js

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'assets');

const APP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2a303b"/>
      <stop offset="1" stop-color="#111317"/>
    </linearGradient>
    <filter id="sh" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="16" stdDeviation="20" flood-color="#000" flood-opacity="0.35"/>
    </filter>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#bg)" filter="url(#sh)"/>
  <rect x="102" y="102" width="820" height="820" rx="184" fill="none" stroke="#fff" stroke-opacity="0.09" stroke-width="4"/>
  <rect x="200" y="270" width="624" height="136" rx="68" fill="#fff" fill-opacity="0.12"/>
  <circle cx="276" cy="338" r="36" fill="#f5a524"/>
  <rect x="346" y="320" width="392" height="36" rx="18" fill="#e7e9ee" fill-opacity="0.9"/>
  <rect x="200" y="444" width="624" height="136" rx="68" fill="#fff" fill-opacity="0.05"/>
  <circle cx="276" cy="512" r="36" fill="#4f8cff"/>
  <rect x="346" y="494" width="300" height="36" rx="18" fill="#e7e9ee" fill-opacity="0.55"/>
  <rect x="200" y="618" width="624" height="136" rx="68" fill="#fff" fill-opacity="0.05"/>
  <circle cx="276" cy="686" r="36" fill="#2ec27e"/>
  <rect x="346" y="668" width="348" height="36" rx="18" fill="#e7e9ee" fill-opacity="0.55"/>
</svg>`;

// Icône « template » : seule l'opacité compte, macOS la colore selon le thème de la barre des menus.
const TRAY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">
  <circle cx="7" cy="8" r="3.6" fill="#000"/>
  <rect x="14" y="6" width="17" height="4" rx="2" fill="#000"/>
  <circle cx="7" cy="18" r="3.6" fill="#000"/>
  <rect x="14" y="16" width="13" height="4" rx="2" fill="#000"/>
  <circle cx="7" cy="28" r="3.6" fill="#000"/>
  <rect x="14" y="26" width="15" height="4" rx="2" fill="#000"/>
</svg>`;

// Une seule fenêtre et une seule page : l'icône 1024 px à gauche, l'icône de barre des menus à droite.
async function renderAll() {
  const win = new BrowserWindow({
    width: 1024 + 36,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  });
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden;display:flex;align-items:flex-start">${APP_SVG}${TRAY_SVG}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 500));
  const icon = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  const tray = await win.webContents.capturePage({ x: 1024, y: 0, width: 36, height: 36 });
  win.destroy();
  return { icon, tray };
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { icon, tray } = await renderAll();
  fs.writeFileSync(path.join(OUT, 'icon.png'), icon.resize({ width: 1024, height: 1024 }).toPNG());
  fs.writeFileSync(path.join(OUT, 'trayTemplate@2x.png'), tray.resize({ width: 36, height: 36 }).toPNG());
  fs.writeFileSync(path.join(OUT, 'trayTemplate.png'), tray.resize({ width: 18, height: 18, quality: 'best' }).toPNG());
  console.log('icônes générées dans', OUT);
  app.quit();
});
