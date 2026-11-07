import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { crc32, deflateSync } from "node:zlib";
import { GREETING_MARKER } from "../instructions.js";
import { closedbotServer } from "../mcp.js";
import { splitTeamNote } from "../team-state.js";
import {
  TEAM_NAMESPACE,
  TOOL_ASK_USER,
  TOOL_REPORT_PROGRESS,
  TOOL_UPDATE_CHECKLIST,
  TOOL_CREATE_AGENT,
  TOOL_CREATE_CHANNEL,
  TOOL_CREATE_ROUTINE,
  TOOL_DELETE_AGENTS,
  TOOL_LIST_AGENTS,
  TOOL_LIST_ROUTINES,
  TOOL_READ_AGENT,
  TOOL_REMEMBER,
  TOOL_SEARCH_MEMORIES,
  TOOL_SEND_MESSAGE,
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
 *   - `/avance N paso` informa que lleva N % de su tarea (report_progress, de antes de la 0.9.13);
 *   - `/lista Título | ✓ hecho | ✱ en curso | ○ pendiente` lleva su lista de tareas (update_checklist);
 *     `/lista-nueva …` igual, pero como una tarea nueva;
 *   - `/imagen descripción` «genera» una imagen (como el generador de imágenes de Codex);
 *   - solo para el bot principal: `/crear Nombre | Rol | Proyecto | Aspecto` crea un agente (el
 *     aspecto es opcional), `/ajustar Nombre | Rol nuevo | Aspecto nuevo` le cambia el rol o el aspecto,
 *     `/proveedor Nombre | codex` le cambia el proveedor, `/eliminar Nombre, Nombre` pide eliminar
 *     agentes (la tarjeta para confirmar), `/ficha Nombre` lee su ficha y `/pizarra texto` escribe la pizarra.
 */
export class DemoAgentClient extends EventEmitter<ClientEvents> implements AgentClient {
  readonly provider: ProviderId = "demo";
  readonly #wordDelayMs: number;
  readonly #threads = new Set<string>();
  readonly #active = new Map<string, { turnId: string; interrupted: boolean }>();
  /** Tokens acumulados de cada sesión, como los informa Claude (la demo no cuesta nada: va sin costo). */
  readonly #spent = new Map<string, { input: number; cacheRead: number; cacheWrite: number; output: number }>();
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
      case "closedbot/mcp":
        // La demo no tiene MCP propios: solo las herramientas de ClosedBot.
        return { servers: [closedbotServer(params, "connected")] } as T;
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
      const { channel, inner } = splitChannel(input);
      const body = extractBody(inner);
      if (/(^|\s)\/equipo(\s|$)/.test(body)) {
        notes.push(`Compañeros: ${await this.#callTool(threadId, state.turnId, TOOL_LIST_AGENTS, {})}`);
      }
      const progress = /^\/avance\s+(\d{1,3})\s*%?\s*(.*)$/m.exec(body);
      if (progress) {
        try {
          await this.#callTool(threadId, state.turnId, TOOL_REPORT_PROGRESS, { percent: Number(progress[1]), step: (progress[2] ?? "").trim() });
          notes.push(`Llevo ${progress[1]} %.`);
        } catch (error) {
          notes.push(`No pude informar el avance: ${errorMessage(error)}`);
        }
      }
      const checklist = /^\/lista(-nueva)?\s+(.*)$/m.exec(body);
      if (checklist) {
        const [title = "", ...steps] = (checklist[2] ?? "").split("|").map((part) => part.trim());
        try {
          await this.#callTool(threadId, state.turnId, TOOL_UPDATE_CHECKLIST, { title, steps: steps.filter(Boolean).join("\n"), new_task: Boolean(checklist[1]) });
          notes.push("Actualicé mi lista de tareas.");
        } catch (error) {
          notes.push(`No pude actualizar la lista: ${errorMessage(error)}`);
        }
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
        const [name = "", role = "", project = "", appearance = ""] = (match[1] ?? "").split("|").map((part) => part.trim());
        const args = {
          name,
          role: role || "Agente de prueba",
          instructions: `Agente de prueba creado desde la demo con el rol «${role || "Agente de prueba"}».`,
          project: project || "Demo",
          ...(appearance ? { appearance } : {}),
        };
        try {
          await this.#callTool(threadId, state.turnId, TOOL_CREATE_AGENT, args);
          notes.push(`Creé a ${name} en «${args.project}».`);
        } catch (error) {
          notes.push(`No pude crear a ${name}: ${errorMessage(error)}`);
        }
      }
      for (const match of body.matchAll(/^\/ajustar\s+(.+)$/gm)) {
        const [agent = "", role = "", appearance = ""] = (match[1] ?? "").split("|").map((part) => part.trim());
        try {
          await this.#callTool(threadId, state.turnId, TOOL_UPDATE_AGENT, { agent, ...(role || !appearance ? { role } : {}), ...(appearance ? { appearance } : {}) });
          notes.push(role || !appearance ? `Le cambié el rol a ${agent}.` : `Le cambié el aspecto a ${agent}.`);
        } catch (error) {
          notes.push(`No pude ajustar a ${agent}: ${errorMessage(error)}`);
        }
      }
      for (const match of body.matchAll(/^\/proveedor\s+(.+)$/gm)) {
        const [agent = "", provider = ""] = (match[1] ?? "").split("|").map((part) => part.trim());
        try {
          await this.#callTool(threadId, state.turnId, TOOL_UPDATE_AGENT, { agent, provider });
          notes.push(`Le cambié el proveedor a ${agent}: ahora usa ${provider}.`);
        } catch (error) {
          notes.push(`No pude cambiarle el proveedor a ${agent}: ${errorMessage(error)}`);
        }
      }
      for (const match of body.matchAll(/^\/eliminar\s+(.+)$/gm)) {
        const agents = (match[1] ?? "")
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
        try {
          await this.#callTool(threadId, state.turnId, TOOL_DELETE_AGENTS, { agents });
          notes.push(`Te dejé la tarjeta para eliminar a ${agents.join(", ")}: confírmalo con «Eliminar».`);
        } catch (error) {
          notes.push(`No pude eliminar a ${agents.join(", ")}: ${errorMessage(error)}`);
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
      // Como el generador de imágenes de Codex: un evento imageGeneration con la imagen en base64.
      let images = 0;
      for (const match of body.matchAll(/^\/imagen(?:\s+(.*))?$/gm)) {
        images += 1;
        this.emit("notification", {
          method: "item/completed",
          params: {
            threadId,
            turnId: state.turnId,
            item: {
              id: `${state.turnId}:imagen-${images}`,
              type: "imageGeneration",
              status: "completed",
              revisedPrompt: (match[1] ?? "").trim() || "Imagen de prueba",
              result: demoPng(images).toString("base64"),
            },
          },
        });
      }
      if (images) notes.push(images === 1 ? "Generé una imagen de prueba." : `Generé ${images} imágenes de prueba.`);
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
      const spent = this.#spent.get(threadId) ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
      spent.input += Math.ceil(input.length / 4);
      spent.cacheRead += 1_000;
      spent.output += Math.ceil(text.length / 4);
      this.#spent.set(threadId, spent);
      this.emit("notification", {
        method: "closedbot/tokenUsage",
        params: { threadId, turnId: state.turnId, reading: { demo: { ...spent, costUsd: null } } },
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

/** Una imagen PNG de prueba de 96×96: un degradado con un cuadro al centro, de otro color en cada `seed`. */
export function demoPng(seed = 1): Buffer {
  const size = 96;
  const hue = (seed * 67) % 360;
  const [r, g, b] = hslToRgb(hue / 360, 0.55, 0.62);
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x += 1) {
      const inner = x >= 28 && x < 68 && y >= 28 && y < 68;
      const shade = 0.75 + (0.25 * (x + y)) / (2 * size);
      row[1 + x * 3] = inner ? 255 : Math.round(r * shade);
      row[2 + x * 3] = inner ? 255 : Math.round(g * shade);
      row[3 + x * 3] = inner ? 255 : Math.round(b * shade);
    }
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bits por canal
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h * 12) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
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
