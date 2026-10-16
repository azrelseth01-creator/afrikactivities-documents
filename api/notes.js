const crypto = require('crypto');
const { session, readJSON, writeJSON } = require('./_lib');
const DATA = 'unfinished-acts/notes.json';
const clean = (v, n) => String(v || '').trim().slice(0, n);

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const s = session(req);
  if (!s || !s.uid) return res.status(401).json({ error: 'Sign in to open notes.' });
  try {
    const items = await readJSON(DATA, []);
    const profiles = await readJSON('unfinished-acts/profiles.json', {});
    const decorate = (list) => list.map((n) => Object.assign({}, n, {
      author: String((profiles[n.uid] || {}).name || n.author || 'Student'), own: n.uid === s.uid,
    }));
    if (req.method === 'GET') return res.json({ items: decorate(items) });
    const id = String(req.query && req.query.id || '').slice(0, 32);
    if (req.method === 'PATCH' || req.method === 'DELETE') {
      const i = items.findIndex((n) => n.id === id);
      if (i < 0) return res.status(404).json({ error: 'Note not found.' });
      if (items[i].uid !== s.uid && s.role !== 'admin') return res.status(403).json({ error: 'You can only edit your own notes.' });
      if (req.method === 'DELETE') items.splice(i, 1);
      else {
        const b = req.body || {}, subject = clean(b.subject, 60), title = clean(b.title, 100), body = clean(b.body, 5000);
        if (!subject || !title || !body || !['note', 'pt'].includes(b.kind)) return res.status(400).json({ error: 'Add a subject, title, and content.' });
        Object.assign(items[i], { subject, title, body, kind: b.kind, updatedAt: new Date().toISOString() });
      }
      await writeJSON(DATA, items);
      return res.json({ items: decorate(items) });
    }
    if (req.method !== 'POST') return res.status(405).end();
    const b = req.body || {}, subject = clean(b.subject, 60), title = clean(b.title, 100), body = clean(b.body, 5000);
    if (!subject || !title || !body || !['note', 'pt'].includes(b.kind)) return res.status(400).json({ error: 'Add a subject, title, and content.' });
    if (items.length >= 1000) return res.status(400).json({ error: 'The notes page has reached its storage limit.' });
    const profile = profiles[s.uid] || {};
    items.unshift({ id: crypto.randomBytes(8).toString('hex'), uid: s.uid, subject, title, body, kind: b.kind, at: new Date().toISOString(), updatedAt: null, author: String(profile.name || (s.role === 'admin' ? 'Admin' : 'Student')).slice(0, 40), role: s.role });
    await writeJSON(DATA, items);
    return res.json({ items: decorate(items) });
  } catch (e) { return res.status(500).json({ error: 'Notes are unavailable. Check the connected Blob store.' }); }
};
