// Сессии: история диалогов по темам, хранится 90 дней.
const fsp = require('fs').promises;
const path = require('path');
const { CONFIG, DIRS } = require('../config');
const { safeId, atomicWrite, readJson } = require('../lib/fsjson');

const memSessions = new Map();
const MEM_LIMIT = 500;

function evictOldest(map, limit) {
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

function sessionFile(sessionId) {
  return path.join(DIRS.sessions, safeId(sessionId) + '.json');
}

async function loadSession(sessionId, options) {
  if (memSessions.has(sessionId)) return memSessions.get(sessionId);
  const create = !options || options.create !== false;

  let data = await readJson(sessionFile(sessionId), null);
  if (!data) {
    // Для чтения «существует ли сессия» не создаём запись в памяти:
    // иначе случайные id из сети копятся до перезапуска.
    if (!create) return null;
    data = {
      sessionId: sessionId,
      currentTopicId: null,
      topics: {},
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }
  memSessions.set(sessionId, data);
  evictOldest(memSessions, MEM_LIMIT);
  return data;
}

async function saveSession(s) {
  s.updatedAt = Date.now();
  await atomicWrite(sessionFile(s.sessionId), JSON.stringify(s, null, 2));
  memSessions.set(s.sessionId, s);
  evictOldest(memSessions, MEM_LIMIT);
}

async function flushSessions() {
  for (const s of memSessions.values()) {
    try {
      await saveSession(s);
    } catch (e) {
      console.error('[flushSessions] сессия ' + s.sessionId + ' не сохранена: ' + e.message);
    }
  }
}

async function cleanupOldSessions() {
  const now = Date.now();
  try {
    const files = await fsp.readdir(DIRS.sessions);
    let removed = 0;
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const full = path.join(DIRS.sessions, f);
      const stat = await fsp.stat(full);
      if (now - stat.mtimeMs > CONFIG.sessionTtlMs) {
        await fsp.unlink(full);
        memSessions.delete(f.replace('.json', ''));
        removed++;
      }
    }
    if (removed) console.log('[cleanup-sessions] удалено:', removed);
  } catch (e) { /* каталога может не быть */ }
}

module.exports = {
  memSessions,
  sessionFile,
  loadSession,
  saveSession,
  flushSessions,
  cleanupOldSessions
};
