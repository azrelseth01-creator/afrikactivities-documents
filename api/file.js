const { Readable } = require('stream');
const { verify, EXT_TYPES } = require('./_lib');
const blob = () => require('@vercel/blob');

// Only used when the connected Blob store is private: public stores are linked to
// directly and never hit this route. Streams the file so large PDFs don't sit in memory.
module.exports = async (req, res) => {
  if (!verify(req)) return res.status(401).end();
  const p = String((req.query && req.query.p) || '');
  if (!/^uploads\/[A-Za-z0-9._-]{1,80}$/.test(p)) return res.status(400).end();
  const type = EXT_TYPES[p.split('.').pop().toLowerCase()];
  if (!type) return res.status(400).end();
  try {
    const r = await blob().get(p, { access: 'private' });
    if (!r || r.statusCode !== 200) return res.status(404).end();
    res.setHeader('Content-Type', type);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const s = Readable.fromWeb(r.stream);
    s.on('error', () => res.destroy());
    s.pipe(res);
  } catch (e) {
    res.status(502).end();
  }
};
