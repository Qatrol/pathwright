// Регистрация, вход, выход, профиль, сессии, смена пароля, капча.
const express = require('express');
const { wrapRouter } = require('../lib/wrap');
const router = wrapRouter(express.Router());
const { CONFIG } = require('../config');
const { hashPassword, verifyPassword, validate } = require('../auth/passwords');
const {
  createUser, findByEmail, findById, updateUser, touchLogin, publicUser, validEmail, normalizeEmail
} = require('../auth/users');
const {
  createSession, destroySession, destroyUserSessions,
  listForUser, revokeOthers, revokeById
} = require('../auth/sessions');
const {
  requireAuth, setSessionCookie, clearSessionCookie, readToken,
  checkLoginAllowed, recordLoginFailure, clearLoginFailures, loginFailuresCount,
  checkRegistrationAllowed, recordRegistration,
  checkPasswordChangeAllowed, recordPasswordFailure, clearPasswordFailures
} = require('../auth/middleware');
const captcha = require('../auth/captcha');
const { entitlementFor } = require('../billing/entitlements');
const { getUsage } = require('../billing/usage');
const provider = require('../billing/provider');

// Хэш-пустышка: для незарегистрированного email всё равно считаем scrypt,
// чтобы по времени ответа нельзя было узнать, есть ли такой аккаунт.
let dummyHash = null;
async function equalizeTiming(password) {
  try {
    if (!dummyHash) dummyHash = await hashPassword('timing-equalizer-not-a-real-password');
    await verifyPassword(password, dummyHash);
  } catch (e) {
    console.warn('[auth] выравнивание времени входа не удалось: ' + e.message);
  }
}

async function authPayload(user) {
  const entitlement = entitlementFor(user);
  const usage = await getUsage(user.id);
  return {
    user: publicUser(user),
    entitlement: entitlement,
    usage: {
      today: usage.today,
      month: usage.month,
      dailyLimit: entitlement.plan.dailyGenerations,
      monthlyLimit: entitlement.plan.monthlyGenerations,
      remaining: Math.max(0, Math.min(
        entitlement.plan.dailyGenerations - usage.today,
        entitlement.plan.monthlyGenerations - usage.month
      ))
    },
    // Интерфейс должен честно писать «тестовая оплата» только в заглушке.
    paymentStub: provider.stubEnabled(),
    paymentMode: provider.mode(),
    captchaRequiredOnLogin: false
  };
}

function clientMeta(req) {
  return {
    ip: req.ip || req.socket.remoteAddress || null,
    userAgent: req.headers['user-agent'] || ''
  };
}

// Капча: не больше 60 штук в минуту с адреса. Генерация дешёвая,
// но бесконечный цикл в браузере не должен забивать память.
const captchaBuckets = new Map();
function allowCaptcha(req) {
  const key = req.ip || req.socket.remoteAddress || 'local';
  const now = Date.now();
  let bucket = captchaBuckets.get(key);
  if (!bucket || bucket.reset <= now) {
    bucket = { count: 0, reset: now + 60000 };
    captchaBuckets.set(key, bucket);
  }
  bucket.count++;
  if (captchaBuckets.size > 2000) {
    for (const [k, b] of captchaBuckets) {
      if (b.reset <= now) captchaBuckets.delete(k);
    }
    // Жёсткий потолок: поддельный X-Forwarded-For не должен растить карту.
    while (captchaBuckets.size > 2000) {
      captchaBuckets.delete(captchaBuckets.keys().next().value);
    }
  }
  return bucket.count <= 60;
}

router.get('/api/auth/captcha', function (req, res) {
  if (!allowCaptcha(req)) {
    return res.status(429).json({ error: 'Слишком много запросов капчи', code: 'TOO_MANY_ATTEMPTS' });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json(captcha.create());
});

router.post('/api/auth/register', async function (req, res) {
  if (!CONFIG.registrationOpen) {
    return res.status(403).json({ error: 'Регистрация закрыта', code: 'REGISTRATION_CLOSED' });
  }

  const body = req.body || {};
  const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
  const name = typeof body.name === 'string' ? body.name.trim() : '';

  if (!validEmail(email)) {
    return res.status(400).json({ error: 'Введите корректный email', code: 'INVALID_EMAIL' });
  }
  if (!name || name.length > 60) {
    return res.status(400).json({ error: 'Имя должно быть от 1 до 60 символов', code: 'INVALID_NAME' });
  }
  const passwordProblem = validate(body.password);
  if (passwordProblem) {
    return res.status(400).json({ error: passwordProblem, code: 'INVALID_PASSWORD' });
  }
  if (!captcha.verify(body.captchaId, body.captchaAnswer)) {
    return res.status(400).json({
      error: 'Неверный ответ на капчу. Обновите пример и попробуйте снова.',
      code: 'CAPTCHA_FAILED'
    });
  }

  const limit = checkRegistrationAllowed(req);
  if (!limit.allowed) {
    return res.status(429).json({
      error: 'Слишком много регистраций с этого адреса. Повторите позже.',
      code: 'TOO_MANY_ATTEMPTS'
    });
  }
  const attemptLimit = checkLoginAllowed(req, email);
  if (!attemptLimit.allowed) {
    return res.status(429).json({ error: 'Слишком много попыток. Повторите позже.', code: 'TOO_MANY_ATTEMPTS' });
  }

  let user;
  try {
    const passwordHash = await hashPassword(body.password);
    user = await createUser({ email: email, name: name, passwordHash: passwordHash });
  } catch (e) {
    if (e.code === 'EMAIL_TAKEN') {
      recordLoginFailure(req, email, { includeIp: false });
      return res.status(409).json({ error: 'Аккаунт с таким email уже существует', code: 'EMAIL_TAKEN' });
    }
    if (e.code === 'INVALID_EMAIL' || e.code === 'INVALID_NAME') {
      return res.status(400).json({ error: e.message, code: e.code });
    }
    throw e;
  }

  recordRegistration(req);
  const session = await createSession(user.id, clientMeta(req));
  setSessionCookie(res, session.token);
  res.status(201).json(await authPayload(user));
});

router.post('/api/auth/login', async function (req, res) {
  const body = req.body || {};
  const email = typeof body.email === 'string' ? normalizeEmail(body.email) : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!email || !password) {
    return res.status(400).json({ error: 'Email и пароль обязательны', code: 'MISSING_CREDENTIALS' });
  }
  // Длина проверяется до лимитера и scrypt: иначе email на 200 КБ
  // оседал бы ключом в таблице попыток.
  if (!validEmail(email) || email.length > 254) {
    return res.status(400).json({ error: 'Некорректный email', code: 'INVALID_EMAIL' });
  }

  const limit = checkLoginAllowed(req, email);
  if (!limit.allowed) {
    return res.status(429).json({ error: 'Слишком много попыток входа. Повторите позже.', code: 'TOO_MANY_ATTEMPTS' });
  }

  // После трёх неудач вход требует капчу. Клиент узнаёт об этом по коду
  // CAPTCHA_REQUIRED и показывает поле, не раскрывая лишнего.
  if (loginFailuresCount(req, email) >= 3) {
    if (!captcha.verify(body.captchaId, body.captchaAnswer)) {
      return res.status(401).json({
        error: 'Введите ответ на пример, чтобы продолжить.',
        code: 'CAPTCHA_REQUIRED',
        captchaRequired: true
      });
    }
  }

  const user = await findByEmail(email);
  let ok = false;
  if (user) {
    ok = await verifyPassword(password, user.passwordHash);
  } else {
    await equalizeTiming(password);
  }

  if (!ok) {
    recordLoginFailure(req, email);
    // Одинаковый ответ на «нет такого» и «неверный пароль»: не подсказываем,
    // какие email зарегистрированы.
    return res.status(401).json({ error: 'Неверный email или пароль', code: 'BAD_CREDENTIALS' });
  }

  clearLoginFailures(req, email);
  await touchLogin(user.id);
  const session = await createSession(user.id, clientMeta(req));
  setSessionCookie(res, session.token);

  const fresh = await findById(user.id);
  res.json(await authPayload(fresh || user));
});

router.post('/api/auth/logout', async function (req, res) {
  const token = readToken(req);
  if (token) await destroySession(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/api/auth/me', requireAuth, async function (req, res) {
  res.json(await authPayload(req.user));
});

// Профиль: имя меняется свободно, email — только с подтверждением пароля.
router.post('/api/auth/profile', requireAuth, async function (req, res) {
  const body = req.body || {};
  const patch = {};

  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 60) {
      return res.status(400).json({ error: 'Имя должно быть от 1 до 60 символов', code: 'INVALID_NAME' });
    }
    patch.name = name;
  }

  if (body.email !== undefined) {
    const email = normalizeEmail(body.email);
    if (!validEmail(email)) {
      return res.status(400).json({ error: 'Введите корректный email', code: 'INVALID_EMAIL' });
    }
    if (email !== req.user.email) {
      // Тот же лимит, что и у смены пароля: иначе угнанная сессия может
      // подбирать текущий пароль через эту ручку без ограничений.
      const limit = checkPasswordChangeAllowed(req.user.id);
      if (!limit.allowed) {
        return res.status(429).json({
          error: 'Слишком много попыток. Повторите позже.',
          code: 'TOO_MANY_ATTEMPTS'
        });
      }

      const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
      const ok = await verifyPassword(currentPassword, req.user.passwordHash);
      if (!ok) {
        recordPasswordFailure(req.user.id);
        return res.status(403).json({
          error: 'Для смены email введите текущий пароль',
          code: 'PASSWORD_REQUIRED'
        });
      }
      clearPasswordFailures(req.user.id);
      patch.email = email;
    }
  }

  if (!Object.keys(patch).length) {
    return res.status(400).json({ error: 'Нечего менять', code: 'NOTHING_TO_UPDATE' });
  }

  let updated;
  try {
    updated = await updateUser(req.user.id, patch);
  } catch (e) {
    if (e.code === 'EMAIL_TAKEN') {
      return res.status(409).json({ error: 'Этот email уже занят', code: 'EMAIL_TAKEN' });
    }
    throw e;
  }

  res.json(await authPayload(updated));
});

router.get('/api/auth/sessions', requireAuth, async function (req, res) {
  res.json({ sessions: await listForUser(req.user.id, req.sessionHash) });
});

// Отзыв сессии по короткому id или всех чужих («выйти везде»).
router.post('/api/auth/sessions/revoke', requireAuth, async function (req, res) {
  const body = req.body || {};
  if (body.all === true) {
    const removed = await revokeOthers(req.user.id, req.sessionHash);
    return res.json({ ok: true, removed: removed });
  }

  const id = typeof body.id === 'string' ? body.id : '';
  const revoked = await revokeById(req.user.id, id);
  if (!revoked) {
    return res.status(404).json({ error: 'Сессия не найдена', code: 'NOT_FOUND' });
  }
  res.json({ ok: true });
});

router.post('/api/auth/password', requireAuth, async function (req, res) {
  const body = req.body || {};
  const oldPassword = typeof body.oldPassword === 'string' ? body.oldPassword : '';
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

  const limit = checkPasswordChangeAllowed(req.user.id);
  if (!limit.allowed) {
    return res.status(429).json({
      error: 'Слишком много попыток смены пароля. Повторите позже.',
      code: 'TOO_MANY_ATTEMPTS'
    });
  }

  const ok = await verifyPassword(oldPassword, req.user.passwordHash);
  if (!ok) {
    recordPasswordFailure(req.user.id);
    return res.status(403).json({ error: 'Текущий пароль неверен', code: 'BAD_PASSWORD' });
  }
  const problem = validate(newPassword);
  if (problem) {
    return res.status(400).json({ error: problem, code: 'INVALID_PASSWORD' });
  }
  clearPasswordFailures(req.user.id);

  const passwordHash = await hashPassword(newPassword);
  await updateUser(req.user.id, { passwordHash: passwordHash });
  // Смена пароля разлогинивает везде, включая текущую вкладку: выдаём новую сессию.
  await destroyUserSessions(req.user.id);
  const session = await createSession(req.user.id, clientMeta(req));
  setSessionCookie(res, session.token);

  const fresh = await findById(req.user.id);
  res.json(await authPayload(fresh));
});

module.exports = router;
