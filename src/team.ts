/**
 * Herramientas de ClosedBot que ve cada agente: compañeros, preguntas al usuario, rutinas y recuerdos.
 * El bot principal (Claude Bot) tiene además las que crean y ajustan agentes y crean canales.
 * Codex las recibe como herramientas dinámicas (`dynamicTools` en thread/start) y
 * Claude como un servidor MCP en proceso; ambos terminan en una petición `item/tool/call`.
 */

import { INSTRUCTIONS_MAX } from "./agent-files.js";
import { BOARD_MAX } from "./board.js";
import { CHANNEL_LIMITS, MAX_CHANNEL_MEMBERS } from "./channels.js";
import { MEMORY_LIMITS } from "./memories.js";
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
export const TOOL_CREATE_CHANNEL = "create_channel";
export const TOOL_READ_AGENT = "read_agent";
export const TOOL_UPDATE_BOARD = "update_board";
export const TOOL_REMEMBER = "remember";
export const TOOL_FORGET_MEMORY = "forget_memory";
export const TOOL_SEARCH_MEMORIES = "search_memories";
export const TOOL_LIST_MEMORIES = "list_memories";
export const TOOL_SET_MEMORY_INCLUSION = "set_memory_inclusion";

/** Herramientas de recuerdos (todos los agentes). */
export const MEMORY_TOOLS = [TOOL_REMEMBER, TOOL_FORGET_MEMORY, TOOL_SEARCH_MEMORIES, TOOL_LIST_MEMORIES, TOOL_SET_MEMORY_INCLUSION] as const;

/** Herramientas de todos los agentes. */
export const TEAM_TOOLS = [
  TOOL_LIST_AGENTS,
  TOOL_SEND_MESSAGE,
  TOOL_ASK_USER,
  TOOL_CREATE_ROUTINE,
  TOOL_LIST_ROUTINES,
  TOOL_DELETE_ROUTINE,
  ...MEMORY_TOOLS,
] as const;

/**
 * Herramientas que solo tiene el bot principal: arman y ajustan los equipos (también el proveedor de cada
 * agente) y les crean su canal, leen la ficha completa de cada agente y llevan la pizarra del trabajo.
 */
export const MAIN_TOOLS = [TOOL_CREATE_AGENT, TOOL_UPDATE_AGENT, TOOL_CREATE_CHANNEL, TOOL_READ_AGENT, TOOL_UPDATE_BOARD] as const;

export const LIST_AGENTS_DESCRIPTION =
  "Lista los agentes de tu equipo con su id, nombre, rol, proyecto y estado (libre, trabajando o con cola). Al bot principal le muestra además los canales, la pizarra y cuánto plan le queda a cada cuenta.";
export const SEND_MESSAGE_DESCRIPTION =
  "Encola un mensaje asíncrono para uno o más compañeros (por id o nombre). Al responder a un compañero, pasa el id de su mensaje en replyToMessageId.";
export const ASK_USER_DESCRIPTION =
  "Hazle al usuario una pregunta de opción múltiple: aparece como una tarjeta en tu conversación y él responde con un toque. Su respuesta te llega después como un mensaje nuevo, así que tras preguntar termina tu turno sin esperarla. Úsala solo para decisiones que de verdad le corresponden (cambian su objetivo o no se pueden deshacer); lo demás, decídelo tú. Marca en recommended la opción que recomiendas.";
export const CREATE_ROUTINE_DESCRIPTION =
  "Crea una rutina: una tarea que harás sola a las horas indicadas (hora local del equipo del usuario) o cada cierto intervalo. Cada vez recibirás un mensaje con el texto de prompt. Úsala solo cuando el usuario pida algo periódico. Indica times (y opcionalmente days) o everyMinutes, uno de los dos.";
export const LIST_ROUTINES_DESCRIPTION = "Lista tus rutinas con su id, nombre, horario, si están activas y su próxima ejecución.";
export const DELETE_ROUTINE_DESCRIPTION = "Elimina una de tus rutinas por su id (míralo con list_routines).";
export const CREATE_AGENT_DESCRIPTION =
  "Crea un agente nuevo en el equipo del usuario, con nombre, rol, descripción, instrucciones permanentes y proyecto (el grupo de la barra lateral donde aparece). Antes revisa con list_agents que no exista uno parecido. Usa el mismo proyecto para todos los agentes de un equipo.";
export const UPDATE_AGENT_DESCRIPTION =
  "Cambia el nombre, el rol, la descripción, las instrucciones, el proyecto, el proveedor, el modelo o el aspecto de un agente que ya existe (indícalo por id o nombre). Solo cambia lo que pases. Cambia el proveedor cuando el agente no puede hacer su parte con el que tiene (p. ej. imágenes) y solo si está libre: empieza una conversación nueva con sus mismas instrucciones y recuerdos. No sirve para cambiarte a ti mismo.";
export const REMEMBER_DESCRIPTION =
  "Guarda un recuerdo duradero: un dato, preferencia o decisión del usuario que te servirá en otras conversaciones (no lo uses para notas de la tarea actual). Con always true se usa siempre (va en tus instrucciones desde tu próximo mensaje); si no, lo buscas con search_memories cuando haga falta. Antes de guardar, revisa que no lo tengas ya.";
export const FORGET_MEMORY_DESCRIPTION = "Borra uno de tus recuerdos por su id (míralo con list_memories o search_memories). Úsalo si quedó viejo, es falso o el usuario te pide olvidarlo.";
export const SEARCH_MEMORIES_DESCRIPTION =
  "Busca entre tus recuerdos los que tratan de un tema (palabras clave, p. ej. «correo cliente factura»). Úsala antes de responder algo en lo que el usuario te pudo haber dado preferencias o datos antes.";
export const LIST_MEMORIES_DESCRIPTION = "Lista todos tus recuerdos con su id y si se usan siempre o solo si hacen falta.";
export const SET_MEMORY_INCLUSION_DESCRIPTION =
  "Cambia si un recuerdo se usa siempre (always true: va en tus instrucciones) o solo cuando lo buscas (always false). Deja en «siempre» solo lo que sirve en casi todas tus tareas.";

export const CREATE_CHANNEL_DESCRIPTION =
  "Crea un canal: una conversación del usuario con varios agentes a la vez. El encargado responde lo que no nombra a nadie y reparte el trabajo; con @Nombre el usuario le habla a uno en particular. Al armar un equipo, crea su canal (uno por equipo, con el nombre del proyecto y el líder como encargado); créalo también cuando el usuario lo pida. Antes revisa con list_agents los canales que ya existen.";

export const READ_AGENT_DESCRIPTION =
  "Lee la ficha completa de un agente (por id o nombre): título, descripción, proveedor y modelo, sus instrucciones (AGENTS.md), sus recuerdos, sus habilidades, sus rutinas, sus canales y en qué anda (lo último de su conversación). Úsala cuando list_agents no te baste para decidir a quién darle un trabajo.";
export const UPDATE_BOARD_DESCRIPTION =
  "Reemplaza la pizarra del trabajo: el objetivo, las partes, quién hace cada una (con qué proveedor), en qué orden, dónde queda cada entrega y el avance, en pocas líneas. La reciben los agentes cuando les escribes y el usuario la ve en tu chat. Pasa el texto completo (vacío la borra).";

export const CHANNEL_FIELD_HELP = {
  name: "Nombre del canal. Para un equipo, el de su proyecto (p. ej. «Creación de Juegos»).",
  members: "Ids o nombres de los agentes del canal: todo el equipo (de 1 a 12). No te incluyas.",
  lead: "Id o nombre del encargado, uno de los miembros: el líder del equipo. Si no lo indicas, el primero.",
  topic: "Tema opcional, en una frase: de qué trata el canal.",
} as const;

export const ROUTINE_LIMITS = { name: 80, prompt: 4_000, times: 12 } as const;
export const QUESTION_LIMITS = { question: 300, label: 80, detail: 200, minOptions: 2, maxOptions: 4 } as const;
export const AGENT_LIMITS = { name: 60, role: 200, description: 2_000, instructions: INSTRUCTIONS_MAX, project: 60, model: 120, appearance: 300 } as const;
/** Proveedores que el bot principal puede elegir para un agente nuevo. */
export const AGENT_PROVIDERS = ["claude", "codex", "grok", "gemini", "local"] as const;

export const AGENT_FIELD_HELP = {
  name: "Nombre corto, claro y único, p. ej. «Diseñador de Niveles».",
  role: "Su rol en una frase.",
  description: "Descripción opcional en dos o tres frases: para qué sirve y qué entrega. La ven el usuario en su ficha y los demás agentes.",
  instructions: "Instrucciones permanentes: qué hace, qué entrega, con quién coordina y cuándo preguntarle al usuario.",
  project: "Proyecto (grupo de la barra lateral), p. ej. «Creación de Juegos». El mismo para todo el equipo.",
  provider:
    "Proveedor del agente, según lo que mejor hace su parte: uno de proveedoresListos (lo da list_agents). Para imágenes, codex (Claude no las genera). Si no lo indicas, el tuyo.",
  model:
    "Modelo opcional (p. ej. claude-sonnet-5-5 o claude-haiku-5-5 para tareas simples). Sin él usa el modelo por defecto del proveedor.",
  appearance:
    "Cómo se ve su personaje en la Oficina (PixelLab lo dibuja en pixel art), en inglés y en una frase: edad, pelo, ropa y un detalle que vaya con su rol, p. ej. «young woman, curly red hair, green sweater, round glasses». Si el usuario describió cómo lo quiere, usa eso.",
} as const;

export const UPDATE_PROVIDER_HELP =
  "Proveedor nuevo, uno de proveedoresListos: para que haga lo que su proveedor no puede (p. ej. codex para imágenes). Solo si está libre; si no indicas model, usa el modelo por defecto del proveedor nuevo.";

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
  {
    type: "function",
    name: TOOL_REMEMBER,
    description: REMEMBER_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, maxLength: MEMORY_LIMITS.text, description: "Lo que debes recordar, en una o dos frases claras." },
        always: { type: "boolean", description: "true: se usa siempre. false o sin indicar: solo cuando lo buscas." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: TOOL_FORGET_MEMORY,
    description: FORGET_MEMORY_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", minLength: 1 } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: TOOL_SEARCH_MEMORIES,
    description: SEARCH_MEMORIES_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", minLength: 1, maxLength: 300, description: "Palabras clave del tema." } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: TOOL_LIST_MEMORIES,
    description: LIST_MEMORIES_DESCRIPTION,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: TOOL_SET_MEMORY_INCLUSION,
    description: SET_MEMORY_INCLUSION_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", minLength: 1 }, always: { type: "boolean" } },
      required: ["id", "always"],
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
        description: { type: "string", maxLength: AGENT_LIMITS.description, description: AGENT_FIELD_HELP.description },
        instructions: { type: "string", minLength: 1, maxLength: AGENT_LIMITS.instructions, description: AGENT_FIELD_HELP.instructions },
        project: { type: "string", minLength: 1, maxLength: AGENT_LIMITS.project, description: AGENT_FIELD_HELP.project },
        provider: { type: "string", enum: [...AGENT_PROVIDERS], description: AGENT_FIELD_HELP.provider },
        model: { type: "string", maxLength: AGENT_LIMITS.model, description: AGENT_FIELD_HELP.model },
        appearance: { type: "string", maxLength: AGENT_LIMITS.appearance, description: AGENT_FIELD_HELP.appearance },
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
        description: { type: "string", maxLength: AGENT_LIMITS.description, description: "Descripción nueva; vacía la borra." },
        instructions: { type: "string", minLength: 1, maxLength: AGENT_LIMITS.instructions, description: AGENT_FIELD_HELP.instructions },
        project: { type: "string", maxLength: AGENT_LIMITS.project, description: "Proyecto nuevo; vacío lo saca de su grupo." },
        provider: { type: "string", enum: [...AGENT_PROVIDERS], description: UPDATE_PROVIDER_HELP },
        model: { type: "string", maxLength: AGENT_LIMITS.model, description: "Modelo nuevo; vacío vuelve al modelo por defecto." },
        appearance: {
          type: "string",
          maxLength: AGENT_LIMITS.appearance,
          description: "Aspecto nuevo de su personaje de la Oficina (en inglés, una frase); PixelLab lo vuelve a dibujar. Solo si el usuario lo pide o no tiene.",
        },
      },
      required: ["agent"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: TOOL_CREATE_CHANNEL,
    description: CREATE_CHANNEL_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: CHANNEL_LIMITS.name, description: CHANNEL_FIELD_HELP.name },
        members: {
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 1,
          maxItems: MAX_CHANNEL_MEMBERS,
          description: CHANNEL_FIELD_HELP.members,
        },
        lead: { type: "string", minLength: 1, description: CHANNEL_FIELD_HELP.lead },
        topic: { type: "string", maxLength: CHANNEL_LIMITS.topic, description: CHANNEL_FIELD_HELP.topic },
      },
      required: ["name", "members"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: TOOL_READ_AGENT,
    description: READ_AGENT_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { agent: { type: "string", minLength: 1, description: "Id o nombre del agente." } },
      required: ["agent"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: TOOL_UPDATE_BOARD,
    description: UPDATE_BOARD_DESCRIPTION,
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", maxLength: BOARD_MAX, description: "La pizarra completa, en pocas líneas." } },
      required: ["text"],
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
      ? "Arma y ajusta los equipos de agentes del usuario y sus canales, habla con ellos, pregúntale al usuario, programa rutinas y guarda recuerdos."
      : "Habla con tus compañeros de ClosedBot, pregúntale al usuario, programa rutinas y guarda recuerdos.",
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
  description: string;
  instructions: string;
  project: string;
  /** null = el mismo proveedor del bot principal. */
  provider: ProviderId | null;
  model: string | null;
  /** Cómo se ve su personaje de la Oficina ("" = sin describir). */
  appearance: string;
}

export function parseCreateAgentArgs(value: unknown): CreateAgentArgs {
  const record = argsRecord(value);
  return {
    name: requiredText(record.name, "name", AGENT_LIMITS.name),
    role: requiredText(record.role, "role", AGENT_LIMITS.role),
    description: optionalText(record.description, "description", AGENT_LIMITS.description),
    instructions: requiredText(record.instructions, "instructions", AGENT_LIMITS.instructions),
    project: requiredText(record.project, "project", AGENT_LIMITS.project),
    provider: parseProvider(record.provider),
    model: optionalText(record.model, "model", AGENT_LIMITS.model) || null,
    appearance: optionalText(record.appearance, "appearance", AGENT_LIMITS.appearance),
  };
}

export interface UpdateAgentArgs {
  agent: string;
  name?: string;
  role?: string;
  /** "" borra la descripción. */
  description?: string;
  instructions?: string;
  /** "" saca al agente de su proyecto. */
  project?: string;
  provider?: ProviderId;
  /** null vuelve al modelo por defecto. */
  model?: string | null;
  appearance?: string;
}

export function parseUpdateAgentArgs(value: unknown): UpdateAgentArgs {
  const record = argsRecord(value);
  const args: UpdateAgentArgs = { agent: requiredText(record.agent, "agent", 100) };
  if (record.name !== undefined && record.name !== null) args.name = requiredText(record.name, "name", AGENT_LIMITS.name);
  if (record.role !== undefined && record.role !== null) args.role = requiredText(record.role, "role", AGENT_LIMITS.role);
  if (record.description !== undefined && record.description !== null) {
    args.description = optionalText(record.description, "description", AGENT_LIMITS.description);
  }
  if (record.instructions !== undefined && record.instructions !== null) {
    args.instructions = requiredText(record.instructions, "instructions", AGENT_LIMITS.instructions);
  }
  if (record.project !== undefined && record.project !== null) args.project = optionalText(record.project, "project", AGENT_LIMITS.project);
  const provider = parseProvider(record.provider);
  if (provider) args.provider = provider;
  if (record.model !== undefined) args.model = optionalText(record.model, "model", AGENT_LIMITS.model) || null;
  if (record.appearance !== undefined && record.appearance !== null) {
    args.appearance = optionalText(record.appearance, "appearance", AGENT_LIMITS.appearance);
  }
  return args;
}

export interface CreateChannelArgs {
  name: string;
  /** Ids o nombres de los miembros, en orden. */
  members: string[];
  /** Id o nombre del encargado; null = el primero de los miembros. */
  lead: string | null;
  topic: string;
}

export function parseCreateChannelArgs(value: unknown): CreateChannelArgs {
  const record = argsRecord(value);
  const raw = typeof record.members === "string" ? [record.members] : record.members;
  if (!Array.isArray(raw) || raw.length === 0 || !raw.every((item) => typeof item === "string" && item.trim())) {
    throw new Error("`members` debe ser una lista con ids o nombres de agentes.");
  }
  if (raw.length > MAX_CHANNEL_MEMBERS) throw new Error(`Un canal admite hasta ${MAX_CHANNEL_MEMBERS} agentes.`);
  return {
    name: requiredText(record.name, "name", CHANNEL_LIMITS.name),
    members: raw.map((item) => (item as string).trim()),
    lead: optionalText(record.lead, "lead", 100) || null,
    topic: optionalText(record.topic, "topic", CHANNEL_LIMITS.topic),
  };
}

export function parseReadAgentArgs(value: unknown): { agent: string } {
  const record = argsRecord(value);
  return { agent: requiredText(record.agent ?? record.id ?? record.name, "agent", 100) };
}

export function parseUpdateBoardArgs(value: unknown): { text: string } {
  const record = argsRecord(value);
  if (typeof record.text !== "string") throw new Error("`text` debe ser el texto de la pizarra (vacío la borra).");
  const text = record.text.replace(/\r\n?/g, "\n").trim();
  if (text.length > BOARD_MAX) throw new Error(`La pizarra admite hasta ${BOARD_MAX} caracteres: déjala en pocas líneas.`);
  return { text };
}

export function parseRememberArgs(value: unknown): { text: string; always: boolean } {
  const record = argsRecord(value);
  const text = requiredText(record.text, "text", MEMORY_LIMITS.text);
  if (record.always !== undefined && record.always !== null && typeof record.always !== "boolean") throw new Error("`always` debe ser true o false.");
  return { text, always: record.always === true };
}

export function parseMemoryIdArgs(value: unknown): { id: string } {
  const record = argsRecord(value);
  return { id: requiredText(record.id, "id", 100) };
}

export function parseSearchMemoriesArgs(value: unknown): { query: string } {
  const record = argsRecord(value);
  return { query: requiredText(record.query, "query", 300) };
}

export function parseMemoryInclusionArgs(value: unknown): { id: string; always: boolean } {
  const record = argsRecord(value);
  if (typeof record.always !== "boolean") throw new Error("`always` debe ser true o false.");
  return { id: requiredText(record.id, "id", 100), always: record.always };
}

function parseProvider(value: unknown): ProviderId | null {
  if (value === undefined || value === null || value === "") return null;
  if (value === "claude" || value === "codex" || value === "grok" || value === "gemini" || value === "demo") return value;
  throw new Error("`provider` debe ser claude, codex, grok o gemini.");
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
