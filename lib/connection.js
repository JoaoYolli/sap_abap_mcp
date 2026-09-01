// Resolución de conexiones SAP — EXPERIMENTAL (rama experiment/keeper-commander-auth):
// no hay ningún archivo local con credenciales ni con mapeos de alias. Los alias se
// descubren en vivo explorando la carpeta "Claude Connections" del vault de Keeper
// (y sus subcarpetas, una por empresa/servidor) vía keeper/list_connections.py, y las
// credenciales de cada uno se resuelven vía keeper/fetch_secret.py. Ambos reutilizan
// la sesión que crea keeper/login.py (login real con usuario/contraseña/2FA, con
// expiración configurable). Igual que antes, las credenciales nunca viajan por la
// conversación ni como argumentos de las tools.
import { z } from "zod";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { runSqlQuery } from "./sql.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEEPER_DIR = path.join(__dirname, "..", "keeper");
const FETCH_SCRIPT = path.join(KEEPER_DIR, "fetch_secret.py");
const LIST_SCRIPT = path.join(KEEPER_DIR, "list_connections.py");
const LOGIN_SCRIPT = path.join(KEEPER_DIR, "login.py");
const START_LOGIN_BAT = path.join(KEEPER_DIR, "start-login.bat");
const PYTHON_BIN = "py";
const CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_LOGIN_HOURS = 10;

// Ruta absoluta y ya citada, por si hiciera falta como último recurso (p.ej.
// documentación o si la tool start_keeper_login no estuviera disponible).
// El camino normal para una sesión caducada/no iniciada NO es mostrar esto
// al usuario: es que el propio agente llame a la tool start_keeper_login
// (ver más abajo) sin preguntar, exactamente igual que ya hace él para
// abrir la ventana de login la primera vez.
export const KEEPER_LOGIN_COMMAND = `py "${LOGIN_SCRIPT}"`;
const LOGIN_HINT =
  'Sesión de Keeper caducada o no iniciada. Llama AHORA MISMO, sin preguntar antes al usuario, ' +
  'a la tool "start_keeper_login" para abrirle la ventana de login; cuando el usuario confirme ' +
  `que ha terminado, reintenta esta misma operación. (Comando equivalente si por algún motivo ` +
  `esa tool no estuviera disponible: ${KEEPER_LOGIN_COMMAND})`;

// Abre una ventana de terminal NUEVA e independiente con el login de Keeper ya
// en marcha (keeper/start-login.bat). El proceso queda desacoplado del server
// MCP (detached + unref): este servidor nunca ve stdout/stdin de esa ventana,
// así que la contraseña maestra y el 2FA del usuario no pasan nunca por aquí.
export function openKeeperLoginWindow(hours = DEFAULT_LOGIN_HOURS) {
  const child = spawn(START_LOGIN_BAT, [String(hours)], {
    detached: true,
    stdio: "ignore",
    shell: true, // necesario en Windows para ejecutar un .bat directamente
    windowsHide: false,
  });
  child.unref();
}

function runPython(scriptPath, args) {
  try {
    return execFileSync(PYTHON_BIN, [scriptPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"], // stdin cerrado: si Keeper necesitara pedir algo por consola, falla rápido en vez de colgarse
      encoding: "utf-8",
      timeout: 30_000,
    });
  } catch (err) {
    const stderr = (err.stderr || "").toString();
    if (stderr.includes("KEEPER_LOGIN_REQUIRED")) {
      throw new Error(LOGIN_HINT);
    }
    throw new Error(stderr.trim() || err.message);
  }
}

// Cache en memoria del proceso: evita lanzar un proceso Python en cada tool call.
// Se refresca cada CACHE_TTL_MS para detectar con cierta rapidez si la sesión de
// Keeper ha caducado o si se ha añadido/borrado un registro, sin pagar el coste de
// un fetch por llamada.
const connectionCache = new Map(); // alias -> { value, fetchedAt }
let listCache = null; // { value, fetchedAt }

// Lista de alias descubiertos en Keeper: [{ alias, ambiguous }]
export function listConnectionAliases() {
  if (listCache && Date.now() - listCache.fetchedAt < CACHE_TTL_MS) {
    return listCache.value;
  }
  const stdout = runPython(LIST_SCRIPT, []);
  const value = JSON.parse(stdout);
  listCache = { value, fetchedAt: Date.now() };
  return value;
}

export const connectionParams = {
  connection: z.string().describe(
    'Alias de la conexión SAP a usar, descubierto automáticamente en la carpeta "Claude Connections" ' +
    "del vault de Keeper (el título del registro, o \"subcarpeta/título\" si está dentro de una subcarpeta " +
    "por empresa). Usa la tool list_connections para ver los alias disponibles."
  ),
};

// Resuelve el alias de conexión contra Keeper (descubrimiento + credenciales)
export async function getConnection({ connection }) {
  const cached = connectionCache.get(connection);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    await checkUserExpirySoon(connection, cached.value);
    return cached.value;
  }

  const stdout = runPython(FETCH_SCRIPT, [connection]);
  const secret = JSON.parse(stdout);
  const value = {
    host: secret.host.replace(/\/+$/, ""),
    client: secret.client,
    user: secret.user,
    password: secret.password,
  };
  connectionCache.set(connection, { value, fetchedAt: Date.now() });
  await checkUserExpirySoon(connection, value);
  return value;
}

// --- Aviso de caducidad de usuario (una vez al día por alias) -------------
//
// La primera vez que se resuelve cada alias en el día (hora local de esta
// máquina, no del sistema SAP), se consulta USR02 para ver si el usuario
// configurado en Keeper para esa conexión caduca en <=30 días (o ya caducó).
// Si es así, se deja un aviso pendiente que installExpiryNoticeMiddleware
// antepone a la respuesta de la tool que disparó la comprobación — así
// llega al usuario sin que ninguna tool individual tenga que saber nada de
// esto. Es "best effort": cualquier fallo (p.ej. sin autorización sobre
// USR02) se traga en silencio y no debe romper la tool original.
const EXPIRY_WARNING_DAYS = 30;
const expiryCheckedToday = new Map(); // alias -> "YYYY-MM-DD"
let pendingNotice = null;

export function consumePendingNotice() {
  const notice = pendingNotice;
  pendingNotice = null;
  return notice;
}

function parseSapDate(yyyymmdd) {
  const digits = String(yyyymmdd || "").replace(/\D/g, "");
  if (digits.length !== 8) return null;
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
}

async function checkUserExpirySoon(alias, conn) {
  const today = new Date().toISOString().slice(0, 10);
  if (expiryCheckedToday.get(alias) === today) return;
  expiryCheckedToday.set(alias, today); // se marca ya, incluso si la consulta falla, para no reintentar en bucle el mismo día

  try {
    const safeUser = conn.user.toUpperCase().replace(/'/g, "''");
    const rows = await runSqlQuery(conn, `SELECT GLTGB FROM USR02 WHERE BNAME = '${safeUser}'`, 1);
    const expiryDate = parseSapDate(rows[0]?.GLTGB);
    if (!expiryDate) return;

    const daysLeft = Math.floor((expiryDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    if (daysLeft > EXPIRY_WARNING_DAYS) return;

    const raw = rows[0].GLTGB.replace(/\D/g, "");
    const dateLabel = raw.replace(/(\d{4})(\d{2})(\d{2})/, "$3/$2/$1");
    pendingNotice = daysLeft < 0
      ? `⚠️ El usuario "${conn.user}" de la conexión "${alias}" YA HA CADUCADO (válido hasta ${dateLabel}). Es posible que las operaciones contra este sistema empiecen a fallar por credenciales inválidas — conviene renovarlo en SU01/Keeper cuanto antes.`
      : `⚠️ El usuario "${conn.user}" de la conexión "${alias}" caduca en ${daysLeft} día(s) (válido hasta ${dateLabel}). Conviene renovarlo pronto en SU01/Keeper.`;
  } catch {
    // Best-effort: no romper la tool original que disparó esta comprobación.
  }
}

// Envuelve server.tool() para que, tras cualquier tool, si checkUserExpirySoon
// dejó un aviso pendiente durante esa llamada, se anteponga al texto de la
// respuesta. Debe llamarse una sola vez, antes de registrar ninguna tool.
export function installExpiryNoticeMiddleware(server) {
  const originalTool = server.tool.bind(server);
  server.tool = (name, ...rest) => {
    const handler = rest[rest.length - 1];
    if (typeof handler === "function") {
      rest[rest.length - 1] = async (...handlerArgs) => {
        const result = await handler(...handlerArgs);
        const notice = consumePendingNotice();
        if (notice && result?.content?.[0]?.type === "text") {
          result.content[0].text = `${notice}\n\n${result.content[0].text}`;
        }
        return result;
      };
    }
    return originalTool(name, ...rest);
  };
}
