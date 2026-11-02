// Renders brand/mark.svg to a 1024px transparent PNG (build/mark.png); scripts/android-assets.py
// then makes the Android launcher icons and splash screens from it and build/icon.png.
// Run: npx electron scripts/android-assets.js && python scripts/android-assets.py
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '..', 'brand', 'mark.svg'), 'utf8');
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, useContentSize: true });
  await win.loadURL('data:text/html,' + encodeURIComponent(
    `<html><body style="margin:0;background:transparent;overflow:hidden">${svg.replace('<svg ', '<svg width="1024" height="1024" ')}</body></html>`));
  await new Promise(r => setTimeout(r, 400));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'mark.png'), img.resize({ width: 1024, height: 1024 }).toPNG());
  app.quit();
});
