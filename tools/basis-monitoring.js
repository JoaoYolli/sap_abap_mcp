// Tools de monitorización Basis basadas en tablas estándar SAP (sin desarrollo
// ABAP nuevo): trabajos en fondo (SM37), cola tRFC (SM58), registros de
// actualización (SM13/SM14), SAPconnect (SOST/SOIN), log de errores de Gateway
// (/IWFND/ERROR_LOG) y destinos RFC (SM59).
import { z } from "zod";
import { connectionParams, getConnection } from "../lib/connection.js";
import { runSqlQuery } from "../lib/sql.js";

function formatRows(rows) {
  if (rows.length === 0) return "(sin resultados)";
  const columns = Object.keys(rows[0]);
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const header = columns.map((c, i) => c.padEnd(widths[i])).join(" | ");
  const sep = widths.map((w) => "-".repeat(w)).join("-|-");
  const body = rows.map((r) => columns.map((c, i) => String(r[c] ?? "").padEnd(widths[i])).join(" | ")).join("\n");
  return `${header}\n${sep}\n${body}`;
}

export function registerBasisMonitoringTools(server) {
  server.tool(
    "get_background_jobs",
    "Lista trabajos en fondo (equivalente a la transacción SM37), con sus pasos si el trabajo ha terminado en error. Por defecto muestra los trabajos activos y cancelados más recientes.",
    {
      ...connectionParams,
      status: z.enum(["SCHEDULED", "RELEASED", "READY", "ACTIVE", "FINISHED", "ABORTED"]).optional().describe("Filtra por estado del trabajo. Si no se indica, se muestran ACTIVE y ABORTED (los que normalmente hay que revisar)."),
      job_name: z.string().optional().describe("Patrón de nombre de trabajo, admite % como wildcard SQL, ej: ZJOB_%"),
      user: z.string().optional().describe("Filtra por el usuario que programó el trabajo"),
      date_from: z.string().optional().describe("Fecha inicial en formato YYYYMMDD"),
      date_to: z.string().optional().describe("Fecha final en formato YYYYMMDD"),
      max_results: z.number().optional().default(50).describe("Número máximo de trabajos a mostrar (default: 50)"),
    },
    async (args) => {
      const { status, job_name, user, date_from, date_to, max_results } = args;
      try {
        const conn = getConnection(args);
        const statusMap = { SCHEDULED: "S", RELEASED: "R", READY: "Y", ACTIVE: "A", FINISHED: "F", ABORTED: "X" };

        const conditions = [];
        conditions.push(status ? `STATUS = '${statusMap[status]}'` : `STATUS IN ('A','X')`);
        if (job_name) conditions.push(`JOBNAME LIKE '${job_name.toUpperCase()}'`);
        if (user) conditions.push(`SDLUNAME = '${user.toUpperCase()}'`);
        if (date_from) conditions.push(`SDLSTRTDT >= '${date_from}'`);
        if (date_to) conditions.push(`SDLSTRTDT <= '${date_to}'`);

        const sql = `SELECT JOBNAME, JOBCOUNT, STATUS, SDLUNAME, SDLSTRTDT, SDLSTRTTM, ENDDATE, ENDTIME FROM TBTCO WHERE ${conditions.join(" AND ")}`;
        const rows = await runSqlQuery(conn, sql, max_results);
        return { content: [{ type: "text", text: formatRows(rows) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_background_job_steps",
    "Lista los pasos (programas/steps) de un trabajo en fondo concreto (detalle de SM37), incluyendo el mensaje del paso en caso de error.",
    {
      ...connectionParams,
      job_name: z.string().describe("Nombre exacto del trabajo (JOBNAME de get_background_jobs)"),
      job_count: z.string().describe("Número de trabajo (JOBCOUNT de get_background_jobs)"),
    },
    async (args) => {
      const { job_name, job_count } = args;
      try {
        const conn = getConnection(args);
        const sql = `SELECT STEPCOUNT, PROGNAME, STATUS FROM TBTCP WHERE JOBNAME = '${job_name.toUpperCase()}' AND JOBCOUNT = '${job_count}' ORDER BY STEPCOUNT`;
        const rows = await runSqlQuery(conn, sql, 200);
        return { content: [{ type: "text", text: formatRows(rows) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_trfc_queue",
    "Consulta la cola de RFC transaccional (equivalente a la transacción SM58). Por defecto muestra solo entradas en error.",
    {
      ...connectionParams,
      only_errors: z.boolean().optional().default(true).describe("Si es true (default), solo muestra entradas con estado de error"),
      destination: z.string().optional().describe("Filtra por destino RFC, admite % como wildcard"),
      max_results: z.number().optional().default(50).describe("Número máximo de entradas (default: 50)"),
    },
    async (args) => {
      const { only_errors, destination, max_results } = args;
      try {
        const conn = getConnection(args);
        const conditions = [];
        if (only_errors) conditions.push(`ARFCSTATE IN ('CPICERR','SYSFAIL','RESYST')`);
        if (destination) conditions.push(`ARFCDEST LIKE '${destination.toUpperCase()}'`);

        let sql = `SELECT ARFCDEST, ARFCSTATE, ARFCDATUM, ARFCUZEIT, ARFCUSER, ARFCTCODE, ARFCMSG FROM ARFCSSTATE`;
        if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
        const rows = await runSqlQuery(conn, sql, max_results);
        return { content: [{ type: "text", text: formatRows(rows) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_update_task_records",
    "Consulta las cabeceras de registros de actualización (equivalente a SM13/SM14). Por defecto solo muestra los que están en error.",
    {
      ...connectionParams,
      only_errors: z.boolean().optional().default(true).describe("Si es true (default), solo muestra registros con error"),
      max_results: z.number().optional().default(50).describe("Número máximo de registros (default: 50)"),
    },
    async (args) => {
      const { only_errors, max_results } = args;
      try {
        const conn = getConnection(args);
        let sql = `SELECT VBKEY, VBUSR, VBDATE, VBREPORT, VBTCODE, VBRC FROM VBHDR`;
        if (only_errors) sql += ` WHERE VBRC <> 0`;
        const rows = await runSqlQuery(conn, sql, max_results);
        return { content: [{ type: "text", text: formatRows(rows) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_sapconnect_requests",
    "Consulta las solicitudes de envío/recepción de SAPconnect (equivalente a SOST/SOIN). Por defecto muestra solo las que están en error.",
    {
      ...connectionParams,
      only_errors: z.boolean().optional().default(true).describe("Si es true (default), solo muestra solicitudes con error"),
      date_from: z.string().optional().describe("Fecha inicial en formato YYYYMMDD"),
      date_to: z.string().optional().describe("Fecha final en formato YYYYMMDD"),
      max_results: z.number().optional().default(50).describe("Número máximo de solicitudes (default: 50)"),
    },
    async (args) => {
      const { only_errors, date_from, date_to, max_results } = args;
      try {
        const conn = getConnection(args);
        const conditions = [];
        if (only_errors) conditions.push(`MSGTY = 'E'`);
        if (date_from) conditions.push(`ENTRY_DATE >= '${date_from}'`);
        if (date_to) conditions.push(`ENTRY_DATE <= '${date_to}'`);

        let sql = `SELECT OBJNO, ENTRY_DATE, ENTRY_TIME, DIRECTION, MSGTY, MSGV1, MSGV2, CREATOR FROM SOST`;
        if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
        const rows = await runSqlQuery(conn, sql, max_results);
        return { content: [{ type: "text", text: formatRows(rows) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_gateway_error_log",
    "Consulta el log de errores de SAP Gateway/OData (equivalente a la transacción /IWFND/ERROR_LOG).",
    {
      ...connectionParams,
      date_from: z.string().optional().describe("Fecha inicial en formato YYYYMMDD"),
      date_to: z.string().optional().describe("Fecha final en formato YYYYMMDD"),
      user: z.string().optional().describe("Filtra por usuario"),
      service_name: z.string().optional().describe("Filtra por nombre de servicio OData, admite % como wildcard"),
      http_status: z.number().optional().describe("Filtra por código de estado HTTP, ej: 500"),
      max_results: z.number().optional().default(50).describe("Número máximo de entradas (default: 50)"),
    },
    async (args) => {
      const { date_from, date_to, user, service_name, http_status, max_results } = args;
      try {
        const conn = getConnection(args);
        const conditions = [];
        if (date_from) conditions.push(`TIMESTAMP >= '${date_from}000000'`);
        if (date_to) conditions.push(`TIMESTAMP <= '${date_to}235959'`);
        if (user) conditions.push(`USERNAME = '${user.toUpperCase()}'`);
        if (service_name) conditions.push(`SERVICE_NAME LIKE '${service_name.toUpperCase()}'`);
        if (http_status) conditions.push(`HTTP_STATUS = '${http_status}'`);

        // Excluye ERROR_CONTEXT/HTML_PAGE (binarios/pesados) del SELECT.
        let sql = `SELECT USERNAME, TIMESTAMP, ERROR_TEXT, ERROR_COMPONENT, SERVICE_NAME, HTTP_STATUS, REQUEST_URI FROM /IWFND/SU_ERRLOG`;
        if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
        const rows = await runSqlQuery(conn, sql, max_results);
        return { content: [{ type: "text", text: formatRows(rows) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_rfc_destinations",
    "Lista los destinos RFC configurados (equivalente a la transacción SM59), incluyendo el host de destino extraído de las opciones de conexión.",
    {
      ...connectionParams,
      rfc_type: z.string().optional().describe("Filtra por tipo de destino (RFCTYPE), ej: 3 (ABAP), T (TCP/IP), H (HTTP)"),
      destination: z.string().optional().describe("Patrón de nombre de destino, admite % como wildcard"),
      max_results: z.number().optional().default(50).describe("Número máximo de destinos (default: 50)"),
    },
    async (args) => {
      const { rfc_type, destination, max_results } = args;
      try {
        const conn = getConnection(args);
        const conditions = [];
        if (rfc_type) conditions.push(`RFCTYPE = '${rfc_type.toUpperCase()}'`);
        if (destination) conditions.push(`RFCDEST LIKE '${destination.toUpperCase()}'`);

        let sql = `SELECT RFCDEST, RFCTYPE, RFCOPTIONS FROM RFCDES`;
        if (conditions.length) sql += ` WHERE ${conditions.join(" AND ")}`;
        const rows = await runSqlQuery(conn, sql, max_results);

        const withHost = rows.map((r) => ({
          RFCDEST: r.RFCDEST,
          RFCTYPE: r.RFCTYPE,
          HOST: r.RFCOPTIONS?.match(/H=([^,]+)/)?.[1] || "",
        }));
        return { content: [{ type: "text", text: formatRows(withHost) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
      }
    }
  );
}
