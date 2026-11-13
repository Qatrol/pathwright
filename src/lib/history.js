// Обрезка истории диалога по количеству символов: старые сообщения выкидываем,
// свежие оставляем. Экономит токены и не даёт промпту расти бесконечно.
function trimHistoryByChars(history, maxChars) {
  const out = [];
  let total = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const len = (history[i].content || '').length;
    if (out.length && total + len > maxChars) break;
    total += len;
    out.unshift(history[i]);
  }
  return out;
}

module.exports = { trimHistoryByChars };
