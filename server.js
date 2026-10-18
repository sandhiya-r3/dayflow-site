'use strict';

// DayFlow backend: accounts, sessions and journal entries.
// Uses only Node built-ins (Node 18+), so there is nothing to install.
// Data is kept in one JSON file (data/db.json).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY = 100 * 1024;
const TAGS = ['Work', 'Family', 'Friends', 'Health', 'Sleep', 'Exercise', 'Study', 'Rest'];
// The site owner's email. Only this account can remove posts from the community feed.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();

// ---------- storage ----------

fs.mkdirSync(DATA_DIR, { recursive: true });

let db = { users: {}, sessions: {}, entries: {} };
try {
  const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  db = {
    users: loaded.users || {},
    sessions: loaded.sessions || {},
    entries: loaded.entries || {},
  };
} catch (err) {
  if (err.code !== 'ENOENT') {
    console.error('Could not read ' + DB_FILE + ': ' + err.message);
    process.exit(1);
  }
}

function persist() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

function pruneSessions() {
  const now = Date.now();
  let changed = false;
  Object.keys(db.sessions).forEach((k) => {
    if (db.sessions[k].expires < now) {
      delete db.sessions[k];
      changed = true;
    }
  });
  if (changed) persist();
}
pruneSessions();

// ---------- auth helpers ----------

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function passwordMatches(password, user) {
  const candidate = Buffer.from(hashPassword(password, user.salt).hash, 'hex');
  const stored = Buffer.from(user.hash, 'hex');
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '')
    .split(';')
    .forEach((part) => {
      const i = part.indexOf('=');
      if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    });
  return out;
}

function isSecure(req) {
  return Boolean(req.socket.encrypted) || req.headers['x-forwarded-proto'] === 'https';
}

function sessionCookie(req, token, maxAgeSeconds) {
  return (
    'dayflow_sid=' + token +
    '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + maxAgeSeconds +
    (isSecure(req) ? '; Secure' : '')
  );
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[sha256(token)] = { userId, expires: Date.now() + SESSION_MS };
  return token;
}

function currentUser(req) {
  const token = parseCookies(req).dayflow_sid;
  if (!token) return null;
  const session = db.sessions[sha256(token)];
  if (!session) return null;
  if (session.expires < Date.now()) {
    delete db.sessions[sha256(token)];
    return null;
  }
  return db.users[session.userId] || null;
}

// The owner is the account matching ADMIN_EMAIL if that is set, otherwise the first account ever created.
function getOwner() {
  if (ADMIN_EMAIL) return Object.values(db.users).find((u) => u.email === ADMIN_EMAIL) || null;
  const users = Object.values(db.users).sort((a, b) => a.createdAt - b.createdAt);
  return users[0] || null;
}
const isAdmin = (u) => {
  const owner = getOwner();
  return Boolean(owner) && owner.id === u.id;
};
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, isAdmin: isAdmin(u) });

// Simple per-address limit on sign-up and login attempts.
const attempts = new Map();
function tooManyAttempts(req) {
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let a = attempts.get(ip);
  if (!a || a.reset < now) a = { n: 0, reset: now + 15 * 60 * 1000 };
  a.n += 1;
  attempts.set(ip, a);
  return a.n > 30;
}

// ---------- http helpers ----------

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
};

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function sendJson(res, status, body, extraHeaders) {
  res.writeHead(
    status,
    Object.assign(
      { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      SECURITY_HEADERS,
      extraHeaders
    )
  );
  res.end(JSON.stringify(body));
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/application\/json/i.test(req.headers['content-type'] || '')) {
      return reject(new HttpError(415, 'Send the request as JSON.'));
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'That request is too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('not an object');
        }
        resolve(parsed);
      } catch (e) {
        reject(new HttpError(400, 'The request body is not valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch (e) {
    return false;
  }
}

// ---------- validation ----------

function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return false;
  const limit = Date.now() + 2 * 24 * 60 * 60 * 1000; // allow for time zones ahead of the server
  return dt.getTime() <= limit && y >= 2000;
}

function cleanEntry(body) {
  const mood = body.mood;
  if (!Number.isInteger(mood) || mood < 1 || mood > 5) {
    throw new HttpError(400, 'Mood must be a whole number from 1 to 5.');
  }
  let tags = Array.isArray(body.tags) ? body.tags : [];
  tags = tags.filter((t, i) => typeof t === 'string' && TAGS.includes(t) && tags.indexOf(t) === i);
  let note = typeof body.note === 'string' ? body.note.trim() : '';
  if (note.length > 5000) throw new HttpError(400, 'Notes can be up to 5000 characters.');
  // Entries are private unless the author explicitly turns sharing on.
  return { mood, tags, note, shared: body.shared === true, updatedAt: Date.now() };
}

// ---------- API ----------

async function handleApi(req, res, url) {
  const method = req.method;
  const p = url.pathname;

  if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(req)) {
    throw new HttpError(403, 'Cross-site requests are not allowed.');
  }

  if (method === 'POST' && (p === '/api/signup' || p === '/api/login')) {
    if (tooManyAttempts(req)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    const body = await readJson(req);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      throw new HttpError(400, 'Enter a valid email address.');
    }
    if (password.length < 8 || password.length > 200) {
      throw new HttpError(400, 'Password must be 8 to 200 characters.');
    }
    const existing = Object.values(db.users).find((u) => u.email === email);

    if (p === '/api/signup') {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 60) throw new HttpError(400, 'Enter your name (up to 60 characters).');
      if (process.env.ALLOW_SIGNUPS === 'false' && Object.keys(db.users).length > 0) {
        throw new HttpError(403, 'Sign-ups are closed.');
      }
      if (existing) throw new HttpError(409, 'An account with that email already exists. Try logging in.');
      const { salt, hash } = hashPassword(password);
      const user = { id: crypto.randomUUID(), name, email, salt, hash, createdAt: Date.now() };
      db.users[user.id] = user;
      db.entries[user.id] = {};
      const token = createSession(user.id);
      persist();
      return sendJson(res, 201, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(req, token, SESSION_MS / 1000) });
    }

    // login: always hash once so unknown emails take as long as known ones
    const ok = existing ? passwordMatches(password, existing) : (hashPassword(password), false);
    if (!ok) throw new HttpError(401, 'Incorrect email or password.');
    const token = createSession(existing.id);
    persist();
    return sendJson(res, 200, { user: publicUser(existing) }, { 'Set-Cookie': sessionCookie(req, token, SESSION_MS / 1000) });
  }

  if (method === 'POST' && p === '/api/logout') {
    const token = parseCookies(req).dayflow_sid;
    if (token && db.sessions[sha256(token)]) {
      delete db.sessions[sha256(token)];
      persist();
    }
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  // Public page: the owner's shared entries, readable by anyone without logging in.
  // Only the account matching ADMIN_EMAIL is ever included, and only entries it chose to share.
  if (method === 'GET' && p === '/api/public') {
    const owner = getOwner();
    if (!owner) return sendJson(res, 200, { author: '', items: [] });
    const days = db.entries[owner.id] || {};
    const items = Object.keys(days)
      .filter((date) => days[date].shared === true && !days[date].hidden)
      .sort()
      .reverse()
      .slice(0, 200)
      .map((date) => ({ date, mood: days[date].mood, tags: days[date].tags, note: days[date].note }));
    return sendJson(res, 200, { author: owner.name.split(/\s+/)[0], items });
  }

  const user = currentUser(req);
  if (!user) throw new HttpError(401, 'Please log in.');

  if (method === 'GET' && p === '/api/me') {
    return sendJson(res, 200, { user: publicUser(user) });
  }

  if (method === 'GET' && p === '/api/entries') {
    return sendJson(res, 200, { entries: db.entries[user.id] || {} });
  }

  // Community feed: only entries whose author turned sharing on. Shows first name only.
  if (method === 'GET' && p === '/api/feed') {
    const items = [];
    Object.keys(db.entries).forEach((uid) => {
      const owner = db.users[uid];
      if (!owner) return;
      const author = owner.name.split(/\s+/)[0];
      const days = db.entries[uid] || {};
      Object.keys(days).forEach((date) => {
        const e = days[date];
        if (e && e.shared === true && !e.hidden) {
          const item = {
            author,
            date,
            mood: e.mood,
            tags: e.tags,
            note: e.note,
            updatedAt: e.updatedAt,
            mine: uid === user.id,
          };
          if (isAdmin(user)) item.id = uid + '_' + date;
          items.push(item);
        }
      });
    });
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    return sendJson(res, 200, { items: items.slice(0, 100) });
  }

  const f = p.match(/^\/api\/feed\/([0-9a-f-]{36})_(\d{4}-\d{2}-\d{2})$/);
  if (f && method === 'DELETE') {
    if (!isAdmin(user)) throw new HttpError(403, 'Only the site owner can remove posts.');
    const target = db.entries[f[1]] && db.entries[f[1]][f[2]];
    if (!target) throw new HttpError(404, 'Not found.');
    target.shared = false;
    target.hidden = true;
    persist();
    return sendJson(res, 200, { ok: true });
  }

  const m = p.match(/^\/api\/entries\/([^/]+)$/);
  if (m) {
    const date = m[1];
    if (!validDate(date)) throw new HttpError(400, 'Use a valid date like 2026-10-17.');
    if (!db.entries[user.id]) db.entries[user.id] = {};

    if (method === 'PUT') {
      const entry = cleanEntry(await readJson(req));
      const prev = db.entries[user.id][date];
      if (prev && prev.hidden) {
        // The site owner removed this entry from the feed; it cannot be shared again.
        entry.hidden = true;
        entry.shared = false;
      }
      db.entries[user.id][date] = entry;
      persist();
      return sendJson(res, 200, { entry });
    }
    if (method === 'DELETE') {
      delete db.entries[user.id][date];
      persist();
      return sendJson(res, 200, { ok: true });
    }
  }

  throw new HttpError(404, 'Not found.');
}

// ---------- static files ----------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch (e) {
    return sendJson(res, 400, { error: 'Bad request.' });
  }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'Forbidden.' });

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, SECURITY_HEADERS));
      return res.end('Not found');
    }
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-cache' }, SECURITY_HEADERS);
    if (type.startsWith('text/html')) headers['Content-Security-Policy'] = CSP;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (err) {
    if (err instanceof HttpError) {
      if (!res.headersSent) sendJson(res, err.status, { error: err.message });
    } else {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: 'Something went wrong on the server.' });
    }
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('Port ' + PORT + ' is already in use. Close the other program or run with a different port, e.g. PORT=3001 node server.js');
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('DayFlow is running at http://localhost:' + PORT);
  console.log('Data file: ' + DB_FILE);
});
