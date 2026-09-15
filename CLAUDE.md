# sap-mcp — instrucciones para el agente

Este repo es un servidor MCP (`sap-abap`) que expone tools sobre un sistema
SAP. Las credenciales viven en Keeper Commander, nunca en el chat ni en
archivos locales — ver `README.md` para el diseño completo.

## Antes de escribir código: comprueba que existe y cómo se usa

Antes de usar una función, clase, tipo o tabla de base de datos en código que
vayas a escribir (ABAP o de este propio repo Node.js), no asumas su firma,
sus parámetros, su estructura de campos ni su comportamiento de memoria —
compruébalo primero:

- **Funciones/clases/métodos ABAP**: usa `search_abap_objects` para
  confirmar que existen (y con qué nombre exacto) y `read_abap_source` para
  leer su interfaz real (parámetros, tipos, excepciones) antes de invocarlas
  desde código nuevo. Si vas a modificar o extender algo ya usado en otro
  sitio, revisa también `get_where_used` para no romper llamadas existentes.
- **Tipos/estructuras ABAP (DDIC)**: usa `describe_table_structure` (sirve
  tanto para tablas como para estructuras/tipos DDIC) para conocer los
  campos reales, su tipo y su longitud antes de dar por buena una estructura
  de memoria.
- **Tablas de base de datos**: usa `describe_table_structure` para la
  estructura y, si hace falta ver datos reales de ejemplo,
  `read_table_data` — no asumas nombres de campo ni claves por analogía con
  otras tablas similares.
- **Código de este repo (JS/Node)**: usa `Grep`/`Glob`/`Read` sobre el
  propio repo para confirmar que una función o clase ya existente hace lo
  que crees antes de reutilizarla o extenderla.
- Por qué: escribir a ciegas sobre una firma o estructura supuesta es
  barato al principio pero cae en syntax-check/activate fallido o en un
  bug silencioso más caro de depurar después — comprobarlo antes es una
  sola llamada de lectura.

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

## Antes de crear un documento (pedido, expedición, entrega...): valida los datos primero

Cuando el usuario pida crear en SAP algo que depende de datos maestros o de
movimientos existentes (un pedido de venta, una expedición/entrega, una
orden, etc.), no arranques la creación con datos supuestos o de memoria
(un material cualquiera, un cliente cualquiera). Antes de tocar la
transacción de creación (por ADT o por navegador), busca y confirma datos
reales y válidos en el sistema para ese caso concreto:

- Usa tools de lectura baratas (`read_table_data`, `describe_table_structure`,
  `search_abap_objects`, o el propio ALV/reporte relevante) para encontrar,
  por ejemplo, un material que sí tenga stock disponible en el almacén que
  vas a usar, un cliente que sí esté habilitado para vender/entregar, un
  centro/almacén válido para ese flujo, o un pedido/entrega existente si la
  operación depende de uno.
- El objetivo es no descubrir a mitad de la creación (dentro del dynpro o
  del ALV, ya en el navegador) que el dato elegido no sirve — eso obliga a
  salir, buscar, y volver a entrar, lo cual es mucho más caro en tokens que
  una consulta de lectura hecha por adelantado.
- Si la creación va a hacerse por navegador (porque no hay tool ADT para
  ese documento), esta validación previa es aún más importante: cada
  intento fallido dentro del ALV/dynpro cuesta capturas y rondas de
  interpretación de pantalla completa, no solo una llamada estructurada.
- Si tras la validación previa el dato igual resulta inválido ya dentro de
  la transacción (SAP puede rechazar por reglas no visibles desde las
  tablas de lectura), no lo tomes como fallo del paso de validación —
  corrige con otro dato ya confirmado y sigue, en vez de volver a explorar
  a ciegas.
- Ver `project_sap_mcp_context` en memoria para la conexión y los objetos
  de prueba ya autorizados en este sistema — si ya hay materiales/clientes
  de prueba conocidos y válidos, empieza por ahí en vez de buscar de cero.

## Registro de desarrollos SAP (vault Obsidian) — pide visto bueno antes de documentar

Existe un vault de Obsidian fuera de este repo, en la carpeta home del
usuario activo del sistema operativo (en Windows,
`%USERPROFILE%\SAP-Dev-Log`), con el registro de desarrollos ABAP y reports
ejecutados en los sistemas SAP gestionados desde este MCP — código escrito/
modificado/activado, fixes, reports corridos con resultado relevante para
el negocio. No es el historial de cambios de este repo (eso lo cubre git):
documenta lo que se hizo **dentro de SAP**, con el sistema en el que se
hizo siempre como dato obligatorio.

- Estructura: `README.md` (punto de entrada, léelo primero si es la
  primera vez que tocas el vault en la sesión), `Indice.md` (lista plana
  cronológica), `_Plantillas/desarrollo.md` y `_Plantillas/reporte.md`
  (front-matter y secciones ya listos para copiar), carpetas `Desarrollos/`,
  `Reportes/` (una nota por `YYYY-MM-DD--slug.md`) y `Sistemas/` (una nota
  por alias de conexión, con enlaces a cada desarrollo/reporte hecho ahí).
  Front-matter de cada nota: `tipo`, `fecha`, `sistema` (alias de conexión
  tal cual lo usa `list_connections` — **obligatorio**), `sid`, `objetos`,
  `estado`, `tags`, `relacionado`. Detalle completo del esquema y de cómo
  enlazar una nota nueva desde `Indice.md` y `Sistemas/` en el propio
  `README.md` del vault.
- **Regla fija, igual de estricta que la de Keeper**: nunca crees ni edites
  una nota en este vault sin que el usuario haya dado el visto bueno
  explícito **para ese desarrollo concreto**, justo antes. Al terminar un
  desarrollo o report relevante, resume en el chat qué documentarías (tipo,
  sistema, objetos tocados, resultado) y pregunta si lo registras — solo
  escribe si la respuesta es afirmativa. Si el usuario ya pidió
  explícitamente "documenta esto" para ese desarrollo concreto, eso cuenta
  como visto bueno y no hace falta volver a preguntar.
- Por qué esta regla: para que el registro quede limpio y refleje solo lo
  que el usuario considera relevante, no un log automático de todo lo que
  pasa por el MCP.

## Paralelización con subagentes: despliega varios cuando ayude, eligiendo el modelo según la tarea

Cuando una tarea se pueda dividir en subtareas independientes (o cuando
distintas partes tengan necesidades de capacidad muy distintas), no la
resuelvas siempre en serie con un único agente: despliega varios agentes en
paralelo, uno por subtarea, y para cada uno elige el modelo más adecuado a
su complejidad — uno más rápido/barato para subtareas simples o mecánicas,
uno más capaz para las que requieran más razonamiento — en vez de usar el
mismo modelo para todo por defecto.

- Por qué: paraleliza el trabajo real (menos tiempo de punta a punta) y
  evita gastar capacidad de un modelo caro en subtareas que uno más barato
  resuelve igual de bien.
- Cómo: usa la tool de despliegue de subagentes ya disponible en tu
  cliente (en Claude Code, el tool Agent/Task con su parámetro de modelo),
  sin que haga falta ninguna tool nueva de este MCP — es una práctica de
  orquestación del propio agente, no una feature de `sap-mcp`.
- No fuerces paralelismo en tareas que en realidad son secuenciales o
  dependientes entre sí (p. ej. un paso necesita el resultado del
  anterior) — la regla es paralelizar cuando ayude, no siempre.

## Al rellenar pantallas en WebGUI: lee los mensajes y usa F4 antes de improvisar

Cuando estés dentro de una transacción vía navegador (SAP GUI para HTML),
no asumas que un Tab/Enter fue aceptado sin comprobarlo — SAP casi siempre
lo dice en la propia pantalla, y leerlo ahí es mucho más barato que seguir
adelante a ciegas y descubrir el problema varios pasos después:

- **Mensajes de error/warning**: tras cada Tab/Enter/Guardar, revisa la
  barra de mensajes (normalmente en la parte inferior de la pantalla, texto
  rojo para error o amarillo para warning) con `get_page_text`/`read_page`
  antes de seguir rellenando. Un error ahí casi siempre explica exactamente
  qué campo o qué valor está mal — no lo ignores ni sigas adelante
  asumiendo que "ya se arreglará".
- **Campos obligatorios sin rellenar**: se marcan con un asterisco (`*`)
  junto a la etiqueta o dentro del propio campo. Si SAP bloquea el avance
  (no deja guardar, o vuelve a la misma pantalla), repasa primero si hay
  algún `*` sin completar antes de sospechar de otra cosa.
- **F4 (ayuda de valores)**: muchos campos aceptan F4 para desplegar una
  lista de valores válidos ya filtrada al contexto actual (cliente,
  material, centro... coherentes con lo que ya hay rellenado en la
  pantalla). Si un dato que habías validado previamente (ver sección
  anterior) resulta no servir ya dentro de la transacción, prueba F4 en ese
  campo antes de salir a buscar otro dato por otra vía (tabla, ADT,
  navegar a otra transacción) — normalmente es más rápido y ya viene
  acotado al caso concreto, así que evita otra ronda de búsqueda aparte.

## Tablas de posiciones editables (ALV/table control clásico: VL01N, VA01...)

Estas tablas (p. ej. "Todas las posiciones" en VL01N) NO son HTML normal:
cada celda es un `<span role="combobox">` del motor "Unified Rendering" de
SAP GUI, con un atributo `readonly` que el framework quita o pone por su
cuenta. Investigado en sesión sobre VL01N en 2026-09:

- **Si una celda no acepta texto (clic + escribir no deja nada, y el valor
  vuelve a quedar vacío al validar), NO es un bug de automatización — casi
  siempre es que falta un campo obligatorio (asterisco rojo) en la
  cabecera de la misma pantalla.** SAP bloquea toda la tabla de posiciones
  hasta que esos campos estén completos (comprobado: en VL01N "sin
  referencia a pedido", la tabla queda con `readonly` en todas las celdas
  hasta rellenar "Dest.mercancías"; en cuanto se rellena ese campo, el
  `readonly` desaparece solo y las celdas aceptan texto con normalidad).
- **Diagnóstico barato antes de insistir con más clics**: usa
  `javascript_tool` para inspeccionar la celda en la que hiciste clic:
  ```js
  const el = document.activeElement;
  ({ tag: el.tagName, id: el.id, readonly: el.getAttribute('readonly'), ariaReadonly: el.getAttribute('aria-readonly') })
  ```
  Si `readonly` no es `null`, para de intentar clics/dobles-clics/F2 en esa
  celda — ve a rellenar los campos obligatorios de cabecera (los marcados
  con `*`) primero, y vuelve después. Esto cuesta una sola llamada y evita
  una ronda larga de prueba y error.
- **Receta una vez que la celda ya no es readonly**: un solo clic en la
  celda + `type` con el valor + `Tab` — no hace falta doble-clic ni F2. Tab
  mueve el foco a la siguiente celda de la fila. La descripción del
  material, la unidad de medida y el tipo de posición se resuelven en un
  round-trip del servidor que puede no completarse hasta el próximo Tab/
  Enter que salga de la fila (p. ej. al volver a un campo de cabecera) —
  si ves columnas derivadas vacías tras rellenar Material, es normal,
  espera al siguiente round-trip en vez de asumir que falló.
- **Ese round-trip puede reiniciar valores que tecleaste demasiado
  pronto** (p. ej. una cantidad escrita justo antes de que la fila
  termine de validarse puede volver a quedar vacía). Trátalo como
  cualquier otro campo dynpro: rellena, espera (`wait` de 1-2s), y
  verifica con una captura/zoom antes de seguir con el siguiente dato —
  no encadenes muchos campos a ciegas en un solo lote.
- Los popups de confirmación que a veces aparecen tras un Tab/Enter (p.
  ej. "Programación de posición da como resultado fecha...") son parte de
  la propia página (no diálogos nativos del navegador que bloqueen), así
  que se pueden cerrar con normalidad haciendo clic en su botón
  "Continuar".
- El tamaño de viewport de la pestaña puede cambiar solo entre llamadas
  (observado: 1536×735 → 1522×784 → 1568×750 sin que el agente redimensione
  nada) — no reutilices coordenadas de píxeles de una captura antigua;
  recalcúlalas siempre a partir de la captura más reciente.
