const crypto = require('crypto');
const { session, readJSON, writeJSON, putBin, getBin, delBlobs } = require('./_lib');
const DATA = 'unfinished-acts/modules.json';
const MAX_BYTES = 30 * 1024 * 1024, MAX_CHUNK = 4000000, MAX_PARTS = 8, MAX_FILES = 10;
const TMP = (id, n) => 'modules-tmp/' + id + '/' + n;
const cleanText = (value, max) => String(value || '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, max);
const cleanName = (value) => String(value || 'Module file').replace(/[\\/\x00-\x1f]/g, '').trim().slice(0, 160) || 'Module file';
const cleanIcon = (value) => String(value || '').trim().slice(0, 8);
const cleanColor = (value) => /^#[0-9a-f]{6}$/i.test(String(value || '')) ? String(value).toLowerCase() : null;
const fileType = (value) => /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(String(value || '')) ? String(value).slice(0, 100) : 'application/octet-stream';
const filesOf = (item) => Array.isArray(item.files) ? item.files : (item.path ? [{ id: item.fileId || item.id, path: item.path, name: item.fileName || item.name, type: item.type, size: item.size, access: item.access, url: item.url }] : []);
const fileKey = (file) => String(file.id || file.path || '');
const tempPaths = (uploads) => uploads.flatMap((upload) => Array.from({ length: Number(upload.total) || 0 }, (_, n) => TMP(String(upload.id || ''), n)));

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const s = session(req);
  if (!s || !s.uid) return res.status(401).json({ error: 'Sign in to open Modules.' });
  let cleanupTemps = [], cleanupCreated = [];
  try {
    const modules = await readJSON(DATA, []);
    const profiles = await readJSON('unfinished-acts/profiles.json', {});
    const decorate = () => modules.map((item) => {
      const files = filesOf(item).map((file) => ({
        id: fileKey(file), name: file.name || 'Module file', size: Number(file.size) || 0, type: file.type || 'application/octet-stream',
      }));
      return Object.assign({}, item, {
        files, size: files.reduce((sum, file) => sum + file.size, 0),
        uploader: String((profiles[item.uid] || {}).name || item.uploader || 'Student'),
        own: item.uid === s.uid,
      });
    });
    if (req.method === 'GET') return res.json({ modules: decorate() });

    const q = req.query || {}, job = String(q.id || '');
    if (q.action === 'chunk' && req.method === 'POST') {
      if (s.role !== 'admin') return res.status(403).json({ error: 'Only admins can upload modules.' });
      if (!/^[a-f0-9]{16,32}$/i.test(job)) return res.status(400).json({ error: 'Invalid upload session.' });
      const n = Number(q.n), buf = Buffer.isBuffer(req.body) ? req.body : null;
      if (!Number.isInteger(n) || n < 0 || n >= MAX_PARTS || !buf || !buf.length || buf.length > MAX_CHUNK) return res.status(400).json({ error: 'Invalid upload part.' });
      await putBin(TMP(job, n), buf, 'application/octet-stream');
      return res.json({ ok: true });
    }
    if (q.action === 'finish' && req.method === 'POST') {
      if (s.role !== 'admin') return res.status(403).json({ error: 'Only admins can upload modules.' });
      const b = req.body || {}, title = cleanText(b.title || b.name || 'Module', 120);
      const subject = cleanText(b.subject, 60), description = cleanText(b.description, 2000);
      if (!title || !subject) return res.status(400).json({ error: 'Add a module name and subject.' });
      const uploads = Array.isArray(b.uploads) ? b.uploads : (job && b.total ? [{ id: job, total: b.total, name: b.fileName || b.name, type: b.type }] : []);
      if (!uploads.length) return res.status(400).json({ error: 'Choose at least one module file.' });
      if (uploads.length > MAX_FILES) return res.status(400).json({ error: 'You can attach up to 10 module files.' });
      const groupId = crypto.randomBytes(8).toString('hex');
      cleanupTemps = tempPaths(uploads);
      const storedFiles = [];
      for (const upload of uploads) {
        const uploadId = String(upload.id || ''), total = Number(upload.total);
        if (!/^[a-f0-9]{16,32}$/i.test(uploadId) || !Number.isInteger(total) || total < 1 || total > MAX_PARTS) return res.status(400).json({ error: 'Invalid upload parts.' });
        const parts = []; let size = 0;
        for (let i = 0; i < total; i++) {
          const part = await getBin(TMP(uploadId, i));
          if (!part) return res.status(400).json({ error: 'Upload was interrupted. Please try again.' });
          size += part.length;
          if (size > MAX_BYTES) return res.status(413).json({ error: 'Each module file must be 30 MB or smaller.' });
          parts.push(part);
        }
        const file = Buffer.concat(parts), fileName = cleanName(upload.name);
        const extMatch = /\.([a-z0-9]{1,12})$/i.exec(fileName), ext = extMatch ? '.' + extMatch[1].toLowerCase() : '';
        const fileId = crypto.randomBytes(8).toString('hex'), path = 'modules/' + groupId + '-' + fileId + ext;
        const type = fileType(upload.type), stored = await putBin(path, file, type);
        cleanupCreated.push(path);
        storedFiles.push({ id: fileId, path, access: stored.access, url: stored.url, name: fileName, type, size });
      }
      const profile = profiles[s.uid] || {};
      modules.unshift({
        id: groupId, uid: s.uid, name: title, subject, description,
        fileName: storedFiles[0].name, path: storedFiles[0].path, fileId: storedFiles[0].id,
        type: storedFiles[0].type, files: storedFiles, size: storedFiles.reduce((sum, file) => sum + file.size, 0),
        icon: cleanIcon(b.icon), color: cleanColor(b.color), at: new Date().toISOString(),
        uploader: String(profile.name || 'Admin').slice(0, 40), role: s.role,
      });
      await writeJSON(DATA, modules);
      cleanupCreated = [];
      await delBlobs(cleanupTemps); cleanupTemps = [];
      return res.json({ modules: decorate() });
    }

    const moduleId = job.slice(0, 32);
    if (req.method === 'DELETE') {
      const i = modules.findIndex((item) => item.id === moduleId);
      if (i < 0) return res.status(404).json({ error: 'Module not found.' });
      if (modules[i].uid !== s.uid && s.role !== 'admin') return res.status(403).json({ error: 'Only the uploader or an admin can delete this module.' });
      const [removed] = modules.splice(i, 1);
      await writeJSON(DATA, modules);
      await delBlobs(filesOf(removed).map((file) => file.path).filter(Boolean));
      return res.json({ modules: decorate() });
    }
    return res.status(405).end();
  } catch (e) {
    if (cleanupTemps.length) await delBlobs(cleanupTemps);
    if (cleanupCreated.length) await delBlobs(cleanupCreated);
    return res.status(500).json({ error: String(e.message || '').startsWith('Storage:') ? e.message : 'Modules are unavailable. Check the connected Blob store.' });
  }
};
