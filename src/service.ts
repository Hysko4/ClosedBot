import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRecord, DeliveryRecord, MessageRecord, RoutineRecord, Store } from "./db.js";
import { buildInstructions, composeDeliveryInput } from "./instructions.js";
import type { AccessLevel, AgentClient, ProviderId } from "./providers/client.js";
import {
  type AppServerNotification,
  type AppServerRequest,
  type DynamicToolCallParams,
  type DynamicToolResult,
  getArray,
  getRecord,
  getString,
  isDynamicToolCall,
  isRecord,
  type ThreadResponse,
  type TurnResponse,
} from "./providers/protocol.js";
import { describeSchedule, nextRun, normalizeSchedule } from "./schedule.js";
import {
  type AskUserArgs,
  parseAskUserArgs,
  parseCreateRoutineArgs,
  parseRoutineIdArgs,
  parseSendMessageArgs,
  type QuestionOption,
  TEAM_DYNAMIC_TOOLS,
  TEAM_NAMESPACE,
  TOOL_ASK_USER,
  TOOL_CREATE_ROUTINE,
  TOOL_DELETE_ROUTINE,
  TOOL_LIST_AGENTS,
  TOOL_LIST_ROUTINES,
  TOOL_SEND_MESSAGE,
} from "./team.js";
import { VERSION } from "./version.js";

export { VERSION };
export const PROVIDERS: ProviderId[] = ["claude", "codex", "demo"];

/** Rutinas: tope por agente y en total, y cuánto retraso se tolera antes de saltarse una ejecución. */
export const MAX_ROUTINES_PER_AGENT = 20;
export const MAX_ROUTINES = 100;
export const ROUTINE_GRACE_MS = 2 * 60 * 60_000;
const ROUTINE_CHECK_MS = 60_000;
/** Tamaño máximo de un archivo adjunto. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const SETTINGS_META = "settings";
const OPTION_LETTERS = "ABCD";

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  available: boolean;
  loggedIn: boolean | null;
  detail: string;
}

export type AgentState = "idle" | "working" | "queued" | "paused";

export interface AgentView extends AgentRecord {
  state: AgentState;
  queued: number;
  /** Hay mensajes del agente que el usuario aún no vio. */
  unread: boolean;
}

export interface RoutineView extends RoutineRecord {
  description: string;
  agentName: string;
  /** La última ejecución sigue en cola o en curso. */
  running: boolean;
}

/** Nombres que muestra la interfaz (el del asistente arriba a la izquierda y el del usuario abajo). */
export interface Settings {
  botName: string;
  userName: string;
}

export type ServiceEvent =
  | { type: "agents"; agents: AgentView[] }
  | { type: "message"; agentId: string; message: MessageRecord }
  | { type: "delta"; agentId: string; messageId: string; delta: string }
  | { type: "queue"; agentId: string; queue: DeliveryRecord[] }
  | { type: "providers"; providers: ProviderStatus[] }
  | { type: "routines"; routines: RoutineView[] }
  | { type: "settings"; settings: Settings }
  | { type: "notice"; level: "error" | "info"; message: string; agentId?: string };

export interface ServiceOptions {
  store: Store;
  workspacesDir: string;
  sharedDir: string;
  maxHops: number;
  createClient: (provider: ProviderId) => AgentClient;
  detectProviders?: () => Promise<ProviderStatus[]>;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

export interface AgentInput {
  name: string;
  role?: string;
  instructions?: string;
  provider: ProviderId;
  model?: string | null;
  effort?: string | null;
  access?: AccessLevel;
  /** Grupo en la barra lateral. */
  project?: string;
}

export interface RoutineInput {
  name?: unknown;
  prompt?: unknown;
  times?: unknown;
  days?: unknown;
  everyMinutes?: unknown;
}

interface TurnState {
  agentId: string;
  provider: ProviderId;
  deliveryId: string;
  hops: number;
  threadId: string | null;
  turnId: string | null;
  sentTo: Set<string>;
  assistantMessageIds: Set<string>;
  lastAssistantText: string;
  /** Pregunta que el agente le hizo al usuario en este turno (para la vista previa). */
  askedQuestion: string | null;
}

export class ServiceError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ServiceError";
  }
}

interface ServiceEvents {
  event: [event: ServiceEvent];
}

const ACTIVITY_ITEM_TYPES = new Set(["commandExecution", "fileChange", "mcpToolCall", "webSearch", "toolCall", "dynamicToolCall", "imageGeneration"]);

/**
 * Orquestador: cola FIFO por agente, un turno activo por agente, hilos persistentes por
 * proveedor y mensajes entre agentes. Inspirado en el AgentService de OpenBot v0.1.11.
 */
export class AgentService extends EventEmitter<ServiceEvents> {
  readonly #store: Store;
  readonly #options: ServiceOptions;
  readonly #clients = new Map<ProviderId, AgentClient>();
  readonly #clientReady = new Map<ProviderId, Promise<AgentClient>>();
  readonly #threadToAgent = new Map<string, string>();
  readonly #loadedThreads = new Set<string>();
  readonly #active = new Map<string, TurnState>();
  readonly #draining = new Set<string>();
  readonly #scheduled = new Set<string>();
  #providers: ProviderStatus[] = PROVIDERS.map((id) => ({
    id,
    label: providerLabel(id),
    available: id === "demo",
    loggedIn: id === "demo" ? true : null,
    detail: id === "demo" ? "Siempre disponible (sin IA)." : "Comprobando…",
  }));
  #stopping = false;
  #routineTimer: NodeJS.Timeout | null = null;

  constructor(options: ServiceOptions) {
    super();
    this.#options = options;
    this.#store = options.store;
  }

  // ---------- ciclo de vida ----------

  async start(): Promise<void> {
    mkdirSync(this.#options.workspacesDir, { recursive: true });
    mkdirSync(this.#options.sharedDir, { recursive: true });
    for (const delivery of this.#store.reconcileUnfinished()) {
      this.#notice(delivery.agentId, "La app se reinició mientras este agente trabajaba; ese turno quedó interrumpido.");
    }
    for (const agentId of this.#store.agentsWithQueuedWork()) this.#scheduleDrain(agentId);
    this.#armRoutines();
    void this.refreshProviders();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#routineTimer) clearTimeout(this.#routineTimer);
    this.#routineTimer = null;
    const clients = [...this.#clients.values()];
    this.#clients.clear();
    this.#clientReady.clear();
    await Promise.allSettled(clients.map((client) => client.stop()));
  }

  async refreshProviders(): Promise<ProviderStatus[]> {
    if (this.#options.detectProviders) {
      try {
        this.#providers = await this.#options.detectProviders();
      } catch (error) {
        this.#log("warn", `No se pudo comprobar los proveedores: ${String(error)}`);
      }
    }
    this.#emit({ type: "providers", providers: this.#providers });
    return this.#providers;
  }

  providers(): ProviderStatus[] {
    return this.#providers;
  }

  async listModels(provider: ProviderId): Promise<Array<{ model: string; displayName: string; isDefault?: boolean; efforts: string[] }>> {
    if (provider === "codex") {
      const status = this.#providers.find((item) => item.id === "codex");
      if (!status?.available) return [];
    }
    const client = await this.#getClient(provider);
    const response = await client.request<unknown>("model/list", {});
    return getArray(response, "data")
      .filter(isRecord)
      .filter((model) => model.hidden !== true)
      .map((model) => ({
        model: String(model.model ?? model.id ?? ""),
        displayName: String(model.displayName ?? model.model ?? ""),
        isDefault: model.isDefault === true,
        efforts: getArray(model, "supportedReasoningEfforts")
          .map((entry) => (isRecord(entry) ? String(entry.reasoningEffort ?? "") : String(entry)))
          .filter(Boolean),
      }))
      .filter((model) => model.model);
  }

  // ---------- agentes ----------

  listAgents(): AgentView[] {
    return this.#store.listAgents().map((agent) => this.#view(agent));
  }

  getAgent(id: string): AgentView {
    return this.#view(this.#requireAgent(id));
  }

  createAgent(input: AgentInput): AgentView {
    const name = cleanName(input.name);
    if (this.#store.findAgentByName(name)) throw new ServiceError(`Ya existe un agente llamado «${name}».`, 409);
    const provider = validProvider(input.provider);
    const workspace = this.#uniqueWorkspace(name);
    mkdirSync(workspace, { recursive: true });
    const agent = this.#store.createAgent({
      name,
      role: cleanText(input.role, 200),
      instructions: cleanText(input.instructions, 8_000),
      provider,
      model: cleanOptional(input.model, 120),
      effort: cleanOptional(input.effort, 20),
      access: input.access === "total" ? "total" : "carpeta",
      workspace,
      project: cleanProject(input.project),
    });
    this.#emitAgents();
    return this.#view(agent);
  }

  updateAgent(id: string, patch: Partial<AgentInput>): AgentView {
    const agent = this.#requireAgent(id);
    const next: Parameters<Store["updateAgent"]>[1] = {};
    if (patch.name !== undefined) {
      const name = cleanName(patch.name);
      const other = this.#store.findAgentByName(name);
      if (other && other.id !== id) throw new ServiceError(`Ya existe un agente llamado «${name}».`, 409);
      next.name = name;
    }
    if (patch.role !== undefined) next.role = cleanText(patch.role, 200);
    if (patch.instructions !== undefined) next.instructions = cleanText(patch.instructions, 8_000);
    if (patch.model !== undefined) next.model = cleanOptional(patch.model, 120);
    if (patch.effort !== undefined) next.effort = cleanOptional(patch.effort, 20);
    if (patch.access !== undefined) next.access = patch.access === "total" ? "total" : "carpeta";
    if (patch.project !== undefined) next.project = cleanProject(patch.project);
    if (patch.provider !== undefined) {
      const provider = validProvider(patch.provider);
      if (provider !== agent.provider) {
        if (this.#active.has(id)) throw new ServiceError("Detén el turno en curso antes de cambiar de proveedor.", 409);
        next.provider = provider;
        next.threadId = null;
        if (patch.model === undefined) next.model = null;
        if (patch.effort === undefined) next.effort = null;
      }
    }
    const updated = this.#store.updateAgent(id, next);
    if (agent.threadId) this.#loadedThreads.delete(`${agent.provider}:${agent.threadId}`);
    if (next.provider) {
      void this.#closeThread(agent);
      this.#notice(id, `Cambiaste el proveedor a ${providerLabel(updated.provider)}: la próxima respuesta empieza una conversación nueva.`);
    }
    this.#emitAgents();
    return this.#view(updated);
  }

  async deleteAgent(id: string): Promise<void> {
    const agent = this.#requireAgent(id);
    if (this.#active.has(id)) throw new ServiceError("Detén el turno en curso antes de eliminar el agente.", 409);
    this.#store.cancelQueuedForAgent(id);
    await this.#closeThread(agent);
    this.#store.deleteAgent(id);
    this.#emitAgents();
    // Sus rutinas se borran con él (ON DELETE CASCADE).
    this.#emitRoutines();
    this.#armRoutines();
  }

  async resetConversation(id: string): Promise<AgentView> {
    const agent = this.#requireAgent(id);
    if (this.#active.has(id)) throw new ServiceError("Detén el turno en curso antes de empezar de cero.", 409);
    this.#store.cancelQueuedForAgent(id);
    await this.#closeThread(agent);
    this.#store.deleteMessagesForAgent(id);
    const updated = this.#store.updateAgent(id, { threadId: null, preview: "" });
    this.#emitQueue(id);
    this.#emitAgents();
    return this.#view(updated);
  }

  setPaused(id: string, paused: boolean): AgentView {
    this.#requireAgent(id);
    const updated = this.#store.updateAgent(id, { paused });
    this.#emitAgents();
    if (!paused) this.#scheduleDrain(id);
    return this.#view(updated);
  }

  /** El usuario abrió la conversación: deja de marcarla como no leída. */
  markRead(id: string): AgentView {
    const agent = this.#requireAgent(id);
    if (agent.lastAt <= agent.readAt) return this.#view(agent);
    const updated = this.#store.updateAgent(id, { readAt: Math.max(Date.now(), agent.lastAt) });
    this.#emitAgents();
    return this.#view(updated);
  }

  // ---------- ajustes ----------

  getSettings(): Settings {
    let stored: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(this.#store.getMeta(SETTINGS_META) ?? "{}");
      if (isRecord(parsed)) stored = parsed;
    } catch {
      stored = {};
    }
    return {
      botName: typeof stored.botName === "string" && stored.botName ? stored.botName : "Cuadrilla",
      userName: typeof stored.userName === "string" ? stored.userName : "",
    };
  }

  updateSettings(patch: { botName?: unknown; userName?: unknown }): Settings {
    const current = this.getSettings();
    const next: Settings = {
      botName: patch.botName === undefined ? current.botName : cleanSettingName(patch.botName) || "Cuadrilla",
      userName: patch.userName === undefined ? current.userName : cleanSettingName(patch.userName),
    };
    this.#store.setMeta(SETTINGS_META, JSON.stringify(next));
    this.#emit({ type: "settings", settings: next });
    return next;
  }

  // ---------- preguntas al usuario ----------

  /** El usuario eligió una opción de una tarjeta de decisión: la respuesta le llega al agente como mensaje. */
  answerDecision(agentId: string, messageId: string, choice: unknown): { decision: MessageRecord; message: MessageRecord; delivery: DeliveryRecord } {
    this.#requireAgent(agentId);
    const result = this.#store.transaction(() => {
      const decision = this.#store.getMessage(messageId);
      if (!decision || decision.agentId !== agentId || decision.role !== "decision") throw new ServiceError("Pregunta no encontrada.", 404);
      const payload = decision.payload ?? {};
      if (payload.answer !== null && payload.answer !== undefined) throw new ServiceError("Esa pregunta ya tiene respuesta.", 409);
      const options = readOptions(payload);
      const index = typeof choice === "number" ? choice : Number.NaN;
      const option = Number.isInteger(index) ? options[index] : undefined;
      if (!option) throw new ServiceError("Elige una de las opciones de la tarjeta.");
      const letter = OPTION_LETTERS[index] ?? String(index + 1);
      const updated = this.#store.updateMessage(messageId, { payload: { ...payload, answer: index, answeredAt: Date.now() } }) as MessageRecord;
      const agentText = [
        `Respuesta del usuario a tu pregunta «${decision.text}»: eligió la opción ${letter}, «${option.label}».`,
        option.detail ? `(${option.detail})` : null,
        "Sigue con la tarea según su elección.",
      ]
        .filter(Boolean)
        .join(" ");
      const message = this.#store.insertMessage({
        agentId,
        role: "user",
        text: `${letter}. ${option.label}`,
        status: "queued",
        payload: { decisionId: messageId, choice: index },
      });
      const { delivery } = this.#store.enqueueDelivery({
        agentId,
        messageId: message.id,
        senderKind: "user",
        text: agentText,
        idempotencyKey: `decision:${messageId}`,
      });
      const linked = this.#store.updateMessage(message.id, { deliveryId: delivery.id }) as MessageRecord;
      return { decision: updated, message: linked, delivery };
    });
    this.#store.updateAgent(agentId, { readAt: Date.now() });
    this.#emit({ type: "message", agentId, message: result.decision });
    this.#emit({ type: "message", agentId, message: result.message });
    this.#emitQueue(agentId);
    this.#emitAgents();
    this.#scheduleDrain(agentId);
    return result;
  }

  // ---------- rutinas ----------

  listRoutines(agentId?: string): RoutineView[] {
    return this.#store.listRoutines(agentId).map((routine) => this.#routineView(routine));
  }

  createRoutine(agentId: string, input: RoutineInput, createdBy: "user" | "agent" = "user"): RoutineView {
    const agent = this.#requireAgent(agentId);
    const { args, schedule } = asServiceError(() => {
      const parsed = parseCreateRoutineArgs(input);
      return { args: parsed, schedule: normalizeSchedule(parsed) };
    });
    if (this.#store.listRoutines(agent.id).length >= MAX_ROUTINES_PER_AGENT) {
      throw new ServiceError(`Cada agente puede tener hasta ${MAX_ROUTINES_PER_AGENT} rutinas.`, 409);
    }
    if (this.#store.listRoutines().length >= MAX_ROUTINES) throw new ServiceError(`El equipo ya tiene ${MAX_ROUTINES} rutinas, el máximo.`, 409);
    const routine = this.#store.insertRoutine({
      agentId: agent.id,
      name: args.name,
      prompt: args.prompt,
      schedule,
      nextRunAt: nextRun(schedule, Date.now()),
    });
    const message = this.#store.insertMessage({
      agentId: agent.id,
      role: "activity",
      text: `${createdBy === "agent" ? "Creó" : "Creaste"} la rutina «${routine.name}» · ${describeSchedule(schedule)}`,
      status: "completed",
      payload: { kind: "routine-created", routineId: routine.id },
    });
    this.#emit({ type: "message", agentId: agent.id, message });
    this.#emitRoutines();
    this.#armRoutines();
    return this.#routineView(routine);
  }

  setRoutineEnabled(id: string, enabled: boolean): RoutineView {
    const routine = this.#requireRoutine(id);
    const updated = this.#store.updateRoutine(id, {
      enabled,
      nextRunAt: enabled ? nextRun(routine.schedule, Date.now()) : null,
    }) as RoutineRecord;
    this.#emitRoutines();
    this.#armRoutines();
    return this.#routineView(updated);
  }

  deleteRoutine(id: string): void {
    this.#requireRoutine(id);
    this.#store.deleteRoutine(id);
    this.#emitRoutines();
    this.#armRoutines();
  }

  /** Ejecuta una rutina ahora mismo, sin cambiar su horario. */
  runRoutineNow(id: string): RoutineView {
    const routine = this.#requireRoutine(id);
    if (this.#routinePending(routine)) throw new ServiceError("Esa rutina ya está en curso.", 409);
    this.#fireRoutine(routine, Date.now(), true);
    this.#emitRoutines();
    return this.#routineView(this.#requireRoutine(id));
  }

  /**
   * Encola las rutinas que ya tocan. La llama un temporizador (como mínimo una vez por minuto) y las pruebas.
   * Si una ejecución se atrasó más de ROUTINE_GRACE_MS (la app estaba cerrada), se salta y se avisa.
   */
  checkRoutines(now = Date.now()): void {
    if (this.#stopping) return;
    const due = this.#store.dueRoutines(now);
    for (const routine of due) {
      const scheduledAt = routine.nextRunAt ?? now;
      const next = nextRun(routine.schedule, now);
      this.#store.updateRoutine(routine.id, { nextRunAt: next });
      if (!this.#store.getAgent(routine.agentId)) continue;
      if (now - scheduledAt > ROUTINE_GRACE_MS) {
        this.#notice(
          routine.agentId,
          `La rutina «${routine.name}» no corrió ${formatWhen(scheduledAt)} porque Cuadrilla estaba cerrada.${next ? ` La próxima será ${formatWhen(next)}.` : ""}`,
        );
        continue;
      }
      if (this.#routinePending(routine)) {
        this.#log("info", `Rutina «${routine.name}» omitida: la ejecución anterior aún no termina.`);
        continue;
      }
      this.#fireRoutine(routine, scheduledAt, false);
    }
    if (due.length) this.#emitRoutines();
    this.#armRoutines();
  }

  // ---------- archivos adjuntos ----------

  /** Guarda un archivo en la carpeta `adjuntos` del agente y devuelve dónde quedó. */
  saveAttachment(agentId: string, rawName: string, data: Buffer): { name: string; path: string; relativePath: string; size: number } {
    const agent = this.#requireAgent(agentId);
    if (!data.length) throw new ServiceError("El archivo está vacío.");
    if (data.length > MAX_UPLOAD_BYTES) throw new ServiceError("El archivo supera los 25 MB.", 413);
    const dir = join(agent.workspace, "adjuntos");
    mkdirSync(dir, { recursive: true });
    const safe = safeFileName(rawName);
    const dot = safe.lastIndexOf(".");
    const stem = dot > 0 ? safe.slice(0, dot) : safe;
    const ext = dot > 0 ? safe.slice(dot) : "";
    for (let index = 1; index < 1_000; index += 1) {
      const name = index === 1 ? safe : `${stem}-${index}${ext}`;
      const path = join(dir, name);
      try {
        writeFileSync(path, data, { flag: "wx" });
        return { name, path, relativePath: `adjuntos/${name}`, size: data.length };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    throw new ServiceError("Ya hay demasiados archivos con ese nombre.", 409);
  }

  // ---------- mensajes y cola ----------

  listMessages(agentId: string, limit?: number, beforeSeq?: number) {
    this.#requireAgent(agentId);
    return this.#store.listMessages(agentId, limit, beforeSeq);
  }

  listQueue(agentId: string): DeliveryRecord[] {
    this.#requireAgent(agentId);
    return this.#store.listQueue(agentId);
  }

  sendUserMessage(agentId: string, text: string): { message: MessageRecord; delivery: DeliveryRecord } {
    this.#requireAgent(agentId);
    const body = text.trim();
    if (!body) throw new ServiceError("El mensaje está vacío.");
    if (body.length > 100_000) throw new ServiceError("El mensaje supera los 100.000 caracteres.");
    const result = this.#store.transaction(() => {
      const message = this.#store.insertMessage({ agentId, role: "user", text: body, status: "queued" });
      const { delivery } = this.#store.enqueueDelivery({ agentId, messageId: message.id, senderKind: "user", text: body });
      const linked = this.#store.updateMessage(message.id, { deliveryId: delivery.id }) as MessageRecord;
      return { message: linked, delivery };
    });
    this.#emit({ type: "message", agentId, message: result.message });
    this.#emitQueue(agentId);
    this.#emitAgents();
    this.#scheduleDrain(agentId);
    return result;
  }

  cancelQueued(agentId: string, deliveryId: string): void {
    const delivery = this.#store.getDelivery(deliveryId);
    if (!delivery || delivery.agentId !== agentId) throw new ServiceError("Mensaje en cola no encontrado.", 404);
    if (delivery.status !== "queued") throw new ServiceError("Ese mensaje ya empezó; usa «Detener».", 409);
    this.#store.updateDelivery(deliveryId, { status: "cancelled", finishedAt: Date.now() });
    const message = this.#store.updateMessage(delivery.messageId, { status: "cancelled" });
    if (message) this.#emit({ type: "message", agentId, message });
    this.#emitQueue(agentId);
    this.#emitAgents();
  }

  async interrupt(agentId: string): Promise<boolean> {
    this.#requireAgent(agentId);
    const state = this.#active.get(agentId);
    if (!state) return false;
    const client = this.#clients.get(state.provider);
    if (!state.turnId || !state.threadId || !client) {
      this.#finishTurn(agentId, state.turnId, "interrupted");
      return true;
    }
    try {
      await client.request("turn/interrupt", { threadId: state.threadId, turnId: state.turnId }, 10_000);
    } catch (error) {
      this.#notice(agentId, `No se pudo detener el turno limpiamente (${errorText(error)}); lo marco como interrumpido.`);
      this.#finishTurn(agentId, state.turnId, "interrupted");
    }
    return true;
  }

  // ---------- internos: clientes ----------

  async #getClient(provider: ProviderId): Promise<AgentClient> {
    const existing = this.#clientReady.get(provider);
    if (existing) return existing;
    const ready = (async () => {
      const client = this.#options.createClient(provider);
      client.on("notification", (notification) => this.#handleNotification(notification));
      client.on("request", (request) => void this.#handleServerRequest(client, request));
      client.on("diagnostic", (message) => this.#log("info", `[${provider}] ${message}`));
      client.once("exit", (error) => this.#handleClientExit(provider, client, error));
      client.start();
      try {
        await client.request(
          "initialize",
          {
            clientInfo: { name: "cuadrilla", title: "Cuadrilla", version: VERSION },
            capabilities: { experimentalApi: true, requestAttestation: false },
          },
          20_000,
        );
        client.notify("initialized", {});
      } catch (error) {
        client.removeAllListeners();
        await client.stop().catch(() => undefined);
        throw new ServiceError(`No se pudo iniciar ${providerLabel(provider)}: ${errorText(error)}`, 502);
      }
      this.#clients.set(provider, client);
      return client;
    })();
    this.#clientReady.set(provider, ready);
    ready.catch(() => {
      if (this.#clientReady.get(provider) === ready) this.#clientReady.delete(provider);
    });
    return ready;
  }

  #handleClientExit(provider: ProviderId, client: AgentClient, error: Error): void {
    if (this.#stopping) return;
    if (this.#clients.get(provider) === client) this.#clients.delete(provider);
    this.#clientReady.delete(provider);
    for (const key of [...this.#loadedThreads]) if (key.startsWith(`${provider}:`)) this.#loadedThreads.delete(key);
    for (const [agentId, state] of [...this.#active]) {
      if (state.provider !== provider) continue;
      this.#notice(agentId, `El proceso de ${providerLabel(provider)} se detuvo: ${error.message}`);
      this.#finishTurn(agentId, state.turnId, "failed");
    }
    if (!this.#stopping) this.#log("warn", `${providerLabel(provider)} terminó: ${error.message}`);
  }

  async #closeThread(agent: AgentRecord): Promise<void> {
    if (!agent.threadId) return;
    this.#loadedThreads.delete(`${agent.provider}:${agent.threadId}`);
    this.#threadToAgent.delete(agent.threadId);
    const client = this.#clients.get(agent.provider);
    if (!client || agent.provider === "codex") return;
    await client.request("thread/close", { threadId: agent.threadId }).catch(() => undefined);
  }

  #threadParams(agent: AgentRecord): Record<string, unknown> {
    const params: Record<string, unknown> = {
      cwd: agent.workspace,
      runtimeWorkspaceRoots: [agent.workspace, this.#options.sharedDir],
      approvalPolicy: "never",
      sandbox: agent.access === "total" ? "danger-full-access" : "workspace-write",
      developerInstructions: buildInstructions(agent, this.#options.sharedDir, this.getSettings().userName),
    };
    if (agent.model) params.model = agent.model;
    if (agent.effort && agent.provider !== "codex") params.effort = agent.effort;
    return params;
  }

  async #ensureThread(agent: AgentRecord, client: AgentClient): Promise<string> {
    if (agent.threadId) {
      this.#threadToAgent.set(agent.threadId, agent.id);
      const key = `${agent.provider}:${agent.threadId}`;
      if (this.#loadedThreads.has(key)) return agent.threadId;
      try {
        await client.request("thread/resume", { threadId: agent.threadId, ...this.#threadParams(agent) });
        this.#loadedThreads.add(key);
        return agent.threadId;
      } catch (error) {
        this.#notice(agent.id, `No se pudo reanudar la conversación anterior (${errorText(error)}). Empiezo una nueva: el agente no recordará lo anterior.`);
        this.#threadToAgent.delete(agent.threadId);
      }
    }
    const response = await client.request<ThreadResponse>("thread/start", {
      ...this.#threadParams(agent),
      ephemeral: false,
      serviceName: "cuadrilla",
      dynamicTools: [TEAM_DYNAMIC_TOOLS],
    });
    const threadId = response.thread.id;
    this.#store.updateAgent(agent.id, { threadId });
    this.#threadToAgent.set(threadId, agent.id);
    this.#loadedThreads.add(`${agent.provider}:${threadId}`);
    return threadId;
  }

  // ---------- internos: cola ----------

  #scheduleDrain(agentId: string): void {
    if (this.#stopping || this.#scheduled.has(agentId)) return;
    this.#scheduled.add(agentId);
    queueMicrotask(() => {
      this.#scheduled.delete(agentId);
      void this.#drain(agentId);
    });
  }

  async #drain(agentId: string): Promise<void> {
    if (this.#stopping || this.#draining.has(agentId) || this.#active.has(agentId)) return;
    const agent = this.#store.getAgent(agentId);
    if (!agent || agent.paused) return;
    const delivery = this.#store.nextQueued(agentId);
    if (!delivery) return;
    this.#draining.add(agentId);
    try {
      await this.#startDelivery(agent, delivery);
    } finally {
      this.#draining.delete(agentId);
    }
  }

  async #startDelivery(agent: AgentRecord, delivery: DeliveryRecord): Promise<void> {
    const state: TurnState = {
      agentId: agent.id,
      provider: agent.provider,
      deliveryId: delivery.id,
      hops: delivery.hops,
      threadId: null,
      turnId: null,
      sentTo: new Set(),
      assistantMessageIds: new Set(),
      lastAssistantText: "",
      askedQuestion: null,
    };
    this.#active.set(agent.id, state);
    this.#store.updateDelivery(delivery.id, { status: "starting", startedAt: Date.now() });
    this.#updateMessageStatus(agent.id, delivery.messageId, "running");
    this.#emitQueue(agent.id);
    this.#emitAgents();
    try {
      const client = await this.#getClient(agent.provider);
      const fresh = this.#requireAgent(agent.id);
      const threadId = await this.#ensureThread(fresh, client);
      state.threadId = threadId;
      const sender = delivery.senderAgentId ? this.#store.getAgent(delivery.senderAgentId) : null;
      const original = delivery.replyTo ? this.#store.getMessage(delivery.replyTo) : null;
      const text = composeDeliveryInput(delivery, sender ? { id: sender.id, name: sender.name } : null, original?.text ?? null);
      const response = await client.request<TurnResponse>(
        "turn/start",
        {
          threadId,
          clientUserMessageId: delivery.id,
          input: [{ type: "text", text, text_elements: [] }],
          cwd: fresh.workspace,
          approvalPolicy: "never",
          sandboxPolicy:
            fresh.access === "total"
              ? { type: "dangerFullAccess" }
              : {
                  type: "workspaceWrite",
                  writableRoots: [fresh.workspace, this.#options.sharedDir],
                  networkAccess: true,
                  excludeTmpdirEnvVar: false,
                  excludeSlashTmp: false,
                },
          ...(fresh.model ? { model: fresh.model } : {}),
          ...(fresh.effort ? { effort: fresh.effort } : {}),
        },
        60_000,
      );
      if (this.#active.get(agent.id) !== state) return;
      state.turnId = state.turnId ?? response.turn.id;
      this.#store.updateDelivery(delivery.id, { status: "running", turnId: state.turnId });
      this.#emitQueue(agent.id);
    } catch (error) {
      if (this.#stopping || this.#active.get(agent.id) !== state) return;
      this.#active.delete(agent.id);
      this.#store.updateDelivery(delivery.id, { status: "failed", error: errorText(error), finishedAt: Date.now() });
      this.#updateMessageStatus(agent.id, delivery.messageId, "failed");
      this.#notice(agent.id, `No se pudo entregar el mensaje: ${errorText(error)}`);
      this.#emitQueue(agent.id);
      this.#emitAgents();
      this.#scheduleDrain(agent.id);
    }
  }

  #finishTurn(agentId: string, turnId: string | null, status: string): void {
    if (this.#stopping) return;
    const state = this.#active.get(agentId);
    if (!state) return;
    if (turnId && state.turnId && state.turnId !== turnId) return;
    this.#active.delete(agentId);
    const terminal = status === "failed" ? "failed" : status === "interrupted" ? "interrupted" : "completed";
    const delivery = this.#store.updateDelivery(state.deliveryId, { status: terminal, finishedAt: Date.now() });
    if (delivery) this.#updateMessageStatus(agentId, delivery.messageId, terminal);
    for (const messageId of state.assistantMessageIds) {
      const message = this.#store.getMessage(messageId);
      if (message?.status === "streaming") this.#updateMessageStatus(agentId, messageId, terminal);
    }
    if (state.askedQuestion) {
      // Lo pendiente es la pregunta: es lo que el usuario debe ver en la lista.
      this.#store.updateAgent(agentId, { preview: `Pregunta: ${state.askedQuestion}`.slice(0, 240) });
    } else if (terminal === "completed" && state.lastAssistantText.trim()) {
      this.#store.updateAgent(agentId, { preview: state.lastAssistantText.trim().slice(0, 240) });
    }
    this.#emitQueue(agentId);
    this.#emitAgents();
    if (delivery && this.#store.listRoutines(agentId).some((routine) => routine.lastDeliveryId === delivery.id)) this.#emitRoutines();

    if (
      terminal === "completed" &&
      delivery?.senderKind === "agent" &&
      delivery.senderAgentId &&
      !delivery.replyTo &&
      !state.sentTo.has(delivery.senderAgentId) &&
      state.lastAssistantText.trim()
    ) {
      // El compañero no contestó con send_message: le hacemos llegar su resultado igual.
      try {
        this.#sendTeammateMessage({
          fromAgentId: agentId,
          to: [delivery.senderAgentId],
          text: state.lastAssistantText.trim(),
          replyTo: delivery.messageId,
          hops: delivery.hops + 1,
          idempotencyKey: `auto:${delivery.id}`,
        });
      } catch (error) {
        this.#notice(agentId, `No se pudo devolver el resultado al remitente: ${errorText(error)}`);
      }
    }
    this.#scheduleDrain(agentId);
  }

  // ---------- internos: eventos del proveedor ----------

  #handleNotification(notification: AppServerNotification): void {
    if (this.#stopping) return;
    const params = notification.params;
    const threadId = getString(params, "threadId");
    const agentId = threadId ? this.#threadToAgent.get(threadId) : undefined;
    switch (notification.method) {
      case "turn/started": {
        if (!agentId) return;
        const turnId = getString(getRecord(params, "turn"), "id");
        const state = this.#active.get(agentId);
        if (state && turnId && !state.turnId) {
          state.turnId = turnId;
          this.#store.updateDelivery(state.deliveryId, { status: "running", turnId });
          this.#emitQueue(agentId);
        }
        return;
      }
      case "item/agentMessage/delta": {
        if (!agentId) return;
        const itemId = getString(params, "itemId");
        const delta = getString(params, "delta");
        if (!itemId || delta === null) return;
        const messageId = this.#ensureAssistantMessage(agentId, itemId, getString(params, "turnId"));
        this.#store.appendMessageText(messageId, delta);
        this.#emit({ type: "delta", agentId, messageId, delta });
        const state = this.#active.get(agentId);
        if (state) state.lastAssistantText = this.#store.getMessage(messageId)?.text ?? state.lastAssistantText;
        return;
      }
      case "item/completed": {
        if (!agentId) return;
        const item = getRecord(params, "item");
        if (!item) return;
        const itemId = getString(item, "id");
        const type = getString(item, "type");
        if (type === "agentMessage" && itemId) {
          const messageId = this.#ensureAssistantMessage(agentId, itemId, getString(params, "turnId"));
          const text = getString(item, "text");
          const message = this.#store.updateMessage(messageId, {
            ...(text !== null ? { text } : {}),
            status: "completed",
          });
          if (message) {
            this.#emit({ type: "message", agentId, message });
            const state = this.#active.get(agentId);
            if (state && message.text.trim()) state.lastAssistantText = message.text;
          }
          return;
        }
        if (type && ACTIVITY_ITEM_TYPES.has(type)) {
          const summary = summarizeActivity(item);
          if (!summary) return;
          const message = this.#store.insertMessage({
            agentId,
            role: "activity",
            text: summary,
            status: "completed",
            turnId: getString(params, "turnId"),
          });
          this.#emit({ type: "message", agentId, message });
        }
        return;
      }
      case "turn/completed": {
        if (!agentId) return;
        const turn = getRecord(params, "turn");
        this.#finishTurn(agentId, getString(turn, "id"), getString(turn, "status") ?? "completed");
        return;
      }
      case "error": {
        if (isRecord(params) && params.willRetry === true) return;
        const message = getString(getRecord(params, "error"), "message") ?? getString(params, "message") ?? "Error del proveedor.";
        if (agentId) this.#notice(agentId, `Error: ${message}`);
        else this.#emit({ type: "notice", level: "error", message });
        return;
      }
      default:
        return;
    }
  }

  #ensureAssistantMessage(agentId: string, itemId: string, turnId: string | null): string {
    const messageId = `${agentId}:${itemId}`;
    const state = this.#active.get(agentId);
    state?.assistantMessageIds.add(messageId);
    if (this.#store.getMessage(messageId)) return messageId;
    const message = this.#store.insertMessage({
      id: messageId,
      agentId,
      role: "assistant",
      text: "",
      status: "streaming",
      turnId,
      deliveryId: state?.deliveryId ?? null,
    });
    this.#emit({ type: "message", agentId, message });
    return messageId;
  }

  async #handleServerRequest(client: AgentClient, request: AppServerRequest): Promise<void> {
    if (this.#stopping) {
      try {
        client.respondError(request.id, { code: -32000, message: "Cuadrilla se está cerrando." });
      } catch {
        // El proceso pudo terminar entre medio.
      }
      return;
    }
    const threadId = getString(request.params, "threadId");
    const agentId = threadId ? this.#threadToAgent.get(threadId) : undefined;
    const agent = agentId ? this.#store.getAgent(agentId) : null;
    const total = agent?.access === "total";
    try {
      switch (request.method) {
        case "item/tool/call": {
          if (!isDynamicToolCall(request.params)) throw new Error("Llamada a herramienta inválida.");
          const params = request.params;
          if (params.namespace !== TEAM_NAMESPACE && params.namespace !== null) {
            throw new Error(`Grupo de herramientas no soportado: ${params.namespace}`);
          }
          client.respond(request.id, this.#handleTeamTool(params));
          return;
        }
        case "item/commandExecution/requestApproval":
        case "item/fileChange/requestApproval":
          client.respond(request.id, { decision: total ? "acceptForSession" : "decline" });
          return;
        case "applyPatchApproval":
        case "execCommandApproval":
          client.respond(request.id, { decision: total ? "approved_for_session" : "denied" });
          return;
        case "item/permissions/requestApproval": {
          const permissions = total ? (getRecord(request.params, "permissions") ?? {}) : {};
          client.respond(request.id, {
            permissions: Object.fromEntries(Object.entries(permissions).filter(([, value]) => value !== null)),
            scope: "turn",
          });
          return;
        }
        case "item/tool/requestUserInput":
          client.respond(request.id, { answers: {} });
          if (agentId) this.#notice(agentId, "El agente pidió que respondieras una pregunta; como no hay nadie atento en vivo, se le pidió que decida con su criterio.");
          return;
        case "mcpServer/elicitation/request":
          client.respond(request.id, { action: "decline", content: null, _meta: null });
          return;
        case "currentTime/read":
          client.respond(request.id, { currentTimeAt: Math.floor(Date.now() / 1_000) });
          return;
        default:
          client.respondError(request.id, { code: -32601, message: `Cuadrilla no implementa ${request.method}.` });
      }
    } catch (error) {
      if (request.method === "item/tool/call") {
        try {
          client.respond(request.id, {
            success: false,
            contentItems: [{ type: "inputText", text: errorText(error) }],
          } satisfies DynamicToolResult);
        } catch {
          // El proceso pudo terminar entre medio.
        }
        return;
      }
      try {
        client.respondError(request.id, { code: -32603, message: errorText(error) });
      } catch {
        // El proceso pudo terminar entre medio.
      }
    }
  }

  #handleTeamTool(params: DynamicToolCallParams): DynamicToolResult {
    const senderId = this.#threadToAgent.get(params.threadId);
    if (!senderId) throw new Error("No se reconoce al agente que envía.");
    if (params.tool === TOOL_LIST_AGENTS) {
      const agents = this.listAgents().map((agent) => ({
        id: agent.id,
        nombre: agent.name,
        rol: agent.role || "Asistente general",
        proveedor: agent.provider,
        estado: agent.state === "working" ? "trabajando" : agent.state === "queued" ? "con cola" : agent.state === "paused" ? "en pausa" : "libre",
        eresTu: agent.id === senderId,
      }));
      return toolResult({ agentes: agents });
    }
    if (params.tool === TOOL_ASK_USER) return this.#askUser(senderId, parseAskUserArgs(params.arguments), params.turnId);
    if (params.tool === TOOL_CREATE_ROUTINE) {
      const routine = this.createRoutine(senderId, isRecord(params.arguments) ? params.arguments : {}, "agent");
      return toolResult({
        creada: true,
        id: routine.id,
        nombre: routine.name,
        horario: routine.description,
        proxima: routine.nextRunAt ? formatWhen(routine.nextRunAt) : null,
      });
    }
    if (params.tool === TOOL_LIST_ROUTINES) {
      return toolResult({
        rutinas: this.listRoutines(senderId).map((routine) => ({
          id: routine.id,
          nombre: routine.name,
          horario: routine.description,
          activa: routine.enabled,
          proxima: routine.enabled && routine.nextRunAt ? formatWhen(routine.nextRunAt) : null,
          tarea: routine.prompt,
        })),
      });
    }
    if (params.tool === TOOL_DELETE_ROUTINE) {
      const { id } = parseRoutineIdArgs(params.arguments);
      const routine = this.#store.getRoutine(id);
      if (!routine || routine.agentId !== senderId) throw new Error("No tienes una rutina con ese id; míralas con list_routines.");
      this.deleteRoutine(id);
      return toolResult({ eliminada: true, nombre: routine.name });
    }
    if (params.tool !== TOOL_SEND_MESSAGE) throw new Error(`Herramienta desconocida: ${params.tool}`);
    const args = parseSendMessageArgs(params.arguments);
    const state = this.#active.get(senderId);
    const receipt = this.#sendTeammateMessage({
      fromAgentId: senderId,
      to: args.to,
      text: args.text,
      replyTo: args.replyToMessageId,
      hops: (state?.hops ?? 0) + 1,
      idempotencyKey: `${params.threadId}:${params.turnId}:${params.callId}`,
    });
    for (const recipient of receipt.recipients) state?.sentTo.add(recipient.id);
    return toolResult(receipt);
  }

  #askUser(agentId: string, args: AskUserArgs, turnId: string | null): DynamicToolResult {
    const message = this.#store.insertMessage({
      agentId,
      role: "decision",
      text: args.question,
      status: "completed",
      turnId,
      payload: { options: args.options, recommended: args.recommended, answer: null, answeredAt: null },
    });
    const state = this.#active.get(agentId);
    if (state) state.askedQuestion = args.question;
    else this.#store.updateAgent(agentId, { preview: `Pregunta: ${args.question}`.slice(0, 240) });
    this.#emit({ type: "message", agentId, message });
    this.#emitAgents();
    return toolResult({
      preguntado: true,
      messageId: message.id,
      nota: "La tarjeta ya está en la conversación. Termina tu turno ahora: la respuesta del usuario te llegará como un mensaje nuevo.",
    });
  }

  #fireRoutine(routine: RoutineRecord, scheduledAt: number, manual: boolean): void {
    const key = manual ? null : `routine:${routine.id}:${scheduledAt}`;
    const result = this.#store.transaction(() => {
      if (key && this.#store.findDeliveryByIdempotencyKey(key)) return null;
      const message = this.#store.insertMessage({
        agentId: routine.agentId,
        role: "routine",
        text: routine.name,
        status: "queued",
        payload: { routineId: routine.id, scheduledAt, schedule: describeSchedule(routine.schedule), manual },
      });
      const { delivery } = this.#store.enqueueDelivery({
        agentId: routine.agentId,
        messageId: message.id,
        senderKind: "user",
        text: composeRoutineInput(routine, scheduledAt, manual),
        idempotencyKey: key,
      });
      this.#store.updateRoutine(routine.id, { lastRunAt: Date.now(), lastDeliveryId: delivery.id });
      return this.#store.updateMessage(message.id, { deliveryId: delivery.id }) as MessageRecord;
    });
    if (!result) return;
    this.#emit({ type: "message", agentId: routine.agentId, message: result });
    this.#emitQueue(routine.agentId);
    this.#emitAgents();
    this.#scheduleDrain(routine.agentId);
  }

  #routinePending(routine: RoutineRecord): boolean {
    if (!routine.lastDeliveryId) return false;
    const status = this.#store.getDelivery(routine.lastDeliveryId)?.status;
    return status === "queued" || status === "starting" || status === "running";
  }

  #armRoutines(): void {
    if (this.#routineTimer) clearTimeout(this.#routineTimer);
    this.#routineTimer = null;
    if (this.#stopping) return;
    const next = this.#store.nextRoutineAt();
    if (next === null) return;
    // Como mínimo una revisión por minuto: así un cambio de hora o una suspensión no la dejan dormida.
    const delay = Math.max(0, Math.min(next - Date.now(), ROUTINE_CHECK_MS));
    this.#routineTimer = setTimeout(() => {
      this.#routineTimer = null;
      try {
        this.checkRoutines();
      } catch (error) {
        this.#log("error", `Fallo al revisar las rutinas: ${errorText(error)}`);
        this.#armRoutines();
      }
    }, delay);
    this.#routineTimer.unref();
  }

  #requireRoutine(id: string): RoutineRecord {
    const routine = this.#store.getRoutine(id);
    if (!routine) throw new ServiceError("Rutina no encontrada.", 404);
    return routine;
  }

  #routineView(routine: RoutineRecord): RoutineView {
    return {
      ...routine,
      description: describeSchedule(routine.schedule),
      agentName: this.#store.getAgent(routine.agentId)?.name ?? "",
      running: this.#routinePending(routine),
    };
  }

  #emitRoutines(): void {
    this.#emit({ type: "routines", routines: this.listRoutines() });
  }

  #sendTeammateMessage(input: {
    fromAgentId: string;
    to: string[];
    text: string;
    replyTo: string | null;
    hops: number;
    idempotencyKey: string;
  }): { enviado: true; recipients: Array<{ id: string; name: string; messageId: string }> } {
    const sender = this.#requireAgent(input.fromAgentId);
    if (input.hops > this.#options.maxHops) {
      throw new Error(
        `Se alcanzó el límite de ${this.#options.maxHops} reenvíos seguidos entre agentes. Termina la tarea tú mismo y responde al usuario.`,
      );
    }
    const recipients = [...new Map(input.to.map((ref) => {
      const agent = this.#resolveAgentRef(ref);
      return [agent.id, agent] as const;
    })).values()];
    if (recipients.some((agent) => agent.id === sender.id)) throw new Error("Un agente no puede enviarse mensajes a sí mismo.");

    const results = this.#store.transaction(() =>
      recipients.map((recipient) => {
        const key = `${input.idempotencyKey}:${recipient.id}`;
        const existing = this.#store.findDeliveryByIdempotencyKey(key);
        if (existing) return { recipient, message: this.#store.getMessage(existing.messageId), created: false };
        const message = this.#store.insertMessage({
          agentId: recipient.id,
          role: "teammate",
          text: input.text,
          status: "queued",
          fromAgentId: sender.id,
          replyTo: input.replyTo,
        });
        const { delivery } = this.#store.enqueueDelivery({
          agentId: recipient.id,
          messageId: message.id,
          senderKind: "agent",
          senderAgentId: sender.id,
          text: input.text,
          replyTo: input.replyTo,
          hops: input.hops,
          idempotencyKey: key,
        });
        return { recipient, message: this.#store.updateMessage(message.id, { deliveryId: delivery.id }), created: true };
      }),
    );

    if (results.some((result) => result.created)) {
      const notice = this.#store.insertMessage({
        agentId: sender.id,
        role: "notice",
        text: input.text,
        status: "completed",
        toAgentIds: recipients.map((agent) => agent.id),
        replyTo: input.replyTo,
      });
      this.#emit({ type: "message", agentId: sender.id, message: notice });
    }
    for (const result of results) {
      if (result.message) this.#emit({ type: "message", agentId: result.recipient.id, message: result.message });
      this.#emitQueue(result.recipient.id);
      this.#scheduleDrain(result.recipient.id);
    }
    this.#emitAgents();
    return {
      enviado: true,
      recipients: results.map((result) => ({ id: result.recipient.id, name: result.recipient.name, messageId: result.message?.id ?? "" })),
    };
  }

  #resolveAgentRef(ref: string): AgentRecord {
    const value = ref.trim().replace(/^@/, "");
    const byId = this.#store.getAgent(value);
    if (byId) return byId;
    const byName = this.#store.findAgentByName(value);
    if (byName) return byName;
    const names = this.#store.listAgents().map((agent) => agent.name).join(", ");
    throw new Error(`No existe el agente «${ref}». Agentes disponibles: ${names || "ninguno"}.`);
  }

  // ---------- internos: utilidades ----------

  #requireAgent(id: string): AgentRecord {
    const agent = this.#store.getAgent(id);
    if (!agent) throw new ServiceError("Agente no encontrado.", 404);
    return agent;
  }

  #view(agent: AgentRecord): AgentView {
    const queued = this.#store.countQueued(agent.id);
    const state: AgentState = this.#active.has(agent.id) ? "working" : agent.paused ? "paused" : queued > 0 ? "queued" : "idle";
    return { ...agent, state, queued, unread: agent.lastAt > agent.readAt };
  }

  #uniqueWorkspace(name: string): string {
    const base = slugify(name) || "agente";
    const taken = new Set(this.#store.listAgents().map((agent) => agent.workspace));
    let candidate = join(this.#options.workspacesDir, base);
    for (let index = 2; taken.has(candidate); index += 1) candidate = join(this.#options.workspacesDir, `${base}-${index}`);
    return candidate;
  }

  #updateMessageStatus(agentId: string, messageId: string, status: MessageRecord["status"]): void {
    const message = this.#store.updateMessage(messageId, { status });
    if (message) this.#emit({ type: "message", agentId, message });
  }

  #notice(agentId: string, text: string): void {
    if (!this.#store.getAgent(agentId)) return;
    const message = this.#store.insertMessage({ agentId, role: "notice", text, status: "completed" });
    this.#emit({ type: "message", agentId, message });
  }

  #emitQueue(agentId: string): void {
    this.#emit({ type: "queue", agentId, queue: this.#store.listQueue(agentId) });
  }

  #emitAgents(): void {
    this.#emit({ type: "agents", agents: this.listAgents() });
  }

  #emit(event: ServiceEvent): void {
    this.emit("event", event);
  }

  #log(level: "info" | "warn" | "error", message: string): void {
    this.#options.log?.(level, message);
  }
}

export function providerLabel(provider: ProviderId): string {
  return provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : "Demo";
}

function validProvider(value: unknown): ProviderId {
  if (value === "claude" || value === "codex" || value === "demo") return value;
  throw new ServiceError("Proveedor inválido: usa claude, codex o demo.");
}

function cleanName(value: unknown): string {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!name) throw new ServiceError("El agente necesita un nombre.");
  if (name.length > 60) throw new ServiceError("El nombre admite hasta 60 caracteres.");
  if (/[\u0000-\u001f]/.test(name)) throw new ServiceError("El nombre tiene caracteres no válidos.");
  return name;
}

function cleanText(value: unknown, max: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length > max) throw new ServiceError(`El texto admite hasta ${max} caracteres.`);
  return text;
}

function cleanProject(value: unknown): string {
  const project = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (project.length > 60) throw new ServiceError("El nombre del proyecto admite hasta 60 caracteres.");
  if (/[\u0000-\u001f]/.test(project)) throw new ServiceError("El proyecto tiene caracteres no válidos.");
  return project;
}

function cleanSettingName(value: unknown): string {
  if (typeof value !== "string") throw new ServiceError("El nombre debe ser texto.");
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length > 40) throw new ServiceError("El nombre admite hasta 40 caracteres.");
  if (/[\u0000-\u001f]/.test(name)) throw new ServiceError("El nombre tiene caracteres no válidos.");
  return name;
}

function asServiceError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw error instanceof ServiceError ? error : new ServiceError(errorText(error));
  }
}

function readOptions(payload: Record<string, unknown>): QuestionOption[] {
  return (Array.isArray(payload.options) ? payload.options : []).filter(isRecord).map((option) => ({
    label: typeof option.label === "string" ? option.label : "",
    detail: typeof option.detail === "string" ? option.detail : "",
  }));
}

function toolResult(value: unknown): DynamicToolResult {
  return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(value) }] };
}

/** Fecha y hora local corta, p. ej. «lun 3 nov, 09:00». */
export function formatWhen(time: number): string {
  return new Date(time).toLocaleString("es-CL", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Texto que recibe el agente cuando corre una de sus rutinas. */
function composeRoutineInput(routine: RoutineRecord, scheduledAt: number, manual: boolean): string {
  return [
    `Rutina programada «${routine.name}» (${describeSchedule(routine.schedule)}), ${manual ? "ejecutada a mano por el usuario" : formatWhen(scheduledAt)}.`,
    "Hazla ahora y deja el resultado en tu respuesta. Si algo necesita una decisión del usuario, pregúntale con ask_user.",
    "--- tarea ---",
    routine.prompt,
  ].join("\n");
}

/** Nombre de archivo seguro dentro de una carpeta, en Windows y en Linux. */
export function safeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  let name = base
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "");
  if (!name) name = "archivo";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) name = `_${name}`;
  if (name.length > 120) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : "";
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name;
}

function cleanOptional(value: unknown, max: number): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  if (text.length > max) throw new ServiceError(`El valor admite hasta ${max} caracteres.`);
  return text;
}

export function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resumen corto de una acción del agente (comando, archivos, herramienta) para mostrarla. */
export function summarizeActivity(item: Record<string, unknown>): string | null {
  const clip = (text: string, max = 400) => (text.length > max ? `${text.slice(0, max)}…` : text);
  switch (item.type) {
    case "commandExecution": {
      const command = getString(item, "command");
      if (!command) return null;
      const exit = typeof item.exitCode === "number" ? ` (salida ${item.exitCode})` : "";
      return `Ejecutó: ${clip(command)}${exit}`;
    }
    case "fileChange": {
      const changes = getArray(item, "changes")
        .filter(isRecord)
        .map((change) => `${getString(change, "path") ?? "?"}`);
      return changes.length ? `Modificó: ${clip(changes.join(", "))}` : null;
    }
    case "mcpToolCall":
      if (getString(item, "server") === TEAM_NAMESPACE) return null;
      return `Usó ${getString(item, "server") ?? "MCP"}.${getString(item, "tool") ?? "herramienta"}`;
    case "dynamicToolCall":
      // Las herramientas de Cuadrilla ya dejan su propia marca (mensaje enviado, pregunta, rutina).
      if ((getString(item, "namespace") ?? TEAM_NAMESPACE) === TEAM_NAMESPACE) return null;
      return `Usó ${getString(item, "namespace")}.${getString(item, "tool") ?? "herramienta"}`;
    case "webSearch":
      return `Buscó en la web: ${clip(getString(item, "query") ?? "")}`;
    case "imageGeneration":
      return "Generó una imagen.";
    case "toolCall": {
      const tool = getString(item, "tool") ?? "herramienta";
      const input = getRecord(item, "input") ?? {};
      const detail = ["command", "file_path", "path", "pattern", "url", "query", "description"]
        .map((key) => getString(input, key))
        .find((value) => value);
      if (tool.startsWith(`mcp__${TEAM_NAMESPACE}__`)) return null;
      return detail ? `${tool}: ${clip(detail)}` : `Usó ${tool}`;
    }
    default:
      return null;
  }
}
