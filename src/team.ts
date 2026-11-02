/**
 * Herramientas del equipo que ve cada agente: listar compañeros y enviarles mensajes.
 * Codex las recibe como herramientas dinámicas (`dynamicTools` en thread/start) y
 * Claude como un servidor MCP en proceso; ambos terminan en una petición `item/tool/call`.
 */

export const TEAM_NAMESPACE = "cuadrilla";
export const TOOL_LIST_AGENTS = "list_agents";
export const TOOL_SEND_MESSAGE = "send_message";

export const LIST_AGENTS_DESCRIPTION =
  "Lista los agentes de tu equipo con su id, nombre, rol y estado (libre, trabajando o con cola).";
export const SEND_MESSAGE_DESCRIPTION =
  "Encola un mensaje asíncrono para uno o más compañeros (por id o nombre). Al responder a un compañero, pasa el id de su mensaje en replyToMessageId.";

export const TEAM_DYNAMIC_TOOLS = {
  type: "namespace",
  name: TEAM_NAMESPACE,
  description: "Descubre a tus compañeros de Cuadrilla y envíales mensajes asíncronos.",
  tools: [
    {
      type: "function",
      name: TOOL_LIST_AGENTS,
      description: LIST_AGENTS_DESCRIPTION,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      type: "function",
      name: TOOL_SEND_MESSAGE,
      description: SEND_MESSAGE_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          to: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 16,
            description: "Ids o nombres de los destinatarios.",
          },
          text: { type: "string", minLength: 1, maxLength: 50_000 },
          replyToMessageId: { type: ["string", "null"] },
        },
        required: ["to", "text"],
        additionalProperties: false,
      },
    },
  ],
} as const;

export interface SendMessageArgs {
  to: string[];
  text: string;
  replyToMessageId: string | null;
}

export function parseSendMessageArgs(value: unknown): SendMessageArgs {
  if (typeof value !== "object" || value === null) throw new Error("Argumentos inválidos.");
  const record = value as Record<string, unknown>;
  const rawTo = record.to ?? record.recipientAgentIds ?? record.recipientBotIds;
  const to = typeof rawTo === "string" ? [rawTo] : rawTo;
  if (!Array.isArray(to) || to.length === 0 || !to.every((item) => typeof item === "string")) {
    throw new Error("`to` debe ser una lista con ids o nombres de agentes.");
  }
  if (to.length > 16) throw new Error("Máximo 16 destinatarios por mensaje.");
  if (typeof record.text !== "string" || !record.text.trim()) throw new Error("`text` es obligatorio.");
  if (record.text.length > 50_000) throw new Error("El mensaje supera los 50.000 caracteres.");
  const reply = record.replyToMessageId;
  if (reply !== undefined && reply !== null && typeof reply !== "string") {
    throw new Error("`replyToMessageId` debe ser el id de un mensaje.");
  }
  return { to: to as string[], text: record.text, replyToMessageId: (reply as string | null | undefined) ?? null };
}
