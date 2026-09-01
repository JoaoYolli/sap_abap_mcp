@echo off
rem Llamado por start-login.bat dentro de la ventana nueva: corre el login y,
rem termine bien o mal, deja el resultado visible unos segundos antes de que
rem la ventana se cierre sola (start-login.bat no usa "cmd /k", así que no
rem hace falta cerrar nada a mano).
py "%~dp0login.py" %*
echo.
echo Cerrando esta ventana en unos segundos...
ping -n 4 127.0.0.1 >nul
