// Tool agregadora: checklist básico de monitorización diaria de Basis.
// No implementa nada nuevo contra SAP — llama en paralelo a las funciones
// fetch* que ya usan get_st22_dumps, get_background_jobs,
// get_update_task_records, get_sapconnect_requests, get_gateway_error_log,
// get_trfc_queue, get_lock_entries y get_work_processes, y arma un solo
// reporte. Las tools individuales siguen existiendo igual para quien las
// quiera usar sueltas (ej. re-consultar un job concreto).
//
// Puntos del checklist original SIN tool estándar disponible todavía (no se
// incluyen, no se inventan datos): ST02/DBACOCKPIT (recursos), monitor de BD
// (excepciones/warnings), recursos SARFC, SICK (health check) y SM21 (log de
// sistema, parte del punto "System logs"). Ver planning de nuevas tools para
// SM21 (get_system_log).
import { z } from "zod";
import { connectionParams, getConnection } from "../lib/connection.js";
import { formatAdtTimestamp } from "../lib/xml.js";
import { fetchSt22Dumps } from "./basis.js";
import {
  fetchBackgroundJobs,
  fetchUpdateTaskRecords,
  fetchSapconnectRequests,
  fetchGatewayErrorLog,
  fetchTrfcQueue,
} from "./basis-monitoring.js";
import { fetchLockEntries, fetchWorkProcesses } from "./basis-live.js";

function formatRows(rows) {
  if (rows.length === 0) return "(sin resultados)";
  const columns = Object.keys(rows[0]);
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const header = columns.map((c, i) => c.padEnd(widths[i])).join(" | ");
  const sep = widths.map((w) => "-".repeat(w)).join("-|-");
  const body = rows.map((r) => columns.map((c, i) => String(r[c] ?? "").padEnd(widths[i])).join(" | ")).join("\n");
  return `${header}\n${sep}\n${body}`;
}

// Corta una lista de filas a `limit` y añade una nota de cuántas se omitieron.
function formatRowsLimited(rows, limit = 20) {
  const shown = rows.slice(0, limit);
  const table = formatRows(shown);
  return rows.length > limit ? `${table}\n… (+${rows.length - limit} más, no mostradas)` : table;
}

function pick(row, candidates) {
  const keys = Object.keys(row);
  for (const cand of candidates) {
    const found = keys.find((k) => k.toLowerCase() === cand.toLowerCase());
    if (found && row[found]) return row[found];
  }
  return undefined;
}

// Agrupa dumps por usuario para poder sugerir "a quién avisar". Los nombres
// de campo del feed de ST22 no están documentados oficialmente (ver
// basis.js), así que se prueban varios candidatos habituales en vez de
// asumir uno fijo.
function groupDumpsByUser(dumps) {
  const counts = {};
  for (const d of dumps) {
    const user = pick(d, ["user", "name", "createdBy", "creator", "author"]) || "(usuario no identificado)";
    counts[user] = (counts[user] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
}

function elapsedMinutes(dateStr, timeStr) {
  if (!dateStr || !timeStr || dateStr.length < 8 || timeStr.length < 6) return null;
  const y = +dateStr.slice(0, 4), mo = +dateStr.slice(4, 6), d = +dateStr.slice(6, 8);
  const h = +timeStr.slice(0, 2), mi = +timeStr.slice(2, 4), s = +timeStr.slice(4, 6);
  const started = new Date(y, mo - 1, d, h, mi, s);
  if (Number.isNaN(started.getTime())) return null;
  return Math.round((Date.now() - started.getTime()) / 60000);
}

// Ejecuta un fetch* y homogeneiza el resultado para que un fallo puntual
// (p.ej. falta de autorización en un módulo RFC) no tumbe todo el reporte.
async function safeSection(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

const SEP = "=".repeat(70);

export function registerDailyMonitoringTools(server) {
  server.tool(
    "monitoreo_basico_basis_diario",
    "Checklist básico de monitorización diaria de Basis en una sola llamada, agregando las tools ya existentes: dumps ABAP (ST22), registros de actualización con error (SM13/SM14), trabajos en fondo con error o de larga duración (SM37), log de errores Fiori/Gateway (/IWFND/ERROR_LOG), SAPconnect fallido (SOST/SOIN), salud de work processes (SM50/SM66), cola tRFC (SM58) y bloqueos de enqueue (SM12). NO cubre ST02/DBACOCKPIT, monitor de BD, recursos SARFC, SICK ni SM21 (log de sistema): no hay tool estándar para ellos todavía en este servidor.",
    {
      ...connectionParams,
      long_running_minutes: z.number().optional().default(60).describe("Umbral en minutos para marcar un trabajo en fondo ACTIVE como de larga duración (default: 60)."),
    },
    async (args) => {
      const { long_running_minutes } = args;
      try {
        const conn = getConnection(args);

        const now = new Date();
        const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const pad = (n) => String(n).padStart(2, "0");
        const yyyymmdd = `${yesterday.getFullYear()}${pad(yesterday.getMonth() + 1)}${pad(yesterday.getDate())}`;
        const dumpsDateFrom = formatAdtTimestamp(yesterday);

        const [dumps, jobs, updateTasks, sapconnect, gateway, trfc, locks, workProcesses] = await Promise.all([
          safeSection(fetchSt22Dumps(conn, { date_from: dumpsDateFrom, max_results: 100 })),
          safeSection(fetchBackgroundJobs(conn, { date_from: yyyymmdd, max_results: 100 })),
          safeSection(fetchUpdateTaskRecords(conn, { max_results: 100 })),
          safeSection(fetchSapconnectRequests(conn, { date_from: yyyymmdd, max_results: 100 })),
          safeSection(fetchGatewayErrorLog(conn, { date_from: yyyymmdd, max_results: 100 })),
          safeSection(fetchTrfcQueue(conn, { max_results: 100 })),
          safeSection(fetchLockEntries(conn, {})),
          safeSection(fetchWorkProcesses(conn)),
        ]);

        const lines = [];
        lines.push(`📋 MONITOREO BÁSICO DE BASIS — DIARIO`);
        lines.push(`Conexión: ${args.connection} | Generado: ${now.toISOString()}`);
        lines.push(`Ventana analizada (salvo donde se indique): últimas 24h`);
        lines.push("");

        // 1) ST22
        lines.push(SEP, "1) Errores de runtime y seguimiento de usuarios involucrados (ST22)", SEP);
        if (!dumps.ok) {
          lines.push(`⚠️ No se pudo obtener: ${dumps.error}`);
        } else {
          const { dumps: rows, totalCount } = dumps.value;
          lines.push(`Total dumps: ${totalCount}`);
          if (totalCount > 0) {
            const byUser = groupDumpsByUser(rows);
            lines.push("Por usuario (mejor esfuerzo — el feed de ST22 no tiene esquema oficial documentado):");
            for (const [user, count] of byUser) lines.push(`  - ${user}: ${count}`);
            lines.push("");
            lines.push(formatRowsLimited(rows));
            lines.push("→ Seguimiento sugerido: contactar a los usuarios listados y usar get_st22_dump_detail sobre el campo 'uri' de cada dump para ver el call stack completo.");
          } else {
            lines.push("Sin dumps en la ventana analizada.");
          }
        }
        lines.push("");

        // 2) SM13/SM14 (SM21 no incluido, ver nota final)
        lines.push(SEP, "2) Registros de actualización con error (SM13/SM14)", SEP);
        lines.push("[Nota: el checklist original agrupaba esto con SM21 (log de sistema); SM21 no está incluido — ver sección final.]");
        if (!updateTasks.ok) {
          lines.push(`⚠️ No se pudo obtener: ${updateTasks.error}`);
        } else {
          lines.push(`Total con error: ${updateTasks.value.length}`);
          lines.push(formatRowsLimited(updateTasks.value));
        }
        lines.push("");

        // 3) SM37
        lines.push(SEP, "3) Trabajos en fondo — excepciones y de larga duración (SM37)", SEP);
        if (!jobs.ok) {
          lines.push(`⚠️ No se pudo obtener: ${jobs.error}`);
        } else {
          const aborted = jobs.value.filter((j) => j.STATUS === "X");
          const longRunning = jobs.value
            .filter((j) => j.STATUS === "A")
            .map((j) => ({ ...j, ELAPSED_MIN: elapsedMinutes(j.SDLSTRTDT, j.SDLSTRTTM) }))
            .filter((j) => j.ELAPSED_MIN !== null && j.ELAPSED_MIN >= long_running_minutes);

          lines.push(`Abortados (excepción): ${aborted.length}`);
          if (aborted.length) lines.push(formatRowsLimited(aborted));
          lines.push("");
          lines.push(`Activos hace más de ${long_running_minutes} min (posible larga duración): ${longRunning.length}`);
          if (longRunning.length) lines.push(formatRowsLimited(longRunning));
          if (!aborted.length && !longRunning.length) lines.push("Sin excepciones ni trabajos de larga duración detectados.");
        }
        lines.push("");

        // 4) Gateway/Fiori
        lines.push(SEP, "4) Log de errores Fiori/Gateway (/IWFND/ERROR_LOG)", SEP);
        if (!gateway.ok) {
          lines.push(`⚠️ No se pudo obtener: ${gateway.error}`);
        } else {
          lines.push(`Total: ${gateway.value.length}`);
          lines.push(formatRowsLimited(gateway.value));
        }
        lines.push("");

        // 5) SOST/SOIN
        lines.push(SEP, "5) SAPconnect — envíos/recepciones fallidas (SOST/SOIN)", SEP);
        if (!sapconnect.ok) {
          lines.push(`⚠️ No se pudo obtener: ${sapconnect.error}`);
        } else {
          lines.push(`Total: ${sapconnect.value.length}`);
          lines.push(formatRowsLimited(sapconnect.value));
        }
        lines.push("");

        // 6) Work processes / salud de application servers + 8bis) locks (se listan juntos, como en el checklist original)
        lines.push(SEP, "6) Salud de application servers y work processes (SM50/SM66)", SEP);
        if (!workProcesses.ok) {
          lines.push(`⚠️ No se pudo obtener: ${workProcesses.error}`);
        } else if (workProcesses.value.length === 0) {
          lines.push("(sin resultados) — puede ser falta de autorización SM50 del usuario de conexión para TH_WPINFO, no necesariamente que no haya procesos.");
        } else {
          lines.push(formatRowsLimited(workProcesses.value));
        }
        lines.push("");

        // 7) SM58
        lines.push(SEP, "7) Cola de RFC transaccional (SM58)", SEP);
        if (!trfc.ok) {
          lines.push(`⚠️ No se pudo obtener: ${trfc.error}`);
        } else {
          lines.push(`Total en error: ${trfc.value.length}`);
          lines.push(formatRowsLimited(trfc.value));
        }
        lines.push("");

        // 8) SM12
        lines.push(SEP, "8) Bloqueos de enqueue activos / persistentes (SM12)", SEP);
        if (!locks.ok) {
          lines.push(`⚠️ No se pudo obtener: ${locks.error}`);
        } else {
          lines.push(`Total: ${locks.value.length}`);
          lines.push(formatRowsLimited(locks.value));
          lines.push("Nota: ENQUE_READ2 no devuelve antigüedad del bloqueo; para identificar bloqueos realmente 'persistentes' hay que revisar manualmente los que correspondan a transacciones ya finalizadas.");
        }
        lines.push("");

        lines.push(SEP, "NO INCLUIDO EN ESTE CHECKLIST (sin tool estándar disponible todavía)", SEP);
        lines.push("- Monitoreo de recursos de sistema (ST02 / DBACOCKPIT)");
        lines.push("- Monitor de base de datos (excepciones/warnings)");
        lines.push("- Recursos SARFC");
        lines.push("- System Health Check (SICK)");
        lines.push("- Log de sistema (SM21) — parte del punto 2 del checklist original");
        lines.push("Ver el planning de nuevas tools (get_system_log, etc.) para ir cubriendo estos puntos.");

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
      }
    }
  );
}
