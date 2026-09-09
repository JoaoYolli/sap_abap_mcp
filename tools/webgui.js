// Tools de gestión del proxy local de SAP GUI para HTML (WebGUI): arrancarlo
// (reutilizando uno ya vivo si coincide el alias), consultar su estado, y
// detenerlo. Antes esto era un script (`keeper/webgui-proxy.js` +
// `start-webgui.bat`) que solo un agente que hubiera leído CLAUDE.md/README.md
// sabía que existía y cómo lanzar con su propia terminal; convertirlo en tools
// del MCP lo hace descubrible por cualquier cliente vía `tools/list`, con las
// reglas de uso (coste en tokens, reutilizar en vez de reiniciar) metidas en
// la propia descripción de la tool.
//
// A diferencia del login de Keeper (`buildKeeperLoginPowerShellCommand` en
// lib/connection.js, que SÍ necesita que el agente lo lance con su propia
// terminal porque abre una ventana interactiva y este proceso no tiene
// desktop propio), el proxy WebGUI no necesita ninguna ventana visible: es un
// servidor HTTP sin interacción humana, así que se puede spawnear oculto
// (`windowsHide`, sin consola) directamente desde este proceso y seguir
// funcionando tras salir de él (`detached` + `unref`). Las credenciales
// siguen sin llegar nunca al agente (LLM): se resuelven vía getConnection()
// igual que en cualquier otra tool, y el proxy hijo las inyecta en cada
// petición sin devolverlas en ningún content de tool.
import { z } from "zod";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { connectionParams, getConnection } from "../lib/connection.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEBGUI_PROXY_SCRIPT = path.join(__dirname, "..", "keeper", "webgui-proxy.js");
const DEFAULT_PORT = 4728;
const READY_TIMEOUT_MS = 8000;
const READY_POLL_MS = 300;

async function fetchProxyInfo(port) {
  try {
    const res = await fetch(`http://localhost:${port}/__sapmcp_proxy_info`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Localiza el PID que escucha en un puerto TCP local. No asume que lo lanzó
// esta tool: también debe encontrar (y poder parar) un proxy abierto a mano
// con start-webgui.bat, o dejado de una sesión anterior.
function findPidOnPort(port) {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf-8", timeout: 5000 });
      const line = out.split("\n").find((l) => {
        const cols = l.trim().split(/\s+/);
        return cols[0] === "TCP" && cols[1]?.endsWith(`:${port}`) && cols[3] === "LISTENING";
      });
      if (!line) return null;
      const pid = line.trim().split(/\s+/).pop();
      return pid ? Number(pid) : null;
    }
    const out = execFileSync("lsof", ["-t", "-i", `:${port}`, "-sTCP:LISTEN"], { encoding: "utf-8", timeout: 5000 });
    const pid = out.trim().split("\n")[0];
    return pid ? Number(pid) : null;
  } catch {
    return null;
  }
}

function killPid(pid) {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/F"], { timeout: 5000 });
    } else {
      process.kill(pid, "SIGKILL");
    }
    return true;
  } catch {
    return false;
  }
}

async function waitForProxyReady(port, expectedAlias, timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await fetchProxyInfo(port);
    if (info && info.alias === expectedAlias) return info;
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
  return null;
}

function transactionUrl(port, client, tcode) {
  const qs = new URLSearchParams({ "sap-client": client });
  if (tcode) qs.set("~transaction", tcode);
  return `http://localhost:${port}/sap/bc/gui/sap/its/webgui?${qs}`;
}

export function registerWebguiTools(server) {
  server.tool(
    "start_webgui_proxy",
    "Arranca el proxy local de SAP GUI para HTML (WebGUI) para navegar un sistema SAP en Chrome (con la extensión claude-in-chrome) cuando no exista ninguna tool ADT (mcp__sap-abap__*) que cubra la tarea (p.ej. ST02, DBACOCKPIT, SOST, o cualquier transacción sin tool dedicada). ÚLTIMO RECURSO frente a ADT: consume muchos más tokens que una tool ADT porque cada paso implica navegar/leer la pantalla en vez de una llamada estructurada — avisa siempre de este coste al usuario antes de usarlo, y comprueba antes si hay una tool ADT que resuelva la tarea. El proxy es agnóstico a la transacción una vez arrancado: si ya hay uno activo para el mismo alias en el mismo puerto, esta tool lo REUTILIZA en vez de relanzarlo (nunca reinicies el proxy solo para cambiar de pantalla) — para moverte a otra transacción, navega la pestaña a la URL que devuelve esta tool cambiando el parámetro '~transaction'.",
    {
      ...connectionParams,
      port: z.number().int().optional().describe(`Puerto local del proxy (por defecto ${DEFAULT_PORT}). Usa el mismo puerto en llamadas sucesivas de la misma sesión de trabajo para reutilizar el proxy en vez de abrir uno nuevo.`),
      transaction: z.string().optional().describe("Transacción inicial (ej. 'ST02', 'SE38') a la que aterrizar nada más navegar. Opcional: más tarde puedes ir a otra transacción navegando directamente a otra URL, sin volver a llamar a esta tool."),
    },
    async (args) => {
      const { connection, transaction } = args;
      const port = args.port || DEFAULT_PORT;
      const baseUrl = `http://localhost:${port}`;

      try {
        const existing = await fetchProxyInfo(port);
        if (existing) {
          if (existing.alias === connection) {
            return {
              content: [{
                type: "text",
                text: `♻️ Ya había un proxy activo en el puerto ${port} para "${connection}" — reutilizado, no se ha lanzado ninguno nuevo.\n` +
                  `🔗 URL base: ${baseUrl}/\n` +
                  (transaction ? `🔗 URL directa a ${transaction}: ${transactionUrl(port, existing.client, transaction)}\n` : "") +
                  `Para cambiar de transacción más tarde, navega esa misma pestaña a otra URL con "~transaction=<TCODE>" — no vuelvas a llamar a esta tool para eso.`,
              }],
            };
          }
          // Alias distinto en ese puerto: hay que liberar el puerto antes de
          // arrancar el nuevo, sea cual sea el proceso que lo esté ocupando
          // (otra sesión, o un start-webgui.bat lanzado a mano).
          const oldPid = findPidOnPort(port);
          if (oldPid) killPid(oldPid);
        }

        // Valida la conexión (y dispara, si hace falta, el mismo aviso de
        // sesión de Keeper caducada que cualquier otra tool) ANTES de
        // spawnear el proxy, para dar un error claro en vez de un proxy que
        // arranca y muere en silencio.
        await getConnection({ connection });

        const child = spawn(
          process.execPath,
          [WEBGUI_PROXY_SCRIPT, connection, String(port), transaction || ""],
          { detached: true, stdio: "ignore", windowsHide: true }
        );
        child.unref();

        const info = await waitForProxyReady(port, connection);
        if (!info) {
          return {
            content: [{
              type: "text",
              text: `❌ El proxy no respondió en el puerto ${port} tras ${READY_TIMEOUT_MS / 1000}s. Puede que el puerto esté ocupado por otro proceso no relacionado — prueba con otro puerto, o reintenta get_webgui_proxy_status en unos segundos por si solo iba lento resolviendo la conexión en Keeper.`,
            }],
            isError: true,
          };
        }

        return {
          content: [{
            type: "text",
            text: `✅ Proxy WebGUI activo en el puerto ${port} para "${connection}" (mandante ${info.client}).\n` +
              `🔗 URL base: ${baseUrl}/\n` +
              (transaction ? `🔗 URL directa a ${transaction}: ${transactionUrl(port, info.client, transaction)}\n` : "") +
              `Recuerda avisar del coste en tokens de esta vía frente a ADT. Para cambiar de transacción, navega la misma pestaña a otra URL con "~transaction=<TCODE>" en vez de volver a llamar a esta tool.`,
          }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
      }
    }
  );

  server.tool(
    "get_webgui_proxy_status",
    "Comprueba si hay un proxy de SAP GUI para HTML (WebGUI) activo en un puerto local dado y a qué alias de conexión está atado (sin exponer host/usuario/contraseña). Llama a esta tool antes de start_webgui_proxy si solo quieres saber si ya puedes navegar directamente sin arrancar nada.",
    { port: z.number().int().optional().describe(`Puerto a comprobar (por defecto ${DEFAULT_PORT}).`) },
    async (args) => {
      const port = args.port || DEFAULT_PORT;
      const info = await fetchProxyInfo(port);
      if (!info) {
        return { content: [{ type: "text", text: `No hay ningún proxy WebGUI respondiendo en el puerto ${port}.` }] };
      }
      return {
        content: [{
          type: "text",
          text: `Proxy activo en el puerto ${port}: alias "${info.alias}", mandante ${info.client}.\n🔗 URL base: http://localhost:${port}/`,
        }],
      };
    }
  );

  server.tool(
    "stop_webgui_proxy",
    "Detiene el proxy de SAP GUI para HTML (WebGUI) que esté escuchando en un puerto local dado, si lo hay (lo haya arrancado start_webgui_proxy o a mano con start-webgui.bat). Rollback total: no queda nada en disco ni estado que limpiar.",
    { port: z.number().int().optional().describe(`Puerto a detener (por defecto ${DEFAULT_PORT}).`) },
    async (args) => {
      const port = args.port || DEFAULT_PORT;
      const pid = findPidOnPort(port);
      if (!pid) {
        return { content: [{ type: "text", text: `No había ningún proceso escuchando en el puerto ${port}.` }] };
      }
      const ok = killPid(pid);
      return {
        content: [{
          type: "text",
          text: ok ? `🛑 Proxy en el puerto ${port} detenido (PID ${pid}).` : `❌ No se pudo detener el proceso PID ${pid} en el puerto ${port}.`,
        }],
        isError: !ok,
      };
    }
  );
}
