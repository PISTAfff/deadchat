'use strict';
// Reads an export (zip, folder or .txt), merges it into a stored chat, and copies the media it references.
// Source files are only ever read, never modified.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const AdmZip = require('adm-zip');
const { parseChat } = require('./parser');

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

// ---------- name matching ----------

function normName(s) {
  return s.normalize('NFKC').toLowerCase().replace(/\([^)]*\)/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Suggest which existing participant each incoming sender is. */
function suggestMapping(incoming, participants) {
  return incoming.map(name => {
    const n = normName(name);
    const hit = participants.findIndex(p => {
      const q = normName(p.name);
      return q && n && (q === n || q.startsWith(n) || n.startsWith(q));
    });
    return hit;
  });
}

// ---------- merging ----------

const textKey = m => m.sys
  ? (m.x || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  : (m.x || '').replace(/\s+/g, ' ').trim();
const isMedia = m => !!(m.a || m.o);

/**
 * Merge parsed messages into an existing list. Handles the same message showing up in two
 * overlapping exports: dedupes per minute+sender, upgrades "<Media omitted>" to a real
 * attachment when one export has the file, and tolerates later edits/deletions.
 */
function mergeMessages(existing, incoming) {
  const buckets = new Map();
  const bucketKey = m => `${Math.floor(m.t / 60000)}|${m.s}`;
  existing.forEach((m, i) => {
    const k = bucketKey(m);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push({ i, used: false });
  });
  const stats = { added: 0, duplicates: 0, upgraded: 0 };
  const added = [];

  for (const m of incoming) {
    const slots = buckets.get(bucketKey(m)) || [];
    const free = slots.filter(s => !s.used);
    const find = pred => free.find(s => pred(existing[s.i]));

    let slot, upgraded = false;
    if (m.sys) slot = find(e => textKey(e) === textKey(m));
    else if (m.a) {
      slot = find(e => e.a && e.a.f === m.a.f);
      if (!slot) {
        slot = find(e => e.o);
        if (slot) { const e = existing[slot.i]; e.a = m.a; delete e.o; if (m.x) e.x = m.x; upgraded = true; }
      }
    } else if (m.o) slot = find(e => isMedia(e));
    else if (m.d) slot = find(e => !isMedia(e));
    else {
      slot = find(e => !isMedia(e) && textKey(e) === textKey(m));
      if (!slot && m.e) slot = find(e => !isMedia(e) && !e.d);
      if (!slot) slot = find(e => e.d);
      if (slot) {
        const e = existing[slot.i];
        if (m.e && !e.e) { e.x = m.x; e.e = 1; }
        if (e.d && !m.d) { e.x = m.x; delete e.d; }
      }
    }
    if (slot) {
      slot.used = true;
      stats[upgraded ? 'upgraded' : 'duplicates']++;
      continue;
    }
    added.push(m);
    stats.added++;
  }
  const all = existing.concat(added);
  all.forEach((m, i) => (m._o = i));
  all.sort((a, b) => a.t - b.t || a._o - b._o);
  all.forEach(m => delete m._o);
  return { messages: all, stats };
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
    chat.messages = chat.messages.filter(m => !(m.u && m.id === msgId));
    this.writeChat(id, chat);
    return before !== chat.messages.length;
  }

  // ---------- re-export ----------

  /** Writes the chat back out as a WhatsApp-style export zip (chat .txt + media). */
  exportChat(id, dest, { includeMedia = true, includeUndelivered = true } = {}) {
    const chat = this.readChat(id);
    const pad = n => String(n).padStart(2, '0');
    const stamp = t => {
      const d = new Date(t);
      let h = d.getUTCHours(); const ap = h < 12 ? 'am' : 'pm'; h = h % 12 || 12;
      return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}, ${h}:${pad(d.getUTCMinutes())} ${ap}`;
    };
    const lines = [];
    const zip = new AdmZip();
    const mediaDir = path.join(this.chatDir(id), 'media');
    let media = 0, skipped = 0;
    for (const m of chat.messages) {
      if (m.u && !includeUndelivered) continue;
      if (m.sys) { lines.push(`${stamp(m.t)} - ${m.x}`); continue; }
      let body;
      const src = m.a && path.join(mediaDir, m.a.f);
      if (m.a && includeMedia && !m.a.missing && fs.existsSync(src)) {
        body = `${m.a.f} (file attached)` + (m.x ? '\n' + m.x : '');
        zip.addLocalFile(src);
        media++;
      } else if (m.a || m.o) {
        body = '<Media omitted>' + (m.x ? '\n' + m.x : '');
        if (m.a) skipped++;
      } else body = m.x || '';
      if (m.e) body += ' <This message was edited>';
      lines.push(`${stamp(m.t)} - ${chat.participants[m.s].name}: ${body}`);
    }
    const name = `WhatsApp Chat with ${chat.title}.txt`;
    zip.addFile(name, Buffer.from(lines.join('\n') + '\n', 'utf8'));
    zip.writeZip(dest);
    return { messages: lines.length, media, skipped, file: dest };
  }

}

module.exports = { Store, openSource, suggestMapping, mergeMessages };
