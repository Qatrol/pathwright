// Сессии: история диалогов по темам. Теперь у каждого пользователя свой
// каталог storage/users/<uid>/sessions, TTL — 90 дней.
const fsp = require('fs').promises;
const path = require('path');
const { CONFIG, DIRS } = require('../config');
const { safeId, atomicWrite, readJson } = require('../lib/fsjson');
const { userSessionsDir, ensureUserDirs } = require('./userpaths');

// ключ: uid + ':' + sessionId, значение: { uid, data }
const memSessions = new Map();
const MEM_LIMIT = 500;

function evictOldest(map, limit) {
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

function memKey(uid, sessionId) {
  return uid + ':' + sessionId;
}

function sessionFile(uid, sessionId) {
  return path.join(userSessionsDir(uid), safeId(sessionId) + '.json');
}

async function loadSession(uid, sessionId, options) {
  const key = memKey(uid, sessionId);
  if (memSessions.has(key)) return memSessions.get(key).data;
  const create = !options || options.create !== false;

  let data = await readJson(sessionFile(uid, sessionId), null);
  if (!data) {
    // Для чтения «существует ли сессия» не создаём запись в памяти:
    // иначе случайные id из сети копятся до перезапуска.
    if (!create) return null;
    ensureUserDirs(uid);
    data = {
      sessionId: sessionId,
      currentTopicId: null,
      topics: {},
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }
  memSessions.set(key, { uid: uid, data: data });
  evictOldest(memSessions, MEM_LIMIT);
  return data;
}

async function saveSession(uid, s) {
  ensureUserDirs(uid);
  s.updatedAt = Date.now();
  await atomicWrite(sessionFile(uid, s.sessionId), JSON.stringify(s, null, 2));
  memSessions.set(memKey(uid, s.sessionId), { uid: uid, data: s });
  evictOldest(memSessions, MEM_LIMIT);
}

async function flushSessions() {
  for (const entry of memSessions.values()) {
    try {
      await saveSession(entry.uid, entry.data);
    } catch (e) {
      console.error('[flushSessions] сессия ' + entry.data.sessionId + ' не сохранена: ' + e.message);
    }
  }
}

async function cleanupOldSessions() {
  const now = Date.now();
  let removed = 0;
  let userDirs;
  try {
    userDirs = await fsp.readdir(DIRS.users, { withFileTypes: true });
  } catch (e) {
    return; // пользователей ещё нет
  }

  for (const entry of userDirs) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(DIRS.users, entry.name, 'sessions');
    let files;
    try {
      files = await fsp.readdir(dir);
    } catch (e) {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const full = path.join(dir, f);
      try {
        const stat = await fsp.stat(full);
        if (now - stat.mtimeMs > CONFIG.sessionTtlMs) {
          await fsp.unlink(full);
          memSessions.delete(entry.name + ':' + f.replace('.json', ''));
          removed++;
        }
      } catch (e) {
        console.warn('[cleanup-sessions] ' + full + ': ' + e.message);
      }
    }
  }
  if (removed) console.log('[cleanup-sessions] удалено:', removed);
}

module.exports = {
  memSessions,
  memKey,
  sessionFile,
  loadSession,
  saveSession,
  flushSessions,
  cleanupOldSessions
};
