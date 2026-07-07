// Parsers XML minimalistas (regex) — suficiente para las respuestas de ADT sin
// añadir una dependencia de parseo XML completa.

export function buildQueryString(qs) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(qs || {})) {
    if (v === undefined || v === null || v === "") continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

// Formato de timestamp que espera el servicio ADT de dumps (runtime/dumps): YYYYMMDDHHMMSS.
export function formatAdtTimestamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function parseXmlAttrs(attrsRaw) {
  const attrs = {};
  const re = /([\w:.-]+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(attrsRaw)) !== null) {
    const name = m[1].includes(":") ? m[1].split(":").pop() : m[1];
    attrs[name] = m[2];
  }
  return attrs;
}

export function extractTagBlocks(xml, tagLocalName) {
  const re = new RegExp(`<(?:\\w+:)?${tagLocalName}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</(?:\\w+:)?${tagLocalName}>)`, "g");
  const blocks = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    blocks.push({ attrs: parseXmlAttrs(m[1] || ""), inner: m[2] || "" });
  }
  return blocks;
}

// Tolerante a prefijos de namespace (<d:Uri>valor</d:Uri>) y a atributos en la
// etiqueta de apertura.
export function extractChildTagValuesNS(xml) {
  const values = {};
  const re = /<(?:[\w.-]+:)?([\w.-]+)(?:\s[^>]*)?>([^<]*)<\/(?:[\w.-]+:)?\1>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    values[m[1]] = m[2];
  }
  return values;
}

// Convierte la respuesta XML (orientada a columnas) del servicio de datapreview de
// ADT en un array de filas { NOMBRE_COLUMNA: valor }.
export function parseDataPreviewTable(xml) {
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
