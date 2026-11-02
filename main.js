'use strict';
const { app, BrowserWindow, ipcMain, dialog, session, shell, clipboard } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const { Store, suggestMapping } = require('./src/importer');

let store, win;

// Dev/testing only: keep test data away from the real library.
if (process.env.DEADCHAT_DATA) app.setPath('userData', process.env.DEADCHAT_DATA);

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 760, minHeight: 520,
    backgroundColor: '#0b141a',
    title: 'DeadChat',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Never navigate away or open windows from the page itself.
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

app.whenReady().then(() => {
  // Offline by construction: the app makes no network requests at all.
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    cb({ cancel: !/^(file|devtools|data|blob):/i.test(details.url) });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  store = new Store(path.join(app.getPath('userData'), 'library'));
  createWindow();
});

app.on('window-all-closed', () => app.quit());

const handle = (name, fn) => ipcMain.handle(name, async (_e, ...args) => {
  try { return { ok: true, value: await fn(...args) }; }
  catch (err) { return { ok: false, error: err.message || String(err) }; }
});

handle('chats:list', () => store.listChats());
handle('chats:get', id => {
  const chat = store.readChat(id);
  chat.mediaBase = pathToFileURL(path.join(store.chatDir(id), 'media') + path.sep).href;
  chat.avatarUrl = store.avatarUrl(id, chat);
  return chat;
});
handle('chats:rename', (id, title) => {
  const c = store.readChat(id); c.title = title; store.writeChat(id, c); return true;
});
handle('chats:setProfile', (id, fields) => store.setProfile(id, fields));
handle('chats:setAvatar', async id => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }] });
  return r.canceled ? null : store.setAvatar(id, r.filePaths[0]);
});
handle('chats:setMe', (id, me) => {
  const c = store.readChat(id); c.me = me; store.writeChat(id, c); return true;
});
handle('chats:delete', async id => {
  const c = store.readChat(id);
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['Cancel', 'Remove from DeadChat'], defaultId: 0, cancelId: 0,
    message: `Remove "${c.title}" from DeadChat?`,
    detail: 'This deletes the app\'s imported copy only. Your original export files are not touched.',
  });
  if (response !== 1) return false;
  store.deleteChat(id);
  return true;
});

handle('chats:write', (id, text) => store.addLocalMessage(id, text));
handle('chats:unwrite', (id, msgId) => store.deleteLocalMessage(id, msgId));
handle('chats:export', async (id, opts) => {
  const c = store.readChat(id);
  const r = await dialog.showSaveDialog(win, {
    title: 'Export chat',
    defaultPath: path.join(app.getPath('documents'), `WhatsApp Chat with ${c.title.replace(/[\\/:*?"<>|]/g, '_')}.zip`),
    filters: [{ name: 'WhatsApp export', extensions: ['zip'] }],
  });
  if (r.canceled) return null;
  const out = store.exportChat(id, r.filePath, opts);
  shell.showItemInFolder(out.file);
  return out;
});

handle('import:pick', async kind => {
  const opts = kind === 'folder'
    ? { properties: ['openDirectory'] }
    : { properties: ['openFile'], filters: [{ name: 'WhatsApp export', extensions: ['zip', 'txt'] }] };
  const r = await dialog.showOpenDialog(win, opts);
  return r.canceled ? null : r.filePaths[0];
});
handle('import:preview', (src, chatId) => {
  const pv = store.preview(src);
  if (chatId) pv.suggested = suggestMapping(pv.senders, store.readChat(chatId).participants);
  return pv;
});
handle('import:run', (src, opts) => store.importSource(src, opts));


// Local files open in their default app. Web links only on an explicit click, in the system browser.
handle('open:media', (chatId, file) => {
  const p = path.join(store.chatDir(chatId), 'media', path.basename(file));
  return shell.openPath(p);
});
handle('open:link', url => {
  if (!/^https?:\/\//i.test(url)) return false;
  return shell.openExternal(url);
});
handle('clip:write', text => clipboard.writeText(String(text)));
