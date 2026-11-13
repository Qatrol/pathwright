// Конфигурация приложения и общие константы.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CACHE_VERSION = 'v4';
const TYPE = { EXPLAIN: 'explain', TASK: 'task', QUIZ: 'quiz' };
const ROLE = { USER: 'user', ASSISTANT: 'assistant', SYSTEM: 'system' };
const SAFE_ID = /^[a-zA-Z0-9_\-]+$/;
const DAY_MS = 24 * 60 * 60 * 1000;

const CONFIG = {
  port: parseInt(process.env.PORT || '5555', 10),
  // По умолчанию только localhost. Для Docker/сервера задайте HOST=0.0.0.0.
  host: process.env.HOST || '127.0.0.1',
  apiKey: process.env.DEEPSEEK_API_KEY,
  apiUrl: 'https://api.deepseek.com/v1/chat/completions',
  model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
  maxTokens: 8000,
  storageDir: process.env.STORAGE_DIR
    ? path.resolve(process.env.STORAGE_DIR)
    : path.join(ROOT, 'storage'),
  cacheTtlMs: 30 * DAY_MS,
  sessionTtlMs: 90 * DAY_MS,
  maxHistoryPerTopic: 50,
  maxHistoryChars: 24000,
  requestTimeoutMs: 300000,
  retries: 3,
  heartbeatMs: 15000,
  autoContinue: true,
  maxContinuations: 2,
  temp: { explain: 0.4, task: 0.6, quiz: 0.5, ask: 0.7 },

  // --- Аккаунты и подписки ---
  cookieName: process.env.COOKIE_NAME || 'pw_session',
  // Secure-кука отправляется только по HTTPS. Включайте, когда сайт стоит
  // за reverse-proxy с TLS: COOKIE_SECURE=true.
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  authSessionTtlMs: 30 * DAY_MS,
  maxSessionsPerUser: 10,
  trialDays: Math.max(0, parseInt(process.env.TRIAL_DAYS || '7', 10) || 0),
  registrationOpen: process.env.REGISTRATION_OPEN !== 'false',
  // Сколько новых аккаунтов в час можно создать с одного адреса.
  registrationLimit: Math.max(1, parseInt(process.env.REGISTRATION_LIMIT || '5', 10) || 5),
  // Часовой пояс для сброса дневного лимита. По UTC «завтра» наступало бы
  // в 03:00 по Москве.
  timezone: process.env.TIMEZONE || 'Europe/Moscow',
  // Оплата пока заглушка: счёт создаётся, «оплата» подтверждается кнопкой.
  // Когда подключите реальный провайдер — PAYMENT_STUB=false.
  paymentStub: process.env.PAYMENT_STUB !== 'false',
  // ЮKassa (СБП). Если ключи заданы — оплата идёт через провайдера,
  // иначе остаётся тестовая заглушка.
  yookassaShopId: process.env.YOOKASSA_SHOP_ID || '',
  yookassaSecret: process.env.YOOKASSA_SECRET_KEY || '',
  adminEmails: (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(function (s) { return s.trim().toLowerCase(); })
    .filter(Boolean),
  // Адрес, на который провайдер вернёт пользователя после оплаты.
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '')
};

const DIRS = {
  cache: path.join(CONFIG.storageDir, 'cache'),
  sessions: path.join(CONFIG.storageDir, 'sessions'),
  projects: path.join(CONFIG.storageDir, 'projects'),
  logs: path.join(CONFIG.storageDir, 'logs'),
  users: path.join(CONFIG.storageDir, 'users'),
  auth: path.join(CONFIG.storageDir, 'auth'),
  billing: path.join(CONFIG.storageDir, 'billing'),
  usage: path.join(CONFIG.storageDir, 'billing', 'usage'),
  invoices: path.join(CONFIG.storageDir, 'billing', 'invoices')
};

// storage/ в .gitignore и отсутствует в свежем клоне. Без этого первый же
// saveSession/saveProject/cacheSet падал бы с ENOENT.
const fs = require('fs');
for (const dir of [
  CONFIG.storageDir, DIRS.cache, DIRS.sessions, DIRS.projects, DIRS.logs,
  DIRS.users, DIRS.auth, DIRS.billing, DIRS.usage, DIRS.invoices
]) {
  fs.mkdirSync(dir, { recursive: true });
}

const STUDENT_PROFILE = process.env.STUDENT_PROFILE ||
  '20 лет, начинающий сисадмин в госструктуре. Работает на Windows 10. Linux изучает через VirtualBox VM (Ubuntu Server) - Linux-команды ученик выполняет в терминале VM (SSH или консоль VirtualBox), НЕ в PowerShell хоста. Команды уровня хоста (VirtualBox, VS Code, установка софта в Windows) помечай явно. Знает базовый Linux, Git, немного Docker, программировал на Node.js и Flutter. Хочет перейти в DevOps и вырасти до Lead. ПРАВИЛА ТОЧНОСТИ: 1) Если не уверен в команде, флаге или синтаксисе - прямо скажи об этом. Попроси проверить --help или man. 2) Указывай версии инструментов там, где критично (Docker 24+, K8s 1.28+). 3) Не выдумывай имена флагов, файлов, команд, API. Лучше сказать не помню точно, проверь в доках, чем дать уверенную галлюцинацию. 4) Для спорных мест ссылайся на официальные доки (docs.docker.com, kubernetes.io).';

module.exports = {
  ROOT,
  CACHE_VERSION,
  TYPE,
  ROLE,
  SAFE_ID,
  DAY_MS,
  CONFIG,
  DIRS,
  STUDENT_PROFILE
};
