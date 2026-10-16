const crypto = require('crypto');
const { session, readJSON, writeJSON, putBin, getBin, delBlobs, dropComments, addHistory, viewHistory, TRASH_MS } = require('./_lib');
const DATA = 'unfinished-acts/modules.json', TRASH = 'unfinished-acts/modules-trash.json';
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
    const decorate = (list) => (list || modules).map((item) => {
      const files = filesOf(item).map((file) => ({
        id: fileKey(file), name: file.name || 'Module file', size: Number(file.size) || 0, type: file.type || 'application/octet-stream',
      }));
      return Object.assign({}, item, {
        files, size: files.reduce((sum, file) => sum + file.size, 0),
        uploader: String((profiles[item.uid] || {}).name || item.uploader || 'Student'),
        own: item.uid === s.uid,
        history: viewHistory(item, profiles),
      });
    });

    // "Recently deleted": removed modules wait here for 7 days (admins only), then go for good with their files.
    let trash = [];
    if (s.role === 'admin') {
      trash = await readJSON(TRASH, []);
      const cut = Date.now() - TRASH_MS, gone = trash.filter((m) => new Date(m.deletedAt).getTime() < cut);
      if (gone.length) {
        trash = trash.filter((m) => !gone.includes(m));
        await writeJSON(TRASH, trash);
        await delBlobs(gone.flatMap((m) => filesOf(m).map((f) => f.path)).filter(Boolean));
        for (const m of gone) await dropComments('module:' + m.id);
      }
    }
    const reply = () => res.json({ modules: decorate(), trash: s.role === 'admin' ? decorate(trash) : [] });
    if (req.method === 'GET') return reply();

    const q = req.query || {}, job = String(q.id || '');
    if (req.method === 'POST' && q.action === 'pin') {
      if (s.role !== 'admin') return res.status(403).json({ error: 'Only admins can pin modules.' });
      const m = modules.find((x) => x.id === job);
      if (!m) return res.status(404).json({ error: 'Module not found.' });
      m.pinned = q.pinned === '1';
      await writeJSON(DATA, modules);
      return reply();
    }
    if (req.method === 'POST' && q.action === 'restore') {
      if (s.role !== 'admin') return res.status(403).json({ error: 'Only admins can restore modules.' });
      const i = trash.findIndex((x) => x.id === job);
      if (i < 0) return res.status(404).json({ error: 'That module is no longer in Recently deleted.' });
      const [back] = trash.splice(i, 1);
      delete back.deletedAt;
      modules.push(back);
      modules.sort((a, b) => String(b.at).localeCompare(String(a.at)));
      await writeJSON(DATA, modules);
      await writeJSON(TRASH, trash);
      return reply();
    }
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
      const replaceId = String(b.replaceId || '').slice(0, 32);
      const replaceIndex = replaceId ? modules.findIndex((item) => item.id === replaceId) : -1;
      if (replaceId && replaceIndex < 0) return res.status(404).json({ error: 'The module being edited could not be found.' });
      const oldFiles = replaceIndex >= 0 ? filesOf(modules[replaceIndex]) : [];
      const keepKeys = new Set(Array.isArray(b.keepFiles) ? b.keepFiles.map(String) : []);
      const retained = oldFiles.filter((file) => keepKeys.has(fileKey(file)));
      const uploads = Array.isArray(b.uploads) ? b.uploads : (job && b.total ? [{ id: job, total: b.total, name: b.fileName || b.name, type: b.type }] : []);
      if (!uploads.length && !retained.length) return res.status(400).json({ error: 'Choose at least one module file.' });
      if (uploads.length + retained.length > MAX_FILES) return res.status(400).json({ error: 'You can attach up to 10 module files.' });
      if (uploads.length > MAX_FILES) return res.status(400).json({ error: 'You can attach up to 10 module files.' });
      const groupId = replaceIndex >= 0 ? modules[replaceIndex].id : crypto.randomBytes(8).toString('hex');
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
      const allFiles = retained.concat(storedFiles);
      const fields = {
        name: title, subject, description,
        fileName: allFiles[0].name, path: allFiles[0].path, fileId: allFiles[0].id,
        type: allFiles[0].type, files: allFiles, size: allFiles.reduce((sum, file) => sum + (Number(file.size) || 0), 0),
        icon: cleanIcon(b.icon), color: cleanColor(b.color),
      };
      if (replaceIndex >= 0) {
        // Editing keeps the original uploader and date; only the content changes.
        Object.assign(modules[replaceIndex], fields);
        addHistory(modules[replaceIndex], s, profiles);
      } else {
        modules.unshift(Object.assign({
          id: groupId, uid: s.uid, at: new Date().toISOString(),
          uploader: String(profile.name || 'Admin').slice(0, 40), role: s.role,
        }, fields));
      }
      await writeJSON(DATA, modules);
      cleanupCreated = [];
      await delBlobs(cleanupTemps); cleanupTemps = [];
      const retainedKeys = new Set(retained.map(fileKey));
      const removed = oldFiles.filter((file) => !retainedKeys.has(fileKey(file))).map((file) => file.path).filter(Boolean);
      if (removed.length) await delBlobs(removed);
      return reply();
    }

    const moduleId = job.slice(0, 32);
    if (req.method === 'DELETE' && q.forever === '1') {
      if (s.role !== 'admin') return res.status(403).json({ error: 'Only admins can delete for good.' });
      const i = trash.findIndex((item) => item.id === moduleId);
      if (i < 0) return res.status(404).json({ error: 'That module is no longer in Recently deleted.' });
      const [gone] = trash.splice(i, 1);
      await writeJSON(TRASH, trash);
      await delBlobs(filesOf(gone).map((file) => file.path).filter(Boolean));
      await dropComments('module:' + gone.id);
      return reply();
    }
    if (req.method === 'DELETE') {
      const i = modules.findIndex((item) => item.id === moduleId);
      if (i < 0) return res.status(404).json({ error: 'Module not found.' });
      if (modules[i].uid !== s.uid && s.role !== 'admin') return res.status(403).json({ error: 'Only the uploader or an admin can delete this module.' });
      const [removed] = modules.splice(i, 1);
      trash = (s.role === 'admin' ? trash : await readJSON(TRASH, [])).filter((x) => x.id !== removed.id);
      trash.unshift(Object.assign(removed, { deletedAt: new Date().toISOString() }));
      await writeJSON(TRASH, trash);
      await writeJSON(DATA, modules);
      return reply();
    }
    return res.status(405).end();
  } catch (e) {
    if (cleanupTemps.length) await delBlobs(cleanupTemps);
    if (cleanupCreated.length) await delBlobs(cleanupCreated);
    return res.status(500).json({ error: String(e.message || '').startsWith('Storage:') ? e.message : 'Modules are unavailable. Check the connected Blob store.' });
  }
};
