// Tools de monitorización de estado "en vivo" (memoria/kernel) que no se
// pueden leer de una tabla: bloqueos de enqueue (SM12) y procesos de trabajo
// (SM50/SM66). Usan el gateway SOAP RFC estándar de SAP (/sap/bc/soap/rfc)
// para invocar módulos de función RFC-habilitados ya existentes en el
// sistema (ENQUE_READ2, TH_WPINFO) — sin ningún desarrollo ABAP nuevo.
import { z } from "zod";
import { connectionParams, getConnection } from "../lib/connection.js";
import { callRfcFunction } from "../lib/rfc.js";

function formatRows(rows) {
  if (rows.length === 0) return "(sin resultados)";
  const columns = Object.keys(rows[0]);
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const header = columns.map((c, i) => c.padEnd(widths[i])).join(" | ");
  const sep = widths.map((w) => "-".repeat(w)).join("-|-");
  const body = rows.map((r) => columns.map((c, i) => String(r[c] ?? "").padEnd(widths[i])).join(" | ")).join("\n");
  return `${header}\n${sep}\n${body}`;
}

// Funciones fetch* reutilizables: mismo cuerpo que ya usaba cada tool, solo
// movido a una función con nombre para que otras tools (p.ej. el agregador
// de monitoreo diario) puedan pedir los mismos datos sin duplicar la llamada RFC.
export async function fetchLockEntries(conn, { gname, garg, user } = {}) {
  const { scalars, tables } = await callRfcFunction(
    conn,
    "ENQUE_READ2",
    { GCLIENT: conn.client, GNAME: gname || "", GARG: garg || "", GUNAME: user || "*" },
    ["ENQ"]
  );
  if (scalars.SUBRC && scalars.SUBRC !== "0") {
    throw new Error(`ENQUE_READ2 devolvió SUBRC=${scalars.SUBRC}`);
  }
  return tables.ENQ.map((r) => ({
    GNAME: r.GNAME, GARG: r.GARG, GMODE: r.GMODE, GUNAME: r.GUNAME, GOBJ: r.GOBJ, GTCODE: r.GTCODE,
  }));
}

export async function fetchWorkProcesses(conn) {
  const { tables } = await callRfcFunction(conn, "TH_WPINFO", {}, ["WPLIST"]);
  return tables.WPLIST.map((r) => ({
    WP_NO: r.WP_NO, WP_TYP: r.WP_TYP, WP_STATUS: r.WP_STATUS, WP_BNAME: r.WP_BNAME, WP_REPORT: r.WP_REPORT, WP_ELTIME: r.WP_ELTIME,
  }));
}

export function registerBasisLiveTools(server) {
  server.tool(
    "get_lock_entries",
    "Lista las entradas de bloqueo (enqueue) activas en el sistema, equivalente a la transacción SM12. Usa el módulo de función estándar ENQUE_READ2 vía el gateway RFC.",
    {
      ...connectionParams,
      gname: z.string().optional().describe("Filtra por nombre de objeto de bloqueo (GNAME), ej: E_MARA. Vacío = todos."),
      garg: z.string().optional().describe("Filtra por argumento de bloqueo (GARG, normalmente contiene la clave del registro). Vacío = todos."),
      user: z.string().optional().describe("Filtra por usuario propietario del bloqueo. Por defecto '*' (todos los usuarios)."),
    },
    async (args) => {
      const { gname, garg, user } = args;
      try {
        const conn = getConnection(args);
        const rows = await fetchLockEntries(conn, { gname, garg, user });
        return { content: [{ type: "text", text: formatRows(rows) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_work_processes",
    "Lista los procesos de trabajo del servidor de aplicación (equivalente a SM50/SM66), vía el módulo de función estándar TH_WPINFO. Nota: TH_WPINFO tiene un chequeo de autorización interno (objeto ligado a SM50) para llamadas RFC externas; si el usuario de la conexión no tiene esa autorización, la respuesta vendrá vacía en vez de dar un error.",
    { ...connectionParams },
    async (args) => {
      try {
        const conn = getConnection(args);
        const rows = await fetchWorkProcesses(conn);
        if (rows.length === 0) {
          return {
            content: [{
              type: "text",
              text: "(sin resultados) — si esperabas ver procesos activos, es posible que el usuario de esta conexión no tenga autorización SM50 para llamadas RFC externas a TH_WPINFO (el propio módulo estándar corta la respuesta en ese caso, no es un fallo de esta tool).",
            }],
          };
        }
        return { content: [{ type: "text", text: formatRows(rows) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
      }
    }
  );
}
