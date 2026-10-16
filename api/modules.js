const crypto = require('crypto');
const { session, readJSON, writeJSON, putBin, getBin, delBlobs } = require('./_lib');
const DATA = 'unfinished-acts/modules.json';
const MAX_BYTES = 30 * 1024 * 1024, MAX_CHUNK = 4.4 * 1024 * 1024, MAX_PARTS = 8;
const TMP = (id, n) => 'modules-tmp/' + id + '/' + n;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const s = session(req);
  if (!s || !s.uid) return res.status(401).json({ error: 'Sign in to open Modules.' });
  try {
    const files = await readJSON(DATA, []);
    const profiles = await readJSON('unfinished-acts/profiles.json', {});
    const decorate = () => files.map((f) => Object.assign({}, f, { uploader: String((profiles[f.uid] || {}).name || f.uploader || 'Student'), own: f.uid === s.uid }));
    if (req.method === 'GET') return res.json({ modules: decorate() });
    const q = req.query || {}, job = String(q.id || '');
    if (q.action === 'chunk' && req.method === 'POST') {
      if (!/^[a-f0-9]{16,32}$/i.test(job)) return res.status(400).json({ error: 'Invalid upload session.' });
      const n = Number(q.n), buf = Buffer.isBuffer(req.body) ? req.body : null;
      if (!Number.isInteger(n) || n < 0 || n >= MAX_PARTS || !buf || !buf.length || buf.length > MAX_CHUNK) return res.status(400).json({ error: 'Invalid upload part.' });
      await putBin(TMP(job, n), buf, 'application/octet-stream');
      return res.json({ ok: true });
    }
    if (q.action === 'finish' && req.method === 'POST') {
      if (!/^[a-f0-9]{16,32}$/i.test(job)) return res.status(400).json({ error: 'Invalid upload session.' });
      const b = req.body || {}, total = Number(b.total);
      if (!Number.isInteger(total) || total < 1 || total > MAX_PARTS) return res.status(400).json({ error: 'Invalid upload parts.' });
      const parts = []; let size = 0;
      for (let i = 0; i < total; i++) {
        const part = await getBin(TMP(job, i));
        if (!part) return res.status(400).json({ error: 'Upload was interrupted. Please try again.' });
        size += part.length;
        if (size > MAX_BYTES) { await delBlobs(Array.from({ length: total }, (_, k) => TMP(job, k))); return res.status(413).json({ error: 'Modules must be 30 MB or smaller.' }); }
        parts.push(part);
      }
      const file = Buffer.concat(parts), id = crypto.randomBytes(8).toString('hex');
      const name = String(b.name || 'Module').replace(/[\\/\x00-\x1f]/g, '').trim().slice(0, 160) || 'Module';
      const extMatch = /\.([a-z0-9]{1,12})$/i.exec(name), ext = extMatch ? '.' + extMatch[1].toLowerCase() : '';
      const type = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(String(b.type || '')) ? String(b.type).slice(0, 100) : 'application/octet-stream';
      const path = 'modules/' + id + ext;
      const stored = await putBin(path, file, type);
      const profile = profiles[s.uid] || {};
      files.unshift({ id, uid: s.uid, name, path, type, size, access: stored.access, url: stored.url, at: new Date().toISOString(), uploader: String(profile.name || (s.role === 'admin' ? 'Admin' : 'Student')).slice(0, 40), role: s.role });
      await writeJSON(DATA, files);
      await delBlobs(Array.from({ length: total }, (_, k) => TMP(job, k)));
      return res.json({ modules: decorate() });
    }
    const moduleId = job.slice(0, 32);
    if (req.method === 'DELETE') {
      const i = files.findIndex((f) => f.id === moduleId);
      if (i < 0) return res.status(404).json({ error: 'Module not found.' });
      if (files[i].uid !== s.uid && s.role !== 'admin') return res.status(403).json({ error: 'Only the uploader or an admin can delete this module.' });
      const [removed] = files.splice(i, 1);
      await writeJSON(DATA, files); await delBlobs([removed.path]);
      return res.json({ modules: decorate() });
    }
    return res.status(405).end();
  } catch (e) { return res.status(500).json({ error: String(e.message || '').startsWith('Storage:') ? e.message : 'Modules are unavailable. Check the connected Blob store.' }); }
};
