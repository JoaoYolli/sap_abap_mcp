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
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEEPER_DIR = path.join(__dirname, "..", "keeper");
const FETCH_SCRIPT = path.join(KEEPER_DIR, "fetch_secret.py");
const LIST_SCRIPT = path.join(KEEPER_DIR, "list_connections.py");
const LOGIN_SCRIPT = path.join(KEEPER_DIR, "login.py");
const PYTHON_BIN = "py";
const CACHE_TTL_MS = 5 * 60 * 1000;

// Ruta absoluta y ya citada para que el comando funcione sin importar desde qué
// carpeta lo ejecute el usuario. Este es el texto que el agente debe mostrarle
// TAL CUAL cuando una tool falle por sesión de Keeper caducada o no iniciada:
// un comando para pegar en una terminal normal, nunca en el chat de Claude Code
// (para que la contraseña maestra y el 2FA no pasen por la conversación).
export const KEEPER_LOGIN_COMMAND = `py "${LOGIN_SCRIPT}"`;
const LOGIN_HINT =
  `Sesión de Keeper caducada o no iniciada. Ejecuta este comando en una terminal ` +
  `(NUNCA dentro del chat de Claude Code): ${KEEPER_LOGIN_COMMAND}`;

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
export function getConnection({ connection }) {
  const cached = connectionCache.get(connection);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
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
  return value;
}
