const c = require('crypto');
const blob = () => require('@vercel/blob');

const secret = () => process.env.SESSION_SECRET || '';

// ---------------------------------------------------------------- sessions
function sign(role, uid) {
  const p = Buffer.from(JSON.stringify({ r: role, u: String(uid || ''), e: Date.now() + 7 * 864e5 })).toString('base64url');
  return p + '.' + c.createHmac('sha256', secret()).update(p).digest('base64url');
}

function session(req) {
  const m = /(?:^|; )ua=([^;]+)/.exec(req.headers.cookie || '');
  if (!m || !secret()) return null;
  const [p, s] = m[1].split('.');
  if (!p || !s) return null;
  const a = Buffer.from(s), b = Buffer.from(c.createHmac('sha256', secret()).update(p).digest('base64url'));
  if (a.length !== b.length || !c.timingSafeEqual(a, b)) return null;
  try { const d = JSON.parse(Buffer.from(p, 'base64url')); return d.e > Date.now() ? { role: d.r, uid: d.u || '' } : null; }
  catch { return null; }
}

function verify(req) { const s = session(req); return s && s.role; }

function same(a, b) {
  const h = (x) => c.createHash('sha256').update(String(x)).digest();
  return c.timingSafeEqual(h(a), h(b));
}

// ----------------------------------------------------------------- storage
// Everything lives in a Vercel Blob store. A store is either public or private (fixed when it
// was created), so each call tries whichever works and remembers it for this warm instance.
let mode = null;

async function attempt(fn) {
  const errs = [];
  for (const access of mode ? [mode] : ['private', 'public']) {
    try { return await fn(access); }
    catch (e) { errs.push(access + ' store: ' + String((e && e.message) || e).slice(0, 180)); }
  }
  console.error('Blob storage error', errs);
  throw new Error('Storage: Blob failed. ' + errs.join(' || ') + ' -- Connect a Blob store to this project in Vercel and redeploy.');
}

async function readJSON(path, fallback) {
  return attempt(async (access) => {
    const r = await blob().get(path, { access, useCache: false });
    if (!r || r.statusCode !== 200) return fallback;
    mode = access;
    return JSON.parse(await new Response(r.stream).text());
  });
}

async function writeJSON(path, obj) {
  return attempt(async (access) => {
    await blob().put(path, JSON.stringify(obj), {
      access, allowOverwrite: true, addRandomSuffix: false, contentType: 'application/json', cacheControlMaxAge: 60,
    });
    mode = access;
  });
}

async function putBin(path, buf, contentType) {
  return attempt(async (access) => {
    const r = await blob().put(path, buf, { access, contentType, allowOverwrite: true, addRandomSuffix: false });
    mode = access;
    return { access, url: access === 'public' ? r.url : null };
  });
}

async function getBin(path) {
  return attempt(async (access) => {
    const r = await blob().get(path, { access, useCache: false });
    if (!r || r.statusCode !== 200) return null;
    mode = access;
    return Buffer.from(await new Response(r.stream).arrayBuffer());
  });
}

// Best effort: a failed cleanup must never break the request that triggered it.
async function delBlobs(paths) {
  for (const p of paths) {
    try { await blob().del(p); } catch (e) { console.error('Blob delete failed', p, String((e && e.message) || e).slice(0, 120)); }
  }
}

// -------------------------------------------------------------- data model
const TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };
const EXT_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' };
const MAX_FILES = 10, MAX_LINKS = 10;
const TRASH_MS = 7 * 864e5;
const DATA = 'unfinished-acts/activities.json';

const isUrl = (u) => typeof u === 'string' && /^https?:\/\/\S{1,500}$/i.test(u);
const isColor = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

function cleanFile(f) {
  if (!f || typeof f !== 'object') return null;
  const path = String(f.path || '');
  if (!/^uploads\/[A-Za-z0-9._-]{1,80}$/.test(path)) return null;
  const access = f.access === 'public' || f.access === 'private' ? f.access : null;
  if (!access) return null;
  let url = null;
  if (access === 'public') {
    try {
      const u = new URL(String(f.url));
      if (u.protocol === 'https:' && u.hostname.endsWith('.blob.vercel-storage.com')) url = u.href;
    } catch { /* invalid url */ }
    if (!url) return null;
  }
  const type = TYPES[f.type] ? f.type : EXT_TYPES[path.split('.').pop().toLowerCase()];
  if (!type) return null;
  return { access, path, url, name: String(f.name || '').slice(0, 120), type, size: Number(f.size) || 0 };
}

function cleanLinks(list) {
  const out = [];
  for (const u of list) if (isUrl(u) && !out.includes(u)) out.push(u);
  return out.slice(0, MAX_LINKS);
}

// Accepts today's shape and the older one (image / pdf / video / url) so existing activities keep working.
function normActivity(a) {
  const files = [];
  const add = (f) => { const x = cleanFile(f); if (x && !files.some((y) => y.path === x.path)) files.push(x); };
  (Array.isArray(a.files) ? a.files : []).forEach(add);
  add(a.image); add(a.pdf);
  const links = cleanLinks([].concat(Array.isArray(a.links) ? a.links : [], a.video || [], a.url || []));
  return {
    id: String(a.id),
    subject: String(a.subject || '').slice(0, 60),
    icon: String(a.icon || '').slice(0, 8),
    name: String(a.name || '').slice(0, 120),
    notes: String(a.notes || '').slice(0, 2000),
    assigned: a.assigned, due: a.due,
    links, files: files.slice(0, MAX_FILES),
  };
}

async function loadDoc() {
  const raw = await readJSON(DATA, null);
  const doc = Array.isArray(raw) ? { activities: raw } : (raw || {});
  const subjects = {};
  for (const [k, v] of Object.entries(doc.subjects || {})) if (isColor(v)) subjects[String(k).toLowerCase()] = v;
  return {
    activities: (doc.activities || []).map(normActivity),
    trash: (doc.trash || []).map((a) => Object.assign(normActivity(a), { deletedAt: a.deletedAt || new Date().toISOString() })),
    subjects,
    updatedAt: doc.updatedAt || null,
  };
}

async function saveDoc(doc) {
  doc.updatedAt = new Date().toISOString();
  await writeJSON(DATA, doc);
}

// Files that any activity (live or in the bin) still points at.
function fileRefs(doc) {
  const s = new Set();
  for (const a of doc.activities.concat(doc.trash)) for (const f of a.files) s.add(f.path);
  return s;
}

// ----------------------------------------------------------------- lockout
// Wrong-password attempts are counted per client (hashed IP) on the server, so refreshing the
// page or clearing browser data does not reset them.
const LOCK = 'unfinished-acts/lockout.json';
const LOCK_FAILS = 5, LOCK_WINDOW = 15 * 60e3, LOCK_BASE = 5 * 60e3, LOCK_MAX = 60 * 60e3, DAY = 864e5;

function clientKey(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = xf || req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || 'unknown';
  return c.createHmac('sha256', secret() || 'x').update(String(ip)).digest('hex').slice(0, 24);
}

function prune(all, now) {
  for (const k of Object.keys(all)) if (now - (all[k].last || 0) > DAY && (all[k].until || 0) < now) delete all[k];
  return all;
}

async function lockCheck(key) {
  const now = Date.now();
  const all = prune(await readJSON(LOCK, {}), now);
  const e = all[key];
  if (e && e.until > now) return { locked: true, retryAfter: Math.ceil((e.until - now) / 1000), known: true };
  return { locked: false, retryAfter: 0, known: !!e };
}

async function lockFail(key) {
  const now = Date.now();
  const all = prune(await readJSON(LOCK, {}), now);
  const e = all[key] || { fails: 0, last: 0, until: 0, strikes: 0 };
  if (now - e.last > LOCK_WINDOW) e.fails = 0;
  if (now - (e.until || e.last) > DAY) e.strikes = 0;
  e.fails += 1; e.last = now;
  let locked = false, retryAfter = 0;
  if (e.fails >= LOCK_FAILS) {
    e.strikes += 1;
    const dur = Math.min(LOCK_BASE * 2 ** (e.strikes - 1), LOCK_MAX);
    e.until = now + dur; e.fails = 0; locked = true; retryAfter = Math.ceil(dur / 1000);
  }
  all[key] = e;
  await writeJSON(LOCK, all);
  return { locked, retryAfter, left: Math.max(0, LOCK_FAILS - e.fails) };
}

async function lockClear(key) {
  const all = await readJSON(LOCK, {});
  if (all[key]) { delete all[key]; await writeJSON(LOCK, all); }
}

module.exports = {
  sign, verify, session, same, readJSON, writeJSON,
  putBin, getBin, delBlobs,
  TYPES, EXT_TYPES, MAX_FILES, MAX_LINKS, TRASH_MS,
  isUrl, isColor, cleanFile, loadDoc, saveDoc, fileRefs,
  clientKey, lockCheck, lockFail, lockClear,
};
