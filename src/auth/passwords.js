// Пароли: scrypt из стандартной библиотеки Node, без внешних зависимостей.
// Формат хранения: scrypt$N$r$p$saltBase64$hashBase64.
const crypto = require('crypto');

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAX_PASSWORD = 200;
const MIN_PASSWORD = 8;

function scrypt(password, salt, keylen, options) {
  return new Promise(function (resolve, reject) {
    crypto.scrypt(password, salt, keylen, options, function (err, key) {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

// Нормализация нужна, чтобы одинаковые по смыслу пароли (é как один символ
// и как e + комбинирующая акутка) давали один и тот же ключ.
function normalize(password) {
  return String(password).normalize('NFKC');
}

function validate(password) {
  if (typeof password !== 'string') return 'Пароль обязателен';
  if (password.length < MIN_PASSWORD) return 'Пароль короче ' + MIN_PASSWORD + ' символов';
  if (password.length > MAX_PASSWORD) return 'Пароль длиннее ' + MAX_PASSWORD + ' символов';
  return null;
}

async function hashPassword(password) {
  const problem = validate(password);
  if (problem) throw new Error(problem);
  const salt = crypto.randomBytes(16);
  const key = await scrypt(normalize(password), salt, KEYLEN, { N, r: R, p: P, maxmem: 256 * 1024 * 1024 });
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  if (password.length > MAX_PASSWORD) return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = parseInt(parts[1], 10);
  const r = parseInt(parts[2], 10);
  const p = parseInt(parts[3], 10);
  // Параметры берутся из файла: без верхней границы правка users.json
  // могла бы подсунуть scrypt на гигабайт памяти и уронить вход.
  if (!Number.isInteger(n) || n < 1024 || n > 1 << 20) return false;
  if (!Number.isInteger(r) || r < 1 || r > 32) return false;
  if (!Number.isInteger(p) || p < 1 || p > 16) return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch (e) {
    return false;
  }
  if (!salt.length || !expected.length) return false;

  const actual = await scrypt(normalize(password), salt, expected.length, {
    N: n, r: r, p: p, maxmem: 256 * 1024 * 1024
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

module.exports = { hashPassword, verifyPassword, validate, MIN_PASSWORD, MAX_PASSWORD };
