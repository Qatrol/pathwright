// Серверные сессии: в куке лежит случайный токен, на диске — только его
// SHA-256. Утечка storage/auth/sessions.json не даёт войти под пользователем.
const path = require('path');
const crypto = require('crypto');
const { CONFIG } = require('../config');
const { atomicWrite, readJsonStrict } = require('../lib/fsjson');

const SESSIONS_FILE = path.join(CONFIG.storageDir, 'auth', 'sessions.json');

let byTokenHash = null;
let loading = null;
let writeQueue = Promise.resolve();

function withWriteLock(fn) {
  const run = writeQueue.then(fn, fn);
  writeQueue = run.then(function () {}, function () {});
  return run;
}

async function load() {
  if (byTokenHash) return;
  if (loading) return loading;
  loading = (async function () {
    const data = await readJsonStrict(SESSIONS_FILE, { version: 1, sessions: {} });
    byTokenHash = new Map(Object.entries((data && data.sessions) || {}));
  })();
  try {
    await loading;
  } finally {
    loading = null;
  }
}

async function persist() {
  const sessions = {};
  for (const [hash, rec] of byTokenHash) sessions[hash] = rec;
  await atomicWrite(SESSIONS_FILE, JSON.stringify({ version: 1, sessions }, null, 2), { private: true });
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

async function createSession(userId, meta) {
  return withWriteLock(async function () {
    await load();
    const now = Date.now();
    const token = newToken();
    const rec = {
      userId: userId,
      createdAt: now,
      expiresAt: now + CONFIG.authSessionTtlMs,
      ip: (meta && meta.ip) || null,
      userAgent: (meta && meta.userAgent || '').slice(0, 200)
    };

    // Не даём одному аккаунту бесконечно копить живые сессии.
    const owned = [];
    for (const [hash, s] of byTokenHash) {
      if (s.userId !== userId) continue;
      if (s.expiresAt <= now) { byTokenHash.delete(hash); continue; }
      owned.push([hash, s.createdAt]);
    }
    owned.sort(function (a, b) { return a[1] - b[1]; });
    while (owned.length >= CONFIG.maxSessionsPerUser) {
      byTokenHash.delete(owned.shift()[0]);
    }

    byTokenHash.set(hashToken(token), rec);
    await persist();
    return { token: token, expiresAt: rec.expiresAt };
  });
}

async function getSession(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  await load();
  const hash = hashToken(token);
  const rec = byTokenHash.get(hash);
  if (!rec) return null;
  if (!rec.expiresAt || rec.expiresAt <= Date.now()) {
    byTokenHash.delete(hash);
    return null;
  }
  return Object.assign({ tokenHash: hash }, rec);
}

// Скользящее продление: если до конца осталось меньше половины срока,
// сессия живёт ещё один полный срок. Запись редкая, не на каждый запрос.
async function touchSession(tokenHash, expiresAt) {
  if (!byTokenHash) return false;
  const rec = byTokenHash.get(tokenHash);
  if (!rec) return false;
  const now = Date.now();
  if (expiresAt - now > CONFIG.authSessionTtlMs / 2) return false;
  return withWriteLock(async function () {
    const fresh = byTokenHash.get(tokenHash);
    if (!fresh) return false;
    fresh.expiresAt = now + CONFIG.authSessionTtlMs;
    await persist();
    return true;
  });
}

async function destroySession(token) {
  if (typeof token !== 'string') return;
  return withWriteLock(async function () {
    await load();
    if (byTokenHash.delete(hashToken(token))) await persist();
  });
}

async function destroyUserSessions(userId) {
  return withWriteLock(async function () {
    await load();
    let changed = false;
    for (const [hash, rec] of byTokenHash) {
      if (rec.userId === userId) { byTokenHash.delete(hash); changed = true; }
    }
    if (changed) await persist();
    return changed;
  });
}

async function cleanupExpired() {
  return withWriteLock(async function () {
    await load();
    const now = Date.now();
    let removed = 0;
    for (const [hash, rec] of byTokenHash) {
      if (!rec.expiresAt || rec.expiresAt <= now) { byTokenHash.delete(hash); removed++; }
    }
    if (removed) {
      await persist();
      console.log('[cleanup-auth] удалено сессий: ' + removed);
    }
    return removed;
  });
}

function resetCache() {
  byTokenHash = null;
  loading = null;
}

module.exports = {
  SESSIONS_FILE,
  createSession,
  getSession,
  touchSession,
  destroySession,
  destroyUserSessions,
  cleanupExpired,
  resetCache
};
