#!/usr/bin/env node
// Синтаксическая проверка всех JS-файлов проекта без запуска сервера.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TARGETS = ['server.js', 'public/app.js', 'public/gate.js', 'public/settings.js', 'scripts/check.js'];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) TARGETS.push(path.relative(ROOT, full));
  }
}
walk(path.join(ROOT, 'src'));

const unique = Array.from(new Set(TARGETS));
let failed = 0;

for (const rel of unique) {
  const file = path.join(ROOT, rel);
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.error || res.status !== 0) {
    failed++;
    console.error('FAIL ' + rel);
    if (res.error) console.error(res.error.message);
    if (res.stderr) console.error(res.stderr.trim());
  } else {
    console.log('ok   ' + rel);
  }
}

if (failed) {
  console.error('\n' + failed + ' файл(ов) с ошибками');
  process.exit(1);
}
console.log('\nВсе ' + unique.length + ' файлов синтаксически корректны');
