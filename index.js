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

const server = new McpServer({
  name: "sap-abap-mcp",
  version: "1.0.0",
});

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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🚀 SAP ABAP MCP Server arrancado y escuchando...");
}

main().catch((err) => {
  console.error("Error fatal:", err);
  process.exit(1);
});
