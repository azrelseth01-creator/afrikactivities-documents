const { session, readJSON, getBin } = require('./_lib');

module.exports = async (req, res) => {
  const s = session(req);
  if (!s || !s.uid) return res.status(401).end('Sign in required.');
  if (req.method !== 'GET') return res.status(405).end();
  try {
    const items = await readJSON('unfinished-acts/notes.json', []);
    const entry = items.find((n) => n.id === String(req.query && req.query.id || ''));
    if (!entry || !entry.file || !entry.file.path) return res.status(404).end('Attachment not found.');
    const file = await getBin(entry.file.path);
    if (!file) return res.status(404).end('Attachment file not found.');
    const name = String(entry.file.name || 'attachment').replace(/[\r\n"\\]/g, '_');
    const type = String(entry.file.type || 'application/octet-stream');
    const inline = type === 'application/pdf';
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Length', String(file.length));
    res.setHeader('Content-Disposition', (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(name));
    return res.status(200).send(file);
  } catch (e) { return res.status(500).end('Attachment download failed.'); }
};
