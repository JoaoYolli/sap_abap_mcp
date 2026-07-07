// Tool de acceso a datos: lectura de tablas SAP vía el servicio SQL Console de ADT.
import { z } from "zod";
import { connectionParams, getConnection } from "../lib/connection.js";
import { sapFetch, getCsrfToken } from "../lib/http.js";

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
}
