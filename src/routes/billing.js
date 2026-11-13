// Подписки и счета. Оплата пока заглушка (см. src/billing/provider.js):
// счёт создаётся, «оплата» подтверждается запросом к /pay.
const express = require('express');
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
  }
  return bucket.count <= CHECKOUT_LIMIT;
}

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
    paymentStub: provider.stubEnabled()
  });
});

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
    payment = await provider.createPayment(invoice);
  } catch (e) {
    // Без провайдера счёт не должен висеть «ожидает оплаты» вечно.
    await updateInvoice(req.user.id, invoice.id, { status: 'cancelled' }).catch(function () {});
    if (e.code === 'PROVIDER_UNAVAILABLE') {
      return res.status(503).json({ error: e.message, code: e.code });
    }
    throw e;
  }

  await updateInvoice(req.user.id, invoice.id, { provider: payment.provider });

  res.status(201).json({
    invoice: Object.assign({}, invoice, { provider: payment.provider }),
    payment: payment,
    stub: provider.stubEnabled()
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

// Заглушка оплаты. У реального провайдера этот шаг заменяет вебхук:
// клиент сюда ходить не должен, счёт помечается оплаченным по уведомлению.
router.post('/api/billing/invoices/:id/pay', requireAuth, async function (req, res) {
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
  if (!provider.stubEnabled()) {
    return res.status(503).json({ error: 'Оплата временно недоступна', code: 'PROVIDER_UNAVAILABLE' });
  }

  const outcome = await withActivationLock(req.user.id, async function () {
    const user = await findById(req.user.id);
    if (!user) {
      return { status: 401, body: { error: 'Аккаунт не найден', code: 'UNAUTHORIZED' } };
    }

    let confirmation;
    try {
      confirmation = await provider.confirmPayment(invoice);
    } catch (e) {
      if (e.code === 'PROVIDER_UNAVAILABLE') {
        return { status: 503, body: { error: e.message, code: e.code } };
      }
      throw e;
    }

    const paidAt = confirmation.paidAt || Date.now();
    const period = subscriptionPeriod(user, invoice.months, paidAt);

    // Счёт переводится в paid атомарно: два параллельных запроса не могут
    // оплатить его дважды и продлить подписку дважды.
    const marked = await markPaidIfPending(req.user.id, id, {
      paidAt: paidAt,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd
    });
    if (!marked.ok) return payError(marked.reason);

    let updated;
    try {
      updated = await updateUser(req.user.id, {
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
      await updateInvoice(req.user.id, id, {
        status: 'pending', paidAt: null, periodStart: null, periodEnd: null
      }).catch(function (revertError) {
        console.error('[billing] не удалось откатить счёт ' + id + ': ' + revertError.message);
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

  res.status(outcome.status).json(outcome.body);
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
