// Express-приложение: статика из public/, авторизация и API-роутеры.
const express = require('express');
const path = require('path');
const { ROOT, CONFIG } = require('./config');
const { originGuard } = require('./auth/middleware');

const app = express();
app.disable('x-powered-by');

// За reverse-proxy (nginx, Caddy) нужен реальный IP и https для куки.
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

// Безопасные заголовки. Приложение не встраивается в iframe и не грузит
// сторонние скрипты; connect-src нужен для SSE и fetch к своему же серверу.
app.use(function (req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; " +
    "form-action 'self'; frame-ancestors 'none'");
  if (CONFIG.cookieSecure) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.use(express.json({ limit: '200kb' }));

// CSRF: сверяем Origin у всех изменяющих запросов.
app.use(originGuard);

// Платные запросы к модели: не больше 20 в минуту с адреса.
// Это грубая сетка от циклов и чужих скриптов; точный лимит по тарифу
// считает billing/guard.js уже по аккаунту.
const LLM_PATHS = new Set([
  '/api/explain', '/api/ask', '/api/task', '/api/quiz',
  '/api/project/start', '/api/project/ask'
]);
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60000;
const rateBuckets = new Map();

app.use(function (req, res, next) {
  // Слэш в конце не должен обходить лимит: /api/explain/ — тот же маршрут.
  const path = req.path.replace(/\/+$/, '') || '/';
  if (req.method !== 'POST' || !LLM_PATHS.has(path)) return next();

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
    for (const [bucketKey, b] of rateBuckets) {
      if (now > b.reset) rateBuckets.delete(bucketKey);
    }
  }
  next();
});

// Публичные маршруты: вход/регистрация и каталог тарифов живут до авторизации.
// Внутри billing защищённые ручки сами требуют сессию.
app.use(require('./routes/auth'));
app.use(require('./routes/billing'));

// Остальные роутеры сами вешают requireAuth на /api: так неизвестный
// /api/... по-прежнему отдаёт 404, а не 401.
app.use(require('./routes/system'));
app.use(require('./routes/progress'));
app.use(require('./routes/topics'));
app.use(require('./routes/projects'));

// Статика после API: файл public/api/... не должен перекрывать маршрут.
app.use(express.static(path.join(ROOT, 'public'), {
  extensions: ['html'],
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  setHeaders: function (res, filePath) {
    // HTML не кэшируем надолго: после деплоя новая разметка должна
    // подхватываться сразу, а не через час.
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

app.get('/', function (req, res) {
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

app.use(function (req, res) {
  res.status(404).json({ error: 'Не найдено' });
});

app.use(function (err, req, res, next) {
  console.error('[express]', err && err.message);
  if (res.headersSent) return next(err);

  // Ошибки body-parser (битый JSON, слишком большое тело) — это 400/413,
  // а не «внутренняя ошибка»: иначе импорт бэкапа выглядит как падение сервера.
  const status = err && (err.status || err.statusCode);
  if (status >= 400 && status < 500) {
    const message = status === 413
      ? 'Тело запроса слишком большое'
      : 'Некорректный запрос';
    return res.status(status).json({ error: message });
  }

  res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

module.exports = app;
