# sap-mcp

Servidor MCP (Model Context Protocol) que expone operaciones sobre un sistema
SAP (ABAP/ADT, RFC estándar, Basis) como *tools* para un agente de IA (Claude
Code u otro cliente MCP). No es un cliente SAP GUI ni requiere instalar nada
en el lado SAP: habla directamente con los servicios REST de ADT ya
disponibles en cualquier sistema NetWeaver/S4HANA con Eclipse ADT habilitado,
más el gateway SOAP RFC clásico para un par de tools que necesitan datos en
memoria del kernel.

## Requisitos y dependencias

Para que el servidor funcione de punta a punta hacen falta, además del propio
repo:

- **Node.js 18+** — usa `fetch` global y ES modules (`"type": "module"` en
  `package.json`). Dependencias npm: `@modelcontextprotocol/sdk` y `zod`
  (ver `package.json`).
- **Python 3** con el paquete
  [`keepercommander`](https://pypi.org/project/keepercommander/) —
  `lib/connection.js` lo invoca como subproceso (vía el launcher `py`, no
  `python`, para evitar el alias roto de la Microsoft Store en Windows) para
  resolver las conexiones SAP a través de Keeper. Sin esto, ninguna tool que
  necesite `connection` puede funcionar.
- **Una cuenta de Keeper** con acceso de escritura a un vault, y la carpeta
  `Claude Connections` creada ahí con al menos un registro de conexión — ver
  la sección "Configurar conexiones SAP" más abajo. No hace falta Keeper
  Secrets Manager ni ninguna licencia especial: basta con el login normal
  (usuario, contraseña maestra, 2FA) que ya usarías para entrar al vault.
- **Un sistema SAP** (NetWeaver/S4HANA) con los servicios REST de ADT
  habilitados — los mismos que usa Eclipse ADT — y, para las tools de
  "estado en vivo" (`get_lock_entries`, `get_work_processes`), el gateway
  SOAP RFC clásico (`/sap/bc/soap/rfc`) activo. Ver limitaciones conocidas
  más abajo para lo que no está cubierto por ningún camino estándar.
- *(Opcional, best-effort)* autorización de lectura sobre la tabla `USR02`
  para el aviso automático de caducidad de usuario (ver tool
  `get_user_expiration` y la comprobación diaria en `getConnection`). Si no
  está disponible, el aviso simplemente no aparece nunca — no rompe ninguna
  otra tool.

## Instalación

```bash
npm install
py -m pip install -r keeper/requirements.txt
```

## Instalar o actualizar vía un agente

Si en vez de escribir los comandos a mano prefieres que un agente de IA
(Claude Code u otro cliente MCP) lo haga por ti, copia y pega uno de estos
dos prompts según el caso. Ambos asumen un agente con acceso a terminal
(Bash/PowerShell) en la máquina donde vive o va a vivir el repo.

### Prompt para actualizar una instalación ya existente

Úsalo cuando el MCP `sap-abap` ya está registrado en tu cliente pero
sospechas que el repo local no tiene los últimos cambios de `main`.

```
Ya tengo el servidor MCP "sap-abap" (repo sap-mcp) registrado en este
cliente, pero puede que la copia local del repo no tenga los últimos
cambios de la rama main en https://github.com/JoaoYolli/sap_abap_mcp .
Actualízalo tú mismo, sin pedirme que ejecute nada a mano salvo lo que
se indica explícitamente al final:

1. Localiza la carpeta del repo local: revisa cómo está registrado el
   servidor "sap-abap" en este cliente (por ejemplo `claude mcp list` en
   Claude Code, o el archivo de configuración de servidores MCP que use tu
   cliente) para encontrar la ruta que usa el comando "node index.js"; esa
   carpeta es el repo.
2. Dentro de esa carpeta, ejecuta `git status`. Si hay cambios locales sin
   commitear que no reconozcas como tuyos de esta tarea, para y avísame en
   vez de descartarlos o sobreescribirlos.
3. Ejecuta `git pull` (rama main, remoto origin) para traer los últimos
   cambios.
4. Si `package.json` cambió en el pull, ejecuta `npm install`. Si
   `keeper/requirements.txt` cambió, ejecuta `py -m pip install -r
   keeper/requirements.txt` (usa el launcher `py`, no `python`, en Windows;
   `python3` en macOS/Linux).
5. El servidor MCP corre como proceso aparte del tuyo, así que no puedes
   forzar su reconexión: dime que ejecute `/mcp` en Claude Code (o el
   equivalente de mi cliente) para reconectar "sap-abap" con el código ya
   actualizado.
6. Confírmame con `git log -1 --oneline` a qué commit quedó actualizado el
   repo.
```

### Prompt para instalar desde cero (incluye contexto completo)

Úsalo con un agente que no conoce este proyecto todavía — por eso lleva
todo el contexto necesario incluido, no solo los comandos.

```
Quiero que instales de cero, en esta máquina, el servidor MCP "sap-abap"
(repo "sap-mcp"): un servidor MCP en Node.js que expone como tools de IA
operaciones sobre un sistema SAP (ABAP/ADT vía servicios REST estándar, más
el gateway SOAP RFC clásico para un par de tools de estado en vivo). No es
un cliente SAP GUI ni instala nada del lado SAP. El repo está en
https://github.com/JoaoYolli/sap_abap_mcp (rama main).

Requisitos que debes comprobar o pedirme antes de continuar (no los asumas
ni los saltes):
- Node.js 18+ y Python 3 disponibles en el PATH (en Windows, el launcher
  se llama `py`, no `python` — evita el alias roto de la Microsoft Store).
- Una cuenta de Keeper (gestor de contraseñas) con acceso de escritura a un
  vault. Esto es mío, no lo tienes tú ni puedes crearlo por mí — si no la
  tengo, dímelo y para ahí en vez de improvisar un almacén de credenciales
  alternativo. Las credenciales SAP viven solo en Keeper, nunca en el chat
  ni en archivos del repo.

Pasos:
1. Pregúntame en qué carpeta quiero clonar el repo (o usa una carpeta de
   proyectos razonable por defecto si te la indico) y clónalo:
   `git clone https://github.com/JoaoYolli/sap_abap_mcp.git`.
2. Dentro de esa carpeta: `npm install` (dependencias: solo
   `@modelcontextprotocol/sdk` y `zod`) y `py -m pip install -r
   keeper/requirements.txt` (instala `keepercommander`, con el launcher
   `py`/`python3` según el sistema operativo).
3. Regístralo como servidor MCP en mi cliente. Si es Claude Code, usa ruta
   absoluta para que funcione lances `claude` desde donde lances:
   `claude mcp add sap-abap -- node "<ruta-absoluta-al-repo>/index.js"`.
   Si mi cliente MCP es otro, adapta el registro a su forma de añadir un
   servidor stdio con ese mismo comando (`node index.js` en la carpeta del
   repo).
4. Este repo tiene una feature opcional (no hace falta para las tools ADT
   principales) que abre SAP GUI para HTML en el navegador para lo que ADT
   no cubre, y depende de otro MCP: la extensión/cliente "Claude in
   Chrome" (tools `mcp__claude-in-chrome__*`). Comprueba si ya tienes esas
   tools disponibles en esta sesión; si no, esa extensión se instala por
   fuera de este repo (Chrome Web Store + habilitarla en tu cliente MCP),
   tú no puedes instalarla vía terminal — límitate a avisarme de que existe
   esa dependencia opcional y de cómo activarla, no lo bloquees ni lo
   intentes forzar.
5. Dime que ejecute `/mcp` en Claude Code (o el equivalente de mi cliente)
   para confirmar que "sap-abap" quedó conectado.
6. Las credenciales SAP se configuran en mi vault de Keeper, no en el repo:
   guíame para crear ahí una carpeta "Claude Connections" con al menos un
   registro tipo Login (campos `login`, `password`, y los custom fields de
   texto `host` y `client`) — tú no tienes acceso a mi vault, así que esta
   parte la hago yo siguiendo tus instrucciones, no la automatices.
7. Una vez conectado y con al menos una conexión creada, verifica que todo
   funciona llamando a la tool `list_connections` y luego `check_connection`
   sobre uno de los alias que aparezcan, y dime el resultado.
```

## Configurar conexiones SAP

Las credenciales **nunca** viajan por el chat ni como argumentos de las
tools, y **no viven en ningún archivo local del repo ni de la máquina**: se
guardan en Keeper y se piden en el momento a través de Keeper Commander.

### 1. Organizar las conexiones en Keeper

Crea una carpeta llamada **`Claude Connections`** en el nivel superior de tu
vault de Keeper. Dentro, una subcarpeta por empresa/servidor (o registros
sueltos directamente si no hace falta agrupar). Cada conexión SAP es un
registro tipo **Login** con:

- `login` → usuario SAP
- `password` → contraseña SAP
- un campo personalizado de texto llamado **`host`** → URL base, ej. `http://mihost:8000`
- un campo personalizado de texto llamado **`client`** → mandante, ej. `100`

```
Claude Connections/
  EmpresaA/
    Prod          (host, client, login, password)
    Dev
  EmpresaB/
    Prod
```

El **alias** que se usa como parámetro `connection` en las tools se calcula
solo a partir de esa estructura: el título del registro si está directamente
en `Claude Connections`, o `"<subcarpeta>/<título>"` si está dentro de una
subcarpeta (ej. `EmpresaA/Prod`). No hace falta editar ningún archivo para
dar de alta una conexión nueva — basta con crear el registro en Keeper. Usa
la tool `list_connections` para ver qué alias hay disponibles ahora mismo
(sin exponer host/usuario/contraseña); si dos registros generan el mismo
alias, `list_connections` los marca como ambiguos hasta que se rename uno.

### 2. Iniciar sesión en Keeper (una vez, y cada vez que caduque)

El propio agente se encarga de esto: la tool `start_keeper_login` (registrada
junto a `list_connections`/`check_connection`) abre una ventana de terminal
**nueva e independiente** con `keeper/login.py [horas]` ya en marcha. Su
descripción le deja explícito al agente que es él quien debe llamarla, sin
que el usuario tenga que pedírselo, en cuanto cualquier otra tool falle con
un error de sesión de Keeper caducada o no iniciada — así que en la práctica
solo hace falta completar el login en la ventana que aparece (email,
contraseña maestra, 2FA) cuando toque. El agente nunca ve ni puede ver lo
que se escribe ahí.

También se puede lanzar a mano, en una terminal normal — **nunca dentro del
chat de Claude Code**, para que la contraseña maestra y el 2FA no pasen por
la conversación con la IA:

```bash
py keeper/login.py [horas_de_sesion]
```

Pide email + contraseña maestra + 2FA de Keeper de forma interactiva, activa
el login persistente del dispositivo y fija cuánto dura esa sesión (por
defecto 10 horas).

### 3. Cómo lo usa el servidor

`lib/connection.js` no guarda nada: en cada `getConnection()`/`list_connections`
invoca `keeper/fetch_secret.py`/`keeper/list_connections.py`, que reutilizan
la sesión de `login.py` para consultar Keeper Commander en vivo (con una
caché en memoria de 5 minutos para no lanzar un proceso Python en cada
llamada). Nunca hay contraseñas en disco: solo el propio proceso de Keeper
(fuera del control del servidor MCP) y una sesión de dispositivo revocable
en cualquier momento desde el vault.

## Arrancar el servidor

El servidor habla el protocolo MCP por stdio (pensado para ser lanzado por un
cliente MCP, no para ejecutarse suelto en una terminal):

```bash
node index.js
```

Para usarlo desde Claude Code (u otro cliente MCP), regístralo apuntando a
`index.js` con Node como comando, según la configuración de servidores MCP de
tu cliente.

### Registrar en Claude Code

Desde la carpeta del proyecto:

```bash
claude mcp add sap-abap -- node index.js
```

O con ruta absoluta (recomendado si vas a lanzar `claude` desde otro
directorio):

```bash
claude mcp add sap-abap -- node "<ruta-al-repo>\sap-mcp\index.js"
```

Después, usa `/mcp` dentro de Claude Code para comprobar que `sap-abap` está
conectado (o reconectarlo tras cambios en el código del servidor).

## Estructura del proyecto

```
index.js                   Arranque: crea el McpServer y registra cada módulo de tools
lib/
  connection.js             Resolución de alias -> credenciales, vía Keeper Commander (keeper/*.py)
  http.js                   fetch autenticado a ADT, CSRF, lock/unlock, resolución de rutas de objetos
  xml.js                    Parseo XML con regex (sin dependencias) + escapeXml
  sql.js                    Ejecuta OpenSQL vía el servicio ADT "SQL Console" (datapreview/freestyle)
  rfc.js                    Cliente mínimo del gateway SOAP RFC clásico (/sap/bc/soap/rfc)
keeper/
  login.py                  Login interactivo de Keeper (usuario/contraseña/2FA), ejecutar a mano en terminal
  start-login.bat           Abre una ventana de terminal nueva con login.py ya en marcha (para que la lance el agente)
  _common.py                Helpers compartidos: sesión persistente, descubrimiento de carpetas/registros
  list_connections.py       Descubre los alias disponibles en la carpeta "Claude Connections"
  fetch_secret.py           Resuelve un alias a {host, client, user, password} (invocado por lib/connection.js)
  webgui-proxy.js           Proxy inverso local para SAP GUI para HTML (WebGUI) — ver sección dedicada más abajo
  start-webgui.bat          Abre una ventana de terminal nueva con webgui-proxy.js ya en marcha
  stop-webgui.bat           Rollback de emergencia: mata el proceso que escucha en el puerto del proxy
tools/
  general.js                Conexión: listar alias, comprobar conectividad
  basis.js                  Sistema: specs, dumps ST22
  basis-monitoring.js        Monitorización Basis vía tablas estándar (SM37, SM58, SM13/14, SOST/SOIN, gateway log, SM59)
  basis-live.js              Monitorización Basis vía RFC en vivo (SM12, SM50/SM66)
  objects.js                Código fuente ABAP: leer, escribir, activar, buscar
  db.js                     Lectura genérica de tablas
  reports.js                Ejecutar programas/reports ABAP
  daily-monitoring.js        Tool agregadora: checklist básico de monitorización diaria
```

Cada módulo de monitorización (`basis.js`, `basis-monitoring.js`, `basis-live.js`)
exporta, además de sus tools, una función `fetch*` por cada consulta (p.ej.
`fetchBackgroundJobs`, `fetchLockEntries`). Las tools individuales las llaman
igual que siempre — nada cambia en su comportamiento — pero eso permite que
`daily-monitoring.js` las reutilice sin duplicar el SQL/RFC.

Cada `tools/*.js` exporta una función `registerXTools(server)` que registra
sus tools en la instancia `McpServer`; `index.js` solo importa y llama a cada
una. Todas las tools siguen el mismo patrón: reciben `connection` (+ params
propios), resuelven la conexión con `getConnection`, hacen la llamada real y
devuelven `{ content: [{ type: "text", text }] }` (o `isError: true` con el
mensaje de error si algo falla).

## Tools disponibles

### Conexión

| Tool | Descripción |
|---|---|
| `start_keeper_login` | Abre una ventana de terminal nueva con el login de Keeper en marcha. El agente la llama solo, sin que se le pida, en cuanto otra tool falla por sesión de Keeper caducada o no iniciada. |
| `list_connections` | Lista los alias descubiertos en la carpeta "Claude Connections" de Keeper y sus subcarpetas (sin credenciales). |
| `check_connection` | Comprueba que una conexión está viva y devuelve SID/host/usuario/mandante. |
| `list_adt_discovery` | Lista los servicios ADT realmente activos en el sistema (vía `/sap/bc/adt/discovery`), con filtro opcional. Útil para confirmar si un servicio (checkruns, atc, usedby...) existe antes de asumirlo. |

### Sistema

| Tool | Descripción |
|---|---|
| `get_system_specs` | SID, mandante, release de SAP_BASIS/ABAP y componentes instalados (tabla `CVERS`). |
| `get_user_expiration` | Fecha de caducidad (y de validez desde) de un usuario SAP, tabla `USR02` — equivalente a "Válido hasta/desde" de SU01. |
| `get_st22_dumps` | Lista dumps ABAP (ST22) en un rango de fechas, opcionalmente filtrados por usuario. |
| `get_st22_dump_detail` | Detalle completo (texto, call stack) de un dump concreto. |

### Monitorización Basis — tablas estándar

Sin desarrollo ABAP: consultan directamente tablas estándar SAP vía el
servicio OpenSQL de ADT.

| Tool | Transacción equivalente | Notas |
|---|---|---|
| `get_background_jobs` | SM37 | Por defecto muestra trabajos `ACTIVE`/`ABORTED`. |
| `get_background_job_steps` | SM37 (detalle) | Pasos de un trabajo concreto (`job_name` + `job_count`). |
| `get_trfc_queue` | SM58 | Cola de RFC transaccional; por defecto solo errores. |
| `get_update_task_records` | SM13 / SM14 | Cabeceras de registros de actualización (tabla `VBHDR`). |
| `get_sapconnect_requests` | SOST / SOIN | Solicitudes de envío/recepción; por defecto solo errores. |
| `get_gateway_error_log` | `/IWFND/ERROR_LOG` | Log de errores de Gateway/OData (tabla `/IWFND/SU_ERRLOG`). |
| `get_rfc_destinations` | SM59 | Destinos RFC configurados, con el host extraído de `RFCOPTIONS`. |

### Monitorización Basis — estado en vivo (RFC)

Sin desarrollo ABAP: invocan módulos de función RFC-habilitados **ya
existentes** en cualquier sistema SAP a través del gateway SOAP RFC clásico
(`/sap/bc/soap/rfc`), un servicio estándar del kernel.

| Tool | Transacción equivalente | FM usado | Notas |
|---|---|---|---|
| `get_lock_entries` | SM12 | `ENQUE_READ2` | Filtrable por objeto de bloqueo, argumento y usuario. |
| `get_work_processes` | SM50 / SM66 | `TH_WPINFO` | Puede devolver vacío si el usuario de la conexión no tiene autorización SM50 para llamadas RFC externas (lo corta el propio módulo estándar, no es un fallo de la tool). |

> **Fuera de alcance por ahora**: ST02 (buffers), DBACOCKPIT (monitor de BD)
> y SICK (health check) no tienen un camino RFC/tabla estándar limpio en el
> sistema investigado — quedan pendientes de más investigación si hace falta.

### Objetos ABAP (código fuente)

Cubren cualquier tipo de objeto (`PROG`, `CLAS`, `FUGR`, `FUNC`, `INTF`,
`TABL`, `VIEW`, `DTEL`, `DOMA`, `REPS`); para `FUNC` hay que indicar además
`function_group`.

| Tool | Descripción |
|---|---|
| `read_abap_source` | Lee el código fuente de un objeto. |
| `write_abap_source` | Escribe/actualiza el código fuente de un objeto existente (lock → PUT → unlock, con detección automática de orden de transporte). |
| `get_object_transport` | Comprueba si un objeto ya está asignado a una orden de transporte y lista órdenes candidatas. |
| `activate_object` | Activa un objeto ABAP. |
| `search_abap_objects` | Busca objetos por nombre/patrón (actualmente devuelve error del lado SAP en algunos sistemas — `ExceptionParameterNotFound: ris_request_type`). |
| `format_source` | Formatea código ABAP con el Pretty Printer estándar de ADT (`/sap/bc/adt/abapsource/prettyprinter`). No requiere que el objeto exista. |
| `check_syntax` | Chequea sintaxis de un objeto (`/sap/bc/adt/checkruns`), sobre la versión activa o sobre un `source_code` propuesto sin guardar. Verificada en vivo (ambas ramas). Pensada para usar antes de `write_abap_source`/`activate_object`. |
| `get_where_used` | Where-Used List de un objeto (`/sap/bc/adt/repository/informationsystem/usageReferences`, con el URI como query param). Verificada en vivo. |
| `run_atc_check` | Chequeo ABAP Test Cockpit (`/sap/bc/adt/atc/*`, flujo de 3 pasos). **Limitación conocida**: el paso de lanzar el run devuelve 500 en el sistema de pruebas (probable falta de autorización ATC del usuario, no un bug de la tool) — ver comentario en `tools/atc.js`. |

### Datos y ejecución

| Tool | Descripción |
|---|---|
| `read_table_data` | `SELECT {fields} FROM {table} [WHERE ...]` genérico vía el SQL Console de ADT. |
| `describe_table_structure` | Estructura DDIC de una tabla/estructura (campos, tipos, longitud, clave) vía RFC `DDIF_FIELDINFO_GET`. |
| `run_abap_report` | Ejecuta un programa/report sin pantalla de selección y devuelve su salida. |

### Checklist diario (agregador)

| Tool | Descripción |
|---|---|
| `monitoreo_basico_basis_diario` | Corre en una sola llamada el checklist básico de monitorización diaria de Basis, reutilizando las tools de arriba. |

`monitoreo_basico_basis_diario` mapea 1:1 contra un checklist estándar de
monitorización diaria. Cobertura:

| Punto del checklist | Estado | Tool usada |
|---|---|---|
| Runtime errors + seguimiento de usuarios (ST22) | ✅ Incluido | `get_st22_dumps` (agrupa por usuario) |
| System logs (SM21 / SM13 / SM14) | ⚠️ Parcial | `get_update_task_records` (solo SM13/SM14; **SM21 no incluido**) |
| Batch job exceptions y long running jobs (SM37) | ✅ Incluido | `get_background_jobs` (separa abortados vs. activos de larga duración) |
| Recursos de sistema, locks y long running jobs (ST02/DBACOCKPIT) | ⛔ Excluido | Sin tool estándar (ver README, sección de Basis-live) |
| Database Monitor (excepciones/warnings) | ⛔ Excluido | Sin tool |
| FIORI Gateway logs (/IWFND/ERROR_LOG) | ✅ Incluido | `get_gateway_error_log` |
| SOIN / SOST | ✅ Incluido | `get_sapconnect_requests` |
| Health de application servers (SM51/SM50/SM66) | ✅ Incluido | `get_work_processes` |
| Transactional RFC Monitoring (SM58) | ✅ Incluido | `get_trfc_queue` |
| Recursos SARFC | ⛔ Excluido | Sin tool |
| Work Processes y persistent locks | ✅ Incluido | `get_work_processes` + `get_lock_entries` |
| System Health Check (SICK) | ⛔ Excluido | Sin tool (ver limitaciones de `run_abap_report`) |

Los puntos excluidos no se inventan ni se aproximan con otra tabla: el
reporte los lista al final como pendientes, para que quede claro qué falta
implementar (ver planning de nuevas tools).

## Feature: SAP GUI para HTML (WebGUI) en el navegador

Para lo que ADT no cubre (pantallas de selección interactivas, transacciones
sin equivalente REST, SM50/DBACOCKPIT/SICK, etc.), esta feature abre SAP GUI
para HTML (`/sap/bc/gui/sap/its/webgui`) en Chrome vía la extensión
`claude-in-chrome`, sin que el host real del servidor ni las credenciales
pasen nunca por el agente/la conversación. No es un prototipo desechable:
es funcionalidad estable del repo, pero consume muchos más tokens que una
tool ADT — úsese solo cuando no exista tool ADT para la tarea (ver
`CLAUDE.md`), y avisando siempre de ese coste al usarla.

```
Chrome (claude-in-chrome) --> http://localhost:<puerto>/...   (esto es lo único que ve el agente)
  --> keeper/webgui-proxy.js (resuelve el alias vía Keeper, igual que getConnection;
      host/usuario/contraseña quedan SOLO en la memoria de este proceso)
    --> https://<host-real>/...   (Authorization: Basic ... inyectado aquí)
```

- **Arrancar**: `keeper/start-webgui.bat <alias> [puerto] [transaccion]` abre
  una ventana de terminal nueva e independiente con `webgui-proxy.js` ya en
  marcha (mismo patrón que `start-login.bat`: nunca se lanza desde dentro del
  proceso del servidor MCP, que no tiene desktop propio). Puerto por defecto:
  `4728`.
- **Usar**: navegar a `http://localhost:<puerto>/` — redirige automáticamente
  a WebGUI con el mandante ya puesto y, si se indicó, la transacción inicial
  (`~transaction=`). El login es transparente (Basic Auth inyectado por el
  proxy en cada petición), no aparece ninguna pantalla de logon.
- **Rollback**: cerrar la ventana del proxy (o Ctrl+C), o ejecutar
  `keeper/stop-webgui.bat [puerto]` si la ventana se cerró de forma sucia. El
  proxy no escribe nada en disco ni deja perfil de navegador ni toca
  `/etc/hosts` — pararlo deja el sistema exactamente como estaba antes.
- **Qué sí ve el agente**: únicamente `localhost:<puerto>` y las rutas/paths
  de WebGUI — nunca el host real, ni el usuario, ni la contraseña. El
  redirect de `/` y la reescritura de `Location` en los redirects del
  backend son siempre relativos al host real (`webgui-proxy.js` los
  reescribe a `localhost`).
- **Limitación conocida**: el proxy reescribe la cabecera `Location` de los
  redirects, pero no reescribe URLs absolutas que puedan venir *dentro* del
  cuerpo HTML/JS de la propia página (poco habitual en WebGUI clásico, que
  usa rutas relativas, pero no está descartado en todos los sistemas/temas).
  Si esto llega a pasar, el agente vería el host real al leer el contenido
  de la página con `read_page`/`get_page_text`.
- **Prioridad de herramientas al operar WebGUI**: ver la sección
  "Automatización de navegador/PC" de `CLAUDE.md` — primero texto
  estructurado (`read_page`/`find`/`get_page_text`), luego `screenshot`
  acotado a la pestaña; el control total del PC/escritorio queda excluido
  por defecto.

## Notas y limitaciones conocidas

- **Aviso automático de caducidad de usuario**: la primera vez que se resuelve
  cada alias en el día, `getConnection()` (`lib/connection.js`) consulta
  `USR02` para el usuario configurado en Keeper de esa conexión; si caduca en
  ≤30 días (o ya caducó), un middleware instalado en `index.js`
  (`installExpiryNoticeMiddleware`) antepone el aviso a la respuesta de
  **cualquier** tool que dispare la comprobación ese día — no hace falta que
  sea `check_connection` ni ninguna tool en concreto. Es best-effort: si la
  consulta falla (p. ej. sin autorización sobre `USR02`), se ignora en
  silencio sin afectar a la tool original. Verificado en vivo contra un
  usuario real con caducidad próxima: el aviso salió correcto y antepuesto a
  la respuesta de una tool no relacionada con usuarios. **Bug corregido**:
  `GLTGB`/`GLTGV` en `00000000` significa "sin fecha fijada" en SAP, no una
  fecha real — al principio esto se interpretaba como una fecha muy en el
  pasado y disparaba un falso "ya caducado" para usuarios que en realidad no
  tienen ninguna caducidad configurada. `parseSapDate()` en
  `lib/connection.js` ahora lo trata como "sin dato" (no genera aviso); lo
  mismo en `get_user_expiration` (`tools/basis.js`), que muestra "sin fecha
  fijada" en vez del `00000000` crudo.
- **Gestión de conexiones vía Keeper** (`keeper/*.py`): el vault moderno de
  Keeper guarda los custom fields como `"<tipo>:<etiqueta>"` (ej.
  `text:host`, no `host`) — `keeper/_common.py` recorta lo de antes del `:`
  al buscar por nombre, así que basta con que la etiqueta visible en el vault
  sea `host`/`client` (sin distinguir mayúsculas), el prefijo de tipo da
  igual. Verificado en vivo contra dos conexiones reales (`Aspa/Hana`,
  `Aspa/Des`).
- La sesión de Keeper Commander la crea `keeper/login.py` (login real,
  interactivo, nunca a través de Claude Code) y caduca según las horas que se
  le pasen; mientras esté viva, `fetch_secret.py`/`list_connections.py` no
  piden nada por consola. Si caduca, cualquier tool que necesite conexión
  devuelve el comando exacto para volver a iniciar sesión.
- `search_abap_objects` está roto en algunos sistemas (error 400
  `ExceptionParameterNotFound: ris_request_type` del lado SAP). Alternativa:
  usar `read_abap_source`/`get_object_transport` conociendo ya el nombre del
  objeto.
- `write_abap_source` puede fallar con `423 ExceptionResourceInvalidLockHandle`
  en sistemas SAP antiguos (visto en un NetWeaver 731 de 2013) por un bug del
  lado servidor en el protocolo de lock/PUT stateful de ADT — no es un bug de
  esta tool. Workaround probado: pegar el código manualmente en SE80.
- `run_abap_report` no funciona con todos los programas ejecutables; algunos
  (p. ej. `RSICC000`, el report detrás de la transacción SICK) devuelven un
  error de esquema ADT (`expected element abapProgram`) porque navegan a una
  pantalla de resultados en vez de solo generar output de texto.
- Las tools de "estado en vivo" (`get_lock_entries`, `get_work_processes`)
  dependen de que el servicio ICF `/sap/bc/soap/rfc` esté activo en el
  sistema de destino.
- `get_where_used` usa el endpoint `usageReferences`, no `whereused` pese a
  que `list_adt_discovery` anuncia ambos por separado con nombres amigables:
  `whereused` devuelve `500 "No service found for ID ."` con cualquier body
  probado. El URI del objeto va como query param (`?uri=`); el body de la
  request no influye en el resultado, solo debe ser un XML válido con el
  content-type correcto. Verificado en vivo contra un sistema real (121
  referencias de una tabla, parseadas correctamente).
- `check_syntax`: al pasar `source_code`, el contenido va en **base64** dentro
  de `chkrun:content` — con texto XML-escapado SAP responde `400
  ExceptionInvalidData` (fallo de deserialización en
  `SADT_CHECK_RUN_OBJECTS`). Además, la rama sin `source_code` comprueba la
  **versión activa** del objeto: si acabas de hacer `write_abap_source` pero
  no has activado, no verá los cambios todavía (compara con `source_code` para
  chequear lo recién guardado).
- Usa `list_adt_discovery` para confirmar, antes de depender de una tool
  concreta, si el servicio ADT que necesita realmente está activo en el
  sistema/release de destino.
- `run_atc_check`: el paso 1 (crear worklist) y el paso 3 (leer resultados)
  están verificados en vivo. El paso 2 (lanzar el run) devuelve `500
  ExceptionInternalServerError` en el sistema de pruebas, probado con 3
  esquemas de body, 2 Content-Type y 2 tipos de objeto distintos — mismo
  error en los 12 casos, lo que descarta un problema de esquema XML del lado
  cliente. Sin dump en ST22 ni entradas en `/sap/bc/adt/atc/checkfailures`
  que lo expliquen; lo más probable es que falte autorización para *ejecutar*
  runs ATC (a diferencia de solo leer resultados/customizing, que sí
  funciona). Pendiente de confirmar con el equipo Basis.
