import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { GREETING_MARKER } from "../instructions.js";
import { ROUND_INPUT_PREFIX, ROUND_RESULT_PREFIX, TODOS_NOTE_PREFIX } from "../rounds.js";
import { splitTeamNote } from "../team-state.js";
import {
  TEAM_NAMESPACE,
  TOOL_ASK_USER,
  TOOL_CREATE_AGENT,
  TOOL_CREATE_CHANNEL,
  TOOL_CREATE_ROUTINE,
  TOOL_LIST_AGENTS,
  TOOL_LIST_ROUTINES,
  TOOL_READ_AGENT,
  TOOL_REMEMBER,
  TOOL_SEARCH_MEMORIES,
  TOOL_SEND_MESSAGE,
  TOOL_START_ROUND,
  TOOL_UPDATE_AGENT,
  TOOL_UPDATE_BOARD,
} from "../team.js";
import type { AgentClient, ProviderId } from "./client.js";
import {
  type AppServerNotification,
  type AppServerRequest,
  getString,
  isRecord,
  type RequestId,
  type RpcError,
} from "./protocol.js";

interface ClientEvents {
  notification: [notification: AppServerNotification];
  request: [request: AppServerRequest];
  exit: [error: Error];
  diagnostic: [message: string];
}

export interface DemoClientOptions {
  /** Pausa entre palabras al transmitir la respuesta. */
  wordDelayMs?: number;
}

/**
 * Proveedor de demostración sin IA: sirve para probar la app (cola, mensajes entre agentes,
 * transmisión en vivo, preguntas y rutinas) sin cuentas. Entiende estos comandos en el mensaje:
 *   - una línea `/encargar Nombre: texto` envía `texto` al compañero Nombre (fuera de los canales
 *     también sirve `@Nombre: texto`; en un canal, la @ solo elige a quién le llega el mensaje);
 *   - `/equipo` lista a los compañeros; `/lento` transmite la respuesta despacio;
 *   - `/pregunta [¿Texto? | Opción A | Opción B]` hace una pregunta con opciones al usuario;
 *   - `/rutina HH:MM Nombre` o `/rutina cada N Nombre` crea una rutina; `/rutinas` las lista;
 *   - solo para el bot principal: `/crear Nombre | Rol | Proyecto` crea un agente,
 *     `/ajustar Nombre | Rol nuevo` le cambia el rol, `/ficha Nombre` lee su ficha,
 *     `/pizarra texto` escribe la pizarra y `/ronda modo | Ana, Beto | consulta` abre una ronda;
 *   - en una ronda, cada agente responde con una propuesta, una opinión o «De acuerdo»
 *     (o «Paso» si la consulta dice `/paso`).
 */
export class DemoAgentClient extends EventEmitter<ClientEvents> implements AgentClient {
  readonly provider: ProviderId = "demo";
  readonly #wordDelayMs: number;
  readonly #threads = new Set<string>();
  readonly #active = new Map<string, { turnId: string; interrupted: boolean }>();
  readonly #pending = new Map<RequestId, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #running = false;

  constructor(options: DemoClientOptions = {}) {
    super();
    this.#wordDelayMs = options.wordDelayMs ?? 30;
  }

  get running(): boolean {
    return this.#running;
  }

  start(): void {
    this.#running = true;
  }

  async stop(): Promise<void> {
    this.#running = false;
    for (const turn of this.#active.values()) turn.interrupted = true;
    for (const pending of this.#pending.values()) pending.reject(new Error("Demo detenida."));
    this.#pending.clear();
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    if (!this.#running) throw new Error("El proveedor demo no está en marcha.");
    switch (method) {
      case "initialize":
        return {} as T;
      case "model/list":
        return { data: [{ model: "demo", displayName: "Demo (sin IA)", isDefault: true }] } as T;
      case "thread/start": {
        const id = randomUUID();
        this.#threads.add(id);
        return { thread: { id } } as T;
      }
      case "thread/resume": {
        const id = getString(params, "threadId");
        if (!id) throw new Error("Falta threadId.");
        this.#threads.add(id);
        return { thread: { id } } as T;
      }
      case "thread/close": {
        const id = getString(params, "threadId");
        if (id) this.#threads.delete(id);
        return {} as T;
      }
      case "turn/start": {
        const threadId = getString(params, "threadId");
        if (!threadId || !this.#threads.has(threadId)) throw new Error("Hilo demo desconocido.");
        if (this.#active.has(threadId)) throw new Error("El hilo demo ya tiene un turno activo.");
        const turnId = randomUUID();
        const state = { turnId, interrupted: false };
        this.#active.set(threadId, state);
        this.emit("notification", { method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress" } } });
        void this.#runTurn(threadId, state, readInputText(params));
        return { turn: { id: turnId, status: "inProgress" } } as T;
      }
      case "turn/interrupt": {
        const threadId = getString(params, "threadId");
        const state = threadId ? this.#active.get(threadId) : undefined;
        if (state) state.interrupted = true;
        return {} as T;
      }
      default:
        throw new Error(`La demo no implementa ${method}.`);
    }
  }

  notify(): void {}

  respond(id: RequestId, result: unknown): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    pending.resolve(result);
  }

  respondError(id: RequestId, error: RpcError): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    pending.reject(new Error(error.message));
  }

  async #runTurn(threadId: string, state: { turnId: string; interrupted: boolean }, input: string): Promise<void> {
    const notes: string[] = [];
    try {
      // La nota de ClosedBot para el bot principal (lo que cambió el usuario) va antes del mensaje.
      const team = splitTeamNote(input);
      if (team.note) notes.push(`ClosedBot me contó cómo están tus agentes:\n${team.note.split("\n").slice(1).join("\n")}`);
      input = team.rest;
      // Una consulta de una ronda de Claude Bot: se responde corto, sin herramientas.
      if (input.startsWith(ROUND_INPUT_PREFIX)) {
        await this.#say(threadId, state, demoRoundAnswer(input));
        return;
      }
      // El resultado de una ronda (lo recibe Claude Bot): cuántos respondieron.
      if (input.startsWith(ROUND_RESULT_PREFIX)) {
        const header = input.split("\n")[0] ?? "";
        const count = /respondieron (\d+) de (\d+)/.exec(header);
        notes.push(`Recibí las respuestas de la ronda${count ? ` (${count[1]} de ${count[2]})` : ""}.`);
        input = input.slice(header.length).trim();
      }
      // «Que opinen todos»: la nota de ClosedBot va antes del mensaje del usuario.
      if (input.startsWith(TODOS_NOTE_PREFIX)) {
        const end = input.indexOf("\n\n");
        notes.push("ClosedBot me pidió que opinen todos antes de repartir.");
        input = end < 0 ? "" : input.slice(end + 2);
      }
      const { channel, inner } = splitChannel(input);
      const body = extractBody(inner);
      if (/(^|\s)\/equipo(\s|$)/.test(body)) {
        notes.push(`Compañeros: ${await this.#callTool(threadId, state.turnId, TOOL_LIST_AGENTS, {})}`);
      }
      const question = /^\/pregunta\b(.*)$/m.exec(body);
      if (question) {
        const parts = (question[1] ?? "").split("|").map((part) => part.trim()).filter(Boolean);
        const args =
          parts.length >= 3
            ? { question: parts[0], options: parts.slice(1, 5).map((label) => ({ label })), recommended: 0 }
            : {
                question: "¿Cómo seguimos con la demo?",
                options: [
                  { label: "Seguir probando", detail: "Te muestro otra función de la demo." },
                  { label: "Terminar por hoy", detail: "Dejo la conversación aquí." },
                ],
                recommended: 0,
              };
        try {
          await this.#callTool(threadId, state.turnId, TOOL_ASK_USER, args);
          notes.push("Te dejé una pregunta: elige una opción en la tarjeta.");
        } catch (error) {
          notes.push(`No pude preguntarte: ${errorMessage(error)}`);
        }
      }
      const routine = /^\/rutina\s+(?:(\d{1,2}:\d{2})|cada\s+(\d+))\s+(.+)$/m.exec(body);
      if (routine) {
        const name = (routine[3] ?? "").trim();
        const args = {
          name,
          prompt: `Rutina de prueba «${name}»: avisa que corrió.`,
          ...(routine[1] ? { times: [routine[1]] } : { everyMinutes: Number(routine[2]) }),
        };
        try {
          await this.#callTool(threadId, state.turnId, TOOL_CREATE_ROUTINE, args);
          notes.push(`Creé la rutina «${name}».`);
        } catch (error) {
          notes.push(`No pude crear la rutina: ${errorMessage(error)}`);
        }
      }
      for (const match of body.matchAll(/^\/crear\s+(.+)$/gm)) {
        const [name = "", role = "", project = ""] = (match[1] ?? "").split("|").map((part) => part.trim());
        const args = {
          name,
          role: role || "Agente de prueba",
          instructions: `Agente de prueba creado desde la demo con el rol «${role || "Agente de prueba"}».`,
          project: project || "Demo",
        };
        try {
          await this.#callTool(threadId, state.turnId, TOOL_CREATE_AGENT, args);
          notes.push(`Creé a ${name} en «${args.project}».`);
        } catch (error) {
          notes.push(`No pude crear a ${name}: ${errorMessage(error)}`);
        }
      }
      for (const match of body.matchAll(/^\/ajustar\s+(.+)$/gm)) {
        const [agent = "", role = ""] = (match[1] ?? "").split("|").map((part) => part.trim());
        try {
          await this.#callTool(threadId, state.turnId, TOOL_UPDATE_AGENT, { agent, role });
          notes.push(`Le cambié el rol a ${agent}.`);
        } catch (error) {
          notes.push(`No pude ajustar a ${agent}: ${errorMessage(error)}`);
        }
      }
      for (const match of body.matchAll(/^\/canal\s+(.+)$/gm)) {
        const [name = "", lead = "", members = ""] = (match[1] ?? "").split("|").map((part) => part.trim());
        const args = {
          name,
          members: members
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
          ...(lead ? { lead } : {}),
        };
        try {
          await this.#callTool(threadId, state.turnId, TOOL_CREATE_CHANNEL, args);
          notes.push(`Creé el canal «${name}».`);
        } catch (error) {
          notes.push(`No pude crear el canal «${name}»: ${errorMessage(error)}`);
        }
      }
      for (const match of body.matchAll(/^\/ficha\s+(.+)$/gm)) {
        const agent = (match[1] ?? "").trim();
        try {
          notes.push(`Ficha de ${agent}: ${await this.#callTool(threadId, state.turnId, TOOL_READ_AGENT, { agent })}`);
        } catch (error) {
          notes.push(`No pude leer la ficha de ${agent}: ${errorMessage(error)}`);
        }
      }
      const board = /^\/pizarra(?:\s+(.*))?$/m.exec(body);
      if (board) {
        try {
          await this.#callTool(threadId, state.turnId, TOOL_UPDATE_BOARD, { text: (board[1] ?? "").trim() });
          notes.push("Actualicé la pizarra.");
        } catch (error) {
          notes.push(`No pude escribir la pizarra: ${errorMessage(error)}`);
        }
      }
      const round = /^\/ronda\s+(.+)$/m.exec(body);
      if (round) {
        const [mode = "", people = "", question = ""] = (round[1] ?? "").split("|").map((part) => part.trim());
        const participants = people
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
        try {
          await this.#callTool(threadId, state.turnId, TOOL_START_ROUND, { mode, participants, question: question || "Consulta de prueba de la demo." });
          notes.push(`Abrí una ronda de «${mode}» con ${participants.join(", ")}.`);
        } catch (error) {
          notes.push(`No pude abrir la ronda: ${errorMessage(error)}`);
        }
      }
      for (const match of body.matchAll(/^\/recuerda(\s+siempre)?\s+(.+)$/gm)) {
        const text = (match[2] ?? "").trim();
        try {
          await this.#callTool(threadId, state.turnId, TOOL_REMEMBER, { text, always: Boolean(match[1]) });
          notes.push(`Lo guardé en mis recuerdos${match[1] ? " (lo uso siempre)" : ""}: «${text}».`);
        } catch (error) {
          notes.push(`No pude guardarlo: ${errorMessage(error)}`);
        }
      }
      const search = /^\/busca\s+(.+)$/m.exec(body);
      if (search) notes.push(`Mis recuerdos sobre eso: ${await this.#callTool(threadId, state.turnId, TOOL_SEARCH_MEMORIES, { query: (search[1] ?? "").trim() })}`);
      if (/(^|\s)\/rutinas(\s|$)/.test(body)) {
        notes.push(`Rutinas: ${await this.#callTool(threadId, state.turnId, TOOL_LIST_ROUTINES, {})}`);
      }
      const handoffs = [
        ...body.matchAll(/^\/encargar\s+([^:\n]+):\s*(.+)$/gm),
        ...(channel === null ? body.matchAll(/^@([^:\n]+):\s*(.+)$/gm) : []),
      ];
      for (const match of handoffs) {
        const name = (match[1] ?? "").trim();
        const text = (match[2] ?? "").trim();
        try {
          await this.#callTool(threadId, state.turnId, TOOL_SEND_MESSAGE, { to: [name], text });
          notes.push(`Le envié a ${name}: «${text}».`);
        } catch (error) {
          notes.push(`No pude escribirle a ${name}: ${errorMessage(error)}`);
        }
      }
      const fromTeammate = inner.startsWith("Mensaje de tu compañero") || inner.startsWith("Respuesta de tu compañero");
      const summary = body.length > 160 ? `${body.slice(0, 160)}…` : body;
      const where = channel === null ? "" : ` en «${channel}»`;
      const reply = input.startsWith(GREETING_MARKER) ? demoGreeting(input) : [
        fromTeammate
          ? `Modo demo${where}: recibí el mensaje de mi compañero («${summary}»).`
          : `Modo demo (sin IA)${where}: recibí «${summary}».`,
        ...notes,
        fromTeammate ? "" : "Este modo no usa ningún modelo; sirve para probar la cola, la transmisión en vivo y los mensajes entre agentes.",
      ]
        .filter(Boolean)
        .join("\n\n");
      const delay = /(^|\s)\/lento(\s|$)/.test(body) ? Math.max(this.#wordDelayMs, 400) : this.#wordDelayMs;
      const itemId = `${state.turnId}:demo`;
      let text = "";
      for (const word of reply.split(/(?<=\s)/)) {
        if (state.interrupted || !this.#running) break;
        text += word;
        this.emit("notification", {
          method: "item/agentMessage/delta",
          params: { threadId, turnId: state.turnId, itemId, delta: word },
        });
        await sleep(delay);
      }
      this.emit("notification", {
        method: "item/completed",
        params: { threadId, turnId: state.turnId, item: { id: itemId, type: "agentMessage", text } },
      });
      this.#finish(threadId, state, state.interrupted ? "interrupted" : "completed");
    } catch (error) {
      this.emit("notification", {
        method: "error",
        params: { threadId, turnId: state.turnId, error: { message: String(error) }, willRetry: false },
      });
      this.#finish(threadId, state, "failed");
    }
  }

  /** Responde un texto fijo (para las rondas) y termina el turno. */
  async #say(threadId: string, state: { turnId: string; interrupted: boolean }, reply: string): Promise<void> {
    const itemId = `${state.turnId}:demo`;
    let text = "";
    for (const word of reply.split(/(?<=\s)/)) {
      if (state.interrupted || !this.#running) break;
      text += word;
      this.emit("notification", { method: "item/agentMessage/delta", params: { threadId, turnId: state.turnId, itemId, delta: word } });
      await sleep(this.#wordDelayMs);
    }
    this.emit("notification", { method: "item/completed", params: { threadId, turnId: state.turnId, item: { id: itemId, type: "agentMessage", text } } });
    this.#finish(threadId, state, state.interrupted ? "interrupted" : "completed");
  }

  #finish(threadId: string, state: { turnId: string }, status: string): void {
    this.#active.delete(threadId);
    this.emit("notification", { method: "turn/completed", params: { threadId, turn: { id: state.turnId, status } } });
  }

  async #callTool(threadId: string, turnId: string, tool: string, args: unknown): Promise<string> {
    const id = randomUUID();
    const result = await new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.emit("request", {
        id,
        method: "item/tool/call",
        params: { threadId, turnId, callId: randomUUID(), namespace: TEAM_NAMESPACE, tool, arguments: args },
      });
    });
    const items = isRecord(result) && Array.isArray(result.contentItems) ? result.contentItems : [];
    const text = items
      .filter(isRecord)
      .map((item) => (typeof item.text === "string" ? item.text : ""))
      .join("\n");
    if (isRecord(result) && result.success === false) throw new Error(text || "La herramienta falló.");
    return text;
  }
}

/** Lo que responde la demo a una consulta de una ronda: corto, como pide la ronda. */
function demoRoundAnswer(input: string): string {
  const mode = /^\[Ronda de ClosedBot · ([^\]\n]+)\]/.exec(input)?.[1] ?? "";
  const start = input.search(/^--- consulta de .+ ---$/m);
  const end = input.indexOf("\n--- cómo responder ---");
  const question = start >= 0 && end > start ? input.slice(input.indexOf("\n", start) + 1, end).trim() : "";
  const summary = question.length > 80 ? `${question.slice(0, 80)}…` : question;
  if (/(^|\s)\/paso(\s|$)/.test(question)) return "Paso: en modo demo no tengo nada que aportar a esto.";
  if (mode === "Acuerdo del reparto") return "De acuerdo con el reparto (modo demo).";
  if (mode === "Que opinen todos") return `Opinión de demo: conviene repartirlo por partes; yo tomaría una de «${summary}».`;
  return `Propuesta de demo: puedo encargarme de una parte de «${summary}».`;
}

/** Saludo inicial de la demo, con el nombre del agente y del usuario que trae el pedido. */
function demoGreeting(input: string): string {
  const agent = /Te llamas «([^»]+)»/.exec(input)?.[1] ?? "tu agente nuevo";
  const user = /El usuario se llama «([^»]+)»/.exec(input)?.[1];
  const team = /Sección «([^»]+)»/.exec(input)?.[1];
  return [
    `¡Hola${user ? `, ${user}` : ""}! Soy ${agent}, recién llegado y listo para echarte una mano.`,
    team
      ? `Para empezar con buen pie: ¿para qué te gustaría usarme principalmente? Veo que ya tienes un equipo en «${team}», así que me sirve saber si quieres que me sume a ese trabajo o que me encargue de otra cosa, como tu correo, tus archivos o tareas del día a día.`
      : "Para empezar con buen pie: ¿para qué te gustaría usarme principalmente? Puedo encargarme de tu correo, tus archivos, investigar algo o ayudarte con tareas del día a día.",
  ].join("\n\n");
}

const CHANNEL_HEADER = /^\[Canal «([^»\n]+)» de ClosedBot\]\n/;
const CHANNEL_MARKER = "\n--- mensaje ---\n";

/** Separa el encabezado de un canal (miembros, lo último que se dijo) de lo que llegó. */
function splitChannel(input: string): { channel: string | null; inner: string } {
  const header = CHANNEL_HEADER.exec(input);
  const index = header ? input.indexOf(CHANNEL_MARKER) : -1;
  if (!header || index < 0) return { channel: null, inner: input };
  return { channel: header[1] ?? "", inner: input.slice(index + CHANNEL_MARKER.length) };
}

/** Quita el encabezado que el orquestador añade a los mensajes de compañeros. */
function extractBody(input: string): string {
  const marker = input.match(/^--- (mensaje|respuesta) ---$/m);
  if (!marker || marker.index === undefined) return input.trim();
  return input.slice(marker.index + marker[0].length).trim();
}

function readInputText(params: unknown): string {
  if (!isRecord(params) || !Array.isArray(params.input)) return "";
  return params.input
    .filter(isRecord)
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
