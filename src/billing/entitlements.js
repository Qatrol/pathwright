// Что пользователю сейчас доступно: оплаченная подписка, пробный период
// или бесплатный тариф. Статус не хранится отдельным полем — он вычисляется
// из дат, поэтому «просроченная» подписка не может остаться активной.
const { PLANS, planById } = require('./plans');

function subscriptionActive(user, now) {
  const sub = user && user.subscription;
  if (!sub) return false;
  return sub.plan !== 'free' &&
    sub.status === 'active' &&
    typeof sub.periodEnd === 'number' &&
    sub.periodEnd > now;
}

function trialActive(user, now) {
  return !!(user && user.trialEndsAt && user.trialEndsAt > now);
}

function resolve(user, now) {
  now = now || Date.now();
  if (subscriptionActive(user, now)) {
    return { planId: user.subscription.plan, source: 'subscription' };
  }
  if (trialActive(user, now)) {
    return { planId: 'trial', source: 'trial' };
  }
  return { planId: 'free', source: 'free' };
}

function entitlementFor(user, now) {
  now = now || Date.now();
  const { planId, source } = resolve(user, now);
  const plan = planById(planId) || PLANS.free;
  const sub = (user && user.subscription) || {};

  return {
    plan: {
      id: plan.id,
      name: plan.name,
      priceMonthly: plan.priceMonthly,
      dailyGenerations: plan.dailyGenerations,
      monthlyGenerations: plan.monthlyGenerations,
      description: plan.description
    },
    source: source,
    trial: {
      active: trialActive(user, now),
      endsAt: (user && user.trialEndsAt) || 0,
      daysLeft: trialActive(user, now)
        ? Math.max(1, Math.ceil((user.trialEndsAt - now) / (24 * 60 * 60 * 1000)))
        : 0
    },
    subscription: {
      plan: sub.plan || 'free',
      status: sub.status || 'none',
      periodStart: sub.periodStart || null,
      periodEnd: sub.periodEnd || null,
      cancelAtPeriodEnd: !!sub.cancelAtPeriodEnd
    }
  };
}

module.exports = { subscriptionActive, trialActive, resolve, entitlementFor };
