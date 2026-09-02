# sap-mcp — instrucciones para el agente

Este repo es un servidor MCP (`sap-abap`) que expone tools sobre un sistema
SAP. Las credenciales viven en Keeper Commander, nunca en el chat ni en
archivos locales — ver `README.md` para el diseño completo.

## Login de Keeper: ejecútalo tú, no se lo derives al usuario

Cuando cualquier tool `mcp__sap-abap__*` falle porque la sesión de Keeper
está caducada o no iniciada, el error trae un comando de terminal exacto.
Regla fija, tanto si el fallo ocurrió solo como si el usuario pide "inicia
sesión en Keeper" explícitamente:

- Llama tú mismo a tu propia herramienta de terminal (Bash/PowerShell) con
  ese comando, en el mismo turno — no le digas al usuario que lo ejecute él,
  ni le muestres el comando para que lo copie/pegue. Tu terminal sí puede
  abrirle la ventana de login; el proceso del servidor MCP no puede (no
  tiene desktop propio).
- Que tu cliente te pida confirmación de permiso antes de ejecutar el
  comando es normal y está bien — confírmalo y sigue. Eso no es motivo para
  derivárselo al usuario en su lugar.
- Mostrarle el comando al usuario para que lo pegue él mismo es el último
  recurso, solo si en esa sesión no tienes ninguna herramienta de terminal
  propia disponible — nunca la opción por defecto.
- Tras ejecutarlo, pide al usuario que complete el login (email, contraseña
  maestra, 2FA — tú nunca ves esos datos) y avise cuando termine, y
  reintenta entonces la operación original.
