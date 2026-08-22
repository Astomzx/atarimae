@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Atarimae かんたんセットアップ
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows\install.ps1"
if errorlevel 1 (
  echo.
  echo セットアップは完了していません。上の説明を確認してください。
)
echo.
pause
