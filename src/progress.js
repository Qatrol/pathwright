// Прогресс по темам: у каждого пользователя свой
// storage/users/<uid>/progress.json плюс сводка для промптов.
const { atomicWrite, readJson } = require('./lib/fsjson');
const { roadmap } = require('./roadmap');
const { userProgressFile, ensureUserDirs } = require('./storage/userpaths');

const CACHE_TTL_MS = 5000;
const progressCache = new Map(); // uid -> { data, at }
const writeQueues = new Map();

// Один писатель на пользователя: параллельные сохранения прогресса
// не перетирают друг друга.
function withWriteLock(uid, fn) {
  const prev = writeQueues.get(uid) || Promise.resolve();
  const run = prev.then(fn, fn);
  const settled = run.then(function () {}, function () {});
  writeQueues.set(uid, settled);
  settled.then(function () {
    if (writeQueues.get(uid) === settled) writeQueues.delete(uid);
  });
  return run;
}

const CACHE_LIMIT = 2000;

function cacheProgress(uid, data) {
  progressCache.set(uid, { data: data, at: Date.now() });
  // Каждый uid из запроса добавляет запись: без потолка карта растёт вечно.
  while (progressCache.size > CACHE_LIMIT) {
    progressCache.delete(progressCache.keys().next().value);
  }
}

async function loadProgress(uid) {
  const cached = progressCache.get(uid);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;
  ensureUserDirs(uid);
  const data = (await readJson(userProgressFile(uid), {})) || {};
  cacheProgress(uid, data);
  return data;
}

async function saveProgressData(uid, data) {
  return withWriteLock(uid, async function () {
    // Сначала диск: если запись упала, кэш в памяти не должен делать вид, что всё сохранено.
    ensureUserDirs(uid);
    await atomicWrite(userProgressFile(uid), JSON.stringify(data, null, 2));
    cacheProgress(uid, data);
  });
}

// Слияние с тем, что уже на диске, под тем же замком: кэш в памяти
// может быть на 5 секунд старее, и merge поверх него терял бы запись.
async function mergeProgress(uid, patch) {
  return withWriteLock(uid, async function () {
    ensureUserDirs(uid);
    const current = (await readJson(userProgressFile(uid), {})) || {};
    const merged = Object.assign({}, current, patch);
    await atomicWrite(userProgressFile(uid), JSON.stringify(merged, null, 2));
    cacheProgress(uid, merged);
    return merged;
  });
}

async function buildProgressSummary(uid) {
  const p = await loadProgress(uid);
  const learned = [];
  const inProgress = [];
  const notStarted = [];
  for (const m of roadmap.months) {
    for (const t of m.topics) {
      const st = p[t.id];
      if (st === 'learned') learned.push(t.title);
      else if (st === 'progress') inProgress.push(t.title);
      else notStarted.push(t.title);
    }
  }
  const lines = [];
  lines.push(' УЖЕ ИЗУЧЕНО: ' + (learned.length ? learned.join(', ') + '.' : 'пока ничего.'));
  lines.push(' В ПРОЦЕССЕ (изучается сейчас): ' + (inProgress.length ? inProgress.join(', ') + '.' : 'пока ничего.'));
  const shown = notStarted.length > 5
    ? notStarted.slice(0, 5).join(', ') + ', и ещё ' + (notStarted.length - 5)
    : notStarted.join(', ');
  lines.push(' ЕЩЁ НЕ НАЧАТО (ученик НЕ знает эти темы): ' + (notStarted.length ? shown + '.' : 'всё пройдено.'));
  return lines.join('\n');
}

async function getMonthContext(uid, monthId) {
  const month = roadmap.months.find(function (m) { return m.month === Number(monthId); });
  if (!month) return null;
  const p = await loadProgress(uid);
  const topics = month.topics.map(function (t) {
    return { id: t.id, title: t.title, level: t.level, status: p[t.id] || 'not_started' };
  });
  const learned = topics.filter(function (t) { return t.status === 'learned'; });
  return {
    month: month,
    topics: topics,
    learned: learned,
    total: topics.length,
    allLearned: learned.length === topics.length,
    missing: topics.filter(function (t) { return t.status !== 'learned'; }).map(function (t) { return t.title; })
  };
}

function resetCache() {
  progressCache.clear();
}

module.exports = {
  loadProgress,
  saveProgressData,
  mergeProgress,
  buildProgressSummary,
  getMonthContext,
  resetCache
};
