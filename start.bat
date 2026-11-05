$bat = @'
@echo off
chcp 65001 >nul
title DevOps AI Tutor
cd /d "%~dp0"

echo.
echo ============================================
echo   🚀 DevOps AI Tutor — запуск
echo ============================================
echo.

REM --- Проверка Node.js ---
where node >nul 2>nul
if errorlevel 1 (
    echo [ОШИБКА] Node.js не найден в PATH.
    echo Установи Node.js и попробуй снова.
    echo.
    pause
    exit /b 1
)

REM --- Проверка .env ---
if not exist ".env" (
    echo [ОШИБКА] Файл .env не найден в папке проекта.
    echo Создай .env с содержимым:
    echo     DEEPSEEK_API_KEY=sk-твой-ключ
    echo     PORT=5555
    echo.
    pause
    exit /b 1
)

REM --- Проверка node_modules ---
if not exist "node_modules" (
    echo [INFO] node_modules не найдена, устанавливаю зависимости...
    call npm install express cors dotenv
    if errorlevel 1 (
        echo [ОШИБКА] Не удалось установить зависимости.
        pause
        exit /b 1
    )
)

REM --- Убить старые процессы node (если висят) ---
taskkill /F /IM node.exe >nul 2>nul

REM --- Открыть браузер через 2 секунды в фоне ---
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:5555"

REM --- Запуск сервера ---
echo [INFO] Запускаю сервер...
echo [INFO] Сайт: http://localhost:5555
echo [INFO] Для остановки нажми Ctrl+C
echo.

node server.js

echo.
echo [INFO] Сервер остановлен.
pause
'@

$path = "C:\Users\Александр\Desktop\devops\start.bat"
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($path, $bat, $utf8)
Write-Host "✅ start.bat создан: $path"