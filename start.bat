@echo off
chcp 65001 >nul
cd /d "%~dp0"
where ffmpeg >nul 2>nul || (echo ffmpeg not found. Install: winget install Gyan.FFmpeg & pause & exit /b 1)
python resizer.py
pause
