// Мелкие утилиты: безопасные идентификаторы и работа с JSON-файлами.
const fsp = require('fs').promises;
const { SAFE_ID } = require('../config');

// На Windows CON, NUL, COM1 и т.п. — имена устройств, а не файлов.
// sessionId приходит из браузера, поэтому такие имена отсекаем.
const RESERVED_WIN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function validSession(id) {
  return typeof id === 'string' && SAFE_ID.test(id) && id.length <= 64 && !RESERVED_WIN.test(id);
}

function safeId(id) {
  if (!validSession(id)) throw new Error('Invalid id');
  return id;
}

// private: true — файл только для владельца (0o600). Нужно для users.json,
// сессий и счетов: на Unix-хосте другие пользователи не должны их читать.
async function atomicWrite(file, data, options) {
  // Уникальный tmp: параллельные записи одного файла не перетирают друг друга.
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.' + Math.random().toString(36).slice(2) + '.tmp';
  const writeOptions = { encoding: 'utf8' };
  if (options && options.private) writeOptions.mode = 0o600;
  try {
    await fsp.writeFile(tmp, data, writeOptions);
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

    // Битый JSON нельзя молча превращать в пустой: прогресс или проект
    // будет перезаписан и потерян. Откладываем копию и громко сообщаем.
    // Остальные ошибки (EACCES, EMFILE, антивирус на Windows) не означают,
    // что файл испорчен: файл не трогаем, только сообщаем.
    console.error('[readJson] не удалось прочитать ' + file + ': ' + e.message);
    if (e instanceof SyntaxError) {
      try {
        await fsp.rename(file, file + '.corrupt-' + Date.now());
      } catch (renameError) {
        console.error('[readJson] не удалось отложить битый файл: ' + renameError.message);
      }
    }
    return fallback === undefined ? null : fallback;
  }
}

// Для баз, которые нельзя молча стартовать пустыми (аккаунты, сессии, счета):
// любая ошибка чтения, кроме «файла нет», уходит наверх. Лучше 500, чем
// перезапись базы пустым объектом при следующем сохранении.
async function readJsonStrict(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback === undefined ? null : fallback;
    console.error('[readJsonStrict] ' + file + ': ' + e.message);
    throw e;
  }
}

module.exports = { safeId, validSession, atomicWrite, readJson, readJsonStrict };
