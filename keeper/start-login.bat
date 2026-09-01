@echo off
rem Abre una ventana de terminal NUEVA e independiente con el login de Keeper
rem ya en marcha. El agente puede ejecutar este .bat para "llevar" al usuario
rem al login, pero nunca ve ni puede ver lo que el usuario escribe en esa
rem ventana (contrasena maestra y 2FA quedan fuera del MCP y de la conversacion).
rem
rem Uso: start-login.bat [horas_de_sesion]
start "Keeper Login" cmd /k py "%~dp0login.py" %*
