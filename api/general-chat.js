const crypto = require('crypto');
const { session, readJSON, writeJSON } = require('./_lib');
const DATA = 'unfinished-acts/general-chat.json';
const MAX_MESSAGES = 500;
const REACTIONS = ['👍', '❤️', '😂', '🎉'];
const cleanText = (v) => String(v || '').trim().slice(0, 1200);

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const s = session(req);
  if (!s || !s.uid) return res.status(401).json({ error: 'Sign in to use general chat.' });
  try {
    const messages = await readJSON(DATA, []);
    const profiles = await readJSON('unfinished-acts/profiles.json', {});
    const decorate = (items) => items.map((m) => {
      const reactions = m.reactions || {};
      return Object.assign({}, m, {
        author: String((profiles[m.uid] || {}).name || m.author || 'Student'),
        avatar: String((profiles[m.uid] || {}).avatar || m.avatar || '🙂'),
        own: m.uid === s.uid,
        admin: m.role === 'admin',
        reactionCounts: Object.fromEntries(REACTIONS.map((emoji) => [emoji, (reactions[emoji] || []).length])),
        myReactions: REACTIONS.filter((emoji) => (reactions[emoji] || []).includes(s.uid)),
      });
    });

    if (req.method === 'GET') return res.json({ messages: decorate(messages) });

    const messageId = String(req.query && req.query.message || '').slice(0, 32);
    if (req.method === 'POST' && req.query && req.query.action === 'react') {
      const emoji = String(req.body && req.body.emoji || '');
      if (!REACTIONS.includes(emoji)) return res.status(400).json({ error: 'That reaction is not supported.' });
      const item = messages.find((m) => m.id === messageId);
      if (!item) return res.status(404).json({ error: 'Message not found.' });
      item.reactions = item.reactions || {};
      item.reactions[emoji] = item.reactions[emoji] || [];
      const i = item.reactions[emoji].indexOf(s.uid);
      if (i < 0) item.reactions[emoji].push(s.uid); else item.reactions[emoji].splice(i, 1);
      await writeJSON(DATA, messages);
      return res.json({ messages: decorate(messages) });
    }

    if (req.method === 'PATCH' || req.method === 'DELETE') {
      const index = messages.findIndex((m) => m.id === messageId);
      if (index < 0) return res.status(404).json({ error: 'Message not found.' });
      if (messages[index].uid !== s.uid && s.role !== 'admin') return res.status(403).json({ error: 'You can only change your own messages.' });
      if (req.method === 'DELETE') {
        const removed = new Set([messageId]);
        messages.forEach((m) => { if (m.parentId === messageId) removed.add(m.id); });
        await writeJSON(DATA, messages.filter((m) => !removed.has(m.id)));
      } else {
        const message = cleanText(req.body && req.body.message);
        if (!message) return res.status(400).json({ error: 'Write a message first.' });
        messages[index].message = message;
        messages[index].editedAt = new Date().toISOString();
        await writeJSON(DATA, messages);
      }
      return res.json({ messages: decorate(await readJSON(DATA, [])) });
    }

    if (req.method !== 'POST') return res.status(405).end();
    const message = cleanText(req.body && req.body.message);
    if (!message) return res.status(400).json({ error: 'Write a message first.' });
    if (messages.length >= MAX_MESSAGES) return res.status(400).json({ error: 'General chat is full. Ask an admin to clear old messages.' });
    const parentId = String(req.body && req.body.parentId || '').slice(0, 32);
    if (parentId && !messages.some((m) => m.id === parentId && !m.parentId)) return res.status(404).json({ error: 'That message is no longer available to reply to.' });
    const profile = profiles[s.uid] || {};
    messages.push({
      id: crypto.randomBytes(8).toString('hex'), uid: s.uid, parentId: parentId || null,
      message, at: new Date().toISOString(), author: String(profile.name || (s.role === 'admin' ? 'Admin' : 'Student')).slice(0, 40),
      role: s.role, reactions: {},
    });
    await writeJSON(DATA, messages);
    return res.json({ messages: decorate(messages) });
  } catch (e) {
    return res.status(500).json({ error: 'General chat is unavailable. Check the connected Blob store.' });
  }
};
