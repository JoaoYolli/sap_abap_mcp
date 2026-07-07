// Resolución de conexiones SAP — las credenciales viven en un archivo local,
// nunca en la conversación ni en los argumentos de las tools.
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_DIR = path.join(os.homedir(), ".sap-mcp");
export const CONFIG_PATH = path.join(CONFIG_DIR, "connections.json");

// Plantilla vacía que se escribe la primera vez que se usa el MCP en una máquina
// nueva, para que quede claro qué campos hay que rellenar.
const CONNECTIONS_TEMPLATE = {
  dev: { host: "", client: "", user: "", password: "" },
};

export function loadConnectionsConfig() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  } catch (err) {
    // Solo se crea la plantilla si el archivo realmente no existe (ENOENT).
    // Cualquier otro error (p.ej. permisos) se propaga tal cual: nunca hay que
    // sobrescribir un archivo que podría existir pero no ser accesible.
    if (err.code !== "ENOENT") throw err;

    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(CONNECTIONS_TEMPLATE, null, 2), "utf-8");
    try {
      fs.chmodSync(CONFIG_PATH, 0o600);
    } catch {
      // chmod no tiene efecto real en Windows (no hay ACLs POSIX), se ignora.
    }
    throw new Error(
      `No existía el archivo de conexiones: se ha creado una plantilla vacía en ${CONFIG_PATH}. ` +
      `Rellena host/client/user/password (y añade tantos alias como conexiones necesites) y vuelve a intentarlo.`
    );
  }
  return JSON.parse(raw);
}

export const connectionParams = {
  connection: z.string().describe(`Alias de la conexión SAP a usar, definida en ${CONFIG_PATH} (ej: dev, qas, prod). Usa la tool list_connections para ver los alias disponibles.`),
};

// Resuelve el alias de conexión contra el archivo de configuración local
export function getConnection({ connection }) {
  const config = loadConnectionsConfig();
  const entry = config[connection];
  if (!entry) {
    const available = Object.keys(config).join(", ") || "(ninguna configurada)";
    throw new Error(`No existe la conexión "${connection}" en ${CONFIG_PATH}. Conexiones disponibles: ${available}`);
  }
  if (!entry.host) {
    throw new Error(`La conexión "${connection}" está vacía en ${CONFIG_PATH}. Rellena host/client/user/password para poder usarla.`);
  }
  return {
    host: entry.host.replace(/\/+$/, ""),
    client: entry.client,
    user: entry.user,
    password: entry.password,
  };
}
