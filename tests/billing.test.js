// Тарифы, лимиты и оплата (заглушка).
const test = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pathwright-bill-'));
process.env.DEEPSEEK_API_KEY = 'test-key';
process.env.PORT = '0';
process.env.REGISTRATION_LIMIT = '100';
process.env.PAYMENT_STUB = 'true';

const app = require('../src/app');
const { PLANS, priceFor, catalogue } = require('../src/billing/plans');
const { checkLimit, reserve, getUsage, usageFile } = require('../src/billing/usage');
const { createInvoice, listInvoices } = require('../src/billing/invoices');
const { entitlementFor } = require('../src/billing/entitlements');

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
  return fetch(base + path, { headers: cookie ? { Cookie: cookie } : {} });
}

test.before(async function () {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = 'http://127.0.0.1:' + server.address().port;
});

test.after(function () {
  server.close();
});

test('каталог тарифов отдаётся публично', async function () {
  const res = await get('/api/billing/plans');
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.ok(body.plans.length >= 3);
  assert.ok(body.periods.length >= 2);
  assert.strictEqual(body.trialDays, 7);
  const basic = body.plans.find(function (p) { return p.id === 'basic'; });
  assert.strictEqual(basic.purchasable, true);
});

test('цена считается со скидкой за период', function () {
  const one = priceFor('basic', 1);
  const year = priceFor('basic', 12);
  assert.strictEqual(one.amount, PLANS.basic.priceMonthly);
  assert.ok(year.amount < one.amount * 12, 'годовая подписка дешевле');
  assert.strictEqual(year.discount, 0.2);
  assert.strictEqual(priceFor('free', 1), null, 'бесплатный тариф не продаётся');
  assert.strictEqual(priceFor('basic', 7), null, 'неизвестный период отклоняется');
});

test('пробный период переходит в free по истечении', function () {
  const now = Date.now();
  const user = {
    trialEndsAt: now + 3 * 24 * 60 * 60 * 1000,
    subscription: { plan: 'free', status: 'none' }
  };
  assert.strictEqual(entitlementFor(user, now).source, 'trial');
  assert.strictEqual(entitlementFor(user, now + 4 * 24 * 60 * 60 * 1000).plan.id, 'free');

  const expired = entitlementFor(user, now + 4 * 24 * 60 * 60 * 1000);
  assert.strictEqual(expired.source, 'free');
  assert.strictEqual(expired.trial.active, false);
});

test('лимит дня и месяца срабатывает', function () {
  const entitlement = { plan: PLANS.free };
  const ok = checkLimit(entitlement, { today: 4, month: 10 });
  assert.strictEqual(ok.allowed, true);
  assert.strictEqual(ok.remaining, 1);

  const dayLimit = checkLimit(entitlement, { today: 5, month: 10 });
  assert.strictEqual(dayLimit.allowed, false);
  assert.strictEqual(dayLimit.scope, 'day');

  const monthLimit = checkLimit(entitlement, { today: 0, month: 100 });
  assert.strictEqual(monthLimit.allowed, false);
  assert.strictEqual(monthLimit.scope, 'month');
});

test('полный цикл: счёт → оплата → активная подписка → отмена', async function () {
  const reg = await post('/api/auth/register', {
    name: 'Покупатель', email: 'buyer@test.local', password: 'password123'
  });
  const cookie = extractCookie(reg);
  assert.ok(cookie);

  const checkout = await post('/api/billing/checkout', { planId: 'basic', months: 3 }, cookie);
  const checkoutBody = await checkout.json();
  assert.strictEqual(checkout.status, 201, JSON.stringify(checkoutBody));
  assert.strictEqual(checkoutBody.invoice.amount, priceFor('basic', 3).amount);
  assert.strictEqual(checkoutBody.invoice.status, 'pending');
  assert.strictEqual(checkoutBody.stub, true);

  const pay = await post('/api/billing/invoices/' + checkoutBody.invoice.id + '/pay', {}, cookie);
  const payBody = await pay.json();
  assert.strictEqual(pay.status, 200, JSON.stringify(payBody));
  assert.strictEqual(payBody.status.entitlement.plan.id, 'basic');
  assert.strictEqual(payBody.status.entitlement.source, 'subscription');

  const status = await (await get('/api/billing/status', cookie)).json();
  assert.strictEqual(status.entitlement.plan.id, 'basic');
  assert.ok(status.entitlement.subscription.periodEnd > Date.now());

  const invoices = await (await get('/api/billing/invoices', cookie)).json();
  assert.strictEqual(invoices.invoices.length, 1);
  assert.strictEqual(invoices.invoices[0].status, 'paid');

  const cancel = await post('/api/billing/cancel', {}, cookie);
  const cancelBody = await cancel.json();
  assert.strictEqual(cancel.status, 200);
  assert.strictEqual(cancelBody.entitlement.subscription.cancelAtPeriodEnd, true);

  // Доступ не пропадает сразу после отмены.
  const still = await (await get('/api/billing/status', cookie)).json();
  assert.strictEqual(still.entitlement.plan.id, 'basic');
});

test('чужой счёт оплатить нельзя', async function () {
  const a = extractCookie(await post('/api/auth/register', {
    name: 'A', email: 'bill-a@test.local', password: 'password123'
  }));
  const b = extractCookie(await post('/api/auth/register', {
    name: 'B', email: 'bill-b@test.local', password: 'password123'
  }));

  const checkout = await post('/api/billing/checkout', { planId: 'pro', months: 1 }, a);
  const invoice = (await checkout.json()).invoice;

  const stolen = await post('/api/billing/invoices/' + invoice.id + '/pay', {}, b);
  assert.strictEqual(stolen.status, 404);
});

test('неизвестный тариф отклоняется', async function () {
  const cookie = extractCookie(await post('/api/auth/register', {
    name: 'C', email: 'bill-c@test.local', password: 'password123'
  }));
  const res = await post('/api/billing/checkout', { planId: 'free', months: 1 }, cookie);
  assert.strictEqual(res.status, 400);
  assert.strictEqual((await res.json()).code, 'INVALID_PLAN');
});

test('параллельные запросы не обходят дневной лимит', async function () {
  const uid = 'u_paralleltest';
  const day = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(usageFile(uid), JSON.stringify({ days: { [day]: 4 } }));

  // 10 одновременных резервирований при остатке в одну генерацию.
  const results = await Promise.all(
    Array.from({ length: 10 }, function () { return reserve(uid, { plan: PLANS.free }); })
  );
  const allowed = results.filter(function (r) { return r.allowed; }).length;

  assert.strictEqual(allowed, 1, 'разрешена должна быть ровно одна генерация');
  const usage = await getUsage(uid);
  assert.strictEqual(usage.today, 5);
});

test('параллельные чекауты не теряют счета', async function () {
  const uid = 'u_invoicetest';
  const created = await Promise.all(
    Array.from({ length: 10 }, function () { return createInvoice(uid, 'basic', 1); })
  );
  const stored = await listInvoices(uid);

  assert.strictEqual(stored.length, 10);
  assert.strictEqual(new Set(created.map(function (i) { return i.id; })).size, 10);
});

test('один счёт нельзя оплатить дважды', async function () {
  const reg = await post('/api/auth/register', {
    name: 'Дважды', email: 'double@test.local', password: 'password123'
  });
  const cookie = extractCookie(reg);
  const checkout = await post('/api/billing/checkout', { planId: 'basic', months: 1 }, cookie);
  const invoice = (await checkout.json()).invoice;

  const first = await post('/api/billing/invoices/' + invoice.id + '/pay', {}, cookie);
  const second = await post('/api/billing/invoices/' + invoice.id + '/pay', {}, cookie);

  assert.strictEqual(first.status, 200);
  assert.strictEqual(second.status, 409);
  assert.strictEqual((await second.json()).code, 'ALREADY_PAID');
});

test('catalogue не отдаёт служебные поля', function () {
  const c = catalogue();
  const json = JSON.stringify(c);
  assert.ok(json.indexOf('passwordHash') === -1);
  assert.ok(c.plans.every(function (p) { return typeof p.dailyGenerations === 'number'; }));
});
