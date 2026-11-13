// Платёжный провайдер. Сейчас — заглушка: счёт создаётся, оплата
// подтверждается кнопкой в интерфейсе. Реальный провайдер (ЮKassa и др.)
// реализует те же две функции, а роут /api/billing/invoices/:id/pay
// заменяется на вебхук провайдера.
const { CONFIG } = require('../config');

function stubEnabled() {
  return CONFIG.paymentStub;
}

function unavailable(what) {
  const e = new Error('Платёжный провайдер не подключён: ' + what);
  e.code = 'PROVIDER_UNAVAILABLE';
  return e;
}

// Возвращает данные для редиректа на страницу оплаты.
async function createPayment(invoice) {
  if (!stubEnabled()) throw unavailable('нет ключей');
  const base = CONFIG.publicBaseUrl || '';
  return {
    provider: 'stub',
    confirmationUrl: base + '/?invoice=' + encodeURIComponent(invoice.id),
    note: 'Тестовый режим: счёт можно «оплатить» кнопкой в личном кабинете'
  };
}

// Подтверждение оплаты. У реального провайдера вызывается из вебхука
// после проверки подписи уведомления.
async function confirmPayment(invoice) {
  if (!stubEnabled()) throw unavailable('нет ключей');
  return { provider: 'stub', paid: true, paidAt: Date.now() };
}

module.exports = { stubEnabled, createPayment, confirmPayment };
