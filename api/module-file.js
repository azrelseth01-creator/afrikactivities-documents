const { session, readJSON, getBin } = require('./_lib');
const filesOf = (item) => Array.isArray(item.files) ? item.files : (item.path ? [{ id: item.fileId || item.id, path: item.path, name: item.fileName || item.name, type: item.type, size: item.size }] : []);

module.exports = async (req, res) => {
  const s = session(req);
  if (!s || !s.uid) return res.status(401).end('Sign in required.');
  if (req.method !== 'GET') return res.status(405).end();
  try {
    const modules = await readJSON('unfinished-acts/modules.json', []);
    const q = req.query || {}, item = modules.find((module) => module.id === String(q.id || ''));
    if (!item) return res.status(404).end('Module not found.');
    const files = filesOf(item), file = q.file ? files.find((candidate) => String(candidate.id || candidate.path) === String(q.file)) : files[0];
    if (!file) return res.status(404).end('Module file not found.');
    const buf = await getBin(file.path);
    if (!buf) return res.status(404).end('Module file not found.');
    const safeName = String(file.name || item.fileName || item.name || 'module').replace(/[\r\n"\\]/g, '_');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', file.type || 'application/octet-stream');
    res.setHeader('Content-Length', String(buf.length));
    const type = String(file.type || 'application/octet-stream');
    const inline = q.inline === '1' && (type === 'application/pdf' || /^image\/(jpeg|png|webp|gif|avif|bmp)$/i.test(type));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(safeName));
    return res.status(200).send(buf);
  } catch (e) { return res.status(500).end('Module download failed.'); }
};
