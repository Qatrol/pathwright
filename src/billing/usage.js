// Расход генераций по пользователю: storage/billing/usage/<uid>.json
// Считаем по дням, месячная сумма выводится из дней. Записи старше
// 200 дней удаляются при каждом сохранении.
const path = require('path');
const { DIRS, CONFIG } = require('../config');
const { assertUid } = require('../storage/userpaths');
const { atomicWrite, readJsonStrict } = require('../lib/fsjson');

const KEEP_DAYS = 200;
const queues = new Map();

function usageFile(uid) {
  return path.join(DIRS.usage, assertUid(uid) + '.json');
}

// Ключ дня — в часовом поясе сервиса, а не UTC: иначе лимит сбрасывался бы
// в 03:00 по Москве. en-CA даёт формат YYYY-MM-DD.
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: CONFIG.timezone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

function dayKey(date) {
  try {
    return dayFormatter.format(date || new Date());
  } catch (e) {
    // Старые сборки Node без полного ICU: падать из-за лимита нельзя.
    return (date || new Date()).toISOString().slice(0, 10);
  }
}

function monthKey(date) {
  return dayKey(date).slice(0, 7);
}

// Один писатель на пользователя: параллельные запросы не теряют инкременты.
function withUserLock(uid, fn) {
  const prev = queues.get(uid) || Promise.resolve();
  const run = prev.then(fn, fn);
  const settled = run.then(function () {}, function () {});
  queues.set(uid, settled);
  settled.then(function () {
    if (queues.get(uid) === settled) queues.delete(uid);
  });
  return run;
}

async function readUsage(uid) {
  const data = await readJsonStrict(usageFile(uid), null);
  return { days: (data && data.days) || {} };
}

function summarize(usage, now) {
  now = now || new Date();
  const today = usage.days[dayKey(now)] || 0;
  const month = monthKey(now);
  let monthTotal = 0;
  for (const key of Object.keys(usage.days)) {
    if (key.startsWith(month)) monthTotal += usage.days[key] || 0;
  }
  return { today: today, month: monthTotal, days: usage.days };
}

async function getUsage(uid) {
  const usage = await readUsage(uid);
  return summarize(usage);
}

function prune(days, now) {
  const cutoff = new Date(now.getTime() - KEEP_DAYS * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  for (const key of Object.keys(days)) {
    if (key < cutoff) delete days[key];
  }
}

async function change(uid, delta) {
  return withUserLock(uid, async function () {
    const usage = await readUsage(uid);
    const key = dayKey();
    const next = Math.max(0, (usage.days[key] || 0) + delta);
    if (next === 0) delete usage.days[key];
    else usage.days[key] = next;
    prune(usage.days, new Date());
    await atomicWrite(usageFile(uid), JSON.stringify({ days: usage.days }, null, 2), { private: true });
    return summarize(usage);
  });
}

function consume(uid) {
  return change(uid, 1);
}

function refund(uid) {
  return change(uid, -1);
}

// Атомарная проверка и списание. Без общей блокировки два параллельных
// запроса читают один счётчик, оба проходят проверку и оба списывают —
// лимит обходится бурстом. Поэтому чтение, проверка и запись идут
// под одним замком пользователя.
async function reserve(uid, entitlement, now) {
  now = now || new Date();
  return withUserLock(uid, async function () {
    const usage = await readUsage(uid);
    const summary = summarize(usage, now);
    const check = checkLimit(entitlement, summary, now);

    if (!check.allowed) {
      return { allowed: false, check: check, usage: summary };
    }

    const key = dayKey(now);
    usage.days[key] = (usage.days[key] || 0) + 1;
    prune(usage.days, now);
    await atomicWrite(usageFile(uid), JSON.stringify({ days: usage.days }, null, 2), { private: true });
    return { allowed: true, check: check, usage: summarize(usage, now) };
  });
}

// Проверка перед платным вызовом модели.
function checkLimit(entitlement, usage, now) {
  now = now || new Date();
  const dayLimit = entitlement.plan.dailyGenerations;
  const monthLimit = entitlement.plan.monthlyGenerations;
  // Ориентир для интерфейса («до завтра»), точная полночь в чужом поясе
  // не нужна: клиент показывает только дату сброса.
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const nextMonth = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  if (usage.today >= dayLimit) {
    return {
      allowed: false,
      scope: 'day',
      limit: dayLimit,
      used: usage.today,
      resetAt: tomorrow.getTime(),
      message: 'Дневной лимит генераций исчерпан (' + usage.today + '/' + dayLimit + '). ' +
        (entitlement.plan.id === 'free'
          ? 'Подключите подписку или подождите до завтра.'
          : 'Лимит обновится завтра.')
    };
  }
  if (usage.month >= monthLimit) {
    return {
      allowed: false,
      scope: 'month',
      limit: monthLimit,
      used: usage.month,
      resetAt: nextMonth.getTime(),
      message: 'Месячный лимит генераций исчерпан (' + usage.month + '/' + monthLimit + ').'
    };
  }
  return {
    allowed: true,
    scope: null,
    limit: dayLimit,
    used: usage.today,
    remaining: Math.min(dayLimit - usage.today, monthLimit - usage.month),
    resetAt: tomorrow.getTime()
  };
}

module.exports = {
  usageFile, dayKey, getUsage, consume, refund, reserve, checkLimit, summarize
};
