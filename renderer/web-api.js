'use strict';
/* global fflate, Capacitor */
// Phone/web backend. The desktop app gets `window.api` from preload.js (Electron); everywhere else
// this file provides the same API on top of IndexedDB, so app.js runs unchanged on Android.
(() => {
  if (window.api) return;
  const DC = window.DeadChat;
  const native = !!(window.Capacitor && Capacitor.isNativePlatform && Capacitor.isNativePlatform());
  const plugin = name => native && Capacitor.Plugins && Capacitor.Plugins[name];
  document.documentElement.classList.add('web');

  // ---------- IndexedDB ----------
  let dbp;
  const db = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('deadchat', 1);
    r.onupgradeneeded = () => ['chats', 'media', 'avatars'].forEach(s => r.result.createObjectStore(s));
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const wrap = q => new Promise((res, rej) => { q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  async function run(store, mode, fn) {
    const t = (await db()).transaction(store, mode);
    const out = fn(t.objectStore(store));
    await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('Storage is full')); });
    return out instanceof IDBRequest ? out.result : out;
  }
  const get = (s, k) => run(s, 'readonly', st => st.get(k));
  const put = (s, k, v) => run(s, 'readwrite', st => { st.put(v, k); });
  const del = (s, k) => run(s, 'readwrite', st => { st.delete(k); });
  const keys = s => run(s, 'readonly', st => st.getAllKeys());

  // ---------- media served by sw.js ----------
  const ready = (async () => {
    try { await navigator.storage?.persist?.(); } catch { /* best effort */ }
    if (!('serviceWorker' in navigator)) throw new Error('This browser cannot show media offline.');
    await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise(r => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
    }
  })();
  const mediaBase = id => new URL(`dcmedia/${id}/`, location.href).href;
  const avatarUrl = (id, chat) => chat.avatar ? new URL(`dcavatar/${id}?v=${chat.avatarAt || 0}`, location.href).href : null;
  const TYPES = { opus: 'audio/ogg', ogg: 'audio/ogg', m4a: 'audio/mp4', mp3: 'audio/mpeg', aac: 'audio/aac', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', '3gp': 'video/3gpp', pdf: 'application/pdf' };
  const typeOf = f => TYPES[(f.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

  // ---------- picking files ----------
  const picked = new Map();
  let pickN = 0;
  function pickFile(accept) {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = accept;
      input.addEventListener('change', () => resolve(input.files[0] || null), { once: true });
      input.addEventListener('cancel', () => resolve(null), { once: true });
      input.click();
    });
  }

  async function readSource(token) {
    const file = picked.get(token);
    if (!file) throw new Error('Pick the file again.');
    if (/\.txt$/i.test(file.name) || file.type === 'text/plain') {
      return { name: file.name.replace(/\.txt$/i, ''), text: await file.text(), files: {} };
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const files = fflate.unzipSync(bytes, { filter: f => !f.name.endsWith('/') });
    const names = Object.keys(files);
    const txt = names.filter(n => /\.txt$/i.test(n));
    const chatName = txt.find(n => /WhatsApp Chat/i.test(n)) || txt[0];
    if (!chatName) throw new Error('No chat .txt file found inside this zip.');
    const byBase = {};
    for (const n of names) if (n !== chatName) byBase[n.split('/').pop()] = files[n];
    return { name: chatName.split('/').pop().replace(/\.txt$/i, ''), text: new TextDecoder('utf-8').decode(files[chatName]), files: byBase };
  }

  // ---------- saving files out (Android share sheet, or a download on the web) ----------
  async function saveOut(blob, name) {
    const fs = plugin('Filesystem'), share = plugin('Share');
    if (!fs || !share) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      return name;
    }
    const path = name.replace(/[\\/:*?"<>|]/g, '_');
    const CHUNK = 3 * 1024 * 1024; // multiple of 3 keeps base64 chunks joinable
    for (let off = 0; off < blob.size || off === 0; off += CHUNK) {
      const buf = new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer());
      let bin = ''; for (let k = 0; k < buf.length; k += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(k, k + 0x8000));
      const data = btoa(bin);
      if (off === 0) await fs.writeFile({ path, data, directory: 'CACHE' });
      else await fs.appendFile({ path, data, directory: 'CACHE' });
      if (blob.size === 0) break;
    }
    const { uri } = await fs.getUri({ path, directory: 'CACHE' });
    await share.share({ title: name, files: [uri] });
    return name;
  }

  // ---------- the API (same shape as preload.js) ----------
  const api = {
    async listChats() {
      await ready;
      const out = [];
      for (const id of await keys('chats')) {
        const c = await get('chats', id);
        const last = c.messages[c.messages.length - 1];
        out.push({ id, title: c.title, count: c.messages.length, lastTime: last ? last.t : 0, avatar: avatarUrl(id, c),
          lastText: last ? (last.x || (last.a ? last.a.k : last.o ? 'media' : '')) : '' });
      }
      return out.sort((a, b) => b.lastTime - a.lastTime);
    },
    async getChat(id) {
      await ready;
      const c = await get('chats', id);
      if (!c) throw new Error('Chat not found.');
      return { ...c, mediaBase: mediaBase(id), avatarUrl: avatarUrl(id, c) };
    },
    async setProfile(id, { contactName, bio } = {}) {
      const c = await get('chats', id);
      if (contactName !== undefined) c.contactName = String(contactName).trim().slice(0, 80) || undefined;
      if (bio !== undefined) c.bio = String(bio).trim().slice(0, 700) || undefined;
      await put('chats', id, c);
      return { contactName: c.contactName || null, bio: c.bio || null };
    },
    async renameChat(id, title) { const c = await get('chats', id); c.title = title; await put('chats', id, c); return true; },
    async setMe(id, me) { const c = await get('chats', id); c.me = me; await put('chats', id, c); return true; },
    async setAvatar(id) {
      const file = await pickFile('image/*');
      if (!file) return null;
      const c = await get('chats', id);
      await put('avatars', id, file);
      c.avatar = true; c.avatarAt = Date.now();
      await put('chats', id, c);
      return avatarUrl(id, c);
    },
    async deleteChat(id) {
      const c = await get('chats', id);
      if (!confirm(`Remove "${c.title}" from DeadChat?\nThis deletes the app's imported copy only.`)) return false;
      const prefix = id + '/';
      await run('media', 'readwrite', st => st.delete(IDBKeyRange.bound(prefix, prefix + '￿')));
      await del('avatars', id);
      await del('chats', id);
      return true;
    },
    async writeMessage(id, text) {
      const c = await get('chats', id);
      if (c.me < 0) throw new Error('Choose which side is you first (chat menu → Switch which side is me).');
      const n = new Date();
      const t = Date.UTC(n.getFullYear(), n.getMonth(), n.getDate(), n.getHours(), n.getMinutes(), n.getSeconds());
      const msg = { t, s: c.me, x: text, u: 1, id: Math.random().toString(16).slice(2, 12) };
      c.messages.push(msg);
      await put('chats', id, c);
      return msg;
    },
    async unwriteMessage(id, msgId) {
      const c = await get('chats', id);
      const n = c.messages.length;
      c.messages = c.messages.filter(m => !(m.u && m.id === msgId));
      await put('chats', id, c);
      return n !== c.messages.length;
    },
    async exportChat(id, { includeMedia = true, includeUndelivered = true } = {}) {
      const c = await get('chats', id);
      const have = new Set((await keys('media')).filter(k => k.startsWith(id + '/')).map(k => k.slice(id.length + 1)));
      const { text, files, lines } = DC.exportText(c, { includeMedia, includeUndelivered, hasFile: f => have.has(f) });
      const entries = { [`WhatsApp Chat with ${c.title}.txt`]: new TextEncoder().encode(text) };
      for (const f of files) entries[f] = [new Uint8Array(await (await get('media', `${id}/${f}`)).arrayBuffer()), { level: 0 }];
      const zip = new Blob([fflate.zipSync(entries)], { type: 'application/zip' });
      const name = await saveOut(zip, `WhatsApp Chat with ${c.title}.zip`);
      return { messages: lines, media: files.length, file: name };
    },
    async pickSource() {
      // no type filter: Android's picker often hides zips otherwise; the type is checked after picking
      const file = await pickFile('');
      if (file && !/\.(zip|txt)$/i.test(file.name)) throw new Error('Pick the .zip or .txt that WhatsApp exported.');
      if (!file) return null;
      const token = 'pick' + (++pickN);
      picked.set(token, file);
      return token;
    },
    async previewSource(token, chatId) {
      await ready;
      const src = await readSource(token);
      const p = DC.parseChat(src.text);
      const ts = p.messages.map(m => m.t);
      const pv = {
        name: src.name, senders: p.senders, counts: p.senders.map((_, i) => p.messages.filter(m => m.s === i).length),
        total: p.messages.length, from: ts.length ? Math.min(...ts) : null, to: ts.length ? Math.max(...ts) : null,
        attachments: p.messages.filter(m => m.a).length, omitted: p.messages.filter(m => m.o).length,
      };
      if (chatId) pv.suggested = DC.suggestMapping(pv.senders, (await get('chats', chatId)).participants);
      return pv;
    },
    async runImport(token, opts) {
      const src = await readSource(token);
      const parsed = DC.parseChat(src.text);
      let id = opts.chatId, chat;
      if (id) chat = await get('chats', id);
      else {
        id = Math.random().toString(16).slice(2, 14);
        chat = { title: opts.title || src.name, participants: [], me: -1, messages: [], sources: [] };
      }
      const map = parsed.senders.map((name, i) => {
        let target = opts.mapping ? opts.mapping[i] : -1;
        if (target == null || target < 0) { target = chat.participants.length; chat.participants.push({ name }); }
        return target;
      });
      if (opts.meIndex != null && opts.meIndex >= 0) chat.me = map[opts.meIndex];
      for (const m of parsed.messages) if (m.s >= 0) m.s = map[m.s];
      const { messages, stats } = DC.mergeMessages(chat.messages, parsed.messages);
      chat.messages = messages;

      const have = new Set((await keys('media')).filter(k => k.startsWith(id + '/')).map(k => k.slice(id.length + 1)));
      let copied = 0, missing = 0;
      for (const m of chat.messages) {
        if (!m.a) continue;
        if (!have.has(m.a.f) && src.files[m.a.f]) {
          await put('media', `${id}/${m.a.f}`, new Blob([src.files[m.a.f]], { type: typeOf(m.a.f) }));
          have.add(m.a.f); copied++;
        }
        if (have.has(m.a.f)) delete m.a.missing; else { m.a.missing = 1; missing++; }
      }
      chat.sources.push({ name: src.name, importedAt: Date.now(), ...stats });
      await put('chats', id, chat);
      picked.delete(token);
      return { id, ...stats, copied, missing, total: chat.messages.length };
    },
    async openMedia(chatId, file) {
      const blob = await get('media', `${chatId}/${file}`);
      if (!blob) throw new Error('That file is not in DeadChat.');
      return saveOut(blob, file);
    },
    async openLink(url) { if (/^https?:\/\//i.test(url)) window.open(url, '_blank'); return true; },
    async copyText(text) { await navigator.clipboard.writeText(String(text)); return true; },
  };
  window.api = api;

  // Android back button: let the app step back one screen at a time.
  const app = plugin('App');
  if (app) app.addListener('backButton', () => window.dispatchEvent(new CustomEvent('dc-back')));
})();
