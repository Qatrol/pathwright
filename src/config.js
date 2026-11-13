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
  temp: { explain: 0.4, task: 0.6, quiz: 0.5, ask: 0.7 }
};

const DIRS = {
  cache: path.join(CONFIG.storageDir, 'cache'),
  sessions: path.join(CONFIG.storageDir, 'sessions'),
  projects: path.join(CONFIG.storageDir, 'projects'),
  logs: path.join(CONFIG.storageDir, 'logs')
};

// storage/ в .gitignore и отсутствует в свежем клоне. Без этого первый же
// saveSession/saveProject/cacheSet падал бы с ENOENT.
const fs = require('fs');
for (const dir of [CONFIG.storageDir, DIRS.cache, DIRS.sessions, DIRS.projects, DIRS.logs]) {
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
