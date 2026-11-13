// Защита платных вызовов модели: проверка лимита и списание одним
// атомарным шагом, возврат при ошибке.
// Ответы из кэша и ожидание чужой генерации сюда не попадают —
// они ничего не стоят и лимит не тратят.
const { entitlementFor } = require('./entitlements');
const { reserve, refund } = require('./usage');

// Возвращает null, если запрос уже отклонён (ответ отправлен),
// иначе — объект с release() для возврата списанной генерации при ошибке.
async function guardGeneration(req, res) {
  const entitlement = entitlementFor(req.user);
  const result = await reserve(req.user.id, entitlement);

  if (!result.allowed) {
    const check = result.check;
    res.status(402).json({
      error: check.message,
      code: 'LIMIT_REACHED',
      scope: check.scope,
      limit: check.limit,
      used: check.used,
      resetAt: check.resetAt,
      plan: entitlement.plan.id
    });
    return null;
  }

  let released = false;
  return {
    entitlement: entitlement,
    release: function () {
      if (released) return;
      released = true;
      refund(req.user.id).catch(function (e) {
        console.error('[usage] не удалось вернуть генерацию: ' + e.message);
      });
    }
  };
}

// Обрыв запроса клиентом (закрытие вкладки, «Стоп») — не повод возвращать
// генерацию: модель уже потратила токены.
function isClientAbort(err) {
  return !!(err && (err.name === 'AbortError' || err.code === 'ABORT_ERR'));
}

module.exports = { guardGeneration, isClientAbort };
