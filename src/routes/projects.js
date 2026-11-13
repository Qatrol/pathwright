// Проекты месяца: план, шаги, экспорт в Markdown, импорт.
const express = require('express');
const { wrapRouter } = require('../lib/wrap');
const router = wrapRouter(express.Router());
const { ROLE, CONFIG } = require('../config');
const { validSession } = require('../lib/fsjson');
const { inFlight } = require('../lib/inflight');
const { trimHistoryByChars } = require('../lib/history');
const { getMonthContext } = require('../progress');
const { loadProject, saveProject } = require('../storage/projects');
const { buildProjectRoleText, PROJECT_PROMPTS, buildProjectSystemPrompt, SYSTEM_GUARD } = require('../prompts');
const { streamDeepSeek, sseError } = require('../llm');
const { guardGeneration, isClientAbort } = require('../billing/guard');
const { requireAuth } = require('../auth/middleware');

router.use('/api/project', requireAuth);

router.get('/api/project/:monthId', async function (req, res) {
  try {
    const sessionId = req.query.sessionId;
    if (!validSession(sessionId)) return res.status(400).json({ error: 'Неверный sessionId' });
    const monthId = parseInt(req.params.monthId, 10);
    const ctx = await getMonthContext(req.user.id, monthId);
    if (!ctx) return res.status(404).json({ error: 'Месяц не найден' });
    const proj = await loadProject(req.user.id, sessionId, monthId);
    res.json({
      month: { month: ctx.month.month, title: ctx.month.title },
      learned: ctx.learned.length,
      total: ctx.total,
      allLearned: ctx.allLearned,
      missing: ctx.missing,
      project: {
        plan: proj.plan,
        history: proj.history,
        currentStep: proj.currentStep,
        totalSteps: proj.totalSteps,
        status: proj.status,
        completedSteps: proj.completedSteps,
        startedAt: proj.startedAt,
        updatedAt: proj.updatedAt
      }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/project/start', async function (req, res) {
  const { sessionId, monthId, force } = req.body || {};
  if (!validSession(sessionId)) return res.status(400).json({ error: 'Неверный sessionId' });
  const uid = req.user.id;
  const ctx = await getMonthContext(uid, monthId);
  if (!ctx) return res.status(404).json({ error: 'Месяц не найден' });
  if (!ctx.allLearned) return res.status(400).json({ error: 'Не все темы изучены', missing: ctx.missing });
  const proj = await loadProject(uid, sessionId, ctx.month.month);

  if (proj.plan && !force) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.write('data: ' + JSON.stringify({ cached: true, plan: true }) + '\n\n');
    res.write('data: ' + JSON.stringify({ delta: proj.plan }) + '\n\n');
    res.write('data: ' + JSON.stringify({ done: true, step: proj.currentStep, totalSteps: proj.totalSteps }) + '\n\n');
    res.end();
    return;
  }

  const key = sessionId + '__month' + ctx.month.month + '__start';
  if (!force && inFlight.has(key)) {
    try {
      const plan = await inFlight.get(key);
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.write('data: ' + JSON.stringify({ cached: true, plan: true }) + '\n\n');
      res.write('data: ' + JSON.stringify({ delta: plan }) + '\n\n');
      res.write('data: ' + JSON.stringify({ done: true }) + '\n\n');
      res.end();
      return;
    } catch (e) {
      return sseError(res, e.message);
    }
  }

  const guard = await guardGeneration(req, res);
  if (!guard) return;

  const promise = (async function () {
    const roleText = await buildProjectRoleText(uid, ctx.month);
    const messages = [
      { role: ROLE.SYSTEM, content: SYSTEM_GUARD + '\n\n' + roleText },
      { role: ROLE.USER, content: PROJECT_PROMPTS.plan(ctx.month, ctx.learned) }
    ];
    const result = await streamDeepSeek(messages, res, 0.55, req, { endpoint: 'project.start', month: ctx.month.month });
    if (result.full.length < 500) throw new Error('Ответ слишком короткий');
    proj.plan = result.full;
    proj.history = [{ role: ROLE.ASSISTANT, content: result.full }];
    proj.status = 'plan_ready';
    proj.startedAt = proj.startedAt || Date.now();
    const stepMatches = result.full.match(/Шаг\s+(\d+)\s*[\.\:]/g) || [];
    if (stepMatches.length) {
      let maxN = 0;
      stepMatches.forEach(function (sm) {
        const nn = parseInt(sm.match(/\d+/)[0], 10);
        if (nn > maxN) maxN = nn;
      });
      proj.totalSteps = maxN;
    }
    proj.currentStep = 1;
    await saveProject(uid, proj);
    return result.full;
  })();

  const tracked = !force;
  if (tracked) inFlight.set(key, promise);
  try {
    await promise;
  } catch (e) {
    if (!isClientAbort(e)) guard.release();
    console.error('[project.start]', e.message);
    sseError(res, e.message);
  } finally {
    // force-запрос не владеет ключом и не должен снимать чужую дедупликацию.
    if (tracked) inFlight.delete(key);
  }
});

router.post('/api/project/ask', async function (req, res) {
  const { sessionId, monthId, question, markStepDone } = req.body || {};
  if (!validSession(sessionId)) return res.status(400).json({ error: 'Неверный sessionId' });
  if (typeof question !== 'string' || !question.trim() || question.length > 4000) {
    return res.status(400).json({ error: 'Пустой или длинный вопрос' });
  }
  const uid = req.user.id;
  const ctx = await getMonthContext(uid, monthId);
  if (!ctx) return res.status(404).json({ error: 'Месяц не найден' });
  const proj = await loadProject(uid, sessionId, ctx.month.month);
  if (!proj.plan) return res.status(400).json({ error: 'Сначала запусти проект' });

  let userText = question;
  if (markStepDone) userText = 'Готово, шаг ' + proj.currentStep + ' выполнен. ' + question;

  const guard = await guardGeneration(req, res);
  if (!guard) return;

  try {
    const DEFENSIVE = /(роли не меняются|не от меня|вставка|О формате)/i;
    const history = trimHistoryByChars(
      proj.history
        .filter(function (m) { return !(m.role === ROLE.ASSISTANT && DEFENSIVE.test(m.content)); })
        .slice(-100),
      CONFIG.maxHistoryChars * 2
    );
    const dialogue = history.concat([{ role: ROLE.USER, content: userText }])
      .map(function (m) {
        const cleanText = String(m.content).replace(/#/g, '');
        return (m.role === ROLE.USER ? 'Ученик: ' : 'Наставник: ') + cleanText;
      })
      .join('\n\n');

    const messages = [
      { role: ROLE.SYSTEM, content: buildProjectSystemPrompt(ctx.month, proj.plan, proj.currentStep, proj.totalSteps, proj.completedSteps) },
      { role: ROLE.USER, content: dialogue }
    ];
    const result = await streamDeepSeek(messages, res, 0.5, req, {
      endpoint: 'project.ask',
      month: ctx.month.month,
      step: proj.currentStep
    });

    proj.history.push({ role: ROLE.USER, content: userText });
    proj.history.push({ role: ROLE.ASSISTANT, content: result.full });
    if (proj.history.length > 300) proj.history = proj.history.slice(-300);
    proj.status = (proj.totalSteps && proj.currentStep >= proj.totalSteps) ? 'completed' : 'in_progress';

    const stepMatch = result.full.match(/(?:Шаг|шаг)\s+(\d+)/);
    if (stepMatch) {
      const nn = parseInt(stepMatch[1], 10);
      const max = proj.totalSteps || 20;
      if (nn > 0 && nn <= max && nn >= proj.currentStep) {
        if (nn > proj.currentStep) {
          for (let ss = proj.currentStep; ss < nn; ss++) {
            if (proj.completedSteps.indexOf(ss) === -1) proj.completedSteps.push(ss);
          }
        }
        proj.currentStep = nn;
      }
    }
    await saveProject(uid, proj);
  } catch (e) {
    if (!isClientAbort(e)) guard.release();
    console.error('[project.ask]', e.message);
    sseError(res, e.message);
  }
});

router.post('/api/project/reset', async function (req, res) {
  const { sessionId } = req.body || {};
  const monthId = Number(req.body && req.body.monthId);
  if (!validSession(sessionId)) return res.status(400).json({ error: 'Неверный sessionId' });
  const uid = req.user.id;
  const ctx = await getMonthContext(uid, monthId);
  if (!ctx) return res.status(404).json({ error: 'Месяц не найден' });
  const proj = await loadProject(uid, sessionId, monthId);
  proj.plan = null;
  proj.history = [];
  proj.currentStep = 1;
  proj.totalSteps = 0;
  proj.completedSteps = [];
  proj.status = 'not_started';
  proj.startedAt = null;
  await saveProject(uid, proj);
  res.json({ ok: true });
});

router.get('/api/project/:monthId/export', async function (req, res) {
  try {
    const sessionId = req.query.sessionId;
    if (!validSession(sessionId)) return res.status(400).json({ error: 'Неверный sessionId' });
    const monthId = Number(req.params.monthId);
    if (!Number.isInteger(monthId) || !(await getMonthContext(req.user.id, monthId))) {
      return res.status(404).json({ error: 'Месяц не найден' });
    }
    const proj = await loadProject(req.user.id, sessionId, monthId);
    if (!proj.plan) return res.status(404).json({ error: 'Проект не начат' });
    let md = '# Проект месяца ' + monthId + '\n\n';
    md += 'Начат: ' + (proj.startedAt ? new Date(proj.startedAt).toLocaleString('ru-RU') : '') + '\n';
    md += 'Текущий шаг: ' + proj.currentStep + ' / ' + (proj.totalSteps || '?') + '\n';
    md += 'Статус: ' + proj.status + '\n\n---\n\n';
    proj.history.forEach(function (m) {
      md += (m.role === 'user' ? '## Ученик\n\n' : '## Наставник\n\n') + m.content + '\n\n---\n\n';
    });
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="project-month-' + monthId + '.md"');
    res.send(md);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/project/import', async function (req, res) {
  const { projects } = req.body || {};
  if (!projects || typeof projects !== 'object') return res.status(400).json({ error: 'projects обязателен' });
  let count = 0;
  let skipped = 0;

  const monthCount = require('../roadmap').roadmap.months.length;

  for (const key of Object.keys(projects)) {
    const p = projects[key];
    // Импорт — недоверенный ввод: без формы и валидных id его нельзя писать на диск.
    if (!p || !validSession(p.sessionId) ||
        !Number.isInteger(p.monthId) || p.monthId < 0 || p.monthId >= monthCount ||
        !Array.isArray(p.history) || (p.plan !== null && typeof p.plan !== 'string')) {
      skipped++;
      continue;
    }
    const historyOk = p.history.every(function (m) {
      return m && (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' && m.content.length <= 100000;
    });
    if (!historyOk) {
      skipped++;
      continue;
    }
    try {
      await saveProject(req.user.id, p);
      count++;
    } catch (e) {
      skipped++;
      console.warn('[project.import] пропущен проект ' + key + ': ' + e.message);
    }
  }

  res.json({ ok: true, count: count, skipped: skipped });
});

module.exports = router;
