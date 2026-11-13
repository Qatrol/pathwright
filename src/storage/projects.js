// Проекты месяца: план, история шагов и прогресс. Файлы лежат в личном
// каталоге пользователя: storage/users/<uid>/projects.
const path = require('path');
const { safeId, atomicWrite, readJson } = require('../lib/fsjson');
const { userProjectsDir, ensureUserDirs } = require('./userpaths');

// ключ: uid + ':' + sessionId + ':month' + N
const memProjects = new Map();
const MEM_LIMIT = 200;

function evictOldest(map, limit) {
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

function memKey(uid, sessionId, monthId) {
  return uid + ':' + sessionId + ':month' + monthId;
}

function projectFile(uid, sessionId, monthId) {
  // monthId приходит из тела запроса: без проверки через него можно выйти
  // из каталога пользователя и перезаписать любой .json в проекте.
  const month = Number(monthId);
  if (!Number.isInteger(month) || month < 0 || month > 99) {
    throw new Error('Invalid monthId');
  }
  return path.join(userProjectsDir(uid), safeId(sessionId) + '__month' + month + '.json');
}

async function loadProject(uid, sessionId, monthId) {
  const key = memKey(uid, sessionId, monthId);
  if (memProjects.has(key)) return memProjects.get(key);
  let data = await readJson(projectFile(uid, sessionId, monthId), null);
  if (!data) {
    ensureUserDirs(uid);
    data = {
      sessionId: sessionId,
      monthId: monthId,
      plan: null,
      history: [],
      currentStep: 1,
      totalSteps: 0,
      status: 'not_started',
      completedSteps: [],
      startedAt: null,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }
  memProjects.set(key, data);
  evictOldest(memProjects, MEM_LIMIT);
  return data;
}

async function saveProject(uid, p) {
  ensureUserDirs(uid);
  p.updatedAt = Date.now();
  await atomicWrite(projectFile(uid, p.sessionId, p.monthId), JSON.stringify(p, null, 2));
  memProjects.set(memKey(uid, p.sessionId, p.monthId), p);
  evictOldest(memProjects, MEM_LIMIT);
  return p;
}

module.exports = { memProjects, memKey, projectFile, loadProject, saveProject };
