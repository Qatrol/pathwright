// Базовые тесты без обращения к DeepSeek: API, статика, утилиты.
const test = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');

process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'test-key';
process.env.PORT = '0';

const app = require('../src/app');
const { trimHistoryByChars } = require('../src/lib/history');
const { roadmap, topicIndex } = require('../src/roadmap');

let server;
let base;

test.before(async function () {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = 'http://127.0.0.1:' + server.address().port;
});

test.after(function () {
  server.close();
});

test('health отвечает ok', async function () {
  const res = await fetch(base + '/health');
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.status, 'ok');
  assert.ok(body.version);
});

test('роадмап: 7 месяцев и 37 тем', function () {
  assert.strictEqual(roadmap.months.length, 7);
  assert.strictEqual(topicIndex.size, 37);
});

test('stats считает проценты корректно', async function () {
  const res = await fetch(base + '/api/stats');
  const s = await res.json();
  assert.strictEqual(s.total, 37);
  assert.ok(s.learned >= 0 && s.learned <= s.total);
  assert.strictEqual(s.percent, Math.round(s.learned / s.total * 100));
  assert.strictEqual(s.perMonth.length, 7);
});

test('статика отдаёт index, css и js', async function () {
  for (const path of ['/', '/styles.css', '/app.js', '/favicon.svg']) {
    const res = await fetch(base + path);
    assert.strictEqual(res.status, 200, path);
    assert.ok((await res.text()).length > 100, path);
  }
});

test('неизвестный маршрут — 404 JSON', async function () {
  const res = await fetch(base + '/api/nope');
  assert.strictEqual(res.status, 404);
  assert.deepStrictEqual(await res.json(), { error: 'Не найдено' });
});

test('неверный sessionId отклоняется', async function () {
  const res = await fetch(base + '/api/history/../../etc');
  assert.ok([400, 404].includes(res.status));
});

test('security headers на месте', async function () {
  const res = await fetch(base + '/');
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
  assert.match(res.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.strictEqual(res.headers.get('access-control-allow-origin'), null);
});

test('monthId с обходом каталога отклоняется', async function () {
  const fs = require('node:fs');
  const path = require('node:path');
  const evil = path.join(__dirname, '..', 'public', 'evil.json');
  try { fs.unlinkSync(evil); } catch (e) { /* файла нет — и хорошо */ }

  const res = await fetch(base + '/api/project/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'sess_test', monthId: '../../public/evil' })
  });

  assert.ok([400, 404].includes(res.status), 'status ' + res.status);
  assert.strictEqual(fs.existsSync(evil), false);
});

test('trimHistoryByChars оставляет свежие сообщения', function () {
  const history = [
    { content: 'a'.repeat(100) },
    { content: 'b'.repeat(100) },
    { content: 'c'.repeat(100) }
  ];
  const trimmed = trimHistoryByChars(history, 250);
  assert.strictEqual(trimmed.length, 2);
  assert.strictEqual(trimmed[1].content[0], 'c');
});
