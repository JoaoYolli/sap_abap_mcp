// SAP MCP Server - index.js
// Requiere: npm install @modelcontextprotocol/sdk zod
// En package.json: "type": "module"

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerGeneralTools } from "./tools/general.js";
import { registerBasisTools } from "./tools/basis.js";
import { registerObjectTools } from "./tools/objects.js";
import { registerDbTools } from "./tools/db.js";
import { registerReportTools } from "./tools/reports.js";

const server = new McpServer({
  name: "sap-abap-mcp",
  version: "1.0.0",
});

registerGeneralTools(server);
registerBasisTools(server);
registerObjectTools(server);
registerDbTools(server);
registerReportTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🚀 SAP ABAP MCP Server arrancado y escuchando...");
}

main().catch((err) => {
  console.error("Error fatal:", err);
  process.exit(1);
});
