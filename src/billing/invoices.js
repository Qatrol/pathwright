// Счета: storage/billing/invoices/<uid>.json. Один файл на пользователя,
// запись — под очередью на uid: параллельные чекауты не теряют счета.
const path = require('path');
const crypto = require('crypto');
const { DIRS } = require('../config');
const { assertUid } = require('../storage/userpaths');
const { atomicWrite, readJsonStrict } = require('../lib/fsjson');
const { planById, priceFor, PURCHASABLE } = require('./plans');

const MAX_INVOICES = 100;
const queues = new Map();

function invoicesFile(uid) {
  return path.join(DIRS.invoices, assertUid(uid) + '.json');
}

// Один писатель на пользователя: read-modify-write не пересекается сам с собой.
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

async function readAll(uid) {
  const data = await readJsonStrict(invoicesFile(uid), null);
  return (data && Array.isArray(data.invoices)) ? data.invoices : [];
}

async function writeAll(uid, invoices) {
  const trimmed = invoices.slice(-MAX_INVOICES);
  await atomicWrite(invoicesFile(uid), JSON.stringify({ invoices: trimmed }, null, 2), { private: true });
  return trimmed;
}

async function listInvoices(uid) {
  const invoices = await readAll(uid);
  return invoices.slice().sort(function (a, b) { return b.createdAt - a.createdAt; });
}

async function getInvoice(uid, id) {
  const invoices = await readAll(uid);
  return invoices.find(function (inv) { return inv.id === id; }) || null;
}

function newId() {
  return 'inv_' + crypto.randomBytes(8).toString('hex');
}

async function createInvoice(uid, planId, months, kind) {
  // months приходит из JSON: '3' строкой иначе склеится в setUTCMonth.
  months = Number(months);
  if (!Number.isInteger(months) || months < 1 || months > 36) {
    const e = new Error('Неверный период оплаты');
    e.code = 'INVALID_PERIOD';
    throw e;
  }
  if (PURCHASABLE.indexOf(planId) === -1) {
    const e = new Error('Этот тариф нельзя купить');
    e.code = 'PLAN_NOT_PURCHASABLE';
    throw e;
  }
  const price = priceFor(planId, months);
  if (!price) {
    const e = new Error('Неверный период оплаты');
    e.code = 'INVALID_PERIOD';
    throw e;
  }
  const plan = planById(planId);
  const now = Date.now();
  const invoice = {
    id: newId(),
    userId: uid,
    planId: plan.id,
    planName: plan.name,
    kind: kind === 'renew' || kind === 'upgrade' ? kind : 'new',
    months: months,
    amount: price.amount,
    baseAmount: price.base,
    discount: price.discount,
    currency: price.currency,
    status: 'pending',
    provider: null,
    createdAt: now,
    // У ЮKassa платёж по СБП живёт 1 час (docs: payment term — 1 hour).
    // Держим тот же срок, чтобы не показывать «оплатите» по мёртвой ссылке.
    expiresAt: now + 60 * 60 * 1000,
    paidAt: null,
    periodStart: null,
    periodEnd: null
  };

  return withUserLock(uid, async function () {
    const invoices = await readAll(uid);
    invoices.push(invoice);
    await writeAll(uid, invoices);
    return invoice;
  });
}

async function updateInvoice(uid, id, patch) {
  return withUserLock(uid, async function () {
    const invoices = await readAll(uid);
    const idx = invoices.findIndex(function (inv) { return inv.id === id; });
    if (idx === -1) return null;
    const next = Object.assign({}, invoices[idx], patch, { id: invoices[idx].id });
    invoices[idx] = next;
    await writeAll(uid, invoices);
    return next;
  });
}

// У пользователя должен быть один счёт на оплату: перед новым чекаутом
// старые неоплаченные закрываются, чтобы в интерфейсе не висела пара
// ссылок на разные суммы.
async function cancelPending(uid) {
  return withUserLock(uid, async function () {
    const invoices = await readAll(uid);
    let cancelled = 0;
    const next = invoices.map(function (inv) {
      if (inv.status !== 'pending') return inv;
      cancelled++;
      return Object.assign({}, inv, { status: 'cancelled' });
    });
    if (cancelled) await writeAll(uid, next);
    return cancelled;
  });
}

// Атомарный переход pending → paid. Два одновременных запроса на один счёт
// не могут оба увидеть pending: второй получит alreadyPaid=true.
async function markPaidIfPending(uid, id, patch) {
  return withUserLock(uid, async function () {
    const invoices = await readAll(uid);
    const idx = invoices.findIndex(function (inv) { return inv.id === id; });
    if (idx === -1) return { ok: false, reason: 'not_found', invoice: null };

    const current = invoices[idx];
    if (current.status !== 'pending') {
      return { ok: false, reason: current.status, invoice: current };
    }
    if (current.expiresAt && current.expiresAt < Date.now()) {
      invoices[idx] = Object.assign({}, current, { status: 'expired' });
      await writeAll(uid, invoices);
      return { ok: false, reason: 'expired', invoice: invoices[idx] };
    }

    const next = Object.assign({}, current, patch, { status: 'paid', id: current.id });
    invoices[idx] = next;
    await writeAll(uid, invoices);
    return { ok: true, reason: null, invoice: next };
  });
}

module.exports = {
  invoicesFile,
  listInvoices,
  getInvoice,
  createInvoice,
  updateInvoice,
  cancelPending,
  markPaidIfPending
};
