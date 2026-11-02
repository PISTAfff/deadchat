// Renders brand/icon.svg to build/icon.png (1024px) for the exe and window icon.
// Run: npx electron brand/render-icon.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'), 'utf8');
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, useContentSize: true });
  await win.loadURL('data:text/html,' + encodeURIComponent(
    `<html><body style="margin:0;background:transparent;overflow:hidden">${svg.replace('<svg ', '<svg width="1024" height="1024" ')}</body></html>`));
  await new Promise(r => setTimeout(r, 400));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), img.resize({ width: 1024, height: 1024 }).toPNG());
  app.quit();
});
