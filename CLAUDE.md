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

## Instrucciones personales del usuario: gestiónalas con tools, no a mano

Cualquier usuario de este MCP puede pedirte que le guardes instrucciones
propias para que su agente las reciba automáticamente al arrancar cada
sesión futura, sin tener que repetirlas en el chat cada vez (p. ej. "usa
siempre la conexión de pruebas X salvo que diga lo contrario", "haz
siempre tú el login de Keeper sin preguntar"). Estas instrucciones:

- viven en `~/.sap-mcp/instructions.json` (carpeta del usuario del sistema
  operativo activo — `os.homedir()` — no dentro de este repo), así que
  sobreviven a un `git pull`, a una reinstalación o a un cambio de versión
  del MCP, y son privadas de ese usuario/máquina: nunca se suben a git ni
  se comparten entre usuarios.
- se gestionan solo con las tools `add_personal_instruction`,
  `list_personal_instructions` y `remove_personal_instruction`
  (`tools/user-instructions.js` + `lib/user-instructions.js`) — nunca
  edites ese JSON a mano ni con Bash/PowerShell, usa siempre las tools.
- se inyectan automáticamente en las `instructions` del servidor MCP al
  arrancar (`index.js` llama a `formatPersonalInstructionsBlock()`), así
  que cualquier cliente (Claude u otro) las recibe desde el primer turno de
  cada sesión nueva sin que el usuario tenga que pedirlo. Un cambio hecho
  con add/remove_personal_instruction se aplica desde el próximo arranque
  del servidor MCP, no a mitad de la sesión actual — avisa de eso si el
  usuario espera que valga ya mismo.
