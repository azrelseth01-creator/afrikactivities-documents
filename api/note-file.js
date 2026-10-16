const { session, readJSON, getBin } = require('./_lib');
const filesOf = (entry) => Array.isArray(entry.files) ? entry.files : (entry.file ? [entry.file] : []);

module.exports = async (req, res) => {
  const s = session(req);
  if (!s || !s.uid) return res.status(401).end('Sign in required.');
  if (req.method !== 'GET') return res.status(405).end();
  try {
    const items = await readJSON('unfinished-acts/notes.json', []);
    const q = req.query || {}, entry = items.find((note) => note.id === String(q.id || ''));
    if (!entry) return res.status(404).end('Attachment not found.');
    const files = filesOf(entry), file = q.file ? files.find((candidate) => String(candidate.id || candidate.path) === String(q.file)) : files[0];
    if (!file || !file.path) return res.status(404).end('Attachment not found.');
    const buf = await getBin(file.path);
    if (!buf) return res.status(404).end('Attachment file not found.');
    const name = String(file.name || 'attachment').replace(/[\r\n"\\]/g, '_');
    const type = String(file.type || 'application/octet-stream');
    const inline = q.download !== '1' && (type === 'application/pdf' || /^image\/(jpeg|png|webp|gif|avif|bmp)$/i.test(type));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Length', String(buf.length));
    res.setHeader('Content-Disposition', (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(name));
    return res.status(200).send(buf);
  } catch (e) { return res.status(500).end('Attachment download failed.'); }
};
