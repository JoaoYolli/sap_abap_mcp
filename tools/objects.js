// Tools de código fuente ABAP: leer, escribir, activar y buscar objetos
// (programas, clases, grupos/módulos de función, includes, etc.). Todas
// comparten la misma lógica genérica vía getObjectPath, así que los módulos de
// función (object_type=FUNC) no tienen tools propias, solo su propia rama de
// resolución de ruta en getObjectPath.
import { z } from "zod";
import { connectionParams, getConnection } from "../lib/connection.js";
import { sapFetch, getCsrfToken, lockObject, unlockObject, getObjectTransport, getObjectPath } from "../lib/http.js";
import { extractTagBlocks, extractChildTagValuesNS, parseXmlAttrs } from "../lib/xml.js";

// --- Lógica reutilizable de las tools de abajo ---

// Pretty Printer estándar de ADT (endpoint confirmado vía list_adt_discovery:
// /sap/bc/adt/abapsource/prettyprinter). No toca ningún objeto: solo formatea
// el texto que se le pasa, según las reglas de indentado estándar de ABAP.
export async function formatAbapSource(conn, sourceCode) {
  const { token: csrfToken, cookie } = await getCsrfToken(conn);
  const res = await sapFetch(conn, "/sap/bc/adt/abapsource/prettyprinter", {
    method: "POST",
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      Accept: "text/plain",
      "X-CSRF-Token": csrfToken,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: sourceCode,
  });
  return res.text();
}

// Chequeo de sintaxis estándar de ADT (/sap/bc/adt/checkruns), verificado en
// vivo contra un sistema real. Si se pasa sourceCode, chequea ese texto sin
// guardarlo (version="inactive"); si no, chequea la versión activa ya
// guardada del objeto. Detalle no obvio: chkrun:content debe ir en base64,
// no como texto XML-escapado — con texto escapado SAP responde 400
// ExceptionInvalidData ("error deserializando en SADT_CHECK_RUN_OBJECTS").
// Se deja igualmente el XML crudo en la respuesta si no se detecta ningún
// checkMessage, por si algún release futuro cambia el esquema.
export async function checkAbapSyntax(conn, { objectUri, sourceCode }) {
  const { token: csrfToken, cookie } = await getCsrfToken(conn);
  const mainUrl = `${objectUri}/source/main`;

  const body = sourceCode
    ? `<?xml version="1.0" encoding="UTF-8"?>
<chkrun:checkObjectList xmlns:chkrun="http://www.sap.com/adt/checkrun" xmlns:adtcore="http://www.sap.com/adt/core">
  <chkrun:checkObject adtcore:uri="${mainUrl}" chkrun:version="inactive">
    <chkrun:artifacts>
      <chkrun:artifact chkrun:contentType="text/plain; charset=utf-8" chkrun:uri="${mainUrl}">
        <chkrun:content>${Buffer.from(sourceCode, "utf-8").toString("base64")}</chkrun:content>
      </chkrun:artifact>
    </chkrun:artifacts>
  </chkrun:checkObject>
</chkrun:checkObjectList>`
    : `<?xml version="1.0" encoding="UTF-8"?>
<chkrun:checkObjectList xmlns:chkrun="http://www.sap.com/adt/checkrun" xmlns:adtcore="http://www.sap.com/adt/core">
  <chkrun:checkObject adtcore:uri="${mainUrl}" chkrun:version="active"/>
</chkrun:checkObjectList>`;

  const res = await sapFetch(conn, "/sap/bc/adt/checkruns?reporters=abapCheckRun", {
    method: "POST",
    headers: {
      "Content-Type": "application/vnd.sap.adt.checkobjects+xml; charset=utf-8",
      Accept: "application/vnd.sap.adt.checkmessages+xml",
      "X-CSRF-Token": csrfToken,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body,
  });
  const xml = await res.text();
  const messages = extractTagBlocks(xml, "checkMessage").map((b) => ({ ...b.attrs, ...extractChildTagValuesNS(b.inner) }));
  return { messages, xml };
}

// Where-Used List, verificada en vivo contra un sistema real. Detalle no
// obvio: el discovery anuncia una colección "whereused"
// (/sap/bc/adt/repository/informationsystem/whereused), pero ese endpoint
// devuelve 500 "No service found for ID ." con cualquier body probado. El
// que realmente funciona es su endpoint hermano "usageReferences", pasando
// el URI del objeto como query param ?uri= (el body de la request no influye
// en el resultado, solo hace falta que sea un XML válido con el content-type
// correcto).
export async function getWhereUsed(conn, objectUri) {
  const { token: csrfToken, cookie } = await getCsrfToken(conn);
  const res = await sapFetch(conn, `/sap/bc/adt/repository/informationsystem/usageReferences?uri=${encodeURIComponent(objectUri)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/vnd.sap.adt.repository.usagereferences.request.v1+xml; charset=utf-8",
      Accept: "application/vnd.sap.adt.repository.usagereferences.result.v1+xml",
      "X-CSRF-Token": csrfToken,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: `<?xml version="1.0" encoding="UTF-8"?><usageReferences:usageReferenceRequest xmlns:usageReferences="http://www.sap.com/adt/ris/usageReferences"/>`,
  });
  const xml = await res.text();

  const rootAttrs = parseXmlAttrs(xml.match(/<usageReferences:usageReferenceResult\s+([^>]*)>/)?.[1] || "");
  const refs = extractTagBlocks(xml, "referencedObject").map((b) => {
    const adtObject = extractTagBlocks(b.inner, "adtObject")[0];
    const packageAttrs = parseXmlAttrs(adtObject?.inner.match(/<adtcore:packageRef\s+([^>]*)\/>/)?.[1] || "");
    return {
      uri: b.attrs.uri || "",
      isResult: b.attrs.isResult || "",
      name: adtObject?.attrs.name || "",
      type: adtObject?.attrs.type || "",
      responsible: adtObject?.attrs.responsible || "",
      package: packageAttrs.name || "",
      objectIdentifier: b.inner.match(/<objectIdentifier>([^<]*)<\/objectIdentifier>/)?.[1] || "",
    };
  });
  return {
    refs,
    totalCount: Number(rootAttrs.numberOfResults) || refs.length,
    description: rootAttrs.resultDescription || "",
    xml,
  };
}

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
        const conn = await getConnection(args);
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
      const conn = await getConnection(args);
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
        const conn = await getConnection(args);
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
        const conn = await getConnection(args);
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
        const conn = await getConnection(args);
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

  server.tool(
    "format_source",
    "Formatea código fuente ABAP con el Pretty Printer estándar de ADT (el mismo que Shift+F1 en SE80/ADT). No requiere que el objeto exista ni lo modifica: solo formatea el texto que se le pasa. Útil antes de write_abap_source para dejar el código con indentado estándar.",
    {
      ...connectionParams,
      source_code: z.string().describe("Código fuente ABAP a formatear"),
    },
    async (args) => {
      try {
        const conn = await getConnection(args);
        const formatted = await formatAbapSource(conn, args.source_code);
        return { content: [{ type: "text", text: formatted }] };
      } catch (err) {
        return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "check_syntax",
    "Comprueba la sintaxis ABAP de un objeto (equivalente al chequeo de sintaxis de SE80/ADT, Ctrl+F2), sin necesidad de activarlo. Si se pasa source_code, chequea ese texto como si fuera a guardarse (sin guardarlo realmente); si no, chequea la versión activa ya guardada del objeto. Pensada para usarse antes de write_abap_source/activate_object y así no activar código roto.",
    {
      ...connectionParams,
      object_name: z.string().describe("Nombre del objeto ABAP"),
      object_type: z.string().describe("Tipo de objeto: PROG, CLAS, FUGR, FUNC, INTF, REPS (include)"),
      function_group: z.string().optional().describe("Obligatorio si object_type es FUNC"),
      source_code: z.string().optional().describe("Si se indica, se chequea este código como propuesta de cambio (sin guardar). Si se omite, se chequea la versión activa actual del objeto."),
    },
    async (args) => {
      const { object_name, object_type, function_group, source_code } = args;
      try {
        const conn = await getConnection(args);
        const objectUri = `/sap/bc/adt/${getObjectPath(object_type, object_name, function_group)}`;
        const { messages, xml } = await checkAbapSyntax(conn, { objectUri, sourceCode: source_code });

        if (messages.length === 0) {
          return {
            content: [{
              type: "text",
              text: `✅ Sin mensajes de chequeo de sintaxis para ${object_name}.\n\n--- XML crudo (por si el parseo no encontró el formato esperado) ---\n${xml.slice(0, 1500)}`,
            }],
          };
        }

        const lines = messages.map((m, i) => {
          const severity = m.type || m.severity || "?";
          const text = m.shortText || m.text || "";
          const uri = m.uri || "";
          return `${i + 1}. [${severity}] ${uri} ${text}`.trim();
        });

        return {
          content: [{
            type: "text",
            text: `Mensajes de chequeo de sintaxis para ${object_name} (${messages.length}):\n\n${lines.join("\n")}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_where_used",
    "Lista dónde se usa un objeto ABAP (equivalente a la Where-Used List de SE80/ADT), vía el endpoint estándar de análisis de uso de ADT (repository/informationsystem/usageReferences). Verificada en vivo.",
    {
      ...connectionParams,
      object_name: z.string().describe("Nombre del objeto ABAP"),
      object_type: z.string().describe("Tipo de objeto: PROG, CLAS, FUGR, FUNC, TABL, VIEW, DTEL, DOMA, INTF, REPS (include)"),
      function_group: z.string().optional().describe("Obligatorio si object_type es FUNC"),
      max_results: z.number().optional().default(50).describe("Número máximo de referencias a mostrar (default: 50)"),
    },
    async (args) => {
      const { object_name, object_type, function_group, max_results } = args;
      try {
        const conn = await getConnection(args);
        const objectUri = `/sap/bc/adt/${getObjectPath(object_type, object_name, function_group)}`;
        const { refs, totalCount, description, xml } = await getWhereUsed(conn, objectUri);

        if (refs.length === 0) {
          return {
            content: [{
              type: "text",
              text: `Sin referencias encontradas para ${object_name}.\n\n--- XML crudo (por si el parseo no encontró el formato esperado) ---\n${xml.slice(0, 1500)}`,
            }],
          };
        }

        const shown = refs.slice(0, max_results);
        const lines = shown.map((r, i) => {
          const parts = [`[${r.type || "?"}]`, r.name || r.uri];
          if (r.package) parts.push(`(paquete ${r.package}${r.responsible ? `, responsable ${r.responsible}` : ""})`);
          if (r.objectIdentifier) parts.push(`— ${r.objectIdentifier}`);
          return `${i + 1}. ${parts.join(" ")}`;
        });

        const header = `${description || `Where-Used List de ${object_name}`}\nTotal: ${totalCount} (mostrando ${shown.length})`;
        return { content: [{ type: "text", text: `${header}\n\n${lines.join("\n")}` }] };
      } catch (err) {
        return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
      }
    }
  );
}
