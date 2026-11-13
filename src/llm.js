// Общение с DeepSeek: SSE-стриминг, ретраи, автопродолжение, кэш и лог токенов.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { CONFIG, DIRS, ROLE } = require('./config');

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// Запрос к DeepSeek с повторами на сетевые сбои, 429 и 5xx.
// Ретраим только до того, как клиенту ушёл первый байт ответа.
async function fetchCompletion(messages, temperature, signal) {
  let lastError = null;

  for (let attempt = 1; attempt <= CONFIG.retries; attempt++) {
    let response = null;

    try {
      response = await fetch(CONFIG.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + CONFIG.apiKey
        },
        body: JSON.stringify({
          model: CONFIG.model,
          messages: messages,
          temperature: temperature,
          max_tokens: CONFIG.maxTokens,
          stream: true,
          stream_options: { include_usage: true }
        }),
        signal: signal
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastError = e;
      if (attempt === CONFIG.retries) throw e;
      console.warn('[deepseek] попытка ' + attempt + ' не удалась: ' + e.message + ', повтор');
      await sleep(600 * attempt);
      continue;
    }

    if (response.ok) return response;

    const body = await response.text().catch(function () { return ''; });
    lastError = new Error('DeepSeek ' + response.status + ': ' + body.slice(0, 300));

    // 400/401/403 и прочие неретрайабельные статусы не повторяем.
    if (!RETRYABLE_STATUS.has(response.status) || attempt === CONFIG.retries) throw lastError;

    console.warn('[deepseek] попытка ' + attempt + ' не удалась: HTTP ' + response.status + ', повтор');
    await sleep(600 * attempt);
  }

  throw lastError || new Error('DeepSeek: неизвестная ошибка');
}

async function streamOnce(messages, res, temperature, req) {
  const controller = new AbortController();
  const timeout = setTimeout(function () { controller.abort(); }, CONFIG.requestTimeoutMs);
  const onClose = function () { try { controller.abort(); } catch (e) { /* уже закрыт */ } };
  req.on('close', onClose);

  let response;
  try {
    response = await fetchCompletion(messages, temperature, controller.signal);
  } catch (e) {
    clearTimeout(timeout);
    req.off('close', onClose);
    throw e;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let finishReason = null;
  let usage = null;
  let parseErrors = 0;

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let json;
        try {
          json = JSON.parse(payload);
        } catch (e) {
          parseErrors++;
          continue;
        }

        // Провайдер умеет присылать ошибку прямо в потоке — не глотаем её.
        if (json.error) {
          const message = json.error.message || JSON.stringify(json.error).slice(0, 200);
          throw new Error('DeepSeek: ' + message);
        }

        if (json.usage) usage = json.usage;
        const choice = json.choices && json.choices[0];
        if (!choice) continue;
        const delta = choice.delta && choice.delta.content;
        if (delta) {
          full += delta;
          try { res.write('data: ' + JSON.stringify({ delta: delta }) + '\n\n'); } catch (e) { /* клиент ушёл */ }
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }
  } finally {
    clearTimeout(timeout);
    req.off('close', onClose);
    try { await reader.cancel(); } catch (e) { /* поток уже закрыт */ }
  }

  if (parseErrors) {
    console.warn('[deepseek] пропущено неполных SSE-строк: ' + parseErrors);
  }

  return { full: full, finishReason: finishReason, usage: usage };
}

async function logTokenUsage(endpoint, meta, usage) {
  try {
    const u = usage || {};
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ep: endpoint,
      meta: meta || {},
      in: u.prompt_tokens || 0,
      out: u.completion_tokens || 0,
      hit: u.prompt_cache_hit_tokens || 0,
      miss: u.prompt_cache_miss_tokens || 0,
      total: u.total_tokens || 0,
      noUsage: usage ? undefined : true
    }) + '\n';
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(DIRS.logs, 'tokens-' + day + '.log');
    await fsp.appendFile(file, line, 'utf8');
  } catch (e) {
    console.error('[logTokens]', e.message);
  }
}

function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  if (res.flushHeaders) res.flushHeaders();
}

async function streamDeepSeek(messages, res, temperature, req, logMeta) {
  sseHeaders(res);

  // Комментарий-пинг не даёт прокси и браузеру прибить соединение,
  // пока модель думает над первым токеном.
  const heartbeat = setInterval(function () {
    try { res.write(': ping\n\n'); } catch (e) { /* соединение закрыто */ }
  }, CONFIG.heartbeatMs);

  let allText = '';
  const totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let lastFinish = null;
  let continuationCount = 0;

  try {
    const first = await streamOnce(messages, res, temperature, req);
    allText += first.full;
    lastFinish = first.finishReason;
    if (first.usage) {
      totalUsage.prompt_tokens += first.usage.prompt_tokens || 0;
      totalUsage.completion_tokens += first.usage.completion_tokens || 0;
      totalUsage.total_tokens += first.usage.total_tokens || 0;
    }

    // Автопродолжение, если модель обрезалась по лимиту токенов.
    while (CONFIG.autoContinue && lastFinish === 'length' && continuationCount < CONFIG.maxContinuations) {
      continuationCount++;
      try { res.write('data: ' + JSON.stringify({ continuation: continuationCount }) + '\n\n'); } catch (e) { /* клиент ушёл */ }

      const contMessages = messages.concat([
        { role: ROLE.ASSISTANT, content: allText },
        { role: ROLE.USER, content: 'Продолжи с того места, где остановился. Не повторяй уже написанное. Начни сразу с продолжения текста.' }
      ]);

      const next = await streamOnce(contMessages, res, temperature, req);
      allText += next.full;
      lastFinish = next.finishReason;
      if (next.usage) {
        totalUsage.prompt_tokens += next.usage.prompt_tokens || 0;
        totalUsage.completion_tokens += next.usage.completion_tokens || 0;
        totalUsage.total_tokens += next.usage.total_tokens || 0;
      }
    }
  } finally {
    clearInterval(heartbeat);
  }

  if (lastFinish === 'length') {
    try {
      res.write('data: ' + JSON.stringify({
        warning: 'Ответ обрезан даже после ' + CONFIG.maxContinuations + ' автопродолжений. Уменьши объём или разбей тему.'
      }) + '\n\n');
    } catch (e) { /* клиент ушёл */ }
  }

  try { res.write('data: ' + JSON.stringify({ usage: totalUsage, finishReason: lastFinish }) + '\n\n'); } catch (e) { /* клиент ушёл */ }
  logTokenUsage(logMeta ? logMeta.endpoint : 'unknown', logMeta, totalUsage).catch(function () {});
  try {
    res.write('data: ' + JSON.stringify({ done: true }) + '\n\n');
    res.end();
  } catch (e) { /* клиент ушёл */ }

  return { full: allText, usage: totalUsage, finishReason: lastFinish };
}

function streamCached(res, answer, extra) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.write('data: ' + JSON.stringify(Object.assign({ cached: true, approxTokens: Math.round(answer.length / 4) }, extra || {})) + '\n\n');
  res.write('data: ' + JSON.stringify({ delta: answer }) + '\n\n');
  res.write('data: ' + JSON.stringify({ done: true }) + '\n\n');
  res.end();
}

function sseError(res, message) {
  // После streamDeepSeek ответ уже закрыт (например, упало сохранение на диск).
  // Писать туда нельзя — это ERR_STREAM_WRITE_AFTER_END. Логируем и выходим.
  if (res.writableEnded || res.destroyed) {
    console.error('[sse] ответ уже завершён, ошибка только в лог: ' + message);
    return;
  }
  try {
    if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    res.write('data: ' + JSON.stringify({ error: message }) + '\n\n');
    res.end();
  } catch (e) { /* соединение уже закрыто */ }
}

module.exports = {
  sleep,
  fetchCompletion,
  streamOnce,
  logTokenUsage,
  streamDeepSeek,
  streamCached,
  sseError
};
