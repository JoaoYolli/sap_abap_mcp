// Tools para que cada usuario gestione sus propias instrucciones personales
// del agente sobre este MCP de SAP (ver lib/user-instructions.js para el
// porqué del almacenamiento en ~/.sap-mcp, fuera de este repo). Estas tools
// solo tocan ese archivo local: no hay credenciales ni conexión SAP de por
// medio, así que no dependen de Keeper ni de getConnection().
import { z } from "zod";
import {
  listPersonalInstructions,
  addPersonalInstruction,
  removePersonalInstruction,
  INSTRUCTIONS_FILE,
} from "../lib/user-instructions.js";

export function registerUserInstructionTools(server) {
  server.tool(
    "add_personal_instruction",
    `Guarda una instrucción personal del usuario que su agente debe seguir automáticamente en cada sesión futura sobre este MCP de SAP (p. ej. "usa siempre la conexión de pruebas X salvo que diga lo contrario"). Se guarda en ${INSTRUCTIONS_FILE}, en el HOME del usuario del sistema operativo activo y fuera de este repo: persiste entre actualizaciones/reinstalaciones del MCP y es privada de este usuario/máquina. Se aplica automáticamente desde el PRÓXIMO arranque del servidor MCP (se inyecta en sus instructions), no a mitad de la sesión actual.`,
    { text: z.string().min(1).describe("Texto de la instrucción, tal cual debe seguirla el agente en cada sesión futura.") },
    async (args) => {
      const entry = addPersonalInstruction(args.text.trim());
      return {
        content: [{
          type: "text",
          text: `✅ Instrucción guardada (id ${entry.id}).\nSe aplicará automáticamente desde el próximo arranque del servidor MCP — si el usuario la necesita ya en esta sesión, tenla en cuenta tú mismo a partir de ahora en esta conversación.`,
        }],
      };
    }
  );

  server.tool(
    "list_personal_instructions",
    `Lista las instrucciones personales que este usuario tiene guardadas para su agente de sap-mcp (${INSTRUCTIONS_FILE}).`,
    {},
    async () => {
      const list = listPersonalInstructions();
      if (list.length === 0) {
        return { content: [{ type: "text", text: "No hay ninguna instrucción personal guardada todavía." }] };
      }
      const text = list.map((entry) => `- [${entry.id}] ${entry.text} (guardada ${entry.createdAt})`).join("\n");
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "remove_personal_instruction",
    "Elimina una instrucción personal guardada previamente. Usa list_personal_instructions para ver los ids disponibles.",
    { id: z.string().min(1).describe("Id de la instrucción a eliminar, tal como aparece en list_personal_instructions.") },
    async (args) => {
      const ok = removePersonalInstruction(args.id);
      return {
        content: [{
          type: "text",
          text: ok
            ? `🗑️ Instrucción ${args.id} eliminada. Dejará de aplicarse desde el próximo arranque del servidor MCP.`
            : `No se encontró ninguna instrucción con id "${args.id}". Usa list_personal_instructions para ver los ids vigentes.`,
        }],
        isError: !ok,
      };
    }
  );
}
