// Tools generales: listar conexiones configuradas y comprobar que una conexión
// concreta está viva.
import { connectionParams, getConnection, loadConnectionsConfig, CONFIG_PATH } from "../lib/connection.js";
import { sapFetch } from "../lib/http.js";
import { getSystemId } from "../lib/sql.js";

export function registerGeneralTools(server) {
  server.tool(
    "list_connections",
    `Lista únicamente los alias de conexión SAP disponibles (definidos en ${CONFIG_PATH}). No expone host, usuario, mandante ni contraseña: esos datos se resuelven internamente en el servidor MCP a partir del alias, nunca hace falta conocerlos para usar las demás tools.`,
    {},
    async () => {
      try {
        const config = loadConnectionsConfig();
        const aliases = Object.keys(config);
        if (aliases.length === 0) {
          return { content: [{ type: "text", text: "No hay ninguna conexión configurada todavía." }] };
        }
        const lines = aliases.map((alias) => `- ${alias}`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "check_connection",
    "Comprueba que la conexión con el sistema SAP está activa y devuelve información del sistema",
    { ...connectionParams },
    async (args) => {
      try {
        const conn = getConnection(args);
        await sapFetch(conn, "/sap/bc/adt/discovery", {
          headers: { Accept: "application/atomsvc+xml" },
        });
        const sid = await getSystemId(conn);

        return {
          content: [{
            type: "text",
            text: `✅ Conexión OK\n🖥️  Host: ${conn.host}\n🏷️  Sistema: ${sid}\n👤  Usuario: ${conn.user}\n📦  Mandante: ${conn.client}`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `❌ Error de conexión: ${err.message}` }],
          isError: true,
        };
      }
    }
  );
}
