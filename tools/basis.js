// Tools de "basis"/sistema: especificaciones del sistema y dumps ABAP (ST22).
import { z } from "zod";
import { connectionParams, getConnection } from "../lib/connection.js";
import { sapFetch } from "../lib/http.js";
import { buildQueryString, formatAdtTimestamp, extractTagBlocks, extractChildTagValuesNS } from "../lib/xml.js";
import { runSqlQuery, getSystemId } from "../lib/sql.js";

// Lógica reutilizable de get_st22_dumps, para que otras tools (p.ej. el
// agregador de monitoreo diario) puedan pedir los mismos datos sin duplicar
// la llamada al feed Atom de dumps.
export async function fetchSt22Dumps(conn, { date_from, date_to, user, max_results = 50 } = {}) {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const dateFrom = date_from || formatAdtTimestamp(weekAgo);
  const dateTo = date_to || formatAdtTimestamp(now);

  const url = `/sap/bc/adt/runtime/dumps${buildQueryString({ dateFrom, dateTo, user })}`;
  const res = await sapFetch(conn, url, { headers: { Accept: "application/atom+xml;type=feed" } });
  const xml = await res.text();

  const entries = extractTagBlocks(xml, "entry");
  const dumps = entries.map((b) => ({ ...b.attrs, ...extractChildTagValuesNS(b.inner) }));

  return { dumps: dumps.slice(0, max_results), totalCount: dumps.length, dateFrom, dateTo, xml };
}

export function registerBasisTools(server) {
  server.tool(
    "get_system_specs",
    "Obtiene las especificaciones del sistema SAP conectado: SID, mandante, y el release de SAP_BASIS/ABAP y demás componentes instalados (vía tabla CVERS). Útil para saber contra qué versión de ABAP/SAP se está desarrollando antes de generar código (p.ej. sintaxis nueva solo disponible desde cierto release).",
    { ...connectionParams },
    async (args) => {
      try {
        const conn = await getConnection(args);
        const sid = await getSystemId(conn);

        const components = await runSqlQuery(
          conn,
          "SELECT COMPONENT,RELEASE,EXTRELEASE FROM CVERS",
          100
        );

        const basis = components.find((c) => c.COMPONENT === "SAP_BASIS");

        const lines = [
          `🖥️  Host: ${conn.host}`,
          `🏷️  Sistema (SID): ${sid}`,
          `📦  Mandante: ${conn.client}`,
          `👤  Usuario: ${conn.user}`,
          "",
        ];

        if (basis) {
          lines.push(`⚙️  Release SAP_BASIS (ABAP): ${basis.RELEASE} ${basis.EXTRELEASE || ""}`.trim());
          lines.push("");
        }

        lines.push("Componentes instalados (tabla CVERS):");
        lines.push(`${"COMPONENT".padEnd(20)} | ${"RELEASE".padEnd(10)} | EXTRELEASE`);
        lines.push("-".repeat(50));
        for (const c of components) {
          lines.push(`${(c.COMPONENT || "").padEnd(20)} | ${(c.RELEASE || "").padEnd(10)} | ${c.EXTRELEASE || ""}`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_user_expiration",
    "Consulta la fecha de caducidad de un usuario SAP (y su fecha de validez desde), equivalente a los campos 'Válido hasta'/'Válido desde' de la pestaña Datos de logon de SU01 (tabla USR02). Útil para saber si una cuenta sigue activa o cuándo dejará de estarlo.",
    {
      ...connectionParams,
      username: z.string().describe("Nombre de usuario SAP a consultar, ej: J.GARCIA"),
    },
    async (args) => {
      const { username } = args;
      try {
        const conn = await getConnection(args);
        const safeUser = username.toUpperCase().replace(/'/g, "''");
        const rows = await runSqlQuery(
          conn,
          `SELECT BNAME, USTYP, GLTGV, GLTGB FROM USR02 WHERE BNAME = '${safeUser}'`,
          1
        );

        if (rows.length === 0) {
          return { content: [{ type: "text", text: `No existe el usuario "${username}" en este sistema.` }] };
        }

        const { BNAME, USTYP, GLTGV, GLTGB } = rows[0];
        // GLTGB = 99991231 es el centinela estándar de SAP para "sin caducidad".
        const noExpiry = (GLTGB || "").replace(/\D/g, "") === "99991231";

        const lines = [
          `👤 Usuario: ${BNAME}`,
          `🏷️  Tipo: ${USTYP || "(desconocido)"}`,
          `📅 Válido desde: ${GLTGV || "(sin dato)"}`,
          `📅 Válido hasta: ${noExpiry ? `sin caducidad (${GLTGB})` : (GLTGB || "(sin dato)")}`,
        ];

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_st22_dumps",
    "Lista los dumps de ABAP (errores en tiempo de ejecución, equivalente a la transacción ST22) ocurridos en el sistema dentro de un rango de fechas, para poder analizarlos. Usa get_st22_dump_detail sobre el 'uri' de un dump concreto para ver su call stack y texto completo.",
    {
      ...connectionParams,
      date_from: z.string().optional().describe("Fecha/hora inicial en formato YYYYMMDDHHMMSS. Si no se indica, se usan los últimos 7 días."),
      date_to: z.string().optional().describe("Fecha/hora final en formato YYYYMMDDHHMMSS. Si no se indica, se usa el momento actual."),
      user: z.string().optional().describe("Filtra por el usuario que provocó el dump (opcional)"),
      max_results: z.number().optional().default(50).describe("Número máximo de dumps a mostrar (default: 50)"),
    },
    async (args) => {
      const { user, max_results } = args;
      try {
        const conn = await getConnection(args);
        // El servicio devuelve un feed Atom (<feed><entry>...>). Por cada <entry> se
        // extraen tanto sus atributos (adtcore:*, etc.) como cualquier elemento hijo
        // con valor de texto (Uri, Timestamp, User, Program...), sin asumir un
        // esquema fijo, porque este endpoint no está documentado oficialmente.
        const { dumps, totalCount, dateFrom, dateTo, xml } = await fetchSt22Dumps(conn, {
          date_from: args.date_from, date_to: args.date_to, user, max_results,
        });

        if (totalCount === 0) {
          return {
            content: [{
              type: "text",
              text: `No se encontraron dumps entre ${dateFrom} y ${dateTo}${user ? ` para el usuario ${user}` : ""}.\n\nRespuesta cruda de SAP (por si el parseo no encontró el formato esperado):\n${xml.slice(0, 2000)}`,
            }],
          };
        }

        const lines = dumps.map((d, i) => {
          const fields = Object.entries(d).map(([k, v]) => `${k}=${v}`).join(" | ");
          return `${i + 1}. ${fields}`;
        });

        return {
          content: [{
            type: "text",
            text: `Dumps encontrados: ${totalCount} (mostrando ${dumps.length}) entre ${dateFrom} y ${dateTo}\n\n${lines.join("\n")}\n\n--- XML crudo (primeras 2000 chars, para verificar el parseo) ---\n${xml.slice(0, 2000)}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_st22_dump_detail",
    "Obtiene el detalle completo (texto del dump, call stack, contexto) de un dump ABAP concreto, a partir del campo 'uri' devuelto por get_st22_dumps.",
    {
      ...connectionParams,
      dump_uri: z.string().describe("URI del dump devuelto por get_st22_dumps (campo 'uri'), ej: /sap/bc/adt/runtime/dumps/<id>"),
    },
    async (args) => {
      const { dump_uri } = args;
      try {
        const conn = await getConnection(args);
        const path = dump_uri.startsWith("/sap/bc/adt") ? dump_uri : `/sap/bc/adt/runtime/dumps/${dump_uri}`;
        const res = await sapFetch(conn, path, { headers: { Accept: "application/xml, text/plain, */*" } });
        const text = await res.text();
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
      }
    }
  );
}
