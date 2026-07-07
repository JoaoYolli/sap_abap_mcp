// Consultas OpenSQL de solo lectura vía el servicio "SQL Console" de ADT.
// Compartido entre las tools de base de datos (db.js) y las de sistema (basis.js).
import { sapFetch, getCsrfToken } from "./http.js";
import { parseDataPreviewTable } from "./xml.js";

export async function runSqlQuery(conn, sql, rowNumber = 100) {
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
export async function getSystemId(conn) {
  try {
    const rows = await runSqlQuery(conn, `SELECT LOGSYS FROM T000 WHERE MANDT = '${conn.client}'`, 1);
    const logsys = rows[0]?.LOGSYS || "";
    return logsys.replace(new RegExp(`CLNT${conn.client}$`), "") || "desconocido";
  } catch {
    return "desconocido";
  }
}
