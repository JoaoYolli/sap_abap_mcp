// Instrucciones personales del usuario para el agente de sap-mcp: cualquier
// usuario puede pedir que se le guarden reglas propias (p. ej. "usa siempre
// la conexión de pruebas X") para que su agente las reciba automáticamente
// en cada sesión futura, sin repetirlas en el chat cada vez.
//
// Se guardan en el HOME del usuario del sistema operativo activo, fuera de
// este repo, para que sean:
// - persistentes entre versiones del MCP: actualizar/reinstalar el repo
//   (git pull, clonar de nuevo) no las toca, porque no viven dentro de él.
// - personales y solo locales: cada usuario de la máquina tiene su propio
//   ~/.sap-mcp, nunca se suben a git ni se comparten entre usuarios.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const INSTRUCTIONS_DIR = path.join(os.homedir(), ".sap-mcp");
const INSTRUCTIONS_FILE = path.join(INSTRUCTIONS_DIR, "instructions.json");

function readAll() {
  try {
    const raw = fs.readFileSync(INSTRUCTIONS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    // No existe el archivo todavía (primer uso) o está corrupto/vacío: no es
    // un error para el usuario, simplemente no hay instrucciones aún.
    return [];
  }
}

function writeAll(list) {
  fs.mkdirSync(INSTRUCTIONS_DIR, { recursive: true });
  fs.writeFileSync(INSTRUCTIONS_FILE, JSON.stringify(list, null, 2), "utf-8");
}

export function listPersonalInstructions() {
  return readAll();
}

export function addPersonalInstruction(text) {
  const list = readAll();
  const entry = { id: crypto.randomUUID(), text, createdAt: new Date().toISOString() };
  list.push(entry);
  writeAll(list);
  return entry;
}

export function removePersonalInstruction(id) {
  const list = readAll();
  const idx = list.findIndex((entry) => entry.id === id);
  if (idx === -1) return false;
  list.splice(idx, 1);
  writeAll(list);
  return true;
}

// Bloque de texto a inyectar en las `instructions` del servidor MCP (ver
// index.js) para que cualquier cliente las reciba automáticamente al
// arrancar, sin que el usuario tenga que pedirlas cada sesión. Se lee de
// forma síncrona porque el servidor MCP construye sus instructions una sola
// vez, de forma síncrona, al arrancar el proceso.
export function formatPersonalInstructionsBlock() {
  const list = readAll();
  if (list.length === 0) return "";
  const lines = list.map((entry) => `- ${entry.text}`).join("\n");
  return `\nInstrucciones personales de este usuario (guardadas en ${INSTRUCTIONS_FILE}; gestiónalas con las tools add_personal_instruction / list_personal_instructions / remove_personal_instruction, nunca editando ese archivo a mano):\n${lines}\n`;
}

export { INSTRUCTIONS_FILE, INSTRUCTIONS_DIR };
