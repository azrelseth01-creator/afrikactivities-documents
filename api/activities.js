const c = require('crypto');
const {
  verify, loadDoc, saveDoc, fileRefs, delBlobs,
  cleanFile, isUrl, isColor, MAX_FILES, MAX_LINKS, TRASH_MS,
} = require('./_lib');

const MAX_ACTIVITIES = 300;

function view(role, doc) {
  return {
    role,
    activities: doc.activities,
    trash: role === 'admin' ? doc.trash : [],
    subjects: doc.subjects,
    updatedAt: doc.updatedAt,
  };
}

// Items older than 7 days in "Recently deleted" are gone for good.
function dropExpired(doc) {
  const cut = Date.now() - TRASH_MS;
  const gone = doc.trash.filter((a) => new Date(a.deletedAt).getTime() < cut);
  doc.trash = doc.trash.filter((a) => !gone.includes(a));
  return gone;
}

const paths = (a) => a.files.map((f) => f.path);

module.exports = async (req, res) => {
  const role = verify(req);
  if (!role) return res.status(401).json({ error: 'Enter the password to continue.' });
  res.setHeader('Cache-Control', 'no-store');

  try {
    const doc = await loadDoc();
    const expired = dropExpired(doc);
    if (req.method === 'GET') return res.json(view(role, doc));
    if (role !== 'admin') return res.status(403).json({ error: 'Only the admin can change activities.' });

    const q = req.query || {};
    const orphans = [].concat(...expired.map(paths));

    if (req.method === 'POST' && q.action === 'restore') {
      const i = doc.trash.findIndex((x) => x.id === q.id);
      if (i === -1) return res.status(404).json({ error: 'That activity is no longer in Recently deleted.' });
      const a = doc.trash.splice(i, 1)[0];
      delete a.deletedAt;
      doc.activities.push(a);

    } else if (req.method === 'POST' || req.method === 'PUT') {
      const b = req.body || {};
      const subject = String(b.subject || '').trim().slice(0, 60);
      const name = String(b.name || '').trim().slice(0, 120);
      if (!subject || !name || isNaN(Date.parse(b.due)) || isNaN(Date.parse(b.assigned)))
        return res.status(400).json({ error: 'Fill in the subject, name, and both dates.' });

      const rawLinks = Array.isArray(b.links) ? b.links : String(b.links || '').split(/\s+/);
      const links = [];
      for (const u of rawLinks.map((x) => String(x).trim()).filter(Boolean)) {
        if (!isUrl(u)) return res.status(400).json({ error: 'Links must start with http:// or https://, one per line.' });
        if (!links.includes(u)) links.push(u);
      }
      if (links.length > MAX_LINKS) return res.status(400).json({ error: 'You can add up to ' + MAX_LINKS + ' links.' });

      const rawFiles = Array.isArray(b.files) ? b.files : [];
      if (rawFiles.length > MAX_FILES) return res.status(400).json({ error: 'You can attach up to ' + MAX_FILES + ' files.' });
      const files = [];
      for (const f of rawFiles) {
        const x = cleanFile(f);
        if (!x) return res.status(400).json({ error: 'One of the attached files is not valid. Remove it and upload it again.' });
        if (!files.some((y) => y.path === x.path)) files.push(x);
      }

      const rec = {
        subject, name,
        icon: String(b.icon || '').trim().slice(0, 8),
        notes: String(b.notes || '').trim().slice(0, 2000),
        assigned: b.assigned, due: b.due,
        links, files,
      };
      if (isColor(b.color)) doc.subjects[subject.toLowerCase()] = b.color;

      if (req.method === 'PUT') {
        const i = doc.activities.findIndex((x) => x.id === b.id);
        if (i === -1) return res.status(404).json({ error: 'That activity no longer exists.' });
        const old = doc.activities[i];
        doc.activities[i] = Object.assign({}, rec, { id: old.id });
        orphans.push(...paths(old).filter((p) => !files.some((f) => f.path === p)));
      } else {
        if (doc.activities.length >= MAX_ACTIVITIES) return res.status(400).json({ error: 'That is the maximum number of activities. Delete some old ones first.' });
        doc.activities.push(Object.assign({ id: c.randomBytes(6).toString('hex') }, rec));
      }

    } else if (req.method === 'DELETE') {
      if (q.forever === '1') {
        const i = doc.trash.findIndex((x) => x.id === q.id);
        if (i === -1) return res.status(404).json({ error: 'That activity is no longer in Recently deleted.' });
        orphans.push(...paths(doc.trash.splice(i, 1)[0]));
      } else {
        const i = doc.activities.findIndex((x) => x.id === q.id);
        if (i === -1) return res.status(404).json({ error: 'That activity no longer exists.' });
        const a = doc.activities.splice(i, 1)[0];
        doc.trash.unshift(Object.assign({}, a, { deletedAt: new Date().toISOString() }));
      }

    } else {
      return res.status(405).end();
    }

    await saveDoc(doc);
    const refs = fileRefs(doc);
    await delBlobs([...new Set(orphans)].filter((p) => !refs.has(p)));
    res.json(view(role, doc));
  } catch (e) {
    res.status(500).json({ error: String(e.message || '').startsWith('Storage:') ? e.message : 'Storage is not connected. Connect a Blob store to this project in Vercel.' });
  }
};
