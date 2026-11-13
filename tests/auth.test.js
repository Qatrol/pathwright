// Регистрация, вход, выход, изоляция данных между аккаунтами.
const test = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pathwright-auth-'));
process.env.DEEPSEEK_API_KEY = 'test-key';
process.env.PORT = '0';
process.env.REGISTRATION_LIMIT = '100';
process.env.TRIAL_DAYS = '7';

const app = require('../src/app');

let server;
let base;

function extractCookie(res) {
  const header = res.headers.get('set-cookie') || '';
  const match = header.match(/pw_session=([^;]+)/);
  return match ? 'pw_session=' + match[1] : '';
}

function post(path, body, cookie) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  return fetch(base + path, { method: 'POST', headers: headers, body: JSON.stringify(body) });
}

function get(path, cookie) {
  const headers = cookie ? { Cookie: cookie } : {};
  return fetch(base + path, { headers: headers });
}

async function registerUser(email, name) {
  const res = await post('/api/auth/register', {
    name: name || 'Ученик', email: email, password: 'password123'
  });
  return { res: res, cookie: extractCookie(res), body: await res.json() };
}

test.before(async function () {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = 'http://127.0.0.1:' + server.address().port;
});

test.after(function () {
  server.close();
});

test('регистрация создаёт аккаунт и пробный период', async function () {
  const { res, cookie, body } = await registerUser('first@test.local', 'Александр');
  assert.strictEqual(res.status, 201);
  assert.ok(cookie, 'кука сессии должна прийти');
  assert.strictEqual(body.user.email, 'first@test.local');
  assert.strictEqual(body.entitlement.source, 'trial');
  assert.strictEqual(body.entitlement.plan.id, 'trial');
  assert.ok(body.entitlement.trial.daysLeft >= 6);
  assert.strictEqual(body.user.role, 'admin', 'первый пользователь — админ');
  assert.strictEqual(body.user.passwordHash, undefined, 'хэш пароля наружу не отдаём');
});

test('me возвращает текущего пользователя', async function () {
  const { cookie } = await registerUser('me@test.local');
  const res = await get('/api/auth/me', cookie);
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.user.email, 'me@test.local');
  assert.ok(typeof body.usage.today === 'number');
});

test('повторный email отклоняется', async function () {
  await registerUser('dup@test.local');
  const { res, body } = await registerUser('dup@test.local');
  assert.strictEqual(res.status, 409);
  assert.strictEqual(body.code, 'EMAIL_TAKEN');
});

test('слабый пароль и плохой email отклоняются', async function () {
  const weak = await post('/api/auth/register', {
    name: 'Тест', email: 'weak@test.local', password: '123'
  });
  assert.strictEqual(weak.status, 400);
  assert.strictEqual((await weak.json()).code, 'INVALID_PASSWORD');

  const badEmail = await post('/api/auth/register', {
    name: 'Тест', email: 'not-an-email', password: 'password123'
  });
  assert.strictEqual(badEmail.status, 400);
  assert.strictEqual((await badEmail.json()).code, 'INVALID_EMAIL');
});

test('неверный пароль — 401 без подсказки', async function () {
  await registerUser('login@test.local');
  const res = await post('/api/auth/login', { email: 'login@test.local', password: 'wrongpass' });
  assert.strictEqual(res.status, 401);
  const body = await res.json();
  assert.strictEqual(body.code, 'BAD_CREDENTIALS');
  assert.ok(!/не существует|не найден/i.test(body.error));
});

test('вход по паролю выдаёт рабочую сессию', async function () {
  await registerUser('signin@test.local');
  const res = await post('/api/auth/login', { email: 'signin@test.local', password: 'password123' });
  assert.strictEqual(res.status, 200);
  const cookie = extractCookie(res);
  assert.ok(cookie);

  const me = await get('/api/auth/me', cookie);
  assert.strictEqual(me.status, 200);
});

test('выход закрывает сессию', async function () {
  const { cookie } = await registerUser('logout@test.local');
  const out = await post('/api/auth/logout', {}, cookie);
  assert.strictEqual(out.status, 200);

  const me = await get('/api/auth/me', cookie);
  assert.strictEqual(me.status, 401);
});

test('данные аккаунтов изолированы', async function () {
  const a = await registerUser('user-a@test.local');
  const b = await registerUser('user-b@test.local');

  const save = await post('/api/progress', {
    progress: { 'm0-linux-install': 'learned' }
  }, a.cookie);
  assert.strictEqual(save.status, 200);

  const aProgress = await (await get('/api/progress', a.cookie)).json();
  const bProgress = await (await get('/api/progress', b.cookie)).json();

  assert.strictEqual(aProgress['m0-linux-install'], 'learned');
  assert.strictEqual(bProgress['m0-linux-install'], undefined);
});

test('прогресс принимает только темы курса и известные статусы', async function () {
  const { cookie } = await registerUser('progress-filter@test.local');
  const res = await post('/api/progress', {
    progress: { 'not-a-topic': 'learned', 'm0-linux-install': 'hacked' }
  }, cookie);
  assert.strictEqual(res.status, 200);

  const progress = await (await get('/api/progress', cookie)).json();
  assert.strictEqual(progress['not-a-topic'], undefined);
  assert.strictEqual(progress['m0-linux-install'], undefined);
});

test('второй пользователь — не админ, служебные ручки закрыты', async function () {
  await registerUser('owner@test.local');
  const regular = await registerUser('regular@test.local');

  assert.strictEqual(regular.body.user.role, 'user');
  const clean = await post('/api/clean-cache', {}, regular.cookie);
  assert.strictEqual(clean.status, 403);

  const report = await get('/api/tokens-report', regular.cookie);
  assert.strictEqual(report.status, 403);
});

test('смена пароля закрывает старые сессии', async function () {
  const { cookie } = await registerUser('change@test.local');
  const res = await post('/api/auth/password', {
    oldPassword: 'password123', newPassword: 'newpassword456'
  }, cookie);
  assert.strictEqual(res.status, 200);

  const fresh = extractCookie(res);
  assert.ok(fresh);

  const oldSession = await get('/api/auth/me', cookie);
  assert.strictEqual(oldSession.status, 401, 'старая кука должна умереть');

  const newSession = await get('/api/auth/me', fresh);
  assert.strictEqual(newSession.status, 200);
});
