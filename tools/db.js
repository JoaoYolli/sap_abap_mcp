// Tools de acceso a datos: lectura de tablas SAP vía el servicio SQL Console
// de ADT, y metadata DDIC (campos/tipos/claves) vía RFC estándar.
import { z } from "zod";
import { connectionParams, getConnection } from "../lib/connection.js";
import { sapFetch, getCsrfToken } from "../lib/http.js";
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

export function registerDbTools(server) {
  server.tool(
    "read_table_data",
    "Lee registros de una tabla SAP usando el servicio de queries ADT (solo para tablas con pocos registros o con filtro WHERE)",
    {
      ...connectionParams,
      table_name: z.string().describe("Nombre de la tabla SAP, ej: MARA, T001, USR02"),
      fields: z.string().optional().describe("Campos a leer separados por coma, ej: MATNR,MTART,MBRSH. Si no se indica, lee todos."),
      where_clause: z.string().optional().describe("Condición WHERE en sintaxis ABAP, ej: MTART EQ 'FERT' AND MBRSH EQ 'M'"),
      max_rows: z.number().optional().default(50).describe("Número máximo de filas (default: 50)"),
    },
    async (args) => {
      const { table_name, fields, where_clause, max_rows } = args;
      try {
        const conn = getConnection(args);
        const { token: csrfToken, cookie } = await getCsrfToken(conn);

        // Servicio "SQL Console" de ADT: recibe una sentencia OpenSQL en texto plano.
        const selectFields = fields ? fields.replace(/\s+/g, "") : "*";
        let sql = `SELECT ${selectFields} FROM ${table_name.toUpperCase()}`;
        if (where_clause) sql += ` WHERE ${where_clause}`;

        const res = await sapFetch(conn, `/sap/bc/adt/datapreview/freestyle?rowNumber=${max_rows}`, {
          method: "POST",
          headers: {
            "Content-Type": "text/plain",
            "X-CSRF-Token": csrfToken,
            Accept: "application/*",
            ...(cookie ? { Cookie: cookie } : {}),
          },
          body: sql,
        });

        const xml = await res.text();
        return { content: [{ type: "text", text: xml }] };
      } catch (err) {
        return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "describe_table_structure",
    "Devuelve la estructura DDIC (campos, tipos, longitud, decimales, clave, tabla de chequeo) de una tabla o estructura, vía el módulo de función estándar DDIF_FIELDINFO_GET. Alternativa vía RFC a la metadata DDIC cuando no se quiere/puede usar el servicio ADT de DDIC.",
    {
      ...connectionParams,
      table_name: z.string().describe("Nombre de la tabla o estructura DDIC, ej: MARA, USR02, ZPOKEMONS"),
      language: z.string().optional().default("EN").describe("Código de idioma (SY-LANGU) para los textos de los campos (default: EN)"),
    },
    async (args) => {
      const { table_name, language } = args;
      try {
        const conn = getConnection(args);
        const { scalars, tables } = await callRfcFunction(
          conn,
          "DDIF_FIELDINFO_GET",
          { TABNAME: table_name.toUpperCase(), LANGU: language || "EN" },
          ["DFIES_TAB"]
        );
        if (scalars.SUBRC && scalars.SUBRC !== "0") {
          return {
            content: [{ type: "text", text: `ERROR: DDIF_FIELDINFO_GET devolvió SUBRC=${scalars.SUBRC} (¿existe la tabla/estructura ${table_name}?)` }],
            isError: true,
          };
        }
        const rows = tables.DFIES_TAB.map((r) => ({
          FIELDNAME: r.FIELDNAME,
          POSITION: r.POSITION,
          KEYFLAG: r.KEYFLAG,
          DATATYPE: r.DATATYPE,
          LENG: r.LENG,
          DECIMALS: r.DECIMALS,
          CHECKTABLE: r.CHECKTABLE,
          ROLLNAME: r.ROLLNAME,
          FIELDTEXT: r.FIELDTEXT,
        }));
        return { content: [{ type: "text", text: formatRows(rows) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
      }
    }
  );
}
