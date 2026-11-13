// Проверка входа, защита от CSRF и лимит попыток входа.
const { CONFIG } = require('../config');
const { getSession, touchSession } = require('./sessions');
const { findById } = require('./users');

function parseCookies(header) {
  const out = {};
  if (!header || typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    let value = part.slice(idx + 1).trim();
    try { value = decodeURIComponent(value); } catch (e) { /* оставляем как есть */ }
    out[key] = value;
  }
  return out;
}

function readToken(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[CONFIG.cookieName];
  return typeof token === 'string' && token ? token : null;
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: CONFIG.cookieSecure,
    path: '/',
    maxAge: CONFIG.authSessionTtlMs
  };
}

function setSessionCookie(res, token) {
  res.cookie(CONFIG.cookieName, token, cookieOptions());
}

function clearSessionCookie(res) {
  const options = cookieOptions();
  delete options.maxAge;
  res.clearCookie(CONFIG.cookieName, options);
}

function unauthorized(res, message) {
  return res.status(401).json({
    error: message || 'Требуется вход',
    code: 'UNAUTHORIZED'
  });
}

// Express 4 не ждёт промисы: async-обработчик оборачиваем явно.
function asyncMiddleware(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

const requireAuth = asyncMiddleware(async function (req, res, next) {
  const token = readToken(req);
  if (!token) return unauthorized(res);

  const record = await getSession(token);
  if (!record) return unauthorized(res, 'Сессия истекла, войдите заново');

  const user = await findById(record.userId);
  if (!user) return unauthorized(res, 'Аккаунт не найден');

  req.user = user;
  req.authToken = token;
  res.locals.user = user;

  // Продление срока. Если сервер сдвинул expiresAt, надо переотправить куку:
  // иначе браузер удалит её по старому Max-Age, и «скользящая» сессия
  // на деле оборвётся на 30-й день.
  touchSession(record.tokenHash, record.expiresAt).then(function (renewed) {
    if (renewed) setSessionCookie(res, token);
  }).catch(function (e) {
    console.warn('[auth] продление сессии не удалось: ' + e.message);
  });

  next();
});

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Доступно только администратору', code: 'FORBIDDEN' });
  }
  next();
}

// SameSite=Lax уже отсекает большинство CSRF, но старые браузеры и
// нестандартные клиенты его игнорируют. Явная сверка Origin — вторая линия.
function originGuard(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

  const origin = req.headers.origin;
  if (!origin) return next(); // curl, серверные вызовы, старые браузеры

  let host;
  try {
    host = new URL(origin).host;
  } catch (e) {
    return res.status(403).json({ error: 'Некорректный Origin', code: 'BAD_ORIGIN' });
  }
  if (host !== req.headers.host) {
    return res.status(403).json({ error: 'Запрос с чужого origin', code: 'BAD_ORIGIN' });
  }
  next();
}

// Попытки входа: 10 на пару адрес+email за 15 минут, 100 на адрес целиком.
// Общий лимит высокий намеренно: за NAT или reverse-proxy без TRUST_PROXY
// у всех один IP, и низкий порог заблокировал бы вход всему офису.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LIMIT_PAIR = 10;
const LOGIN_LIMIT_IP = 100;
const ATTEMPTS_CAP = 5000;
const attempts = new Map();

// Жёсткий потолок: истёкшие записи чистятся, но при всплеске активных
// ключей (поддельный X-Forwarded-For) карта иначе растёт без предела.
function capMap(map, limit) {
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

function loginKey(req, email) {
  return (req.ip || req.socket.remoteAddress || 'local') + '|' + (email || '');
}

function checkLoginAllowed(req, email) {
  const now = Date.now();
  const pair = attempts.get(loginKey(req, email));
  const ip = attempts.get(loginKey(req, ''));

  if (pair && pair.reset > now && pair.count >= LOGIN_LIMIT_PAIR) {
    return { allowed: false, retryAt: pair.reset };
  }
  if (ip && ip.reset > now && ip.count >= LOGIN_LIMIT_IP) {
    return { allowed: false, retryAt: ip.reset };
  }
  return { allowed: true };
}

function recordLoginFailure(req, email, options) {
  const now = Date.now();
  const keys = [loginKey(req, email)];
  // Регистрация на занятый email не должна «заряжать» общий бакет адреса:
  // иначе чужой человек блокирует вход всем, кто сидит за тем же NAT.
  if (!options || options.includeIp !== false) keys.push(loginKey(req, ''));

  for (const key of keys) {
    let bucket = attempts.get(key);
    if (!bucket || bucket.reset <= now) {
      bucket = { count: 0, reset: now + LOGIN_WINDOW_MS };
      attempts.set(key, bucket);
    }
    bucket.count++;
  }
  // Сначала выбрасываем истёкшие, затем — самые старые.
  if (attempts.size > ATTEMPTS_CAP) {
    for (const [key, b] of attempts) {
      if (b.reset <= now) attempts.delete(key);
    }
    capMap(attempts, ATTEMPTS_CAP);
  }
}

function clearLoginFailures(req, email) {
  attempts.delete(loginKey(req, email));
}

// Регистрация: не больше 5 новых аккаунтов в час с одного адреса.
// Без этого аноним может наделать аккаунтов с пробным периодом и жечь
// токены DeepSeek, а каждый запрос ещё и считает scrypt.
const REGISTRATION_WINDOW_MS = 60 * 60 * 1000;
const registrations = new Map();

function registrationKey(req) {
  return req.ip || req.socket.remoteAddress || 'local';
}

function checkRegistrationAllowed(req) {
  const bucket = registrations.get(registrationKey(req));
  const now = Date.now();
  if (bucket && bucket.reset > now && bucket.count >= CONFIG.registrationLimit) {
    return { allowed: false, retryAt: bucket.reset };
  }
  return { allowed: true };
}

function recordRegistration(req) {
  const key = registrationKey(req);
  const now = Date.now();
  let bucket = registrations.get(key);
  if (!bucket || bucket.reset <= now) {
    bucket = { count: 0, reset: now + REGISTRATION_WINDOW_MS };
    registrations.set(key, bucket);
  }
  bucket.count++;

  if (registrations.size > 2000) {
    for (const [k, b] of registrations) {
      if (b.reset <= now) registrations.delete(k);
    }
    capMap(registrations, 2000);
  }
}

// Смена пароля: не больше 5 неверных старых паролей за 15 минут.
// Иначе угнанная сессия может подбирать текущий пароль без ограничений.
const PASSWORD_LIMIT = 5;
const passwordAttempts = new Map();

function checkPasswordChangeAllowed(userId) {
  const bucket = passwordAttempts.get(userId);
  const now = Date.now();
  if (bucket && bucket.reset > now && bucket.count >= PASSWORD_LIMIT) {
    return { allowed: false, retryAt: bucket.reset };
  }
  return { allowed: true };
}

function recordPasswordFailure(userId) {
  const now = Date.now();
  let bucket = passwordAttempts.get(userId);
  if (!bucket || bucket.reset <= now) {
    bucket = { count: 0, reset: now + LOGIN_WINDOW_MS };
    passwordAttempts.set(userId, bucket);
  }
  bucket.count++;
  capMap(passwordAttempts, 2000);
}

function clearPasswordFailures(userId) {
  passwordAttempts.delete(userId);
}

module.exports = {
  parseCookies,
  readToken,
  setSessionCookie,
  clearSessionCookie,
  unauthorized,
  requireAuth,
  requireAdmin,
  originGuard,
  checkLoginAllowed,
  recordLoginFailure,
  clearLoginFailures,
  checkRegistrationAllowed,
  recordRegistration,
  checkPasswordChangeAllowed,
  recordPasswordFailure,
  clearPasswordFailures,
  asyncMiddleware
};
