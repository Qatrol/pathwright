// Проекты месяца: план, история шагов и прогресс по конкретной сессии.
const path = require('path');
const { DIRS } = require('../config');
const { safeId, atomicWrite, readJson } = require('../lib/fsjson');

const memProjects = new Map();
const MEM_LIMIT = 200;

function evictOldest(map, limit) {
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

function projectFile(sessionId, monthId) {
  // monthId приходит из тела запроса: без проверки через него можно выйти
  // из storage/projects и перезаписать любой .json в проекте.
  const month = Number(monthId);
  if (!Number.isInteger(month) || month < 0 || month > 99) {
    throw new Error('Invalid monthId');
  }
  return path.join(DIRS.projects, safeId(sessionId) + '__month' + month + '.json');
}

async function loadProject(sessionId, monthId) {
  const key = sessionId + '__month' + monthId;
  if (memProjects.has(key)) return memProjects.get(key);
  let data = await readJson(projectFile(sessionId, monthId), null);
  if (!data) {
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

async function saveProject(p) {
  p.updatedAt = Date.now();
  await atomicWrite(projectFile(p.sessionId, p.monthId), JSON.stringify(p, null, 2));
  memProjects.set(p.sessionId + '__month' + p.monthId, p);
  evictOldest(memProjects, MEM_LIMIT);
  return p;
}

module.exports = { memProjects, projectFile, loadProject, saveProject };
