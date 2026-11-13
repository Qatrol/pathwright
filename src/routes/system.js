// Служебные маршруты: здоровье, статистика, очистка кэша, отчёт по токенам.
const express = require('express');
const fsp = require('fs').promises;
const path = require('path');
const { wrapRouter } = require('../lib/wrap');
const router = wrapRouter(express.Router());
const { CONFIG, DIRS, CACHE_VERSION } = require('../config');
const { roadmap } = require('../roadmap');
const { loadProgress } = require('../progress');
const { requireAuth, requireAdmin } = require('../auth/middleware');
const { clearCache } = require('../storage/cache');
const { readJson } = require('../lib/fsjson');

// Публичный: используется healthcheck'ом Docker и CI. Наружу — минимум:
// размеры кэшей и число сессий посторонним знать незачем.
router.get('/health', function (req, res) {
  res.json({
    status: 'ok',
    version: 'v5.1',
    cacheVersion: CACHE_VERSION,
    uptime: Math.round(process.uptime())
  });
});

router.use(['/api/stats', '/api/clean-cache', '/api/tokens-report'], requireAuth);

router.get('/api/stats', async function (req, res) {
  try {
    const p = await loadProgress(req.user.id);
    let total = 0;
    let learned = 0;
    let inProg = 0;
    let notStarted = 0;
    const perMonth = [];
    for (const m of roadmap.months) {
      let ml = 0;
      let mp = 0;
      for (const t of m.topics) {
        total++;
        const st = p[t.id];
        if (st === 'learned') { learned++; ml++; }
        else if (st === 'progress') { inProg++; mp++; }
        else notStarted++;
      }
      perMonth.push({ month: m.month, title: m.title, total: m.topics.length, learned: ml, progress: mp });
    }
    let cacheCount = 0;
    let totalTokens = 0;
    try {
      const files = await fsp.readdir(DIRS.cache);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        cacheCount++;
        const d = await readJson(path.join(DIRS.cache, f), null);
        if (d && d.approxTokens) totalTokens += d.approxTokens;
      }
    } catch (e) { /* кэша ещё нет */ }
    res.json({
      total: total,
      learned: learned,
      progress: inProg,
      notStarted: notStarted,
      percent: total ? Math.round(learned / total * 100) : 0,
      cacheFiles: cacheCount,
      approxTokens: totalTokens,
      perMonth: perMonth
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Кэш общий для всех пользователей: чистка — только админу.
router.post('/api/clean-cache', requireAdmin, async function (req, res) {
  try {
    const removed = await clearCache();
    res.json({ ok: true, removed: removed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Расход и стоимость — служебная информация, тоже только админу.
router.get('/api/tokens-report', requireAdmin, async function (req, res) {
  try {
    const files = await fsp.readdir(DIRS.logs).catch(function (e) {
      console.warn('[tokens-report] не удалось прочитать логи: ' + e.message);
      return [];
    });
    const summary = { total: { in: 0, out: 0, hit: 0, miss: 0, count: 0 }, byEndpoint: {}, byDay: {} };
    for (const f of files) {
      if (!f.startsWith('tokens-') || !f.endsWith('.log')) continue;
      const content = await fsp.readFile(path.join(DIRS.logs, f), 'utf8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          summary.total.in += e.in || 0;
          summary.total.out += e.out || 0;
          summary.total.hit += e.hit || 0;
          summary.total.miss += e.miss || 0;
          summary.total.count += 1;
          const ep = e.ep || 'unknown';
          if (!summary.byEndpoint[ep]) summary.byEndpoint[ep] = { in: 0, out: 0, count: 0 };
          summary.byEndpoint[ep].in += e.in || 0;
          summary.byEndpoint[ep].out += e.out || 0;
          summary.byEndpoint[ep].count += 1;
          const day = (e.ts || '').slice(0, 10);
          if (day) {
            if (!summary.byDay[day]) summary.byDay[day] = { in: 0, out: 0, count: 0 };
            summary.byDay[day].in += e.in || 0;
            summary.byDay[day].out += e.out || 0;
            summary.byDay[day].count += 1;
          }
        } catch (e) { /* битая строка лога */ }
      }
    }
    // Оценка стоимости DeepSeek v4-flash (цены за 1M токенов).
    let miss = summary.total.miss || 0;
    let hit = summary.total.hit || 0;
    if (miss === 0 && hit === 0 && summary.total.in > 0) miss = summary.total.in;
    const cost = {
      inMiss: miss * 0.5 / 1000000,
      inHit: hit * 0.1 / 1000000,
      out: (summary.total.out || 0) * 8 / 1000000
    };
    cost.totalCNY = cost.inMiss + cost.inHit + cost.out;
    cost.totalRUB = cost.totalCNY * 13;
    res.json({ summary: summary, cost: cost, days: parseInt(req.query.days || '30', 10), model: CONFIG.model });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
