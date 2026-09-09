// Proxy inverso local para abrir SAP GUI para HTML (WebGUI,
// /sap/bc/gui/sap/its/webgui) en un navegador normal, sin que el host real
// del servidor ni las credenciales pasen nunca por el agente/la conversación:
//
//   Chrome --> http://localhost:<puerto>/...  (esto es lo único que ve el agente)
//     --> este proceso (resuelve el alias vía Keeper, igual que getConnection,
//         y guarda host/usuario/contraseña SOLO en su propia memoria)
//       --> https://<host-real>/...  (Authorization: Basic ... inyectado aquí)
//
// Se ejecuta en su propia ventana de terminal (ver start-webgui.bat), nunca
// dentro del proceso del servidor MCP ni de una tool invocada por el agente:
// así el agente jamás ve el JSON de credenciales que sí ve este proceso.
//
// Rollback: cierra esta ventana (o Ctrl+C). No escribe nada en disco, no deja
// perfil de navegador, no toca /etc/hosts ni ningún archivo del repo — parar
// el proceso deja el sistema exactamente como estaba antes.
import http from "node:http";
import https from "node:https";
import { getConnection } from "../lib/connection.js";

const [, , alias, portArg, transaction] = process.argv;
if (!alias) {
  console.error("Uso: node webgui-proxy.js <alias> [puerto] [transaccion]");
  process.exit(1);
}
const PORT = Number(portArg) || 4728;

async function main() {
  const conn = await getConnection({ connection: alias });
  const target = new URL(conn.host);
  const isHttps = target.protocol === "https:";
  const client = isHttps ? https : http;
  const targetPort = target.port || (isHttps ? 443 : 80);
  const authHeader = "Basic " + Buffer.from(`${conn.user}:${conn.password}`).toString("base64");
  const localOrigin = `http://localhost:${PORT}`;

  const server = http.createServer((req, res) => {
    // Ruta de entrada cómoda: "/" te lleva directo a WebGUI con el mandante
    // correcto ya puesto, sin que quien navega tenga que saberlo.
    if (req.url === "/") {
      const qs = new URLSearchParams({ "sap-client": conn.client });
      if (transaction) qs.set("~transaction", transaction);
      res.writeHead(302, { Location: `/sap/bc/gui/sap/its/webgui?${qs}` });
      res.end();
      return;
    }

    // Identificación del proxy ya en marcha: permite al agente comprobar a
    // qué alias/mandante está atado ESTE proceso antes de decidir si lo
    // reutiliza (navegando a otra transacción con la misma sesión) o si
    // hace falta relanzarlo para un alias distinto. Nunca expone
    // host/usuario/contraseña, solo el alias que se le pasó como argumento.
    if (req.url === "/__sapmcp_proxy_info") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ alias, client: conn.client, port: PORT }));
      return;
    }

    const headers = { ...req.headers };
    delete headers["host"];
    delete headers["origin"];
    headers["host"] = target.host;
    headers["authorization"] = authHeader; // credenciales inyectadas aquí, nunca las ve el navegador ni el agente

    const proxyReq = client.request(
      { hostname: target.hostname, port: targetPort, path: req.url, method: req.method, headers },
      (proxyRes) => {
        const resHeaders = { ...proxyRes.headers };
        // Cualquier redirect/URL absoluta que el backend devuelva apuntando al
        // host real se reescribe a localhost, para que ese host nunca llegue
        // a aparecer en la barra de direcciones ni en las tools de pestañas.
        if (resHeaders.location) {
          resHeaders.location = resHeaders.location.replace(target.origin, localOrigin);
        }
        delete resHeaders["content-security-policy"];
        delete resHeaders["x-frame-options"];
        res.writeHead(proxyRes.statusCode, resHeaders);
        proxyRes.pipe(res);
      }
    );
    proxyReq.on("error", (err) => {
      res.writeHead(502);
      res.end(`Proxy error: ${err.message}`);
    });
    req.pipe(proxyReq);
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`✅ Proxy WebGUI activo: ${localOrigin}/  (conexión "${alias}")`);
    console.log("   Cierra esta ventana (o Ctrl+C) para desconectar — rollback total, no queda nada en disco.");
  });
}

main().catch((err) => {
  console.error("Error fatal:", err.message);
  process.exit(1);
});
