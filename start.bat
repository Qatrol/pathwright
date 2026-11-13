@echo off
chcp 65001 >nul
title Pathwright — DevOps AI Tutor
cd /d "%~dp0"

echo.
echo ============================================
echo   Pathwright — запуск
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ОШИБКА] Node.js не найден в PATH.
    echo Установите Node.js 18+ и попробуйте снова.
    pause
    exit /b 1
)

if not exist ".env" (
    echo [ОШИБКА] Нет файла .env.
    echo Скопируйте .env.example в .env и вставьте ключ DeepSeek:
    echo     copy .env.example .env
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [INFO] Устанавливаю зависимости...
    call npm install
    if errorlevel 1 (
        echo [ОШИБКА] Не удалось установить зависимости.
        pause
        exit /b 1
    )
)

start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:5555"

echo [INFO] Сервер: http://localhost:5555
echo [INFO] Остановка — Ctrl+C
echo.
node server.js

echo.
pause
