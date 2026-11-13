// Express 4 не ловит отклонённые промисы из async-обработчиков.
// Патчим методы роутера, чтобы любой такой отказ уходил в error-middleware,
// а не оставлял запрос висеть без ответа.
function wrapHandler(fn) {
  if (typeof fn !== 'function' || fn.length === 4) return fn;
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all', 'use'];

function wrapRouter(router) {
  for (const method of METHODS) {
    if (typeof router[method] !== 'function') continue;
    const original = router[method].bind(router);
    router[method] = function (path) {
      const handlers = Array.prototype.slice.call(arguments, 1).map(wrapHandler);
      if (typeof path === 'function') return original(wrapHandler(path));
      return original.apply(null, [path].concat(handlers));
    };
  }
  return router;
}

module.exports = { wrapRouter, wrapHandler };
