// Тарифы. Цены и лимиты меняются здесь — остальной код читает их отсюда.
const PLANS = {
  trial: {
    id: 'trial',
    name: 'Пробный период',
    priceMonthly: 0,
    rank: 0,
    dailyGenerations: 60,
    monthlyGenerations: 400,
    description: 'Полный доступ на время пробного периода'
  },
  free: {
    id: 'free',
    name: 'Free',
    priceMonthly: 0,
    rank: 0,
    dailyGenerations: 5,
    monthlyGenerations: 100,
    description: 'Пять новых генераций в день. Готовые уроки из кэша — без ограничений'
  },
  basic: {
    id: 'basic',
    name: 'Basic',
    priceMonthly: 390,
    rank: 1,
    dailyGenerations: 40,
    monthlyGenerations: 900,
    description: 'Для регулярных занятий: 40 новых генераций в день'
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceMonthly: 790,
    rank: 2,
    dailyGenerations: 150,
    monthlyGenerations: 4000,
    description: 'Максимум: 150 новых генераций в день, приоритетная поддержка'
  }
};

// Периоды оплаты. Скидка — доля от суммы за месяцы (0.1 = −10%).
const PERIODS = {
  1: { months: 1, discount: 0 },
  3: { months: 3, discount: 0.1 },
  12: { months: 12, discount: 0.2 }
};

// Что вообще можно купить. Пробный и free не продаются.
const PURCHASABLE = ['basic', 'pro'];

function planById(id) {
  return Object.prototype.hasOwnProperty.call(PLANS, id) ? PLANS[id] : null;
}

function planRank(id) {
  const plan = planById(id);
  return plan ? plan.rank : -1;
}

function periodByMonths(months) {
  return Object.prototype.hasOwnProperty.call(PERIODS, months) ? PERIODS[months] : null;
}

function priceFor(planId, months) {
  const plan = planById(planId);
  const period = periodByMonths(months);
  if (!plan || !period || PURCHASABLE.indexOf(planId) === -1) return null;
  const base = plan.priceMonthly * period.months;
  const amount = Math.round(base * (1 - period.discount));
  return { base: base, amount: amount, discount: period.discount, currency: 'RUB' };
}

function catalogue() {
  return {
    trialDays: require('../config').CONFIG.trialDays,
    plans: Object.keys(PLANS).map(function (id) {
      const p = PLANS[id];
      return {
        id: p.id,
        name: p.name,
        priceMonthly: p.priceMonthly,
        rank: p.rank,
        dailyGenerations: p.dailyGenerations,
        monthlyGenerations: p.monthlyGenerations,
        description: p.description,
        purchasable: PURCHASABLE.indexOf(id) !== -1
      };
    }),
    periods: Object.keys(PERIODS).map(function (m) {
      const p = PERIODS[m];
      return { months: p.months, discount: p.discount };
    }),
    currency: 'RUB'
  };
}

module.exports = {
  PLANS, PERIODS, PURCHASABLE, planById, planRank, periodByMonths, priceFor, catalogue
};
