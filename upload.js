const c = require('crypto');
const { verify, putBin, getBin, delBlobs, TYPES } = require('./_lib');

// Vercel functions accept request bodies up to 4.5MB, so the browser sends a file in pieces
// (action=chunk), then asks for them to be joined and stored (action=finish).
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_CHUNK = 4.4 * 1024 * 1024;
const MAX_PARTS = 8;

function sniff(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 5 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();
  if (verify(req) !== 'admin') return res.status(403).json({ error: 'Only the admin can upload files.' });

  const q = req.query || {};
  const id = String(q.id || '');
  if (!/^[a-z0-9]{8,40}$/.test(id)) return res.status(400).json({ error: 'Bad upload request.' });
  const tmp = (n) => 'uploads-tmp/' + id + '/' + n;

  try {
    if (q.action === 'chunk') {
      const n = Number(q.n);
      if (!Number.isInteger(n) || n < 0 || n >= MAX_PARTS) return res.status(400).json({ error: 'That file is too big. Keep each file under 20MB.' });
      const buf = Buffer.isBuffer(req.body) ? req.body : null;
      if (!buf || !buf.length) return res.status(400).json({ error: 'The upload arrived empty. Try again.' });
      if (buf.length > MAX_CHUNK) return res.status(413).json({ error: 'That upload piece is too large.' });
      await putBin(tmp(n), buf, 'application/octet-stream');
      return res.json({ ok: true });
    }

    if (q.action === 'finish') {
      const body = req.body || {};
      const total = Number(body.total);
      if (!Number.isInteger(total) || total < 1 || total > MAX_PARTS) return res.status(400).json({ error: 'Bad upload request.' });
      const parts = [];
      let size = 0;
      for (let i = 0; i < total; i++) {
        const b = await getBin(tmp(i));
        if (!b) return res.status(400).json({ error: 'The upload was interrupted. Try again.' });
        size += b.length;
        if (size > MAX_BYTES) { await delBlobs(Array.from({ length: total }, (_, k) => tmp(k))); return res.status(413).json({ error: 'That file is too big. Keep each file under 20MB.' }); }
        parts.push(b);
      }
      const buf = Buffer.concat(parts);
      const type = sniff(buf);
      if (!type) { await delBlobs(Array.from({ length: total }, (_, k) => tmp(k))); return res.status(400).json({ error: 'Upload a JPG, PNG, or PDF file.' }); }

      const path = 'uploads/' + c.randomBytes(8).toString('hex') + '.' + TYPES[type];
      const r = await putBin(path, buf, type);
      await delBlobs(Array.from({ length: total }, (_, k) => tmp(k)));
      return res.json({ access: r.access, path, url: r.url, name: String(body.name || '').trim().slice(0, 120), type, size: buf.length });
    }

    res.status(400).json({ error: 'Bad upload request.' });
  } catch (e) {
    res.status(500).json({ error: String(e.message || '').startsWith('Storage:') ? e.message : 'Upload failed. Check that a Blob store is connected to this project.' });
  }
};
