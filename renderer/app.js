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
const fmtDay = t => `${DAYS[d(t).getUTCDay()]}, ${fmtDate(t)}`;
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

async function openChat(id) {
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
    else if (a.k === 'audio') body = voiceHtml(i);
    else body = `<div class="doc" data-open="${esc(a.f)}">📄 <span class="doc-name">${esc(a.f)}</span></div>`;
    b.innerHTML = body + (m.x ? `<div class="text caption" dir="auto">${linkify(m.x)}</div>` : '') + meta;
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

function scrollToBottom() { const box = $('#messages'); box.scrollTop = box.scrollHeight; }

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

function onScroll() {
  const box = $('#messages'), n = S.chat ? S.chat.messages.length : 0;
  if (!S.chat || loading) return;
  $('#to-bottom').hidden = S.hi === n && box.scrollHeight - box.scrollTop - box.clientHeight < 400;
  loading = true;
  try {
    if (box.scrollTop < 600 && S.lo > 0) {
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
    } else if (box.scrollHeight - box.scrollTop - box.clientHeight < 600 && S.hi < n) {
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

function voiceHtml(i) {
  const m = S.chat.messages[i], dur = durations.get(i), playing = playingIdx === i;
  const name = (S.chat.participants[m.s]?.name || '?').normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '');
  const bars = waveBars(m.a.f).map(v => `<i class="h${Math.round(v / 10)}"></i>`).join('');
  return `<div class="voice${playing ? ' playing' : ''}" data-voice="${i}">
    <button class="play" title="Play">${playing && !player.paused ? PAUSE : PLAY}</button>
    <div class="v-main">
      <div class="wave" title="Seek">${bars}<span class="dot"></span></div>
      <div class="v-time">${playing ? fmtDur(player.currentTime) : dur ? fmtDur(dur) : '0:00'}</div>
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
  const v = voiceNode(playingIdx); if (!v) return;
  v.classList.add('playing');
  v.querySelector('.play').innerHTML = player.paused ? PLAY : PAUSE;
  const dur = player.duration;
  if (isFinite(dur) && dur > 0) setWave(v, player.currentTime / dur);
  v.querySelector('.v-time').textContent = fmtDur(player.currentTime);
}

function resetVoiceUI(i) {
  const v = voiceNode(i); if (!v) return;
  v.classList.remove('playing');
  v.querySelector('.play').innerHTML = PLAY;
  setWave(v, 0);
  const d = durations.get(i);
  v.querySelector('.v-time').textContent = d ? fmtDur(d) : '0:00';
}

function playVoice(i, seekFrac) {
  const m = S.chat.messages[i];
  if (playingIdx !== i) {
    if (playingIdx != null) resetVoiceUI(playingIdx);
    playingIdx = i;
    player.src = mediaUrl(m.a.f);
    player.playbackRate = speed;
  }
  if (seekFrac != null) {
    const go = () => { if (isFinite(player.duration)) player.currentTime = seekFrac * player.duration; };
    if (player.readyState >= 1) go(); else player.addEventListener('loadedmetadata', go, { once: true });
  }
  player.play().catch(err => toast('Could not play this voice note: ' + err.message));
}

function stopAudio() { player.pause(); if (playingIdx != null) resetVoiceUI(playingIdx); playingIdx = null; }

player.addEventListener('timeupdate', updateVoiceUI);
player.addEventListener('play', updateVoiceUI);
player.addEventListener('pause', updateVoiceUI);
player.addEventListener('loadedmetadata', () => { if (playingIdx != null) durations.set(playingIdx, player.duration); updateVoiceUI(); });
player.addEventListener('ended', () => {
  const done = playingIdx;
  resetVoiceUI(done);
  playingIdx = null;
  // like WhatsApp: roll straight into the next voice note if it comes right after
  const next = S.chat?.messages[done + 1];
  if (next && next.a && next.a.k === 'audio' && !next.a.missing) {
    if (!voiceNode(done + 1)) jumpTo(done + 1, false);
    voiceNode(done + 1)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    playVoice(done + 1);
  }
});

// fetch durations lazily for voice notes that scroll into view
const durObserver = new IntersectionObserver(entries => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const i = +e.target.dataset.voice;
    durObserver.unobserve(e.target);
    if (durations.has(i) || !S.chat) continue;
    const probe = new Audio(); probe.preload = 'metadata';
    probe.addEventListener('loadedmetadata', () => {
      durations.set(i, probe.duration);
      const v = voiceNode(i); if (v && playingIdx !== i) v.querySelector('.v-time').textContent = fmtDur(probe.duration);
      probe.src = '';
    }, { once: true });
    probe.src = mediaUrl(S.chat.messages[i].a.f);
  }
}, { root: null, rootMargin: '200px' });

function observeVoices() {
  document.querySelectorAll('#messages [data-voice]').forEach(v => { if (!durations.has(+v.dataset.voice)) durObserver.observe(v); });
  if (playingIdx != null) updateVoiceUI();
}

// ---------- message interactions ----------
$('#messages').addEventListener('click', e => {
  const t = e.target;
  const voice = t.closest('[data-voice]');
  if (voice) {
    const i = +voice.dataset.voice;
    if (t.closest('.play')) { if (playingIdx === i && !player.paused) player.pause(); else playVoice(i); }
    else if (t.closest('.wave')) {
      const r = t.closest('.wave').getBoundingClientRect();
      playVoice(i, Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
    }
    else if (t.closest('.speed')) {
      speed = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1;
      store.set('speed', speed); player.playbackRate = speed;
      document.querySelectorAll('.voice .speed').forEach(s => (s.textContent = speed + '×'));
    }
    return;
  }
  if (t.matches('.media-img')) {
    const m = S.chat.messages[+t.closest('[data-i]').dataset.i];
    openViewer(t.src, { name: m.s === S.chat.me ? 'You' : otherName(), sub: `${fmtDate(m.t)} at ${fmtTime(m.t)}`, avatar: m.s === S.chat.me ? null : S.chat.avatarUrl });
    return;
  }
  const doc = t.closest('[data-open]');
  if (doc) { api.openMedia(S.chatId, doc.dataset.open).catch(err => toast(err.message)); return; }
  const a = t.closest('a[data-href]');
  if (a) { api.openLink(a.dataset.href); }
});
$('#messages').addEventListener('scroll', onScroll, { passive: true });
$('#lightbox').onclick = e => { if (!e.target.closest('#lightbox-img, .lb-bar')) closeViewer(); };
// ---------- contact info + photo viewer (like WhatsApp) ----------
function otherIndex() { return S.chat.participants.findIndex((_, k) => k !== S.chat.me); }
function otherName() { return S.chat.participants[otherIndex()]?.name || S.chat.title; }

function openViewer(src, { name, sub, avatar, pfp } = {}) {
  $('#lightbox-img').src = src;
  $('#lightbox-img').classList.toggle('pfp', !!pfp);
  $('#lb-name').textContent = name || '';
  $('#lb-sub').textContent = sub || '';
  $('#lb-avatar').innerHTML = avatar ? `<img src="${esc(avatar)}" alt="">` : esc((name || '?').charAt(0));
  $('#lightbox').hidden = false;
}
function closeViewer() { $('#lightbox').hidden = true; $('#lightbox-img').removeAttribute('src'); }

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
      <button class="info-photo" id="info-photo">${c.avatarUrl ? `<img src="${esc(c.avatarUrl)}" alt="">` : `<span>${esc(otherName().charAt(0))}</span>`}</button>
      <div class="info-name" dir="auto">${esc(otherName())}</div>
      <div class="info-sub">${esc(c.title)}</div>
    </div>
    <div class="info-card">
      <div class="info-row"><span>Media, links and docs</span><span class="muted">${total.toLocaleString()}</span></div>
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
  if (e.target.closest('#info-photo') && S.chat.avatarUrl) {
    openViewer(S.chat.avatarUrl, { name: otherName(), sub: 'Profile photo', avatar: S.chat.avatarUrl, pfp: true });
  }
  const img = e.target.closest('img[data-k]');
  if (img) {
    const m = S.chat.messages[+img.dataset.k];
    openViewer(img.src, { name: m.s === S.chat.me ? 'You' : otherName(), sub: `${fmtDate(m.t)} at ${fmtTime(m.t)}`, avatar: m.s === S.chat.me ? null : S.chat.avatarUrl });
  }
});
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
    if (await api.deleteChat(S.chatId)) { stopAudio(); S.chatId = null; S.chat = null; await refreshChats(); showView('empty'); }
  }
};

// ---------- writing (never delivered) ----------
const compose = $('#compose');
const fitCompose = () => { compose.style.height = 'auto'; compose.style.height = Math.min(compose.scrollHeight, 140) + 'px'; $('#send').disabled = !compose.value.trim(); };
compose.addEventListener('input', fitCompose);
compose.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendLocal(); } });
$('#send').onclick = sendLocal;

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

// right-click an undelivered message to take it back
$('#messages').addEventListener('contextmenu', e => {
  const row = e.target.closest('[data-uid]');
  closeCtx();
  if (!row) return;
  e.preventDefault();
  const menu = el('div', 'ctx', '<button data-copy>Copy text</button><button class="danger" data-del>Delete this message</button>');
  menu.style.left = Math.min(e.clientX, innerWidth - 220) + 'px'; menu.style.top = Math.min(e.clientY, innerHeight - 100) + 'px';
  document.body.append(menu);
  const i = +row.dataset.i;
  menu.onclick = async ev => {
    if (ev.target.closest('[data-copy]')) api.copyText(S.chat.messages[i].x || '');
    if (ev.target.closest('[data-del]')) {
      await api.unwriteMessage(S.chatId, row.dataset.uid);
      S.chat.messages.splice(i, 1);
      S.hi = Math.min(S.hi, S.chat.messages.length);
      const keep = Math.max(0, i - 1); renderWindow(); $(`#messages [data-i="${keep}"]`)?.scrollIntoView({ block: 'center' });
      refreshChats();
    }
    closeCtx();
  };
});
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
  if (S.chats.length) openChat(S.chats[0].id);
})();
