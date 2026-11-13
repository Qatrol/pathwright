// Pathwright — точка входа. Вся логика в src/.
const app = require('./src/app');
const { CONFIG } = require('./src/config');
const { cleanupOldSessions, flushSessions } = require('./src/storage/sessions');
const { cleanupOldCache } = require('./src/storage/cache');

if (!CONFIG.apiKey) {
  console.warn('Внимание: DEEPSEEK_API_KEY не задан — генерация уроков работать не будет, кеш и интерфейс доступны.');
}

const server = app.listen(CONFIG.port, CONFIG.host, function () {
  console.log('');
  console.log('  Pathwright — DevOps AI Tutor v4.1');
  console.log('  http://localhost:' + CONFIG.port + '  (bind ' + CONFIG.host + ')');
  console.log('  Хранилище: ' + CONFIG.storageDir);
  console.log('');
  cleanupOldSessions();
  cleanupOldCache();
  setInterval(cleanupOldSessions, 60 * 60 * 1000);
  setInterval(cleanupOldCache, 60 * 60 * 1000);
});

server.on('error', function (e) {
  if (e.code === 'EADDRINUSE') {
    console.error('Порт ' + CONFIG.port + ' занят');
    process.exit(1);
  }
  throw e;
});

async function shutdown() {
  console.log('\nСохраняю сессии...');
  // Не висим вечно, если запись на диск залипла.
  setTimeout(function () { process.exit(1); }, 5000).unref();
  await flushSessions();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', function (e) {
  console.error('[unhandledRejection]', (e && e.stack) || e);
});
process.on('uncaughtException', function (e) {
  console.error('[uncaughtException]', (e && e.stack) || e);
});
