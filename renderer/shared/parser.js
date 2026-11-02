'use strict';
// Parses WhatsApp "Export chat" .txt files (Android and iOS styles, 12h/24h, 2/4-digit years).

const LINE_RE = /^\[?(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?[\s  ]*([AaPp]\.?\s?[Mm]\.?)?\]?\s*(?:-\s)?(.*)$/;
const ATTACHED_RE = /^(.+?) \(file attached\)$/;
const IOS_ATTACHED_RE = /^<attached: (.+?)>$/;
const OMITTED_RE = /^<?(Media|image|video|audio|sticker|GIF|document|Contact card) omitted>?$/i;
const DELETED_RE = /^(You deleted this message|This message was deleted)\.?$/;
const EDITED_RE = /\s*<This message was edited>\s*$/;

function clean(s) {
  return s.replace(/^[‎‏﻿]+/, '');
}

function kindOf(file) {
  const ext = file.split('.').pop().toLowerCase();
  if (/^PTT-/i.test(file)) return 'audio';
  if (/^STK-/i.test(file) || ext === 'webp') return 'sticker';
  if (['jpg', 'jpeg', 'png', 'gif', 'heic', 'bmp'].includes(ext)) return 'image';
  if (['opus', 'ogg', 'm4a', 'mp3', 'aac', 'amr', 'wav'].includes(ext)) return 'audio';
  if (['mp4', '3gp', 'mov', 'mkv', 'webm'].includes(ext)) return 'video';
  return 'document';
}

// Decide whether the export is day-first or month-first by looking for an impossible month.
function detectOrder(lines) {
  let dayFirst = 0, monthFirst = 0;
  for (const raw of lines) {
    const m = LINE_RE.exec(clean(raw));
    if (!m) continue;
    const a = +m[1], b = +m[2];
    if (a > 12) dayFirst++;
    if (b > 12) monthFirst++;
  }
  return monthFirst > dayFirst ? 'mdy' : 'dmy';
}

function toTime(m, order) {
  let day = +m[1], month = +m[2];
  if (order === 'mdy') [day, month] = [month, day];
  let year = +m[3];
  if (year < 100) year += 2000;
  let hour = +m[4];
  const ap = m[7] ? m[7].replace(/[.\s]/g, '').toLowerCase() : null;
  if (ap === 'pm' && hour < 12) hour += 12;
  if (ap === 'am' && hour === 12) hour = 0;
  // Stored as "wall clock" UTC so it never shifts with the viewer's time zone.
  return Date.UTC(year, month - 1, day, hour, +m[5], +(m[6] || 0));
}

function parseBody(body) {
  const msg = { x: body };
  if (EDITED_RE.test(msg.x)) { msg.x = msg.x.replace(EDITED_RE, ''); msg.e = 1; }
  const first = msg.x.split('\n')[0].trim();
  const rest = msg.x.split('\n').slice(1).join('\n').trim();
  let m;
  if ((m = ATTACHED_RE.exec(first)) || (m = IOS_ATTACHED_RE.exec(first))) {
    msg.a = { f: clean(m[1]).trim(), k: kindOf(m[1].trim()) };
    msg.x = rest;
  } else if (OMITTED_RE.test(first)) {
    msg.o = 1;
    msg.x = rest;
  } else if (DELETED_RE.test(first)) {
    msg.d = 1;
    msg.x = first;
  }
  return msg;
}

/**
 * @returns {{senders: string[], messages: object[]}}
 * message: { t, s (sender index, -1 = system), x text, a {f,k} attachment, o omitted, d deleted, e edited }
 */
function parseChat(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const order = detectOrder(lines);
  const senders = [];
  const senderIdx = new Map();
  const out = [];
  let cur = null;

  const flush = () => {
    if (!cur) return;
    const msg = cur.sys ? { x: cur.body.trim() } : parseBody(cur.body.replace(/\s+$/, ''));
    msg.t = cur.t;
    msg.s = cur.sys ? -1 : cur.s;
    if (cur.sys) msg.sys = 1;
    out.push(msg);
    cur = null;
  };

  for (const raw of lines) {
    const line = clean(raw);
    const m = LINE_RE.exec(line);
    if (m) {
      flush();
      const t = toTime(m, order);
      const rest = clean(m[8]);
      const sep = rest.indexOf(': ');
      if (sep > 0 && sep < 80) {
        const name = rest.slice(0, sep).trim();
        if (!senderIdx.has(name)) { senderIdx.set(name, senders.length); senders.push(name); }
        cur = { t, s: senderIdx.get(name), body: clean(rest.slice(sep + 2)) };
      } else {
        cur = { t, sys: true, body: rest };
      }
    } else if (cur) {
      cur.body += '\n' + raw;
    }
  }
  flush();
  return { senders, messages: out };
}

// Works in Node (require) and in the browser (window.DeadChat).
if (typeof module !== 'undefined' && module.exports) module.exports = { parseChat, kindOf };
else (globalThis.DeadChat = globalThis.DeadChat || {}, Object.assign(globalThis.DeadChat, { parseChat, kindOf }));
