// SAP MCP Server - index.js
// Requiere: npm install @modelcontextprotocol/sdk zod
// En package.json: "type": "module"

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { installExpiryNoticeMiddleware } from "./lib/connection.js";
import { registerGeneralTools } from "./tools/general.js";
import { registerBasisTools } from "./tools/basis.js";
import { registerBasisMonitoringTools } from "./tools/basis-monitoring.js";
import { registerBasisLiveTools } from "./tools/basis-live.js";
import { registerObjectTools } from "./tools/objects.js";
import { registerDbTools } from "./tools/db.js";
import { registerReportTools } from "./tools/reports.js";
import { registerDailyMonitoringTools } from "./tools/daily-monitoring.js";
import { registerAtcTools } from "./tools/atc.js";
import { registerWebguiTools } from "./tools/webgui.js";

const server = new McpServer(
  {
    name: "sap-abap-mcp",
    version: "1.0.0",
  },
  {
    instructions: `
Jerarquía de coste (en tokens y en tiempo) para cualquier tarea sobre este sistema SAP.
Sigue este orden SIEMPRE, sin que el usuario tenga que pedirlo cada vez:

1. Tool ADT/RFC dedicada (cualquier mcp__sap-abap__* que no sea de navegador).
   Es una llamada estructurada: la opción más barata con diferencia. Antes de
   navegar, comprueba si ya existe (revisa la lista de tools, o llama a
   list_adt_discovery si dudas de si el endpoint existe en este release).
   Ejemplos: SM50/SM66 -> get_work_processes; ST22 -> get_st22_dumps;
   SE38 (leer/buscar/ejecutar/chequear sintaxis) -> read_abap_source,
   search_abap_objects, run_abap_report, check_syntax, write_abap_source;
   un dato puntual de un documento de negocio sin tool dedicada (p.ej. una
   entrega VL03N) -> read_table_data/describe_table_structure sobre la tabla
   conocida (LIKP/LIPS, etc.) en vez de navegar, si con eso alcanza.

2. WebGUI vía claude-in-chrome (start_webgui_proxy / get_webgui_proxy_status),
   SOLO si confirmaste que no hay tool ADT para esa tarea concreta (p.ej.
   ST02/DBACOCKPIT, SOST, o revisar visualmente un documento completo).
   Avisa siempre, explícitamente, de que esta vía cuesta muchos más tokens
   que ADT -- no lo des por sobreentendido aunque ya lo hayas dicho antes en
   la misma conversación. Reutiliza el proxy activo entre transacciones
   (navega la pestaña cambiando ~transaction en la URL); no lo relances solo
   para cambiar de pantalla. Dentro del navegador, en este orden: primero
   texto estructurado (get_page_text, read_page, find -- SAP GUI para HTML
   es HTML real, no canvas), y solo si hace falta ver el layout, screenshot
   acotado a la pestaña (nunca a la pantalla completa del sistema).

3. Control total del PC/escritorio (fuera del navegador): excluido por
   defecto. Únicamente si el usuario lo pide explícitamente para ese caso
   concreto.

Login de Keeper caducado/no iniciado: ejecuta tú mismo el comando de
terminal que trae el error, en el mismo turno -- no se lo derives al
usuario salvo que no tengas ninguna herramienta de terminal disponible.

Detalle completo y razonamiento de cada punto en CLAUDE.md de este repo.
`.trim(),
  },
);

// Antes de registrar ninguna tool: engancha el aviso de "usuario a punto de
// caducar" (ver lib/connection.js) a la respuesta de cualquier tool, sin que
// cada tools/*.js tenga que saber nada de esto.
installExpiryNoticeMiddleware(server);

registerGeneralTools(server);
registerBasisTools(server);
registerBasisMonitoringTools(server);
registerBasisLiveTools(server);
registerObjectTools(server);
registerDbTools(server);
registerReportTools(server);
registerDailyMonitoringTools(server);
registerAtcTools(server);
registerWebguiTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🚀 SAP ABAP MCP Server arrancado y escuchando...");
}

main().catch((err) => {
  console.error("Error fatal:", err);
  process.exit(1);
});
