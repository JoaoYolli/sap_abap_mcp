@echo off
rem Abre una ventana de terminal NUEVA e independiente con el proxy inverso
rem local de SAP WebGUI (webgui-proxy.js) ya en marcha. El agente ejecuta
rem este .bat con su propia herramienta de terminal (nunca desde dentro del
rem proceso del servidor MCP, que no tiene desktop propio) y luego navega a
rem http://localhost:<puerto>/ -- nunca llega a ver el host real ni las
rem credenciales, que quedan solo en la memoria de ESTA ventana.
rem
rem Uso: start-webgui.bat <alias> [puerto] [transaccion]
rem Rollback: cierra esta ventana (o Ctrl+C) -- el proxy no escribe nada en
rem disco, no hay estado que limpiar.
cd /d "%~dp0.."
start "SAP WebGUI Proxy" cmd /k node keeper\webgui-proxy.js %*
