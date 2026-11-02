@echo off
setlocal EnableExtensions
title Instalar Cuadrilla
cd /d "%~dp0"

echo.
echo   Cuadrilla - instalar o actualizar la app de escritorio
echo   -------------------------------------------------------
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   Falta Node.js. Instalalo con este comando y vuelve a abrir este archivo:
  echo.
  echo       winget install OpenJS.NodeJS.LTS
  echo.
  pause
  exit /b 1
)

if exist "Cuadrilla.exe" (
  echo   Cerrando Cuadrilla si estaba abierta...
  start "" /wait "Cuadrilla.exe" /salir
)
curl.exe -s -m 3 -o nul http://127.0.0.1:8787/api/health >nul 2>nul
if not errorlevel 1 (
  echo   Cuadrilla sigue abierta en otra ventana ^(la ventana negra de "npm start"^).
  echo   Cierrala y pulsa una tecla para seguir.
  pause >nul
)

echo   [1/4] Instalando las dependencias...
call npm ci --no-audit --no-fund
if errorlevel 1 goto fallo

echo.
echo   [2/4] Compilando Cuadrilla...
call npm run build
if errorlevel 1 goto fallo

echo.
echo   [3/4] Creando el programa Cuadrilla.exe...
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo   Falta .NET Framework 4, que viene con Windows 10 y 11.
  goto fallo
)
"%CSC%" /nologo /codepage:65001 /target:winexe /optimize+ /out:Cuadrilla.exe /win32icon:public\icons\cuadrilla.ico /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Management.dll scripts\windows\Cuadrilla.cs
if errorlevel 1 goto fallo

echo.
echo   [4/4] Preparando la clave y los accesos directos...
node --disable-warning=ExperimentalWarning dist\src\cli\password.js --generate --if-missing --save CONTRASENA-CUADRILLA.txt
if errorlevel 1 goto fallo
start "" /wait "Cuadrilla.exe" /instalar
if errorlevel 1 goto fallo

echo.
echo   Listo. Cuadrilla se abre en su propia ventana y queda en la bandeja, junto al reloj.
echo   Para abrirla otra vez, usa el icono Cuadrilla del escritorio.
start "" "Cuadrilla.exe"
timeout /t 10 >nul
exit /b 0

:fallo
echo.
echo   Hubo un problema. Revisa los mensajes de arriba.
pause
exit /b 1
