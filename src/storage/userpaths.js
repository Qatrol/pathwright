// Пути к личным данным пользователя. Все, что приходит из запроса,
// проверяется до подстановки в путь: каталог нельзя выйти за пределы storage/users.
const fs = require('fs');
const path = require('path');
const { CONFIG, SAFE_ID } = require('../config');

function assertUid(uid) {
  if (typeof uid !== 'string' || !SAFE_ID.test(uid) || uid.length > 64) {
    throw new Error('Invalid user id');
  }
  return uid;
}

function userDir(uid) {
  return path.join(CONFIG.storageDir, 'users', assertUid(uid));
}

function userSessionsDir(uid) {
  return path.join(userDir(uid), 'sessions');
}

function userProjectsDir(uid) {
  return path.join(userDir(uid), 'projects');
}

function userProgressFile(uid) {
  return path.join(userDir(uid), 'progress.json');
}

function ensureUserDirs(uid) {
  for (const dir of [userDir(uid), userSessionsDir(uid), userProjectsDir(uid)]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports = {
  assertUid,
  userDir,
  userSessionsDir,
  userProjectsDir,
  userProgressFile,
  ensureUserDirs
};
