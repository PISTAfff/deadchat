'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = async (name, ...args) => {
  const r = await ipcRenderer.invoke(name, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

contextBridge.exposeInMainWorld('api', {
  listChats: () => call('chats:list'),
  getChat: id => call('chats:get', id),
  renameChat: (id, title) => call('chats:rename', id, title),
  setMe: (id, me) => call('chats:setMe', id, me),
  setAvatar: id => call('chats:setAvatar', id),
  setProfile: (id, fields) => call('chats:setProfile', id, fields),
  deleteChat: id => call('chats:delete', id),
  writeMessage: (id, text) => call('chats:write', id, text),
  attachFiles: id => call('local:attach', id),
  sendVoice: (id, bytes) => call('local:voice', id, bytes),
  listStickers: () => call('stickers:list'),
  readMedia: (id, f) => call('media:read', id, f),
  sendSticker: (id, fromChatId, f) => call('local:sticker', id, fromChatId, f),
  unwriteMessage: (id, msgId) => call('chats:unwrite', id, msgId),
  exportChat: (id, opts) => call('chats:export', id, opts),
  pickSource: kind => call('import:pick', kind),
  previewSource: (src, chatId) => call('import:preview', src, chatId),
  runImport: (src, opts) => call('import:run', src, opts),
  openMedia: (chatId, file) => call('open:media', chatId, file),
  openLink: url => call('open:link', url),
  copyText: text => call('clip:write', text),
});
