// Tool de ejecución de programas/reports ABAP.
import { z } from "zod";
import { connectionParams, getConnection } from "../lib/connection.js";
import { sapFetch, getCsrfToken } from "../lib/http.js";

export function registerReportTools(server) {
  server.tool(
    "run_abap_report",
    "Ejecuta un programa/report ABAP en background y devuelve el resultado (solo programas sin pantalla de selección o con parámetros predefinidos)",
    {
      ...connectionParams,
      program_name: z.string().describe("Nombre del programa ABAP a ejecutar, ej: ZTEST_REPORT"),
    },
    async (args) => {
      const { program_name } = args;
      try {
        const conn = getConnection(args);
        const { token: csrfToken, cookie } = await getCsrfToken(conn);

        const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">
  <adtcore:objectReference adtcore:uri="/sap/bc/adt/programs/programs/${program_name.toLowerCase()}" adtcore:name="${program_name.toUpperCase()}"/>
</adtcore:objectReferences>`;

        const res = await sapFetch(conn, "/sap/bc/adt/programs/programs/execute", {
          method: "POST",
          headers: {
            "Content-Type": "application/xml",
            "X-CSRF-Token": csrfToken,
            Accept: "text/plain, application/xml",
            ...(cookie ? { Cookie: cookie } : {}),
          },
          body: xmlBody,
        });

        const output = await res.text();
        return {
          content: [{ type: "text", text: output || `✅ Programa ${program_name} ejecutado (sin output de texto).` }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
      }
    }
  );
}
