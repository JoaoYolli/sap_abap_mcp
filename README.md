# sap-mcp

Servidor MCP (Model Context Protocol) que expone operaciones sobre un sistema
SAP (ABAP/ADT, RFC estándar, Basis) como *tools* para un agente de IA (Claude
Code u otro cliente MCP). No es un cliente SAP GUI ni requiere instalar nada
en el lado SAP: habla directamente con los servicios REST de ADT ya
disponibles en cualquier sistema NetWeaver/S4HANA con Eclipse ADT habilitado,
más el gateway SOAP RFC clásico para un par de tools que necesitan datos en
memoria del kernel.

## Instalación

```bash
npm install
```

Requiere Node.js 18+ (usa `fetch` global y ES modules — `"type": "module"` en
`package.json`).

## Configurar conexiones SAP

Las credenciales **nunca** viajan por el chat ni como argumentos de las
tools. Viven en un archivo local, fuera del repo:

```
%USERPROFILE%\.sap-mcp\connections.json      (Windows)
~/.sap-mcp/connections.json                  (Linux/Mac)
```

La primera vez que se usa cualquier tool sin este archivo, el servidor lo
crea automáticamente con una plantilla vacía y lanza un error pidiendo
rellenarlo:

```json
{
  "dev": { "host": "http://mihost:8000", "client": "100", "user": "usuario", "password": "clave" },
  "prod": { "host": "https://otrohost:443", "client": "300", "user": "usuario", "password": "clave" }
}
```

Cada clave del objeto (`dev`, `prod`, `aspa_hana`, ...) es un **alias de
conexión** que luego se pasa como parámetro `connection` a cualquier tool.
Usa la tool `list_connections` para ver qué alias hay configurados sin
exponer host/usuario/contraseña.

## Arrancar el servidor

El servidor habla el protocolo MCP por stdio (pensado para ser lanzado por un
cliente MCP, no para ejecutarse suelto en una terminal):

```bash
node index.js
```

Para usarlo desde Claude Code (u otro cliente MCP), regístralo apuntando a
`index.js` con Node como comando, según la configuración de servidores MCP de
tu cliente.

## Estructura del proyecto

```
index.js                   Arranque: crea el McpServer y registra cada módulo de tools
lib/
  connection.js             Resolución de alias -> credenciales (connections.json)
  http.js                   fetch autenticado a ADT, CSRF, lock/unlock, resolución de rutas de objetos
  xml.js                    Parseo XML con regex (sin dependencias) + escapeXml
  sql.js                    Ejecuta OpenSQL vía el servicio ADT "SQL Console" (datapreview/freestyle)
  rfc.js                    Cliente mínimo del gateway SOAP RFC clásico (/sap/bc/soap/rfc)
tools/
  general.js                Conexión: listar alias, comprobar conectividad
  basis.js                  Sistema: specs, dumps ST22
  basis-monitoring.js        Monitorización Basis vía tablas estándar (SM37, SM58, SM13/14, SOST/SOIN, gateway log, SM59)
  basis-live.js              Monitorización Basis vía RFC en vivo (SM12, SM50/SM66)
  objects.js                Código fuente ABAP: leer, escribir, activar, buscar
  db.js                     Lectura genérica de tablas
  reports.js                Ejecutar programas/reports ABAP
```

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
| `list_connections` | Lista los alias de conexión configurados (sin credenciales). |
| `check_connection` | Comprueba que una conexión está viva y devuelve SID/host/usuario/mandante. |

### Sistema

| Tool | Descripción |
|---|---|
| `get_system_specs` | SID, mandante, release de SAP_BASIS/ABAP y componentes instalados (tabla `CVERS`). |
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

### Datos y ejecución

| Tool | Descripción |
|---|---|
| `read_table_data` | `SELECT {fields} FROM {table} [WHERE ...]` genérico vía el SQL Console de ADT. |
| `run_abap_report` | Ejecuta un programa/report sin pantalla de selección y devuelve su salida. |

## Notas y limitaciones conocidas

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
