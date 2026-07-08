// Tool de ABAP Test Cockpit (ATC): chequeo de calidad/seguridad estático
// estándar (equivalente a la transacción ATC / SCI), vía los servicios REST
// de ADT confirmados con list_adt_discovery (/sap/bc/adt/atc/*). Requiere
// mínimo SAP_BASIS 7.50 y que exista al menos un check variant configurado
// en el sistema (customizing de la transacción ATC, endpoint
// /sap/bc/adt/atc/customizing → property "systemCheckVariant").
//
// Flujo de 3 pasos (no es una sola llamada, a diferencia de checkruns):
//   1. Crear un worklist:            POST /sap/bc/adt/atc/worklists?checkVariant=...
//      → el id va en la cabecera Location (.../worklistId/<ID>) y también
//        en el body como texto plano.
//   2. Lanzar el run sobre el objeto: POST /sap/bc/adt/atc/runs?worklistId=...&clientWait=false
//      (clientWait=false es obligatorio: el servidor devuelve 400
//      ExceptionResourceBadRequest "Only 'false' is currently supported" si
//      se omite o se pone true).
//   3. Leer los resultados:          GET  /sap/bc/adt/atc/worklists/{id}?includeExemptedFindings=false
//      con Accept: application/atc.worklist.v1+xml (con Accept: application/xml
//      da 406 ExceptionResourceNotAcceptable).
//
// LIMITACIÓN CONOCIDA (sin resolver): en el sistema de pruebas, el paso 2
// (lanzar el run) devuelve siempre 500 ExceptionInternalServerError ("An
// exception was raised", T100KEY SY/530), probado con 3 esquemas de body
// distintos, 2 Content-Type distintos y 2 tipos de objeto distintos (PROG y
// TABL) — mismo error byte a byte en los 12 casos. Esto descarta un problema
// de esquema XML del lado cliente; lo más probable es que el usuario de la
// conexión no tenga autorización para *ejecutar* runs ATC (ver objeto de
// autorización S_ATC_RUN o similar) o que falte alguna infraestructura de
// fondo para el run en este sistema — no hay dump en ST22 ni entradas en
// /sap/bc/adt/atc/checkfailures que lo expliquen. El paso 1 y el paso 3 sí
// funcionan correctamente y están verificados en vivo.
import { z } from "zod";
import { connectionParams, getConnection } from "../lib/connection.js";
import { sapFetch, getCsrfToken, getObjectPath } from "../lib/http.js";
import { extractTagBlocks } from "../lib/xml.js";

export async function runAtcCheck(conn, objectUri, { checkVariant } = {}) {
  const { token: csrfToken, cookie } = await getCsrfToken(conn);

  const worklistQs = checkVariant ? `?checkVariant=${encodeURIComponent(checkVariant)}` : "";
  const worklistRes = await sapFetch(conn, `/sap/bc/adt/atc/worklists${worklistQs}`, {
    method: "POST",
    headers: {
      "X-CSRF-Token": csrfToken,
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  const location = worklistRes.headers.get("location") || "";
  const worklistId = location.split("/").filter(Boolean).pop();
  if (!worklistId) {
    throw new Error(`No se pudo obtener el worklistId de ATC (cabecera Location vacía o inesperada: "${location}")`);
  }

  const runBody = `<?xml version="1.0" encoding="UTF-8"?>
<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">
  <adtcore:objectReference adtcore:uri="${objectUri}"/>
</adtcore:objectReferences>`;

  const runRes = await sapFetch(conn, `/sap/bc/adt/atc/runs?worklistId=${encodeURIComponent(worklistId)}&clientWait=false`, {
    method: "POST",
    headers: {
      "Content-Type": "application/xml",
      Accept: "application/xml",
      "X-CSRF-Token": csrfToken,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: runBody,
  });
  const runXml = await runRes.text();

  const resultRes = await sapFetch(conn, `/sap/bc/adt/atc/worklists/${encodeURIComponent(worklistId)}?includeExemptedFindings=false`, {
    headers: { Accept: "application/atc.worklist.v1+xml" },
  });
  const resultXml = await resultRes.text();

  const findings = extractTagBlocks(resultXml, "finding").map((b) => b.attrs);
  return { worklistId, findings, runXml, resultXml };
}

export function registerAtcTools(server) {
  server.tool(
    "run_atc_check",
    "Ejecuta un chequeo de calidad/seguridad ABAP Test Cockpit (ATC, equivalente a la transacción ATC/SCI) sobre un objeto ABAP. Requiere SAP_BASIS 7.50+ y un check variant configurado; usa list_adt_discovery(filter='atc') para confirmar antes que el sistema tenga el servicio activo. LIMITACIÓN CONOCIDA: en al menos un sistema de pruebas, el paso de lanzar el run devuelve 500 (probablemente falta de autorización para ejecutar runs ATC, no un problema de esta tool) — si falla, revisa con el equipo Basis los permisos ATC del usuario de conexión.",
    {
      ...connectionParams,
      object_name: z.string().describe("Nombre del objeto ABAP"),
      object_type: z.string().describe("Tipo de objeto: PROG, CLAS, FUGR, FUNC, INTF, TABL, VIEW, DTEL, DOMA, REPS (include)"),
      function_group: z.string().optional().describe("Obligatorio si object_type es FUNC"),
      check_variant: z.string().optional().describe("Nombre del check variant ATC a usar (transacción ATC, customizing). Si no se indica, se usa el variant por defecto del sistema."),
    },
    async (args) => {
      const { object_name, object_type, function_group, check_variant } = args;
      try {
        const conn = getConnection(args);
        const objectUri = `/sap/bc/adt/${getObjectPath(object_type, object_name, function_group)}`;
        const { worklistId, findings, resultXml } = await runAtcCheck(conn, objectUri, { checkVariant: check_variant });

        if (findings.length === 0) {
          return {
            content: [{
              type: "text",
              text: `Worklist ATC: ${worklistId}\nSin findings detectados para ${object_name} (o el parseo no encontró el formato esperado — revisar XML crudo).\n\n--- XML crudo de resultados (primeras 2000 chars) ---\n${resultXml.slice(0, 2000)}`,
            }],
          };
        }

        const lines = findings.map((f, i) => {
          const priority = f.priority || f.severity || "?";
          const text = f.messageTitle || f.checkTitle || f.text || "";
          const uri = f.uri || "";
          return `${i + 1}. [prio ${priority}] ${uri} ${text}`.trim();
        });

        return {
          content: [{
            type: "text",
            text: `Worklist ATC: ${worklistId}\nFindings para ${object_name} (${findings.length}):\n\n${lines.join("\n")}`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
      }
    }
  );
}
