const { session, readJSON, getBin } = require('./_lib');
module.exports = async (req, res) => {
  const s = session(req);
  if (!s || !s.uid) return res.status(401).end('Sign in required.');
  if (req.method !== 'GET') return res.status(405).end();
  try {
    const files = await readJSON('unfinished-acts/modules.json', []);
    const f = files.find((x) => x.id === String(req.query && req.query.id || ''));
    if (!f) return res.status(404).end('Module not found.');
    const buf = await getBin(f.path);
    if (!buf) return res.status(404).end('Module file not found.');
    const safeName = String(f.name || 'module').replace(/[\r\n"\\]/g, '_');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Type', f.type || 'application/octet-stream');
    res.setHeader('Content-Length', String(buf.length));
    res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(safeName));
    return res.status(200).send(buf);
  } catch (e) { return res.status(500).end('Module download failed.'); }
};
