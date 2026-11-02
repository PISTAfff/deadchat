'use strict';
// Shared by the desktop app (Node) and the phone app (browser): name matching, merging, export text.

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

/** Builds a WhatsApp-style export .txt. Returns the text and the media files it references. */
function exportText(chat, { includeMedia = true, includeUndelivered = true, hasFile = () => true } = {}) {
  const pad = n => String(n).padStart(2, '0');
  const stamp = t => {
    const d = new Date(t);
    let h = d.getUTCHours(); const ap = h < 12 ? 'am' : 'pm'; h = h % 12 || 12;
    return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}, ${h}:${pad(d.getUTCMinutes())} ${ap}`;
  };
  const out = [], files = [];
  let skipped = 0;
  for (const m of chat.messages) {
    if (m.u && !includeUndelivered) continue;
    if (m.sys) { out.push(`${stamp(m.t)} - ${m.x}`); continue; }
    let body;
    if (m.a && includeMedia && !m.a.missing && hasFile(m.a.f)) {
      body = `${m.a.f} (file attached)` + (m.x ? '\n' + m.x : '');
      if (!files.includes(m.a.f)) files.push(m.a.f);
    } else if (m.a || m.o) {
      body = '<Media omitted>' + (m.x ? '\n' + m.x : '');
      if (m.a) skipped++;
    } else body = m.x || '';
    if (m.e) body += ' <This message was edited>';
    out.push(`${stamp(m.t)} - ${chat.participants[m.s].name}: ${body}`);
  }
  return { text: out.join('\n') + '\n', files, lines: out.length, skipped };
}

// Works in Node (require) and in the browser (window.DeadChat).
if (typeof module !== 'undefined' && module.exports) module.exports = { normName, suggestMapping, mergeMessages, exportText };
else (globalThis.DeadChat = globalThis.DeadChat || {}, Object.assign(globalThis.DeadChat, { normName, suggestMapping, mergeMessages, exportText }));
