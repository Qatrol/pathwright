// Прогресс, сброс и удаление темы, полный экспорт данных.
const express = require('express');
const fsp = require('fs').promises;
const path = require('path');
const { wrapRouter } = require('../lib/wrap');
const router = wrapRouter(express.Router());
const { DIRS, TYPE, CACHE_VERSION } = require('../config');
const { topicIndex } = require('../roadmap');
const { loadProgress, saveProgressData } = require('../progress');
const { validSession, readJson } = require('../lib/fsjson');
const { loadSession, saveSession } = require('../storage/sessions');
const { dropCache } = require('../storage/cache');

router.get('/api/progress', async function (req, res) {
  res.json(await loadProgress());
});

router.post('/api/progress', async function (req, res) {
  try {
    const { progress } = req.body || {};
    if (!progress || typeof progress !== 'object') return res.status(400).json({ error: 'progress обязателен' });
    const current = await loadProgress();
    const merged = Object.assign({}, current, progress);
    await saveProgressData(merged);
    res.json({ ok: true, count: Object.keys(merged).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/reset-topic', async function (req, res) {
  const { sessionId, topicId } = req.body || {};
  if (!validSession(sessionId)) return res.status(400).json({ error: 'Неверный sessionId' });
  if (!topicIndex.has(topicId)) return res.status(404).json({ error: 'Тема не найдена' });
  const s = await loadSession(sessionId);
  if (s.topics[topicId]) {
    s.topics[topicId].history = [];
    await saveSession(s);
  }
  res.json({ ok: true });
});

router.post('/api/delete-topic', async function (req, res) {
  const { sessionId, topicId } = req.body || {};
  if (!validSession(sessionId)) return res.status(400).json({ error: 'Неверный sessionId' });
  if (!topicIndex.has(topicId)) return res.status(404).json({ error: 'Тема не найдена' });
  await dropCache(topicId, TYPE.EXPLAIN);
  await dropCache(topicId, TYPE.TASK);
  await dropCache(topicId, TYPE.QUIZ);
  const s = await loadSession(sessionId);
  if (s.topics[topicId]) {
    delete s.topics[topicId];
    await saveSession(s);
  }
  res.json({ ok: true });
});

router.get('/api/export', async function (req, res) {
  try {
    const sessions = {};
    const sFiles = await fsp.readdir(DIRS.sessions);
    for (const f of sFiles) {
      if (f.endsWith('.json')) sessions[f.replace('.json', '')] = await readJson(path.join(DIRS.sessions, f));
    }
    const cache = {};
    const cFiles = await fsp.readdir(DIRS.cache);
    for (const f of cFiles) {
      if (f.endsWith('.json')) cache[f.replace('.json', '')] = await readJson(path.join(DIRS.cache, f));
    }
    const progress = await loadProgress();
    const projects = {};
    try {
      const pFiles = await fsp.readdir(DIRS.projects);
      for (const f of pFiles) {
        if (f.endsWith('.json')) projects[f.replace('.json', '')] = await readJson(path.join(DIRS.projects, f));
      }
    } catch (e) { /* проектов пока нет */ }
    res.setHeader('Content-Disposition', 'attachment; filename="pathwright-backup.json"');
    res.json({ version: CACHE_VERSION, exportedAt: Date.now(), sessions: sessions, cache: cache, progress: progress, projects: projects });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
