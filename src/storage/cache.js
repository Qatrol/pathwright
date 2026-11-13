// Кэш сгенерированных ответов модели: память + JSON-файлы в storage/cache.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { CONFIG, DIRS, CACHE_VERSION } = require('../config');
const { safeId, atomicWrite, readJson } = require('../lib/fsjson');

const memCache = new Map();

function cacheFile(topicId, type) {
  return path.join(DIRS.cache, safeId(topicId) + '__' + type + '__' + CACHE_VERSION + '.json');
}

async function cacheGet(topicId, type) {
  const key = topicId + '__' + type;
  if (memCache.has(key)) {
    const entry = memCache.get(key);
    if (Date.now() - entry.data.createdAt > CONFIG.cacheTtlMs) {
      memCache.delete(key);
      return null;
    }
    return entry.data;
  }
  const data = await readJson(cacheFile(topicId, type), null);
  if (!data) return null;
  // Без createdAt запись считается просроченной, а не вечной.
  if (!data.createdAt || Date.now() - data.createdAt > CONFIG.cacheTtlMs) return null;
  memCache.set(key, { data: data });
  return data;
}

async function cacheSet(topicId, type, answer, extra) {
  const data = Object.assign({
    topicId: topicId,
    type: type,
    answer: answer,
    model: CONFIG.model,
    cacheVersion: CACHE_VERSION,
    approxTokens: Math.round(answer.length / 4),
    createdAt: Date.now()
  }, extra || {});
  await atomicWrite(cacheFile(topicId, type), JSON.stringify(data, null, 2));
  memCache.set(topicId + '__' + type, { data: data });
  return data;
}

async function dropCache(topicId, type) {
  try { await fsp.unlink(cacheFile(topicId, type)); } catch (e) { /* уже нет */ }
  memCache.delete(topicId + '__' + type);
}

async function clearCache() {
  const files = await fsp.readdir(DIRS.cache);
  let removed = 0;
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    await fsp.unlink(path.join(DIRS.cache, f));
    removed++;
  }
  memCache.clear();
  return removed;
}

async function cleanupOldCache() {
  const now = Date.now();
  try {
    const files = await fsp.readdir(DIRS.cache);
    let removed = 0;
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const full = path.join(DIRS.cache, f);
      if (!f.includes('__' + CACHE_VERSION + '.json')) {
        await fsp.unlink(full);
        removed++;
        continue;
      }
      const stat = await fsp.stat(full);
      if (now - stat.mtimeMs > CONFIG.cacheTtlMs) {
        await fsp.unlink(full);
        removed++;
      }
    }
    if (removed) console.log('[cleanup-cache] удалено:', removed);
  } catch (e) { /* каталога может не быть */ }
}

module.exports = {
  memCache,
  cacheFile,
  cacheGet,
  cacheSet,
  dropCache,
  clearCache,
  cleanupOldCache
};
