'use strict';
/* global api */

const $ = s => document.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* per-viewer convenience only */ } },
};

// ---------- time formatting (times are stored as wall-clock UTC) ----------
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const d = t => new Date(t);
const fmtTime = t => { const x = d(t); let h = x.getUTCHours(); const ap = h < 12 ? 'am' : 'pm'; h = h % 12 || 12; return `${h}:${String(x.getUTCMinutes()).padStart(2, '0')} ${ap}`; };
const fmtDate = t => { const x = d(t); return `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]} ${x.getUTCFullYear()}`; };
const FULL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const fmtDay = t => {
  const now = new Date(), today = Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86400000);
  const diff = today - Math.floor(t / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff > 1 && diff < 7) return DAYS[d(t).getUTCDay()];
  const x = d(t);
  return `${x.getUTCDate()} ${FULL_MONTHS[x.getUTCMonth()]} ${x.getUTCFullYear()}`;
};
const dayKey = t => Math.floor(t / 86400000);
const fmtDur = s => (!isFinite(s) || s < 0) ? '0:00' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const toast = msg => { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 3200); };

// ---------- state ----------
const S = {
  chats: [],
  chatId: null,
  chat: null,
  lo: 0, hi: 0,          // rendered message window [lo, hi)
  search: { q: '', hits: [], pos: -1 },
};
const CHUNK = 160, MAXWIN = 640;

// ================= sidebar =================

async function refreshChats() {
  S.chats = await api.listChats();
  renderSide();
}

function renderSide() {
  const list = $('#side-list');
  list.innerHTML = '';
  if (!S.chats.length) list.append(el('div', 'side-empty', 'No chats yet. Use the import button above.'));
  for (const c of S.chats) {
    const r = el('div', 'row' + (c.id === S.chatId ? ' active' : ''));
    r.innerHTML = `${avatarHtml(c.avatar, c.title)}
      <div class="row-main"><div class="row-top"><div class="row-title">${esc(c.title)}</div>
      <div class="row-time">${c.lastTime ? fmtDate(c.lastTime) : ''}</div></div>
      <div class="row-sub" dir="auto">${esc((c.lastText || '').split('\n')[0])}</div></div>`;
    r.onclick = () => openChat(c.id);
    list.append(r);
  }
}

function showView(v) {
  $('#empty').hidden = v !== 'empty';
  $('#chat-view').hidden = v !== 'chat';
}

// ================= chat =================

const isPhone = () => matchMedia('(max-width: 768px)').matches;
function backToList() { stopAudio(); closeInfo(); document.body.classList.remove('chat-open'); }

async function openChat(id) {
  document.body.classList.add('chat-open');
  stopAudio();
  closeInfo();
  S.chatId = id;
  S.chat = await api.getChat(id);
  S.search = { q: '', hits: [], pos: -1 };
  $('#searchbar').hidden = true;
  const c = S.chat, msgs = c.messages;
  $('#chat-title').textContent = c.title;
  $('#chat-avatar').outerHTML = avatarHtml(c.avatarUrl, c.title, 'chat-avatar');
  const other = c.participants.filter((_, i) => i !== c.me).map(p => p.name).join(', ');
  $('#chat-sub').textContent = msgs.length
    ? `${msgs.length.toLocaleString()} messages · ${fmtDate(msgs[0].t)} – ${fmtDate(msgs[msgs.length - 1].t)}${other ? ' · ' + other : ''}`
    : 'Empty';
  if (msgs.length) {
    const toISO = t => new Date(t).toISOString().slice(0, 10);
    $('#jump-date').min = toISO(msgs[0].t); $('#jump-date').max = toISO(msgs[msgs.length - 1].t);
  }
  showView('chat');
  renderSide();
  fitCompose();
  // always open at the very end, like WhatsApp
  S.hi = msgs.length; S.lo = Math.max(0, S.hi - CHUNK); renderWindow(); stickToBottom();
}

const TICK = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>';

// Arabic (or other RTL) messages start from the right, like WhatsApp.
const isRtl = s => /^[^\p{L}]*[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u.test(s || '');

function avatarHtml(url, title, id) {
  const idAttr = id ? ` id="${id}"` : '';
  return url
    ? `<div class="avatar"${idAttr}><img src="${esc(url)}" alt=""></div>`
    : `<div class="avatar"${idAttr}>${esc((title || '?').trim().charAt(0).toUpperCase())}</div>`;
}

function senderClass(m) { return m.s === S.chat.me ? 'out' : 'in'; }

// ---------- starred messages: kept per chat on this device ----------
// A message is known by its time, sender and content (imported ones have no id of their own).
function msgKey(m) {
  if (m.id) return 'u:' + m.id;
  const s = (m.x || '') + '|' + ((m.a && m.a.f) || '');
  let h = 0;
  for (let k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) | 0;
  return m.t + ':' + m.s + ':' + h;
}
let stars = new Set(), starsFor = null;
function starSet() {
  if (starsFor !== S.chatId) { stars = new Set(store.get('stars:' + S.chatId, [])); starsFor = S.chatId; }
  return stars;
}
const isStarred = m => starSet().has(msgKey(m));
function toggleStar(i) {
  const set = starSet(), k = msgKey(S.chat.messages[i]), on = !set.has(k);
  if (on) set.add(k); else set.delete(k);
  store.set('stars:' + S.chatId, [...set]);
  $('#messages [data-i="' + i + '"]')?.classList.toggle('starred', on);
  toast(on ? 'Starred' : 'Unstarred');
}
function msgPreview(m) {
  if (m.x) return m.x;
  if (m.a) return { audio: 'Voice note', image: 'Photo', video: 'Video', sticker: 'Sticker' }[m.a.k] || m.a.f;
  return 'Message';
}
function openStarred() {
  const list = [];
  S.chat.messages.forEach((m, i) => { if (!m.sys && isStarred(m)) list.push(i); });
  list.reverse();
  const who = m => (m.s === S.chat.me ? 'You' : (S.chat.participants[m.s] && S.chat.participants[m.s].name) || '?');
  const rows = list.map(i => {
    const m = S.chat.messages[i];
    return '<button class="starred-row" data-go="' + i + '"><span class="starred-top"><b dir="auto">' + esc(who(m)) + '</b><span class="muted">' +
      fmtDate(m.t) + ', ' + fmtTime(m.t) + '</span></span><span class="starred-text" dir="auto">' + esc(msgPreview(m)) + '</span></button>';
  }).join('');
  modal('<h2>Starred messages</h2>' + (list.length
    ? '<div class="starred-list">' + rows + '</div>'
    : '<p class="muted">Nothing starred yet. Long-press a message (or right-click it) and choose Star.</p>') +
    '<div class="modal-actions"><button class="ghost" data-close>Close</button></div>');
  const box = document.querySelector('.starred-list');
  if (box) box.addEventListener('click', e => {
    const b = e.target.closest('[data-go]');
    if (!b) return;
    closeModal(); closeInfo();
    jumpTo(+b.dataset.go);
  });
}

function linkify(text) {
  let html = esc(text);
  html = html.replace(/\bhttps?:\/\/[^\s<]+/g, u => `<a data-href="${u}">${u}</a>`);
  const q = S.search.q;
  if (q) {
    const re = new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    html = html.replace(/(<[^>]+>)|([^<]+)/g, (all, tag, txt) => tag || txt.replace(re, s => `<mark>${s}</mark>`));
  }
  return html;
}

function mediaUrl(f) { return S.chat.mediaBase + encodeURIComponent(f); }

function renderMessage(m, i, prev) {
  const frag = document.createDocumentFragment();
  if (!prev || dayKey(prev.t) !== dayKey(m.t)) {
    const day = el('div', 'day'); day.innerHTML = `<span>${fmtDay(m.t)}</span>`; frag.append(day);
  }
  if (m.sys) {
    const s = el('div', 'sys'); s.dataset.i = i; s.innerHTML = `<span dir="auto">${esc(m.x)}</span>`; frag.append(s); return frag;
  }
  const first = !prev || prev.sys || prev.s !== m.s || dayKey(prev.t) !== dayKey(m.t);
  const sticker = m.a && m.a.k === 'sticker' && !m.a.missing;
  const row = el('div', `msg ${senderClass(m)}${first ? ' first' : ''}${sticker ? ' sticker-wrap' : ''}`);
  row.dataset.i = i;
  if (m.u) row.dataset.uid = m.id;
  if (isStarred(m)) row.classList.add('starred');
  const b = el('div', 'bubble');
  const tick = m.u ? `<span class="tick" title="Not delivered — and it never will be">${TICK}</span>` : '';
  const meta = `<span class="meta">${m.e ? 'Edited · ' : ''}${fmtTime(m.t)}${tick}</span>`;

  if (m.d) b.innerHTML = `<span class="note">🚫 ${esc(m.x || 'This message was deleted')}</span>${meta}`;
  else if (m.o) b.innerHTML = `<span class="note">📎 Media not included in this export</span>${m.x ? `<div class="text caption" dir="auto">${linkify(m.x)}</div>` : ''}${meta}`;
  else if (m.a) {
    const a = m.a;
    let body;
    if (a.missing) body = `<div class="missing">📎 ${esc(a.f)} — file wasn't in the export</div>`;
    else if (a.k === 'image') body = `<img class="media-img" loading="lazy" decoding="async" src="${mediaUrl(a.f)}" alt="">`;
    else if (a.k === 'sticker') body = `<img class="sticker" loading="lazy" decoding="async" src="${mediaUrl(a.f)}" alt="sticker">`;
    else if (a.k === 'video') body = `<video class="media-video" controls preload="metadata" src="${mediaUrl(a.f)}"></video>`;
    else if (a.k === 'audio') body = voiceHtml(i, meta);
    else body = `<div class="doc" data-open="${esc(a.f)}">📄 <span class="doc-name">${esc(a.f)}</span></div>`;
    const voiceOwnsMeta = a.k === 'audio' && !a.missing && !m.x; // voice notes show the time in their own footer, like WhatsApp
    b.innerHTML = body + (m.x ? `<div class="text caption" dir="auto">${linkify(m.x)}</div>` : '') + (voiceOwnsMeta ? '' : meta);
  } else {
    b.innerHTML = `<span class="text" dir="auto">${linkify(m.x)}</span>${meta}`;
    if (isRtl(m.x)) b.classList.add('rtl');
  }
  row.append(b);
  if (S.search.hits[S.search.pos] === i) row.classList.add('hit');
  frag.append(row);
  return frag;
}

function renderRange(from, to) {
  const msgs = S.chat.messages, frag = document.createDocumentFragment();
  for (let i = from; i < to; i++) frag.append(renderMessage(msgs[i], i, i > from ? msgs[i - 1] : null));
  return frag;
}

function edgeNote(top) {
  const msgs = S.chat.messages;
  if (top && S.lo === 0) return el('div', 'edge', `The beginning · ${msgs.length ? fmtDay(msgs[0].t) : ''}`);
  if (!top && S.hi === msgs.length) return el('div', 'edge', 'The end of this archive');
  return null;
}

function renderWindow() {
  const box = $('#messages');
  box.innerHTML = '';
  const top = edgeNote(true); if (top) box.append(top);
  box.append(renderRange(S.lo, S.hi));
  const bot = edgeNote(false); if (bot) box.append(bot);
  observeVoices();
}

let autoScrolled = false;
function scrollToBottom() { const box = $('#messages'); autoScrolled = true; box.scrollTop = box.scrollHeight; }

function jumpTo(i, highlight = true) {
  stick = false;
  const n = S.chat.messages.length;
  i = Math.max(0, Math.min(n - 1, i));
  S.lo = Math.max(0, i - Math.floor(CHUNK / 2));
  S.hi = Math.min(n, S.lo + CHUNK);
  renderWindow();
  const node = $(`#messages [data-i="${i}"]`);
  if (node) {
    node.scrollIntoView({ block: 'center' });
    if (highlight && !node.classList.contains('hit')) { node.classList.add('hit'); setTimeout(() => node.classList.remove('hit'), 1600); }
  }
}

let loading = false;
// Keep the message you are looking at in the same spot when content is added or removed above it.
// (The browser's own scroll anchoring may already have done it; then the correction is zero.)
function anchorOf(box) {
  const top = box.getBoundingClientRect().top;
  for (const n of box.querySelectorAll('[data-i]')) {
    const r = n.getBoundingClientRect();
    if (r.bottom > top) return { n, y: r.top };
  }
  return null;
}
function keepAnchor(box, a) {
  if (!a || !a.n.isConnected) return;
  const d = a.n.getBoundingClientRect().top - a.y;
  if (Math.abs(d) > 0.5) box.scrollTop += d;
}

let scrollFrame = 0;
function onScrollEvent() {
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => { scrollFrame = 0; onScroll(); });
}

function onScroll() {
  const box = $('#messages'), n = S.chat ? S.chat.messages.length : 0;
  if (!S.chat || loading) return;
  // any scroll we didn't cause that leaves the bottom means you're reading: stop following the end
  if (autoScrolled) autoScrolled = false;
  else if (box.scrollHeight - box.scrollTop - box.clientHeight > 80) stick = false;
  $('#to-bottom').hidden = S.hi === n && box.scrollHeight - box.scrollTop - box.clientHeight < 400;
  loading = true;
  try {
    if (box.scrollTop < 1500 && S.lo > 0) {
      const from = Math.max(0, S.lo - CHUNK), anchor = anchorOf(box);
      const firstMsg = box.querySelector('[data-i]');
      // drop the day chip of the old first message if it will now continue the same day
      box.querySelector('.edge')?.remove();
      const frag = renderRange(from, S.lo);
      if (firstMsg && firstMsg.previousElementSibling?.classList.contains('day') && dayKey(S.chat.messages[S.lo - 1].t) === dayKey(S.chat.messages[S.lo].t)) firstMsg.previousElementSibling.remove();
      if (firstMsg && !S.chat.messages[S.lo].sys && S.chat.messages[S.lo - 1].s === S.chat.messages[S.lo].s && !S.chat.messages[S.lo - 1].sys) firstMsg.classList.remove('first');
      S.lo = from;
      box.prepend(frag);
      const top = edgeNote(true); if (top) box.prepend(top);
      keepAnchor(box, anchor);
      trim('bottom');
      observeVoices();
    } else if (box.scrollHeight - box.scrollTop - box.clientHeight < 1500 && S.hi < n) {
      const to = Math.min(n, S.hi + CHUNK);
      box.querySelector('.edge:last-child')?.remove();
      const frag = document.createDocumentFragment();
      for (let i = S.hi; i < to; i++) frag.append(renderMessage(S.chat.messages[i], i, S.chat.messages[i - 1]));
      S.hi = to;
      box.append(frag);
      const bot = edgeNote(false); if (bot) box.append(bot);
      trim('top');
      observeVoices();
    }
  } finally { loading = false; }
}

// keep the DOM bounded by dropping messages far from the viewport
function trim(side) {
  const box = $('#messages');
  if (S.hi - S.lo <= MAXWIN) return;
  const drop = S.hi - S.lo - MAXWIN;
  if (side === 'bottom') {
    const cut = S.hi - drop;
    for (const node of [...box.children].reverse()) {
      const i = node.dataset.i != null ? +node.dataset.i : null;
      if (i != null && i < cut) break;
      node.remove();
    }
    S.hi = cut;
  } else {
    const cut = S.lo + drop, anchor = anchorOf(box);
    for (const node of [...box.children]) {
      const i = node.dataset.i != null ? +node.dataset.i : null;
      if (i != null && i >= cut) break;
      node.remove();
    }
    S.lo = cut;
    const m = S.chat.messages[cut];
    const firstNode = box.querySelector('[data-i]');
    if (firstNode && !firstNode.previousElementSibling?.classList.contains('day')) {
      const day = el('div', 'day'); day.innerHTML = `<span>${fmtDay(m.t)}</span>`; box.prepend(day);
    }
    keepAnchor(box, anchor);
  }
}

// Stay pinned to the bottom while late-loading photos and videos change heights,
// until you scroll yourself.
let stick = false;
function stickToBottom() { stick = true; scrollToBottom(); }
const unstick = () => { stick = false; };
$('#messages').addEventListener('wheel', unstick, { passive: true });
$('#messages').addEventListener('pointerdown', unstick);
$('#messages').addEventListener('keydown', unstick);
$('#messages').addEventListener('load', () => { if (stick) scrollToBottom(); }, true);
$('#messages').addEventListener('loadedmetadata', () => { if (stick) scrollToBottom(); }, true);

// ---------- voice notes ----------
const player = new Audio();
player.preload = 'auto';
let playingIdx = null;
let speed = store.get('speed', 1);
const durations = new Map();

// on Android, a note held to the ear plays natively through the earpiece (see EarpiecePlugin.java)
const native = window.Capacitor?.isNativePlatform?.() && window.Capacitor.Plugins;
const Ear = native && native.Earpiece, FS = native && native.Filesystem;
let ear = null; // { i, pos, timer } while the playing note is at the ear
const curTime = () => (ear ? ear.pos : player.currentTime);
const isPaused = () => (ear ? false : player.paused);
let scrub = null; // { i, frac, ... } while a waveform is being dragged

const PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>';
const PAUSE = '<svg viewBox="0 0 24 24"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>';

const MIC = '<svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11z"/></svg>';
const BARS = 40;

// A stable, decorative waveform per file (the export carries no waveform data).
function waveBars(name) {
  let h = 2166136261;
  for (let k = 0; k < name.length; k++) h = Math.imul(h ^ name.charCodeAt(k), 16777619);
  const out = [];
  for (let k = 0; k < BARS; k++) {
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    const r = ((h >>> 0) % 1000) / 1000;
    const env = 0.55 + 0.45 * Math.sin((k / BARS) * Math.PI);
    out.push(Math.round(14 + 86 * env * (0.35 + 0.65 * r)));
  }
  return out;
}

function voiceHtml(i, meta = '') {
  const m = S.chat.messages[i], playing = playingIdx === i;
  if (!durations.has(i) && cachedWave(m.a.f) && durByFile.has(m.a.f)) durations.set(i, durByFile.get(m.a.f));
  const dur = durations.get(i);
  const name = (S.chat.participants[m.s]?.name || '?').normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '');
  // real waveform once it has been measured; a flat line until then
  const bars = (cachedWave(m.a.f) || Array(BARS).fill(1)).map(v => `<i class="h${v}"></i>`).join('');
  return `<div class="voice${playing ? ' playing' : ''}" data-voice="${i}">
    <button class="play" title="Play">${playing && !isPaused() ? PAUSE : PLAY}</button>
    <div class="v-main">
      <div class="wave" title="Seek">${bars}<span class="dot"></span></div>
      <div class="v-foot"><span class="v-time">${playing ? fmtDur(curTime()) : dur ? fmtDur(dur) : '0:00'}</span>${S.chat.messages[i].x ? '' : meta}</div>
    </div>
    <div class="v-side">
      <div class="v-avatar">${m.s !== S.chat.me && S.chat.avatarUrl ? `<img src="${esc(S.chat.avatarUrl)}" alt="">` : esc(name.charAt(0).toUpperCase() || '?')}<span class="v-mic">${MIC}</span></div>
      <button class="speed" title="Playback speed">${speed}×</button>
    </div></div>`;
}

const voiceNode = i => document.querySelector(`[data-voice="${i}"]`);

function setWave(v, frac) {
  const n = Math.round(frac * BARS);
  v.querySelectorAll('.wave i').forEach((b, k) => b.classList.toggle('on', k < n));
  v.querySelector('.dot').style.left = (frac * 100) + '%';
}

function updateVoiceUI() {
  if (playingIdx == null) return;
  updateSession();
  const v = voiceNode(playingIdx); if (!v) return;
  v.classList.add('playing');
  v.querySelector('.play').innerHTML = isPaused() ? PLAY : PAUSE;
  if (scrub && scrub.i === playingIdx) return;
  const dur = playingDuration();
  if (dur > 0) setWave(v, Math.min(1, curTime() / dur));
  v.querySelector('.v-time').textContent = fmtDur(curTime());
}

function resetVoiceUI(i) {
  const v = voiceNode(i); if (!v) return;
  v.classList.remove('playing');
  v.querySelector('.play').innerHTML = PLAY;
  setWave(v, 0);
  const d = durations.get(i);
  v.querySelector('.v-time').textContent = d ? fmtDur(d) : '0:00';
}

// the phone build plays voice notes from an in-memory copy (steadier than streaming through the
// service worker on Android); the desktop plays the file directly
let playerUrl = null;
async function voiceSrc(m) {
  if (!document.documentElement.classList.contains('web') || !api.readMedia) return mediaUrl(m.a.f);
  const bytes = await api.readMedia(S.chatId, m.a.f);
  if (playerUrl) URL.revokeObjectURL(playerUrl);
  const ext = m.a.f.split('.').pop().toLowerCase();
  playerUrl = URL.createObjectURL(new Blob([bytes], { type: ext === 'webm' ? 'audio/webm' : ext === 'm4a' ? 'audio/mp4' : ext === 'mp3' ? 'audio/mpeg' : 'audio/ogg' }));
  return playerUrl;
}

// a known length for the playing note even when the file doesn't say (recorded .webm)
function playingDuration() {
  if (isFinite(player.duration) && player.duration > 0) return player.duration;
  const m = playingIdx != null && S.chat.messages[playingIdx];
  return durations.get(playingIdx) || (m && m.a && durByFile.get(m.a.f)) || 0;
}

async function playVoice(i, seekFrac) {
  const m = S.chat.messages[i];
  if (ear) await fromEar(false);
  if (playingIdx !== i) {
    if (playingIdx != null) resetVoiceUI(playingIdx);
    playingIdx = i;
    try { player.src = await voiceSrc(m); } catch (err) { toast('Could not play this voice note: ' + err.message); return; }
    if (playingIdx !== i) return; // another note was tapped meanwhile
    player.playbackRate = speed;
  }
  if (seekFrac != null) {
    const go = () => { const d = playingDuration(); if (d) player.currentTime = seekFrac * d; };
    if (player.readyState >= 1) go(); else player.addEventListener('loadedmetadata', go, { once: true });
  }
  player.play().then(() => { if (atEar) toEar(); })
    .catch(err => { if (err.name !== 'AbortError') toast('Could not play this voice note: ' + err.message); });
  tickVoice();
}

function pauseVoice() { if (ear) fromEar(false); else player.pause(); }

function seekBy(sec) {
  if (playingIdx == null || ear) return;
  const d = playingDuration();
  player.currentTime = Math.max(0, Math.min(d || Infinity, player.currentTime + sec));
  updateVoiceUI();
}

// the voice note before or after this one in the chat
function voiceNear(from, dir) {
  const msgs = S.chat?.messages || [];
  for (let k = from + dir; k >= 0 && k < msgs.length; k += dir) {
    const a = msgs[k].a;
    if (a && a.k === 'audio' && !a.missing) return k;
  }
  return null;
}
function playVoiceAt(k) {
  if (k == null) return;
  if (!voiceNode(k)) jumpTo(k, false);
  voiceNode(k)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  playVoice(k);
}

// ---------- system media controls: notification, lock screen, headset and keyboard keys ----------
const MS = 'mediaSession' in navigator ? navigator.mediaSession : null;
let sessionIdx = null;
function updateSession() {
  if (!MS) return;
  if (playingIdx == null) {
    if (sessionIdx != null) { MS.metadata = null; MS.playbackState = 'none'; sessionIdx = null; }
    return;
  }
  if (sessionIdx !== playingIdx && S.chat) {
    sessionIdx = playingIdx;
    const m = S.chat.messages[playingIdx];
    MS.metadata = new MediaMetadata({
      title: `Voice note from ${S.chat.participants[m.s]?.name || 'someone'}`,
      artist: fmtDate(m.t),
      album: S.chat.title,
      artwork: S.chat.avatarUrl ? [{ src: S.chat.avatarUrl }] : [],
    });
  }
  MS.playbackState = isPaused() ? 'paused' : 'playing';
  const d = playingDuration();
  if (d > 0) { try { MS.setPositionState({ duration: d, position: Math.min(d, curTime()), playbackRate: speed }); } catch { /* not supported */ } }
}
if (MS) {
  const on = (action, fn) => { try { MS.setActionHandler(action, fn); } catch { /* action not supported here */ } };
  on('play', () => { if (playingIdx != null) playVoice(playingIdx); });
  on('pause', pauseVoice);
  on('stop', stopAudio);
  on('seekbackward', e => seekBy(-(e.seekOffset || 5)));
  on('seekforward', e => seekBy(e.seekOffset || 5));
  on('seekto', e => { if (playingIdx != null && !ear) { player.currentTime = e.seekTime; updateVoiceUI(); } });
  on('previoustrack', () => { if (playingIdx != null) playVoiceAt(voiceNear(playingIdx, -1)); });
  on('nexttrack', () => { if (playingIdx != null) playVoiceAt(voiceNear(playingIdx, 1)); });
}

// ---------- at the ear ----------
let atEar = false, earCached = null;
async function earFile(m) {
  if (earCached && earCached.f === m.a.f) return earCached.uri;
  const bytes = await api.readMedia(S.chatId, m.a.f);
  const path = 'ear-voice.' + (m.a.f.split('.').pop() || 'ogg');
  let bin = '';
  for (let k = 0; k < bytes.length; k += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(k, k + 0x8000));
  await FS.writeFile({ path, data: btoa(bin), directory: 'CACHE' });
  const { uri } = await FS.getUri({ path, directory: 'CACHE' });
  earCached = { f: m.a.f, uri };
  return uri;
}

async function toEar() {
  if (!Ear || !FS || ear || playingIdx == null || player.paused) return;
  const i = playingIdx, m = S.chat.messages[i];
  ear = { i, pos: player.currentTime, timer: 0 };
  player.pause();
  try {
    const path = await earFile(m);
    if (!ear || ear.i !== i) return;
    await Ear.play({ path, position: ear.pos, rate: speed });
    ear.timer = setInterval(async () => {
      const r = await Ear.position().catch(() => null);
      if (ear && r && r.position >= 0) { ear.pos = r.position; updateVoiceUI(); }
    }, 200);
  } catch {
    if (ear && ear.i === i) { ear = null; player.play().catch(() => {}); }
  }
}

async function fromEar(resume = true) {
  if (!ear) return;
  const e = ear;
  ear = null;
  clearInterval(e.timer);
  const r = await Ear.halt().catch(() => ({ position: -1 }));
  if (playingIdx !== e.i) return;
  player.currentTime = r.position >= 0 ? r.position : e.pos;
  if (resume) player.play().catch(() => {}); else { updateVoiceUI(); Ear.stop(); }
}

if (Ear) {
  Ear.addListener('proximity', ({ near }) => { atEar = near; if (near) toEar(); else fromEar(); });
  Ear.addListener('ended', () => {
    if (!ear) return;
    clearInterval(ear.timer);
    ear = null;
    voiceEnded();
  });
  player.addEventListener('play', () => Ear.start().catch(() => {}));
  player.addEventListener('pause', () => { if (!ear) Ear.stop().catch(() => {}); });
}

// move the dot and bars every frame while playing, so it glides like WhatsApp instead of jumping
let voiceFrame = 0;
function tickVoice() {
  cancelAnimationFrame(voiceFrame);
  const step = () => {
    if (playingIdx == null || player.paused) return;
    const v = voiceNode(playingIdx), d = playingDuration();
    if (v && d && !(scrub && scrub.i === playingIdx)) setWave(v, Math.min(1, player.currentTime / d));
    voiceFrame = requestAnimationFrame(step);
  };
  voiceFrame = requestAnimationFrame(step);
}
player.addEventListener('play', tickVoice);

function stopAudio() {
  if (ear) { clearInterval(ear.timer); ear = null; Ear.halt().catch(() => {}); }
  player.pause();
  if (playingIdx != null) resetVoiceUI(playingIdx);
  playingIdx = null;
  updateSession();
  if (Ear) Ear.stop().catch(() => {});
}

player.addEventListener('timeupdate', updateVoiceUI);
player.addEventListener('play', updateVoiceUI);
player.addEventListener('pause', updateVoiceUI);
player.addEventListener('loadedmetadata', () => { if (playingIdx != null && isFinite(player.duration) && player.duration > 0) durations.set(playingIdx, player.duration); updateVoiceUI(); });
function voiceEnded() {
  const done = playingIdx;
  resetVoiceUI(done);
  playingIdx = null;
  // like WhatsApp: roll straight into the next voice note if it comes right after
  const next = S.chat?.messages[done + 1];
  if (next && next.a && next.a.k === 'audio' && !next.a.missing) playVoiceAt(done + 1);
  else { updateSession(); if (Ear) Ear.stop().catch(() => {}); }
}
player.addEventListener('ended', () => { if (!ear) voiceEnded(); });

// ---------- real waveforms: decode each voice note once, remember its loudness shape ----------
const waveCache = new Map();
function cachedWave(f) {
  if (waveCache.has(f)) return waveCache.get(f);
  const v = store.get('wave:' + f, null);
  if (v && v.w) { waveCache.set(f, v.w); if (v.d) durByFile.set(f, v.d); return v.w; }
  return null;
}
const durByFile = new Map();
let decodeCtx = null, waveQueue = Promise.resolve();
const measuring = new Set();

function measureVoice(i) {
  const m = S.chat && S.chat.messages[i];
  if (!m || !m.a) return;
  const f = m.a.f, chatId = S.chatId;
  if (cachedWave(f)) { applyWave(f); return; }
  if (measuring.has(f)) return;
  measuring.add(f);
  waveQueue = waveQueue.then(async () => {
    try {
      const bytes = await api.readMedia(chatId, f);
      decodeCtx = decodeCtx || new (window.AudioContext || window.webkitAudioContext)();
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const audio = await decodeCtx.decodeAudioData(ab);
      const data = audio.getChannelData(0), step = Math.max(1, Math.floor(data.length / BARS));
      const rms = [];
      for (let b = 0; b < BARS; b++) {
        let sum = 0; const from = b * step, to = Math.min(data.length, from + step);
        for (let k = from; k < to; k++) sum += data[k] * data[k];
        rms.push(Math.sqrt(sum / Math.max(1, to - from)));
      }
      const peak = Math.max(...rms) || 1;
      const w = rms.map(r => Math.max(1, Math.min(10, Math.round(Math.pow(r / peak, 0.7) * 10))));
      waveCache.set(f, w); durByFile.set(f, audio.duration);
      store.set('wave:' + f, { w, d: Math.round(audio.duration * 10) / 10 });
      applyWave(f);
    } catch { /* unreadable or missing file: keep the flat line */ }
    measuring.delete(f);
  });
}

// redraw the bars (and length) of every visible voice note that uses this file
function applyWave(f) {
  const w = waveCache.get(f); if (!w) return;
  document.querySelectorAll('#messages [data-voice]').forEach(v => {
    const i = +v.dataset.voice, m = S.chat.messages[i];
    if (!m || !m.a || m.a.f !== f) return;
    v.querySelectorAll('.wave i').forEach((b, k) => { b.className = `h${w[k]}` + (b.classList.contains('on') ? ' on' : ''); });
    const d = durByFile.get(f);
    if (d && !durations.has(i)) { durations.set(i, d); if (playingIdx !== i) v.querySelector('.v-time').textContent = fmtDur(d); }
  });
}

const durObserver = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting || !S.chat) continue;
    durObserver.unobserve(e.target);
    measureVoice(+e.target.dataset.voice);
  }
}, { root: null, rootMargin: '300px' });

function observeVoices() {
  document.querySelectorAll('#messages [data-voice]').forEach(v => {
    const m = S.chat.messages[+v.dataset.voice];
    if (!m || !m.a || !cachedWave(m.a.f) || !durations.has(+v.dataset.voice)) durObserver.observe(v);
  });
  if (playingIdx != null) updateVoiceUI();
}

// ---------- message interactions ----------
$('#messages').addEventListener('click', e => {
  const t = e.target;
  const voice = t.closest('[data-voice]');
  if (voice) {
    const i = +voice.dataset.voice;
    if (t.closest('.play')) { if (playingIdx === i && !isPaused()) pauseVoice(); else playVoice(i); }
    else if (t.closest('.speed')) {
      speed = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1;
      store.set('speed', speed); player.playbackRate = speed;
      document.querySelectorAll('.voice .speed').forEach(s => (s.textContent = speed + '×'));
      updateSession();
    }
    return;
  }
  if (t.matches('.media-img')) { openMedia(+t.closest('[data-i]').dataset.i); return; }
  const doc = t.closest('[data-open]');
  if (doc) { api.openMedia(S.chatId, doc.dataset.open).catch(err => toast(err.message)); return; }
  const a = t.closest('a[data-href]');
  if (a) { api.openLink(a.dataset.href); }
});
$('#messages').addEventListener('scroll', onScrollEvent, { passive: true });

// drag along a voice note's waveform to scrub; a tap seeks there too
function scrubAt(e) {
  const r = scrub.w.getBoundingClientRect();
  scrub.frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  setWave(scrub.v, scrub.frac);
  const d = scrub.i === playingIdx ? playingDuration() : durations.get(scrub.i) || 0;
  if (d) scrub.v.querySelector('.v-time').textContent = fmtDur(scrub.frac * d);
}
$('#messages').addEventListener('pointerdown', e => {
  const w = e.target.closest('.voice .wave');
  if (!w || e.button > 0) return;
  const v = w.closest('[data-voice]');
  scrub = { i: +v.dataset.voice, w, v, id: e.pointerId, frac: 0 };
  w.setPointerCapture(e.pointerId);
  scrubAt(e);
});
$('#messages').addEventListener('pointermove', e => { if (scrub && e.pointerId === scrub.id) scrubAt(e); });
$('#messages').addEventListener('pointerup', e => {
  if (!scrub || e.pointerId !== scrub.id) return;
  const { i, frac } = scrub;
  scrub = null;
  playVoice(i, frac);
});
$('#messages').addEventListener('pointercancel', () => {
  if (!scrub) return;
  const i = scrub.i;
  scrub = null;
  if (i === playingIdx) updateVoiceUI(); else resetVoiceUI(i);
});
$('#lightbox').onclick = e => { if (!e.target.closest('#lightbox-img, #lightbox-video, .lb-bar, .lb-nav, .lb-strip')) closeViewer(); };
// ---------- contact info + photo viewer (like WhatsApp) ----------
function otherIndex() { return S.chat.participants.findIndex((_, k) => k !== S.chat.me); }
function otherName() { return S.chat.contactName || S.chat.participants[otherIndex()]?.name || S.chat.title; }

// Single photos (profile pictures) open on their own; chat media opens as a gallery you can move through.
const V = { list: null, pos: 0 };

function openViewer(src, { name, sub, avatar, pfp } = {}) {
  V.list = null;
  $('#lightbox').classList.remove('gallery');
  showStill(src, !!pfp);
  setViewerBar(name, sub, avatar);
  $('#lb-caption').textContent = '';
  $('#lb-strip').innerHTML = '';
  $('#lightbox').hidden = false;
}
function closeViewer() {
  $('#lightbox').hidden = true;
  $('#lightbox-img').removeAttribute('src');
  zReset();
  const v = $('#lightbox-video'); v.pause(); v.removeAttribute('src'); v.hidden = true;
  V.list = null;
}
function setViewerBar(name, sub, avatar) {
  $('#lb-name').textContent = name || '';
  $('#lb-sub').textContent = sub || '';
  $('#lb-avatar').innerHTML = avatar ? `<img src="${esc(avatar)}" alt="">` : esc((name || '?').charAt(0));
}
function showStill(src, pfp) {
  const v = $('#lightbox-video'); v.pause(); v.removeAttribute('src'); v.hidden = true;
  const img = $('#lightbox-img');
  img.hidden = false; img.src = src; img.classList.toggle('pfp', pfp);
  zReset();
}

// ---------- zoom in the viewer: pinch, double-tap (double-click) or the wheel, then drag about ----------
const Z = { s: 1, x: 0, y: 0, pts: new Map(), pinch: null, pan: null, tap: 0, tapAt: null };
const zImg = $('#lightbox-img');
function zApply(anim) {
  zImg.style.transition = anim ? 'transform .22s cubic-bezier(.2,.9,.3,1)' : 'none';
  zImg.style.transform = Z.s === 1 ? '' : 'translate(' + Z.x + 'px,' + Z.y + 'px) scale(' + Z.s + ')';
  zImg.classList.toggle('zoomed', Z.s > 1);
}
function zReset() { Z.s = 1; Z.x = 0; Z.y = 0; Z.pts.clear(); Z.pinch = Z.pan = null; zApply(false); }
// keep the picture covering what it can: no dragging it off into the dark
function zClamp() {
  const w = zImg.offsetWidth, h = zImg.offsetHeight;
  const mx = Math.max(0, (w * Z.s - innerWidth) / 2 + 16), my = Math.max(0, (h * Z.s - innerHeight) / 2 + 16);
  const ex = (w * (Z.s - 1)) / 2, ey = (h * (Z.s - 1)) / 2;
  Z.x = Math.max(-Math.max(mx, ex), Math.min(Math.max(mx, ex), Z.x));
  Z.y = Math.max(-Math.max(my, ey), Math.min(Math.max(my, ey), Z.y));
}
// zoom to `s` keeping the screen point (cx, cy) where it is
function zTo(s, cx, cy, anim) {
  s = Math.max(1, Math.min(5, s));
  const r = zImg.getBoundingClientRect();
  const ox = (r.left + r.right) / 2 - Z.x, oy = (r.top + r.bottom) / 2 - Z.y; // the untouched centre
  const ux = cx - ox, uy = cy - oy;
  Z.x = ux - (ux - Z.x) * (s / Z.s);
  Z.y = uy - (uy - Z.y) * (s / Z.s);
  Z.s = s;
  if (s === 1) { Z.x = 0; Z.y = 0; }
  zClamp();
  zApply(anim);
}
zImg.addEventListener('pointerdown', e => {
  try { zImg.setPointerCapture(e.pointerId); } catch { /* a pointer the browser no longer has */ }
  Z.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (Z.pts.size === 2) {
    const [a, b] = [...Z.pts.values()];
    Z.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: Z.s };
    Z.pan = null;
  } else if (Z.pts.size === 1) {
    Z.pan = { x: e.clientX, y: e.clientY, zx: Z.x, zy: Z.y };
    // a second tap close by and soon: zoom in there, or back out
    if (e.pointerType !== 'mouse' && Date.now() - Z.tap < 300 && Z.tapAt && Math.hypot(e.clientX - Z.tapAt.x, e.clientY - Z.tapAt.y) < 30) {
      zTo(Z.s > 1 ? 1 : 2.5, e.clientX, e.clientY, true);
      Z.tap = 0;
    } else { Z.tap = Date.now(); Z.tapAt = { x: e.clientX, y: e.clientY }; }
  }
});
zImg.addEventListener('pointermove', e => {
  if (!Z.pts.has(e.pointerId)) return;
  Z.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (Z.pinch && Z.pts.size >= 2) {
    const [a, b] = [...Z.pts.values()];
    zTo(Z.pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / (Z.pinch.d || 1), (a.x + b.x) / 2, (a.y + b.y) / 2, false);
  } else if (Z.pan && Z.s > 1) {
    Z.x = Z.pan.zx + e.clientX - Z.pan.x;
    Z.y = Z.pan.zy + e.clientY - Z.pan.y;
    zClamp();
    zApply(false);
  }
});
for (const t of ['pointerup', 'pointercancel']) zImg.addEventListener(t, e => {
  Z.pts.delete(e.pointerId);
  if (Z.pts.size < 2) Z.pinch = null;
  if (!Z.pts.size) { Z.pan = null; if (Z.s < 1.05) zTo(1, 0, 0, true); }
});
zImg.addEventListener('dblclick', e => zTo(Z.s > 1 ? 1 : 2.5, e.clientX, e.clientY, true));
zImg.addEventListener('wheel', e => { e.preventDefault(); zTo(Z.s * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY, false); }, { passive: false });


// every photo and video in the chat that has its file, oldest first
function chatMedia() {
  const out = [];
  S.chat.messages.forEach((m, i) => { if (m.a && !m.a.missing && (m.a.k === 'image' || m.a.k === 'video')) out.push(i); });
  return out;
}

function openMedia(index) {
  V.list = chatMedia();
  V.pos = Math.max(0, V.list.indexOf(index));
  $('#lightbox').classList.add('gallery');
  $('#lightbox').hidden = false;
  showMediaAt(V.pos);
}

function showMediaAt(pos) {
  if (!V.list || !V.list.length) return;
  V.pos = Math.max(0, Math.min(V.list.length - 1, pos));
  const i = V.list[V.pos], m = S.chat.messages[i], url = mediaUrl(m.a.f);
  const mine = m.s === S.chat.me;
  setViewerBar(mine ? 'You' : otherName(), `${fmtDate(m.t)} at ${fmtTime(m.t)}`, mine ? null : S.chat.avatarUrl);
  if (m.a.k === 'video') {
    $('#lightbox-img').hidden = true; $('#lightbox-img').removeAttribute('src');
    const v = $('#lightbox-video'); v.hidden = false; v.src = url; v.play().catch(() => {});
  } else showStill(url, false);
  $('#lb-caption').textContent = m.x || '';
  $('#lb-prev').hidden = V.pos === 0;
  $('#lb-next').hidden = V.pos === V.list.length - 1;
  renderStrip();
}

// thumbnails along the bottom, like WhatsApp
function renderStrip() {
  const strip = $('#lb-strip');
  const from = Math.max(0, V.pos - 25), to = Math.min(V.list.length, V.pos + 26);
  strip.innerHTML = V.list.slice(from, to).map((i, k) => {
    const m = S.chat.messages[i], p = from + k;
    return m.a.k === 'video'
      ? `<button class="thumb vid${p === V.pos ? ' on' : ''}" data-p="${p}"><video src="${mediaUrl(m.a.f)}#t=0.1" preload="metadata" muted></video></button>`
      : `<button class="thumb${p === V.pos ? ' on' : ''}" data-p="${p}"><img src="${mediaUrl(m.a.f)}" loading="lazy" alt=""></button>`;
  }).join('');
  strip.querySelector('.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
}

$('#lb-prev').onclick = () => showMediaAt(V.pos - 1);
$('#lb-next').onclick = () => showMediaAt(V.pos + 1);
$('#lb-strip').addEventListener('click', e => { const b = e.target.closest('[data-p]'); if (b) showMediaAt(+b.dataset.p); });
$('#lb-goto').onclick = () => {
  if (!V.list) return;
  const i = V.list[V.pos];
  closeViewer(); closeInfo();
  jumpTo(i);
};
document.addEventListener('keydown', e => {
  if ($('#lightbox').hidden || !V.list) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); showMediaAt(V.pos - 1); }
  if (e.key === 'ArrowRight') { e.preventDefault(); showMediaAt(V.pos + 1); }
});
// swipe between media on touch screens
(() => {
  let x0 = null;
  const stage = document.querySelector('.lb-stage');
  stage.addEventListener('touchstart', e => { x0 = e.touches.length === 1 && Z.s === 1 ? e.touches[0].clientX : null; }, { passive: true });
  stage.addEventListener('touchend', e => {
    if (x0 == null || !V.list || Z.s > 1 || e.touches.length) { if (!e.touches.length) x0 = null; return; }
    const dx = e.changedTouches[0].clientX - x0; x0 = null;
    if (Math.abs(dx) > 50) showMediaAt(V.pos + (dx < 0 ? 1 : -1));
  });
})();

function openInfo() {
  if (!S.chat) return;
  const c = S.chat, msgs = c.messages;
  const media = [];
  for (let k = msgs.length - 1; k >= 0 && media.length < 9; k--) {
    const m = msgs[k];
    if (m.a && !m.a.missing && m.a.k === 'image') media.push(k);
  }
  const counts = { image: 0, video: 0, audio: 0, document: 0, sticker: 0 };
  let links = 0;
  for (const m of msgs) { if (m.a && !m.a.missing) counts[m.a.k]++; if (/https?:\/\//.test(m.x || '')) links++; }
  const total = counts.image + counts.video + counts.document + links;
  $('#info-body').innerHTML = `
    <div class="info-card info-top">
      <div class="info-photo-wrap">
        <button class="info-photo" id="info-photo" title="${c.avatarUrl ? 'View photo' : 'Add a photo'}">${c.avatarUrl ? `<img src="${esc(c.avatarUrl)}" alt="">` : `<span>${esc(otherName().charAt(0))}</span>`}</button>
        <button class="photo-edit" id="info-photo-edit" title="Change photo"><svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg></button>
      </div>
      <div class="editable" data-field="contactName">
        <div class="info-name" dir="auto">${esc(otherName())}</div>
        <button class="pencil" title="Edit name">${PENCIL}</button>
      </div>
      <div class="info-sub">${esc(c.title)}</div>
    </div>
    <div class="info-card">
      <div class="info-row"><span>About</span></div>
      <div class="editable about" data-field="bio">
        <div class="info-about${c.bio ? '' : ' empty'}" dir="auto">${c.bio ? esc(c.bio) : 'Add a few words about them'}</div>
        <button class="pencil" title="Edit about">${PENCIL}</button>
      </div>
    </div>
    <div class="info-card">
      <button class="info-row info-link" id="info-all"><span>Media, links and docs</span><span class="muted">${total.toLocaleString()} ›</span></button>
      <button class="info-row info-link" id="info-starred"><span>Starred messages</span><span class="muted">${msgs.filter(m => !m.sys && isStarred(m)).length.toLocaleString()} ›</span></button>
      <div class="info-grid">${media.map(k => `<img src="${mediaUrl(msgs[k].a.f)}" data-k="${k}" loading="lazy" alt="">`).join('')}</div>
    </div>
    <div class="info-card info-stats">
      <div><span class="muted">Messages</span><b>${msgs.length.toLocaleString()}</b></div>
      <div><span class="muted">Voice notes</span><b>${counts.audio.toLocaleString()}</b></div>
      <div><span class="muted">Photos</span><b>${counts.image.toLocaleString()}</b></div>
      <div><span class="muted">First message</span><b>${msgs.length ? fmtDate(msgs[0].t) : '—'}</b></div>
      <div><span class="muted">Last message</span><b>${msgs.length ? fmtDate(msgs[msgs.length - 1].t) : '—'}</b></div>
    </div>`;
  $('#info-panel').hidden = false;
}
function closeInfo() { $('#info-panel').hidden = true; }

document.querySelector('.chat-head').addEventListener('click', e => {
  if (e.target.closest('#chat-avatar, .chat-titles')) openInfo();
});
$('#info-close').onclick = closeInfo;
$('#info-body').addEventListener('click', e => {
  if (e.target.closest('#info-photo-edit') || (e.target.closest('#info-photo') && !S.chat.avatarUrl)) { changePhoto(); return; }
  if (e.target.closest('#info-photo')) {
    openViewer(S.chat.avatarUrl, { name: otherName(), sub: 'Profile photo', avatar: S.chat.avatarUrl, pfp: true });
  }
  const pen = e.target.closest('.pencil');
  if (pen) { editField(pen.closest('.editable')); return; }
  const img = e.target.closest('[data-k]');
  if (img) { openMedia(+img.dataset.k); return; }
  if (e.target.closest('#info-all')) openGallery();
  if (e.target.closest('#info-starred')) openStarred();
  if (e.target.closest('#gallery-back')) openInfo();
});

const PENCIL = '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></svg>';

async function changePhoto() {
  try {
    const url = await api.setAvatar(S.chatId);
    if (!url) return;
    S.chat.avatarUrl = url;
    $('#chat-avatar').outerHTML = avatarHtml(url, S.chat.title, 'chat-avatar');
    await refreshChats();
    openInfo();
    renderWindow();
    toast('Profile photo updated');
  } catch (err) { toast(err.message); }
}

// inline editing for the contact's name and About, saved with the chat
function editField(box) {
  const field = box.dataset.field, multi = field === 'bio';
  const current = field === 'bio' ? (S.chat.bio || '') : otherName();
  box.innerHTML = multi
    ? `<textarea class="edit-input" rows="3" maxlength="700" dir="auto" placeholder="Add a few words about them">${esc(current)}</textarea>`
    : `<input class="edit-input" maxlength="80" dir="auto" value="${esc(current)}">`;
  box.insertAdjacentHTML('beforeend', '<div class="edit-actions"><button class="ghost" data-cancel>Cancel</button><button class="primary" data-save>Save</button></div>');
  const input = box.querySelector('.edit-input');
  input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  const save = async () => {
    try {
      const r = await api.setProfile(S.chatId, { [field]: input.value });
      S.chat.contactName = r.contactName || undefined;
      S.chat.bio = r.bio || undefined;
      openInfo();
      if (field === 'contactName') renderWindow();
    } catch (err) { toast(err.message); }
  };
  box.querySelector('[data-save]').onclick = save;
  box.querySelector('[data-cancel]').onclick = () => openInfo();
  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); openInfo(); }
    if (e.key === 'Enter' && (!multi || e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
  });
}

// all photos and videos, newest first, in the contact panel (WhatsApp's "Media" tab)
function openGallery() {
  const list = chatMedia().reverse();
  const byMonth = [];
  for (const i of list) {
    const d = new Date(S.chat.messages[i].t), key = `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    if (!byMonth.length || byMonth[byMonth.length - 1].key !== key) byMonth.push({ key, items: [] });
    byMonth[byMonth.length - 1].items.push(i);
  }
  $('#info-body').innerHTML = `<div class="info-card gallery-head"><button class="icon-btn" id="gallery-back" title="Back"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6" /></svg></button><span>Media · ${list.length.toLocaleString()}</span></div>` +
    byMonth.map(g => `<div class="info-card"><div class="info-row"><span>${g.key}</span></div><div class="info-grid">${g.items.map(i => {
      const m = S.chat.messages[i];
      return m.a.k === 'video'
        ? `<div class="gthumb vid" data-k="${i}"><video src="${mediaUrl(m.a.f)}#t=0.1" preload="metadata" muted></video></div>`
        : `<img src="${mediaUrl(m.a.f)}" data-k="${i}" loading="lazy" alt="">`;
    }).join('')}</div></div>`).join('');
  $('#info-body').scrollTop = 0;
}
// voice-note avatars open the photo too
document.addEventListener('click', e => {
  const img = e.target.closest('.v-avatar img');
  if (!img) return;
  e.stopPropagation();
  openViewer(img.src, { name: otherName(), sub: 'Profile photo', avatar: img.src, pfp: true });
}, true);
$('#lb-close').onclick = closeViewer;
$('#to-bottom').onclick = () => { S.hi = S.chat.messages.length; S.lo = Math.max(0, S.hi - CHUNK); renderWindow(); stickToBottom(); };

$('#jump-date').onchange = e => {
  if (!e.target.value || !S.chat) return;
  const [y, mo, da] = e.target.value.split('-').map(Number);
  const t = Date.UTC(y, mo - 1, da);
  const msgs = S.chat.messages;
  let lo = 0, hi = msgs.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (msgs[mid].t < t) lo = mid + 1; else hi = mid; }
  if (lo >= msgs.length) lo = msgs.length - 1;
  jumpTo(lo);
  if (dayKey(msgs[lo].t) !== dayKey(t)) toast(`Nothing on that day — showing ${fmtDate(msgs[lo].t)}`);
};

// ---------- search ----------
function openSearch() { if (!S.chat) return; $('#searchbar').hidden = false; $('#search-input').focus(); $('#search-input').select(); }
function closeSearch() { $('#searchbar').hidden = true; if (S.search.q) { S.search = { q: '', hits: [], pos: -1 }; const keep = currentIndex(); jumpTo(keep, false); } }
function currentIndex() { const n = $('#messages [data-i]'); return n ? +n.dataset.i : 0; }
let searchTimer;
$('#search-input').oninput = e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const q = e.target.value.trim();
    S.search.q = q;
    S.search.hits = [];
    if (q) {
      const lq = q.toLowerCase();
      S.chat.messages.forEach((m, i) => { if (m.x && m.x.toLowerCase().includes(lq)) S.search.hits.push(i); });
    }
    S.search.pos = S.search.hits.length - 1;
    $('#search-count').textContent = q ? (S.search.hits.length ? `${S.search.hits.length} found` : 'No matches') : '';
    if (S.search.hits.length) showHit(); else renderWindow();
  }, 180);
};
function showHit() {
  const s = S.search;
  $('#search-count').textContent = `${s.pos + 1} of ${s.hits.length}`;
  jumpTo(s.hits[s.pos], false);
}
function stepSearch(dir) {
  const s = S.search; if (!s.hits.length) return;
  s.pos = (s.pos + dir + s.hits.length) % s.hits.length;
  showHit();
}
$('#search-input').onkeydown = e => {
  if (e.key === 'Enter') { e.preventDefault(); stepSearch(e.shiftKey ? 1 : -1); }
  if (e.key === 'Escape') closeSearch();
};
$('#search-prev').onclick = () => stepSearch(-1);
$('#search-next').onclick = () => stepSearch(1);
$('#search-close').onclick = closeSearch;
$('#btn-search').onclick = openSearch;

// ---------- chat menu ----------
$('#btn-menu').onclick = e => { e.stopPropagation(); $('#chat-menu').hidden = !$('#chat-menu').hidden; };
document.addEventListener('click', () => { $('#chat-menu').hidden = true; });
$('#chat-menu').onclick = async e => {
  const act = e.target.dataset.act; if (!act) return;
  $('#chat-menu').hidden = true;
  if (act === 'add') startImport(S.chatId);
  if (act === 'export') startExport();
  if (act === 'first') jumpTo(0, false);
  if (act === 'starred') openStarred();
  if (act === 'date') { const d = $('#jump-date'); try { d.showPicker(); } catch { d.focus(); d.click(); } }
  if (act === 'avatar') {
    const url = await api.setAvatar(S.chatId);
    if (url) { await refreshChats(); openChat(S.chatId); }
  }
  if (act === 'rename') {
    modal(`<h2>Rename chat</h2><div class="field"><input type="text" id="rn" value="${esc(S.chat.title)}"></div>
      <div class="modal-actions"><button class="ghost" data-close>Cancel</button><button class="primary" id="rn-ok">Save</button></div>`);
    $('#rn').focus();
    $('#rn-ok').onclick = async () => { const t = $('#rn').value.trim(); if (!t) return; await api.renameChat(S.chatId, t); closeModal(); await refreshChats(); openChat(S.chatId); };
  }
  if (act === 'me') {
    const opts = S.chat.participants.map((p, i) => `<label class="opt"><input type="radio" name="me" value="${i}" ${i === S.chat.me ? 'checked' : ''}> <span dir="auto">${esc(p.name)}</span></label>`).join('');
    modal(`<h2>Which side is you?</h2><p class="muted">Your messages show on the right in green.</p><div class="field">${opts}</div>
      <div class="modal-actions"><button class="ghost" data-close>Cancel</button><button class="primary" id="me-ok">Save</button></div>`);
    $('#me-ok').onclick = async () => { const v = document.querySelector('input[name=me]:checked'); if (!v) return; await api.setMe(S.chatId, +v.value); closeModal(); openChat(S.chatId); };
  }
  if (act === 'remove') {
    if (await api.deleteChat(S.chatId)) { backToList(); S.chatId = null; S.chat = null; await refreshChats(); showView('empty'); }
  }
};

// ---------- writing (never delivered) ----------
const compose = $('#compose');
const fitCompose = () => {
  compose.style.height = 'auto';
  compose.style.height = Math.min(compose.scrollHeight, 140) + 'px';
  const has = !!compose.value.trim();
  $('#send').disabled = false;
  $('#send').title = has ? 'Send (Enter) · it stays here, never delivered' : 'Record a voice note';
  document.querySelector('.composer').classList.toggle('typing', has);
};

// emoji picker, like WhatsApp's
const EMOJI = '😀 😁 😂 🤣 😊 😍 🥰 😘 😅 😭 😢 🥺 😩 😤 😡 🤬 😳 😱 🙄 😏 😌 😴 🤔 🤭 🫠 🤍 🖤 ❤️ 💔 ❤️‍🩹 💕 💗 🌹 🌙 ⭐ ✨ 🔥 💯 👍 👎 👏 🙏 🤝 👀 🫶 🤲 💪 ☠️ 💀 😶 😐 😑 🙃 😇 🤗 🤡 👻 🎉 🎶 🎧 📚 ☕ 🍕 🌊 🏖️ 🚗 ✈️ 📸 💬 ✔️'.split(' ');
const emojiHtml = EMOJI.map(e => `<button data-e="${e}">${e}</button>`).join('');
$('#ep-body').innerHTML = emojiHtml;
$('#ep-body').className = 'ep-body emoji';
document.querySelector('.ep-tabs').addEventListener('click', async e => {
  e.stopPropagation();
  const t = e.target.closest('[data-tab]'); if (!t) return;
  document.querySelectorAll('.ep-tabs button').forEach(b => b.classList.toggle('on', b === t));
  const body = $('#ep-body');
  if (t.dataset.tab === 'emoji') { body.className = 'ep-body emoji'; body.innerHTML = emojiHtml; return; }
  body.className = 'ep-body stickers'; body.innerHTML = '<div class="ep-empty">Loading stickers…</div>';
  const list = await api.listStickers();
  body.innerHTML = list.length
    ? list.map(s => `<button data-sticker="${esc(s.f)}" data-from="${esc(s.chatId)}"><img src="${esc(s.url)}" loading="lazy" alt=""></button>`).join('')
    : '<div class="ep-empty">No stickers in your imported chats yet.</div>';
});
$('#emoji-btn').onclick = e => { e.stopPropagation(); $('#emoji-panel').hidden = !$('#emoji-panel').hidden; if (!$('#emoji-panel').hidden) compose.focus(); };
$('#emoji-panel').addEventListener('click', e => {
  e.stopPropagation();
  const st = e.target.closest('[data-sticker]');
  if (st) { $('#emoji-panel').hidden = true; sendWith(() => api.sendSticker(S.chatId, st.dataset.from, st.dataset.sticker)); return; }
  const b = e.target.closest('[data-e]'); if (!b) return;
  const s = compose.selectionStart ?? compose.value.length, en = compose.selectionEnd ?? s;
  compose.value = compose.value.slice(0, s) + b.dataset.e + compose.value.slice(en);
  compose.selectionStart = compose.selectionEnd = s + b.dataset.e.length;
  compose.focus(); fitCompose();
});
document.addEventListener('click', e => { if (!e.target.closest('#emoji-panel, #emoji-btn')) $('#emoji-panel').hidden = true; });
compose.addEventListener('input', fitCompose);
fitCompose(); // start with the mic showing
compose.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendLocal(); } });
$('#send').onclick = () => { if (compose.value.trim()) sendLocal(); else if (rec) stopRecording(true); else startRecording(); };
$('#attach-btn').onclick = () => sendWith(() => api.attachFiles(S.chatId));

// adds undelivered messages to the open chat and shows them at the bottom
async function sendWith(fn) {
  if (!S.chat) return;
  try {
    const r = await fn();
    const msgs = Array.isArray(r) ? r : r ? [r] : [];
    if (!msgs.length) return;
    S.chat.messages.push(...msgs);
    S.hi = S.chat.messages.length; S.lo = Math.max(0, S.hi - CHUNK);
    renderWindow(); stickToBottom(); refreshChats();
  } catch (err) { toast(err.message); }
}

// ---------- voice notes you record (they stay here, never delivered) ----------
let rec = null;
async function startRecording() {
  if (!S.chat) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find(t => MediaRecorder.isTypeSupported(t)) || '';
    const mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks = [];
    mr.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    rec = { mr, stream, chunks, keep: false, elapsed: 0, since: Date.now(), paused: false };
    const secs = () => (rec.elapsed + (rec.paused ? 0 : Date.now() - rec.since)) / 1000;
    rec.timer = setInterval(() => { if (rec) $('#rec-time').textContent = fmtDur(secs()); }, 200);
    // live waveform from the microphone level, like WhatsApp: bars while you speak, dots in silence
    const wave = $('#rec-wave'); wave.innerHTML = '';
    try {
      const ac = new AudioContext(), an = ac.createAnalyser();
      an.fftSize = 512;
      ac.createMediaStreamSource(stream).connect(an);
      const buf = new Uint8Array(an.fftSize);
      rec.ac = ac;
      rec.levels = setInterval(() => {
        if (!rec || rec.paused) return;
        an.getByteTimeDomainData(buf);
        let sum = 0; for (const v of buf) sum += (v - 128) * (v - 128);
        const rms = Math.sqrt(sum / buf.length) / 128;
        const bar = document.createElement('i');
        const h = Math.min(1, rms * 4.5);
        if (h < 0.06) bar.className = 'dot'; else bar.style.height = Math.round(18 + h * 82) + '%';
        wave.append(bar);
        const max = Math.floor(wave.clientWidth / 5);
        while (wave.children.length > max && max > 0) wave.firstChild.remove();
      }, 90);
    } catch { /* waveform is decoration only */ }
    mr.onstop = async () => {
      const r = rec; rec = null;
      clearInterval(r.timer); clearInterval(r.levels);
      try { r.ac && r.ac.close(); } catch { /* already closed */ }
      r.stream.getTracks().forEach(t => t.stop());
      document.querySelector('.composer').classList.remove('rec-paused');
      document.querySelector('.composer').classList.remove('recording');
      $('#rec-bar').hidden = true; $('#rec-time').textContent = '0:00';
      if (!r.keep || !r.chunks.length) return;
      const blob = new Blob(r.chunks, { type: r.chunks[0].type || 'audio/webm' });
      // desktop sends bytes over IPC; the phone build stores the Blob directly
      const payload = window.DeadChat && !window.require ? (document.documentElement.classList.contains('web') ? blob : new Uint8Array(await blob.arrayBuffer())) : new Uint8Array(await blob.arrayBuffer());
      sendWith(() => api.sendVoice(S.chatId, payload));
    };
    mr.start(250);
    document.querySelector('.composer').classList.add('recording');
    $('#rec-bar').hidden = false;
  } catch (err) { toast('Microphone not available: ' + err.message); }
}
function stopRecording(keep) { if (!rec) return; rec.keep = keep; if (rec.mr.state === 'paused') rec.mr.resume(); rec.mr.stop(); }
$('#rec-cancel').onclick = () => stopRecording(false);
$('#rec-send').onclick = () => stopRecording(true);
$('#rec-pause').onclick = () => {
  if (!rec) return;
  const comp = document.querySelector('.composer');
  if (rec.paused) { rec.mr.resume(); rec.paused = false; rec.since = Date.now(); }
  else { rec.mr.pause(); rec.paused = true; rec.elapsed += Date.now() - rec.since; }
  comp.classList.toggle('rec-paused', rec.paused);
  $('#rec-pause .lbl').textContent = rec.paused ? 'Resume' : 'Pause';
};

async function sendLocal() {
  const text = compose.value.replace(/\s+$/, '');
  if (!text.trim() || !S.chat) return;
  try {
    const msg = await api.writeMessage(S.chatId, text);
    compose.value = ''; fitCompose();
    S.chat.messages.push(msg);
    S.hi = S.chat.messages.length; S.lo = Math.max(0, S.hi - CHUNK);
    renderWindow(); scrollToBottom();
    refreshChats();
  } catch (err) { toast(err.message); }
}

// a message's menu: right-click it, or long-press it on a phone. Star any message; take back one
// written here.
function msgMenu(row, x, y) {
  closeCtx();
  const i = +row.dataset.i, m = S.chat.messages[i];
  const menu = el('div', 'ctx', '<button data-star>' + (isStarred(m) ? 'Unstar' : 'Star') + '</button>' +
    (m.x ? '<button data-copy>Copy text</button>' : '') + (row.dataset.uid ? '<button class="danger" data-del>Delete this message</button>' : ''));
  document.body.append(menu);
  menu.style.left = Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8)) + 'px';
  menu.onclick = async ev => {
    if (ev.target.closest('[data-star]')) toggleStar(i);
    if (ev.target.closest('[data-copy]')) api.copyText(m.x || '');
    if (ev.target.closest('[data-del]')) {
      if (playingIdx === i) stopAudio();
      else if (playingIdx != null && playingIdx > i) playingIdx--;
      await api.unwriteMessage(S.chatId, row.dataset.uid);
      S.chat.messages.splice(i, 1);
      S.hi = Math.min(S.hi, S.chat.messages.length);
      const keep = Math.max(0, i - 1); renderWindow(); $(`#messages [data-i="${keep}"]`)?.scrollIntoView({ block: 'center' });
      refreshChats();
    }
    closeCtx();
  };
}
$('#messages').addEventListener('contextmenu', e => {
  const row = e.target.closest('.msg[data-i]');
  closeCtx();
  if (!row || e.target.closest('a, input, textarea')) return;
  e.preventDefault();
  if (Date.now() - pressedAt < 800) return; // the long press already opened it
  msgMenu(row, e.clientX, e.clientY);
});
let pressTimer = 0, pressedAt = 0, pressAt = null;
$('#messages').addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse') return;
  const row = e.target.closest('.msg[data-i]');
  if (!row || e.target.closest('.wave, button, a, video')) return;
  pressAt = { x: e.clientX, y: e.clientY };
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => { pressedAt = Date.now(); try { navigator.vibrate && navigator.vibrate(12); } catch {} msgMenu(row, pressAt.x, pressAt.y); }, 480);
});
for (const t of ['pointerup', 'pointercancel']) $('#messages').addEventListener(t, () => clearTimeout(pressTimer));
$('#messages').addEventListener('pointermove', e => { if (pressAt && Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) > 10) clearTimeout(pressTimer); });
$('#messages').addEventListener('scroll', () => clearTimeout(pressTimer), { passive: true });
function closeCtx() { document.querySelectorAll('.ctx').forEach(m => m.remove()); }
document.addEventListener('click', e => { if (!e.target.closest('.ctx')) closeCtx(); });

// ---------- export ----------
function startExport() {
  const undelivered = S.chat.messages.filter(m => m.u).length;
  modal(`<h2>Export chat</h2>
    <p class="muted">Saves a WhatsApp-style export (.zip with the chat .txt and media) that DeadChat, or another viewer, can open again.</p>
    <label class="chk"><input type="checkbox" id="ex-media" checked><span>Include media<small>Voice notes, photos, stickers and videos (about the size of the library).</small></span></label>
    <label class="chk"><input type="checkbox" id="ex-u" ${undelivered ? 'checked' : 'disabled'}><span>Include messages written in DeadChat<small>${undelivered ? `${undelivered} undelivered message${undelivered === 1 ? '' : 's'}. In the export they look like normal messages from you.` : 'You haven\'t written any yet.'}</small></span></label>
    <div class="modal-actions"><button class="ghost" data-close>Cancel</button><button class="primary" id="ex-go">Export…</button></div>`);
  $('#ex-go').onclick = async () => {
    const opts = { includeMedia: $('#ex-media').checked, includeUndelivered: $('#ex-u').checked };
    modal('<h2>Exporting…</h2><p class="muted">Writing the zip. With media this can take a minute.</p>');
    try {
      const r = await api.exportChat(S.chatId, opts);
      if (!r) { closeModal(); return; }
      modal(`<h2>Exported</h2><div class="stat"><span>Messages</span><span>${r.messages.toLocaleString()}</span>
        <span>Media files</span><span>${r.media.toLocaleString()}</span></div><p class="muted" dir="auto">${esc(r.file)}</p>
        <div class="modal-actions"><button class="primary" data-close>Done</button></div>`);
    } catch (err) { modal(`<h2>Export failed</h2><p>${esc(err.message)}</p><div class="modal-actions"><button class="primary" data-close>OK</button></div>`); }
  };
}

// ================= import =================

function modal(html) { $('#modal-card').innerHTML = html; $('#modal').hidden = false; }
function closeModal() { $('#modal').hidden = true; $('#modal-card').innerHTML = ''; }
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal(); });

function startImport(intoChatId = null) {
  modal(`<h2>${intoChatId ? 'Add another export to this chat' : 'Import a WhatsApp export'}</h2>
    <p class="muted">Pick the <b>.zip</b> WhatsApp made, the exported <b>.txt</b>, or a folder holding the .txt with its media.
    Your files are only read, never changed.${intoChatId ? ' Messages already in the chat are skipped, and missing media gets filled in.' : ''}</p>
    <div class="modal-actions"><button class="ghost" data-close>Cancel</button>
    <button class="ghost" id="pick-folder">Choose folder…</button><button class="primary" id="pick-file">Choose .zip or .txt…</button></div>`);
  const go = async kind => {
    const src = await api.pickSource(kind);
    if (!src) return;
    modal('<h2>Reading…</h2><p class="muted">Parsing the chat.</p>');
    try { previewImport(src, intoChatId, await api.previewSource(src, intoChatId)); }
    catch (err) { modal(`<h2>Couldn't read that</h2><p>${esc(err.message)}</p><div class="modal-actions"><button class="primary" data-close>OK</button></div>`); }
  };
  $('#pick-file').onclick = () => go('file');
  $('#pick-folder').onclick = () => go('folder');
}

function previewImport(src, intoChatId, pv) {
  const meOpts = pv.senders.map((s, i) => `<label class="opt"><input type="radio" name="me" value="${i}" ${i === pv.senders.length - 1 ? 'checked' : ''}>
    <span dir="auto">${esc(s)}</span><span class="muted">· ${pv.counts[i].toLocaleString()} messages</span></label>`).join('');
  let target = '';
  if (intoChatId) {
    const parts = S.chat.participants;
    target = `<div class="field"><span class="fl">Match people in this export to the chat</span>${pv.senders.map((s, i) => `
      <div class="map-row"><span dir="auto">${esc(s)}</span><select data-map="${i}">
      ${parts.map((p, j) => `<option value="${j}" ${pv.suggested[i] === j ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
      <option value="-1" ${pv.suggested[i] < 0 ? 'selected' : ''}>Someone new</option></select></div>`).join('')}</div>`;
  } else {
    const title = pv.name.replace(/^WhatsApp Chat (with|-)\s*/i, '').trim() || 'Chat';
    target = `<div class="field"><span class="fl">Chat name</span><input type="text" id="imp-title" value="${esc(title)}"></div>`;
  }
  modal(`<h2>${esc(pv.name)}</h2>
    <div class="stat"><span>Messages</span><span>${pv.total.toLocaleString()}</span>
    <span>From</span><span>${pv.from ? fmtDate(pv.from) : '—'}</span><span>To</span><span>${pv.to ? fmtDate(pv.to) : '—'}</span>
    <span>Media files referenced</span><span>${pv.attachments.toLocaleString()}</span>
    <span>Media left out of export</span><span>${pv.omitted.toLocaleString()}</span></div>
    <div class="field"><span class="fl">Which one is you?</span>${meOpts}</div>${target}
    <div class="modal-actions"><button class="ghost" data-close>Cancel</button><button class="primary" id="imp-go">Import</button></div>`);
  $('#imp-go').onclick = async () => {
    const opts = { meIndex: +document.querySelector('input[name=me]:checked').value };
    if (intoChatId) {
      opts.chatId = intoChatId;
      opts.mapping = pv.senders.map((_, i) => +document.querySelector(`[data-map="${i}"]`).value);
    } else opts.title = $('#imp-title').value.trim() || pv.name;
    modal('<h2>Importing…</h2><p class="muted">Copying the chat and its media into DeadChat. Large exports can take a minute.</p>');
    try {
      const r = await api.runImport(src, opts);
      await refreshChats();
      modal(`<h2>Done</h2><div class="stat">
        <span>New messages</span><span>${r.added.toLocaleString()}</span>
        <span>Already there (skipped)</span><span>${r.duplicates.toLocaleString()}</span>
        <span>Media filled in</span><span>${r.upgraded.toLocaleString()}</span>
        <span>Media files copied</span><span>${r.copied.toLocaleString()}</span>
        <span>Media still missing</span><span>${r.missing.toLocaleString()}</span>
        <span>Chat total</span><span>${r.total.toLocaleString()}</span></div>
        <div class="modal-actions"><button class="primary" data-close>Open chat</button></div>`);
      openChat(r.id);
    } catch (err) {
      modal(`<h2>Import failed</h2><p>${esc(err.message)}</p><div class="modal-actions"><button class="primary" data-close>OK</button></div>`);
    }
  };
}

// ================= wiring =================

$('#btn-import').onclick = () => startImport();
$('#btn-import-empty').onclick = () => startImport();
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); openSearch(); }
  if (e.key === 'Escape') { if (!$('#lightbox').hidden) closeViewer(); else if (!$('#modal').hidden) closeModal(); else closeInfo(); }
  if (e.key === ' ' && playingIdx != null && !['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)) { e.preventDefault(); player.paused ? player.play() : player.pause(); }
});

(async () => {
  await refreshChats();
  if (S.chats.length && !isPhone()) openChat(S.chats[0].id);
})();

// back arrow (phones) and the Android back button: step back one screen at a time
$('#chat-back').onclick = backToList;
window.addEventListener('dc-back', () => {
  if (!$('#lightbox').hidden) closeViewer();
  else if (!$('#modal').hidden) closeModal();
  else if (!$('#info-panel').hidden) closeInfo();
  else if (isPhone() && document.body.classList.contains('chat-open')) backToList();
  else window.Capacitor?.Plugins?.App?.exitApp();
});
