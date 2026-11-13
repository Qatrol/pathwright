// Подписки и счета. Провайдер выбирается в billing/provider.js:
// ЮKassa + СБП, если заданы ключи, иначе тестовая заглушка.
const express = require('express');
const { CONFIG } = require('../config');
const { wrapRouter } = require('../lib/wrap');
const router = wrapRouter(express.Router());
const { requireAuth } = require('../auth/middleware');
const { catalogue, priceFor } = require('../billing/plans');
const { entitlementFor } = require('../billing/entitlements');
const { getUsage } = require('../billing/usage');
const {
  listInvoices, getInvoice, createInvoice, updateInvoice, markPaidIfPending
} = require('../billing/invoices');
const { findById, updateUser } = require('../auth/users');
const provider = require('../billing/provider');
const yookassa = require('../billing/yookassa');

function addMonths(ts, months) {
  months = Number(months);
  const d = new Date(ts);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  // 31 января + 1 месяц = 28/29 февраля, а не 3 марта.
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.getTime();
}

// Каталог тарифов — публичный: страницу с ценами видно до регистрации.
router.get('/api/billing/plans', function (req, res) {
  res.json(catalogue());
});

router.get('/api/billing/status', requireAuth, async function (req, res) {
  const entitlement = entitlementFor(req.user);
  const usage = await getUsage(req.user.id);
  res.json({
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
    paymentStub: provider.stubEnabled(),
    paymentMode: provider.mode()
  });
});

// Чекаут: не больше 10 счетов в час на аккаунт. Каждый счёт — перезапись
// файла, и у реального провайдера это ещё и внешний вызов.
const CHECKOUT_LIMIT = 10;
const CHECKOUT_WINDOW_MS = 60 * 60 * 1000;
const checkoutBuckets = new Map();

function allowCheckout(uid) {
  const now = Date.now();
  let bucket = checkoutBuckets.get(uid);
  if (!bucket || bucket.reset <= now) {
    bucket = { count: 0, reset: now + CHECKOUT_WINDOW_MS };
    checkoutBuckets.set(uid, bucket);
  }
  bucket.count++;

  if (checkoutBuckets.size > 2000) {
    for (const [key, b] of checkoutBuckets) {
      if (b.reset <= now) checkoutBuckets.delete(key);
    }
    while (checkoutBuckets.size > 2000) {
      checkoutBuckets.delete(checkoutBuckets.keys().next().value);
    }
  }
  return bucket.count <= CHECKOUT_LIMIT;
}

function returnUrlFor(req) {
  if (/^https:\/\//.test(CONFIG.publicBaseUrl)) return CONFIG.publicBaseUrl + '/?paid=1';
  return req.protocol + '://' + req.get('host') + '/?paid=1';
}

router.post('/api/billing/checkout', requireAuth, async function (req, res) {
  if (!allowCheckout(req.user.id)) {
    return res.status(429).json({
      error: 'Слишком много счетов за час. Повторите позже.',
      code: 'TOO_MANY_ATTEMPTS'
    });
  }

  const body = req.body || {};
  const planId = typeof body.planId === 'string' ? body.planId : '';
  const months = Number(body.months);

  const price = priceFor(planId, months);
  if (!price) {
    return res.status(400).json({ error: 'Неизвестный тариф или период', code: 'INVALID_PLAN' });
  }

  const invoice = await createInvoice(req.user.id, planId, months);
  let payment;
  try {
    payment = await provider.createPayment(invoice, { returnUrl: returnUrlFor(req) });
  } catch (e) {
    // Без провайдера счёт не должен висеть «ожидает оплаты» вечно.
    await updateInvoice(req.user.id, invoice.id, { status: 'cancelled' }).catch(function () {});
    if (e.code === 'PROVIDER_UNAVAILABLE' || e.code === 'PROVIDER_ERROR') {
      return res.status(503).json({ error: 'Оплата временно недоступна', code: 'PROVIDER_UNAVAILABLE' });
    }
    throw e;
  }

  await updateInvoice(req.user.id, invoice.id, {
    provider: payment.provider,
    providerPaymentId: payment.paymentId || null
  });

  res.status(201).json({
    invoice: Object.assign({}, invoice, {
      provider: payment.provider,
      providerPaymentId: payment.paymentId || null
    }),
    payment: payment,
    stub: provider.stubEnabled(),
    paymentMode: provider.mode()
  });
});

// Период считается от конца текущей подписки, если она ещё действует:
// оплата вперёд не сгорает.
function subscriptionPeriod(user, months, from) {
  const current = user.subscription || {};
  const stillActive = current.status === 'active' &&
    typeof current.periodEnd === 'number' && current.periodEnd > from;
  const periodStart = stillActive ? current.periodEnd : from;
  return { periodStart: periodStart, periodEnd: addMonths(periodStart, months) };
}

// Активация подписки сериализуется на пользователя: две оплаты разных счетов
// подряд не должны прочитать одну и ту же подписку и потерять один период.
const activationQueues = new Map();

function withActivationLock(uid, fn) {
  const prev = activationQueues.get(uid) || Promise.resolve();
  const run = prev.then(fn, fn);
  const settled = run.then(function () {}, function () {});
  activationQueues.set(uid, settled);
  settled.then(function () {
    if (activationQueues.get(uid) === settled) activationQueues.delete(uid);
  });
  return run;
}

function payError(reason) {
  if (reason === 'not_found') return { status: 404, body: { error: 'Счёт не найден', code: 'NOT_FOUND' } };
  if (reason === 'expired') return { status: 410, body: { error: 'Срок действия счёта истёк', code: 'EXPIRED' } };
  if (reason === 'paid') return { status: 409, body: { error: 'Счёт уже оплачен', code: 'ALREADY_PAID' } };
  return { status: 409, body: { error: 'Счёт нельзя оплатить', code: 'BAD_STATE' } };
}

async function activateInvoice(uid, invoiceId, paidAt) {
  return withActivationLock(uid, async function () {
    const user = await findById(uid);
    if (!user) {
      return { status: 401, body: { error: 'Аккаунт не найден', code: 'UNAUTHORIZED' } };
    }
    const invoice = await getInvoice(uid, invoiceId);
    if (!invoice) return payError('not_found');

    const period = subscriptionPeriod(user, invoice.months, paidAt);
    const marked = await markPaidIfPending(uid, invoiceId, {
      paidAt: paidAt,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd
    });
    if (!marked.ok) return payError(marked.reason);

    let updated;
    try {
      updated = await updateUser(uid, {
        trialEndsAt: 0,
        trialUsed: true,
        subscription: {
          plan: invoice.planId,
          status: 'active',
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          cancelAtPeriodEnd: false,
          updatedAt: Date.now()
        }
      });
    } catch (e) {
      // Не оставляем счёт оплаченным без подписки.
      await updateInvoice(uid, invoiceId, {
        status: 'pending', paidAt: null, periodStart: null, periodEnd: null
      }).catch(function (revertError) {
        console.error('[billing] не удалось откатить счёт ' + invoiceId + ': ' + revertError.message);
      });
      throw e;
    }

    return {
      status: 200,
      body: {
        ok: true,
        invoice: marked.invoice,
        status: {
          entitlement: entitlementFor(updated),
          user: { id: updated.id, email: updated.email, name: updated.name }
        }
      }
    };
  });
}

// Ручное подтверждение — только для заглушки. С реальным провайдером
// оплата подтверждается вебхуком, а клиент уходит на страницу банка.
router.post('/api/billing/invoices/:id/pay', requireAuth, async function (req, res) {
  if (!provider.stubEnabled()) {
    return res.status(409).json({
      error: 'Оплата проходит через платёжный провайдер',
      code: 'PROVIDER_REDIRECT_REQUIRED'
    });
  }

  const id = String(req.params.id || '');
  const invoice = await getInvoice(req.user.id, id);

  if (!invoice) {
    return res.status(404).json({ error: 'Счёт не найден', code: 'NOT_FOUND' });
  }
  if (invoice.status === 'paid') {
    return res.status(409).json({ error: 'Счёт уже оплачен', code: 'ALREADY_PAID' });
  }
  if (invoice.status !== 'pending') {
    return res.status(409).json({ error: 'Счёт нельзя оплатить', code: 'BAD_STATE' });
  }
  if (invoice.expiresAt && invoice.expiresAt < Date.now()) {
    await updateInvoice(req.user.id, id, { status: 'expired' });
    return res.status(410).json({ error: 'Срок действия счёта истёк', code: 'EXPIRED' });
  }

  const confirmation = await provider.confirmPayment(invoice);
  const outcome = await activateInvoice(req.user.id, id, confirmation.paidAt || Date.now());
  res.status(outcome.status).json(outcome.body);
});

// Вебхук публичный, а каждый запрос — исходящий вызов API ЮKassa.
// Без лимита это усилитель запросов: аноним заливает ручку, сервер
// молотит провайдера. Ограничиваем частоту и параллельность.
const WEBHOOK_LIMIT = 120;
const WEBHOOK_WINDOW_MS = 60000;
const WEBHOOK_MAX_INFLIGHT = 8;
const webhookBuckets = new Map();
let webhookInFlight = 0;

function allowWebhook(req) {
  const key = req.ip || req.socket.remoteAddress || 'local';
  const now = Date.now();
  let bucket = webhookBuckets.get(key);
  if (!bucket || bucket.reset <= now) {
    bucket = { count: 0, reset: now + WEBHOOK_WINDOW_MS };
    webhookBuckets.set(key, bucket);
  }
  bucket.count++;

  if (webhookBuckets.size > 2000) {
    for (const [k, b] of webhookBuckets) {
      if (b.reset <= now) webhookBuckets.delete(k);
    }
    while (webhookBuckets.size > 2000) {
      webhookBuckets.delete(webhookBuckets.keys().next().value);
    }
  }
  return bucket.count <= WEBHOOK_LIMIT;
}

// Вебхук ЮKassa. Телу уведомления не доверяем: статус платежа
// перепроверяется запросом к API провайдера. Поэтому подделать
// уведомление и получить подписку бесплатно нельзя.
router.post('/api/billing/webhook/yookassa', async function (req, res) {
  if (provider.mode() !== 'yookassa') {
    return res.status(404).json({ error: 'Провайдер не подключён' });
  }
  if (!allowWebhook(req)) {
    return res.status(429).json({ error: 'Слишком много уведомлений' });
  }
  if (webhookInFlight >= WEBHOOK_MAX_INFLIGHT) {
    // 503 — провайдер повторит позже, когда отпустит очередь.
    return res.status(503).json({ error: 'Сервер занят, повторите позже' });
  }

  const body = req.body || {};
  const objectId = body.object && body.object.id;
  if (typeof objectId !== 'string' || !objectId) {
    return res.status(400).json({ error: 'Нет id платежа' });
  }

  webhookInFlight++;
  let payment;
  try {
    payment = await yookassa.fetchPayment(objectId);
  } catch (e) {
    console.error('[webhook] не удалось проверить платёж ' + objectId + ': ' + e.message);
    // 502 — провайдер повторит уведомление позже.
    return res.status(502).json({ error: 'Не удалось проверить платёж' });
  } finally {
    webhookInFlight--;
  }

  if (!payment || payment.status !== 'succeeded') {
    return res.status(200).json({ ok: true, ignored: payment ? payment.status : 'unknown' });
  }

  const meta = payment.metadata || {};
  const uid = meta.userId;
  const invoiceId = meta.invoiceId;
  if (typeof uid !== 'string' || typeof invoiceId !== 'string') {
    console.warn('[webhook] платёж без метаданных счёта: ' + objectId);
    return res.status(200).json({ ok: true, ignored: 'no metadata' });
  }

  const invoice = await getInvoice(uid, invoiceId);
  if (!invoice) {
    console.warn('[webhook] счёт не найден: ' + invoiceId);
    return res.status(200).json({ ok: true, ignored: 'no invoice' });
  }

  // Сумма и валюта сверяются с тем, что мы сами выставили: уведомление
  // может относиться к другому платежу или быть подделано.
  const expectedValue = (Math.round(invoice.amount * 100) / 100).toFixed(2);
  const amount = payment.amount || {};
  if (amount.currency !== 'RUB' || amount.value !== expectedValue) {
    console.warn('[webhook] сумма не совпала для счёта ' + invoiceId);
    return res.status(200).json({ ok: true, ignored: 'amount mismatch' });
  }
  if (invoice.providerPaymentId && invoice.providerPaymentId !== payment.id) {
    console.warn('[webhook] чужой платёж для счёта ' + invoiceId);
    return res.status(200).json({ ok: true, ignored: 'payment mismatch' });
  }

  const paidAt = Date.parse(payment.captured_at) || Date.now();
  let outcome;
  try {
    outcome = await activateInvoice(uid, invoiceId, paidAt);
  } catch (e) {
    console.error('[webhook] активация не удалась: ' + e.message);
    return res.status(500).json({ error: 'Не удалось активировать подписку' });
  }

  if (outcome.status !== 200) {
    // Уже оплачен или счёт истёк — повторять уведомление смысла нет.
    // Персональные данные в лог не пишем.
    console.warn('[webhook] счёт ' + invoiceId + ' не активирован: ' + outcome.status);
  }
  res.status(200).json({ ok: true });
});

router.get('/api/billing/invoices', requireAuth, async function (req, res) {
  res.json({ invoices: await listInvoices(req.user.id) });
});

// Отмена: доступ живёт до конца оплаченного периода, автопродления нет.
router.post('/api/billing/cancel', requireAuth, async function (req, res) {
  const resume = !!(req.body && req.body.resume === true);
  const sub = req.user.subscription || {};

  if (sub.status !== 'active') {
    return res.status(409).json({ error: 'Активной подписки нет', code: 'NO_SUBSCRIPTION' });
  }

  const updated = await updateUser(req.user.id, {
    subscription: Object.assign({}, sub, {
      cancelAtPeriodEnd: !resume,
      updatedAt: Date.now()
    })
  });

  res.json({ ok: true, entitlement: entitlementFor(updated) });
});

module.exports = router;
