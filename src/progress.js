// Прогресс по темам: storage/progress.json плюс сводка для промптов.
const path = require('path');
const { CONFIG } = require('./config');
const { atomicWrite, readJson } = require('./lib/fsjson');
const { roadmap } = require('./roadmap');

const PROGRESS_FILE = path.join(CONFIG.storageDir, 'progress.json');
let progressCache = null;
let progressLoadedAt = 0;

async function loadProgress() {
  if (progressCache && Date.now() - progressLoadedAt < 5000) return progressCache;
  progressCache = (await readJson(PROGRESS_FILE, {})) || {};
  progressLoadedAt = Date.now();
  return progressCache;
}

async function saveProgressData(data) {
  // Сначала диск: если запись упала, кэш в памяти не должен делать вид, что всё сохранено.
  await atomicWrite(PROGRESS_FILE, JSON.stringify(data, null, 2));
  progressCache = data;
  progressLoadedAt = Date.now();
}

async function buildProgressSummary() {
  const p = await loadProgress();
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

async function getMonthContext(monthId) {
  const month = roadmap.months.find(function (m) { return m.month === Number(monthId); });
  if (!month) return null;
  const p = await loadProgress();
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

module.exports = {
  PROGRESS_FILE,
  loadProgress,
  saveProgressData,
  buildProgressSummary,
  getMonthContext
};
