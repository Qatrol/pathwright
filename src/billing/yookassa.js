// Платёжный провайдер ЮKassa, способ оплаты — СБП (Система быстрых платежей).
// Ключи берутся из окружения: YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY.
// Без них слой не активен, приложение работает с тестовой заглушкой.
const { CONFIG } = require('../config');

const API = 'https://api.yookassa.ru/v3';
const TIMEOUT_MS = 20000;

function configured() {
  return !!(CONFIG.yookassaShopId && CONFIG.yookassaSecret);
}

function authHeader() {
  return 'Basic ' + Buffer.from(CONFIG.yookassaShopId + ':' + CONFIG.yookassaSecret).toString('base64');
}

async function request(path, options) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
  const opts = options || {};

  let response;
  try {
    response = await fetch(API + path, {
      method: opts.method || 'GET',
      headers: Object.assign({
        'Authorization': authHeader(),
        'Content-Type': 'application/json'
      }, opts.headers || {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { /* не JSON */ }

  if (!response.ok) {
    const description = data && (data.description || (data.error && data.error.message));
    const err = new Error('ЮKassa ' + response.status + ': ' + (description || text.slice(0, 200)));
    err.code = 'PROVIDER_ERROR';
    err.status = response.status;
    throw err;
  }
  return data;
}

// Создаёт платёж с СБП. Idempotence-Key = id счёта: повторный checkout
// не создаст второй платёж за тот же счёт.
async function createPayment(invoice, options) {
  if (!configured()) {
    const e = new Error('ЮKassa не настроена');
    e.code = 'PROVIDER_UNAVAILABLE';
    throw e;
  }
  const opts = options || {};
  const amount = (Math.round(invoice.amount * 100) / 100).toFixed(2);

  const payment = await request('/payments', {
    method: 'POST',
    headers: { 'Idempotence-Key': invoice.id },
    body: {
      amount: { value: amount, currency: 'RUB' },
      capture: true,
      // redirect: пользователь выбирает банк в приложении ЮKassa и платит по СБП.
      confirmation: {
        type: 'redirect',
        return_url: opts.returnUrl || (CONFIG.publicBaseUrl + '/')
      },
      payment_method_data: { type: 'sbp' },
      description: 'Pathwright · ' + invoice.planName + ', ' + invoice.months + ' мес',
      metadata: {
        invoiceId: invoice.id,
        userId: invoice.userId
      }
    }
  });

  return {
    provider: 'yookassa',
    paymentId: payment.id,
    status: payment.status,
    confirmationUrl: payment.confirmation && payment.confirmation.confirmation_url
  };
}

async function fetchPayment(paymentId) {
  if (!configured()) {
    const e = new Error('ЮKassa не настроена');
    e.code = 'PROVIDER_UNAVAILABLE';
    throw e;
  }
  if (typeof paymentId !== 'string' || !/^[a-zA-Z0-9-]{8,64}$/.test(paymentId)) {
    const e = new Error('Неверный id платежа');
    e.code = 'BAD_PAYMENT_ID';
    throw e;
  }
  return request('/payments/' + encodeURIComponent(paymentId));
}

module.exports = { configured, createPayment, fetchPayment };
