@echo off
rem Rollback de emergencia: mata el proceso node que esta escuchando en el
rem puerto del proxy WebGUI, por si la ventana se cerro de forma sucia o se
rem quiere liberar el puerto sin ir a buscar la ventana a mano.
rem
rem Uso: stop-webgui.bat [puerto]   (por defecto 4728, el mismo default de webgui-proxy.js)
setlocal
set "PORT=%~1"
if "%PORT%"=="" set "PORT=4728"

powershell -NoProfile -Command ^
  "$c = Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue; if ($c) { $c | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }; Write-Host 'Proxy en el puerto %PORT% detenido.' } else { Write-Host 'No habia ningun proceso escuchando en el puerto %PORT%.' }"

pause
