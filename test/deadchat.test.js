'use strict';
// node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const { parseChat } = require('../renderer/shared/parser');
const { Store, mergeMessages, suggestMapping } = require('../src/importer');

const ANDROID = [
  '12/03/2024, 4:58 pm - Messages and calls are end-to-end encrypted. Only people in this chat can read, listen to, or share them.',
  '12/03/2024, 4:59 pm - Alex: hey',
  '12/03/2024, 5:00 pm - Sam: hi!',
  'this line continues the same message',
  '12/03/2024, 5:01 pm - Sam: PTT-20240312-WA0001.opus (file attached)',
  '12/03/2024, 5:02 pm - Alex: <Media omitted>',
  '12/03/2024, 5:03 pm - Alex: This message was deleted',
  '13/03/2024, 12:15 am - Sam: fixed it <This message was edited>',
  '13/03/2024, 12:16 am - Alex: DOC-20240313-WA0002. (file attached)',
].join('\n');

const IOS = [
  '[3/12/24, 16:58:01] Alex: hello',
  '[3/13/24, 09:05:12] Sam: <attached: 00000012-PHOTO-2024-03-13.jpg>',
].join('\n');

test('parses Android exports: senders, system lines, multi-line, media, edits, deletes', () => {
  const { senders, messages } = parseChat(ANDROID);
  assert.deepStrictEqual(senders, ['Alex', 'Sam']);
  assert.strictEqual(messages.length, 8);
  assert.ok(messages[0].sys);
  assert.strictEqual(messages[2].x, 'hi!\nthis line continues the same message');
  assert.deepStrictEqual(messages[3].a, { f: 'PTT-20240312-WA0001.opus', k: 'audio' });
  assert.ok(messages[4].o);
  assert.ok(messages[5].d);
  assert.strictEqual(messages[6].x, 'fixed it');
  assert.ok(messages[6].e);
  assert.strictEqual(messages[6].t, Date.UTC(2024, 2, 13, 0, 15));
  assert.strictEqual(messages[7].a.k, 'document');
});

test('parses iOS exports with month-first dates and 24h times', () => {
  const { messages } = parseChat(IOS);
  assert.strictEqual(messages[0].t, Date.UTC(2024, 2, 12, 16, 58, 1));
  assert.deepStrictEqual(messages[1].a, { f: '00000012-PHOTO-2024-03-13.jpg', k: 'image' });
});

test('merging an overlapping export skips duplicates and fills in omitted media', () => {
  const a = parseChat(ANDROID).messages;
  const b = parseChat(ANDROID.replace('Alex: <Media omitted>', 'Alex: IMG-20240312-WA0003.jpg (file attached)')).messages;
  const { messages, stats } = mergeMessages(a, b);
  assert.strictEqual(messages.length, a.length);
  assert.strictEqual(stats.added, 0);
  assert.strictEqual(stats.upgraded, 1);
  assert.strictEqual(messages[4].a.f, 'IMG-20240312-WA0003.jpg');
});

test('suggests the same person across differently styled names', () => {
  assert.deepStrictEqual(suggestMapping(['Sam ( Work )', 'Alex'], [{ name: 'Alex' }, { name: 'Sam' }]), [1, 0]);
});

test('imports a zip, writes undelivered messages and re-exports losslessly', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deadchat-'));
  try {
    const zipPath = path.join(tmp, 'export.zip');
    const zip = new AdmZip();
    zip.addFile('WhatsApp Chat with Sam.txt', Buffer.from(ANDROID));
    zip.addFile('PTT-20240312-WA0001.opus', Buffer.from('fake audio'));
    zip.writeZip(zipPath);

    const store = new Store(path.join(tmp, 'library'));
    const pv = store.preview(zipPath);
    assert.strictEqual(pv.total, 8);
    const r = store.importSource(zipPath, { title: 'Sam', meIndex: 0 });
    assert.strictEqual(r.copied, 1);
    assert.strictEqual(r.missing, 1); // the document wasn't in the zip

    const msg = store.addLocalMessage(r.id, 'never sent', new Date(2026, 0, 1, 9, 30));
    assert.ok(msg.u);

    const out = path.join(tmp, 'out.zip');
    const ex = store.exportChat(r.id, out, { includeMedia: true, includeUndelivered: true });
    assert.strictEqual(ex.messages, 9);
    const back = parseChat(new AdmZip(out).getEntries().find(e => e.entryName.endsWith('.txt')).getData().toString('utf8'));
    assert.strictEqual(back.messages.length, 9);
    assert.strictEqual(back.messages[8].x, 'never sent');

    assert.ok(store.deleteLocalMessage(r.id, msg.id));
    assert.strictEqual(store.readChat(r.id).messages.length, 8);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
