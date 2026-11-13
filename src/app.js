// Express-приложение: статика из public/ и API-роутеры.
const express = require('express');
const path = require('path');
const { ROOT } = require('./config');

const app = express();
app.disable('x-powered-by');

// Безопасные заголовки. Приложение не встраивается в iframe и не грузит
// сторонние скрипты; connect-src нужен для SSE и fetch к своему же серверу.
app.use(function (req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; " +
    "form-action 'self'; frame-ancestors 'none'");
  next();
});

app.use(express.json({ limit: '200kb' }));

// Простой лимит на платные запросы к модели: не больше 20 в минуту с адреса.
// Защищает от случайного цикла в браузере и от чужого скрипта на localhost.
const LLM_PATHS = new Set([
  '/api/explain', '/api/ask', '/api/task', '/api/quiz',
  '/api/project/start', '/api/project/ask'
]);
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60000;
const rateBuckets = new Map();

app.use(function (req, res, next) {
  if (req.method !== 'POST' || !LLM_PATHS.has(req.path)) return next();

  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || 'local';
  let bucket = rateBuckets.get(key);
  if (!bucket || now > bucket.reset) {
    bucket = { count: 0, reset: now + RATE_WINDOW_MS };
    rateBuckets.set(key, bucket);
  }
  bucket.count++;

  if (bucket.count > RATE_LIMIT) {
    return res.status(429).json({ error: 'Слишком много запросов к модели. Подождите минуту.' });
  }

  // Не даём таблице расти бесконечно.
  if (rateBuckets.size > 1000) {
    for (const [ip, b] of rateBuckets) {
      if (now > b.reset) rateBuckets.delete(ip);
    }
  }
  next();
});

app.use(express.static(path.join(ROOT, 'public'), {
  extensions: ['html'],
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0
}));

app.use(require('./routes/system'));
app.use(require('./routes/progress'));
app.use(require('./routes/topics'));
app.use(require('./routes/projects'));

app.get('/', function (req, res) {
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

app.use(function (req, res) {
  res.status(404).json({ error: 'Не найдено' });
});

app.use(function (err, req, res, next) {
  console.error('[express]', err && err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

module.exports = app;
