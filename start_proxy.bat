@echo off
title Codex NIM Proxy
cd /d "%~dp0"

if not exist .env (
    echo [WARNING] .env file not found. Create one from .env.example and set your NVIDIA_API_KEY.
    echo Copying .env.example to .env ...
    copy .env.example .env >nul 2>&1
    echo Please edit .env and set your NVIDIA NIM API key, then re-run this script.
    pause
    exit /b 1
)

echo Starting Codex NIM Proxy...
echo Proxy  : http://127.0.0.1:15721/v1/responses
echo UI     : http://127.0.0.1:15721/ui
echo.
node responses_proxy.cjs
pause