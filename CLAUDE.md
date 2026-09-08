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

## Automatización de navegador/PC: prioriza siempre la alternativa más barata en tokens

Este repo incluye un prototipo de acceso a SAP GUI para HTML vía navegador
(`keeper/webgui-proxy.js` + `start-webgui.bat`, pensado para usarse con la
extensión `claude-in-chrome`) para cubrir lo que ADT no puede. Al operarlo —
o cualquier otra tarea que implique interactuar con una interfaz visual—,
usa la opción más barata en tokens que resuelva el paso, y solo sube de
nivel cuando esa opción no alcance:

1. **Primero, texto estructurado**: `read_page` (árbol de accesibilidad),
   `find` (búsqueda por descripción) y `get_page_text` — casi siempre
   bastan para saber qué hay en la pantalla o localizar un elemento, y
   cuestan una fracción de lo que cuesta una imagen.
2. **Solo si hace falta ver el layout real** (validar visualmente un ALV,
   confirmar coordenadas de algo no accesible por texto), recurre a
   `computer` con `screenshot`, y limita la captura a la pestaña/ventana
   relevante en vez de a la pantalla completa.
Fuera de esos dos niveles, **no uses control total del PC/escritorio**
(herramientas de "computer use" a nivel de sistema operativo, fuera del
navegador): queda excluido por defecto, no es una opción de último
recurso a la que subir de nivel. Todo lo que haga falta hacer en el
navegador se resuelve dentro de una pestaña con `claude-in-chrome`. Usa
control total del PC únicamente si el usuario lo pide de forma explícita
para ese caso concreto (p. ej. "necesito que controles todo el PC para
esto"); sin esa petición explícita, ni lo propongas como alternativa.
