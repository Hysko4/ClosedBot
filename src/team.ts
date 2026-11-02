/**
 * Herramientas de ClosedBot que ve cada agente: compañeros, preguntas al usuario y rutinas.
 * El bot principal (Claude Bot) tiene además las que crean y ajustan agentes.
 * Codex las recibe como herramientas dinámicas (`dynamicTools` en thread/start) y
 * Claude como un servidor MCP en proceso; ambos terminan en una petición `item/tool/call`.
 */

import type { ProviderId } from "./providers/client.js";
import { MAX_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES } from "./schedule.js";

export const TEAM_NAMESPACE = "closedbot";
export const TOOL_LIST_AGENTS = "list_agents";
export const TOOL_SEND_MESSAGE = "send_message";
export const TOOL_ASK_USER = "ask_user";
export const TOOL_CREATE_ROUTINE = "create_routine";
export const TOOL_LIST_ROUTINES = "list_routines";
export const TOOL_DELETE_ROUTINE = "delete_routine";
export const TOOL_CREATE_AGENT = "create_agent";
export const TOOL_UPDATE_AGENT = "update_agent";

/** Herramientas de todos los agentes. */
export const TEAM_TOOLS = [
  TOOL_LIST_AGENTS,
  TOOL_SEND_MESSAGE,
  TOOL_ASK_USER,
  TOOL_CREATE_ROUTINE,
  TOOL_LIST_ROUTINES,
  TOOL_DELETE_ROUTINE,
] as const;

/** Herramientas que solo tiene el bot principal: arman y ajustan los equipos. */
export const MAIN_TOOLS = [TOOL_CREATE_AGENT, TOOL_UPDATE_AGENT] as const;

export const LIST_AGENTS_DESCRIPTION =
  "Lista los agentes de tu equipo con su id, nombre, rol, proyecto y estado (libre, trabajando o con cola).";
export const SEND_MESSAGE_DESCRIPTION =
  "Encola un mensaje asíncrono para uno o más compañeros (por id o nombre). Al responder a un compañero, pasa el id de su mensaje en replyToMessageId.";
export const ASK_USER_DESCRIPTION =
  "Hazle al usuario una pregunta de opción múltiple: aparece como una tarjeta en tu conversación y él responde con un toque. Su respuesta te llega después como un mensaje nuevo, así que tras preguntar termina tu turno sin esperarla. Úsala solo para decisiones que de verdad le corresponden (cambian su objetivo o no se pueden deshacer); lo demás, decídelo tú. Marca en recommended la opción que recomiendas.";
export const CREATE_ROUTINE_DESCRIPTION =
  "Crea una rutina: una tarea que harás sola a las horas indicadas (hora local del equipo del usuario) o cada cierto intervalo. Cada vez recibirás un mensaje con el texto de prompt. Úsala solo cuando el usuario pida algo periódico. Indica times (y opcionalmente days) o everyMinutes, uno de los dos.";
export const LIST_ROUTINES_DESCRIPTION = "Lista tus rutinas con su id, nombre, horario, si están activas y su próxima ejecución.";
export const DELETE_ROUTINE_DESCRIPTION = "Elimina una de tus rutinas por su id (míralo con list_routines).";
export const CREATE_AGENT_DESCRIPTION =
  "Crea un agente nuevo en el equipo del usuario, con nombre, rol, instrucciones permanentes y proyecto (el grupo de la barra lateral donde aparece). Antes revisa con list_agents que no exista uno parecido. Usa el mismo proyecto para todos los agentes de un equipo.";
export const UPDATE_AGENT_DESCRIPTION =
  "Cambia el nombre, el rol, las instrucciones, el proyecto o el modelo de un agente que ya existe (indícalo por id o nombre). Solo cambia lo que pases. No sirve para cambiarte a ti mismo.";

export const ROUTINE_LIMITS = { name: 80, prompt: 4_000, times: 12 } as const;
export const QUESTION_LIMITS = { question: 300, label: 80, detail: 200, minOptions: 2, maxOptions: 4 } as const;
export const AGENT_LIMITS = { name: 60, role: 200, instructions: 8_000, project: 60, model: 120 } as const;
/** Proveedores que el bot principal puede elegir para un agente nuevo. */
export const AGENT_PROVIDERS = ["claude", "codex"] as const;

export const AGENT_FIELD_HELP = {
  name: "Nombre corto, claro y único, p. ej. «Diseñador de Niveles».",
  role: "Su rol en una frase.",
  instructions: "Instrucciones permanentes: qué hace, qué entrega, con quién coordina y cuándo preguntarle al usuario.",
  project: "Proyecto (grupo de la barra lateral), p. ej. «Creación de Juegos». El mismo para todo el equipo.",
  provider: "Proveedor del agente. Si no lo indicas, el tuyo.",
  model:
    "Modelo opcional (p. ej. claude-sonnet-5-5 o claude-haiku-5-5 para tareas simples). Sin él usa el modelo por defecto del proveedor.",
} as const;

const BASE_DYNAMIC_TOOLS = [
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
  {
    type: "function",
    name: TOOL_ASK_USER,
    description: ASK_USER_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", minLength: 1, maxLength: QUESTION_LIMITS.question, description: "La pregunta, breve y directa." },
        options: {
          type: "array",
          minItems: QUESTION_LIMITS.minOptions,
          maxItems: QUESTION_LIMITS.maxOptions,
          items: {
            type: "object",
            properties: {
              label: { type: "string", minLength: 1, maxLength: QUESTION_LIMITS.label, description: "Nombre corto de la opción." },
              detail: { type: "string", maxLength: QUESTION_LIMITS.detail, description: "Qué pasa si la elige, en una frase." },
            },
            required: ["label"],
            additionalProperties: false,
          },
        },
        recommended: { type: ["integer", "null"], minimum: 0, maximum: QUESTION_LIMITS.maxOptions - 1, description: "Índice (desde 0) de la opción recomendada." },
      },
      required: ["question", "options"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: TOOL_CREATE_ROUTINE,
    description: CREATE_ROUTINE_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: ROUTINE_LIMITS.name, description: "Nombre corto, p. ej. «Resumen de la mañana»." },
        prompt: { type: "string", minLength: 1, maxLength: ROUTINE_LIMITS.prompt, description: "Qué debes hacer cada vez." },
        times: {
          type: "array",
          items: { type: "string", pattern: "^\\d{1,2}:\\d{2}$" },
          minItems: 1,
          maxItems: ROUTINE_LIMITS.times,
          description: "Horas locales HH:MM.",
        },
        days: {
          type: "array",
          items: { type: "integer", minimum: 0, maximum: 6 },
          maxItems: 7,
          description: "Días de la semana con times (0 = domingo … 6 = sábado). Sin días = todos.",
        },
        everyMinutes: {
          type: "integer",
          minimum: MIN_INTERVAL_MINUTES,
          maximum: MAX_INTERVAL_MINUTES,
          description: "En vez de horas fijas: cada cuántos minutos.",
        },
      },
      required: ["name", "prompt"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: TOOL_LIST_ROUTINES,
    description: LIST_ROUTINES_DESCRIPTION,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: TOOL_DELETE_ROUTINE,
    description: DELETE_ROUTINE_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", minLength: 1 } },
      required: ["id"],
      additionalProperties: false,
    },
  },
] as const;

const MAIN_DYNAMIC_TOOLS = [
  {
    type: "function",
    name: TOOL_CREATE_AGENT,
    description: CREATE_AGENT_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: AGENT_LIMITS.name, description: AGENT_FIELD_HELP.name },
        role: { type: "string", minLength: 1, maxLength: AGENT_LIMITS.role, description: AGENT_FIELD_HELP.role },
        instructions: { type: "string", minLength: 1, maxLength: AGENT_LIMITS.instructions, description: AGENT_FIELD_HELP.instructions },
        project: { type: "string", minLength: 1, maxLength: AGENT_LIMITS.project, description: AGENT_FIELD_HELP.project },
        provider: { type: "string", enum: [...AGENT_PROVIDERS], description: AGENT_FIELD_HELP.provider },
        model: { type: "string", maxLength: AGENT_LIMITS.model, description: AGENT_FIELD_HELP.model },
      },
      required: ["name", "role", "instructions", "project"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: TOOL_UPDATE_AGENT,
    description: UPDATE_AGENT_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", minLength: 1, description: "Id o nombre actual del agente." },
        name: { type: "string", minLength: 1, maxLength: AGENT_LIMITS.name, description: "Nombre nuevo." },
        role: { type: "string", minLength: 1, maxLength: AGENT_LIMITS.role, description: AGENT_FIELD_HELP.role },
        instructions: { type: "string", minLength: 1, maxLength: AGENT_LIMITS.instructions, description: AGENT_FIELD_HELP.instructions },
        project: { type: "string", maxLength: AGENT_LIMITS.project, description: "Proyecto nuevo; vacío lo saca de su grupo." },
        model: { type: "string", maxLength: AGENT_LIMITS.model, description: "Modelo nuevo; vacío vuelve al modelo por defecto." },
      },
      required: ["agent"],
      additionalProperties: false,
    },
  },
] as const;

/** Herramientas dinámicas de un hilo (Codex las fija al crearlo). El bot principal recibe además las de equipos. */
export function teamDynamicTools(main: boolean) {
  return {
    type: "namespace",
    name: TEAM_NAMESPACE,
    description: main
      ? "Arma y ajusta los equipos de agentes del usuario, habla con ellos, pregúntale al usuario y programa rutinas."
      : "Habla con tus compañeros de ClosedBot, pregúntale al usuario y programa rutinas.",
    tools: main ? [...BASE_DYNAMIC_TOOLS, ...MAIN_DYNAMIC_TOOLS] : [...BASE_DYNAMIC_TOOLS],
  };
}

export const TEAM_DYNAMIC_TOOLS = teamDynamicTools(false);

export interface SendMessageArgs {
  to: string[];
  text: string;
  replyToMessageId: string | null;
}

export function parseSendMessageArgs(value: unknown): SendMessageArgs {
  const record = argsRecord(value);
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

export interface QuestionOption {
  label: string;
  detail: string;
}

export interface AskUserArgs {
  question: string;
  options: QuestionOption[];
  recommended: number | null;
}

export function parseAskUserArgs(value: unknown): AskUserArgs {
  const record = argsRecord(value);
  const question = requiredText(record.question, "question", QUESTION_LIMITS.question);
  const options = record.options;
  if (!Array.isArray(options) || options.length < QUESTION_LIMITS.minOptions || options.length > QUESTION_LIMITS.maxOptions) {
    throw new Error(`\`options\` debe tener entre ${QUESTION_LIMITS.minOptions} y ${QUESTION_LIMITS.maxOptions} opciones.`);
  }
  const parsed = options.map((option, index) => {
    const entry = typeof option === "string" ? { label: option } : option;
    if (typeof entry !== "object" || entry === null) throw new Error(`La opción ${index + 1} no es válida.`);
    const item = entry as Record<string, unknown>;
    return {
      label: requiredText(item.label, `options[${index}].label`, QUESTION_LIMITS.label),
      detail: optionalText(item.detail, `options[${index}].detail`, QUESTION_LIMITS.detail),
    };
  });
  const rawRecommended = record.recommended;
  let recommended: number | null = null;
  if (rawRecommended !== undefined && rawRecommended !== null) {
    const index = Number(rawRecommended);
    if (!Number.isInteger(index) || index < 0 || index >= parsed.length) throw new Error("`recommended` debe ser el índice de una de las opciones.");
    recommended = index;
  }
  return { question, options: parsed, recommended };
}

export interface CreateRoutineArgs {
  name: string;
  prompt: string;
  times?: unknown;
  days?: unknown;
  everyMinutes?: unknown;
}

/** Valida nombre y tarea; el horario lo valida `normalizeSchedule`. */
export function parseCreateRoutineArgs(value: unknown): CreateRoutineArgs {
  const record = argsRecord(value);
  return {
    name: requiredText(record.name, "name", ROUTINE_LIMITS.name),
    prompt: requiredText(record.prompt, "prompt", ROUTINE_LIMITS.prompt),
    times: record.times,
    days: record.days,
    everyMinutes: record.everyMinutes,
  };
}

export function parseRoutineIdArgs(value: unknown): { id: string } {
  const record = argsRecord(value);
  return { id: requiredText(record.id, "id", 100) };
}

export interface CreateAgentArgs {
  name: string;
  role: string;
  instructions: string;
  project: string;
  /** null = el mismo proveedor del bot principal. */
  provider: ProviderId | null;
  model: string | null;
}

export function parseCreateAgentArgs(value: unknown): CreateAgentArgs {
  const record = argsRecord(value);
  return {
    name: requiredText(record.name, "name", AGENT_LIMITS.name),
    role: requiredText(record.role, "role", AGENT_LIMITS.role),
    instructions: requiredText(record.instructions, "instructions", AGENT_LIMITS.instructions),
    project: requiredText(record.project, "project", AGENT_LIMITS.project),
    provider: parseProvider(record.provider),
    model: optionalText(record.model, "model", AGENT_LIMITS.model) || null,
  };
}

export interface UpdateAgentArgs {
  agent: string;
  name?: string;
  role?: string;
  instructions?: string;
  /** "" saca al agente de su proyecto. */
  project?: string;
  /** null vuelve al modelo por defecto. */
  model?: string | null;
}

export function parseUpdateAgentArgs(value: unknown): UpdateAgentArgs {
  const record = argsRecord(value);
  const args: UpdateAgentArgs = { agent: requiredText(record.agent, "agent", 100) };
  if (record.name !== undefined && record.name !== null) args.name = requiredText(record.name, "name", AGENT_LIMITS.name);
  if (record.role !== undefined && record.role !== null) args.role = requiredText(record.role, "role", AGENT_LIMITS.role);
  if (record.instructions !== undefined && record.instructions !== null) {
    args.instructions = requiredText(record.instructions, "instructions", AGENT_LIMITS.instructions);
  }
  if (record.project !== undefined && record.project !== null) args.project = optionalText(record.project, "project", AGENT_LIMITS.project);
  if (record.model !== undefined) args.model = optionalText(record.model, "model", AGENT_LIMITS.model) || null;
  return args;
}

function parseProvider(value: unknown): ProviderId | null {
  if (value === undefined || value === null || value === "") return null;
  if (value === "claude" || value === "codex" || value === "demo") return value;
  throw new Error("`provider` debe ser claude o codex.");
}

function argsRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Argumentos inválidos.");
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`\`${name}\` es obligatorio.`);
  const text = value.trim();
  if (text.length > max) throw new Error(`\`${name}\` admite hasta ${max} caracteres.`);
  return text;
}

function optionalText(value: unknown, name: string, max: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error(`\`${name}\` debe ser texto.`);
  const text = value.trim();
  if (text.length > max) throw new Error(`\`${name}\` admite hasta ${max} caracteres.`);
  return text;
}
