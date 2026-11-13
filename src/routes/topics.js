// Темы: роадмап, объяснение, вопросы, практика, тест, история.
const express = require('express');
const { wrapRouter } = require('../lib/wrap');
const router = wrapRouter(express.Router());
const { CONFIG, TYPE, ROLE } = require('../config');
const { roadmap, topicIndex } = require('../roadmap');
const { validSession } = require('../lib/fsjson');
const { inFlight } = require('../lib/inflight');
const { trimHistoryByChars } = require('../lib/history');
const { loadSession, saveSession } = require('../storage/sessions');
const { cacheGet, cacheSet } = require('../storage/cache');
const { buildRoleText, PROMPTS, SYSTEM_GUARD } = require('../prompts');
const { streamDeepSeek, streamCached, sseError } = require('../llm');
const { guardGeneration, isClientAbort } = require('../billing/guard');
const { requireAuth } = require('../auth/middleware');

// Роадмап публичен: это данные курса, их видно на странице входа.
router.get('/api/roadmap', function (req, res) {
  res.json(roadmap);
});

// Всё остальное — только с сессией. Список префиксов, а не все /api:
// иначе неизвестный путь отдавал бы 401 вместо 404.
router.use(['/api/cache', '/api/history', '/api/explain', '/api/ask', '/api/task', '/api/quiz'], requireAuth);

router.get('/api/cache/:topicId/:type', async function (req, res) {
  const { topicId, type } = req.params;
  if (!topicIndex.has(topicId)) return res.status(404).json({ error: 'Тема не найдена' });
  if ([TYPE.EXPLAIN, TYPE.TASK, TYPE.QUIZ].indexOf(type) === -1) return res.status(400).json({ error: 'Неверный тип' });
  const c = await cacheGet(topicId, type);
  if (!c) return res.json({ cached: false });
  res.json({ cached: true, answer: c.answer, createdAt: c.createdAt, approxTokens: c.approxTokens });
});

router.get('/api/history/:sessionId', async function (req, res) {
  const { sessionId } = req.params;
  if (!validSession(sessionId)) return res.status(400).json({ error: 'Неверный sessionId' });
  const s = await loadSession(req.user.id, sessionId, { create: false });
  // Вся переписка клиенту не нужна — только точка возврата и счётчик тем.
  res.json({
    currentTopicId: s ? s.currentTopicId : null,
    topicCount: s ? Object.keys(s.topics).length : 0
  });
});

router.post('/api/explain', async function (req, res) {
  const { topicId, sessionId, force } = req.body || {};
  const topic = topicIndex.get(topicId);
  if (!topic) return res.status(404).json({ error: 'Тема не найдена' });
  if (!validSession(sessionId)) return res.status(400).json({ error: 'Неверный sessionId' });
  const uid = req.user.id;
  const s = await loadSession(uid, sessionId);
  s.currentTopicId = topicId;

  // Кэш и ожидание чужой генерации бесплатны: лимит не тратится.
  if (!force) {
    const cached = await cacheGet(topicId, TYPE.EXPLAIN);
    if (cached) {
      if (!s.topics[topicId]) s.topics[topicId] = { history: [], createdAt: Date.now() };
      if (s.topics[topicId].history.length === 0) {
        s.topics[topicId].history.push({ role: ROLE.ASSISTANT, content: cached.answer });
      }
      await saveSession(uid, s);
      return streamCached(res, cached.answer, { topic: topic });
    }
  }

  const key = topicId + '__explain';
  if (!force && inFlight.has(key)) {
    try {
      const answer = await inFlight.get(key);
      // Пользователь получил урок из чужой генерации — зафиксировать его
      // текущую тему всё равно нужно, иначе после перезапуска он её «теряет».
      if (!s.topics[topicId]) s.topics[topicId] = { history: [], createdAt: Date.now() };
      if (s.topics[topicId].history.length === 0) {
        s.topics[topicId].history.push({ role: ROLE.ASSISTANT, content: answer });
      }
      await saveSession(uid, s);
      return streamCached(res, answer, { topic: topic });
    } catch (e) {
      return sseError(res, e.message);
    }
  }

  const guard = await guardGeneration(req, res);
  if (!guard) return;

  const promise = (async function () {
    const roleText = await buildRoleText(uid);
    const messages = [
      { role: ROLE.SYSTEM, content: SYSTEM_GUARD + '\n\n' + roleText },
      { role: ROLE.USER, content: PROMPTS.explain(topic) }
    ];
    const result = await streamDeepSeek(messages, res, CONFIG.temp.explain, req, { endpoint: 'explain', topic: topicId });
    if (result.full.length < 400) throw new Error('Ответ AI слишком короткий');
    await cacheSet(topicId, TYPE.EXPLAIN, result.full, { usage: result.usage, finishReason: result.finishReason });
    if (!s.topics[topicId]) s.topics[topicId] = { history: [], createdAt: Date.now() };
    s.topics[topicId].history = [{ role: ROLE.ASSISTANT, content: result.full }];
    await saveSession(uid, s);
    return result.full;
  })();

  const tracked = !force;
  if (tracked) inFlight.set(key, promise);
  try {
    await promise;
  } catch (e) {
    if (!isClientAbort(e)) guard.release();
    console.error('[explain]', e.message);
    sseError(res, e.message);
  } finally {
    // force-запрос не владеет ключом и не должен снимать чужую дедупликацию.
    if (tracked) inFlight.delete(key);
  }
});

router.post('/api/ask', async function (req, res) {
  const { question, sessionId } = req.body || {};
  if (typeof question !== 'string' || !question.trim() || question.length > 4000) {
    return res.status(400).json({ error: 'Пустой или длинный вопрос' });
  }
  if (!validSession(sessionId)) return res.status(400).json({ error: 'Неверный sessionId' });
  const uid = req.user.id;

  const s = await loadSession(uid, sessionId);
  if (!s.currentTopicId) return res.status(400).json({ error: 'Сначала выбери тему' });
  const topic = topicIndex.get(s.currentTopicId);
  // Сессия могла пережить правку роадмапа: темы больше нет.
  if (!topic) {
    s.currentTopicId = null;
    await saveSession(uid, s);
    return res.status(400).json({ error: 'Тема больше не в программе, выбери другую' });
  }

  const guard = await guardGeneration(req, res);
  if (!guard) return;

  try {
    const ts = s.topics[s.currentTopicId] || { history: [] };
    const history = trimHistoryByChars(
      ts.history.slice(-CONFIG.maxHistoryPerTopic),
      CONFIG.maxHistoryChars
    );

    const roleText = await buildRoleText(uid);
    const messages = [
      { role: ROLE.SYSTEM, content: SYSTEM_GUARD + '\n\n' + roleText },
      { role: ROLE.USER, content: PROMPTS.ask(topic, history.concat([{ role: ROLE.USER, content: question }])) }
    ];
    const result = await streamDeepSeek(messages, res, CONFIG.temp.ask, req, { endpoint: 'ask', topic: s.currentTopicId });

    ts.history.push({ role: ROLE.USER, content: question });
    ts.history.push({ role: ROLE.ASSISTANT, content: result.full });
    if (ts.history.length > CONFIG.maxHistoryPerTopic * 2) ts.history = ts.history.slice(-CONFIG.maxHistoryPerTopic);
    s.topics[s.currentTopicId] = ts;
    await saveSession(uid, s);
  } catch (e) {
    if (!isClientAbort(e)) guard.release();
    console.error('[ask]', e.message);
    sseError(res, e.message);
  }
});

async function handleTopicEndpoint(req, res, type, promptFn, temp) {
  const { sessionId, force } = req.body || {};
  if (!validSession(sessionId)) return res.status(400).json({ error: 'Неверный sessionId' });
  const uid = req.user.id;
  const s = await loadSession(uid, sessionId);
  if (!s.currentTopicId) return res.status(400).json({ error: 'Сначала выбери тему' });
  const topic = topicIndex.get(s.currentTopicId);
  if (!topic) {
    s.currentTopicId = null;
    await saveSession(uid, s);
    return res.status(400).json({ error: 'Тема больше не в программе, выбери другую' });
  }

  if (!force) {
    const cached = await cacheGet(topic.id, type);
    if (cached) return streamCached(res, cached.answer);
  }

  const key = topic.id + '__' + type;
  if (!force && inFlight.has(key)) {
    try {
      const answer = await inFlight.get(key);
      return streamCached(res, answer);
    } catch (e) {
      return sseError(res, e.message);
    }
  }

  const guard = await guardGeneration(req, res);
  if (!guard) return;

  const promise = (async function () {
    const roleText = await buildRoleText(uid);
    const messages = [
      { role: ROLE.SYSTEM, content: SYSTEM_GUARD + '\n\n' + roleText },
      { role: ROLE.USER, content: promptFn(topic) }
    ];
    const result = await streamDeepSeek(messages, res, temp, req, { endpoint: type, topic: topic.id });
    if (result.full.length < 400) throw new Error('Ответ AI слишком короткий');
    await cacheSet(topic.id, type, result.full, { usage: result.usage, finishReason: result.finishReason });
    return result.full;
  })();

  const tracked = !force;
  if (tracked) inFlight.set(key, promise);
  try {
    await promise;
  } catch (e) {
    if (!isClientAbort(e)) guard.release();
    console.error('[' + type + ']', e.message);
    sseError(res, e.message);
  } finally {
    // force-запрос не владеет ключом и не должен снимать чужую дедупликацию.
    if (tracked) inFlight.delete(key);
  }
}

router.post('/api/task', function (req, res) {
  return handleTopicEndpoint(req, res, TYPE.TASK, PROMPTS.task, CONFIG.temp.task);
});

router.post('/api/quiz', function (req, res) {
  return handleTopicEndpoint(req, res, TYPE.QUIZ, PROMPTS.quiz, CONFIG.temp.quiz);
});

module.exports = router;
