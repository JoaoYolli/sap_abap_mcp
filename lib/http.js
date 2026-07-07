// Helpers genéricos de peticiones ADT: auth, fetch, cookies, CSRF, lock/unlock
// y resolución de rutas de objetos ABAP. Usados por todas las tools.

export function getAuthHeaders(conn, extraHeaders = {}) {
  const creds = Buffer.from(`${conn.user}:${conn.password}`).toString("base64");
  return {
    Authorization: `Basic ${creds}`,
    "sap-client": conn.client,
    Accept: "text/plain, application/xml, */*",
    ...extraHeaders,
  };
}

export async function sapFetch(conn, path, options = {}) {
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
export function extractCookies(res) {
  const rawCookies =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")] : []);
  return rawCookies.map((c) => c.split(";")[0].trim()).filter(Boolean);
}

// Combina varios juegos de cookies quedándose con el valor más reciente de cada nombre
// (necesario para mantener viva la sesión stateful entre LOCK -> PUT -> UNLOCK).
export function mergeCookies(...cookieArrays) {
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
export async function getCsrfToken(conn) {
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
export async function lockObject(conn, objectPath, csrfToken, cookie) {
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
export async function unlockObject(conn, objectPath, lockHandle, csrfToken, cookie) {
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
export async function getObjectTransport(conn, objectUri, csrfToken, cookie) {
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
export function getAdtPath(objectType) {
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
export function getObjectPath(objectType, objectName, functionGroup) {
  const name = objectName.toLowerCase();
  if (objectType.toUpperCase() === "FUNC") {
    if (!functionGroup) {
      throw new Error("Para objetos FUNC hace falta indicar function_group (el grupo de funciones que contiene el módulo).");
    }
    return `functions/groups/${functionGroup.toLowerCase()}/fmodules/${name}`;
  }
  return `${getAdtPath(objectType)}/${name}`;
}
