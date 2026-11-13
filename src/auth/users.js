// Пользователи: один JSON-файл storage/users.json, кэш в памяти,
// сериализованная запись. Для сотен аккаунтов этого достаточно,
// а база данных тут не нужна.
const path = require('path');
const crypto = require('crypto');
const { CONFIG, DAY_MS } = require('../config');
const { atomicWrite, readJsonStrict } = require('../lib/fsjson');

const USERS_FILE = path.join(CONFIG.storageDir, 'users.json');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;

let byId = null;
let byEmail = null;
let loading = null;
let writeQueue = Promise.resolve();

function withWriteLock(fn) {
  const run = writeQueue.then(fn, fn);
  // Ошибка одного писателя не должна ломать очередь для следующих.
  writeQueue = run.then(function () {}, function () {});
  return run;
}

async function load() {
  if (byId) return;
  if (loading) return loading;
  loading = (async function () {
    const data = await readJsonStrict(USERS_FILE, { version: 1, users: {} });
    const users = (data && data.users) || {};
    byId = new Map(Object.entries(users));
    byEmail = new Map();
    for (const u of byId.values()) {
      if (u && u.email) byEmail.set(u.email, u.id);
    }
  })();
  try {
    await loading;
  } finally {
    loading = null;
  }
}

async function persist() {
  const users = {};
  for (const [id, u] of byId) users[id] = u;
  await atomicWrite(USERS_FILE, JSON.stringify({ version: 1, users }, null, 2), { private: true });
}

function clone(user) {
  return user ? JSON.parse(JSON.stringify(user)) : null;
}

function normalizeEmail(email) {
  return String(email == null ? '' : email).trim().toLowerCase();
}

function validEmail(email) {
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email);
}

function newId() {
  return 'u_' + crypto.randomBytes(8).toString('hex');
}

function isAdminEmail(email) {
  return CONFIG.adminEmails.indexOf(normalizeEmail(email)) !== -1;
}

async function count() {
  await load();
  return byId.size;
}

async function findById(id) {
  if (typeof id !== 'string') return null;
  await load();
  return clone(byId.get(id));
}

async function findByEmail(email) {
  await load();
  const id = byEmail.get(normalizeEmail(email));
  return id ? clone(byId.get(id)) : null;
}

// Создание аккаунта. Первый зарегистрированный становится админом:
// ему доступны служебные разделы (очистка кэша, отчёт по токенам).
async function createUser(input) {
  const email = normalizeEmail(input.email);
  if (!validEmail(email)) {
    const e = new Error('Некорректный email');
    e.code = 'INVALID_EMAIL';
    throw e;
  }
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 60) {
    const e = new Error('Имя должно быть от 1 до 60 символов');
    e.code = 'INVALID_NAME';
    throw e;
  }

  return withWriteLock(async function () {
    await load();
    if (byEmail.has(email)) {
      const e = new Error('Аккаунт с таким email уже существует');
      e.code = 'EMAIL_TAKEN';
      throw e;
    }

    const now = Date.now();
    const user = {
      id: newId(),
      email: email,
      name: input.name.trim(),
      passwordHash: input.passwordHash,
      // Админ — тот, кого явно указали в ADMIN_EMAILS. Первый пользователь
      // получает роль только если список пуст: на публичном инстансе
      // достаточно один раз заполнить ADMIN_EMAILS, чтобы роль не досталась
      // случайному первому регистранту.
      role: (isAdminEmail(email) || (byId.size === 0 && CONFIG.adminEmails.length === 0))
        ? 'admin' : 'user',
      createdAt: now,
      lastLoginAt: null,
      // Пробный период стартует сразу после регистрации.
      trialEndsAt: CONFIG.trialDays > 0 ? now + CONFIG.trialDays * DAY_MS : 0,
      trialUsed: CONFIG.trialDays > 0,
      subscription: {
        plan: 'free',
        status: 'none',
        periodStart: null,
        periodEnd: null,
        cancelAtPeriodEnd: false,
        updatedAt: now
      }
    };

    byId.set(user.id, user);
    byEmail.set(email, user.id);
    await persist();
    return clone(user);
  });
}

// patch — плоское слияние верхнего уровня. Вложенную подписку
// вызывающий собирает целиком, чтобы не потерять поля.
async function updateUser(id, patch) {
  return withWriteLock(async function () {
    await load();
    const user = byId.get(id);
    if (!user) return null;

    const next = Object.assign({}, user, patch, { id: user.id });
    if (patch && patch.email !== undefined) {
      next.email = normalizeEmail(patch.email);
      if (!validEmail(next.email)) {
        const e = new Error('Некорректный email');
        e.code = 'INVALID_EMAIL';
        throw e;
      }
    }

    // Проверяем занятость ДО изменения памяти: иначе при отказе
    // byId уже содержал бы новый email, а byEmail — старый.
    const oldEmail = user.email;
    const emailChanged = next.email !== oldEmail;
    if (emailChanged && byEmail.has(next.email)) {
      const e = new Error('Аккаунт с таким email уже существует');
      e.code = 'EMAIL_TAKEN';
      throw e;
    }

    byId.set(id, next);
    if (emailChanged) {
      byEmail.delete(oldEmail);
      byEmail.set(next.email, id);
    }

    await persist();
    return clone(next);
  });
}

async function touchLogin(id) {
  return updateUser(id, { lastLoginAt: Date.now() });
}

// Публичное представление: без хэша пароля и служебных полей.
function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt,
    trialEndsAt: user.trialEndsAt || 0,
    subscription: user.subscription || { plan: 'free', status: 'none' }
  };
}

// Только для тестов: сбросить кэш в памяти после смены STORAGE_DIR.
function resetCache() {
  byId = null;
  byEmail = null;
  loading = null;
}

module.exports = {
  USERS_FILE,
  normalizeEmail,
  validEmail,
  count,
  findById,
  findByEmail,
  createUser,
  updateUser,
  touchLogin,
  publicUser,
  resetCache
};
