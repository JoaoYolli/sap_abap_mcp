// Tools generales: listar conexiones configuradas, comprobar que una conexión
// concreta está viva, y descubrir qué servicios ADT están realmente activos
// en el sistema (vía el documento de descubrimiento estándar de ADT).
import { z } from "zod";
import { connectionParams, getConnection, listConnectionAliases } from "../lib/connection.js";
import { sapFetch } from "../lib/http.js";
import { getSystemId } from "../lib/sql.js";
import { extractTagBlocks, extractChildTagValuesNS } from "../lib/xml.js";

export function registerGeneralTools(server) {
  server.tool(
    "list_connections",
    `Lista los alias de conexión SAP disponibles, descubiertos automáticamente en la carpeta "Claude Connections" del vault de Keeper (y sus subcarpetas, una por empresa/servidor). No expone host, usuario, mandante ni contraseña: esos datos se resuelven internamente en el servidor MCP a partir del alias, nunca hace falta conocerlos para usar las demás tools.`,
    {},
    async () => {
      try {
        const aliases = listConnectionAliases();
        if (aliases.length === 0) {
          return { content: [{ type: "text", text: "No hay ninguna conexión en la carpeta \"Claude Connections\" de Keeper todavía." }] };
        }
        const lines = aliases.map(({ alias, ambiguous }) => `- ${alias}${ambiguous ? "  ⚠️ ambiguo: varios registros coinciden con este alias" : ""}`);
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
        const conn = await getConnection(args);
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

  server.tool(
    "list_adt_discovery",
    "Lista los servicios ADT (ABAP Development Tools) que están realmente activos en el sistema conectado, a partir del documento de descubrimiento estándar (/sap/bc/adt/discovery — el mismo que usa Eclipse ADT para saber qué puede ofrecer cada sistema). Útil para confirmar si un servicio concreto (checkruns, prettyprinter, usedby, atc, abapunit, cts...) existe en ese release/sistema antes de asumir que una tool lo va a poder usar.",
    {
      ...connectionParams,
      filter: z.string().optional().describe("Filtra los servicios cuyo workspace, título, tipo o href contengan este texto (sin distinguir mayúsculas/minúsculas), ej: 'atc', 'checkrun', 'usedby', 'prettyprinter', 'abapunit'. Si no se indica, se listan todos."),
    },
    async (args) => {
      const { filter } = args;
      try {
        const conn = await getConnection(args);
        const res = await sapFetch(conn, "/sap/bc/adt/discovery", {
          headers: { Accept: "application/atomsvc+xml" },
        });
        const xml = await res.text();

        // El discovery es un documento AtomPub estándar (app:service > app:workspace >
        // app:collection), no algo propietario sin documentar como el feed de dumps de
        // ST22: cada workspace agrupa colecciones (servicios), y cada collection trae su
        // href, título y tipo adtcore:type.
        const services = [];
        for (const ws of extractTagBlocks(xml, "workspace")) {
          const wsTitle = extractChildTagValuesNS(ws.inner).title || "(workspace sin título)";
          for (const c of extractTagBlocks(ws.inner, "collection")) {
            const values = extractChildTagValuesNS(c.inner);
            services.push({
              workspace: wsTitle,
              href: c.attrs.href || "",
              title: values.title || "",
              type: values.type || "",
            });
          }
        }

        const filtered = filter
          ? services.filter((s) => [s.workspace, s.href, s.title, s.type].some((v) => v.toLowerCase().includes(filter.toLowerCase())))
          : services;

        if (filtered.length === 0) {
          return {
            content: [{
              type: "text",
              text: `No se encontraron servicios ADT${filter ? ` que coincidan con "${filter}"` : ""}. Total de servicios en el discovery: ${services.length}.\n\n--- XML crudo (primeras 1500 chars, por si el parseo no encontró el formato esperado) ---\n${xml.slice(0, 1500)}`,
            }],
          };
        }

        const lines = filtered.map((s) => `[${s.workspace}] ${s.title || "(sin título)"}${s.type ? ` (${s.type})` : ""} -> ${s.href}`);
        return {
          content: [{
            type: "text",
            text: `Servicios ADT activos: ${filtered.length}${filter ? ` (de ${services.length} totales, filtrados por "${filter}")` : ""}\n\n${lines.join("\n")}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
      }
    }
  );
}
