@echo off
title Conectar na Vercel - Painel Riva
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\conectar-vercel.ps1"
