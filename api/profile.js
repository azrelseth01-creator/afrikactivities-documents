const { session, readJSON, writeJSON } = require('./_lib');
const DATA = 'unfinished-acts/profiles.json';
const MAX_AVATAR_CHARS = 4_200_000;
const clean = (p) => ({ name: String(p && p.name || '').trim().slice(0, 40), avatar: String(p && p.avatar || '🙂').slice(0, MAX_AVATAR_CHARS) });
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const s = session(req);
  if (!s || !s.uid) return res.status(401).json({ error: 'Sign in again to set up this device profile.' });
  try {
    const profiles = await readJSON(DATA, {});
    if (req.method === 'GET') return res.json(Object.assign({ role: s.role }, clean(profiles[s.uid] || { name: s.role === 'admin' ? 'Admin' : 'Student', avatar: '🙂' })));
    if (req.method !== 'PUT') return res.status(405).end();
    const body = req.body || {};
    const rawAvatar = String(body.avatar || '🙂');
    if (rawAvatar.length > MAX_AVATAR_CHARS) return res.status(400).json({ error: 'Choose a PNG, JPG, or WebP image under 3 MB.' });
    const p = clean(body);
    if (!p.name) return res.status(400).json({ error: 'Add a display name.' });
    if (p.avatar.startsWith('data:') && !/^data:image\/(png|jpeg|webp);base64,/.test(p.avatar)) return res.status(400).json({ error: 'Use a PNG, JPG, or WebP image under 3 MB.' });
    profiles[s.uid] = p;
    await writeJSON(DATA, profiles);
    return res.json(Object.assign({ role: s.role }, p));
  } catch (e) { return res.status(500).json({ error: 'Profile storage is unavailable.' }); }
};
