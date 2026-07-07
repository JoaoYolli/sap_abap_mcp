// Cliente mínimo para el gateway SOAP RFC clásico de SAP (/sap/bc/soap/rfc),
// un servicio estándar del kernel (no requiere desarrollo ABAP) que permite
// invocar cualquier módulo de función RFC-habilitado por HTTP plano.
import { sapFetch } from "./http.js";
import { escapeXml, extractTagBlocks, extractChildTagValuesNS } from "./xml.js";

// params: objeto { NOMBRE_PARAMETRO: valor } para IMPORTING.
// tableNames: nombres de parámetros TABLES/EXPORTING-table cuyas filas queremos recibir.
export async function callRfcFunction(conn, functionName, params = {}, tableNames = []) {
  const paramXml = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `<${k.toUpperCase()}>${escapeXml(v)}</${k.toUpperCase()}>`)
    .join("");
  const tablesXml = tableNames.map((t) => `<${t.toUpperCase()}></${t.toUpperCase()}>`).join("");

  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">
  <SOAP-ENV:Body>
    <n1:${functionName} xmlns:n1="urn:sap-com:document:sap:rfc:functions">${paramXml}${tablesXml}</n1:${functionName}>
  </SOAP-ENV:Body>
</SOAP-ENV:Envelope>`;

  const res = await sapFetch(conn, `/sap/bc/soap/rfc?sap-client=${conn.client}`, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"${functionName}"` },
    body: envelope,
  });
  const xml = await res.text();

  if (/:Fault>/.test(xml)) {
    const faultString = xml.match(/<faultstring>([\s\S]*?)<\/faultstring>/)?.[1] || xml.slice(0, 300);
    throw new Error(`RFC ${functionName} SOAP fault: ${faultString}`);
  }

  const responseMatch = xml.match(new RegExp(`<n1:${functionName}\\.Response[^>]*>([\\s\\S]*?)</n1:${functionName}\\.Response>`));
  let inner = responseMatch ? responseMatch[1] : "";

  const tables = {};
  for (const t of tableNames) {
    const tableMatch = inner.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i"));
    tables[t] = tableMatch ? extractTagBlocks(tableMatch[1], "item").map((b) => extractChildTagValuesNS(b.inner)) : [];
    inner = inner.replace(new RegExp(`<${t}[^>]*>[\\s\\S]*?</${t}>`, "i"), "");
  }

  const scalars = extractChildTagValuesNS(inner);
  return { scalars, tables };
}
