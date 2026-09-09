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

## SAP vía Chrome es el último recurso, no una alternativa equivalente a ADT

La feature de SAP GUI para HTML vía navegador (siguiente sección) — no un
prototipo, es funcionalidad estable de este repo — cuesta
**muchos más tokens** que cualquier tool `mcp__sap-abap__*` sobre ADT — cada
paso implica navegar, leer árbol de accesibilidad o capturas, e interpretar
una pantalla completa, en vez de una única llamada estructurada. Por eso:

- Antes de tocar el navegador, comprueba si ya existe una tool ADT que
  resuelva la tarea (revisa la lista de tools `mcp__sap-abap__*` disponibles,
  o `mcp__sap-abap__list_adt_discovery` si dudas de si el endpoint existe).
  Si existe, úsala siempre — no ofrezcas el navegador como alternativa "por
  si acaso" cuando ya hay una tool ADT que cubre lo pedido.
- Solo propón/usa el navegador cuando confirmes que no hay tool ADT para esa
  tarea concreta (p. ej. ST02/DBACOCKPIT, SOST, o cualquier transacción sin
  tool dedicada todavía).
- Cada vez que propongas o inicies el uso del navegador para SAP, dilo
  explícitamente y avisa del coste elevado en tokens frente a ADT, para que
  quien lea la respuesta sepa que esa vía es más cara — no lo des por
  sobreentendido ni lo omitas aunque ya lo hayas avisado antes en la misma
  conversación.

## Arrancar el proxy WebGUI: usa las tools, no el terminal

El proxy de SAP GUI para HTML tiene sus propias tools del MCP —
`start_webgui_proxy`, `get_webgui_proxy_status`, `stop_webgui_proxy`
(`tools/webgui.js`) — así que llámalas como cualquier otra tool
`mcp__sap-abap__*`, sin pasar por Bash/PowerShell ni por
`start-webgui.bat`/`stop-webgui.bat` (esos `.bat` siguen existiendo solo como
respaldo manual para el usuario, no como paso del agente). A diferencia del
login de Keeper (sección anterior), esto SÍ puede hacerlo una tool MCP
directamente: el proxy no necesita ninguna ventana ni interacción del
usuario, así que no choca con la limitación de "esta tool no tiene desktop
propio".

- `start_webgui_proxy` es agnóstico a la transacción: una vez arrancado para
  un alias, sirve cualquier ruta del sistema real detrás de él. Si ya hay un
  proxy activo para el mismo alias en el mismo puerto, la propia tool lo
  detecta y lo reutiliza — nunca la llames de nuevo solo para cambiar de
  pantalla dentro de la misma sesión de trabajo. Para pasar a otra
  transacción, navega (`navigate`) la misma pestaña a la URL que te devolvió
  la tool cambiando `~transaction=<TCODE>`.
- Si solo quieres saber si ya puedes navegar sin arrancar nada, usa antes
  `get_webgui_proxy_status`.
- Usa `stop_webgui_proxy` para el rollback en vez de pedirle al usuario que
  cierre una ventana — ya no hay ninguna ventana visible que cerrar (el
  proceso se lanza oculto).

## Automatización de navegador/PC: prioriza siempre la alternativa más barata en tokens

Este repo incluye una feature de acceso a SAP GUI para HTML vía navegador
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

**Por qué esta jerarquía**: no es solo alcance/seguridad, también es coste
en tokens. `claude-in-chrome` sobre una sola pestaña (con texto estructurado
como primer nivel) es la opción más barata de las dos formas de "ver la
pantalla"; controlar el PC entero a nivel de sistema operativo es más caro
todavía que el propio navegador, porque cada acción implica capturas de
pantalla completas y coordenadas en vez de una pestaña acotada y su árbol
de accesibilidad. Es decir: ADT (más barato) < `claude-in-chrome` en una
pestaña (caro frente a ADT, pero la opción correcta cuando no hay tool ADT)
< control total del PC (el más caro con diferencia, y por eso excluido por
defecto salvo petición explícita del usuario). Esto no cambia el resto de
reglas de esta sección: sigue avisando siempre del coste elevado del
navegador frente a ADT, y sigue sin usarse control total del PC sin
petición explícita.
