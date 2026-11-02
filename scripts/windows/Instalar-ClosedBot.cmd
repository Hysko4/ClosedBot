@echo off
setlocal EnableExtensions
title Instalar ClosedBot
rem Descarga ClosedBot en tu carpeta de usuario, copia tu contrasena y abre su instalador.
rem Si ClosedBot queda funcionando, envia a la papelera la version anterior, la carpeta cuadrilla.
rem Tus agentes y conversaciones no se borran: el instalador los pasa a la carpeta .closedbot.

set "DEST=%USERPROFILE%\ClosedBot"
set "VIEJA=%USERPROFILE%\cuadrilla"
set "RAMA=app-escritorio"
set "REPO=https://github.com/Hysko4/ClosedBot.git"

echo.
echo   ClosedBot - descargar e instalar
echo   --------------------------------
echo.

set "GIT=git"
where git >nul 2>nul
if errorlevel 1 set "GIT=%ProgramFiles%\Git\cmd\git.exe"
if not "%GIT%"=="git" if not exist "%GIT%" (
  echo   No encontre git en este equipo.
  goto fallo
)

if exist "%DEST%\.git" (
  echo   [1/3] Actualizando el codigo en %DEST% ...
  "%GIT%" -C "%DEST%" fetch origin %RAMA%
  if errorlevel 1 goto fallo
  "%GIT%" -C "%DEST%" checkout -q %RAMA%
  if errorlevel 1 goto fallo
  "%GIT%" -C "%DEST%" merge -q --ff-only origin/%RAMA%
  if errorlevel 1 goto fallo
) else (
  if exist "%DEST%" (
    echo   Ya existe la carpeta %DEST% y no es una descarga de ClosedBot. No la toco.
    goto fallo
  )
  echo   [1/3] Descargando ClosedBot en %DEST% ...
  "%GIT%" clone --branch %RAMA% %REPO% "%DEST%"
  if errorlevel 1 goto fallo
)

echo.
echo   [2/3] Copiando tu contrasena...
if exist "%DEST%\CONTRASENA-CLOSEDBOT.txt" goto instalar
if not exist "%VIEJA%\CONTRASENA-CUADRILLA.txt" goto instalar
copy /y "%VIEJA%\CONTRASENA-CUADRILLA.txt" "%DEST%\CONTRASENA-CLOSEDBOT.txt" >nul
if errorlevel 1 goto fallo
rem Igual que el archivo original: solo tu usuario puede abrirlo.
icacls "%DEST%\CONTRASENA-CLOSEDBOT.txt" /inheritance:r /grant:r "%USERNAME%:F" >nul 2>nul

:instalar
echo.
echo   [3/3] Abriendo el instalador de ClosedBot...
call "%DEST%\Instalar-escritorio.cmd"
rem Si el instalador falla, ya mostro el motivo y espero una tecla.
if errorlevel 1 exit /b 1

echo.
echo   Comprobando que ClosedBot 0.3.0 responde...
set /a INTENTOS=0
:esperar
set /a INTENTOS+=1
curl.exe -s -m 3 http://127.0.0.1:8787/api/health 2>nul | findstr /c:"0.3.0" >nul
if not errorlevel 1 goto funciona
if %INTENTOS% geq 20 goto sin_respuesta
timeout /t 3 /nobreak >nul
goto esperar

:funciona
echo   ClosedBot esta funcionando.
rem Solo se borra la carpeta de la app anterior, y solo si de verdad es esa app.
set "ES_VIEJA="
if exist "%VIEJA%\scripts\windows\Cuadrilla.cs" set "ES_VIEJA=1"
if exist "%VIEJA%\Cuadrilla.exe" set "ES_VIEJA=1"
if not exist "%VIEJA%\package.json" set "ES_VIEJA="
if not defined ES_VIEJA goto terminado
if exist "%VIEJA%\CONTRASENA-CUADRILLA.txt" if not exist "%DEST%\CONTRASENA-CLOSEDBOT.txt" (
  echo   No borro la version anterior porque tu contrasena sigue solo ahi.
  goto terminado
)
echo   Enviando a la papelera la version anterior: %VIEJA%
powershell -NoProfile -Command "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($env:VIEJA, 'OnlyErrorDialogs', 'SendToRecycleBin')"
if exist "%VIEJA%" (
  echo   No pude borrarla entera. Cierra lo que tengas abierto de esa carpeta y vuelve a abrir este archivo.
) else (
  echo   Listo: la version anterior quedo en la papelera.
)
goto terminado

:sin_respuesta
echo   ClosedBot todavia no responde, asi que no borre la version anterior.
echo   Avisale a Claude.
pause
exit /b 1

:terminado
echo.
echo   Todo listo. Ya puedes cerrar esta ventana.
pause
exit /b 0

:fallo
echo.
echo   No se pudo terminar. Avisale a Claude con lo que dice arriba.
pause
exit /b 1
