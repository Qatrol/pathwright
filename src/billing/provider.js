// Платёжный провайдер. Если заданы YOOKASSA_SHOP_ID/YOOKASSA_SECRET_KEY —
// оплата идёт через ЮKassa по СБП. Иначе включается тестовая заглушка
// (PAYMENT_STUB=true), чтобы можно было пройти весь путь без мерчанта.
const { CONFIG } = require('../config');
const yookassa = require('./yookassa');

function mode() {
  const hasShop = !!CONFIG.yookassaShopId;
  const hasSecret = !!CONFIG.yookassaSecret;
  // Половина ключей — это ошибка настройки, а не повод тихо включить
  // бесплатную заглушку: иначе «настроенная» ЮKassa раздаёт подписки даром.
  if (hasShop !== hasSecret) return 'none';
  if (hasShop && hasSecret) return 'yookassa';
  if (CONFIG.paymentStub) return 'stub';
  return 'none';
}

function stubEnabled() {
  return mode() === 'stub';
}

function unavailable(what) {
  const e = new Error('Платёжный провайдер не подключён: ' + what);
  e.code = 'PROVIDER_UNAVAILABLE';
  return e;
}

// ctx.returnUrl — куда провайдер вернёт пользователя после оплаты.
async function createPayment(invoice, ctx) {
  if (mode() === 'yookassa') {
    return yookassa.createPayment(invoice, ctx);
  }
  if (mode() === 'stub') {
    const base = CONFIG.publicBaseUrl || '';
    return {
      provider: 'stub',
      confirmationUrl: base + '/?invoice=' + encodeURIComponent(invoice.id),
      note: 'Тестовый режим: счёт можно «оплатить» кнопкой в настройках'
    };
  }
  throw unavailable('нет ключей');
}

// Подтверждение вручную — только для заглушки. Реальные платежи
// подтверждает вебхук после проверки статуса через API провайдера.
async function confirmPayment(invoice) {
  if (!stubEnabled()) throw unavailable('подтверждение только через вебхук');
  return { provider: 'stub', paid: true, paidAt: Date.now() };
}

module.exports = { mode, stubEnabled, createPayment, confirmPayment };
