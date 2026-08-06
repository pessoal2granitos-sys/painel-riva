@echo off
title Painel de Treinamentos - Riva Stones
cd /d "%~dp0"

set NODE_DIR=%LOCALAPPDATA%\node-portable\node-v24.19.0-win-x64
if not exist "%NODE_DIR%\node.exe" (
  echo.
  echo  ERRO: Node.js nao encontrado em:
  echo  %NODE_DIR%
  echo.
  echo  Instale o Node.js LTS ou ajuste a variavel NODE_DIR neste arquivo.
  echo.
  pause
  exit /b 1
)

echo.
echo   ====================================================
echo    PAINEL DE TREINAMENTOS NORMATIVOS - RIVA STONES
echo   ====================================================
echo.
echo    Iniciando o servidor...
echo    Endereco: http://localhost:3000
echo.
echo    NAO FECHE ESTA JANELA enquanto estiver usando o painel.
echo    Para encerrar, feche esta janela ou pressione Ctrl+C.
echo.

start "" http://localhost:3000
"%NODE_DIR%\node.exe" server.js

echo.
echo  O servidor foi encerrado.
pause
