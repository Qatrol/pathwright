// Прогресс, сброс и удаление темы, полный экспорт данных пользователя.
const express = require('express');
const fsp = require('fs').promises;
const path = require('path');
const { wrapRouter } = require('../lib/wrap');
const router = wrapRouter(express.Router());
const { TYPE, CACHE_VERSION } = require('../config');
const { topicIndex } = require('../roadmap');
const { loadProgress, mergeProgress } = require('../progress');
const { validSession, readJson } = require('../lib/fsjson');
const { loadSession, saveSession } = require('../storage/sessions');
const { userSessionsDir, userProjectsDir } = require('../storage/userpaths');
const { dropCache } = require('../storage/cache');
const { requireAuth } = require('../auth/middleware');

router.use(['/api/progress', '/api/reset-topic', '/api/delete-topic', '/api/export'], requireAuth);

router.get('/api/progress', async function (req, res) {
  res.json(await loadProgress(req.user.id));
});

const ALLOWED_STATUS = new Set(['learned', 'progress', 'not_started']);

router.post('/api/progress', async function (req, res) {
  try {
    const { progress } = req.body || {};
    if (!progress || typeof progress !== 'object' || Array.isArray(progress)) {
      return res.status(400).json({ error: 'progress обязателен' });
    }

    // Только темы из программы и только известные статусы: клиент не должен
    // иметь возможности записать в файл произвольный мусор или __proto__.
    const clean = {};
    for (const key of Object.keys(progress)) {
      if (topicIndex.has(key) && ALLOWED_STATUS.has(progress[key])) clean[key] = progress[key];
    }

    const merged = await mergeProgress(req.user.id, clean);
    res.json({ ok: true, count: Object.keys(merged).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/reset-topic', async function (req, res) {
  const { sessionId, topicId } = req.body || {};
  if (!validSession(sessionId)) return res.status(400).json({ error: 'Неверный sessionId' });
  if (!topicIndex.has(topicId)) return res.status(404).json({ error: 'Тема не найдена' });
  const uid = req.user.id;
  const s = await loadSession(uid, sessionId);
  if (s.topics[topicId]) {
    s.topics[topicId].history = [];
    await saveSession(uid, s);
  }
  res.json({ ok: true });
});

router.post('/api/delete-topic', async function (req, res) {
  const { sessionId, topicId } = req.body || {};
  if (!validSession(sessionId)) return res.status(400).json({ error: 'Неверный sessionId' });
  if (!topicIndex.has(topicId)) return res.status(404).json({ error: 'Тема не найдена' });
  const uid = req.user.id;
  // Кэш уроков общий на всех: обычный пользователь не должен его чистить,
  // иначе заставит всех генерировать заново. Админу можно.
  if (req.user.role === 'admin') {
    await dropCache(topicId, TYPE.EXPLAIN);
    await dropCache(topicId, TYPE.TASK);
    await dropCache(topicId, TYPE.QUIZ);
  }
  const s = await loadSession(uid, sessionId);
  if (s.topics[topicId]) {
    delete s.topics[topicId];
    await saveSession(uid, s);
  }
  res.json({ ok: true });
});

router.get('/api/export', async function (req, res) {
  try {
    const uid = req.user.id;
    const sessions = {};
    const sFiles = await fsp.readdir(userSessionsDir(uid)).catch(function () { return []; });
    for (const f of sFiles) {
      if (f.endsWith('.json')) sessions[f.replace('.json', '')] = await readJson(path.join(userSessionsDir(uid), f));
    }
    // Кэш уроков общий для всех аккаунтов: в личный бэкап он не входит.
    const progress = await loadProgress(uid);
    const projects = {};
    const pFiles = await fsp.readdir(userProjectsDir(uid)).catch(function () { return []; });
    for (const f of pFiles) {
      if (f.endsWith('.json')) projects[f.replace('.json', '')] = await readJson(path.join(userProjectsDir(uid), f));
    }
    res.setHeader('Content-Disposition', 'attachment; filename="pathwright-backup.json"');
    res.json({ version: CACHE_VERSION, exportedAt: Date.now(), sessions: sessions, progress: progress, projects: projects });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
