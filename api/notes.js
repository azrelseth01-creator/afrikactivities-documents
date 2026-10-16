const crypto = require('crypto');
const { session, readJSON, writeJSON, putBin, getBin, delBlobs } = require('./_lib');
const DATA = 'unfinished-acts/notes.json';
const MAX_BYTES = 20 * 1024 * 1024, MAX_CHUNK = 4000000, MAX_PARTS = 6, MAX_FILES = 10;
const TMP = (id, n) => 'notes-tmp/' + id + '/' + n;
const clean = (v, n) => String(v || '').trim().slice(0, n);
const safeName = (v) => String(v || 'Attachment').replace(/[\\/\x00-\x1f]/g, '').trim().slice(0, 160) || 'Attachment';
const fileType = (v) => /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(String(v || '')) ? String(v).slice(0, 100) : 'application/octet-stream';
const cleanIcon = (v) => String(v || '').trim().slice(0, 8);
const cleanColor = (v) => /^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v).toLowerCase() : null;
const filesOf = (entry) => Array.isArray(entry.files) ? entry.files : (entry.file ? [entry.file] : []);
const fileKey = (file) => String(file.id || file.path || '');
const tempPaths = (uploads) => uploads.flatMap((upload) => Array.from({ length: Number(upload.total) || 0 }, (_, n) => TMP(String(upload.id || ''), n)));

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const s = session(req);
  if (!s || !s.uid) return res.status(401).json({ error: 'Sign in to open notes.' });
  let cleanupTemps = [], cleanupCreated = [];
  try {
    const items = await readJSON(DATA, []);
    const profiles = await readJSON('unfinished-acts/profiles.json', {});
    const decorate = (list) => list.map((n) => {
      const visibleFiles = filesOf(n).map((file) => ({
        id: fileKey(file), name: file.name, size: file.size, type: file.type,
      }));
      return Object.assign({}, n, {
        author: String((profiles[n.uid] || {}).name || n.author || 'Student'),
        own: n.uid === s.uid,
        files: visibleFiles,
        file: visibleFiles[0] || null,
      });
    });
    const q = req.query || {}, job = String(q.id || '');

    if (req.method === 'GET') return res.json({ items: decorate(items) });

    if (req.method === 'POST' && q.action === 'chunk') {
      const replaceId = String(q.replaceId || '').slice(0, 32);
      const canEdit = s.role === 'admin' || items.some((n) => n.id === replaceId && n.uid === s.uid);
      if (!canEdit) return res.status(403).json({ error: 'Only admins can add notes or PTs.' });
      if (!/^[a-f0-9]{16,32}$/i.test(job)) return res.status(400).json({ error: 'Invalid upload session.' });
      const n = Number(q.n), buf = Buffer.isBuffer(req.body) ? req.body : null;
      if (!Number.isInteger(n) || n < 0 || n >= MAX_PARTS || !buf || !buf.length || buf.length > MAX_CHUNK) return res.status(400).json({ error: 'Invalid file upload part.' });
      await putBin(TMP(job, n), buf, 'application/octet-stream');
      return res.json({ ok: true });
    }

    if (req.method === 'POST' && q.action === 'finish') {
      const b = req.body || {}, subject = clean(b.subject, 60), title = clean(b.title, 100), body = clean(b.body, 5000), kind = b.kind;
      if (!['note', 'presentation'].includes(kind)) return res.status(400).json({ error: 'Choose Note or PT for this entry.' });
      if (!subject || !title) return res.status(400).json({ error: 'Add a subject and title for this entry.' });
      const replaceId = String(b.replaceId || '').slice(0, 32);
      const replaceIndex = replaceId ? items.findIndex((n) => n.id === replaceId) : -1;
      if (replaceId && replaceIndex < 0) return res.status(404).json({ error: 'The entry being updated could not be found.' });
      if (replaceIndex >= 0 && items[replaceIndex].uid !== s.uid && s.role !== 'admin') return res.status(403).json({ error: 'You can only edit your own notes.' });
      if (replaceIndex < 0 && s.role !== 'admin') return res.status(403).json({ error: 'Only admins can add notes or PTs.' });
      if (replaceIndex < 0 && items.length >= 1000) return res.status(400).json({ error: 'The notes page has reached its storage limit.' });

      // Accept the former one-file request shape while the new form sends a file list.
      const uploads = Array.isArray(b.uploads) ? b.uploads : (job && b.total ? [{ id: job, total: b.total, name: b.name, type: b.type }] : []);
      if (uploads.length > MAX_FILES) return res.status(400).json({ error: 'You can attach up to 10 files.' });
      const oldFiles = replaceIndex >= 0 ? filesOf(items[replaceIndex]) : [];
      const keepKeys = new Set(Array.isArray(b.keepFiles) ? b.keepFiles.map(String) : []);
      const retained = oldFiles.filter((file) => keepKeys.has(fileKey(file)));
      const entryId = replaceIndex >= 0 ? items[replaceIndex].id : crypto.randomBytes(8).toString('hex');
      cleanupTemps = tempPaths(uploads);
      const added = [];
      for (const upload of uploads) {
        const uploadId = String(upload.id || '');
        const total = Number(upload.total);
        if (!/^[a-f0-9]{16,32}$/i.test(uploadId) || !Number.isInteger(total) || total < 1 || total > MAX_PARTS) return res.status(400).json({ error: 'Invalid file upload parts.' });
        const parts = []; let size = 0;
        for (let i = 0; i < total; i++) {
          const part = await getBin(TMP(uploadId, i));
          if (!part) return res.status(400).json({ error: 'Upload was interrupted. Please try again.' });
          size += part.length;
          if (size > MAX_BYTES) return res.status(413).json({ error: 'Each attachment must be 20 MB or smaller.' });
          parts.push(part);
        }
        const file = Buffer.concat(parts), name = safeName(upload.name);
        const extMatch = /\.([a-z0-9]{1,12})$/i.exec(name), ext = extMatch ? '.' + extMatch[1].toLowerCase() : '';
        const id = crypto.randomBytes(8).toString('hex'), path = 'notes/' + entryId + '-' + id + ext;
        const type = fileType(upload.type), stored = await putBin(path, file, type);
        cleanupCreated.push(path);
        added.push({ id, path, access: stored.access, url: stored.url, name, type, size });
      }
      const allFiles = retained.concat(added);
      if (allFiles.length > MAX_FILES) return res.status(400).json({ error: 'You can attach up to 10 files.' });
      if (kind === 'presentation' && !allFiles.length) return res.status(400).json({ error: 'Choose at least one PT file.' });
      if (kind === 'note' && !body && !allFiles.length) return res.status(400).json({ error: 'Write note content or attach a file.' });

      const profile = profiles[s.uid] || {};
      const entry = replaceIndex >= 0 ? items[replaceIndex] : { id: entryId, uid: s.uid, at: new Date().toISOString(), updatedAt: null };
      Object.assign(entry, {
        uid: s.uid, subject, title, body, kind, icon: cleanIcon(b.icon), color: cleanColor(b.color),
        files: allFiles, file: allFiles[0] || null,
        updatedAt: replaceIndex >= 0 ? new Date().toISOString() : null,
        author: String(profile.name || (s.role === 'admin' ? 'Admin' : 'Student')).slice(0, 40), role: s.role,
      });
      if (replaceIndex < 0) items.unshift(entry);
      await writeJSON(DATA, items);
      cleanupCreated = [];
      await delBlobs(cleanupTemps); cleanupTemps = [];
      const retainedKeys = new Set(retained.map(fileKey));
      const removed = oldFiles.filter((file) => !retainedKeys.has(fileKey(file))).map((file) => file.path).filter(Boolean);
      if (removed.length) await delBlobs(removed);
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
        await delBlobs(filesOf(removed).map((file) => file.path).filter(Boolean));
      } else {
        const b = req.body || {}, subject = clean(b.subject, 60), title = clean(b.title, 100), body = clean(b.body, 5000), kind = b.kind;
        const hasFiles = filesOf(items[i]).length > 0;
        if (!subject || !title || (kind === 'note' && !body && !hasFiles) || !['note', 'presentation'].includes(kind)) return res.status(400).json({ error: 'Add a subject, title, and valid content or attachment.' });
        if (kind === 'presentation' && !hasFiles && items[i].kind !== 'pt') return res.status(400).json({ error: 'Upload a PT file before saving this entry.' });
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
  } catch (e) {
    if (cleanupTemps.length) await delBlobs(cleanupTemps);
    if (cleanupCreated.length) await delBlobs(cleanupCreated);
    return res.status(500).json({ error: String(e.message || '').startsWith('Storage:') ? e.message : 'Notes are unavailable. Check the connected Blob store.' });
  }
};
