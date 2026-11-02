'use strict';
// Phone/web build only: serves imported media straight out of IndexedDB so the chat can use plain
// URLs (dcmedia/<chat>/<file>), with Range support so voice notes and videos can seek.

const TYPES = {
  opus: 'audio/ogg', ogg: 'audio/ogg', m4a: 'audio/mp4', mp3: 'audio/mpeg', aac: 'audio/aac', amr: 'audio/amr', wav: 'audio/wav',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic',
  mp4: 'video/mp4', '3gp': 'video/3gpp', mov: 'video/quicktime', webm: 'video/webm', pdf: 'application/pdf',
};

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

let dbp;
function db() {
  return dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('deadchat', 1);
    r.onupgradeneeded = () => ['chats', 'media', 'avatars'].forEach(s => r.result.createObjectStore(s));
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}
async function get(store, key) {
  const d = await db();
  return new Promise((res, rej) => {
    const q = d.transaction(store).objectStore(store).get(key);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}

async function serve(request, store, key, name) {
  const blob = await get(store, key);
  if (!blob) return new Response('Not found', { status: 404 });
  const type = blob.type || TYPES[(name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') || '');
  if (!range) {
    return new Response(blob, { headers: { 'Content-Type': type, 'Content-Length': blob.size, 'Accept-Ranges': 'bytes' } });
  }
  const size = blob.size;
  const start = range[1] ? +range[1] : Math.max(0, size - +range[2]);
  const end = range[1] && range[2] ? Math.min(+range[2], size - 1) : size - 1;
  return new Response(blob.slice(start, end + 1, type), {
    status: 206,
    headers: { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' },
  });
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  const m = /\/dcmedia\/([^/]+)\/(.+)$/.exec(url.pathname);
  if (m) { const f = decodeURIComponent(m[2]); e.respondWith(serve(e.request, 'media', `${m[1]}/${f}`, f)); return; }
  const a = /\/dcavatar\/([^/]+)$/.exec(url.pathname);
  if (a) e.respondWith(serve(e.request, 'avatars', a[1], 'avatar.jpg'));
});
