const crypto = require('crypto');
const { session, readJSON, writeJSON, putBin, getBin, delBlobs } = require('./_lib');
const DATA = 'unfinished-acts/notes.json';
const MAX_BYTES = 20 * 1024 * 1024, MAX_CHUNK = 4.4 * 1024 * 1024, MAX_PARTS = 5;
const TMP = (id, n) => 'notes-tmp/' + id + '/' + n;
const clean = (v, n) => String(v || '').trim().slice(0, n);
const safeName = (v) => String(v || 'Attachment').replace(/[\\/\x00-\x1f]/g, '').trim().slice(0, 160) || 'Attachment';
const fileType = (v) => /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(String(v || '')) ? String(v).slice(0, 100) : 'application/octet-stream';
const cleanIcon = (v) => String(v || '').trim().slice(0, 8);
const cleanColor = (v) => /^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v).toLowerCase() : null;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const s = session(req);
  if (!s || !s.uid) return res.status(401).json({ error: 'Sign in to open notes.' });
  try {
    const items = await readJSON(DATA, []);
    const profiles = await readJSON('unfinished-acts/profiles.json', {});
    const decorate = (list) => list.map((n) => Object.assign({}, n, {
      author: String((profiles[n.uid] || {}).name || n.author || 'Student'),
      own: n.uid === s.uid,
      file: n.file ? { name: n.file.name, size: n.file.size, type: n.file.type } : null,
    }));
    const q = req.query || {}, job = String(q.id || '');

    if (req.method === 'GET') return res.json({ items: decorate(items) });

    if (req.method === 'POST' && (q.action === 'chunk' || q.action === 'finish')) {
      if (s.role !== 'admin') return res.status(403).json({ error: 'Only admins can add notes or PTs.' });
      if (!/^[a-f0-9]{16,32}$/i.test(job)) return res.status(400).json({ error: 'Invalid upload session.' });
      if (q.action === 'chunk') {
        const n = Number(q.n), buf = Buffer.isBuffer(req.body) ? req.body : null;
        if (!Number.isInteger(n) || n < 0 || n >= MAX_PARTS || !buf || !buf.length || buf.length > MAX_CHUNK) return res.status(400).json({ error: 'Invalid file upload part.' });
        await putBin(TMP(job, n), buf, 'application/octet-stream');
        return res.json({ ok: true });
      }

      const b = req.body || {}, total = Number(b.total), subject = clean(b.subject, 60), title = clean(b.title, 100), body = clean(b.body, 5000), kind = b.kind;
      if (!['note', 'presentation'].includes(kind)) return res.status(400).json({ error: 'Choose Note or PT for this entry.' });
      if (!Number.isInteger(total) || total < 1 || total > MAX_PARTS) return res.status(400).json({ error: 'Invalid file upload parts.' });
      if (!subject || !title) return res.status(400).json({ error: 'Add a subject and title for this entry.' });
      const replaceId = String(b.replaceId || '').slice(0, 32);
      const replaceIndex = replaceId ? items.findIndex((n) => n.id === replaceId) : -1;
      if (replaceId && replaceIndex < 0) return res.status(404).json({ error: 'The entry being updated could not be found.' });
      if (replaceIndex < 0 && items.length >= 1000) return res.status(400).json({ error: 'The notes page has reached its storage limit.' });

      const parts = []; let size = 0;
      for (let i = 0; i < total; i++) {
        const part = await getBin(TMP(job, i));
        if (!part) return res.status(400).json({ error: 'Upload was interrupted. Please try again.' });
        size += part.length;
        if (size > MAX_BYTES) {
          await delBlobs(Array.from({ length: total }, (_, k) => TMP(job, k)));
          return res.status(413).json({ error: 'Attachments must be 20 MB or smaller.' });
        }
        parts.push(part);
      }
      const file = Buffer.concat(parts), id = replaceIndex >= 0 ? items[replaceIndex].id : crypto.randomBytes(8).toString('hex');
      const name = safeName(b.name), extMatch = /\.([a-z0-9]{1,12})$/i.exec(name), ext = extMatch ? '.' + extMatch[1].toLowerCase() : '';
      const type = fileType(b.type), path = 'notes/' + id + ext, stored = await putBin(path, file, type);
      const profile = profiles[s.uid] || {}, previous = replaceIndex >= 0 ? items[replaceIndex].file : null;
      const entry = replaceIndex >= 0 ? items[replaceIndex] : { id, uid: s.uid, at: new Date().toISOString(), updatedAt: null };
      Object.assign(entry, {
        uid: s.uid, subject, title, body, kind, icon: cleanIcon(b.icon), color: cleanColor(b.color),
        file: { path, access: stored.access, url: stored.url, name, type, size },
        updatedAt: replaceIndex >= 0 ? new Date().toISOString() : null,
        author: String(profile.name || 'Admin').slice(0, 40), role: s.role,
      });
      if (replaceIndex < 0) items.unshift(entry);
      await writeJSON(DATA, items);
      await delBlobs(Array.from({ length: total }, (_, k) => TMP(job, k)));
      if (previous && previous.path !== path) await delBlobs([previous.path]);
      return res.json({ items: decorate(items) });
    }

    const id = String(q.id || '').slice(0, 32);
    if (req.method === 'PATCH' || req.method === 'DELETE') {
      const i = items.findIndex((n) => n.id === id);
      if (i < 0) return res.status(404).json({ error: 'Note not found.' });
      if (items[i].uid !== s.uid && s.role !== 'admin') return res.status(403).json({ error: 'You can only edit your own notes.' });
      if (req.method === 'DELETE') {
        const [removed] = items.splice(i, 1);
        await writeJSON(DATA, items);
        if (removed.file && removed.file.path) await delBlobs([removed.file.path]);
      } else {
        const b = req.body || {}, subject = clean(b.subject, 60), title = clean(b.title, 100), body = clean(b.body, 5000), kind = b.kind;
        if (!subject || !title || (kind === 'note' && !body && !items[i].file) || !['note', 'presentation'].includes(kind)) return res.status(400).json({ error: 'Add a subject, title, and valid content or attachment.' });
        if (kind === 'presentation' && !items[i].file && items[i].kind !== 'pt') return res.status(400).json({ error: 'Upload a PT file before saving this entry.' });
        Object.assign(items[i], { subject, title, body, kind, icon: cleanIcon(b.icon), color: cleanColor(b.color), updatedAt: new Date().toISOString() });
        await writeJSON(DATA, items);
      }
      return res.json({ items: decorate(items) });
    }

    if (req.method !== 'POST') return res.status(405).end();
    if (s.role !== 'admin') return res.status(403).json({ error: 'Only admins can add notes.' });
    const b = req.body || {}, subject = clean(b.subject, 60), title = clean(b.title, 100), body = clean(b.body, 5000);
    if (!subject || !title || !body || b.kind !== 'note') return res.status(400).json({ error: 'Add a subject, title, and note content.' });
    if (items.length >= 1000) return res.status(400).json({ error: 'The notes page has reached its storage limit.' });
    const profile = profiles[s.uid] || {};
    items.unshift({ id: crypto.randomBytes(8).toString('hex'), uid: s.uid, subject, title, body, kind: 'note', icon: cleanIcon(b.icon), color: cleanColor(b.color), at: new Date().toISOString(), updatedAt: null, author: String(profile.name || 'Admin').slice(0, 40), role: s.role });
    await writeJSON(DATA, items);
    return res.json({ items: decorate(items) });
  } catch (e) { return res.status(500).json({ error: String(e.message || '').startsWith('Storage:') ? e.message : 'Notes are unavailable. Check the connected Blob store.' }); }
};
