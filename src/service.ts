import { EventEmitter } from "node:events";
import { mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { composeChannelInput, findMentions, uniqueName } from "./channels.js";
import {
  type AgentRecord,
  AVATAR_MAX,
  type ChannelRecord,
  type DeliveryRecord,
  type MessageRecord,
  type RoutineRecord,
  type Store,
  toVoice,
  type VoiceSettings,
} from "./db.js";
import { buildInstructions, composeDeliveryInput, composeGreeting, GREETING_MARKER } from "./instructions.js";
import { type AccessLevel, type AgentClient, isProviderId, PROVIDER_IDS, type ProviderId } from "./providers/client.js";
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
import { type SignInProvider, SignInFlows, type SignInResult, type SignInView } from "./providers/signin.js";
import { type CliCommand, runCli } from "./providers/spawn.js";
import { describeSchedule, nextRun, normalizeSchedule } from "./schedule.js";
import {
  type AskUserArgs,
  type CreateAgentArgs,
  parseAskUserArgs,
  parseCreateAgentArgs,
  parseCreateRoutineArgs,
  parseRoutineIdArgs,
  parseSendMessageArgs,
  parseUpdateAgentArgs,
  type QuestionOption,
  TEAM_NAMESPACE,
  teamDynamicTools,
  TOOL_ASK_USER,
  TOOL_CREATE_AGENT,
  TOOL_CREATE_ROUTINE,
  TOOL_DELETE_ROUTINE,
  TOOL_LIST_AGENTS,
  TOOL_LIST_ROUTINES,
  TOOL_SEND_MESSAGE,
  TOOL_UPDATE_AGENT,
  type UpdateAgentArgs,
} from "./team.js";
import { VERSION } from "./version.js";

export { VERSION };
export const PROVIDERS: ProviderId[] = [...PROVIDER_IDS];
/** Proveedores que se pueden instalar desde Ajustes (Claude viene con la app). */
export type InstallProvider = "codex" | "grok" | "gemini";

/** Rutinas: tope por agente y en total, y cuánto retraso se tolera antes de saltarse una ejecución. */
export const MAX_ROUTINES_PER_AGENT = 20;
export const MAX_ROUTINES = 100;
export const ROUTINE_GRACE_MS = 2 * 60 * 60_000;
const ROUTINE_CHECK_MS = 60_000;
/** Tamaño máximo de un archivo adjunto. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const SETTINGS_META = "settings";
export const DEFAULT_BOT_NAME = "ClosedBot";
/** Bot principal: arma los equipos de agentes. Su id se guarda aparte de los ajustes. */
export const MAIN_AGENT_META = "main_agent";
export const MAIN_AGENT_NAME = "Claude Bot";
export const MAIN_AGENT_ROLE = "Bot principal: arma y coordina tus equipos de agentes";
/** Topes para los agentes que crea el bot principal: en total y en un mismo turno. */
export const MAX_AGENTS = 60;
export const MAX_AGENTS_PER_TURN = 8;
const OPTION_LETTERS = "ABCD";
/** Secciones de la barra lateral creadas a mano (pueden quedar vacías); las demás salen del proyecto de cada agente. */
export const SECTIONS_META = "sections";
export const MAX_SECTIONS = 50;
/** Biblioteca: cuántos elementos muestra una carpeta como máximo. */
export const MAX_LIBRARY_ENTRIES = 500;
/** Canales activos como máximo, agentes por canal y mensajes anteriores que ve cada agente. */
export const MAX_CHANNELS = 50;
export const MAX_CHANNEL_MEMBERS = 12;
const CHANNEL_HISTORY = 12;
export const CHANNEL_LIMITS = { name: 60, topic: 300 } as const;
/** Uso del plan: cada cuánto se vuelve a leer y cuánto esperar como mínimo entre lecturas. */
const USAGE_INTERVAL_MS = 10 * 60_000;
const USAGE_MIN_GAP_MS = 60_000;
const USAGE_AFTER_TURN_MS = 2 * 60_000;
const USAGE_FIRST_MS = 20_000;

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  available: boolean;
  loggedIn: boolean | null;
  detail: string;
  /** Cuenta conectada, si el proveedor la informa. */
  account?: { email: string | null; plan: string | null } | null;
  /** Se puede iniciar y cerrar sesión desde la app. */
  canSignIn?: boolean;
  /** Se puede cerrar la sesión desde la app (Gemini CLI no tiene un comando para salir). */
  canSignOut?: boolean;
  /** Se puede instalar (o reinstalar) desde la app. */
  canInstall?: boolean;
  /** Programa que usa la app para este proveedor. */
  path?: string;
  /** Inicio de sesión en curso. */
  signIn?: SignInView | null;
  /** Instalación en curso. */
  install?: { startedAt: string } | null;
}

/** Comandos del CLI de un proveedor para iniciar y cerrar sesión con la cuenta de la persona. */
export interface SignInCommands {
  login: CliCommand;
  /** null: el programa no tiene cómo cerrar la sesión. */
  logout: CliCommand | null;
  /** Claude Code acepta pegar el código que muestra la página si el navegador no vuelve solo. */
  acceptsCode: boolean;
}

export type AgentState = "idle" | "working" | "queued" | "paused";

export interface AgentView extends AgentRecord {
  state: AgentState;
  queued: number;
  /** Hay mensajes del agente que el usuario aún no vio. */
  unread: boolean;
  /** Es el bot principal (Claude Bot): arma los equipos y no se puede eliminar. */
  main: boolean;
}

export interface RoutineView extends RoutineRecord {
  description: string;
  agentName: string;
  /** La última ejecución sigue en cola o en curso. */
  running: boolean;
}

/** Una ventana de uso del plan (p. ej. la semanal): porcentaje usado y cuándo se reinicia. */
export interface UsageWindow {
  id: string;
  label: string;
  percent: number;
  resetsAt: number | null;
}

/** Uso del plan de un proveedor, tal como lo informa su CLI. */
export interface UsageView {
  provider: ProviderId;
  label: string;
  plan: string | null;
  windows: UsageWindow[];
  updatedAt: number;
  error: string | null;
}

/** Un archivo o carpeta de la biblioteca de un agente. */
export interface LibraryEntry {
  name: string;
  /** Ruta relativa a la raíz, con «/». */
  path: string;
  dir: boolean;
  size: number;
  modifiedAt: number;
}

export type LibraryRoot = "agent" | "shared";

/** Nombres que muestra la interfaz (el del asistente arriba a la izquierda y el del usuario abajo). */
export interface Settings {
  botName: string;
  userName: string;
  /** Todos los agentes trabajan con acceso total (comandos sin pedir permiso), sea cual sea el nivel de cada uno. */
  fullAccess: boolean;
}

/** Un canal tal como lo ve la interfaz. */
export interface ChannelView extends ChannelRecord {
  unread: boolean;
  /** Miembros que están trabajando ahora en algo de este canal. */
  working: string[];
}

export interface ChannelInput {
  name?: unknown;
  topic?: unknown;
  memberIds?: unknown;
  leadId?: unknown;
}

export type ServiceEvent =
  | { type: "agents"; agents: AgentView[] }
  | { type: "channels"; channels: ChannelView[]; deleted: ChannelView[] }
  | { type: "message"; agentId: string; message: MessageRecord }
  | { type: "delta"; agentId: string; messageId: string; delta: string; channelId?: string | null }
  | { type: "queue"; agentId: string; queue: DeliveryRecord[] }
  | { type: "providers"; providers: ProviderStatus[] }
  | { type: "routines"; routines: RoutineView[] }
  | { type: "settings"; settings: Settings }
  | { type: "sections"; sections: string[] }
  | { type: "usage"; usage: UsageView[] }
  | { type: "notice"; level: "error" | "info"; message: string; agentId?: string };

export interface ServiceOptions {
  store: Store;
  workspacesDir: string;
  sharedDir: string;
  maxHops: number;
  createClient: (provider: ProviderId) => AgentClient;
  detectProviders?: () => Promise<ProviderStatus[]>;
  /** Cómo iniciar sesión en cada proveedor; null si en este equipo no se puede desde la app. */
  signInCommands?: (provider: SignInProvider) => SignInCommands | null;
  /** Tiempo máximo para terminar un inicio de sesión (10 minutos por defecto). */
  signInTimeoutMs?: number;
  /** Cómo instalar cada proveedor (npm o su instalador oficial); null si no se puede desde la app. */
  installCommands?: (provider: InstallProvider) => CliCommand | null;
  /** Tiempo máximo para una instalación (10 minutos por defecto). */
  installTimeoutMs?: number;
  /** Crea el bot principal (Claude Bot) al arrancar si aún no existe. */
  mainAgent?: boolean;
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
  /** Figura y color elegidos (ver AVATAR_CUSTOM_BASE). */
  avatar?: number;
  pinned?: boolean;
  hidden?: boolean;
  voice?: Partial<VoiceSettings>;
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
  /** Agentes que creó en este turno (solo el bot principal). */
  createdAgents: number;
  /** Canal del encargo: lo que escriba el agente se publica allí. */
  channelId: string | null;
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
  #mainAgentId: string | null = null;
  readonly #signIns: SignInFlows;
  readonly #installs: SignInFlows;
  readonly #usage = new Map<ProviderId, UsageView>();
  #usageTimer: NodeJS.Timeout | null = null;
  #usageSoon: NodeJS.Timeout | null = null;
  #usageRefresh: Promise<UsageView[]> | null = null;
  #usageReadAt = 0;

  constructor(options: ServiceOptions) {
    super();
    this.#options = options;
    this.#store = options.store;
    this.#signIns = new SignInFlows(options.signInTimeoutMs ? { timeoutMs: options.signInTimeoutMs } : {});
    this.#signIns.on("change", () => this.#emit({ type: "providers", providers: this.providers() }));
    this.#signIns.on("settled", (provider, result) => void this.#afterSignIn(provider, result));
    this.#installs = new SignInFlows({ action: "install", ...(options.installTimeoutMs ? { timeoutMs: options.installTimeoutMs } : {}) });
    this.#installs.on("change", () => this.#emit({ type: "providers", providers: this.providers() }));
    this.#installs.on("settled", (provider, result) => void this.#afterInstall(provider as InstallProvider, result));
  }

  // ---------- ciclo de vida ----------

  async start(): Promise<void> {
    mkdirSync(this.#options.workspacesDir, { recursive: true });
    mkdirSync(this.#options.sharedDir, { recursive: true });
    this.#ensureMainAgent();
    for (const delivery of this.#store.reconcileUnfinished()) {
      this.#notice(delivery.agentId, "La app se reinició mientras este agente trabajaba; ese turno quedó interrumpido.");
    }
    for (const agentId of this.#store.agentsWithQueuedWork()) this.#scheduleDrain(agentId);
    this.#armRoutines();
    void this.refreshProviders().then(() => this.#armUsage());
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#signIns.stopAll();
    this.#installs.stopAll();
    if (this.#routineTimer) clearTimeout(this.#routineTimer);
    this.#routineTimer = null;
    if (this.#usageTimer) clearInterval(this.#usageTimer);
    if (this.#usageSoon) clearTimeout(this.#usageSoon);
    this.#usageTimer = null;
    this.#usageSoon = null;
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
    const providers = this.providers();
    this.#emit({ type: "providers", providers });
    return providers;
  }

  providers(): ProviderStatus[] {
    return this.#providers.map((status) => {
      const signIn = status.id === "demo" ? null : this.#signIns.view(status.id);
      const installing = status.id === "demo" ? null : this.#installs.view(status.id);
      if (!signIn && !installing) return status;
      return { ...status, ...(signIn ? { signIn } : {}), ...(installing ? { install: { startedAt: installing.startedAt } } : {}) };
    });
  }

  // ---------- sesión de los proveedores ----------

  /** Abre el inicio de sesión del proveedor: su CLI abre el navegador para entrar con la cuenta. */
  startSignIn(provider: unknown): ProviderStatus[] {
    const id = signInProvider(provider);
    const commands = this.#signInCommands(id);
    try {
      this.#signIns.start(id, commands.login, { acceptsCode: commands.acceptsCode });
    } catch (error) {
      throw new ServiceError(`No pude abrir el inicio de sesión de ${providerLabel(id)}: ${errorText(error)}`, 502);
    }
    this.#log("info", `Abrí el inicio de sesión de ${providerLabel(id)}.`);
    return this.providers();
  }

  /** Código que muestra la página de inicio de sesión cuando el navegador no vuelve solo a la app. */
  submitSignInCode(provider: unknown, code: unknown): void {
    const id = signInProvider(provider);
    const value = typeof code === "string" ? code.trim() : "";
    if (!value) throw new ServiceError("Pega el código que te mostró la página.");
    if (!/^[^\s#]{1,2048}#[^\s#]{1,2048}$/.test(value)) {
      throw new ServiceError("Ese código no está completo: cópialo entero desde la página e inténtalo otra vez.");
    }
    try {
      this.#signIns.submitCode(id, value);
    } catch (error) {
      throw new ServiceError(errorText(error), 409);
    }
  }

  cancelSignIn(provider: unknown): ProviderStatus[] {
    this.#signIns.cancel(signInProvider(provider));
    return this.providers();
  }

  /** Cierra la sesión del proveedor en la app (no la del CLI que la persona use por su cuenta). */
  async signOut(provider: unknown): Promise<ProviderStatus[]> {
    const id = signInProvider(provider);
    const commands = this.#signInCommands(id);
    const status = this.#providers.find((item) => item.id === id);
    if (!commands.logout || status?.canSignOut === false) {
      throw new ServiceError(`${providerLabel(id)} no tiene un comando para cerrar la sesión desde la app.`, 409);
    }
    if ([...this.#active.values()].some((state) => state.provider === id)) {
      throw new ServiceError(`Hay agentes de ${providerLabel(id)} trabajando: espera a que terminen o detenlos antes de cerrar la sesión.`, 409);
    }
    this.#signIns.cancel(id);
    const result = await runCli(commands.logout, 30_000);
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout).trim().split(/\r?\n/).at(-1)?.slice(0, 300) || (result.error?.message ?? "sin respuesta");
      throw new ServiceError(`No se pudo cerrar la sesión de ${providerLabel(id)}: ${detail}`, 502);
    }
    this.#log("info", `Cerré la sesión de ${providerLabel(id)}.`);
    await this.#dropClient(id);
    return this.refreshProviders();
  }

  #signInCommands(provider: SignInProvider): SignInCommands {
    const commands = this.#options.signInCommands?.(provider) ?? null;
    if (!commands) throw new ServiceError(`En este equipo no se puede iniciar sesión en ${providerLabel(provider)} desde la app.`, 409);
    return commands;
  }

  async #afterSignIn(provider: SignInProvider, result: SignInResult): Promise<void> {
    if (this.#stopping) return;
    const label = providerLabel(provider);
    if (!result.ok) {
      if (result.message) {
        this.#log("warn", `El inicio de sesión de ${label} no terminó: ${result.message}`);
        this.#emit({ type: "notice", level: "error", message: result.message });
      }
      this.#emit({ type: "providers", providers: this.providers() });
      return;
    }
    this.#log("info", `${label} quedó conectado.`);
    // Los procesos que ya estaban abiertos arrancaron sin la sesión nueva.
    await this.#dropClient(provider);
    const providers = await this.refreshProviders();
    const email = providers.find((status) => status.id === provider)?.account?.email;
    this.#emit({ type: "notice", level: "info", message: `${label} quedó conectado${email ? ` como ${email}` : ""}.` });
  }

  // ---------- instalación de los proveedores ----------

  /** Instala el programa del proveedor con su instalador oficial (npm para Codex y Gemini CLI). */
  startInstall(provider: unknown): ProviderStatus[] {
    const id = installProvider(provider);
    const command = this.#options.installCommands?.(id) ?? null;
    if (!command) throw new ServiceError(`En este equipo no se puede instalar ${providerLabel(id)} desde la app.`, 409);
    if (this.#installs.view(id)) return this.providers();
    // Un programa en uso no se puede reemplazar (en Windows, el archivo está bloqueado).
    if ([...this.#active.values()].some((state) => state.provider === id)) {
      throw new ServiceError(`Hay agentes de ${providerLabel(id)} trabajando: espera a que terminen o detenlos antes de instalar.`, 409);
    }
    this.#signIns.cancel(id);
    void this.#dropClient(id);
    try {
      this.#installs.start(id, command, { acceptsCode: false });
    } catch (error) {
      throw new ServiceError(`No pude abrir el instalador de ${providerLabel(id)}: ${errorText(error)}`, 502);
    }
    this.#log("info", `Instalando ${providerLabel(id)}…`);
    return this.providers();
  }

  cancelInstall(provider: unknown): ProviderStatus[] {
    this.#installs.cancel(installProvider(provider));
    return this.providers();
  }

  async #afterInstall(provider: InstallProvider, result: SignInResult): Promise<void> {
    if (this.#stopping) return;
    const label = providerLabel(provider);
    if (!result.ok) {
      if (result.message) {
        this.#log("warn", `La instalación de ${label} no terminó: ${result.message}`);
        this.#emit({ type: "notice", level: "error", message: `${label}: ${result.message}` });
      }
      this.#emit({ type: "providers", providers: this.providers() });
      return;
    }
    this.#log("info", `${label} quedó instalado.`);
    await this.#dropClient(provider);
    const providers = await this.refreshProviders();
    const status = providers.find((item) => item.id === provider);
    let message: string;
    if (!status?.available) message = `Terminó la instalación de ${label}, pero todavía no lo encuentro. Cierra y abre ClosedBot, y vuelve a mirar en Ajustes.`;
    else if (status.loggedIn === true) message = `${label} quedó instalado y listo.`;
    else message = `${label} quedó instalado. Ahora pulsa «${signInButton(provider)}».`;
    this.#emit({ type: "notice", level: status?.available ? "info" : "error", message });
  }

  /** Cierra el cliente de un proveedor sin turnos activos: el próximo mensaje abre uno nuevo. */
  async #dropClient(provider: ProviderId): Promise<void> {
    if ([...this.#active.values()].some((state) => state.provider === provider)) return;
    const ready = this.#clientReady.get(provider);
    this.#clientReady.delete(provider);
    const client = this.#clients.get(provider) ?? (await ready?.catch(() => null)) ?? null;
    this.#clients.delete(provider);
    for (const key of [...this.#loadedThreads]) if (key.startsWith(`${provider}:`)) this.#loadedThreads.delete(key);
    if (!client) return;
    client.removeAllListeners();
    await client.stop().catch(() => undefined);
  }

  async listModels(provider: ProviderId): Promise<Array<{ model: string; displayName: string; isDefault?: boolean; efforts: string[] }>> {
    // Codex, Grok y Gemini son programas aparte: si no están instalados (o no tienen sesión) no se arrancan.
    if (provider === "codex" || provider === "grok" || provider === "gemini") {
      const status = this.#providers.find((item) => item.id === provider);
      if (!status?.available || (provider !== "codex" && status.loggedIn === false)) return [];
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

  /** `greet`: el agente lo creó el usuario a mano, así que se presenta con un primer mensaje. */
  createAgent(input: AgentInput, options: { greet?: boolean } = {}): AgentView {
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
      ...(input.avatar === undefined ? {} : { avatar: cleanAvatar(input.avatar) }),
    });
    let created = agent;
    if (input.voice !== undefined || input.pinned !== undefined || input.hidden !== undefined) {
      created = this.#store.updateAgent(agent.id, {
        ...(input.voice === undefined ? {} : { voice: toVoice({ ...agent.voice, ...input.voice }) }),
        ...(input.pinned === undefined ? {} : { pinned: input.pinned === true }),
        ...(input.hidden === undefined ? {} : { hidden: input.hidden === true }),
      });
    }
    this.#emitAgents();
    if (options.greet) this.#greet(created);
    return this.#view(created);
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
    if (patch.avatar !== undefined) next.avatar = cleanAvatar(patch.avatar);
    if (patch.pinned !== undefined) next.pinned = patch.pinned === true;
    if (patch.hidden !== undefined) next.hidden = patch.hidden === true;
    if (patch.voice !== undefined) next.voice = toVoice({ ...agent.voice, ...patch.voice });
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
    if (this.#isMain(agent)) {
      throw new ServiceError(`${agent.name} es el bot principal y no se puede eliminar. Si quieres, empieza su conversación de cero.`, 409);
    }
    if (this.#active.has(id)) throw new ServiceError("Detén el turno en curso antes de eliminar el agente.", 409);
    this.#store.cancelQueuedForAgent(id);
    await this.#closeThread(agent);
    const touchedChannels = this.#leaveChannels(id);
    this.#store.deleteAgent(id);
    this.#emitAgents();
    if (touchedChannels) this.#emitChannels();
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

  /** «Marcar como no leído»: vuelve a mostrar el aviso aunque no haya mensajes nuevos. */
  markUnread(id: string): AgentView {
    this.#requireAgent(id);
    const updated = this.#store.updateAgent(id, { readAt: -1 });
    this.#emitAgents();
    return this.#view(updated);
  }

  /** «Marcar todo como leído» desde la barra lateral. Devuelve cuántos agentes tenían novedades. */
  markAllRead(): number {
    const now = Date.now();
    let changed = 0;
    let channels = 0;
    for (const agent of this.#store.listAgents()) {
      if (agent.lastAt <= agent.readAt) continue;
      this.#store.updateAgent(agent.id, { readAt: Math.max(now, agent.lastAt) });
      changed += 1;
    }
    for (const channel of this.#store.listChannels()) {
      if (channel.lastAt <= channel.readAt) continue;
      this.#store.updateChannel(channel.id, { readAt: Math.max(now, channel.lastAt) });
      channels += 1;
    }
    if (changed) this.#emitAgents();
    if (channels) this.#emitChannels();
    return changed + channels;
  }

  // ---------- secciones de la barra lateral ----------

  /** Secciones creadas a mano, en orden. La interfaz les suma las que salen del proyecto de cada agente. */
  listSections(): string[] {
    try {
      const parsed: unknown = JSON.parse(this.#store.getMeta(SECTIONS_META) ?? "[]");
      if (!Array.isArray(parsed)) return [];
      const seen = new Set<string>();
      return parsed
        .filter((item): item is string => typeof item === "string" && item.trim() !== "")
        .filter((item) => {
          const key = item.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    } catch {
      return [];
    }
  }

  createSection(rawName: unknown): string[] {
    const name = cleanProject(rawName);
    if (!name) throw new ServiceError("Ponle un nombre a la sección.");
    const sections = this.listSections();
    if (this.#sectionExists(name)) throw new ServiceError(`Ya existe una sección llamada «${name}».`, 409);
    if (sections.length >= MAX_SECTIONS) throw new ServiceError(`Puedes tener hasta ${MAX_SECTIONS} secciones.`, 409);
    return this.#saveSections([...sections, name]);
  }

  /** Cambia el nombre de una sección y mueve a sus agentes. */
  renameSection(rawFrom: unknown, rawTo: unknown): string[] {
    const from = cleanProject(rawFrom);
    const to = cleanProject(rawTo);
    if (!from || !this.#sectionExists(from)) throw new ServiceError("Sección no encontrada.", 404);
    if (!to) throw new ServiceError("Ponle un nombre a la sección.");
    if (to.toLowerCase() !== from.toLowerCase() && this.#sectionExists(to)) throw new ServiceError(`Ya existe una sección llamada «${to}».`, 409);
    const sections = this.listSections();
    const index = sections.findIndex((item) => item.toLowerCase() === from.toLowerCase());
    if (index >= 0) sections[index] = to;
    let moved = 0;
    for (const agent of this.#store.listAgents()) {
      if (agent.project.toLowerCase() !== from.toLowerCase()) continue;
      this.#store.updateAgent(agent.id, { project: to });
      moved += 1;
    }
    const result = this.#saveSections(sections);
    if (moved) this.#emitAgents();
    return result;
  }

  /** Quita una sección: sus agentes pasan a «Sin asignar». */
  deleteSection(rawName: unknown): string[] {
    const name = cleanProject(rawName);
    if (!name || !this.#sectionExists(name)) throw new ServiceError("Sección no encontrada.", 404);
    let moved = 0;
    for (const agent of this.#store.listAgents()) {
      if (agent.project.toLowerCase() !== name.toLowerCase()) continue;
      this.#store.updateAgent(agent.id, { project: "" });
      moved += 1;
    }
    const result = this.#saveSections(this.listSections().filter((item) => item.toLowerCase() !== name.toLowerCase()));
    if (moved) this.#emitAgents();
    return result;
  }

  #sectionExists(name: string): boolean {
    const key = name.toLowerCase();
    return (
      this.listSections().some((item) => item.toLowerCase() === key) ||
      this.#store.listAgents().some((agent) => !this.#isMain(agent) && agent.project.toLowerCase() === key)
    );
  }

  #saveSections(sections: string[]): string[] {
    this.#store.setMeta(SECTIONS_META, JSON.stringify(sections));
    const saved = this.listSections();
    this.#emit({ type: "sections", sections: saved });
    return saved;
  }

  // ---------- biblioteca ----------

  /** Archivos de la carpeta del agente o de la compartida, para verlos y descargarlos desde la interfaz. */
  listLibrary(agentId: string, root: LibraryRoot, relativePath: string): { root: LibraryRoot; path: string; base: string; entries: LibraryEntry[]; truncated: boolean } {
    const { base, target, path } = this.#libraryPath(agentId, root, relativePath);
    let info;
    try {
      info = statSync(target);
    } catch {
      if (!path) return { root, path, base, entries: [], truncated: false };
      throw new ServiceError("Esa carpeta ya no existe.", 404);
    }
    if (!info.isDirectory()) throw new ServiceError("Eso es un archivo, no una carpeta.", 400);
    const entries: LibraryEntry[] = [];
    let total = 0;
    for (const dirent of readdirSync(target, { withFileTypes: true })) {
      if (dirent.name.startsWith(".")) continue;
      total += 1;
      if (entries.length >= MAX_LIBRARY_ENTRIES) continue;
      const full = join(target, dirent.name);
      try {
        const stat = statSync(full);
        entries.push({
          name: dirent.name,
          path: path ? `${path}/${dirent.name}` : dirent.name,
          dir: stat.isDirectory(),
          size: stat.isDirectory() ? 0 : stat.size,
          modifiedAt: Math.round(stat.mtimeMs),
        });
      } catch {
        // Un enlace roto o un archivo que se borró mientras leíamos: se omite.
      }
    }
    entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, "es", { sensitivity: "base", numeric: true }));
    return { root, path, base, entries, truncated: total > entries.length };
  }

  /** Ruta real de un archivo de la biblioteca, comprobando que no salga de su raíz. */
  libraryFile(agentId: string, root: LibraryRoot, relativePath: string): { path: string; name: string; size: number; modifiedAt: number } {
    const { target, path } = this.#libraryPath(agentId, root, relativePath);
    if (!path) throw new ServiceError("Indica un archivo.", 400);
    let info;
    try {
      info = statSync(target);
    } catch {
      throw new ServiceError("Ese archivo ya no existe.", 404);
    }
    if (!info.isFile()) throw new ServiceError("Eso no es un archivo.", 400);
    return { path: target, name: target.split(sep).pop() ?? "archivo", size: info.size, modifiedAt: Math.round(info.mtimeMs) };
  }

  /** Carpeta de trabajo y compartida de un agente (para la pestaña «Computadora»). */
  libraryBase(agentId: string, root: LibraryRoot): string {
    const agent = this.#requireAgent(agentId);
    return root === "shared" ? this.#options.sharedDir : agent.workspace;
  }

  #libraryPath(agentId: string, root: LibraryRoot, relativePath: string): { base: string; target: string; path: string } {
    const base = this.libraryBase(agentId, root);
    const parts = String(relativePath ?? "")
      .split(/[\\/]+/)
      .filter((part) => part !== "" && part !== ".");
    if (parts.some((part) => part === ".." || part.includes("\0") || /^[a-zA-Z]:$/.test(part))) throw new ServiceError("Ruta no válida.", 400);
    const target = resolve(base, ...parts);
    const realBase = safeRealpath(base);
    const realTarget = safeRealpath(target);
    // Comprueba también los enlaces simbólicos: la ruta real tiene que seguir dentro de la raíz.
    if (!isInside(resolve(base), target) || (realBase && realTarget && !isInside(realBase, realTarget))) {
      throw new ServiceError("Ruta no válida.", 400);
    }
    return { base, target, path: parts.join("/") };
  }

  // ---------- uso del plan ----------

  usage(): UsageView[] {
    return [...this.#usage.values()];
  }

  /**
   * Vuelve a leer el uso del plan de los proveedores con sesión (como /usage en Claude Code).
   * Con `force` falso devuelve lo guardado si la última lectura es de hace menos de un minuto.
   */
  refreshUsage(force = false): Promise<UsageView[]> {
    if (this.#usageRefresh) return this.#usageRefresh;
    if (!force && Date.now() - this.#usageReadAt < USAGE_MIN_GAP_MS) return Promise.resolve(this.usage());
    this.#usageRefresh = this.#readUsage().finally(() => {
      this.#usageRefresh = null;
    });
    return this.#usageRefresh;
  }

  async #readUsage(): Promise<UsageView[]> {
    this.#usageReadAt = Date.now();
    for (const provider of ["claude", "codex"] as const) {
      const status = this.#providers.find((item) => item.id === provider);
      // Solo con la sesión confirmada (con la detección apagada no se sabe y no se arranca nada).
      // Codex, además, solo si ya está en marcha: leer el uso no debe arrancar su proceso.
      const ready =
        Boolean(status?.available) && status?.loggedIn === true && (provider === "claude" || Boolean(this.#clients.get("codex")?.running));
      if (!ready) {
        if (status?.loggedIn === false) this.#usage.delete(provider);
        continue;
      }
      try {
        const client = await this.#getClient(provider);
        const response = await client.request<unknown>("account/rateLimits/read", {}, 30_000);
        const parsed = parseUsage(provider, response);
        if (parsed) this.#usage.set(provider, parsed);
        else this.#usage.delete(provider);
      } catch (error) {
        const previous = this.#usage.get(provider);
        const message = errorText(error);
        if (/no implementa|not implemented|unknown method/i.test(message)) continue;
        this.#usage.set(provider, {
          provider,
          label: providerLabel(provider),
          plan: previous?.plan ?? null,
          windows: previous?.windows ?? [],
          updatedAt: previous?.updatedAt ?? Date.now(),
          error: `No se pudo leer el uso: ${message}`,
        });
      }
    }
    const usage = this.usage();
    this.#emit({ type: "usage", usage });
    return usage;
  }

  #armUsage(): void {
    if (this.#stopping || this.#usageTimer) return;
    // La primera lectura espera un poco: al arrancar no hace falta abrir otro proceso de Claude enseguida.
    this.#usageSoon ??= setTimeout(() => {
      this.#usageSoon = null;
      void this.refreshUsage(true).catch(() => undefined);
    }, USAGE_FIRST_MS);
    this.#usageSoon.unref();
    this.#usageTimer = setInterval(() => void this.refreshUsage(true).catch(() => undefined), USAGE_INTERVAL_MS);
    this.#usageTimer.unref();
  }

  /** Tras un turno el uso cambió: se vuelve a leer, como mucho una vez cada dos minutos. */
  #usageAfterTurn(): void {
    if (this.#stopping || this.#usageSoon) return;
    const wait = Math.max(5_000, USAGE_AFTER_TURN_MS - (Date.now() - this.#usageReadAt));
    this.#usageSoon = setTimeout(() => {
      this.#usageSoon = null;
      void this.refreshUsage(true).catch(() => undefined);
    }, wait);
    this.#usageSoon.unref();
  }

  // ---------- saludo inicial ----------

  /** El agente que acaba de crear el usuario se presenta: el pedido va oculto y solo se ve su respuesta. */
  #greet(agent: AgentRecord): void {
    const team = this.#store.listAgents().filter((other) => other.id !== agent.id && !this.#isMain(other));
    const text = composeGreeting(agent, this.getSettings().userName, team);
    const message = this.#store.transaction(() => {
      const inserted = this.#store.insertMessage({
        agentId: agent.id,
        role: "activity",
        text: "Saludo inicial",
        status: "queued",
        payload: { kind: "greeting" },
      });
      const { delivery } = this.#store.enqueueDelivery({
        agentId: agent.id,
        messageId: inserted.id,
        senderKind: "user",
        text,
        idempotencyKey: `greeting:${agent.id}`,
      });
      return this.#store.updateMessage(inserted.id, { deliveryId: delivery.id }) as MessageRecord;
    });
    this.#emit({ type: "message", agentId: agent.id, message });
    this.#emitQueue(agent.id);
    this.#emitAgents();
    this.#scheduleDrain(agent.id);
  }

  /** Id del bot principal (Claude Bot), o null si esta instalación no lo tiene. */
  mainAgentId(): string | null {
    return this.#mainAgentId;
  }

  /** Busca el bot principal guardado; si falta, adopta un agente que ya se llame así o lo crea. */
  #ensureMainAgent(): void {
    const stored = this.#store.getMeta(MAIN_AGENT_META);
    const existing = stored ? this.#store.getAgent(stored) : null;
    this.#mainAgentId = existing?.id ?? null;
    if (existing || !this.#options.mainAgent) return;
    const adopted = this.#store.findAgentByName(MAIN_AGENT_NAME);
    let agent = adopted;
    if (!agent) {
      const workspace = this.#uniqueWorkspace(MAIN_AGENT_NAME);
      mkdirSync(workspace, { recursive: true });
      agent = this.#store.createAgent({
        name: MAIN_AGENT_NAME,
        role: MAIN_AGENT_ROLE,
        instructions: "",
        provider: "claude",
        model: null,
        effort: null,
        access: "carpeta",
        workspace,
        project: "",
      });
    }
    this.#store.setMeta(MAIN_AGENT_META, agent.id);
    this.#mainAgentId = agent.id;
    this.#log("info", adopted ? `«${agent.name}» pasa a ser el bot principal.` : `Creé el bot principal «${agent.name}».`);
  }

  #isMain(agent: AgentRecord): boolean {
    return agent.id === this.#mainAgentId;
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
      // «Cuadrilla» era el nombre por defecto antes de que la app se llamara ClosedBot.
      botName: typeof stored.botName === "string" && stored.botName && stored.botName !== "Cuadrilla" ? stored.botName : DEFAULT_BOT_NAME,
      userName: typeof stored.userName === "string" ? stored.userName : "",
      fullAccess: stored.fullAccess === true,
    };
  }

  updateSettings(patch: { botName?: unknown; userName?: unknown; fullAccess?: unknown }): Settings {
    if (patch.fullAccess !== undefined && typeof patch.fullAccess !== "boolean") {
      throw new ServiceError("El acceso total para todos debe ser true o false.", 400);
    }
    const current = this.getSettings();
    const next: Settings = {
      botName: patch.botName === undefined ? current.botName : cleanSettingName(patch.botName) || DEFAULT_BOT_NAME,
      userName: patch.userName === undefined ? current.userName : cleanSettingName(patch.userName),
      fullAccess: patch.fullAccess === undefined ? current.fullAccess : patch.fullAccess,
    };
    this.#store.setMeta(SETTINGS_META, JSON.stringify(next));
    if (next.fullAccess !== current.fullAccess) {
      // Cada agente vuelve a enviar su configuración en el próximo turno, y el proveedor
      // reinicia su proceso con el acceso nuevo. Un turno en curso termina con el de antes.
      this.#loadedThreads.clear();
      this.#log("warn", next.fullAccess ? "Acceso total activado para todos los agentes." : "Acceso total para todos desactivado: cada agente vuelve a su nivel.");
    }
    this.#emit({ type: "settings", settings: next });
    return next;
  }

  /** Nivel de acceso con el que trabaja un agente: el suyo, salvo que en Ajustes esté el acceso total para todos. */
  #access(agent: AgentRecord): AccessLevel {
    return this.getSettings().fullAccess ? "total" : agent.access;
  }

  // ---------- canales ----------

  listChannels(): ChannelView[] {
    return this.#store.listChannels().map((channel) => this.#channelView(channel));
  }

  /** «Canales eliminados»: se pueden restaurar o borrar para siempre. */
  listDeletedChannels(): ChannelView[] {
    return this.#store.listChannels({ deleted: true }).map((channel) => this.#channelView(channel));
  }

  getChannel(id: string): ChannelView {
    return this.#channelView(this.#requireChannel(id));
  }

  createChannel(input: ChannelInput): ChannelView {
    if (this.#store.listChannels().length >= MAX_CHANNELS) {
      throw new ServiceError(`Ya tienes ${MAX_CHANNELS} canales, el máximo. Elimina alguno que no uses.`, 409);
    }
    const name = channelName(input.name);
    if (this.#store.findChannelByName(name)) throw new ServiceError(`Ya existe un canal llamado «${name}».`, 409);
    const memberIds = this.#channelMembers(input.memberIds);
    const leadId = this.#channelLead(input.leadId, memberIds);
    const channel = this.#store.createChannel({ name, topic: channelTopic(input.topic), leadId, memberIds });
    this.#log("info", `Creé el canal «${name}».`);
    this.#emitChannels();
    return this.#channelView(channel);
  }

  updateChannel(id: string, patch: ChannelInput): ChannelView {
    const channel = this.#requireChannel(id);
    const next: Partial<Pick<ChannelRecord, "name" | "topic" | "leadId" | "memberIds">> = {};
    if (patch.name !== undefined) {
      const name = channelName(patch.name);
      const other = this.#store.findChannelByName(name);
      if (other && other.id !== id) throw new ServiceError(`Ya existe un canal llamado «${name}».`, 409);
      next.name = name;
    }
    if (patch.topic !== undefined) next.topic = channelTopic(patch.topic);
    const memberIds = patch.memberIds !== undefined ? this.#channelMembers(patch.memberIds) : channel.memberIds;
    if (patch.memberIds !== undefined) next.memberIds = memberIds;
    if (patch.leadId !== undefined || patch.memberIds !== undefined) {
      // Si el encargado deja el canal, pasa a serlo el primero de los que quedan.
      const wanted = patch.leadId !== undefined ? patch.leadId : memberIds.includes(channel.leadId ?? "") ? channel.leadId : null;
      next.leadId = this.#channelLead(wanted, memberIds);
    }
    const updated = this.#store.updateChannel(id, next);
    this.#emitChannels();
    return this.#channelView(updated);
  }

  /** Lo mueve a «Canales eliminados»: lo que esperaba turno se cancela y se puede restaurar después. */
  deleteChannel(id: string): ChannelView {
    const channel = this.#requireChannel(id);
    if (channel.deletedAt) return this.#channelView(channel);
    const cancelled = this.#store.cancelQueuedForChannel(id);
    const updated = this.#store.updateChannel(id, { deletedAt: Date.now() });
    for (const agentId of new Set(cancelled.map((delivery) => delivery.agentId))) this.#emitQueue(agentId);
    this.#emitAgents();
    this.#emitChannels();
    return this.#channelView(updated);
  }

  restoreChannel(id: string): ChannelView {
    const channel = this.#requireChannel(id);
    if (!channel.deletedAt) return this.#channelView(channel);
    if (this.#store.listChannels().length >= MAX_CHANNELS) {
      throw new ServiceError(`Ya tienes ${MAX_CHANNELS} canales activos: elimina uno antes de restaurar otro.`, 409);
    }
    // Si mientras tanto se creó otro con el mismo nombre, el restaurado se llama «Nombre (2)».
    const name = uniqueName(channel.name, (candidate) => Boolean(this.#store.findChannelByName(candidate)), CHANNEL_LIMITS.name);
    const memberIds = channel.memberIds.filter((agentId) => this.#store.getAgent(agentId));
    const updated = this.#store.updateChannel(id, {
      name,
      memberIds,
      leadId: memberIds.includes(channel.leadId ?? "") ? channel.leadId : (memberIds[0] ?? null),
      deletedAt: null,
    });
    this.#emitChannels();
    return this.#channelView(updated);
  }

  /** Borra para siempre un canal de «Canales eliminados», con todos sus mensajes. */
  purgeChannel(id: string): void {
    const channel = this.#requireChannel(id);
    if (!channel.deletedAt) throw new ServiceError("Primero elimina el canal; después se puede borrar para siempre desde «Canales eliminados».", 409);
    if ([...this.#active.values()].some((state) => state.channelId === id)) {
      throw new ServiceError("Un agente todavía está terminando algo de este canal: espera un momento y vuelve a intentarlo.", 409);
    }
    this.#store.deleteChannel(id);
    this.#emitChannels();
  }

  listChannelMessages(id: string, limit?: number, beforeSeq?: number) {
    this.#requireChannel(id);
    return this.#store.listChannelMessages(id, limit, beforeSeq);
  }

  /**
   * Mensaje del usuario en el canal: lo atiende el encargado, salvo que nombre a alguien con @Nombre
   * (o a todos con @todos). Cada uno lo recibe en su cola y responde en el canal.
   */
  sendChannelMessage(id: string, text: string): { message: MessageRecord; recipients: Array<{ id: string; name: string }> } {
    const channel = this.#requireChannel(id);
    if (channel.deletedAt) throw new ServiceError("Ese canal está en «Canales eliminados»: restáuralo para escribir en él.", 409);
    const body = text.trim();
    if (!body) throw new ServiceError("El mensaje está vacío.");
    if (body.length > 100_000) throw new ServiceError("El mensaje supera los 100.000 caracteres.");
    const members = channel.memberIds.map((agentId) => this.#store.getAgent(agentId)).filter((agent): agent is AgentRecord => agent !== null);
    if (!members.length) throw new ServiceError("Este canal no tiene agentes: agrega al menos uno con «Editar canal».", 409);
    const lead = members.find((agent) => agent.id === channel.leadId) ?? (members[0] as AgentRecord);
    const mentioned = findMentions(body, members);
    const recipients = mentioned.length ? members.filter((agent) => mentioned.includes(agent.id)) : [lead];
    // El mensaje lo guarda el bot principal (que no se elimina) para que no desaparezca con un agente.
    const owner = this.#mainAgentId && this.#store.getAgent(this.#mainAgentId) ? this.#mainAgentId : (recipients[0] as AgentRecord).id;
    const message = this.#store.transaction(() => {
      const inserted = this.#store.insertMessage({
        agentId: owner,
        channelId: id,
        role: "user",
        text: body,
        status: "completed",
        payload: { to: recipients.map((agent) => agent.id) },
      });
      for (const recipient of recipients) {
        this.#store.enqueueDelivery({ agentId: recipient.id, messageId: inserted.id, senderKind: "user", text: body, channelId: id });
      }
      this.#store.updateChannel(id, { preview: `Tú: ${body}`.slice(0, 240), readAt: Date.now() });
      return inserted;
    });
    this.#emit({ type: "message", agentId: owner, message });
    for (const recipient of recipients) {
      this.#emitQueue(recipient.id);
      this.#scheduleDrain(recipient.id);
    }
    this.#emitAgents();
    this.#emitChannels();
    return { message, recipients: recipients.map((agent) => ({ id: agent.id, name: agent.name })) };
  }

  markChannelRead(id: string): ChannelView {
    const channel = this.#requireChannel(id);
    if (channel.lastAt <= channel.readAt) return this.#channelView(channel);
    const updated = this.#store.updateChannel(id, { readAt: Math.max(Date.now(), channel.lastAt) });
    this.#emitChannels();
    return this.#channelView(updated);
  }

  markChannelUnread(id: string): ChannelView {
    this.#requireChannel(id);
    const updated = this.#store.updateChannel(id, { readAt: -1 });
    this.#emitChannels();
    return this.#channelView(updated);
  }

  /** «Detener» en un canal: corta lo que esté haciendo cada miembro para él y lo que esperaba turno. */
  async interruptChannel(id: string): Promise<boolean> {
    this.#requireChannel(id);
    const cancelled = this.#store.cancelQueuedForChannel(id);
    for (const agentId of new Set(cancelled.map((delivery) => delivery.agentId))) this.#emitQueue(agentId);
    const working = [...this.#active.values()].filter((state) => state.channelId === id).map((state) => state.agentId);
    const results = await Promise.all(working.map((agentId) => this.interrupt(agentId)));
    this.#emitAgents();
    this.#emitChannels();
    return results.some(Boolean) || cancelled.length > 0;
  }

  #requireChannel(id: string): ChannelRecord {
    const channel = this.#store.getChannel(id);
    if (!channel) throw new ServiceError("Canal no encontrado.", 404);
    return channel;
  }

  #channelView(channel: ChannelRecord): ChannelView {
    const working = [...this.#active.values()].filter((state) => state.channelId === channel.id).map((state) => state.agentId);
    return { ...channel, unread: channel.lastAt > channel.readAt, working: [...new Set(working)] };
  }

  #emitChannels(): void {
    this.#emit({ type: "channels", channels: this.listChannels(), deleted: this.listDeletedChannels() });
  }

  /** Miembros válidos: agentes que existen, sin repetir, como mucho MAX_CHANNEL_MEMBERS. */
  #channelMembers(value: unknown): string[] {
    if (!Array.isArray(value)) throw new ServiceError("Elige los agentes del canal.");
    const ids = [...new Set(value.filter((item): item is string => typeof item === "string"))];
    if (!ids.length) throw new ServiceError("Un canal necesita al menos un agente.");
    if (ids.length > MAX_CHANNEL_MEMBERS) throw new ServiceError(`Un canal admite hasta ${MAX_CHANNEL_MEMBERS} agentes.`);
    for (const agentId of ids) {
      if (!this.#store.getAgent(agentId)) throw new ServiceError("Uno de los agentes elegidos ya no existe.", 404);
    }
    return ids;
  }

  #channelLead(value: unknown, memberIds: string[]): string | null {
    if (value === null || value === undefined || value === "") return memberIds[0] ?? null;
    if (typeof value !== "string" || !memberIds.includes(value)) throw new ServiceError("El encargado tiene que ser uno de los agentes del canal.");
    return value;
  }

  /** Al eliminar un agente: deja los canales y, si era el encargado, lo reemplaza el siguiente. */
  #leaveChannels(agentId: string): boolean {
    let touched = false;
    for (const channel of [...this.#store.listChannels(), ...this.#store.listChannels({ deleted: true })]) {
      if (!channel.memberIds.includes(agentId)) continue;
      const memberIds = channel.memberIds.filter((id) => id !== agentId);
      this.#store.updateChannel(channel.id, {
        memberIds,
        leadId: channel.leadId === agentId || !channel.leadId ? (memberIds[0] ?? null) : channel.leadId,
      });
      touched = true;
    }
    // Lo que escribió el usuario en los canales no se pierde con el agente que lo guardaba.
    const heir = (this.#mainAgentId && this.#mainAgentId !== agentId && this.#store.getAgent(this.#mainAgentId) ? this.#mainAgentId : null) ??
      this.#store.listAgents().find((agent) => agent.id !== agentId)?.id ?? null;
    if (heir) this.#store.moveChannelUserMessages(agentId, heir);
    return touched;
  }

  /** Lo que recibe un miembro: el canal, quién está, lo último que se dijo y el mensaje. */
  #channelInput(channel: ChannelRecord, agent: AgentRecord, delivery: DeliveryRecord, body: string): string {
    const members = channel.memberIds.map((id) => this.#store.getAgent(id)).filter((item): item is AgentRecord => item !== null);
    const lead = members.find((member) => member.id === channel.leadId) ?? null;
    const recent = this.#store
      .listChannelMessages(channel.id, CHANNEL_HISTORY + 1)
      .filter((message) => message.id !== delivery.messageId && message.text.trim())
      .filter((message) => message.role === "user" || message.role === "assistant" || (message.role === "notice" && message.toAgentIds.length > 0))
      .slice(-CHANNEL_HISTORY);
    const name = (id: string | null) => (id ? (this.#store.getAgent(id)?.name ?? "un agente eliminado") : "alguien");
    const history = recent.map((message) => ({
      author:
        message.role === "user"
          ? "Usuario"
          : message.role === "notice"
            ? `${name(message.agentId)} → ${message.toAgentIds.map(name).join(", ")}`
            : name(message.agentId),
      text: message.text,
    }));
    return composeChannelInput(
      {
        name: channel.name,
        topic: channel.topic,
        you: agent.name,
        leadName: lead?.name ?? null,
        members: members.map((member) => ({ name: member.name, role: member.role })),
        history,
      },
      body,
    );
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
      // Una pregunta hecha en un canal se contesta en el canal.
      const channelId = decision.channelId;
      const message = this.#store.insertMessage({
        agentId,
        role: "user",
        text: `${letter}. ${option.label}`,
        status: channelId ? "completed" : "queued",
        payload: { decisionId: messageId, choice: index, ...(channelId ? { to: [agentId] } : {}) },
        channelId,
      });
      const { delivery } = this.#store.enqueueDelivery({
        agentId,
        messageId: message.id,
        senderKind: "user",
        text: agentText,
        idempotencyKey: `decision:${messageId}`,
        channelId,
      });
      const linked = this.#store.updateMessage(message.id, { deliveryId: delivery.id }) as MessageRecord;
      if (channelId && this.#store.getChannel(channelId)) this.#store.updateChannel(channelId, { readAt: Date.now() });
      return { decision: updated, message: linked, delivery };
    });
    if (!result.decision.channelId) this.#store.updateAgent(agentId, { readAt: Date.now() });
    this.#emit({ type: "message", agentId, message: result.decision });
    this.#emit({ type: "message", agentId, message: result.message });
    this.#emitQueue(agentId);
    this.#emitAgents();
    if (result.decision.channelId) this.#emitChannels();
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
          `La rutina «${routine.name}» no corrió ${formatWhen(scheduledAt)} porque ClosedBot estaba cerrada.${next ? ` La próxima será ${formatWhen(next)}.` : ""}`,
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
    return this.#queueView(agentId);
  }

  /** La cola tal como la ve la interfaz: el pedido del saludo inicial no se muestra. */
  #queueView(agentId: string): DeliveryRecord[] {
    return this.#store.listQueue(agentId).map((delivery) => (delivery.text.startsWith(GREETING_MARKER) ? { ...delivery, text: "Saludo inicial" } : delivery));
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
            clientInfo: { name: "closedbot", title: "ClosedBot", version: VERSION },
            capabilities: { experimentalApi: true, requestAttestation: false },
          },
          // Gemini CLI y Grok tardan más en arrancar (cargan su configuración y sus extensiones).
          provider === "grok" || provider === "gemini" ? 90_000 : 20_000,
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

  #threadParams(agent: AgentRecord, starting: boolean): Record<string, unknown> {
    const main = this.#isMain(agent);
    const params: Record<string, unknown> = {
      cwd: agent.workspace,
      runtimeWorkspaceRoots: [agent.workspace, this.#options.sharedDir],
      approvalPolicy: "never",
      sandbox: this.#access(agent) === "total" ? "danger-full-access" : "workspace-write",
      developerInstructions: buildInstructions({ ...agent, access: this.#access(agent) }, this.#options.sharedDir, this.getSettings().userName, { main }),
    };
    if (agent.model) params.model = agent.model;
    if (agent.effort && agent.provider !== "codex") params.effort = agent.effort;
    // Codex fija las herramientas al crear el hilo; Claude y la demo las reciben también al reanudarlo.
    if (starting || agent.provider !== "codex") params.dynamicTools = [teamDynamicTools(main)];
    return params;
  }

  async #ensureThread(agent: AgentRecord, client: AgentClient): Promise<string> {
    if (agent.threadId) {
      this.#threadToAgent.set(agent.threadId, agent.id);
      const key = `${agent.provider}:${agent.threadId}`;
      if (this.#loadedThreads.has(key)) return agent.threadId;
      try {
        await client.request("thread/resume", { threadId: agent.threadId, ...this.#threadParams(agent, false) });
        this.#loadedThreads.add(key);
        return agent.threadId;
      } catch (error) {
        this.#notice(agent.id, `No se pudo reanudar la conversación anterior (${errorText(error)}). Empiezo una nueva: el agente no recordará lo anterior.`);
        this.#threadToAgent.delete(agent.threadId);
      }
    }
    const response = await client.request<ThreadResponse>("thread/start", {
      ...this.#threadParams(agent, true),
      ephemeral: false,
      serviceName: "closedbot",
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
      // Si esa entrega no quedó en curso (falló o se canceló), se sigue con la próxima de la cola.
      if (!this.#active.has(agentId)) this.#scheduleDrain(agentId);
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
      createdAgents: 0,
      channelId: delivery.channelId,
    };
    // Un encargo de un canal que se movió a «Canales eliminados» ya no se atiende.
    const channel = delivery.channelId ? this.#store.getChannel(delivery.channelId) : null;
    if (delivery.channelId && (!channel || channel.deletedAt)) {
      this.#store.updateDelivery(delivery.id, { status: "cancelled", finishedAt: Date.now() });
      this.#emitQueue(agent.id);
      this.#scheduleDrain(agent.id);
      return;
    }
    this.#active.set(agent.id, state);
    this.#store.updateDelivery(delivery.id, { status: "starting", startedAt: Date.now() });
    this.#updateMessageStatus(agent.id, delivery.messageId, "running");
    this.#emitQueue(agent.id);
    this.#emitAgents();
    if (channel) this.#emitChannels();
    try {
      const client = await this.#getClient(agent.provider);
      const fresh = this.#requireAgent(agent.id);
      const threadId = await this.#ensureThread(fresh, client);
      state.threadId = threadId;
      const sender = delivery.senderAgentId ? this.#store.getAgent(delivery.senderAgentId) : null;
      const original = delivery.replyTo ? this.#store.getMessage(delivery.replyTo) : null;
      const body = composeDeliveryInput(delivery, sender ? { id: sender.id, name: sender.name } : null, original?.text ?? null);
      const text = channel ? this.#channelInput(channel, fresh, delivery, body) : body;
      const response = await client.request<TurnResponse>(
        "turn/start",
        {
          threadId,
          clientUserMessageId: delivery.id,
          input: [{ type: "text", text, text_elements: [] }],
          cwd: fresh.workspace,
          approvalPolicy: "never",
          sandboxPolicy:
            this.#access(fresh) === "total"
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
      this.#notice(agent.id, `No se pudo entregar el mensaje${channel ? ` a ${agent.name}` : ""}: ${errorText(error)}`, delivery.channelId);
      this.#emitQueue(agent.id);
      this.#emitAgents();
      if (channel) this.#emitChannels();
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
    const channel = state.channelId ? this.#store.getChannel(state.channelId) : null;
    const speaker = channel ? `${this.#store.getAgent(agentId)?.name ?? "Un agente"}: ` : "";
    let preview: string | null = null;
    // Lo pendiente es la pregunta: es lo que el usuario debe ver en la lista.
    if (state.askedQuestion) preview = `${channel ? `Pregunta de ${speaker}` : "Pregunta: "}${state.askedQuestion}`;
    else if (terminal === "completed" && state.lastAssistantText.trim()) preview = `${speaker}${state.lastAssistantText.trim()}`;
    if (preview && channel) this.#store.updateChannel(channel.id, { preview: preview.slice(0, 240) });
    else if (preview && !state.channelId) this.#store.updateAgent(agentId, { preview: preview.slice(0, 240) });
    this.#emitQueue(agentId);
    this.#emitAgents();
    if (state.channelId) this.#emitChannels();
    if (delivery && this.#store.listRoutines(agentId).some((routine) => routine.lastDeliveryId === delivery.id)) this.#emitRoutines();
    if (state.provider !== "demo") this.#usageAfterTurn();

    if (
      terminal === "completed" &&
      delivery?.senderKind === "agent" &&
      delivery.senderAgentId &&
      !delivery.replyTo &&
      !state.sentTo.has(delivery.senderAgentId) &&
      state.lastAssistantText.trim()
    ) {
      // El compañero no contestó con send_message: le hacemos llegar su resultado igual. En un canal
      // su respuesta ya se ve, así que no se repite como aviso (y si el canal se eliminó, no sigue).
      try {
        if (!delivery.channelId || (channel && !channel.deletedAt)) {
          this.#sendTeammateMessage({
            fromAgentId: agentId,
            to: [delivery.senderAgentId],
            text: state.lastAssistantText.trim(),
            replyTo: delivery.messageId,
            hops: delivery.hops + 1,
            idempotencyKey: `auto:${delivery.id}`,
            channelId: delivery.channelId,
            quiet: Boolean(delivery.channelId),
          });
        }
      } catch (error) {
        this.#notice(agentId, `No se pudo devolver el resultado al remitente: ${errorText(error)}`, delivery.channelId);
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
        const state = this.#active.get(agentId);
        this.#emit({ type: "delta", agentId, messageId, delta, channelId: state?.channelId ?? null });
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
            channelId: this.#active.get(agentId)?.channelId ?? null,
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
      channelId: state?.channelId ?? null,
    });
    this.#emit({ type: "message", agentId, message });
    return messageId;
  }

  async #handleServerRequest(client: AgentClient, request: AppServerRequest): Promise<void> {
    if (this.#stopping) {
      try {
        client.respondError(request.id, { code: -32000, message: "ClosedBot se está cerrando." });
      } catch {
        // El proceso pudo terminar entre medio.
      }
      return;
    }
    const threadId = getString(request.params, "threadId");
    const agentId = threadId ? this.#threadToAgent.get(threadId) : undefined;
    const agent = agentId ? this.#store.getAgent(agentId) : null;
    const total = agent ? this.#access(agent) === "total" : false;
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
          client.respondError(request.id, { code: -32601, message: `ClosedBot no implementa ${request.method}.` });
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
      // El bot principal ve además el modelo y las instrucciones, para ajustar equipos sin duplicarlos.
      const forMain = senderId === this.#mainAgentId;
      const agents = this.listAgents().map((agent) => ({
        id: agent.id,
        nombre: agent.name,
        rol: agent.role || "Asistente general",
        proyecto: agent.project || null,
        proveedor: agent.provider,
        estado: agent.state === "working" ? "trabajando" : agent.state === "queued" ? "con cola" : agent.state === "paused" ? "en pausa" : "libre",
        eresTu: agent.id === senderId,
        ...(agent.main ? { botPrincipal: true } : {}),
        ...(forMain ? { modelo: agent.model ?? "predeterminado", instrucciones: clip(agent.instructions, 400) } : {}),
      }));
      // Al bot principal le sirve saber con qué proveedores puede crear agentes ahora mismo.
      const ready = forMain
        ? this.#providers.filter((status) => status.id !== "demo" && status.available && status.loggedIn !== false).map((status) => status.id)
        : null;
      return toolResult({ agentes: agents, ...(ready ? { proveedoresListos: ready } : {}) });
    }
    if (params.tool === TOOL_CREATE_AGENT || params.tool === TOOL_UPDATE_AGENT) {
      if (senderId !== this.#mainAgentId) {
        throw new Error("Solo el bot principal puede crear o cambiar agentes. Si hace falta, pídeselo al usuario.");
      }
      return params.tool === TOOL_CREATE_AGENT
        ? this.#createAgentFromMain(senderId, parseCreateAgentArgs(params.arguments), params.turnId)
        : this.#updateAgentFromMain(senderId, parseUpdateAgentArgs(params.arguments), params.turnId);
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
      channelId: state?.channelId ?? null,
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
      channelId: this.#active.get(agentId)?.channelId ?? null,
    });
    const state = this.#active.get(agentId);
    if (state) state.askedQuestion = args.question;
    else this.#store.updateAgent(agentId, { preview: `Pregunta: ${args.question}`.slice(0, 240) });
    this.#emit({ type: "message", agentId, message });
    this.#emitAgents();
    if (message.channelId) this.#emitChannels();
    return toolResult({
      preguntado: true,
      messageId: message.id,
      nota: "La tarjeta ya está en la conversación. Termina tu turno ahora: la respuesta del usuario te llegará como un mensaje nuevo.",
    });
  }

  /** create_agent del bot principal: crea el agente, lo deja marcado en ambas conversaciones y lo devuelve. */
  #createAgentFromMain(mainId: string, args: CreateAgentArgs, turnId: string | null): DynamicToolResult {
    const main = this.#requireAgent(mainId);
    const state = this.#active.get(mainId);
    if (state && state.createdAgents >= MAX_AGENTS_PER_TURN) {
      throw new Error(`Ya creaste ${MAX_AGENTS_PER_TURN} agentes en este turno, el máximo por pedido. Muéstrale el equipo al usuario y sigue en otro turno si te lo pide.`);
    }
    if (this.#store.listAgents().length >= MAX_AGENTS) {
      throw new Error(`Ya hay ${MAX_AGENTS} agentes, el máximo que puedes crear. Pídele al usuario que elimine los que no use.`);
    }
    const provider = args.provider ?? main.provider;
    const status = this.#providers.find((item) => item.id === provider);
    if (provider !== main.provider && status && !status.available) {
      throw new Error(`${providerLabel(provider)} no está disponible en este equipo: crea el agente con ${providerLabel(main.provider)}.`);
    }
    if (provider !== main.provider && status?.loggedIn === false) {
      throw new Error(`${providerLabel(provider)} no tiene la sesión iniciada (el usuario puede entrar en Ajustes): crea el agente con ${providerLabel(main.provider)}.`);
    }
    let agent: AgentView;
    try {
      agent = this.createAgent({
        name: args.name,
        role: args.role,
        instructions: args.instructions,
        provider,
        model: args.model,
        project: args.project,
      });
    } catch (error) {
      if (error instanceof ServiceError && error.status === 409) {
        throw new Error(`${error.message} Elige otro nombre, o ajusta ese agente con update_agent.`);
      }
      throw error;
    }
    if (state) state.createdAgents += 1;
    const activity = this.#store.insertMessage({
      agentId: mainId,
      role: "activity",
      text: `Creó el agente «${agent.name}» · ${agent.project}`,
      status: "completed",
      turnId,
      payload: { kind: "agent-created", agentId: agent.id, project: agent.project },
    });
    this.#emit({ type: "message", agentId: mainId, message: activity });
    this.#notice(agent.id, `${main.name} creó este agente para el proyecto «${agent.project}».`);
    // Queda como no leído hasta que el usuario lo abra: así ve qué agentes son nuevos.
    this.#store.updateAgent(agent.id, { readAt: 0 });
    this.#emitAgents();
    return toolResult({
      creado: true,
      id: agent.id,
      nombre: agent.name,
      proyecto: agent.project,
      proveedor: agent.provider,
      modelo: agent.model ?? "predeterminado",
    });
  }

  /** update_agent del bot principal: cambia solo lo indicado y lo deja marcado en ambas conversaciones. */
  #updateAgentFromMain(mainId: string, args: UpdateAgentArgs, turnId: string | null): DynamicToolResult {
    const main = this.#requireAgent(mainId);
    const target = this.#resolveAgentRef(args.agent);
    if (target.id === mainId) throw new Error("No puedes cambiarte a ti mismo: eso lo hace el usuario desde «Editar agente».");
    const patch: Partial<AgentInput> = {};
    const changes: string[] = [];
    if (args.name !== undefined && args.name !== target.name) {
      patch.name = args.name;
      changes.push("nombre");
    }
    if (args.role !== undefined && args.role !== target.role) {
      patch.role = args.role;
      changes.push("rol");
    }
    if (args.instructions !== undefined && args.instructions !== target.instructions) {
      patch.instructions = args.instructions;
      changes.push("instrucciones");
    }
    if (args.project !== undefined && args.project !== target.project) {
      patch.project = args.project;
      changes.push("proyecto");
    }
    if (args.model !== undefined && args.model !== target.model) {
      patch.model = args.model;
      changes.push("modelo");
    }
    if (!changes.length) return toolResult({ actualizado: false, nota: "No había nada distinto que cambiar." });
    let updated: AgentView;
    try {
      updated = this.updateAgent(target.id, patch);
    } catch (error) {
      throw new Error(errorText(error));
    }
    const list = changes.join(", ");
    const activity = this.#store.insertMessage({
      agentId: mainId,
      role: "activity",
      text: `Ajustó a «${updated.name}»: ${list}`,
      status: "completed",
      turnId,
      payload: { kind: "agent-updated", agentId: updated.id, changes },
    });
    this.#emit({ type: "message", agentId: mainId, message: activity });
    this.#notice(updated.id, `${main.name} ajustó este agente: ${list}.`);
    this.#emitAgents();
    return toolResult({ actualizado: true, id: updated.id, nombre: updated.name, proyecto: updated.project || null, cambios: changes });
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
    /** Canal donde ocurre: el encargo y lo que responda el compañero se ven allí. */
    channelId?: string | null;
    /** Sin el aviso «Enviado a…» (cuando el texto ya se ve en el canal). */
    quiet?: boolean;
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
          channelId: input.channelId ?? null,
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
          channelId: input.channelId ?? null,
        });
        return { recipient, message: this.#store.updateMessage(message.id, { deliveryId: delivery.id }), created: true };
      }),
    );

    if (results.some((result) => result.created) && !input.quiet) {
      const notice = this.#store.insertMessage({
        agentId: sender.id,
        role: "notice",
        text: input.text,
        status: "completed",
        toAgentIds: recipients.map((agent) => agent.id),
        replyTo: input.replyTo,
        channelId: input.channelId ?? null,
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
    return { ...agent, state, queued, unread: agent.lastAt > agent.readAt, main: this.#isMain(agent) };
  }

  #uniqueWorkspace(name: string): string {
    const base = slugify(name) || "agente";
    const taken = new Set(this.#store.listAgents().map((agent) => agent.workspace));
    let candidate = join(this.#options.workspacesDir, base);
    for (let index = 2; taken.has(candidate); index += 1) candidate = join(this.#options.workspacesDir, `${base}-${index}`);
    return candidate;
  }

  #updateMessageStatus(agentId: string, messageId: string, status: MessageRecord["status"]): void {
    // El mensaje del usuario en un canal puede ir a varios agentes: no sigue el estado de cada entrega.
    const current = this.#store.getMessage(messageId);
    if (!current || (current.channelId && current.role === "user")) return;
    const message = this.#store.updateMessage(messageId, { status });
    if (message) this.#emit({ type: "message", agentId, message });
  }

  /** Aviso en la conversación del agente; durante un encargo de un canal, en ese canal. */
  #notice(agentId: string, text: string, channelId: string | null = this.#active.get(agentId)?.channelId ?? null): void {
    if (!this.#store.getAgent(agentId)) return;
    const channel = channelId ? this.#store.getChannel(channelId) : null;
    const message = this.#store.insertMessage({ agentId, role: "notice", text, status: "completed", channelId: channel ? channel.id : null });
    this.#emit({ type: "message", agentId, message });
  }

  #emitQueue(agentId: string): void {
    this.#emit({ type: "queue", agentId, queue: this.#queueView(agentId) });
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

function signInProvider(value: unknown): SignInProvider {
  if (value === "claude" || value === "codex" || value === "grok" || value === "gemini") return value;
  throw new ServiceError("Ese proveedor no tiene inicio de sesión.", 400);
}

function channelName(value: unknown): string {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ").replace(/^#+\s*/, "") : "";
  if (!name) throw new ServiceError("El canal necesita un nombre.");
  if (name.length > CHANNEL_LIMITS.name) throw new ServiceError(`El nombre admite hasta ${CHANNEL_LIMITS.name} caracteres.`);
  if (/[\u0000-\u001f]/.test(name)) throw new ServiceError("El nombre tiene caracteres no válidos.");
  return name;
}

function channelTopic(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new ServiceError("El tema del canal debe ser texto.");
  const topic = value.trim();
  if (topic.length > CHANNEL_LIMITS.topic) throw new ServiceError(`El tema admite hasta ${CHANNEL_LIMITS.topic} caracteres.`);
  return topic;
}

function installProvider(value: unknown): InstallProvider {
  if (value === "codex" || value === "grok" || value === "gemini") return value;
  throw new ServiceError("Ese proveedor no se instala desde la app.", 400);
}

const PROVIDER_LABELS: Record<ProviderId, string> = { claude: "Claude", codex: "Codex", grok: "Grok", gemini: "Gemini", demo: "Demo" };

export function providerLabel(provider: ProviderId): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/** Texto del botón para iniciar sesión, igual que en Ajustes. */
function signInButton(provider: ProviderId): string {
  if (provider === "codex") return "Iniciar sesión con ChatGPT";
  if (provider === "gemini") return "Iniciar sesión con Google";
  return `Iniciar sesión con ${providerLabel(provider)}`;
}

function validProvider(value: unknown): ProviderId {
  if (isProviderId(value)) return value;
  throw new ServiceError("Proveedor inválido: usa claude, codex, grok, gemini o demo.");
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

function cleanAvatar(value: unknown): number {
  const avatar = typeof value === "number" ? value : Number.NaN;
  if (!Number.isInteger(avatar) || avatar < 0 || avatar >= AVATAR_MAX) throw new ServiceError("La figura elegida no es válida.");
  return avatar;
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

function isInside(base: string, target: string): boolean {
  const root = base.endsWith(sep) ? base : base + sep;
  const a = process.platform === "win32" ? target.toLowerCase() : target;
  const b = process.platform === "win32" ? root.toLowerCase() : root;
  return a === b.slice(0, -1) || a.startsWith(b);
}

/** Nombre de cada ventana de uso de Claude. */
const USAGE_LABELS: Record<string, string> = {
  five_hour: "5 horas",
  seven_day: "Semanal",
  seven_day_opus: "Semanal · Opus",
  seven_day_sonnet: "Semanal · Sonnet",
  seven_day_oauth_apps: "Semanal · apps",
};

/** Normaliza la respuesta de `account/rateLimits/read`: la del adaptador de Claude o la del app-server de Codex. */
export function parseUsage(provider: ProviderId, response: unknown): UsageView | null {
  const limits = getRecord(response, "rateLimits") ?? (isRecord(response) ? response : null);
  if (!limits || limits.available === false) return null;
  const windows: UsageWindow[] = [];
  const add = (id: string, label: string, percentValue: unknown, resetsValue: unknown): void => {
    const percent = Number(percentValue);
    if (!Number.isFinite(percent)) return;
    windows.push({ id, label, percent: Math.max(0, Math.min(100, Math.round(percent))), resetsAt: toMillis(resetsValue) });
  };
  if (Array.isArray(limits.windows)) {
    for (const window of limits.windows.filter(isRecord)) {
      const id = String(window.id ?? "");
      const label = typeof window.label === "string" && window.label ? window.label : (USAGE_LABELS[id] ?? (id.startsWith("model:") ? `Semanal · ${id.slice(6)}` : id));
      add(id, label, window.usedPercent ?? window.used_percent, window.resetsAt ?? window.resets_at);
    }
  }
  for (const key of ["primary", "secondary"]) {
    const window = getRecord(limits, key);
    if (!window) continue;
    const minutes = Number(window.windowDurationMins ?? window.windowMinutes ?? window.window_minutes);
    const label = !Number.isFinite(minutes)
      ? key === "primary"
        ? "Principal"
        : "Secundario"
      : minutes >= 7 * 24 * 60 - 60
        ? "Semanal"
        : minutes >= 24 * 60
          ? `${Math.round(minutes / (24 * 60))} días`
          : `${Math.round(minutes / 60)} horas`;
    // Versiones viejas de Codex dicen cuántos segundos faltan en vez de la fecha del reinicio.
    const rawSeconds = window.resetsInSeconds ?? window.resets_in_seconds;
    const inSeconds = typeof rawSeconds === "number" ? rawSeconds : Number.NaN;
    const resets = window.resetsAt ?? window.resets_at ?? (Number.isFinite(inSeconds) ? Date.now() + inSeconds * 1000 : null);
    add(key, label, window.usedPercent ?? window.used_percent, resets);
  }
  if (!windows.length) return null;
  // Primero la semanal (la que muestra el anillo), después las demás.
  windows.sort((a, b) => Number(b.label === "Semanal") - Number(a.label === "Semanal"));
  return {
    provider,
    label: providerLabel(provider),
    plan: typeof limits.plan === "string" && limits.plan ? limits.plan : null,
    windows,
    updatedAt: Date.now(),
    error: null,
  };
}

/** Fecha en milisegundos a partir de segundos Unix, milisegundos o texto ISO. */
function toMillis(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return toMillis(numeric);
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function cleanProject(value: unknown): string {
  const project = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (project.length > 60) throw new ServiceError("El nombre de la sección admite hasta 60 caracteres.");
  if (/[\u0000-\u001f]/.test(project)) throw new ServiceError("La sección tiene caracteres no válidos.");
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

function clip(text: string, max: number): string {
  const value = text.trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
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
      // Las herramientas de ClosedBot ya dejan su propia marca (mensaje enviado, pregunta, rutina).
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
