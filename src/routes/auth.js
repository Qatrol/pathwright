// Регистрация, вход, выход, текущий пользователь, смена пароля.
const express = require('express');
const { wrapRouter } = require('../lib/wrap');
const router = wrapRouter(express.Router());
const { CONFIG } = require('../config');
const { hashPassword, verifyPassword, validate } = require('../auth/passwords');
const {
  createUser, findByEmail, findById, updateUser, touchLogin, publicUser, validEmail
} = require('../auth/users');
const {
  createSession, destroySession, destroyUserSessions
} = require('../auth/sessions');
const {
  requireAuth, setSessionCookie, clearSessionCookie, readToken,
  checkLoginAllowed, recordLoginFailure, clearLoginFailures,
  checkRegistrationAllowed, recordRegistration,
  checkPasswordChangeAllowed, recordPasswordFailure, clearPasswordFailures
} = require('../auth/middleware');
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
    paymentStub: provider.stubEnabled()
  };
}

function clientMeta(req) {
  return {
    ip: req.ip || req.socket.remoteAddress || null,
    userAgent: req.headers['user-agent'] || ''
  };
}

router.post('/api/auth/register', async function (req, res) {
  if (!CONFIG.registrationOpen) {
    return res.status(403).json({ error: 'Регистрация закрыта', code: 'REGISTRATION_CLOSED' });
  }

  const body = req.body || {};
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
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
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  if (!email || !password) {
    return res.status(400).json({ error: 'Email и пароль обязательны', code: 'MISSING_CREDENTIALS' });
  }

  const limit = checkLoginAllowed(req, email);
  if (!limit.allowed) {
    return res.status(429).json({ error: 'Слишком много попыток входа. Повторите позже.', code: 'TOO_MANY_ATTEMPTS' });
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
