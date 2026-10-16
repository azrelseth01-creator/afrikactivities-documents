const crypto = require('crypto');
const { session, readJSON, writeJSON, loadDoc } = require('./_lib');
const DATA = 'unfinished-acts/comments.json';
const text = (v) => String(v || '').trim().slice(0, 1200);
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const s = session(req);
  if (!s || !s.uid) return res.status(401).json({ error: 'Sign in again to comment.' });
  const id = String(req.query && req.query.id || '').slice(0, 40);
  try {
    const doc = await loadDoc();
    if (!doc.activities.some(a => a.id === id)) return res.status(404).json({ error: 'Activity not found.' });
    const all = await readJSON(DATA, {});
    const profiles = await readJSON('unfinished-acts/profiles.json', {});
    const decorate = (items) => items.map(c => Object.assign({}, c, {
      author: String((profiles[c.uid] || {}).name || c.author || 'Student'),
      avatar: String((profiles[c.uid] || {}).avatar || c.avatar || '🙂'),
      own: c.uid === s.uid,
    }));
    if (req.method === 'GET') return res.json({ comments: decorate(all[id] || []) });
    if (req.method === 'PATCH' || req.method === 'DELETE') {
      const commentId = String(req.query && req.query.comment || '').slice(0, 32);
      const list = all[id] || [], index = list.findIndex(c => c.id === commentId);
      if (index < 0) return res.status(404).json({ error: 'Comment not found.' });
      if (list[index].uid !== s.uid) return res.status(403).json({ error: 'You can only change your own comments.' });
      if (req.method === 'DELETE') list.splice(index, 1);
      else {
        const message = text(req.body && req.body.message);
        if (!message) return res.status(400).json({ error: 'Write a comment first.' });
        list[index].message = message;
        list[index].editedAt = new Date().toISOString();
      }
      all[id] = list;
      await writeJSON(DATA, all);
      return res.json({ comments: decorate(list) });
    }
    if (req.method !== 'POST') return res.status(405).end();
    const body = req.body || {}, message = text(body.message);
    if (!message) return res.status(400).json({ error: 'Write a comment first.' });
    if (body.announcement === true && s.role !== 'admin') return res.status(403).json({ error: 'Only admins can post announcements.' });
    const profile = profiles[s.uid] || {};
    const list = all[id] || [];
    list.push({ id: crypto.randomBytes(8).toString('hex'), uid: s.uid, message, question: body.question === true, announcement: body.announcement === true && s.role === 'admin', at: new Date().toISOString(), author: String(profile.name || (s.role === 'admin' ? 'Admin' : 'Student')).slice(0, 40), role: s.role });
    all[id] = list.slice(-200);
    await writeJSON(DATA, all);
    return res.json({ comments: decorate(all[id]) });
  } catch (e) { return res.status(500).json({ error: 'Comments are unavailable. Check the connected Blob store.' }); }
};
