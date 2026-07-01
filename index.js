// SAP MCP Server - index.js
// Requiere: npm install @modelcontextprotocol/sdk zod
// En package.json: "type": "module"

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ─────────────────────────────────────────────
// CONEXIÓN — las credenciales viven en un archivo local, nunca en la conversación
// ─────────────────────────────────────────────
// Las tools ya no reciben host/usuario/contraseña como argumentos (eso obligaba a
// pasar credenciales en texto plano por el chat/contexto del modelo). En su lugar
// reciben un alias ("connection") que se resuelve aquí, en el propio servidor MCP,
// contra un archivo de conexiones guardado fuera del repo.
const CONFIG_DIR = path.join(os.homedir(), ".sap-mcp");
const CONFIG_PATH = path.join(CONFIG_DIR, "connections.json");

// Plantilla vacía que se escribe la primera vez que se usa el MCP en una máquina
// nueva, para que quede claro qué campos hay que rellenar.
const CONNECTIONS_TEMPLATE = {
  dev: { host: "", client: "", user: "", password: "" },
};

function loadConnectionsConfig() {
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

const connectionParams = {
  connection: z.string().describe(`Alias de la conexión SAP a usar, definida en ${CONFIG_PATH} (ej: dev, qas, prod). Usa la tool list_connections para ver los alias disponibles.`),
};

// Resuelve el alias de conexión contra el archivo de configuración local
function getConnection({ connection }) {
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

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function getAuthHeaders(conn, extraHeaders = {}) {
  const creds = Buffer.from(`${conn.user}:${conn.password}`).toString("base64");
  return {
    Authorization: `Basic ${creds}`,
    "sap-client": conn.client,
    Accept: "text/plain, application/xml, */*",
    ...extraHeaders,
  };
}

async function sapFetch(conn, path, options = {}) {
  const url = `${conn.host}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      ...getAuthHeaders(conn),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`SAP ADT error ${res.status}: ${errText.slice(0, 300)}`);
  }
  return res;
}

// SAP devuelve varias cabeceras Set-Cookie (SAP_SESSIONID_*, sap-contextid, ...).
// res.headers.get("set-cookie") las combina en un único string separado por ", ",
// lo cual rompe el valor porque atributos como "Expires=Wed, 21 Oct 2026..." ya
// contienen comas. Hay que leerlas por separado y quedarnos solo con "nombre=valor".
function extractCookies(res) {
  const rawCookies =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
  return rawCookies.map((c) => c.split(";")[0].trim()).filter(Boolean);
}

// Combina varios juegos de cookies quedándose con el valor más reciente de cada nombre
// (necesario para mantener viva la sesión stateful entre LOCK -> PUT -> UNLOCK).
function mergeCookies(...cookieArrays) {
  const map = new Map();
  for (const arr of cookieArrays) {
    for (const c of arr) {
      const eq = c.indexOf("=");
      const name = eq === -1 ? c : c.slice(0, eq);
      map.set(name, c);
    }
  }
  return [...map.values()].join("; ");
}

// Obtiene el CSRF token necesario para operaciones de escritura
async function getCsrfToken(conn) {
  const res = await sapFetch(conn, "/sap/bc/adt/discovery", {
    headers: { "X-CSRF-Token": "Fetch" },
  });
  const token = res.headers.get("x-csrf-token");
  if (!token) throw new Error("No se pudo obtener el CSRF token");

  const cookie = extractCookies(res).join("; ");

  return { token, cookie };
}

// Bloquea un objeto ABAP (requerido por ADT antes de poder modificar su fuente).
// Devuelve el lockHandle y las cookies de la sesión stateful que hay que reutilizar
// en el PUT y en el UNLOCK posteriores.
async function lockObject(conn, objectPath, csrfToken, cookie) {
  const res = await sapFetch(conn, `/sap/bc/adt/${objectPath}?_action=LOCK&accessMode=MODIFY`, {
    method: "POST",
    headers: {
      "X-CSRF-Token": csrfToken,
      "X-sap-adt-sessiontype": "stateful",
      Accept: "application/vnd.sap.as+xml; charset=UTF-8",
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
  const body = await res.text();
  const lockHandleMatch = body.match(/<LOCK_HANDLE>([^<]*)<\/LOCK_HANDLE>/);
  if (!lockHandleMatch) {
    throw new Error(`No se pudo obtener LOCK_HANDLE: ${body.slice(0, 300)}`);
  }
  const sessionCookie = mergeCookies(cookie ? cookie.split("; ") : [], extractCookies(res));
  return { lockHandle: lockHandleMatch[1], cookie: sessionCookie };
}

// Desbloquea un objeto ABAP previamente bloqueado con lockObject.
async function unlockObject(conn, objectPath, lockHandle, csrfToken, cookie) {
  await sapFetch(conn, `/sap/bc/adt/${objectPath}?_action=UNLOCK&lockHandle=${encodeURIComponent(lockHandle)}`, {
    method: "POST",
    headers: {
      "X-CSRF-Token": csrfToken,
      "X-sap-adt-sessiontype": "stateful",
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
}

// Consulta el estado de transporte de un objeto ABAP usando el endpoint de
// "transport checks" de ADT. Si el objeto ya está bloqueado/asignado a una
// orden (p.ej. porque alguien empezó a modificarlo antes), esa orden aparece
// en el bloque LOCKS de la respuesta. También devuelve, si los hay, otras
// órdenes abiertas del usuario que serían candidatas para el objeto.
async function getObjectTransport(conn, objectUri, csrfToken, cookie) {
  // Formato ABAP-XML que espera este endpoint (igual que usa Eclipse ADT):
  // un documento asx:abap con DATA/OPERATION, DATA/URI y DATA/DEVCLASS.
  const requestXml = `<?xml version="1.0" encoding="UTF-8"?>
<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
    <DATA>
      <OPERATION>I</OPERATION>
      <URI>${objectUri}</URI>
      <DEVCLASS/>
    </DATA>
  </asx:values>
</asx:abap>`;

  const mimeType = "application/vnd.sap.as+xml; charset=UTF-8; dataname=com.sap.adt.transport.service.checkData";
  const res = await sapFetch(conn, "/sap/bc/adt/cts/transportchecks", {
    method: "POST",
    headers: {
      "X-CSRF-Token": csrfToken,
      "Content-Type": mimeType,
      Accept: mimeType,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: requestXml,
  });
  const xml = await res.text();

  // La orden a la que el objeto ya está asignado/bloqueado viene dentro de un
  // bloque de "lock" (p.ej. <LOCKS>...<CTS_OBJECT_LOCK>...<TRKORR>NNN</TRKORR>).
  const lockBlockMatch = xml.match(/<LOCKS>[\s\S]*?<\/LOCKS>/i) || xml.match(/<CTS_OBJECT_LOCK>[\s\S]*?<\/CTS_OBJECT_LOCK>/i);
  const assignedTransport = lockBlockMatch ? lockBlockMatch[0].match(/<TRKORR>([^<]+)<\/TRKORR>/)?.[1] || null : null;

  // El resto de <TRKORR> del documento son órdenes abiertas candidatas
  // (todavía no asignadas a este objeto) que el usuario podría usar.
  const candidateTransports = [];
  const trkorrRegex = /<TRKORR>([^<]+)<\/TRKORR>/g;
  let m;
  while ((m = trkorrRegex.exec(xml)) !== null) {
    const trkorr = m[1];
    if (trkorr === assignedTransport) continue;
    if (candidateTransports.some((c) => c.trkorr === trkorr)) continue;
    const windowText = xml.slice(m.index, m.index + 400);
    const desc = windowText.match(/<(?:AS4TEXT|DESCRIPTION|TARGET_DESC)>([^<]*)<\/(?:AS4TEXT|DESCRIPTION|TARGET_DESC)>/)?.[1] || "";
    candidateTransports.push({ trkorr, desc });
  }

  return { assignedTransport, candidateTransports, rawXml: xml };
}

// Mapea tipo de objeto ABAP a su ruta ADT
function getAdtPath(objectType) {
  const map = {
    PROG: "programs/programs",
    CLAS: "oo/classes",
    FUGR: "functions/groups",
    FUNC: "functions/fmodules",
    TABL: "ddic/tables",
    VIEW: "ddic/views",
    DTEL: "ddic/dataelements",
    DOMA: "ddic/domains",
    INTF: "oo/interfaces",
    REPS: "programs/includes",
  };
  return map[objectType.toUpperCase()] || "programs/programs";
}

// Resuelve la ruta ADT completa de un objeto (sin /source/main). Los módulos de
// función (FUNC) no cuelgan directamente de "functions/fmodules/{name}": ADT los
// expone bajo su grupo de funciones contenedor, functions/groups/{grupo}/fmodules/{name}.
function getObjectPath(objectType, objectName, functionGroup) {
  const name = objectName.toLowerCase();
  if (objectType.toUpperCase() === "FUNC") {
    if (!functionGroup) {
      throw new Error("Para objetos FUNC hace falta indicar function_group (el grupo de funciones que contiene el módulo).");
    }
    return `functions/groups/${functionGroup.toLowerCase()}/fmodules/${name}`;
  }
  return `${getAdtPath(objectType)}/${name}`;
}

// ─────────────────────────────────────────────
// DEBUGGER — helpers y estado de sesión
// ─────────────────────────────────────────────
// El debugger de ADT es el mismo protocolo (no documentado oficialmente) que usa
// Eclipse. Es stateful: hace falta un terminalId/ideId estables, breakpoints
// registrados con esos IDs, un listener en long-poll que se desbloquea cuando la
// ejecución choca con un breakpoint, y luego attach/stack/variables/step sobre esa
// misma sesión (mismas cookies). Se guarda una sesión de debug por conexión
// (host+client+user), en memoria del proceso del servidor MCP.
const debugSessions = new Map();

function debugSessionKey(conn) {
  return `${conn.host}|${conn.client}|${conn.user}`;
}

function getOrCreateDebugSession(conn) {
  const key = debugSessionKey(conn);
  let session = debugSessions.get(key);
  if (!session) {
    session = {
      terminalId: randomUUID(),
      ideId: randomUUID(),
      cookie: "",
      csrfToken: "",
      breakpoints: [],
    };
    debugSessions.set(key, session);
  }
  return session;
}

async function ensureDebugSession(conn, session) {
  if (session.csrfToken) return;
  const { token, cookie } = await getCsrfToken(conn);
  session.csrfToken = token;
  session.cookie = cookie;
}

function escapeXml(str) {
  return String(str).replace(/[<>&"']/g, (c) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;",
  }[c]));
}

function buildQueryString(qs) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(qs || {})) {
    if (v === undefined || v === null || v === "") continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

// Petición al debugger ADT: siempre stateful, reutiliza y actualiza las cookies de
// sesión guardadas en `session`, y admite timeout propio (para el long-poll del listener).
async function debugFetch(conn, session, path, { method = "GET", qs, headers = {}, body, timeoutMs } = {}) {
  const url = `${conn.host}${path}${buildQueryString(qs)}`;
  const controller = timeoutMs ? new AbortController() : undefined;
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    const res = await fetch(url, {
      method,
      signal: controller?.signal,
      headers: {
        ...getAuthHeaders(conn),
        "X-sap-adt-sessiontype": "stateful",
        ...(session.csrfToken ? { "X-CSRF-Token": session.csrfToken } : {}),
        ...(session.cookie ? { Cookie: session.cookie } : {}),
        ...headers,
      },
      body,
    });
    session.cookie = mergeCookies(session.cookie ? session.cookie.split("; ") : [], extractCookies(res));
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`SAP ADT debugger error ${res.status}: ${errText.slice(0, 500)}`);
    }
    return res;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Parsers XML minimalistas (regex) — suficiente para esta API sin añadir una
// dependencia de parseo XML completa.
function parseXmlAttrs(attrsRaw) {
  const attrs = {};
  const re = /([\w:.-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(attrsRaw)) !== null) {
    const name = m[1].includes(":") ? m[1].split(":").pop() : m[1];
    attrs[name] = m[2];
  }
  return attrs;
}

function extractTagBlocks(xml, tagLocalName) {
  const re = new RegExp(`<(?:\\w+:)?${tagLocalName}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:\\w+:)?${tagLocalName}>)`, "g");
  const blocks = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    blocks.push({ attrs: parseXmlAttrs(m[1] || ""), inner: m[2] || "" });
  }
  return blocks;
}

function extractChildTagValues(xml) {
  const values = {};
  const re = /<(\w+)>([^<]*)<\/\1>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    values[m[1]] = m[2];
  }
  return values;
}

// Convierte la respuesta XML (orientada a columnas) del servicio de datapreview de
// ADT en un array de filas { NOMBRE_COLUMNA: valor }.
function parseDataPreviewTable(xml) {
  const columns = extractTagBlocks(xml, "columns").map((block) => {
    const nameMatch = block.inner.match(/name="([^"]+)"/);
    const name = nameMatch ? nameMatch[1] : "?";
    const values = extractTagBlocks(block.inner, "data").map((d) => d.inner);
    return { name, values };
  });
  const rowCount = columns.length ? Math.max(...columns.map((c) => c.values.length)) : 0;
  const rows = [];
  for (let i = 0; i < rowCount; i++) {
    const row = {};
    for (const col of columns) row[col.name] = col.values[i] ?? "";
    rows.push(row);
  }
  return rows;
}

// Ejecuta una sentencia OpenSQL de solo lectura vía el servicio "SQL Console" de ADT
// y devuelve las filas ya parseadas.
async function runSqlQuery(conn, sql, rowNumber = 100) {
  const { token: csrfToken, cookie } = await getCsrfToken(conn);
  const res = await sapFetch(conn, `/sap/bc/adt/datapreview/freestyle?rowNumber=${rowNumber}`, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
      "X-CSRF-Token": csrfToken,
      Accept: "application/*",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: sql,
  });
  const xml = await res.text();
  return parseDataPreviewTable(xml);
}

// El SID no viene en /sap/bc/adt/discovery (es solo un documento Atom de servicios,
// sin ese dato). Se obtiene del LOGSYS de T000, que sigue el patrón "<SID>CLNT<mandante>".
async function getSystemId(conn) {
  try {
    const rows = await runSqlQuery(conn, `SELECT LOGSYS FROM T000 WHERE MANDT = '${conn.client}'`, 1);
    const logsys = rows[0]?.LOGSYS || "";
    return logsys.replace(new RegExp(`CLNT${conn.client}$`), "") || "desconocido";
  } catch {
    return "desconocido";
  }
}

// Reenvía a SAP la lista completa de breakpoints de la sesión (modo "full sync":
// sustituye cualquier breakpoint anterior de este terminalId/ideId por esta lista,
// así que para "borrar todos" basta con llamar con session.breakpoints = []).
async function postBreakpoints(conn, session) {
  const breakpointsXml = session.breakpoints
    .map((bp) => {
      const adtPath = getAdtPath(bp.object_type);
      const name = bp.object_name.toLowerCase();
      const uri = `/sap/bc/adt/${adtPath}/${name}/source/main#start=${bp.line}`;
      const conditionAttr = bp.condition ? ` condition="${escapeXml(bp.condition)}"` : "";
      return `<breakpoint xmlns:adtcore="http://www.sap.com/adt/core" kind="line" clientId="${session.terminalId}" skipCount="0" adtcore:uri="${uri}"${conditionAttr}/>`;
    })
    .join("");

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<dbg:breakpoints scope="external" debuggingMode="user" requestUser="${conn.user.toUpperCase()}" terminalId="${session.terminalId}" ideId="${session.ideId}" systemDebugging="false" deactivated="false" xmlns:dbg="http://www.sap.com/adt/debugger">
  <syncScope mode="full"></syncScope>
  ${breakpointsXml}
</dbg:breakpoints>`;

  const res = await debugFetch(conn, session, "/sap/bc/adt/debugger/breakpoints", {
    method: "POST",
    headers: { "Content-Type": "application/xml", Accept: "application/xml" },
    body,
  });
  return res.text();
}

async function debugGetStack(conn, session) {
  const res = await debugFetch(conn, session, "/sap/bc/adt/debugger/stack", {
    qs: { method: "getStack", emode: "_", semanticURIs: true },
    headers: { Accept: "application/xml" },
  });
  const xml = await res.text();
  return extractTagBlocks(xml, "stackEntry").map((b) => b.attrs);
}

async function debugGetVariables(conn, session, parents, children = false) {
  const tag = children ? "STPDA_ADT_VARIABLE_HIERARCHY" : "STPDA_ADT_VARIABLE";
  const idTag = children ? "PARENT_ID" : "ID";
  const mainBody = parents.map((p) => `<${tag}><${idTag}>${escapeXml(p)}</${idTag}></${tag}>`).join("");
  const dataInner = children ? `<HIERARCHIES>${mainBody}</HIERARCHIES>` : mainBody;
  const dataname = children ? "com.sap.adt.debugger.ChildVariables" : "com.sap.adt.debugger.Variables";
  const body = `<?xml version="1.0" encoding="UTF-8" ?><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA>${dataInner}</DATA></asx:values></asx:abap>`;

  const res = await debugFetch(conn, session, "/sap/bc/adt/debugger", {
    method: "POST",
    qs: { method: children ? "getChildVariables" : "getVariables" },
    headers: {
      Accept: `application/vnd.sap.as+xml;charset=UTF-8;dataname=${dataname}`,
      "Content-Type": `application/vnd.sap.as+xml; charset=UTF-8; dataname=${dataname}`,
    },
    body,
  });
  const xml = await res.text();
  return extractTagBlocks(xml, "STPDA_ADT_VARIABLE").map((b) => extractChildTagValues(b.inner));
}

function formatStack(stack) {
  if (!stack.length) return "(sin call stack disponible)";
  return stack
    .map((s, i) => `  ${i === 0 ? "▶" : " "} #${s.stackPosition ?? i} ${s.programName || "?"} / ${s.includeName || "?"} línea ${s.line || "?"}`)
    .join("\n");
}

function formatVariables(vars) {
  if (!vars.length) return "(sin variables)";
  return vars
    .map((v) => `  ${v.NAME || "?"} = ${v.VALUE ?? ""}  [${v.DECLARED_TYPE_NAME || v.ACTUAL_TYPE_NAME || "?"}]${v.ID ? ` (id: ${v.ID})` : ""}`)
    .join("\n");
}

// ─────────────────────────────────────────────
// SERVIDOR MCP
// ─────────────────────────────────────────────
const server = new McpServer({
  name: "sap-abap-mcp",
  version: "1.0.0",
});

// ─────────────────────────────────────────────
// TOOL 1: Leer código fuente de un objeto ABAP
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// TOOL 2: Escribir/actualizar código fuente
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// TOOL 2b: Consultar la orden de transporte de un objeto
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// TOOL 3: Activar objeto ABAP
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// TOOL 4: Buscar objetos ABAP por nombre/patrón
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// TOOL 5: Leer contenido de una tabla SAP
// ─────────────────────────────────────────────
server.tool(
  "read_table_data",
  "Lee registros de una tabla SAP usando el servicio de queries ADT (solo para tablas con pocos registros o con filtro WHERE)",
  {
    ...connectionParams,
    table_name: z.string().describe("Nombre de la tabla SAP, ej: MARA, T001, USR02"),
    fields: z.string().optional().describe("Campos a leer separados por coma, ej: MATNR,MTART,MBRSH. Si no se indica, lee todos."),
    where_clause: z.string().optional().describe("Condición WHERE en sintaxis ABAP, ej: MTART EQ 'FERT' AND MBRSH EQ 'M'"),
    max_rows: z.number().optional().default(50).describe("Número máximo de filas (default: 50)"),
  },
  async (args) => {
    const { table_name, fields, where_clause, max_rows } = args;
    try {
      const conn = getConnection(args);
      const { token: csrfToken, cookie } = await getCsrfToken(conn);

      // Servicio "SQL Console" de ADT: recibe una sentencia OpenSQL en texto plano.
      const selectFields = fields ? fields.replace(/\s+/g, "") : "*";
      let sql = `SELECT ${selectFields} FROM ${table_name.toUpperCase()}`;
      if (where_clause) sql += ` WHERE ${where_clause}`;

      const res = await sapFetch(conn, `/sap/bc/adt/datapreview/freestyle?rowNumber=${max_rows}`, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "X-CSRF-Token": csrfToken,
          Accept: "application/*",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: sql,
      });

      const xml = await res.text();
      return { content: [{ type: "text", text: xml }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
    }
  }
);

// ─────────────────────────────────────────────
// TOOL 6: Ejecutar un programa ABAP (report)
// ─────────────────────────────────────────────
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

// ─────────────────────────────────────────────
// TOOL 6b: Listar conexiones SAP configuradas
// ─────────────────────────────────────────────
server.tool(
  "list_connections",
  `Lista los alias de conexión SAP disponibles (definidos en ${CONFIG_PATH}), sin exponer las contraseñas.`,
  {},
  async () => {
    try {
      const config = loadConnectionsConfig();
      const aliases = Object.keys(config);
      if (aliases.length === 0) {
        return { content: [{ type: "text", text: "No hay ninguna conexión configurada todavía." }] };
      }
      const lines = aliases.map((alias) => {
        const c = config[alias];
        return `- ${alias}: ${c.user}@${c.host} (mandante ${c.client})`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
    }
  }
);

// ─────────────────────────────────────────────
// TOOL 7: Verificar conexión y estado del sistema
// ─────────────────────────────────────────────
server.tool(
  "check_connection",
  "Comprueba que la conexión con el sistema SAP está activa y devuelve información del sistema",
  { ...connectionParams },
  async (args) => {
    try {
      const conn = getConnection(args);
      await sapFetch(conn, "/sap/bc/adt/discovery", {
        headers: { Accept: "application/atomsvc+xml" },
      });
      const sid = await getSystemId(conn);

      return {
        content: [{
          type: "text",
          text: `✅ Conexión OK\n🖥️  Host: ${conn.host}\n🏷️  Sistema: ${sid}\n👤  Usuario: ${conn.user}\n📦  Mandante: ${conn.client}`,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `❌ Error de conexión: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ─────────────────────────────────────────────
// TOOL 7b: Especificaciones del sistema (release SAP/ABAP, componentes instalados)
// ─────────────────────────────────────────────
server.tool(
  "get_system_specs",
  "Obtiene las especificaciones del sistema SAP conectado: SID, mandante, y el release de SAP_BASIS/ABAP y demás componentes instalados (vía tabla CVERS). Útil para saber contra qué versión de ABAP/SAP se está desarrollando antes de generar código (p.ej. sintaxis nueva solo disponible desde cierto release).",
  { ...connectionParams },
  async (args) => {
    try {
      const conn = getConnection(args);
      const sid = await getSystemId(conn);

      const components = await runSqlQuery(
        conn,
        "SELECT COMPONENT,RELEASE,EXTRELEASE FROM CVERS",
        100
      );

      const basis = components.find((c) => c.COMPONENT === "SAP_BASIS");

      const lines = [
        `🖥️  Host: ${conn.host}`,
        `🏷️  Sistema (SID): ${sid}`,
        `📦  Mandante: ${conn.client}`,
        `👤  Usuario: ${conn.user}`,
        "",
      ];

      if (basis) {
        lines.push(`⚙️  Release SAP_BASIS (ABAP): ${basis.RELEASE} ${basis.EXTRELEASE || ""}`.trim());
        lines.push("");
      }

      lines.push("Componentes instalados (tabla CVERS):");
      lines.push(`${"COMPONENT".padEnd(20)} | ${"RELEASE".padEnd(10)} | EXTRELEASE`);
      lines.push("-".repeat(50));
      for (const c of components) {
        lines.push(`${(c.COMPONENT || "").padEnd(20)} | ${(c.RELEASE || "").padEnd(10)} | ${c.EXTRELEASE || ""}`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
    }
  }
);

// ─────────────────────────────────────────────
// TOOL 8: Fijar un breakpoint de debug
// ─────────────────────────────────────────────
server.tool(
  "debug_set_breakpoint",
  "Fija un breakpoint de línea en un programa/include ABAP para una futura sesión de debug (usar junto con debug_wait_for_breakpoint). Se pueden fijar varios llamando repetidas veces.",
  {
    ...connectionParams,
    object_name: z.string().describe("Nombre del programa o include, ej: ZPRUEBA_TIENDA"),
    object_type: z.string().optional().default("PROG").describe("Tipo de objeto: PROG o REPS (include)"),
    line: z.number().describe("Número de línea donde parar"),
    condition: z.string().optional().describe("Condición ABAP opcional para el breakpoint, ej: p_id = 'X'"),
  },
  async (args) => {
    const { object_name, object_type, line, condition } = args;
    try {
      const conn = getConnection(args);
      const session = getOrCreateDebugSession(conn);
      await ensureDebugSession(conn, session);

      session.breakpoints.push({ object_name, object_type, line, condition });
      const rawXml = await postBreakpoints(conn, session);

      return {
        content: [{
          type: "text",
          text: `✅ Breakpoint fijado en ${object_name} línea ${line}.\nBreakpoints activos en esta sesión: ${session.breakpoints.length}\nAhora ejecuta el programa (SAP GUI, o run_abap_report) y llama a debug_wait_for_breakpoint.\n\nRespuesta cruda de SAP (para depurar si no salta):\n${rawXml}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
    }
  }
);

// ─────────────────────────────────────────────
// TOOL 9: Limpiar breakpoints
// ─────────────────────────────────────────────
server.tool(
  "debug_clear_breakpoints",
  "Elimina todos los breakpoints fijados en la sesión de debug actual",
  { ...connectionParams },
  async (args) => {
    try {
      const conn = getConnection(args);
      const session = getOrCreateDebugSession(conn);
      await ensureDebugSession(conn, session);
      session.breakpoints = [];
      await postBreakpoints(conn, session);
      return { content: [{ type: "text", text: "🧹 Breakpoints eliminados." }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
    }
  }
);

// ─────────────────────────────────────────────
// TOOL 10: Esperar a que salte un breakpoint (long-poll)
// ─────────────────────────────────────────────
server.tool(
  "debug_wait_for_breakpoint",
  "Espera (long-poll) a que la ejecución choque con alguno de los breakpoints fijados con debug_set_breakpoint. Al detenerse, hace attach automático y devuelve la línea actual, el call stack y las variables locales. Si no salta ningún breakpoint dentro del timeout, hay que volver a llamarla.",
  {
    ...connectionParams,
    timeout_seconds: z.number().optional().default(60).describe("Segundos máximos de espera (se acota entre 5 y 240, por defecto 60)"),
  },
  async (args) => {
    const { timeout_seconds } = args;
    try {
      const conn = getConnection(args);
      const session = getOrCreateDebugSession(conn);
      await ensureDebugSession(conn, session);

      if (session.breakpoints.length === 0) {
        return { content: [{ type: "text", text: "⚠️ No hay breakpoints activos. Usa primero debug_set_breakpoint." }] };
      }

      const clamped = Math.min(Math.max(timeout_seconds ?? 60, 5), 240);

      // Chequeo previo (no bloqueante) para detectar conflictos antes del long-poll
      let conflictXml = "";
      try {
        const checkRes = await debugFetch(conn, session, "/sap/bc/adt/debugger/listeners", {
          qs: {
            debuggingMode: "user",
            requestUser: conn.user.toUpperCase(),
            terminalId: session.terminalId,
            ideId: session.ideId,
            checkConflict: true,
          },
        });
        conflictXml = await checkRes.text();
      } catch (err) {
        conflictXml = `(chequeo de conflicto falló: ${err.message})`;
      }

      let listenRes;
      try {
        listenRes = await debugFetch(conn, session, "/sap/bc/adt/debugger/listeners", {
          method: "POST",
          qs: {
            debuggingMode: "user",
            requestUser: conn.user.toUpperCase(),
            terminalId: session.terminalId,
            ideId: session.ideId,
            checkConflict: true,
            isNotifiedOnConflict: true,
          },
          timeoutMs: clamped * 1000,
        });
      } catch (err) {
        if (err.name === "AbortError") {
          return {
            content: [{
              type: "text",
              text: `⏱️ Ningún breakpoint alcanzado en ${clamped}s. Ejecuta el programa y vuelve a llamar a debug_wait_for_breakpoint.\n\nChequeo de conflicto/listener previo (para depurar):\n${conflictXml}\n\nBreakpoints activos (terminalId=${session.terminalId}, ideId=${session.ideId}):\n${JSON.stringify(session.breakpoints)}`,
            }],
          };
        }
        throw err;
      }

      const listenXml = await listenRes.text();
      if (!listenXml.trim()) {
        return { content: [{ type: "text", text: "El listener devolvió una respuesta vacía. Vuelve a intentarlo." }] };
      }

      const debuggeeFields = extractChildTagValues(listenXml);
      const debuggeeId = debuggeeFields.DEBUGGEE_ID || debuggeeFields.ID || "";

      // Attach a la sesión detenida en el breakpoint
      const attachRes = await debugFetch(conn, session, "/sap/bc/adt/debugger", {
        method: "POST",
        qs: {
          method: "attach",
          debuggeeId,
          dynproDebugging: true,
          debuggingMode: "user",
          requestUser: conn.user.toUpperCase(),
        },
        headers: { Accept: "application/xml" },
      });
      const attachXml = await attachRes.text();

      const stack = await debugGetStack(conn, session);
      const vars = await debugGetVariables(conn, session, ["@ROOT"]);

      const top = stack[0] || {};
      const lines = [
        `🔴 Breakpoint alcanzado en ${top.programName || "?"} / ${top.includeName || "?"}, línea ${top.line || "?"}`,
        "",
        "Call stack:",
        formatStack(stack),
        "",
        "Variables locales (@ROOT):",
        formatVariables(vars),
      ];

      if (!debuggeeId) {
        lines.push(
          "",
          "⚠️ No se pudo identificar el debuggeeId automáticamente en la respuesta del listener; el attach puede no haberse completado. XML crudo del listener (para depurar):",
          listenXml.slice(0, 1500),
          "",
          "XML crudo del attach:",
          attachXml.slice(0, 1500)
        );
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
    }
  }
);

// ─────────────────────────────────────────────
// TOOL 11: Step (avanzar la ejecución)
// ─────────────────────────────────────────────
server.tool(
  "debug_step",
  "Avanza la ejecución en una sesión de debug ya detenida en un breakpoint (tras debug_wait_for_breakpoint) y devuelve la nueva línea, call stack y variables.",
  {
    ...connectionParams,
    action: z.enum(["stepInto", "stepOver", "stepReturn", "stepContinue", "terminateDebuggee"]).optional().default("stepOver").describe("Tipo de paso: stepInto, stepOver, stepReturn, stepContinue o terminateDebuggee"),
  },
  async (args) => {
    const { action } = args;
    try {
      const conn = getConnection(args);
      const session = getOrCreateDebugSession(conn);
      if (!session.csrfToken) {
        return { content: [{ type: "text", text: "⚠️ No hay ninguna sesión de debug activa (usa debug_set_breakpoint + debug_wait_for_breakpoint primero)." }] };
      }

      await debugFetch(conn, session, "/sap/bc/adt/debugger", {
        method: "POST",
        qs: { method: action },
        headers: { Accept: "application/xml" },
      });

      if (action === "terminateDebuggee") {
        return { content: [{ type: "text", text: "🛑 Ejecución del debuggee terminada." }] };
      }

      const stack = await debugGetStack(conn, session);
      const vars = await debugGetVariables(conn, session, ["@ROOT"]);
      const top = stack[0] || {};

      const lines = [
        `▶️ ${action} ejecutado. Ahora en ${top.programName || "?"} / ${top.includeName || "?"}, línea ${top.line || "?"}`,
        "",
        "Call stack:",
        formatStack(stack),
        "",
        "Variables locales (@ROOT):",
        formatVariables(vars),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
    }
  }
);

// ─────────────────────────────────────────────
// TOOL 12: Consultar variables concretas
// ─────────────────────────────────────────────
server.tool(
  "debug_get_variables",
  "Consulta el valor de variables concretas (o sus hijos, para estructuras/tablas internas) en la sesión de debug detenida actual",
  {
    ...connectionParams,
    names: z.array(z.string()).optional().default(["@ROOT"]).describe("Nombres/IDs de variable a consultar. @ROOT devuelve las variables locales del contexto actual."),
    children: z.boolean().optional().default(false).describe("Si es true, devuelve los hijos (campos de estructura o filas de tabla interna) de los IDs indicados en vez de sus valores directos"),
  },
  async (args) => {
    const { names, children } = args;
    try {
      const conn = getConnection(args);
      const session = getOrCreateDebugSession(conn);
      if (!session.csrfToken) {
        return { content: [{ type: "text", text: "⚠️ No hay ninguna sesión de debug activa." }] };
      }
      const vars = await debugGetVariables(conn, session, names, children);
      return { content: [{ type: "text", text: formatVariables(vars) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
    }
  }
);

// ─────────────────────────────────────────────
// TOOL 13: Detener la sesión de debug
// ─────────────────────────────────────────────
server.tool(
  "debug_stop",
  "Detiene la sesión de debug: limpia todos los breakpoints y da de baja el listener registrado",
  { ...connectionParams },
  async (args) => {
    try {
      const conn = getConnection(args);
      const key = debugSessionKey(conn);
      const session = debugSessions.get(key);
      if (!session) {
        return { content: [{ type: "text", text: "No había ninguna sesión de debug activa." }] };
      }

      session.breakpoints = [];
      await postBreakpoints(conn, session).catch(() => {});

      await debugFetch(conn, session, "/sap/bc/adt/debugger/listeners", {
        method: "DELETE",
        qs: {
          debuggingMode: "user",
          requestUser: conn.user.toUpperCase(),
          terminalId: session.terminalId,
          ideId: session.ideId,
          checkConflict: false,
          notifyConflict: true,
        },
      }).catch(() => {});

      debugSessions.delete(key);
      return { content: [{ type: "text", text: "🧹 Sesión de debug detenida y breakpoints eliminados." }] };
    } catch (err) {
      return { content: [{ type: "text", text: `ERROR: ${err.message}` }], isError: true };
    }
  }
);

// ─────────────────────────────────────────────
// ARRANQUE
// ─────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("🚀 SAP ABAP MCP Server arrancado y escuchando...");
}

main().catch((err) => {
  console.error("Error fatal:", err);
  process.exit(1);
});
