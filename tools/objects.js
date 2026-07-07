// Tools de código fuente ABAP: leer, escribir, activar y buscar objetos
// (programas, clases, grupos/módulos de función, includes, etc.). Todas
// comparten la misma lógica genérica vía getObjectPath, así que los módulos de
// función (object_type=FUNC) no tienen tools propias, solo su propia rama de
// resolución de ruta en getObjectPath.
import { z } from "zod";
import { connectionParams, getConnection } from "../lib/connection.js";
import { sapFetch, getCsrfToken, lockObject, unlockObject, getObjectTransport, getObjectPath } from "../lib/http.js";

export function registerObjectTools(server) {
  server.tool(
    "read_abap_source",
    "Lee el código fuente de un objeto ABAP (programa, clase, función, tabla, etc.)",
    {
      ...connectionParams,
      object_name: z.string().describe("Nombre del objeto ABAP, ej: ZTEST_REPORT"),
      object_type: z.string().describe("Tipo de objeto: PROG, CLAS, FUGR, FUNC, TABL, VIEW, DTEL, DOMA, INTF, REPS (include)"),
      function_group: z.string().optional().describe("Obligatorio si object_type es FUNC: nombre del grupo de funciones que contiene el módulo, ej: ZFG_TIENDA"),
    },
    async (args) => {
      const { object_name, object_type, function_group } = args;
      try {
        const conn = getConnection(args);
        const path = getObjectPath(object_type, object_name, function_group);
        const res = await sapFetch(conn, `/sap/bc/adt/${path}/source/main`);
        const source = await res.text();
        return {
          content: [{ type: "text", text: source }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "write_abap_source",
    "Escribe o actualiza el código fuente de un objeto ABAP existente. El objeto debe existir previamente.",
    {
      ...connectionParams,
      object_name: z.string().describe("Nombre del objeto ABAP"),
      object_type: z.string().describe("Tipo de objeto: PROG, CLAS, FUGR, FUNC, INTF, REPS (include)"),
      source_code: z.string().describe("Código fuente ABAP completo. Para FUNC, incluye tanto el cuerpo como la interfaz (IMPORTING/EXPORTING/CHANGING/TABLES/EXCEPTIONS) en el propio texto, tal como los devuelve read_abap_source."),
      function_group: z.string().optional().describe("Obligatorio si object_type es FUNC: nombre del grupo de funciones que contiene el módulo"),
      transport_request: z.string().optional().describe("Número de orden de transporte (corrNr). Necesario si el objeto no es un objeto local ($TMP)."),
    },
    async (args) => {
      const { object_name, object_type, source_code, function_group } = args;
      let { transport_request } = args;
      const conn = getConnection(args);
      const objectPath = getObjectPath(object_type, object_name, function_group);
      // Los módulos de función, a diferencia de otros objetos, no se bloquean en su
      // URI base sino en su propio recurso de código fuente (source/main).
      const lockPath = object_type.toUpperCase() === "FUNC" ? `${objectPath}/source/main` : objectPath;
      let lockHandle, sessionCookie, csrfToken;
      let autoDetectedTransport = null;

      try {
        const { token, cookie } = await getCsrfToken(conn);
        csrfToken = token;

        // Si no se indicó orden de transporte, comprobamos si el objeto ya
        // está asignado a una y la reutilizamos en vez de dejar que SAP falle
        // pidiendo una orden o abra una nueva sin necesidad.
        if (!transport_request) {
          try {
            const { assignedTransport } = await getObjectTransport(conn, `/sap/bc/adt/${objectPath}`, csrfToken, cookie);
            if (assignedTransport) {
              transport_request = assignedTransport;
              autoDetectedTransport = assignedTransport;
            }
          } catch {
            // Si la comprobación falla (p.ej. objeto local $TMP), seguimos sin orden.
          }
        }

        ({ lockHandle, cookie: sessionCookie } = await lockObject(conn, lockPath, csrfToken, cookie));

        let putUrl = `/sap/bc/adt/${objectPath}/source/main?lockHandle=${encodeURIComponent(lockHandle)}`;
        if (transport_request) {
          putUrl += `&corrNr=${encodeURIComponent(transport_request)}`;
        }

        await sapFetch(conn, putUrl, {
          method: "PUT",
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "X-CSRF-Token": csrfToken,
            ...(sessionCookie ? { Cookie: sessionCookie } : {}),
          },
          body: source_code,
        });

        const transportNote = autoDetectedTransport
          ? ` (usando orden de transporte detectada automáticamente: ${autoDetectedTransport})`
          : "";
        return {
          content: [{ type: "text", text: `✅ Código fuente de ${object_name} actualizado correctamente.${transportNote}` }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
      } finally {
        if (lockHandle) {
          await unlockObject(conn, lockPath, lockHandle, csrfToken, sessionCookie).catch(() => {});
        }
      }
    }
  );

  server.tool(
    "get_object_transport",
    "Comprueba si un objeto ABAP ya está asignado a una orden de transporte (p.ej. porque quedó a medio modificar) y lista otras órdenes abiertas candidatas. Útil para ejecutar antes de write_abap_source y así reutilizar la orden correcta.",
    {
      ...connectionParams,
      object_name: z.string().describe("Nombre del objeto ABAP"),
      object_type: z.string().describe("Tipo de objeto: PROG, CLAS, FUGR, FUNC, TABL, VIEW, DTEL, DOMA, INTF, REPS (include)"),
      function_group: z.string().optional().describe("Obligatorio si object_type es FUNC: nombre del grupo de funciones que contiene el módulo"),
    },
    async (args) => {
      const { object_name, object_type, function_group } = args;
      try {
        const conn = getConnection(args);
        const objectUri = `/sap/bc/adt/${getObjectPath(object_type, object_name, function_group)}`;

        const { token: csrfToken, cookie } = await getCsrfToken(conn);
        const { assignedTransport, candidateTransports } = await getObjectTransport(conn, objectUri, csrfToken, cookie);

        const lines = [];
        if (assignedTransport) {
          lines.push(`🔒 El objeto ${object_name} ya está asignado a la orden de transporte: ${assignedTransport}`);
        } else {
          lines.push(`El objeto ${object_name} no está asignado actualmente a ninguna orden de transporte.`);
        }

        if (candidateTransports.length > 0) {
          lines.push("");
          lines.push("Órdenes abiertas candidatas disponibles:");
          for (const t of candidateTransports) {
            lines.push(`  - ${t.trkorr}${t.desc ? ` | ${t.desc}` : ""}`);
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "activate_object",
    "Activa un objeto ABAP en el sistema SAP",
    {
      ...connectionParams,
      object_name: z.string().describe("Nombre del objeto ABAP"),
      object_type: z.string().describe("Tipo de objeto: PROG, CLAS, FUGR, FUNC, INTF, TABL, VIEW, DTEL, DOMA, REPS (include)"),
      function_group: z.string().optional().describe("Obligatorio si object_type es FUNC: nombre del grupo de funciones que contiene el módulo"),
    },
    async (args) => {
      const { object_name, object_type, function_group } = args;
      try {
        const conn = getConnection(args);
        const { token: csrfToken, cookie } = await getCsrfToken(conn);

        // El URI del objeto que queremos activar
        const objectUri = `/sap/bc/adt/${getObjectPath(object_type, object_name, function_group)}`;

        // Payload XML requerido por el endpoint de activación ADT
        const xmlBody = `<?xml version="1.0" encoding="utf-8"?>
<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">
  <adtcore:objectReference adtcore:uri="${objectUri}" adtcore:name="${object_name.toUpperCase()}"/>
</adtcore:objectReferences>`;

        const res = await sapFetch(conn, "/sap/bc/adt/activation?method=activate&preauditRequested=true", {
          method: "POST",
          headers: {
            "Content-Type": "application/vnd.sap.adt.activation.request+xml; charset=utf-8",
            "X-CSRF-Token": csrfToken,
            Accept: "application/xml",
            ...(cookie ? { Cookie: cookie } : {}),
          },
          body: xmlBody,
        });

        const responseText = await res.text();

        // Si la respuesta contiene errores de sintaxis SAP los parsea
        if (responseText.includes("ERROR") || responseText.includes("error")) {
          return {
            content: [{ type: "text", text: `⚠️ Activación con advertencias:\n${responseText}` }],
          };
        }

        return {
          content: [{ type: "text", text: `✅ Objeto ${object_name} activado correctamente.` }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "search_abap_objects",
    "Busca objetos ABAP en el sistema por nombre o patrón (admite * como wildcard)",
    {
      ...connectionParams,
      query: z.string().describe("Nombre o patrón a buscar, ej: ZTEST* o *MATERIAL*"),
      object_type: z.string().optional().describe("Filtrar por tipo: PROG, CLAS, FUGR, TABL, VIEW, etc. Si no se indica, busca en todos."),
      max_results: z.number().optional().default(20).describe("Número máximo de resultados (default: 20)"),
    },
    async (args) => {
      const { query, object_type, max_results } = args;
      try {
        const conn = getConnection(args);
        let url = `/sap/bc/adt/repository/informationsystem/search?searchTerm=${encodeURIComponent(query)}&maxResults=${max_results}`;
        if (object_type) {
          url += `&objectType=${object_type.toUpperCase()}`;
        }

        const res = await sapFetch(conn, url, {
          headers: { Accept: "application/xml" },
        });
        const xmlText = await res.text();

        // Extrae los nombres de los objetos del XML de respuesta con regex simple
        const matches = [...xmlText.matchAll(/adtcore:name="([^"]+)"/g)];
        const typeMatches = [...xmlText.matchAll(/adtcore:type="([^"]+)"/g)];
        const descMatches = [...xmlText.matchAll(/adtcore:description="([^"]+)"/g)];

        if (matches.length === 0) {
          return { content: [{ type: "text", text: `No se encontraron objetos con el patrón: ${query}` }] };
        }

        const results = matches.map((m, i) => {
          const name = m[1];
          const type = typeMatches[i]?.[1] || "?";
          const desc = descMatches[i]?.[1] || "";
          return `${type.padEnd(6)} | ${name.padEnd(40)} | ${desc}`;
        });

        const header = `${"TIPO".padEnd(6)} | ${"NOMBRE".padEnd(40)} | DESCRIPCIÓN\n${"-".repeat(80)}`;
        return {
          content: [{ type: "text", text: `${header}\n${results.join("\n")}` }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
      }
    }
  );
}
