@echo off
title Publicar Painel de Treinamentos - Riva Stones
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0PUBLICAR.ps1"
