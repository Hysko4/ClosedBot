@echo off
setlocal EnableExtensions
title Instalar ClosedBot
cd /d "%~dp0"

echo.
echo   ClosedBot - instalar o actualizar la app de escritorio
echo   ------------------------------------------------------
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

set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo   Falta .NET Framework 4, que viene con Windows 10 y 11.
  goto fallo
)

echo   [1/4] Creando el programa ClosedBot.exe...
"%CSC%" /nologo /codepage:65001 /target:winexe /optimize+ /out:ClosedBot.nuevo.exe /win32icon:public\icons\closedbot.ico /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Management.dll scripts\windows\ClosedBot.cs
if errorlevel 1 goto fallo

rem Cierra la app si esta abierta, tambien la version de antes del cambio de nombre (Cuadrilla).
echo   Cerrando ClosedBot si estaba abierta...
start "" /wait "ClosedBot.nuevo.exe" /salir
curl.exe -s -m 3 -o nul http://127.0.0.1:8787/api/health >nul 2>nul
if not errorlevel 1 (
  echo   ClosedBot sigue abierta en otra ventana ^(la ventana negra de "npm start"^).
  echo   Cierrala y pulsa una tecla para seguir.
  pause >nul
)

echo.
echo   [2/4] Instalando las dependencias...
call npm ci --no-audit --no-fund
if errorlevel 1 goto fallo

echo.
echo   [3/4] Compilando ClosedBot...
call npm run build
if errorlevel 1 goto fallo

echo.
echo   [4/4] Preparando la clave y los accesos directos...
rem Si alguien abrio ClosedBot mientras se instalaba, Windows no deja cambiar el programa:
rem se le pide que se cierre y se reintenta unas veces antes de rendirse.
set /a INTENTOS=0
:mover
move /y "ClosedBot.nuevo.exe" "ClosedBot.exe" >nul 2>nul
if not errorlevel 1 goto movido
set /a INTENTOS+=1
if %INTENTOS% geq 5 (
  echo   No pude cambiar ClosedBot.exe porque sigue abierto.
  echo   Cierra ClosedBot desde su icono junto al reloj ^(Salir^) y vuelve a abrir este archivo.
  goto fallo
)
start "" /wait "ClosedBot.nuevo.exe" /salir
timeout /t 2 /nobreak >nul
goto mover
:movido
rem Restos de cuando la app se llamaba Cuadrilla: el programa viejo y el nombre del archivo de la clave.
if exist "Cuadrilla.exe" del /q "Cuadrilla.exe"
if exist "CONTRASENA-CUADRILLA.txt" if not exist "CONTRASENA-CLOSEDBOT.txt" ren "CONTRASENA-CUADRILLA.txt" "CONTRASENA-CLOSEDBOT.txt"
node --disable-warning=ExperimentalWarning dist\src\cli\password.js --generate --if-missing --save CONTRASENA-CLOSEDBOT.txt
if errorlevel 1 goto fallo
rem "acceso-total": todos los agentes ejecutan comandos sin pedir permiso, si aun no se eligio en Ajustes.
if /i "%~1"=="acceso-total" (
  node --disable-warning=ExperimentalWarning dist\src\cli\access.js total --if-unset
  if errorlevel 1 goto fallo
)
start "" /wait "ClosedBot.exe" /instalar
if errorlevel 1 goto fallo

echo.
echo   Listo. ClosedBot se abre en su propia ventana y queda en la bandeja, junto al reloj.
echo   Para abrirla otra vez, usa el icono ClosedBot del escritorio.
start "" "ClosedBot.exe"
timeout /t 10 >nul
exit /b 0

:fallo
echo.
echo   Hubo un problema. Revisa los mensajes de arriba.
pause
exit /b 1
