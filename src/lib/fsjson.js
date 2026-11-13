// Мелкие утилиты: безопасные идентификаторы и работа с JSON-файлами.
const fsp = require('fs').promises;
const { SAFE_ID } = require('../config');

function safeId(id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id) || id.length > 64) {
    throw new Error('Invalid id');
  }
  return id;
}

function validSession(id) {
  return typeof id === 'string' && SAFE_ID.test(id) && id.length <= 64;
}

async function atomicWrite(file, data) {
  // Уникальный tmp: параллельные записи одного файла не перетирают друг друга.
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.' + Math.random().toString(36).slice(2) + '.tmp';
  try {
    await fsp.writeFile(tmp, data, 'utf8');
    await fsp.rename(tmp, file);
  } catch (e) {
    try { await fsp.unlink(tmp); } catch (cleanupError) { /* tmp уже нет */ }
    throw e;
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback === undefined ? null : fallback;

    // Битый файл нельзя молча превращать в пустой: прогресс или проект
    // будет перезаписан и потерян. Откладываем копию и громко сообщаем.
    console.error('[readJson] не удалось прочитать ' + file + ': ' + e.message);
    try {
      await fsp.rename(file, file + '.corrupt-' + Date.now());
    } catch (renameError) {
      console.error('[readJson] не удалось отложить битый файл: ' + renameError.message);
    }
    return fallback === undefined ? null : fallback;
  }
}

module.exports = { safeId, validSession, atomicWrite, readJson };
