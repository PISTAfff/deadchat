'use strict';
// Reads an export (zip, folder or .txt), merges it into a stored chat, and copies the media it references.
// Source files are only ever read, never modified.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const AdmZip = require('adm-zip');
const { parseChat } = require('../renderer/shared/parser');
const { suggestMapping, mergeMessages, exportText } = require('../renderer/shared/core');

// ---------- reading sources ----------

function walk(dir, map, depth = 0) {
  if (depth > 6) return;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, map, depth + 1);
    else if (!map.has(ent.name)) map.set(ent.name, p);
  }
}

/** Returns { name, text, media: { has(name), copyTo(name, dest) } } */
function openSource(srcPath) {
  const stat = fs.statSync(srcPath);
  if (stat.isFile() && /\.zip$/i.test(srcPath)) {
    const zip = new AdmZip(srcPath);
    const entries = zip.getEntries().filter(e => !e.isDirectory);
    const txts = entries.filter(e => /\.txt$/i.test(e.entryName));
    const chatEntry = txts.find(e => /WhatsApp Chat/i.test(e.entryName)) || txts[0];
    if (!chatEntry) throw new Error('No chat .txt file found inside this zip.');
    const byName = new Map(entries.map(e => [path.basename(e.entryName), e]));
    return {
      name: path.basename(chatEntry.entryName, '.txt'),
      text: chatEntry.getData().toString('utf8'),
      media: {
        has: n => byName.has(n),
        copyTo: (n, dest) => fs.writeFileSync(dest, byName.get(n).getData()),
      },
    };
  }
  let txtPath = srcPath, dir = srcPath;
  if (stat.isDirectory()) {
    const txts = fs.readdirSync(srcPath).filter(f => /\.txt$/i.test(f));
    const pick = txts.find(f => /WhatsApp Chat|chat/i.test(f)) || txts[0];
    if (!pick) throw new Error('No chat .txt file found in this folder.');
    txtPath = path.join(srcPath, pick);
  } else {
    dir = path.dirname(srcPath);
  }
  const files = new Map();
  walk(dir, files);
  return {
    name: path.basename(txtPath, '.txt'),
    text: fs.readFileSync(txtPath, 'utf8'),
    media: {
      has: n => files.has(n),
      copyTo: (n, dest) => fs.copyFileSync(files.get(n), dest),
    },
  };
}

// ---------- store ----------

class Store {
  constructor(root) {
    this.root = root;
    this.chatsDir = path.join(root, 'chats');
    fs.mkdirSync(this.chatsDir, { recursive: true });
  }

  listChats() {
    return fs.readdirSync(this.chatsDir)
      .filter(id => fs.existsSync(path.join(this.chatsDir, id, 'chat.json')))
      .map(id => {
        const c = this.readChat(id);
        const last = c.messages[c.messages.length - 1];
        return { id, title: c.title, count: c.messages.length, lastTime: last ? last.t : 0, avatar: this.avatarUrl(id, c),
          lastText: last ? (last.x || (last.a ? last.a.k : last.o ? 'media' : '')) : '' };
      })
      .sort((a, b) => b.lastTime - a.lastTime);
  }

  chatDir(id) { return path.join(this.chatsDir, id); }

  avatarUrl(id, chat) {
    if (!chat.avatar) return null;
    const p = path.join(this.chatDir(id), chat.avatar);
    return fs.existsSync(p) ? pathToFileURL(p).href + '?v=' + (chat.avatarAt || 0) : null;
  }

  /** Saves the editable contact details shown in Contact info. */
  setProfile(id, { contactName, bio } = {}) {
    const chat = this.readChat(id);
    if (contactName !== undefined) chat.contactName = String(contactName).trim().slice(0, 80) || undefined;
    if (bio !== undefined) chat.bio = String(bio).trim().slice(0, 700) || undefined;
    this.writeChat(id, chat);
    return { contactName: chat.contactName || null, bio: chat.bio || null };
  }

  /** Copies an image in as the chat's profile photo. */
  setAvatar(id, file) {
    const chat = this.readChat(id);
    const name = 'avatar' + path.extname(file).toLowerCase();
    if (chat.avatar && chat.avatar !== name) fs.rmSync(path.join(this.chatDir(id), chat.avatar), { force: true });
    fs.copyFileSync(file, path.join(this.chatDir(id), name));
    chat.avatar = name;
    chat.avatarAt = Date.now();
    this.writeChat(id, chat);
    return this.avatarUrl(id, chat);
  }

  readChat(id) {
    return JSON.parse(fs.readFileSync(path.join(this.chatDir(id), 'chat.json'), 'utf8'));
  }

  writeChat(id, chat) {
    const file = path.join(this.chatDir(id), 'chat.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(chat));
    fs.renameSync(file + '.tmp', file);
  }

  deleteChat(id) {
    fs.rmSync(this.chatDir(id), { recursive: true, force: true });
  }

  /** Step 1 of an import: parse and describe the source without writing anything. */
  preview(srcPath) {
    const src = openSource(srcPath);
    const parsed = parseChat(src.text);
    const counts = parsed.senders.map((_, i) => parsed.messages.filter(m => m.s === i).length);
    const ts = parsed.messages.map(m => m.t);
    return {
      name: src.name, senders: parsed.senders, counts,
      total: parsed.messages.length,
      from: ts.length ? Math.min(...ts) : null, to: ts.length ? Math.max(...ts) : null,
      attachments: parsed.messages.filter(m => m.a).length,
      omitted: parsed.messages.filter(m => m.o).length,
    };
  }

  /**
   * Step 2: import. opts = { chatId?: existing id, title?, meIndex (incoming sender index that is "me"),
   *                          mapping?: incoming sender index -> existing participant index (-1 = new) }
   */
  importSource(srcPath, opts) {
    const src = openSource(srcPath);
    const parsed = parseChat(src.text);
    let id = opts.chatId, chat;
    if (id) {
      chat = this.readChat(id);
    } else {
      id = crypto.randomBytes(6).toString('hex');
      fs.mkdirSync(path.join(this.chatDir(id), 'media'), { recursive: true });
      chat = { title: opts.title || src.name, participants: [], me: -1, messages: [], sources: [] };
    }

    // map incoming sender indexes onto stored participants
    const map = parsed.senders.map((name, i) => {
      let target = opts.mapping ? opts.mapping[i] : -1;
      if (target == null || target < 0) {
        target = chat.participants.length;
        chat.participants.push({ name });
      }
      return target;
    });
    if (opts.meIndex != null && opts.meIndex >= 0) chat.me = map[opts.meIndex];
    for (const m of parsed.messages) if (m.s >= 0) m.s = map[m.s];

    const { messages, stats } = mergeMessages(chat.messages, parsed.messages);
    chat.messages = messages;

    // copy media referenced anywhere in the chat that we don't have yet
    const mediaDir = path.join(this.chatDir(id), 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    let copied = 0;
    for (const m of chat.messages) {
      if (!m.a) continue;
      const dest = path.join(mediaDir, m.a.f);
      if (fs.existsSync(dest)) continue;
      if (src.media.has(m.a.f)) { src.media.copyTo(m.a.f, dest); copied++; }
    }
    let missing = 0;
    for (const m of chat.messages) {
      if (!m.a) continue;
      const ok = fs.existsSync(path.join(mediaDir, m.a.f));
      if (ok) delete m.a.missing; else { m.a.missing = 1; missing++; }
    }
    chat.sources.push({ name: src.name, file: path.basename(srcPath), importedAt: Date.now(), ...stats });
    this.writeChat(id, chat);
    return { id, ...stats, copied, missing, total: chat.messages.length };
  }

  // ---------- never-delivered messages ----------

  /** Adds a message written in DeadChat. It is stored locally only and marked undelivered (u). */
  addLocalMessage(id, text, now = new Date()) {
    const chat = this.readChat(id);
    if (chat.me < 0) throw new Error('Choose which side is you first (chat menu → Switch which side is me).');
    // stored as wall-clock time, like imported messages
    const t = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds());
    const msg = { t, s: chat.me, x: text, u: 1, id: crypto.randomBytes(5).toString('hex') };
    chat.messages.push(msg);
    this.writeChat(id, chat);
    return msg;
  }

  deleteLocalMessage(id, msgId) {
    const chat = this.readChat(id);
    const before = chat.messages.length;
    const gone = chat.messages.find(m => m.u && m.id === msgId);
    chat.messages = chat.messages.filter(m => !(m.u && m.id === msgId));
    this.writeChat(id, chat);
    // a file sent from DeadChat goes with its message, unless something else still uses it
    if (gone && gone.a && !chat.messages.some(m => m.a && m.a.f === gone.a.f)) {
      fs.rmSync(path.join(this.chatDir(id), 'media', gone.a.f), { force: true });
    }
    return before !== chat.messages.length;
  }

  /** Adds an undelivered photo, video, file, voice note or sticker. `src` is a file path or a Buffer. */
  addLocalMedia(id, src, name, kind, now = new Date()) {
    const chat = this.readChat(id);
    if (chat.me < 0) throw new Error('Choose which side is you first (chat menu → Switch which side is me).');
    const pad = n => String(n).padStart(2, '0');
    const day = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const ext = (path.extname(name) || '.bin').toLowerCase();
    const prefix = kind === 'audio' && /^PTT-/.test(name) ? 'PTT' : kind === 'sticker' ? 'STK' : kind === 'image' ? 'IMG' : kind === 'video' ? 'VID' : 'DOC';
    const f = kind === 'document' ? `DC-${crypto.randomBytes(3).toString('hex')}-${path.basename(name)}` : `${prefix}-${day}-DC${crypto.randomBytes(3).toString('hex')}${ext}`;
    const dest = path.join(this.chatDir(id), 'media', f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (Buffer.isBuffer(src)) fs.writeFileSync(dest, src); else fs.copyFileSync(src, dest);
    const t = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds());
    const msg = { t, s: chat.me, x: '', a: { f, k: kind }, u: 1, id: crypto.randomBytes(5).toString('hex') };
    chat.messages.push(msg);
    this.writeChat(id, chat);
    return msg;
  }

  /** Every sticker in every imported chat (one of each file name). */
  listStickers() {
    const seen = new Map();
    for (const c of this.listChats()) {
      const chat = this.readChat(c.id);
      for (let k = chat.messages.length - 1; k >= 0; k--) {
        const m = chat.messages[k];
        if (!m.a || m.a.k !== 'sticker' || m.a.missing || seen.has(m.a.f)) continue;
        const p = path.join(this.chatDir(c.id), 'media', m.a.f);
        if (fs.existsSync(p)) seen.set(m.a.f, { chatId: c.id, f: m.a.f, url: pathToFileURL(p).href });
      }
    }
    return [...seen.values()];
  }

  addLocalSticker(id, fromChatId, f) {
    return this.addLocalMedia(id, path.join(this.chatDir(fromChatId), 'media', path.basename(f)), f, 'sticker');
  }

  // ---------- re-export ----------

  /** Writes the chat back out as a WhatsApp-style export zip (chat .txt + media). */
  exportChat(id, dest, { includeMedia = true, includeUndelivered = true } = {}) {
    const chat = this.readChat(id);
    const mediaDir = path.join(this.chatDir(id), 'media');
    const zip = new AdmZip();
    const { text, files, lines, skipped } = exportText(chat, {
      includeMedia, includeUndelivered,
      hasFile: f => fs.existsSync(path.join(mediaDir, f)),
    });
    for (const f of files) zip.addLocalFile(path.join(mediaDir, f));
    zip.addFile(`WhatsApp Chat with ${chat.title}.txt`, Buffer.from(text, 'utf8'));
    zip.writeZip(dest);
    return { messages: lines, media: files.length, skipped, file: dest };
  }

}

module.exports = { Store, openSource, suggestMapping, mergeMessages };
