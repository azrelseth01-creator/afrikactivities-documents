const { sign, same, clientKey, lockCheck, lockFail, lockClear } = require('./_lib');
const COOKIE = '; Path=/; HttpOnly; Secure; SameSite=Strict';

const wait = (s) => {
  const m = Math.ceil(s / 60);
  return m <= 1 ? 'about a minute' : m + ' minutes';
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', 'ua=; Max-Age=0' + COOKIE);
    return res.json({ ok: true });
  }

  const key = clientKey(req);
  const status = async () => {
    try { return await lockCheck(key); } catch (e) { return { locked: false, retryAfter: 0, known: false }; }
  };

  // The page asks this on load so a refresh still shows the countdown.
  if (req.method === 'GET') {
    const s = await status();
    return res.json({ locked: s.locked, retryAfter: s.retryAfter });
  }

  if (req.method !== 'POST') return res.status(405).end();
  const { NORMAL_PASSWORD: normal, ADMIN_PASSWORD: admin, SESSION_SECRET: secret } = process.env;
  if (!normal || !admin || !secret) return res.status(500).json({ error: 'The site is not configured yet. Set the passwords in Vercel.' });

  const s = await status();
  if (s.locked) {
    res.setHeader('Retry-After', String(s.retryAfter));
    return res.status(429).json({ error: 'Too many wrong tries. Try again in ' + wait(s.retryAfter) + '.', retryAfter: s.retryAfter });
  }

  const pw = (req.body && req.body.password) || '';
  const uid = String(req.body && req.body.deviceId || '').replace(/[^a-f0-9-]/gi, '').slice(0, 64);
  if (!/^[a-f0-9-]{16,64}$/i.test(uid)) return res.status(400).json({ error: 'This device could not be identified. Refresh and try again.' });
  const role = same(pw, admin) ? 'admin' : same(pw, normal) ? 'viewer' : null;

  if (!role) {
    await new Promise((r) => setTimeout(r, 700));
    let f = { locked: false, left: null };
    try { f = await lockFail(key); } catch (e) { console.error('lockout write failed', String(e.message || e).slice(0, 120)); }
    if (f.locked) {
      res.setHeader('Retry-After', String(f.retryAfter));
      return res.status(429).json({ error: 'Too many wrong tries. Try again in ' + wait(f.retryAfter) + '.', retryAfter: f.retryAfter });
    }
    const hint = f.left !== null && f.left <= 2 ? ' ' + f.left + (f.left === 1 ? ' try' : ' tries') + ' left before a timeout.' : '';
    return res.status(401).json({ error: 'That password is not right.' + hint });
  }

  if (s.known) { try { await lockClear(key); } catch (e) { /* not critical */ } }
  res.setHeader('Set-Cookie', 'ua=' + sign(role, uid) + '; Max-Age=604800' + COOKIE);
  res.json({ role });
};
