// Простая арифметическая капча: без внешних сервисов и картинок.
// Одноразовая, живёт 5 минут. Для формы регистрации и для входа после
// серии неудачных попыток.
const crypto = require('crypto');

const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 2000;
const store = new Map();

function randomInt(min, max) {
  return min + crypto.randomInt(max - min + 1);
}

function cleanup(now) {
  for (const [id, entry] of store) {
    if (entry.expiresAt <= now) store.delete(id);
  }
  // Жёсткий потолок на случай флуда запросами капчи.
  while (store.size > MAX_ENTRIES) {
    store.delete(store.keys().next().value);
  }
}

function create() {
  const now = Date.now();
  if (store.size > MAX_ENTRIES / 2) cleanup(now);

  const a = randomInt(2, 9);
  const b = randomInt(2, 9);
  const plus = crypto.randomInt(2) === 0;
  const question = plus
    ? 'Сколько будет ' + a + ' + ' + b + '?'
    : (a >= b ? 'Сколько будет ' + a + ' − ' + b + '?' : 'Сколько будет ' + b + ' − ' + a + '?');
  const answer = plus ? a + b : Math.abs(a - b);

  const id = crypto.randomBytes(16).toString('base64url');
  store.set(id, { answer: answer, expiresAt: now + TTL_MS });
  return { id: id, question: question, expiresIn: Math.round(TTL_MS / 1000) };
}

// Одноразовая проверка: успешная или неуспешная попытка сжигает капчу,
// чтобы нельзя было подбирать ответ бесконечно.
function verify(id, answer) {
  if (typeof id !== 'string' || typeof answer !== 'string') return false;
  const entry = store.get(id);
  if (!entry) return false;
  store.delete(id);
  if (entry.expiresAt <= Date.now()) return false;

  const normalized = answer.trim().replace(/\s+/g, '');
  if (!/^-?\d{1,3}$/.test(normalized)) return false;
  return Number(normalized) === entry.answer;
}

function reset() {
  store.clear();
}

module.exports = { create, verify, reset, TTL_MS };
