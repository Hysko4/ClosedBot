import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  cleanInstructions,
  composeSkill,
  deleteSkill,
  INSTRUCTIONS_MAX,
  listSkills,
  migrateInstructions,
  newSkillId,
  parseSkill,
  readInstructions,
  readSkill,
  SKILL_LIMITS,
  type SkillInfo,
  writeInstructions,
  writeSkill,
} from "./agent-files.js";
import { boardSection } from "./board.js";
import { CHANNEL_LIMITS, composeChannelInput, findMentions, MAX_CHANNEL_MEMBERS, uniqueName } from "./channels.js";
import {
  type AgentRecord,
  AVATAR_MAX,
  type ChannelRecord,
  type DeliveryRecord,
  type MemoryRecord,
  type MessageRecord,
  type NotifyLevel,
  type RoutineRecord,
  type RoutineRun,
  type Store,
  toNotify,
  toVoice,
  type VoiceSettings,
} from "./db.js";
import { type SavedImage, saveGeneratedImage, withImages } from "./images.js";
import { downloadPrices, type ModelPrice, normalizeModel } from "./prices.js";
import { buildInstructions, composeDeliveryInput, composeGreeting, GREETING_MARKER } from "./instructions.js";
import { type AgentMcpView, closedbotServer, fromCodexStatus, type McpListing, type McpServerView } from "./mcp.js";
import { cleanMemory, describeMemories, MEMORY_LIMITS, searchMemories } from "./memories.js";
import { APPEARANCE_MAX, type CharacterManifest, type CharacterState, OfficeStudio, type OfficeStudioOptions, PixelLabError, type PixelLabOptions } from "./office.js";
import { type AccessLevel, type AgentClient, isProviderId, PROVIDER_IDS, type ProviderId } from "./providers/client.js";
import { AppServerError } from "./providers/codex.js";
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
  type CreateChannelArgs,
  parseAskUserArgs,
  parseCreateAgentArgs,
  parseCreateChannelArgs,
  parseCreateRoutineArgs,
  parseDeleteAgentsArgs,
  parseMemoryIdArgs,
  parseReadAgentArgs,
  parseMemoryInclusionArgs,
  parseRememberArgs,
  parseRoutineIdArgs,
  parseSearchMemoriesArgs,
  parseSendMessageArgs,
  parseUpdateAgentArgs,
  parseUpdateBoardArgs,
  type QuestionOption,
  TEAM_NAMESPACE,
  teamDynamicTools,
  TOOL_ASK_USER,
  TOOL_CREATE_AGENT,
  TOOL_CREATE_CHANNEL,
  TOOL_CREATE_ROUTINE,
  TOOL_DELETE_AGENTS,
  TOOL_DELETE_ROUTINE,
  TOOL_FORGET_MEMORY,
  TOOL_LIST_AGENTS,
  TOOL_LIST_MEMORIES,
  TOOL_LIST_ROUTINES,
  TOOL_READ_AGENT,
  TOOL_REMEMBER,
  TOOL_SEARCH_MEMORIES,
  TOOL_SEND_MESSAGE,
  TOOL_SET_MEMORY_INCLUSION,
  TOOL_UPDATE_AGENT,
  TOOL_UPDATE_BOARD,
  TOOL_REPORT_PROGRESS,
  parseReportProgressArgs,
  type UpdateAgentArgs,
} from "./team.js";
import { emptyReading, localDay, type ModelReading, rangeStart, type Reading, readingIncrement, spendReport, type SpendReport, tokensOf } from "./spend.js";
import { describeChanges, describeTeam, parseTeamSnapshot, snapshotAgent, snapshotChannel, snapshotTeam, type TeamSnapshot } from "./team-state.js";
import { VERSION } from "./version.js";

export { CHANNEL_LIMITS, MAX_CHANNEL_MEMBERS, VERSION };
export const PROVIDERS: ProviderId[] = [...PROVIDER_IDS];
/** Proveedores que se pueden instalar desde Ajustes (Claude viene con la app). */
export type InstallProvider = "codex" | "grok" | "gemini";

/** Rutinas: tope por agente y en total, y cuánto retraso se tolera antes de saltarse una ejecución. */
export const MAX_ROUTINES_PER_AGENT = 20;
export const MAX_ROUTINES = 100;
export const ROUTINE_GRACE_MS = 2 * 60 * 60_000;
const ROUTINE_CHECK_MS = 60_000;
/** Tiempo máximo de «Instalar» (Antigravity son unos 200 MB). */
const INSTALL_TIMEOUT_MS = 30 * 60_000;
/** Tamaño máximo de un archivo adjunto. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const SETTINGS_META = "settings";
export const DEFAULT_BOT_NAME = "ClosedBot";
/** Bot principal: arma los equipos de agentes. Su id se guarda aparte de los ajustes. */
export const MAIN_AGENT_META = "main_agent";
export const MAIN_AGENT_NAME = "Claude Bot";
export const MAIN_AGENT_ROLE = "Bot principal: arma y coordina tus equipos de agentes";
/** Lo último que se le contó al bot principal de los agentes y canales (ver team-state.ts). */
export const MAIN_KNOWN_META = "main_known";
/** La pizarra del trabajo que lleva Claude Bot: la reciben los agentes cuando él les escribe. */
export const BOARD_META = "main_board";
/** Avance que informó cada agente de su tarea (report_progress), como JSON { id: AgentProgress }. */
export const PROGRESS_META = "agent_progress";
/** Avance de cada equipo (canal) en su trabajo actual, como JSON { channelId: TeamProgressRecord }. */
export const TEAM_PROGRESS_META = "team_progress";
/** Cuánto se sigue mostrando un avance: el terminado, media hora; el que va en camino, 12 horas sin novedades. */
const PROGRESS_DONE_MS = 30 * 60_000;
const PROGRESS_STALE_MS = 12 * 3_600_000;
/**
 * Un equipo cuyos integrantes que informaron ya terminaron, y en el que nadie trabaja hace este rato, da su trabajo
 * por listo (los que no informaron no tenían parte). Antes de eso puede llegar la etapa siguiente del mismo trabajo.
 * La Oficina usa el mismo plazo (TEAM_SETTLE_MS en public/office.js).
 */
const TEAM_SETTLE_MS = 10 * 60_000;
/** Topes para los agentes que crea el bot principal: en total y en un mismo turno. */
export const MAX_AGENTS = 60;
export const MAX_AGENTS_PER_TURN = 8;
/** Tarjeta con la que el usuario confirma los agentes que Claude Bot quiere eliminar (delete_agents). */
export const DELETE_AGENTS_CARD = "delete-agents";
/**
 * Encargos seguidos que puede hacer Claude Bot en un mismo pedido del usuario (cada send_message cuenta uno, a uno
 * o a varios agentes). Cuando él escribe, la cuenta de reenvíos entre agentes (MAX_HOPS) vuelve a empezar.
 */
export const MAIN_MAX_STEPS = 20;
const OPTION_LETTERS = "ABCD";
/** Secciones de la barra lateral creadas a mano (pueden quedar vacías); las demás salen del proyecto de cada agente. */
export const SECTIONS_META = "sections";
export const MAX_SECTIONS = 50;
/** Biblioteca: cuántos elementos muestra una carpeta como máximo. */
export const MAX_LIBRARY_ENTRIES = 500;
/** Canales activos como máximo, agentes por canal y mensajes anteriores que ve cada agente. */
export const MAX_CHANNELS = 50;
const CHANNEL_HISTORY = 12;
/** Canales que el bot principal puede crear en un mismo turno. */
export const MAX_CHANNELS_PER_TURN = 3;
/** Uso del plan: cada cuánto se vuelve a leer y cuánto esperar como mínimo entre lecturas. */
const USAGE_INTERVAL_MS = 10 * 60_000;
/**
 * Las listas de modelos de cada proveedor, guardadas como JSON { proveedor: { at, models } }: la ficha y «Crear»
 * las muestran al instante (Gemini tarda en abrir la sesión con que se piden). Pasado este rato, se renuevan en
 * segundo plano la próxima vez que se piden.
 */
export const MODELS_META = "model_lists";
const MODELS_REFRESH_MS = 30 * 60_000;
/** Lo último que dijo cada sesión de su gasto acumulado: así de cada turno se cuenta solo lo nuevo. */
export const TOKEN_READINGS_META = "token_readings";
/** Una sesión sin novedades en 60 días se olvida. */
const TOKEN_READING_KEEP_MS = 60 * 24 * 60 * 60_000;
/** La lista de precios de las API (de LiteLLM) y cuándo se bajó; se renueva una vez al día. */
export const PRICES_META = "model_prices";
const PRICES_REFRESH_MS = 24 * 60 * 60_000;
/** Si todavía no hay precios, «Uso» espera la lista a lo más esto. */
const PRICES_WAIT_MS = 12_000;
const USAGE_MIN_GAP_MS = 60_000;
const USAGE_AFTER_TURN_MS = 2 * 60_000;
const USAGE_FIRST_MS = 20_000;
/** Última lectura del uso del plan: se guarda para verla al abrir la app (Gemini solo se lee con Antigravity en marcha). */
export const USAGE_META = "usage";
/** Proveedores con uso del plan, en el orden en que se muestran. */
const USAGE_PROVIDERS = ["claude", "codex", "grok", "gemini"] as const satisfies readonly ProviderId[];
/** Al eliminar un agente que está trabajando: cuánto se espera a que su turno se detenga. */
const STOP_WAIT_MS = 10_000;
/** Los MCP de un agente: cuánto vale la última revisión, cuánto se espera y cuántas revisiones a la vez. */
const MCP_CACHE_MS = 5 * 60_000;
const MCP_TIMEOUT_MS = 60_000;
const MCP_PARALLEL = 2;
/** Ya se pasaron las instrucciones guardadas en la base a AGENTS.md (0.7.0). */
export const INSTRUCTIONS_FILES_META = "instructions_files";
/** Lo que se manda de las instrucciones en la lista de agentes (las completas se piden aparte). */
const INSTRUCTIONS_PREVIEW = 400;
export const DESCRIPTION_MAX = 2_000;

/** Un modelo para elegir en el editor del agente. */
export interface ModelOption {
  model: string;
  displayName: string;
  isDefault?: boolean;
  efforts: string[];
  /** Nivel → id real, cuando el proveedor ofrece cada nivel como otro modelo (Gemini por Antigravity). */
  variants?: Record<string, string>;
}

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
  /** Se puede cerrar la sesión desde la app (Antigravity, el de Gemini, no tiene un comando para salir). */
  canSignOut?: boolean;
  /** Se puede instalar (o reinstalar) desde la app. */
  canInstall?: boolean;
  /** Programa que usa la app para este proveedor. */
  path?: string;
  /** Inicio de sesión en curso. */
  signIn?: SignInView | null;
  /** Instalación en curso. */
  install?: { startedAt: string } | null;
  /** Por qué falló el último intento de iniciar sesión (lo que respondió el proveedor), mientras siga sin sesión. */
  problem?: string;
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
  /** Cuándo avisa (lo elegido o, si no eligió, lo de siempre: todo en Claude Bot y lo necesario en los demás). */
  notify: NotifyLevel;
  /** Largo de sus instrucciones: `instructions` trae solo el comienzo (las completas, en /instructions). */
  instructionsLength: number;
  /** Cuánto lleva de su tarea, según lo último que informó con report_progress. */
  progress: AgentProgress | null;
}

/** Avance de la tarea de un agente. */
export interface AgentProgress {
  percent: number;
  step: string;
  at: number;
}

/** El trabajo actual de un equipo: lo último de cada integrante que informó, y el avance que se muestra. */
interface TeamProgressRecord {
  percent: number;
  at: number;
  parts: Record<string, number>;
}

/** Un recuerdo tal como lo ve la interfaz. */
export type MemoryView = MemoryRecord;

/** Una habilidad del agente tal como la ve la interfaz. */
export interface SkillView extends SkillInfo {
  enabled: boolean;
}

/** Aviso para el sistema (notificación del navegador), según «Avisarme» de cada agente. */
export interface AlertEvent {
  type: "alert";
  agentId: string;
  channelId: string | null;
  kind: "reply" | "question" | "error";
  title: string;
  body: string;
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
  /**
   * Avance del equipo en su trabajo actual (la tarjeta de la Oficina), o null. `done`: los que informaron ya
   * terminaron; la Oficina lo muestra listo cuando además nadie del equipo sigue trabajando.
   */
  progress: { percent: number; at: number; done: boolean } | null;
}

export interface ChannelInput {
  name?: unknown;
  topic?: unknown;
  memberIds?: unknown;
  leadId?: unknown;
  /** Color del equipo en la Oficina («#rrggbb»); vacío o null vuelve al automático. */
  color?: unknown;
}

/** La Oficina: a qué equipo pasa un agente que el usuario arrastró. */
export interface TeamMoveInput {
  /** El canal de la plataforma de donde salió (null si estaba en «Sin grupo»). */
  from?: unknown;
  /** El canal al que entra; null o vacío lo deja «Sin grupo». */
  to?: unknown;
  /** Nombre de un equipo nuevo (canal) que se crea con él de encargado. */
  name?: unknown;
}

export interface TeamMove {
  agent: AgentView;
  /** El equipo en el que quedó (null si quedó «Sin grupo»). */
  team: ChannelView | null;
  /** Nombres de los canales que dejó. */
  left: string[];
  /** Los que se quedaron sin agentes y pasaron a «Canales eliminados». */
  archived: string[];
  /** Los canales como quedaron (como en el evento «channels»), para que la interfaz no espere al evento. */
  channels: ChannelView[];
  deleted: ChannelView[];
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
  /** Se contó el gasto de un turno (la ventana «Uso» abierta se actualiza). */
  | { type: "spend" }
  | { type: "notice"; level: "error" | "info"; message: string; agentId?: string }
  | { type: "memories"; agentId: string; memories: MemoryView[] }
  | { type: "skills"; agentId: string; skills: SkillView[] }
  /** Terminó un turno (la Oficina muestra «!» si falló). */
  | { type: "turn"; agentId: string; status: "completed" | "failed" | "interrupted" }
  /** Llegó el arte de la Oficina en alta resolución. */
  | { type: "office"; art: OfficeArtView }
  | AlertEvent;

export interface OfficeArtView {
  hd: boolean;
  version: number;
}

/** Lo que necesita la Oficina al abrirse; lo demás llega con los eventos. */
export interface OfficeSnapshot {
  board: string;
  images: Array<{ agentId: string; channelId: string | null; path: string; at: number }>;
  activity: Record<string, { text: string; at: number }>;
  asking: string[];
  failed: string[];
  art: OfficeArtView;
  pixelLab: PixelLabStatus;
}

export interface PixelLabStatus {
  configured: boolean;
  /** Agentes sin personaje de PixelLab (ni en camino). */
  missing: number;
  /** A quién está dibujando ahora o tiene en cola. */
  drawing: string[];
}

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
  /** Encargos seguidos que puede hacer Claude Bot en un pedido (MAIN_MAX_STEPS por defecto). */
  mainMaxSteps?: number;
  /** Carpeta de la Oficina (personajes y arte); por defecto «oficina» junto a la carpeta compartida. */
  officeDir?: string;
  /** Pedir a PixelLab el personaje de cada agente nuevo (la Oficina de robots no lo usa: apagado por omisión). */
  autoCharacters?: boolean;
  /** Cómo hablar con PixelLab (las pruebas usan un servidor falso). */
  pixelLab?: PixelLabOptions;
  /** De dónde y cómo bajar el arte en alta resolución (las pruebas usan uno falso). */
  officeArt?: OfficeStudioOptions["art"];
  /** Cómo bajar la lista de precios de las API (por omisión, la de LiteLLM); null: sin precios (pruebas). */
  fetchPrices?: (() => Promise<Record<string, ModelPrice>>) | null;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

/** Donde se guarda el token de PixelLab: aparte de los ajustes, que van a la interfaz. */
export const PIXELLAB_TOKEN_META = "pixellab_token";

export interface AgentInput {
  name: string;
  role?: string;
  description?: string;
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
  /** «Avisarme»: all, needs o none; null vuelve a lo de siempre. */
  notify?: NotifyLevel | null;
  /** Cómo se ve su personaje de la Oficina. */
  appearance?: string;
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
  /** Agentes y canales que creó en este turno (solo el bot principal). */
  createdAgents: number;
  createdChannels: number;
  /** Canal del encargo: lo que escriba el agente se publica allí. */
  channelId: string | null;
  /** Encargos que lleva Claude Bot en la cadena de este pedido (ver MAIN_MAX_STEPS). */
  steps: number;
  /** Imágenes que generó en este turno, ya en la carpeta compartida; `sent` cuando ya se le pasaron a alguien. */
  images: Array<SavedImage & { sent: boolean }>;
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
  /** Hilos abiertos en su proveedor y la huella de las instrucciones con que se abrieron (si cambian, se reabren). */
  readonly #loadedThreads = new Map<string, string>();
  readonly #active = new Map<string, TurnState>();
  readonly #draining = new Set<string>();
  readonly #scheduled = new Set<string>();
  /** Agentes que se están eliminando: su cola ya no arranca turnos nuevos. */
  readonly #deleting = new Set<string>();
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
  /** Lo que respondió el proveedor en el último inicio de sesión fallido. */
  readonly #signInProblems = new Map<ProviderId, string>();
  readonly #usage = new Map<ProviderId, UsageView>();
  #usageTimer: NodeJS.Timeout | null = null;
  #usageSoon: NodeJS.Timeout | null = null;
  #usageRefresh: Promise<UsageView[]> | null = null;
  #usageReadAt = 0;
  /** Procesos abiertos solo para leer el uso: se cierran al terminar si ningún agente los empezó a usar. */
  readonly #usageOnly = new Set<ProviderId>();
  /** Personajes de PixelLab y arte de la Oficina. */
  readonly #studio: OfficeStudio;
  /** Agentes cuyo último turno falló (para el «!» de la Oficina). */
  readonly #failedTurns = new Set<string>();
  /** Los MCP de cada agente, la última vez que se revisaron (key: proveedor y acceso con que se revisó). */
  readonly #mcp = new Map<string, { key: string; at: number; view: AgentMcpView }>();
  readonly #mcpChecks = new Map<string, Promise<AgentMcpView>>();
  /** Revisar los MCP abre una sesión corta de Claude Code (o Codex): pocas a la vez. */
  #mcpSlots = MCP_PARALLEL;
  readonly #mcpQueue: Array<() => void> = [];
  #progress: Map<string, AgentProgress> | null = null;
  #teamProgress: Map<string, TeamProgressRecord> | null = null;
  #modelLists: Map<string, { at: number; models: ModelOption[] }> | null = null;
  /** Lo último que dijo cada sesión («proveedor:hilo») de su gasto acumulado. */
  #tokenReadings: Map<string, { at: number; reading: Reading }> | null = null;
  /** La lista de precios guardada (undefined: aún no se leyó de la base). */
  #prices: { at: number; prices: Record<string, ModelPrice> } | null | undefined = undefined;
  #pricesRefresh: Promise<void> | null = null;
  readonly #modelReads = new Map<ProviderId, Promise<ModelOption[]>>();

  constructor(options: ServiceOptions) {
    super();
    this.#options = options;
    this.#store = options.store;
    this.#signIns = new SignInFlows(options.signInTimeoutMs ? { timeoutMs: options.signInTimeoutMs } : {});
    this.#signIns.on("change", () => this.#emit({ type: "providers", providers: this.providers() }));
    this.#signIns.on("settled", (provider, result) => void this.#afterSignIn(provider, result));
    // Antigravity (Gemini) son unos 200 MB: con una conexión lenta tarda más que los 10 minutos de un inicio de sesión.
    this.#installs = new SignInFlows({ action: "install", timeoutMs: options.installTimeoutMs ?? INSTALL_TIMEOUT_MS });
    this.#installs.on("change", () => this.#emit({ type: "providers", providers: this.providers() }));
    this.#installs.on("settled", (provider, result) => void this.#afterInstall(provider as InstallProvider, result));
    this.#studio = new OfficeStudio({
      dir: options.officeDir ?? join(dirname(resolve(options.sharedDir)), "oficina"),
      token: () => this.#pixelLabToken(),
      ...(options.pixelLab ? { pixelLab: options.pixelLab } : {}),
      ...(options.officeArt ? { art: options.officeArt } : {}),
      log: (level, message) => this.#log(level, message),
    });
    this.#studio.on("character", (agentId: string, change: { status: CharacterState["status"]; error: string | null; version?: number }) =>
      this.#characterChanged(agentId, change),
    );
    this.#studio.on("art", () => this.#emit({ type: "office", art: this.#officeArt() }));
  }

  // ---------- ciclo de vida ----------

  async start(): Promise<void> {
    mkdirSync(this.#options.workspacesDir, { recursive: true });
    mkdirSync(this.#options.sharedDir, { recursive: true });
    this.#ensureMainAgent();
    this.#migrateInstructionFiles();
    // Un personaje que se estaba dibujando cuando se cerró la app no sigue solo (no se gasta de nuevo sin pedirlo).
    for (const agent of this.#store.listAgents()) {
      if (agent.character?.status === "drawing") {
        this.#store.updateAgent(agent.id, { character: { ...agent.character, status: "failed", error: "Se interrumpió al cerrar ClosedBot.", updatedAt: Date.now() } });
      }
    }
    for (const delivery of this.#store.reconcileUnfinished()) {
      this.#notice(delivery.agentId, "La app se reinició mientras este agente trabajaba; ese turno quedó interrumpido.");
    }
    for (const agentId of this.#store.agentsWithQueuedWork()) this.#scheduleDrain(agentId);
    this.#armRoutines();
    this.#loadUsage();
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
        // Un error de inicio de sesión viejo deja de importar si el proveedor ya quedó conectado.
        for (const status of this.#providers) if (status.loggedIn === true) this.#signInProblems.delete(status.id);
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
      const signIn = status.id === "demo" || status.id === "local" ? null : this.#signIns.view(status.id);
      const installing = status.id === "demo" || status.id === "local" ? null : this.#installs.view(status.id);
      const problem = status.loggedIn === true || signIn ? null : (this.#signInProblems.get(status.id) ?? null);
      if (!signIn && !installing && !problem) return status;
      return {
        ...status,
        ...(signIn ? { signIn } : {}),
        ...(installing ? { install: { startedAt: installing.startedAt } } : {}),
        ...(problem ? { problem } : {}),
      };
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
        // Queda a la vista en su tarjeta de Ajustes hasta que se conecte.
        this.#signInProblems.set(provider, result.message);
        this.#emit({ type: "notice", level: "error", message: result.message });
      }
      this.#emit({ type: "providers", providers: this.providers() });
      return;
    }
    // Los procesos que ya estaban abiertos arrancaron sin la sesión nueva.
    await this.#dropClient(provider);
    this.#signInProblems.delete(provider);
    const providers = await this.refreshProviders();
    const status = providers.find((item) => item.id === provider);
    // Que el programa termine bien no basta: la sesión tiene que haber quedado guardada.
    if (status?.loggedIn === false) {
      const message = `El inicio de sesión de ${label} terminó, pero la sesión no quedó guardada. Vuelve a pulsar «${signInButton(provider)}».`;
      this.#log("warn", message);
      this.#signInProblems.set(provider, message);
      this.#emit({ type: "notice", level: "error", message });
      this.#emit({ type: "providers", providers: this.providers() });
      return;
    }
    this.#log("info", `${label} quedó conectado.`);
    const email = status?.account?.email;
    this.#emit({ type: "notice", level: "info", message: `${label} quedó conectado${email ? ` como ${email}` : ""}.` });
  }

  // ---------- instalación de los proveedores ----------

  /** Instala el programa del proveedor con su instalador oficial (npm para Codex, el .zip de Google para Gemini). */
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
    for (const key of [...this.#loadedThreads.keys()]) if (key.startsWith(`${provider}:`)) this.#loadedThreads.delete(key);
    if (!client) return;
    client.removeAllListeners();
    await client.stop().catch(() => undefined);
  }

  /**
   * El modelo de un agente para contarlo (a Claude Bot, en sus herramientas): el elegido o, si no hay, el que usa su
   * programa por defecto, con el nombre de la lista guardada (pedido: nada de «predeterminado» sin decir cuál).
   */
  #modelName(provider: ProviderId, model: string | null): string {
    if (model) return model;
    const models = this.#modelListMap().get(provider)?.models ?? [];
    const fallback = models.find((entry) => entry.isDefault) ?? models[0];
    return fallback ? `${fallback.model} (el que usa ${providerLabel(provider)} por defecto)` : "el que use su programa por defecto";
  }

  /** El id del modelo de un agente: el elegido o el que usa su programa por defecto (de la lista guardada). */
  #modelId(provider: ProviderId, model: string | null): string {
    if (model) return model;
    const models = this.#modelListMap().get(provider)?.models ?? [];
    return (models.find((entry) => entry.isDefault) ?? models[0])?.model ?? provider;
  }

  /** El nombre de un modelo para mostrar («Claude Opus 5.5»), si está en la lista guardada. */
  #modelLabel(provider: ProviderId, model: string): string {
    const name = normalizeModel(model);
    const models = this.#modelListMap().get(provider)?.models ?? [];
    return models.find((entry) => entry.model === model || normalizeModel(entry.model) === name)?.displayName ?? model;
  }

  // ---------- gasto de los agentes («Uso») ----------

  /** El informe de «Uso» de los últimos `days` días (0 = todo), con precios de API para lo que no trae costo. */
  async spendReport(days: number): Promise<SpendReport> {
    await this.#ensurePrices();
    const from = rangeStart(days);
    const prices = this.#priceList();
    return spendReport(this.#store.tokenUsageGroups(from), {
      from,
      to: localDay(Date.now()),
      prices: prices?.prices ?? {},
      pricesAt: prices?.at ?? null,
      providerLabel,
      modelLabel: (provider, model) => this.#modelLabel(provider, model),
      agentName: (agentId) => this.#store.getAgent(agentId)?.name ?? null,
    });
  }

  /** Sin precios todavía: se espera la lista un rato; si es vieja, se renueva aparte. */
  async #ensurePrices(): Promise<void> {
    if (this.#options.fetchPrices === null) return;
    const saved = this.#priceList();
    if (saved && Date.now() - saved.at < PRICES_REFRESH_MS) return;
    this.#pricesRefresh ??= (async () => {
      try {
        const prices = await (this.#options.fetchPrices ?? (() => downloadPrices()))();
        this.#prices = { at: Date.now(), prices };
        this.#store.setMeta(PRICES_META, JSON.stringify(this.#prices));
      } catch (error) {
        this.#log("warn", `No se pudo bajar la lista de precios: ${errorText(error)}`);
      } finally {
        this.#pricesRefresh = null;
      }
    })();
    if (saved) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.#pricesRefresh, new Promise<void>((done) => (timer = setTimeout(done, PRICES_WAIT_MS)))]);
    clearTimeout(timer);
  }

  #priceList(): { at: number; prices: Record<string, ModelPrice> } | null {
    if (this.#prices !== undefined) return this.#prices;
    this.#prices = null;
    try {
      const saved: unknown = JSON.parse(this.#store.getMeta(PRICES_META) ?? "null");
      if (isRecord(saved) && typeof saved.at === "number" && isRecord(saved.prices)) {
        this.#prices = { at: saved.at, prices: saved.prices as Record<string, ModelPrice> };
      }
    } catch {
      // Una lista dañada se vuelve a bajar.
    }
    return this.#prices;
  }

  #tokenReadingMap(): Map<string, { at: number; reading: Reading }> {
    if (this.#tokenReadings) return this.#tokenReadings;
    const map = new Map<string, { at: number; reading: Reading }>();
    try {
      const saved: unknown = JSON.parse(this.#store.getMeta(TOKEN_READINGS_META) ?? "{}");
      if (isRecord(saved)) {
        for (const [key, value] of Object.entries(saved)) {
          const reading = isRecord(value) ? parseReading(getRecord(value, "reading")) : null;
          if (isRecord(value) && typeof value.at === "number" && reading) map.set(key, { at: value.at, reading });
        }
      }
    } catch {
      // Dañada: se empieza de nuevo (las sesiones siguientes vuelven a contar desde su próxima lectura).
    }
    this.#tokenReadings = map;
    return map;
  }

  #saveTokenReadings(): void {
    const map = this.#tokenReadingMap();
    const now = Date.now();
    for (const [key, value] of map) if (now - value.at > TOKEN_READING_KEEP_MS) map.delete(key);
    this.#store.setMeta(TOKEN_READINGS_META, JSON.stringify(Object.fromEntries(map)));
  }

  #seedTokenReading(provider: ProviderId, threadId: string): void {
    this.#tokenReadingMap().set(`${provider}:${threadId}`, { at: Date.now(), reading: {} });
    this.#saveTokenReadings();
  }

  /**
   * Cuenta lo que gastó un turno. `reading`: lo acumulado en la sesión (se resta la lectura anterior);
   * `turn`: lo de este turno solo, que se usa si la acumulada no sirve (sesión reanudada sin lectura anterior).
   */
  #countTokens(agentId: string, threadId: string, reading: Reading | null, turn: (ModelReading & { model: string }) | null): void {
    const agent = this.#store.getAgent(agentId);
    if (!agent) return;
    let counted: Reading | null = null;
    if (reading && !emptyReading(reading)) {
      const readings = this.#tokenReadingMap();
      const key = `${agent.provider}:${threadId}`;
      const previous = readings.get(key);
      if (previous) {
        counted = readingIncrement(reading, previous.reading);
        // Bajó: la sesión empezó de nuevo. Sin lo del turno, la lectura entera es lo nuevo (Codex reanudado desde cero).
        if (!counted && !turn) counted = reading;
      }
      readings.set(key, { at: Date.now(), reading });
      this.#saveTokenReadings();
    }
    if (!counted && turn) counted = { [turn.model]: turn };
    if (!counted) return;
    const at = Date.now();
    let added = false;
    for (const [model, entry] of Object.entries(counted)) {
      if (!tokensOf(entry) && !entry.costUsd) continue;
      this.#store.addTokenUsage({
        at,
        day: localDay(at),
        provider: agent.provider,
        model,
        agentId: agent.id,
        agentName: agent.name,
        input: entry.input,
        cacheRead: entry.cacheRead,
        cacheWrite: entry.cacheWrite,
        output: entry.output,
        costUsd: entry.costUsd,
      });
      added = true;
    }
    if (added) this.#emit({ type: "spend" });
  }

  /** `fresh`: pedirla de nuevo aunque haya una guardada. */
  async listModels(provider: ProviderId, options: { fresh?: boolean } = {}): Promise<ModelOption[]> {
    // Codex, Grok y Gemini son programas aparte: si no están instalados (o no tienen sesión) no se arrancan.
    if (provider === "codex" || provider === "grok" || provider === "gemini") {
      const status = this.#providers.find((item) => item.id === provider);
      if (!status?.available || (provider !== "codex" && status.loggedIn === false)) return [];
    }
    // La guardada sale al instante (pedido: «Gemini demora mucho en cargar el modelo»); si es vieja, se renueva aparte.
    const saved = this.#modelListMap().get(provider);
    if (saved && !options.fresh) {
      if (Date.now() - saved.at > MODELS_REFRESH_MS) void this.#readModels(provider).catch(() => undefined);
      return saved.models;
    }
    return this.#readModels(provider);
  }

  #modelListMap(): Map<string, { at: number; models: ModelOption[] }> {
    if (this.#modelLists) return this.#modelLists;
    const map = new Map<string, { at: number; models: ModelOption[] }>();
    try {
      const saved: unknown = JSON.parse(this.#store.getMeta(MODELS_META) ?? "{}");
      if (isRecord(saved)) {
        for (const [provider, value] of Object.entries(saved)) {
          if (!isRecord(value) || typeof value.at !== "number" || !Array.isArray(value.models)) continue;
          const models = value.models.filter((model): model is ModelOption => isRecord(model) && typeof model.model === "string" && typeof model.displayName === "string" && Array.isArray(model.efforts));
          if (models.length) map.set(provider, { at: value.at, models });
        }
      }
    } catch {
      // Una lista dañada se vuelve a pedir.
    }
    this.#modelLists = map;
    return map;
  }

  /** Pide la lista al programa (una vez a la vez por proveedor) y la guarda. */
  #readModels(provider: ProviderId): Promise<ModelOption[]> {
    const running = this.#modelReads.get(provider);
    if (running) return running;
    const read = (async () => {
      const client = await this.#getClient(provider);
      const response = await client.request<unknown>("model/list", {});
      const models: ModelOption[] = getArray(response, "data")
        .filter(isRecord)
        .filter((model) => model.hidden !== true)
        .map((model) => ({
          model: String(model.model ?? model.id ?? ""),
          displayName: String(model.displayName ?? model.model ?? ""),
          isDefault: model.isDefault === true,
          efforts: getArray(model, "supportedReasoningEfforts")
            .map((entry) => (isRecord(entry) ? String(entry.reasoningEffort ?? "") : String(entry)))
            .filter(Boolean),
          ...variantsOf(model),
        }))
        .filter((model) => model.model);
      if (models.length) {
        const map = this.#modelListMap();
        map.set(provider, { at: Date.now(), models });
        this.#store.setMeta(MODELS_META, JSON.stringify(Object.fromEntries(map)));
      }
      return models;
    })().finally(() => this.#modelReads.delete(provider));
    this.#modelReads.set(provider, read);
    return read;
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
    const instructions = cleanText(input.instructions, INSTRUCTIONS_MAX);
    writeInstructions(workspace, instructions);
    const agent = this.#store.createAgent({
      name,
      role: cleanText(input.role, 200),
      description: cleanText(input.description, DESCRIPTION_MAX),
      instructions: cleanInstructions(instructions),
      provider,
      model: cleanOptional(input.model, 120),
      effort: cleanOptional(input.effort, 20),
      access: input.access === "total" ? "total" : "carpeta",
      workspace,
      project: cleanProject(input.project),
      appearance: cleanText(input.appearance, APPEARANCE_MAX),
      ...(input.avatar === undefined ? {} : { avatar: cleanAvatar(input.avatar) }),
    });
    let created = agent;
    if (input.voice !== undefined || input.pinned !== undefined || input.hidden !== undefined || input.notify !== undefined) {
      created = this.#store.updateAgent(agent.id, {
        ...(input.voice === undefined ? {} : { voice: toVoice({ ...agent.voice, ...input.voice }) }),
        ...(input.pinned === undefined ? {} : { pinned: input.pinned === true }),
        ...(input.hidden === undefined ? {} : { hidden: input.hidden === true }),
        ...(input.notify === undefined ? {} : { notify: cleanNotify(input.notify) }),
      });
    }
    // La Oficina dibuja robots: los personajes de PixelLab solo se piden si se activa `autoCharacters`.
    if (this.#options.autoCharacters && this.#requestCharacter(created)) created = this.#store.getAgent(created.id) ?? created;
    this.#emitAgents();
    if (options.greet) this.#greet(created);
    return this.#view(created);
  }

  /** `by`: quién hizo el cambio, si no fue el usuario (Claude Bot), para el aviso en el chat del agente. */
  updateAgent(id: string, patch: Partial<AgentInput>, options: { by?: string } = {}): AgentView {
    const agent = this.#requireAgent(id);
    const next: Parameters<Store["updateAgent"]>[1] = {};
    if (patch.name !== undefined) {
      const name = cleanName(patch.name);
      const other = this.#store.findAgentByName(name);
      if (other && other.id !== id) throw new ServiceError(`Ya existe un agente llamado «${name}».`, 409);
      next.name = name;
    }
    if (patch.role !== undefined) next.role = cleanText(patch.role, 200);
    if (patch.description !== undefined) next.description = cleanText(patch.description, DESCRIPTION_MAX);
    if (patch.instructions !== undefined) next.instructions = cleanInstructions(cleanText(patch.instructions, INSTRUCTIONS_MAX));
    if (patch.notify !== undefined) next.notify = cleanNotify(patch.notify);
    if (patch.model !== undefined) next.model = cleanOptional(patch.model, 120);
    if (patch.effort !== undefined) next.effort = cleanOptional(patch.effort, 20);
    if (patch.access !== undefined) next.access = patch.access === "total" ? "total" : "carpeta";
    if (patch.project !== undefined) next.project = cleanProject(patch.project);
    if (patch.avatar !== undefined) next.avatar = cleanAvatar(patch.avatar);
    if (patch.pinned !== undefined) next.pinned = patch.pinned === true;
    if (patch.hidden !== undefined) next.hidden = patch.hidden === true;
    if (patch.voice !== undefined) next.voice = toVoice({ ...agent.voice, ...patch.voice });
    if (patch.appearance !== undefined) next.appearance = cleanText(patch.appearance, APPEARANCE_MAX);
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
    // El archivo es lo que lee el agente (y lo que él mismo edita): se escribe antes de guardarlo en la base.
    if (next.instructions !== undefined) writeInstructions(agent.workspace, next.instructions);
    let updated = this.#store.updateAgent(id, next);
    // Otro aspecto: PixelLab lo vuelve a dibujar.
    if (this.#options.autoCharacters && next.appearance !== undefined && next.appearance !== agent.appearance && this.#requestCharacter(updated)) {
      updated = this.#store.getAgent(id) ?? updated;
    }
    if (agent.threadId) this.#loadedThreads.delete(`${agent.provider}:${agent.threadId}`);
    if (next.provider) {
      void this.#closeThread(agent);
      this.#notice(
        id,
        `${options.by ? `${options.by} cambió` : "Cambiaste"} el proveedor a ${providerLabel(updated.provider)}: la próxima respuesta empieza una conversación nueva.`,
      );
    }
    this.#emitAgents();
    return this.#view(updated);
  }

  /** Elimina un agente. Con `stop`, si está trabajando primero detiene su turno (así se eliminan varios de una vez). */
  async deleteAgent(id: string, options: { stop?: boolean } = {}): Promise<void> {
    const agent = this.#requireAgent(id);
    if (this.#isMain(agent)) {
      throw new ServiceError(`${agent.name} es el bot principal y no se puede eliminar. Si quieres, empieza su conversación de cero.`, 409);
    }
    if (this.#deleting.has(id)) throw new ServiceError(`${agent.name} ya se está eliminando.`, 409);
    if (this.#active.has(id) && !options.stop) throw new ServiceError("Detén el turno en curso antes de eliminar el agente.", 409);
    this.#deleting.add(id);
    try {
      this.#store.cancelQueuedForAgent(id);
      if (this.#active.has(id)) await this.#stopTurn(id);
      // Mientras trabajaba pudo estrenar su hilo: se cierra el que tiene ahora.
      await this.#closeThread(this.#store.getAgent(id) ?? agent);
      const touchedChannels = this.#leaveChannels(id);
      this.#store.deleteAgent(id);
      this.#studio.forget(id);
      this.#failedTurns.delete(id);
      this.#mcp.delete(id);
      this.#setProgress(id, null);
      this.#emitAgents();
      if (touchedChannels) this.#emitChannels();
      // Sus rutinas se borran con él (ON DELETE CASCADE).
      this.#emitRoutines();
      this.#armRoutines();
    } finally {
      this.#deleting.delete(id);
    }
  }

  /** Detiene el turno en curso y espera a que termine; si no termina a tiempo, lo da por interrumpido. */
  async #stopTurn(agentId: string): Promise<void> {
    await this.interrupt(agentId).catch(() => false);
    const deadline = Date.now() + STOP_WAIT_MS;
    while (this.#active.has(agentId) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    const state = this.#active.get(agentId);
    if (state) this.#finishTurn(agentId, state.turnId, "interrupted");
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
    if (!name) throw new ServiceError("Sección no encontrada.", 404);
    // Si ya no existe (p. ej. se borraron todos sus agentes), no queda nada que hacer.
    if (!this.#sectionExists(name)) return this.listSections();
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

  /** Carpeta de trabajo y compartida de un agente (para «Carpetas» en su ficha). */
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
    return USAGE_PROVIDERS.map((provider) => this.#usage.get(provider)).filter((entry): entry is UsageView => entry !== undefined);
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
    // A la vez: Gemini puede tardar (abre su propia sesión la primera vez) y los demás no lo esperan.
    await Promise.all(USAGE_PROVIDERS.map((provider) => this.#readProviderUsage(provider)));
    const usage = this.usage();
    this.#saveUsage();
    this.#emit({ type: "usage", usage });
    return usage;
  }

  async #readProviderUsage(provider: (typeof USAGE_PROVIDERS)[number]): Promise<void> {
    const status = this.#providers.find((item) => item.id === provider);
    if (status?.loggedIn === false) {
      this.#usage.delete(provider);
      return;
    }
    // Solo con la sesión confirmada: con la detección apagada no se sabe, y no se arranca nada.
    if (!status?.available || status.loggedIn !== true) return;
    // Antigravity (Gemini) tarda en arrancar y descomprime unos 300 MB: no se abre solo para esto. Se lee
    // cuando ya está en marcha porque un agente lo usa; mientras, queda la última lectura.
    if (provider === "gemini" && !this.#clients.get("gemini")?.running) return;
    // Codex y Grok arrancan en un momento: se abren para leer y se cierran si ningún agente los está usando.
    const opened = provider !== "claude" && !this.#clientReady.has(provider);
    if (opened) this.#usageOnly.add(provider);
    try {
      const client = await this.#getClient(provider, "usage");
      const response = await client.request<unknown>("account/rateLimits/read", {}, provider === "gemini" ? 150_000 : 30_000);
      const parsed = parseUsage(provider, response);
      if (parsed) this.#usage.set(provider, parsed);
      else this.#usage.delete(provider);
    } catch (error) {
      const previous = this.#usage.get(provider);
      const message = errorText(error);
      if (/no implementa|not implemented|unknown method|method not found/i.test(message)) return;
      this.#usage.set(provider, {
        provider,
        label: providerLabel(provider),
        plan: previous?.plan ?? null,
        windows: previous?.windows ?? [],
        updatedAt: previous?.updatedAt ?? Date.now(),
        error: `No se pudo leer el uso: ${message}`,
      });
    } finally {
      if (opened && this.#usageOnly.has(provider)) await this.#releaseClient(provider);
      this.#usageOnly.delete(provider);
    }
    this.#emit({ type: "usage", usage: this.usage() });
  }

  /** Codex avisa cuando cambia el uso (al terminar un turno): se toma sin volver a preguntar. */
  #usageUpdated(provider: ProviderId, params: unknown): void {
    const parsed = parseUsage(provider, params);
    if (!parsed) return;
    const previous = this.#usage.get(provider);
    const windows = [...parsed.windows, ...(previous?.windows ?? []).filter((window) => !parsed.windows.some((item) => item.id === window.id))];
    // Como en parseUsage: primero la semanal (la que muestra el anillo).
    windows.sort((a, b) => Number(b.label === "Semanal") - Number(a.label === "Semanal"));
    this.#usage.set(provider, { ...parsed, plan: parsed.plan ?? previous?.plan ?? null, windows });
    this.#saveUsage();
    this.#emit({ type: "usage", usage: this.usage() });
  }

  #saveUsage(): void {
    const saved = this.usage()
      .filter((entry) => entry.windows.length)
      .map((entry) => ({ provider: entry.provider, plan: entry.plan, windows: entry.windows, updatedAt: entry.updatedAt }));
    this.#store.setMeta(USAGE_META, JSON.stringify(saved));
  }

  /** La última lectura guardada, para mostrarla al abrir la app mientras se vuelve a leer. */
  #loadUsage(): void {
    let saved: unknown;
    try {
      saved = JSON.parse(this.#store.getMeta(USAGE_META) ?? "[]");
    } catch {
      return;
    }
    if (!Array.isArray(saved)) return;
    for (const entry of saved.filter(isRecord)) {
      const provider = entry.provider;
      if (typeof provider !== "string" || !(USAGE_PROVIDERS as readonly string[]).includes(provider) || !isProviderId(provider)) continue;
      const windows = getArray(entry, "windows")
        .filter(isRecord)
        .map((window) => ({
          id: String(window.id ?? ""),
          label: String(window.label ?? ""),
          percent: Number(window.percent),
          resetsAt: typeof window.resetsAt === "number" && Number.isFinite(window.resetsAt) ? window.resetsAt : null,
        }))
        .filter((window) => window.label && Number.isFinite(window.percent));
      if (!windows.length) continue;
      this.#usage.set(provider, {
        provider,
        label: providerLabel(provider),
        plan: typeof entry.plan === "string" ? entry.plan : null,
        windows,
        updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : 0,
        error: null,
      });
    }
  }

  /** Cierra un proceso que se abrió solo para leer el uso, si ningún agente lo está usando. */
  async #releaseClient(provider: ProviderId): Promise<void> {
    if (this.#stopping) return;
    if ([...this.#active.values()].some((state) => state.provider === provider)) return;
    if ([...this.#loadedThreads.keys()].some((key) => key.startsWith(`${provider}:`))) return;
    const client = this.#clients.get(provider);
    if (!client) return;
    this.#clients.delete(provider);
    this.#clientReady.delete(provider);
    client.removeAllListeners();
    await client.stop().catch(() => undefined);
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

  /** Agentes (sin el bot principal) y canales, también los eliminados, como los conoce el bot principal. */
  #teamSnapshot(threadId: string | null): TeamSnapshot {
    const agents = this.#store.listAgents().filter((agent) => !this.#isMain(agent));
    return snapshotTeam(threadId, agents, [...this.#store.listChannels(), ...this.#store.listChannels({ deleted: true })]);
  }

  /**
   * Nota para el bot principal: lo que cambió desde su último mensaje o, si su conversación es nueva
   * (o nunca se le contó), cómo está todo. Devuelve también la foto que hay que guardar.
   */
  #teamNote(threadId: string): { note: string | null; saved: string; previous: string | null } {
    const previous = this.#store.getMeta(MAIN_KNOWN_META);
    const known = parseTeamSnapshot(previous);
    const now = this.#teamSnapshot(threadId);
    const label = (provider: string) => (isProviderId(provider) ? providerLabel(provider) : provider);
    const note = known && known.threadId === threadId ? describeChanges(known, now, label) : describeTeam(now, label);
    return { note, saved: JSON.stringify(now), previous };
  }

  /** Lo que hizo el propio bot principal con sus herramientas ya lo sabe: se suma a lo que se le contó. */
  #absorbKnown(update: (known: TeamSnapshot) => void): void {
    const known = parseTeamSnapshot(this.#store.getMeta(MAIN_KNOWN_META));
    if (!known) return;
    update(known);
    this.#store.setMeta(MAIN_KNOWN_META, JSON.stringify(known));
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
    const next: Partial<Pick<ChannelRecord, "name" | "topic" | "leadId" | "memberIds" | "color">> = {};
    if (patch.color !== undefined) next.color = channelColor(patch.color);
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

  /**
   * La Oficina: el usuario arrastró a un agente a otra plataforma. Deja el canal de donde salió (`from`) y entra
   * al de destino (`to`) o a uno nuevo (`name`, con él de encargado); sin destino queda «Sin grupo» y deja todos
   * sus canales. Si su sección era la del equipo que deja (o no tenía), pasa a la del nuevo, para que la barra
   * lateral muestre lo mismo que la Oficina. Un canal que se queda sin agentes pasa a «Canales eliminados».
   */
  moveAgentToTeam(agentId: string, input: TeamMoveInput): TeamMove {
    const agent = this.#requireAgent(agentId);
    if (this.#isMain(agent)) throw new ServiceError("Claude Bot se queda en su salón: desde ahí coordina a todos los equipos.", 409);
    const from = typeof input.from === "string" && input.from ? this.#requireChannel(input.from) : null;
    const newName = typeof input.name === "string" && input.name.trim() ? channelName(input.name) : null;
    const target = !newName && typeof input.to === "string" && input.to ? this.#requireChannel(input.to) : null;
    if (target?.deletedAt) throw new ServiceError(`«${target.name}» está en «Canales eliminados»: restáuralo antes de sumarle agentes.`, 409);
    if (target && !target.memberIds.includes(agent.id) && target.memberIds.length >= MAX_CHANNEL_MEMBERS) {
      throw new ServiceError(`«${target.name}» ya tiene ${MAX_CHANNEL_MEMBERS} agentes, el máximo de un equipo.`, 409);
    }
    if (newName) {
      if (this.#store.listChannels().length >= MAX_CHANNELS) {
        throw new ServiceError(`Ya tienes ${MAX_CHANNELS} canales, el máximo. Elimina alguno que no uses.`, 409);
      }
      if (this.#store.findChannelByName(newName)) throw new ServiceError(`Ya existe un equipo llamado «${newName}».`, 409);
    }
    // Lo que deja: el canal de donde salió o, si queda «Sin grupo», todos los suyos.
    const leaving = (target || newName ? (from ? [from] : []) : this.#store.listChannels())
      .filter((channel) => !channel.deletedAt && channel.memberIds.includes(agent.id) && channel.id !== target?.id);
    // Su sección sigue al equipo si era la del que deja (o si no tenía ninguna).
    const before = from && from.memberIds.includes(agent.id) ? this.#teamSection(from) : "";
    const follows = !agent.project || agent.project.toLowerCase() === before.toLowerCase();

    const archived: ChannelRecord[] = [];
    let team: ChannelRecord | null = null;
    this.#store.transaction(() => {
      if (newName) {
        team = this.#store.createChannel({ name: newName, topic: "", leadId: agent.id, memberIds: [agent.id] });
      } else if (target) {
        team = target.memberIds.includes(agent.id)
          ? target
          : this.#store.updateChannel(target.id, { memberIds: [...target.memberIds, agent.id], leadId: target.leadId ?? agent.id });
      }
      for (const channel of leaving) {
        const memberIds = channel.memberIds.filter((id) => id !== agent.id);
        if (!memberIds.length) {
          archived.push(channel);
          continue;
        }
        // Si era el encargado, lo reemplaza el primero que queda (mejor un agente que Claude Bot).
        const lead =
          channel.leadId && channel.leadId !== agent.id && memberIds.includes(channel.leadId)
            ? channel.leadId
            : (memberIds.find((id) => id !== this.#mainAgentId) ?? memberIds[0] ?? null);
        this.#store.updateChannel(channel.id, { memberIds, leadId: lead });
      }
      if (follows) {
        const project = team ? this.#teamSection(team, agent.id) : "";
        if (project !== agent.project) this.#store.updateAgent(agent.id, { project });
      }
    });
    if (newName) this.#log("info", `Creé el canal «${newName}» desde la Oficina.`);
    // Igual que al eliminar agentes: el canal vacío va a «Canales eliminados» (y se cancela lo que esperaba turno).
    // Se guarda con él como miembro: si lo restauras, vuelve a estar ahí.
    for (const channel of archived) this.deleteChannel(channel.id);
    this.#emitAgents();
    this.#emitChannels();
    const moved = this.#requireAgent(agent.id);
    const joined = team as ChannelRecord | null;
    return {
      agent: this.#view(moved),
      team: joined ? this.#channelView(this.#store.getChannel(joined.id) ?? joined) : null,
      left: leaving.map((channel) => channel.name),
      archived: archived.map((channel) => channel.name),
      channels: this.listChannels(),
      deleted: this.listDeletedChannels(),
    };
  }

  /** La sección de un equipo: la más común entre sus agentes (sin Claude Bot) o, si no tienen, su nombre. */
  #teamSection(channel: ChannelRecord, exclude?: string): string {
    const counts = new Map<string, { name: string; count: number }>();
    for (const id of channel.memberIds) {
      if (id === exclude || id === this.#mainAgentId) continue;
      const project = this.#store.getAgent(id)?.project ?? "";
      if (!project) continue;
      const entry = counts.get(project.toLowerCase()) ?? { name: project, count: 0 };
      entry.count += 1;
      counts.set(project.toLowerCase(), entry);
    }
    let best: { name: string; count: number } | null = null;
    for (const entry of counts.values()) if (!best || entry.count > best.count) best = entry;
    return best?.name ?? cleanProject(channel.name);
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
    return { ...channel, unread: channel.lastAt > channel.readAt, working: [...new Set(working)], progress: this.#channelProgress(channel) };
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

  /**
   * El usuario eligió una opción de una tarjeta de decisión: la respuesta le llega al agente como mensaje.
   * Si es la tarjeta para eliminar agentes y tocó «Eliminar», antes se eliminan.
   */
  async answerDecision(agentId: string, messageId: string, choice: unknown): Promise<{ decision: MessageRecord; message: MessageRecord; delivery: DeliveryRecord }> {
    this.#requireAgent(agentId);
    const card = this.#store.getMessage(messageId);
    if (card && card.agentId === agentId && card.role === "decision" && card.payload?.kind === DELETE_AGENTS_CARD) {
      return this.#answerDeleteAgents(agentId, messageId, choice);
    }
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

  /**
   * Respuesta a la tarjeta de delete_agents. Con «Eliminar», ClosedBot elimina a los agentes (al que trabaja le
   * detiene el turno, y un canal que se queda sin miembros pasa a «Canales eliminados»), deja la línea
   * «Eliminó a…» en el chat del bot y le cuenta el resultado en un mensaje.
   */
  async #answerDeleteAgents(agentId: string, messageId: string, choice: unknown): Promise<{ decision: MessageRecord; message: MessageRecord; delivery: DeliveryRecord }> {
    // Primero queda respondida: así un segundo toque (o el otro dispositivo) no la responde otra vez.
    const answered = this.#store.transaction(() => {
      const decision = this.#store.getMessage(messageId);
      if (!decision || decision.agentId !== agentId || decision.role !== "decision") throw new ServiceError("Pregunta no encontrada.", 404);
      const payload = decision.payload ?? {};
      if (payload.answer !== null && payload.answer !== undefined) throw new ServiceError("Esa pregunta ya tiene respuesta.", 409);
      const options = readOptions(payload);
      const index = typeof choice === "number" ? choice : Number.NaN;
      const option = Number.isInteger(index) ? options[index] : undefined;
      if (!option) throw new ServiceError("Elige una de las opciones de la tarjeta.");
      const updated = this.#store.updateMessage(messageId, { payload: { ...payload, answer: index, answeredAt: Date.now() } }) as MessageRecord;
      return { decision: updated, index, option };
    });
    this.#emit({ type: "message", agentId, message: answered.decision });
    const payload = answered.decision.payload ?? {};
    const ids = Array.isArray(payload.agentIds) ? payload.agentIds.filter((id): id is string => typeof id === "string") : [];
    const names = Array.isArray(payload.names) ? payload.names.filter((name): name is string => typeof name === "string") : [];
    let outcome: { text: string; deleted: string[]; closed: string[] } | null = null;
    if (answered.index === 0) {
      try {
        outcome = await this.#deleteConfirmed(agentId, ids, names);
      } catch (error) {
        // Que el bot se entere igual: la tarjeta ya quedó respondida.
        outcome = { text: `El usuario confirmó, pero no se pudo terminar de eliminar: ${errorText(error)}. Cuéntaselo al usuario en una línea.`, deleted: [], closed: [] };
      }
    }
    const letter = OPTION_LETTERS[answered.index] ?? String(answered.index + 1);
    const agentText = outcome
      ? outcome.text
      : `El usuario tocó «${answered.option.label}» en la tarjeta para eliminar a ${joinNames(names.map((name) => `«${name}»`)) || "esos agentes"}: no se eliminó a nadie. No insistas; sigue con lo demás que te haya pedido.`;
    const channelId = answered.decision.channelId;
    const result = this.#store.transaction(() => {
      const message = this.#store.insertMessage({
        agentId,
        role: "user",
        text: `${letter}. ${answered.option.label}`,
        status: channelId ? "completed" : "queued",
        payload: { decisionId: messageId, choice: answered.index, ...(channelId ? { to: [agentId] } : {}) },
        channelId,
      });
      const activity =
        outcome && outcome.deleted.length
          ? this.#store.insertMessage({
              agentId,
              role: "activity",
              text: `Eliminó a ${joinNames(outcome.deleted.map((name) => `«${name}»`))}`,
              status: "completed",
              payload: { kind: "agents-deleted", names: outcome.deleted, channels: outcome.closed },
              channelId,
            })
          : null;
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
      return { message: linked, activity, delivery };
    });
    if (!channelId) this.#store.updateAgent(agentId, { readAt: Date.now() });
    this.#emit({ type: "message", agentId, message: result.message });
    if (result.activity) this.#emit({ type: "message", agentId, message: result.activity });
    this.#emitQueue(agentId);
    this.#emitAgents();
    if (channelId) this.#emitChannels();
    this.#scheduleDrain(agentId);
    return { decision: answered.decision, message: result.message, delivery: result.delivery };
  }

  /** Elimina a los agentes que confirmó el usuario y arma lo que se le cuenta al bot principal. */
  async #deleteConfirmed(mainId: string, ids: string[], names: string[]): Promise<{ text: string; deleted: string[]; closed: string[] }> {
    const targets = ids.map((id) => this.#store.getAgent(id)).filter((agent): agent is AgentRecord => agent !== null && agent.id !== mainId);
    // Los que ya no estaban (los eliminó el usuario entre medio): se nombran como estaban en la tarjeta.
    const missing = ids.flatMap((id, index) => (this.#store.getAgent(id) ? [] : [names[index] ?? "un agente"]));
    const doomed = new Set(targets.map((agent) => agent.id));
    const touched = new Set(
      [...this.#store.listChannels(), ...this.#store.listChannels({ deleted: true })]
        .filter((channel) => channel.memberIds.some((id) => doomed.has(id)))
        .map((channel) => channel.id),
    );
    // Igual que «Eliminar» con varios marcados: un canal cuyos miembros se eliminan todos pasa a «Canales eliminados».
    const emptied = this.#store.listChannels().filter((channel) => channel.memberIds.length > 0 && channel.memberIds.every((id) => doomed.has(id)));
    const deleted: AgentRecord[] = [];
    const failures: string[] = [];
    for (const agent of targets) {
      try {
        await this.deleteAgent(agent.id, { stop: true });
        deleted.push(agent);
      } catch (error) {
        if (error instanceof ServiceError && error.status === 404) missing.push(agent.name);
        else failures.push(`«${agent.name}» (${errorText(error)})`);
      }
    }
    const gone = new Set(deleted.map((agent) => agent.id));
    const closed: ChannelRecord[] = [];
    for (const channel of emptied) {
      if (!channel.memberIds.every((id) => gone.has(id))) continue;
      try {
        this.deleteChannel(channel.id);
        closed.push(channel);
      } catch (error) {
        failures.push(`el canal «${channel.name}» (${errorText(error)})`);
      }
    }
    // Lo hizo el propio bot con su herramienta: no se le cuenta después como un cambio del usuario.
    this.#absorbKnown((known) => {
      for (const agent of deleted) delete known.agents[agent.id];
      for (const id of touched) {
        const channel = this.#store.getChannel(id);
        if (channel && known.channels[id]) known.channels[id] = snapshotChannel(channel);
      }
    });
    const quoted = (list: string[]) => joinNames(list.map((name) => `«${name}»`));
    const text = [
      deleted.length
        ? `El usuario confirmó y ClosedBot eliminó a ${quoted(deleted.map((agent) => agent.name))}, con su historial, su cola y sus rutinas (sus archivos siguen en sus carpetas).`
        : "El usuario confirmó, pero no se eliminó a nadie.",
      closed.length === 1 ? `El canal «${closed[0]?.name}» pasó a «Canales eliminados».` : closed.length ? `Los canales ${quoted(closed.map((channel) => channel.name))} pasaron a «Canales eliminados».` : null,
      missing.length ? `${quoted(missing)} ya no ${missing.length === 1 ? "existía" : "existían"}.` : null,
      failures.length ? `No se pudo eliminar ${failures.join("; ")}.` : null,
      "Confírmaselo al usuario en una línea y sigue con lo que quede de su pedido.",
    ]
      .filter(Boolean)
      .join(" ");
    return { text, deleted: deleted.map((agent) => agent.name), closed: closed.map((channel) => channel.name) };
  }

  // ---------- lo que sabe cada agente: instrucciones, recuerdos y habilidades ----------

  /** Sus instrucciones completas, leídas de AGENTS.md (el agente también las edita). */
  getInstructions(agentId: string): { text: string; max: number; file: string } {
    const agent = this.#syncInstructions(this.#requireAgent(agentId));
    return { text: agent.instructions, max: INSTRUCTIONS_MAX, file: join(agent.workspace, "AGENTS.md") };
  }

  /**
   * Guarda sus instrucciones. Con `base` (lo que tenía la pantalla al empezar a editar), si el agente
   * las cambió entre medio no se pisan: se avisa con un 409 y el texto nuevo.
   */
  saveInstructions(agentId: string, text: unknown, base?: unknown): AgentView {
    const agent = this.#syncInstructions(this.#requireAgent(agentId));
    if (typeof text !== "string") throw new ServiceError("Las instrucciones deben ser texto.");
    if (typeof base === "string" && cleanInstructions(base) !== agent.instructions) {
      throw new ServiceError("El agente cambió sus instrucciones mientras las editabas. Revisa la versión nueva antes de guardar.", 409);
    }
    return this.updateAgent(agentId, { instructions: text });
  }

  listMemories(agentId: string): MemoryView[] {
    this.#requireAgent(agentId);
    return this.#store.listMemories(agentId);
  }

  createMemory(agentId: string, input: { text?: unknown; always?: unknown }, createdBy: "user" | "agent" = "user"): MemoryView {
    const agent = this.#requireAgent(agentId);
    const text = asServiceError(() => cleanMemory(input.text));
    const memories = this.#store.listMemories(agent.id);
    const same = memories.find((memory) => memory.text.toLowerCase() === text.toLowerCase());
    if (same) {
      if (input.always === true && !same.always) return this.updateMemory(same.id, { always: true });
      return same;
    }
    if (memories.length >= MEMORY_LIMITS.perAgent) {
      throw new ServiceError(`${agent.name} ya tiene ${MEMORY_LIMITS.perAgent} recuerdos, el máximo: borra alguno antes de guardar otro.`, 409);
    }
    const memory = this.#store.insertMemory({ agentId: agent.id, text, always: input.always === true, createdBy });
    this.#emitMemories(agent.id);
    return memory;
  }

  updateMemory(id: string, input: { text?: unknown; always?: unknown }): MemoryView {
    const memory = this.#requireMemory(id);
    const patch: { text?: string; always?: boolean } = {};
    if (input.text !== undefined) patch.text = asServiceError(() => cleanMemory(input.text));
    if (input.always !== undefined) {
      if (typeof input.always !== "boolean") throw new ServiceError("Indica always: true o false.");
      patch.always = input.always;
    }
    const updated = this.#store.updateMemory(memory.id, patch) as MemoryRecord;
    this.#emitMemories(memory.agentId);
    return updated;
  }

  deleteMemory(id: string): void {
    const memory = this.#requireMemory(id);
    this.#store.deleteMemory(memory.id);
    this.#emitMemories(memory.agentId);
  }

  /** Sus habilidades (carpetas con SKILL.md en .agents/skills o .claude/skills de su carpeta). */
  listSkills(agentId: string): SkillView[] {
    const agent = this.#requireAgent(agentId);
    const off = new Set(agent.skillsOff);
    return listSkills(agent.workspace).map((skill) => ({ ...skill, enabled: !off.has(skill.id) }));
  }

  getSkill(agentId: string, skillId: string): { skill: SkillView; text: string } {
    const agent = this.#requireAgent(agentId);
    const text = asServiceError(() => readSkill(agent.workspace, skillId));
    const skill = this.listSkills(agentId).find((item) => item.id === skillId);
    if (text === null || !skill) throw new ServiceError("Esa habilidad ya no existe.", 404);
    return { skill, text };
  }

  /** Crea una habilidad: su carpeta en .agents/skills con un SKILL.md armado con nombre, descripción y pasos. */
  createSkill(agentId: string, input: { name?: unknown; description?: unknown; body?: unknown }): SkillView {
    const agent = this.#requireAgent(agentId);
    const name = cleanText(input.name, SKILL_LIMITS.name).replace(/\s+/g, " ");
    if (!name) throw new ServiceError("Ponle un nombre a la habilidad.");
    const description = cleanText(input.description, SKILL_LIMITS.description).replace(/\s+/g, " ");
    const body = cleanText(input.body, SKILL_LIMITS.text);
    if (!body) throw new ServiceError("Escribe los pasos de la habilidad.");
    if (this.listSkills(agentId).some((skill) => skill.name.toLowerCase() === name.toLowerCase())) {
      throw new ServiceError(`${agent.name} ya tiene una habilidad llamada «${name}».`, 409);
    }
    const id = newSkillId(agent.workspace, name);
    asServiceError(() => writeSkill(agent.workspace, id, composeSkill(name, description, body)));
    this.#emitSkills(agent.id);
    const skill = this.listSkills(agentId).find((item) => item.id === id);
    if (!skill) throw new ServiceError("No se pudo crear la habilidad.", 500);
    return skill;
  }

  /** Guarda el SKILL.md completo (encabezado y pasos). */
  saveSkill(agentId: string, skillId: string, text: unknown): SkillView {
    const agent = this.#requireAgent(agentId);
    if (typeof text !== "string" || !text.trim()) throw new ServiceError("La habilidad no puede quedar vacía.");
    if (text.length > SKILL_LIMITS.text) throw new ServiceError(`Una habilidad admite hasta ${SKILL_LIMITS.text} caracteres.`);
    if (asServiceError(() => readSkill(agent.workspace, skillId)) === null) throw new ServiceError("Esa habilidad ya no existe.", 404);
    const folder = skillId.split("/").pop() ?? "";
    const parsed = parseSkill(text, folder);
    const clash = this.listSkills(agentId).find((skill) => skill.id !== skillId && skill.name.toLowerCase() === parsed.name.toLowerCase());
    if (clash) throw new ServiceError(`Ya hay otra habilidad llamada «${parsed.name}».`, 409);
    asServiceError(() => writeSkill(agent.workspace, skillId, text));
    this.#emitSkills(agent.id);
    const skill = this.listSkills(agentId).find((item) => item.id === skillId);
    if (!skill) throw new ServiceError("Esa habilidad ya no existe.", 404);
    return skill;
  }

  setSkillEnabled(agentId: string, skillId: string, enabled: boolean): SkillView {
    const agent = this.#requireAgent(agentId);
    const skill = this.listSkills(agentId).find((item) => item.id === skillId);
    if (!skill) throw new ServiceError("Esa habilidad ya no existe.", 404);
    const off = new Set(agent.skillsOff.filter((id) => id !== skillId));
    if (!enabled) off.add(skillId);
    this.#store.updateAgent(agent.id, { skillsOff: [...off] });
    this.#emitSkills(agent.id);
    return { ...skill, enabled };
  }

  deleteSkill(agentId: string, skillId: string): void {
    const agent = this.#requireAgent(agentId);
    if (!this.listSkills(agentId).some((item) => item.id === skillId)) throw new ServiceError("Esa habilidad ya no existe.", 404);
    asServiceError(() => deleteSkill(agent.workspace, skillId));
    if (agent.skillsOff.includes(skillId)) this.#store.updateAgent(agent.id, { skillsOff: agent.skillsOff.filter((id) => id !== skillId) });
    this.#emitSkills(agent.id);
  }

  // ---------- MCP de cada agente ----------

  /**
   * Los MCP que tiene conectados un agente: el de ClosedBot (sus herramientas de equipo) y los que trae su
   * programa (lo que configuraste en Claude Code o en Codex), tal como los ve él. Se guardan unos minutos.
   */
  async agentMcp(agentId: string, options: { refresh?: boolean } = {}): Promise<AgentMcpView> {
    const agent = this.#requireAgent(agentId);
    const key = `${agent.provider}:${this.#access(agent)}`;
    const cached = this.#mcp.get(agent.id);
    if (!options.refresh && cached?.key === key && Date.now() - cached.at < MCP_CACHE_MS) return cached.view;
    const running = this.#mcpChecks.get(agent.id);
    if (running) return running;
    const check = this.#withMcpSlot(() => this.#readMcp(agent))
      .then((view) => {
        if (this.#store.getAgent(agent.id)) this.#mcp.set(agent.id, { key, at: Date.now(), view });
        return view;
      })
      .finally(() => this.#mcpChecks.delete(agent.id));
    this.#mcpChecks.set(agent.id, check);
    return check;
  }

  async #readMcp(agent: AgentRecord): Promise<AgentMcpView> {
    const base = { agentId: agent.id, provider: agent.provider, access: this.#access(agent), checkedAt: new Date().toISOString(), hidden: false, error: null };
    const params = { ...this.#threadParams(agent, true), threadId: agent.threadId ?? null };
    const own = closedbotServer(params, "included");
    // Gemini y Grok (ACP) no cuentan los MCP que les configuraste: solo se sabe el de ClosedBot, sin abrirlos.
    if (agent.provider === "gemini" || agent.provider === "grok") return { ...base, servers: [own], hidden: true };
    const status = this.#providers.find((item) => item.id === agent.provider);
    if (status && !status.available) return { ...base, servers: [own], error: `${providerLabel(agent.provider)} no está instalado en este equipo.` };
    try {
      // Codex recibe las herramientas de ClosedBot aparte (no como MCP): se suman a las suyas.
      if (agent.provider === "codex") return { ...base, servers: [own, ...(await this.#readCodexMcp())] };
      const client = await this.#getClient(agent.provider);
      const listing = await client.request<McpListing>("closedbot/mcp", params, MCP_TIMEOUT_MS);
      return { ...base, servers: Array.isArray(listing?.servers) ? listing.servers : [], hidden: listing?.hidden === true };
    } catch (error) {
      return { ...base, servers: [own], error: `No pude revisar sus MCP: ${errorText(error)}` };
    }
  }

  /** Los MCP de Codex son los de su configuración (los mismos para todos sus agentes). */
  async #readCodexMcp(): Promise<McpServerView[]> {
    const opened = !this.#clientReady.has("codex");
    if (opened) this.#usageOnly.add("codex");
    try {
      const client = await this.#getClient("codex", "usage");
      const servers: McpServerView[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 5; page += 1) {
        let response: unknown;
        try {
          response = await client.request<unknown>("mcpServerStatus/list", { cursor, limit: 100 }, MCP_TIMEOUT_MS);
        } catch (error) {
          // Los Codex más antiguos lo llamaban «mcpServers/list».
          const code = error instanceof AppServerError ? error.code : null;
          if (page > 0 || !(code === -32601 || code === -32600 || /unknown variant|method not found/i.test(errorText(error)))) throw error;
          response = await client.request<unknown>("mcpServers/list", {}, MCP_TIMEOUT_MS);
        }
        servers.push(...fromCodexStatus(response));
        cursor = getString(response, "nextCursor");
        if (!cursor) break;
      }
      return servers;
    } finally {
      if (opened && this.#usageOnly.has("codex")) await this.#releaseClient("codex");
      this.#usageOnly.delete("codex");
    }
  }

  async #withMcpSlot<T>(work: () => Promise<T>): Promise<T> {
    while (this.#mcpSlots === 0) await new Promise<void>((resolveSlot) => this.#mcpQueue.push(resolveSlot));
    this.#mcpSlots -= 1;
    try {
      return await work();
    } finally {
      this.#mcpSlots += 1;
      this.#mcpQueue.shift()?.();
    }
  }

  /** Lo que lee el agente de AGENTS.md pasa a la base (para la lista y para Claude Bot). */
  #syncInstructions(agent: AgentRecord): AgentRecord {
    const text = readInstructions(agent.workspace) ?? "";
    return text === agent.instructions ? agent : this.#store.updateAgent(agent.id, { instructions: text });
  }

  /** Al pasar a la 0.7.0: las instrucciones guardadas en la base pasan a AGENTS.md de cada agente (una sola vez). */
  #migrateInstructionFiles(): void {
    if (this.#store.getMeta(INSTRUCTIONS_FILES_META) === "1") return;
    for (const agent of this.#store.listAgents()) {
      try {
        mkdirSync(agent.workspace, { recursive: true });
        const text = migrateInstructions(agent.workspace, agent.instructions);
        if (text !== agent.instructions) this.#store.updateAgent(agent.id, { instructions: text });
      } catch (error) {
        this.#log("warn", `No pude pasar a AGENTS.md las instrucciones de «${agent.name}»: ${errorText(error)}`);
      }
    }
    this.#store.setMeta(INSTRUCTIONS_FILES_META, "1");
  }

  /** Las habilidades encendidas del agente, para sus instrucciones. */
  #activeSkills(agent: AgentRecord): SkillInfo[] {
    const off = new Set(agent.skillsOff);
    return listSkills(agent.workspace).filter((skill) => !off.has(skill.id));
  }

  #requireMemory(id: string): MemoryRecord {
    const memory = this.#store.getMemory(id);
    if (!memory) throw new ServiceError("Ese recuerdo ya no existe.", 404);
    return memory;
  }

  #emitMemories(agentId: string): void {
    this.#emit({ type: "memories", agentId, memories: this.#store.listMemories(agentId) });
  }

  #emitSkills(agentId: string): void {
    this.#emit({ type: "skills", agentId, skills: this.listSkills(agentId) });
  }

  // ---------- rutinas ----------

  /** Las últimas ejecuciones de una rutina, con lo que respondió el agente. */
  routineRuns(id: string): RoutineRun[] {
    this.#requireRoutine(id);
    return this.#store.listRoutineRuns(id, 10).map((run) => ({ ...run, reply: clip(run.reply, 600) }));
  }

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

  /** `usage`: solo para leer el uso del plan (no cuenta como que un agente empezó a usar el proceso). */
  async #getClient(provider: ProviderId, purpose: "work" | "usage" = "work"): Promise<AgentClient> {
    if (purpose === "work") this.#usageOnly.delete(provider);
    const existing = this.#clientReady.get(provider);
    if (existing) return existing;
    const ready = (async () => {
      const client = this.#options.createClient(provider);
      client.on("notification", (notification) => {
        if (notification.method === "account/rateLimits/updated") this.#usageUpdated(provider, notification.params);
        else this.#handleNotification(notification);
      });
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
          // Grok y Antigravity tardan más en arrancar (Antigravity descomprime unos 300 MB cada vez).
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
    for (const key of [...this.#loadedThreads.keys()]) if (key.startsWith(`${provider}:`)) this.#loadedThreads.delete(key);
    for (const [agentId, state] of [...this.#active]) {
      if (state.provider !== provider) continue;
      // Si se cerró porque le falta la sesión (Antigravity sin entrar), el aviso ya lo explica.
      this.#notice(agentId, error.name === "SignInRequiredError" ? error.message : `El proceso de ${providerLabel(provider)} se detuvo: ${error.message}`);
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
      developerInstructions: buildInstructions({ ...agent, access: this.#access(agent) }, this.#options.sharedDir, this.getSettings().userName, {
        main,
        memories: describeMemories(this.#store.listMemories(agent.id)),
        skills: this.#activeSkills(agent),
      }),
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
      const params = this.#threadParams(agent, false);
      // Si cambió lo que sabe (instrucciones, recuerdos, habilidades…), se reabre para que lo use desde este mensaje.
      const print = paramsPrint(params);
      if (this.#loadedThreads.get(key) === print) return agent.threadId;
      try {
        await client.request("thread/resume", { threadId: agent.threadId, ...params });
        this.#loadedThreads.set(key, print);
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
    // Sesión nueva: su gasto empieza en cero (de una reanudada solo se cuenta lo que sume desde la lectura anterior).
    this.#seedTokenReading(agent.provider, threadId);
    // La huella es la de reanudar (Codex no repite ahí las herramientas): así el próximo mensaje no lo reabre por nada.
    this.#loadedThreads.set(`${agent.provider}:${threadId}`, paramsPrint(this.#threadParams(agent, false)));
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
    if (this.#stopping || this.#draining.has(agentId) || this.#active.has(agentId) || this.#deleting.has(agentId)) return;
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
      createdChannels: 0,
      channelId: delivery.channelId,
      steps: delivery.steps,
      images: [],
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
    let known: { note: string | null; saved: string; previous: string | null } | null = null;
    try {
      const client = await this.#getClient(agent.provider);
      if (this.#stopping || this.#active.get(agent.id) !== state) return;
      // Lo que tenga ahora su AGENTS.md (el usuario o el propio agente pudieron cambiarlo).
      const fresh = this.#syncInstructions(this.#requireAgent(agent.id));
      const threadId = await this.#ensureThread(fresh, client);
      if (this.#stopping || this.#active.get(agent.id) !== state) return;
      state.threadId = threadId;
      const sender = delivery.senderAgentId ? this.#store.getAgent(delivery.senderAgentId) : null;
      const original = delivery.replyTo ? this.#store.getMessage(delivery.replyTo) : null;
      // Un encargo nuevo (del usuario o de Claude Bot) después de terminar el anterior: la barra vuelve a cero.
      if (!delivery.replyTo && (!sender || this.#isMain(sender)) && (this.#progressMap().get(agent.id)?.percent ?? 0) >= 100) {
        this.#setProgress(agent.id, null);
        // Si es el encargado del canal donde llegó, el equipo también empieza un trabajo nuevo.
        if (channel && channel.leadId === agent.id) this.#restartTeamProgress(channel);
      }
      // Lo que le escribe Claude Bot a un agente lleva la pizarra del trabajo.
      const board = sender && this.#isMain(sender) && !this.#isMain(fresh) ? boardSection(this.#board(), sender.name) : null;
      const body = composeDeliveryInput(delivery, sender ? { id: sender.id, name: sender.name } : null, original?.text ?? null, board);
      let text = channel ? this.#channelInput(channel, fresh, delivery, body) : body;
      if (this.#isMain(fresh)) {
        // Antes de cada mensaje, el bot principal se entera de lo que cambió el usuario en agentes y canales.
        known = this.#teamNote(threadId);
        if (known.note) text = `${known.note}\n\n${text}`;
        // Se guarda antes de empezar: lo que haga el propio bot en este turno se suma a lo que ya sabe.
        this.#store.setMeta(MAIN_KNOWN_META, known.saved);
      }
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
      // No alcanzó a leer la nota: se le cuenta en el próximo mensaje.
      if (known && this.#store.getMeta(MAIN_KNOWN_META) === known.saved) this.#store.setMeta(MAIN_KNOWN_META, known.previous ?? "");
      if (this.#stopping || this.#active.get(agent.id) !== state) return;
      this.#active.delete(agent.id);
      this.#store.updateDelivery(delivery.id, { status: "failed", error: errorText(error), finishedAt: Date.now() });
      this.#updateMessageStatus(agent.id, delivery.messageId, "failed");
      this.#notice(agent.id, `No se pudo entregar el mensaje${channel ? ` a ${agent.name}` : ""}: ${errorText(error)}`, delivery.channelId);
      this.#alert(agent.id, "error", `No pudo empezar: ${errorText(error)}`, delivery.channelId);
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
    // Pudo editar su AGENTS.md en este turno: la lista y Claude Bot ven lo nuevo.
    const record = this.#store.getAgent(agentId);
    if (record) this.#syncInstructions(record);
    // «Avisarme»: la pregunta ya avisó al hacerse; aquí, lo que respondió o que no pudo terminar.
    if (terminal === "failed") this.#alert(agentId, "error", "No pudo terminar. Abre la conversación para ver qué pasó.", state.channelId);
    else if (terminal === "completed" && !state.askedQuestion && state.lastAssistantText.trim()) {
      this.#alert(agentId, "reply", state.lastAssistantText, state.channelId);
    }
    for (const messageId of state.assistantMessageIds) {
      const message = this.#store.getMessage(messageId);
      if (message?.status === "streaming") this.#updateMessageStatus(agentId, messageId, terminal);
    }
    if (terminal === "failed") this.#failedTurns.add(agentId);
    else this.#failedTurns.delete(agentId);
    this.#emit({ type: "turn", agentId, status: terminal });
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
      (state.lastAssistantText.trim() || state.images.some((image) => !image.sent))
    ) {
      // El compañero no contestó con send_message: le hacemos llegar su resultado igual, con las imágenes
      // que generó. En un canal su respuesta ya se ve, así que no se repite como aviso (y si el canal se
      // eliminó, no sigue).
      try {
        if (!delivery.channelId || (channel && !channel.deletedAt)) {
          const images = state.images.filter((image) => !image.sent);
          this.#sendTeammateMessage({
            fromAgentId: agentId,
            to: [delivery.senderAgentId],
            text: withImages(state.lastAssistantText, images),
            replyTo: delivery.messageId,
            hops: delivery.hops + 1,
            steps: delivery.steps,
            idempotencyKey: `auto:${delivery.id}`,
            channelId: delivery.channelId,
            quiet: Boolean(delivery.channelId),
            images,
          });
          for (const image of images) image.sent = true;
        }
      } catch (error) {
        this.#notice(agentId, `No se pudo devolver el resultado al remitente: ${errorText(error)}`, delivery.channelId);
      }
    }
    this.#scheduleDrain(agentId);
  }

  // ---------- la Oficina ----------

  /** Lo que la Oficina necesita al abrirse; de paso, baja el arte en alta resolución si falta. */
  officeSnapshot(): OfficeSnapshot {
    this.#studio.ensureArt();
    const activity: Record<string, { text: string; at: number }> = {};
    for (const item of this.#store.latestActivities(Date.now() - 30 * 60_000)) activity[item.agentId] = { text: item.text, at: item.at };
    return {
      board: this.#board(),
      images: this.#store.recentImages(40),
      activity,
      asking: this.#store.agentsAsking(),
      failed: [...this.#failedTurns],
      art: this.#officeArt(),
      pixelLab: this.pixelLabStatus(),
    };
  }

  /** Baja el arte en alta resolución en segundo plano al arrancar, sin esperar a que se abra la Oficina. */
  prefetchOfficeArt(): void {
    this.#studio.ensureArt();
  }

  pixelLabStatus(): PixelLabStatus {
    const agents = this.#store.listAgents();
    return {
      configured: Boolean(this.#pixelLabToken()),
      missing: agents.filter((agent) => agent.character?.status !== "ready" && !this.#studio.pending(agent.id)).length,
      drawing: agents.filter((agent) => this.#studio.pending(agent.id)).map((agent) => agent.id),
    };
  }

  /** Guarda el token de PixelLab (antes comprueba que PixelLab lo acepte) o, con null, lo quita. */
  async setPixelLabToken(token: string | null): Promise<PixelLabStatus> {
    const value = token?.trim() ?? "";
    if (!value) {
      this.#store.setMeta(PIXELLAB_TOKEN_META, "");
      return this.pixelLabStatus();
    }
    if (value.length > 400 || /\s/.test(value)) throw new ServiceError("Eso no parece un token de PixelLab.", 400);
    try {
      await this.#studio.client(value)?.balance();
    } catch (error) {
      if (error instanceof PixelLabError && (error.status === 401 || error.status === 403)) {
        throw new ServiceError("PixelLab no aceptó ese token. Cópialo de nuevo desde tu cuenta de PixelLab.", 400);
      }
      throw new ServiceError(error instanceof Error ? error.message : "No se pudo conectar con PixelLab.", 502);
    }
    this.#store.setMeta(PIXELLAB_TOKEN_META, value);
    return this.pixelLabStatus();
  }

  /** Pide a PixelLab los personajes que faltan o, con `ids`, los de esos agentes (aunque ya tengan uno). */
  drawCharacters(ids?: string[]): number {
    if (!this.#pixelLabToken()) throw new ServiceError("Conecta PixelLab en Ajustes para dibujar los personajes.", 409);
    const agents = ids?.length ? ids.map((id) => this.#requireAgent(id)) : this.#store.listAgents().filter((agent) => agent.character?.status !== "ready");
    let count = 0;
    for (const agent of agents) if (!this.#studio.pending(agent.id) && this.#requestCharacter(agent)) count += 1;
    if (count) this.#emitAgents();
    return count;
  }

  characterManifest(id: string): CharacterManifest {
    this.#requireAgent(id);
    const manifest = this.#studio.manifest(id);
    if (!manifest) throw new ServiceError("Este agente aún no tiene personaje de PixelLab.", 404);
    return manifest;
  }

  characterFile(id: string, name: string): string {
    this.#requireAgent(id);
    const path = this.#studio.file(id, name);
    if (!path) throw new ServiceError("No encontrado.", 404);
    return path;
  }

  /** El arte original de una pieza de la Oficina, o null si aún no se descargó (se usa el que trae la app). */
  officeArtFile(name: string): string | null {
    return this.#studio.artFile(name);
  }

  #officeArt(): OfficeArtView {
    const hd = this.#studio.artReady();
    return { hd, version: hd ? this.#studio.artVersion() : 0 };
  }

  #pixelLabToken(): string | null {
    const value = this.#store.getMeta(PIXELLAB_TOKEN_META);
    return value?.trim() ? value.trim() : null;
  }

  /** Encola el personaje de un agente si PixelLab está conectado y lo deja «dibujándose». */
  #requestCharacter(agent: AgentRecord): boolean {
    if (!this.#studio.request({ id: agent.id, name: agent.name, role: agent.role, appearance: agent.appearance })) return false;
    this.#store.updateAgent(agent.id, { character: { status: "drawing", version: agent.character?.version ?? 0, error: null, updatedAt: Date.now() } });
    return true;
  }

  #characterChanged(agentId: string, change: { status: CharacterState["status"]; error: string | null; version?: number; quiet?: boolean }): void {
    const agent = this.#store.getAgent(agentId);
    if (!agent) {
      // Se eliminó mientras PixelLab lo dibujaba: no quedan sus cuadros.
      if (change.status !== "drawing") this.#studio.forget(agentId);
      return;
    }
    // Si quedó otro dibujo en cola (cambió el aspecto mientras tanto), sigue «dibujándose».
    const status = change.status !== "drawing" && this.#studio.pending(agentId) ? "drawing" : change.status;
    this.#store.updateAgent(agentId, {
      character: { status, version: change.version ?? agent.character?.version ?? 0, error: change.error, updatedAt: Date.now() },
    });
    if (change.status === "failed" && change.error && !change.quiet) this.#emit({ type: "notice", level: "error", message: `Personaje de ${agent.name}: ${change.error}` });
    this.#emitAgents();
  }

  // ---------- internos: eventos del proveedor ----------

  #handleNotification(notification: AppServerNotification): void {
    if (this.#stopping) return;
    const params = notification.params;
    const threadId = getString(params, "threadId");
    const agentId = threadId ? this.#threadToAgent.get(threadId) : undefined;
    switch (notification.method) {
      case "closedbot/tokenUsage": {
        // Claude (y la demo): lo acumulado en la sesión por modelo, con su costo; y lo de este turno, por si no sirve.
        if (agentId && threadId) this.#countTokens(agentId, threadId, parseReading(getRecord(params, "reading")), parseTurnUsage(getRecord(params, "turn")));
        return;
      }
      case "thread/tokenUsage/updated": {
        // Codex: el total del hilo (su entrada incluye lo leído de caché); el modelo es el del agente.
        const total = getRecord(getRecord(params, "tokenUsage"), "total");
        const agent = agentId ? this.#store.getAgent(agentId) : null;
        if (!agent || !threadId || !total) return;
        // La entrada de OpenAI incluye lo leído de caché; lo escrito en caché (modelos nuevos) va dentro salvo que el total diga otra cosa.
        const input = tokenNumber(total.inputTokens);
        const cached = tokenNumber(total.cachedInputTokens);
        const written = tokenNumber(total.cacheWriteInputTokens);
        const output = tokenNumber(total.outputTokens);
        const writtenApart = written > 0 && tokenNumber(total.totalTokens) >= input + output + written;
        const reading: Reading = {
          [this.#modelId(agent.provider, agent.model)]: {
            input: Math.max(0, input - cached - (writtenApart ? 0 : written)),
            cacheRead: cached,
            cacheWrite: written,
            output,
            costUsd: null,
          },
        };
        this.#countTokens(agent.id, threadId, reading, null);
        return;
      }
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
        if (type === "imageGeneration") {
          this.#imageGenerated(agentId, item, getString(params, "turnId"));
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
        ...(agent.description ? { descripcion: clip(agent.description, 300) } : {}),
        proyecto: agent.project || null,
        proveedor: agent.provider,
        estado: agentStateLabel(agent.state),
        ...(agent.progress ? { avance: `${agent.progress.percent} %${agent.progress.step ? ` · ${agent.progress.step}` : ""}` } : {}),
        eresTu: agent.id === senderId,
        ...(agent.main ? { botPrincipal: true } : {}),
        ...(forMain ? { modelo: this.#modelName(agent.provider, agent.model), instrucciones: clip(agent.instructions, 400) } : {}),
      }));
      // Al bot principal le sirve saber con qué proveedores puede crear agentes ahora mismo.
      const ready = forMain
        ? this.#providers.filter((status) => status.id !== "demo" && status.available && status.loggedIn !== false).map((status) => status.id)
        : null;
      // Y los canales que ya existen, para no crear dos para el mismo equipo.
      const channels = forMain
        ? this.listChannels().map((channel) => {
            const names = this.#channelNames(channel);
            return { nombre: channel.name, encargado: names.lead, miembros: names.members };
          })
        : null;
      // Cuánto plan le queda a cada cuenta y la pizarra: para repartir sin agotar una cuenta.
      const usage = forMain ? this.#usageForMain() : null;
      const board = forMain ? this.#board() : "";
      return toolResult({
        agentes: agents,
        ...(ready ? { proveedoresListos: ready } : {}),
        ...(usage && usage.length ? { usoDelPlan: usage } : {}),
        ...(channels ? { canales: channels } : {}),
        ...(board ? { pizarra: board } : {}),
      });
    }
    if (params.tool === TOOL_READ_AGENT || params.tool === TOOL_UPDATE_BOARD) {
      if (senderId !== this.#mainAgentId) {
        throw new Error("Solo el bot principal puede leer fichas y llevar la pizarra. Si hace falta, pídeselo a él con send_message.");
      }
      if (params.tool === TOOL_READ_AGENT) return this.#readAgent(parseReadAgentArgs(params.arguments));
      return this.#updateBoard(senderId, parseUpdateBoardArgs(params.arguments).text, params.turnId);
    }
    if (params.tool === RETIRED_ROUND_TOOL) {
      // Un hilo de Codex de la 0.8.0 todavía la tiene: Codex fija sus herramientas al crear el hilo.
      throw new Error("Las rondas ya no existen: decide tú quién hace cada parte y encárgasela con send_message.");
    }
    if (params.tool === TOOL_CREATE_AGENT || params.tool === TOOL_UPDATE_AGENT || params.tool === TOOL_DELETE_AGENTS || params.tool === TOOL_CREATE_CHANNEL) {
      if (senderId !== this.#mainAgentId) {
        throw new Error("Solo el bot principal puede crear, cambiar o eliminar agentes y crear canales. Si hace falta, pídeselo al usuario.");
      }
      if (params.tool === TOOL_CREATE_CHANNEL) return this.#createChannelFromMain(senderId, parseCreateChannelArgs(params.arguments), params.turnId);
      if (params.tool === TOOL_DELETE_AGENTS) return this.#deleteAgentsFromMain(senderId, parseDeleteAgentsArgs(params.arguments).agents, params.turnId);
      return params.tool === TOOL_CREATE_AGENT
        ? this.#createAgentFromMain(senderId, parseCreateAgentArgs(params.arguments), params.turnId)
        : this.#updateAgentFromMain(senderId, parseUpdateAgentArgs(params.arguments), params.turnId);
    }
    if (params.tool === TOOL_ASK_USER) return this.#askUser(senderId, parseAskUserArgs(params.arguments), params.turnId);
    if (params.tool === TOOL_REMEMBER || params.tool === TOOL_FORGET_MEMORY || params.tool === TOOL_SEARCH_MEMORIES) return this.#memoryTool(senderId, params);
    if (params.tool === TOOL_LIST_MEMORIES || params.tool === TOOL_SET_MEMORY_INCLUSION) return this.#memoryTool(senderId, params);
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
    if (params.tool === TOOL_REPORT_PROGRESS) {
      const { percent, step } = parseReportProgressArgs(params.arguments);
      this.#setProgress(senderId, { percent, step, at: Date.now() });
      return toolResult({ guardado: true, avance: `${percent} %` });
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
    // Claude Bot decide cada paso: cuando él escribe, la cuenta de reenvíos entre agentes vuelve a empezar y
    // lo que se limita es cuántos encargos seguidos hace en un mismo pedido.
    const main = senderId === this.#mainAgentId;
    // Las imágenes que generó en este turno van con el mensaje (con su ruta en la carpeta compartida).
    const images = state ? state.images.filter((image) => !image.sent) : [];
    const receipt = this.#sendTeammateMessage({
      fromAgentId: senderId,
      to: args.to,
      text: withImages(args.text, images),
      replyTo: args.replyToMessageId,
      hops: main ? 1 : (state?.hops ?? 0) + 1,
      steps: (state?.steps ?? 0) + (main ? 1 : 0),
      idempotencyKey: `${params.threadId}:${params.turnId}:${params.callId}`,
      channelId: state?.channelId ?? null,
      images,
    });
    for (const recipient of receipt.recipients) state?.sentTo.add(recipient.id);
    for (const image of images) image.sent = true;
    if (main && state) state.steps += 1;
    return toolResult(receipt);
  }

  /** Herramientas de recuerdos: cada agente solo ve y toca los suyos. */
  #memoryTool(agentId: string, params: DynamicToolCallParams): DynamicToolResult {
    const view = (memory: MemoryRecord) => ({ id: memory.id, texto: memory.text, siempre: memory.always });
    const own = (id: string): MemoryRecord => {
      const memory = this.#store.getMemory(id);
      if (!memory || memory.agentId !== agentId) throw new Error("No tienes un recuerdo con ese id; míralos con list_memories.");
      return memory;
    };
    switch (params.tool) {
      case TOOL_REMEMBER: {
        const args = parseRememberArgs(params.arguments);
        const before = this.#store.countMemories(agentId);
        let memory: MemoryRecord;
        try {
          memory = this.createMemory(agentId, args, "agent");
        } catch (error) {
          throw new Error(errorText(error));
        }
        const fresh = this.#store.countMemories(agentId) > before;
        if (fresh) this.#activity(agentId, `Guardó un recuerdo: «${clip(memory.text, 120)}»`, params.turnId, { kind: "memory-saved", memoryId: memory.id });
        return toolResult({
          guardado: true,
          ...(fresh ? {} : { nota: "Ya lo tenías guardado." }),
          ...view(memory),
          ...(memory.always ? { cuando: "Desde tu próximo mensaje va en tus instrucciones." } : {}),
        });
      }
      case TOOL_FORGET_MEMORY: {
        const memory = own(parseMemoryIdArgs(params.arguments).id);
        this.deleteMemory(memory.id);
        this.#activity(agentId, `Olvidó un recuerdo: «${clip(memory.text, 120)}»`, params.turnId, { kind: "memory-deleted" });
        return toolResult({ borrado: true, texto: memory.text });
      }
      case TOOL_SEARCH_MEMORIES: {
        const { query } = parseSearchMemoriesArgs(params.arguments);
        const found = searchMemories(this.#store.listMemories(agentId), query);
        return toolResult(found.length ? { recuerdos: found.map(view) } : { recuerdos: [], nota: "No encontré recuerdos sobre eso." });
      }
      case TOOL_LIST_MEMORIES: {
        const memories = this.#store.listMemories(agentId);
        return toolResult({ recuerdos: memories.map(view), total: memories.length, maximo: MEMORY_LIMITS.perAgent });
      }
      case TOOL_SET_MEMORY_INCLUSION: {
        const args = parseMemoryInclusionArgs(params.arguments);
        const memory = own(args.id);
        const updated = memory.always === args.always ? memory : this.updateMemory(memory.id, { always: args.always });
        return toolResult({ actualizado: true, ...view(updated) });
      }
      default:
        throw new Error(`Herramienta desconocida: ${params.tool}`);
    }
  }

  /** Una línea de actividad en la conversación del agente (y en su canal, si trabaja para uno). */
  #activity(agentId: string, text: string, turnId: string | null, payload: Record<string, unknown>): void {
    const message = this.#store.insertMessage({
      agentId,
      role: "activity",
      text,
      status: "completed",
      turnId,
      payload,
      channelId: this.#active.get(agentId)?.channelId ?? null,
    });
    this.#emit({ type: "message", agentId, message });
  }

  #askUser(agentId: string, args: AskUserArgs, turnId: string | null): DynamicToolResult {
    const message = this.#postDecision(agentId, args, turnId);
    return toolResult({
      preguntado: true,
      messageId: message.id,
      nota: "La tarjeta ya está en la conversación. Termina tu turno ahora: la respuesta del usuario te llegará como un mensaje nuevo.",
    });
  }

  /** Deja una tarjeta de decisión en la conversación del agente (y en su canal, si trabaja para uno) y avisa al usuario. */
  #postDecision(agentId: string, args: AskUserArgs, turnId: string | null, extra: Record<string, unknown> = {}): MessageRecord {
    const message = this.#store.insertMessage({
      agentId,
      role: "decision",
      text: args.question,
      status: "completed",
      turnId,
      payload: { ...extra, options: args.options, recommended: args.recommended, answer: null, answeredAt: null },
      channelId: this.#active.get(agentId)?.channelId ?? null,
    });
    const state = this.#active.get(agentId);
    if (state) state.askedQuestion = args.question;
    else this.#store.updateAgent(agentId, { preview: `Pregunta: ${args.question}`.slice(0, 240) });
    this.#emit({ type: "message", agentId, message });
    this.#alert(agentId, "question", args.question, message.channelId);
    this.#emitAgents();
    if (message.channelId) this.#emitChannels();
    return message;
  }

  /**
   * delete_agents del bot principal: no elimina nada todavía. Deja una tarjeta para que el usuario lo confirme
   * con un toque; al tocar «Eliminar», ClosedBot los elimina (ver #answerDeleteAgents).
   */
  #deleteAgentsFromMain(mainId: string, refs: string[], turnId: string | null): DynamicToolResult {
    const targets = [...new Map(refs.map((ref) => {
      const agent = this.#resolveAgentRef(ref);
      return [agent.id, agent] as const;
    })).values()];
    if (targets.some((agent) => agent.id === mainId)) {
      throw new Error("No puedes eliminarte a ti mismo. Quítate de la lista y vuelve a llamarla con los demás.");
    }
    const names = targets.map((agent) => `«${agent.name}»`);
    const doomed = new Set(targets.map((agent) => agent.id));
    const emptied = this.#store.listChannels().filter((channel) => channel.memberIds.length > 0 && channel.memberIds.every((id) => doomed.has(id)));
    const one = targets.length === 1;
    const effects = [
      one ? "Se borra con su historial, su cola y sus rutinas; sus archivos quedan en su carpeta." : "Se borran con su historial, su cola y sus rutinas; sus archivos quedan en sus carpetas.",
      emptied.length === 1
        ? `El canal «${emptied[0]?.name}» pasa a «Canales eliminados».`
        : emptied.length
          ? `Los canales ${joinNames(emptied.map((channel) => `«${channel.name}»`))} pasan a «Canales eliminados».`
          : "",
    ].filter(Boolean);
    const question = targets.length <= 8 ? `¿Eliminar a ${joinNames(names)}?` : `¿Eliminar ${targets.length} agentes: ${names.slice(0, 7).join(", ")} y ${targets.length - 7} más?`;
    const message = this.#postDecision(
      mainId,
      {
        question,
        options: [
          { label: "Eliminar", detail: effects.join(" ") },
          { label: "Cancelar", detail: "No se elimina a nadie." },
        ],
        recommended: null,
      },
      turnId,
      { kind: DELETE_AGENTS_CARD, agentIds: targets.map((agent) => agent.id), names: targets.map((agent) => agent.name) },
    );
    return toolResult({
      tarjeta: true,
      messageId: message.id,
      agentes: targets.map((agent) => agent.name),
      nota: "El usuario ya tiene la tarjeta para confirmar: cuando toque «Eliminar», ClosedBot los elimina y te llega un mensaje con el resultado. Termina tu turno ahora sin volver a preguntárselo; si quieres, dile en una línea qué vas a eliminar.",
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
      throw new Error(`Ya hay ${MAX_AGENTS} agentes, el máximo que puedes crear. Pregúntale al usuario cuáles eliminar; si te lo pide, elimínalos con delete_agents.`);
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
        description: args.description,
        instructions: args.instructions,
        provider,
        model: args.model,
        project: args.project,
        appearance: args.appearance,
      });
    } catch (error) {
      if (error instanceof ServiceError && error.status === 409) {
        throw new Error(`${error.message} Elige otro nombre, o ajusta ese agente con update_agent.`);
      }
      throw error;
    }
    if (state) state.createdAgents += 1;
    const record = this.#store.getAgent(agent.id);
    if (record) {
      this.#absorbKnown((known) => {
        known.agents[record.id] = snapshotAgent(record);
      });
    }
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
      modelo: this.#modelName(agent.provider, agent.model),
    });
  }

  /** create_channel del bot principal: crea el canal (normalmente, el de un equipo) y lo deja anotado en su conversación. */
  #createChannelFromMain(mainId: string, args: CreateChannelArgs, turnId: string | null): DynamicToolResult {
    const state = this.#active.get(mainId);
    if (state && state.createdChannels >= MAX_CHANNELS_PER_TURN) {
      throw new Error(`Ya creaste ${MAX_CHANNELS_PER_TURN} canales en este turno, el máximo por pedido.`);
    }
    const members = args.members.map((ref) => this.#resolveAgentRef(ref));
    if (members.some((agent) => agent.id === mainId)) {
      throw new Error("No te incluyas en el canal: es para el equipo. Quítate de members y vuelve a crearlo.");
    }
    const memberIds = [...new Set(members.map((agent) => agent.id))];
    const lead = args.lead ? this.#resolveAgentRef(args.lead) : null;
    if (lead && !memberIds.includes(lead.id)) {
      throw new Error(`${lead.name} no está entre los miembros: agrégalo o elige otro encargado.`);
    }
    let channel: ChannelView;
    try {
      channel = this.createChannel({ name: args.name, topic: args.topic, memberIds, leadId: lead?.id ?? null });
    } catch (error) {
      if (error instanceof ServiceError && error.status === 409 && this.#store.findChannelByName(args.name.trim())) {
        throw new Error(`${error.message} Si es el de este equipo, no hace falta otro: díselo al usuario.`);
      }
      throw new Error(errorText(error));
    }
    if (state) state.createdChannels += 1;
    const record = this.#store.getChannel(channel.id);
    if (record) {
      this.#absorbKnown((known) => {
        known.channels[record.id] = snapshotChannel(record);
      });
    }
    const names = this.#channelNames(channel);
    const activity = this.#store.insertMessage({
      agentId: mainId,
      role: "activity",
      text: `Creó el canal «${channel.name}» · ${names.members.join(", ")}`,
      status: "completed",
      turnId,
      payload: { kind: "channel-created", channelId: channel.id, members: names.members },
    });
    this.#emit({ type: "message", agentId: mainId, message: activity });
    return toolResult({ creado: true, id: channel.id, nombre: channel.name, encargado: names.lead, miembros: names.members });
  }

  /** Nombres del encargado y de los miembros de un canal. */
  #channelNames(channel: ChannelRecord): { lead: string | null; members: string[] } {
    const members = channel.memberIds.map((id) => this.#store.getAgent(id)).filter((item): item is AgentRecord => item !== null);
    return { lead: members.find((member) => member.id === channel.leadId)?.name ?? null, members: members.map((member) => member.name) };
  }

  /** update_agent del bot principal: cambia solo lo indicado y lo deja marcado en ambas conversaciones. */
  #updateAgentFromMain(mainId: string, args: UpdateAgentArgs, turnId: string | null): DynamicToolResult {
    const main = this.#requireAgent(mainId);
    const target = this.#syncInstructions(this.#resolveAgentRef(args.agent));
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
    if (args.description !== undefined && args.description !== target.description) {
      patch.description = args.description;
      changes.push("descripción");
    }
    if (args.instructions !== undefined && cleanInstructions(args.instructions) !== target.instructions) {
      patch.instructions = args.instructions;
      changes.push("instrucciones");
    }
    if (args.project !== undefined && args.project !== target.project) {
      patch.project = args.project;
      changes.push("proyecto");
    }
    if (args.appearance !== undefined && args.appearance !== target.appearance) {
      patch.appearance = args.appearance;
      changes.push("aspecto");
    }
    if (args.provider !== undefined && args.provider !== target.provider) {
      // Por ejemplo, para que haga imágenes (Claude no las genera): con otro proveedor empieza una conversación
      // nueva, con sus mismas instrucciones y recuerdos.
      const status = this.#providers.find((item) => item.id === args.provider);
      if (status && !status.available) throw new Error(`${providerLabel(args.provider)} no está disponible en este equipo: elige otro de proveedoresListos.`);
      if (status?.loggedIn === false) {
        throw new Error(`${providerLabel(args.provider)} no tiene la sesión iniciada (el usuario puede entrar en Ajustes): elige otro de proveedoresListos.`);
      }
      if (this.#active.has(target.id)) throw new Error(`${target.name} está trabajando: cámbiale el proveedor cuando termine su turno.`);
      patch.provider = args.provider;
      changes.push("proveedor");
    }
    // El modelo es de cada proveedor: si cambia el proveedor y no se indica, vuelve al predeterminado.
    if (args.model !== undefined && (args.model !== target.model || patch.provider !== undefined)) {
      patch.model = args.model;
      if (args.model !== target.model) changes.push("modelo");
    }
    if (!changes.length) return toolResult({ actualizado: false, nota: "No había nada distinto que cambiar." });
    let updated: AgentView;
    try {
      updated = this.updateAgent(target.id, patch, { by: main.name });
    } catch (error) {
      throw new Error(errorText(error));
    }
    const record = this.#store.getAgent(updated.id);
    if (record) {
      this.#absorbKnown((known) => {
        known.agents[record.id] = snapshotAgent(record);
      });
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
    return toolResult({
      actualizado: true,
      id: updated.id,
      nombre: updated.name,
      proyecto: updated.project || null,
      proveedor: updated.provider,
      modelo: this.#modelName(updated.provider, updated.model),
      cambios: changes,
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
    /** Canal donde ocurre: el encargo y lo que responda el compañero se ven allí. */
    channelId?: string | null;
    /** Sin el aviso «Enviado a…» (cuando el texto ya se ve en el canal). */
    quiet?: boolean;
    /** Encargos de Claude Bot en esta cadena (las respuestas lo heredan). */
    steps?: number;
    /** Imágenes que generó el remitente en su turno: se ven en el chat de quien las recibe. */
    images?: ReadonlyArray<Pick<SavedImage, "relativePath">>;
  }): { enviado: true; recipients: Array<{ id: string; name: string; messageId: string }> } {
    const sender = this.#requireAgent(input.fromAgentId);
    const steps = input.steps ?? 0;
    const maxSteps = this.#options.mainMaxSteps ?? MAIN_MAX_STEPS;
    if (steps > maxSteps) {
      throw new Error(
        `Ya hiciste ${maxSteps} encargos seguidos en este pedido, el máximo. Cuéntale al usuario cómo va el trabajo y qué falta; si te pide seguir, sigues.`,
      );
    }
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
          payload: input.images?.length ? { images: input.images.map((image) => image.relativePath) } : null,
        });
        const { delivery } = this.#store.enqueueDelivery({
          agentId: recipient.id,
          messageId: message.id,
          senderKind: "agent",
          senderAgentId: sender.id,
          text: input.text,
          replyTo: input.replyTo,
          hops: input.hops,
          steps,
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

  // ---------- Claude Bot: fichas y pizarra ----------

  /** La pizarra del trabajo (vacía si no hay). */
  #board(): string {
    return this.#store.getMeta(BOARD_META) ?? "";
  }

  /** update_board: reemplaza la pizarra y lo deja a la vista en el chat de Claude Bot. */
  #updateBoard(mainId: string, text: string, turnId: string | null): DynamicToolResult {
    if (text === this.#board().trim()) return toolResult({ guardada: true, sinCambios: true });
    this.#store.setMeta(BOARD_META, text);
    this.#activity(mainId, text ? "Actualizó la pizarra" : "Borró la pizarra", turnId, { kind: "board-updated", board: text });
    return toolResult({
      guardada: true,
      caracteres: text.length,
      nota: text ? "Los agentes la recibirán cuando les escribas." : "La pizarra quedó vacía.",
    });
  }

  /** Uso del plan de cada cuenta, en pocas palabras (para list_agents de Claude Bot). */
  #usageForMain(): Array<Record<string, unknown>> {
    return this.usage().map((entry) => ({
      proveedor: entry.label,
      ...(entry.plan ? { plan: entry.plan } : {}),
      ventanas: entry.windows.map((window) => ({
        nombre: window.label,
        usado: `${Math.round(window.percent)} %`,
        ...(window.resetsAt ? { seReinicia: formatWhen(window.resetsAt) } : {}),
      })),
      leido: formatWhen(entry.updatedAt),
      ...(entry.error ? { error: entry.error } : {}),
    }));
  }

  /** read_agent: la ficha completa de un agente, para que Claude Bot sepa qué sabe y en qué anda. */
  #readAgent(args: { agent: string }): DynamicToolResult {
    const agent = this.#syncInstructions(this.#resolveAgentRef(args.agent));
    const view = this.#view(agent);
    const memories: Array<{ texto: string; siempre: boolean }> = [];
    let used = 0;
    let hidden = 0;
    // Primero los que siempre usa; después, los más nuevos.
    const sorted = [...this.#store.listMemories(agent.id)].sort((a, b) => Number(b.always) - Number(a.always) || b.updatedAt - a.updatedAt);
    for (const memory of sorted) {
      if (used + memory.text.length > READ_AGENT_LIMITS.memories) {
        hidden += 1;
        continue;
      }
      memories.push({ texto: memory.text, siempre: memory.always });
      used += memory.text.length;
    }
    const nameOf = (id: string | null) => (id ? (this.#store.getAgent(id)?.name ?? "un agente eliminado") : "alguien");
    const recent = this.#store
      .listMessages(agent.id, 40)
      .filter((message) => (message.role === "user" || message.role === "assistant" || message.role === "teammate") && message.text.trim())
      .slice(-READ_AGENT_LIMITS.recent)
      .map((message) => ({
        de: message.role === "user" ? "Usuario" : message.role === "assistant" ? agent.name : `${nameOf(message.fromAgentId)} (compañero)`,
        cuando: formatWhen(message.createdAt),
        texto: clip(message.text.replace(/\s+/g, " ").trim(), READ_AGENT_LIMITS.message),
      }));
    const channels = this.listChannels()
      .filter((channel) => channel.memberIds.includes(agent.id))
      .map((channel) => `${channel.name}${channel.leadId === agent.id ? " (encargado)" : ""}`);
    return toolResult({
      id: agent.id,
      nombre: agent.name,
      titulo: agent.role || (view.main ? "Bot principal" : "Asistente general"),
      ...(agent.description ? { descripcion: agent.description } : {}),
      ...(agent.appearance ? { aspecto: agent.appearance } : {}),
      proyecto: agent.project || null,
      proveedor: providerLabel(agent.provider),
      modelo: this.#modelName(agent.provider, agent.model),
      razonamiento: agent.effort ?? "predeterminado",
      estado: agentStateLabel(view.state),
      enCola: view.queued,
      ...(view.main ? { botPrincipal: true } : {}),
      instrucciones: agent.instructions.trim() ? clip(agent.instructions.trim(), READ_AGENT_LIMITS.instructions) : "(sin instrucciones)",
      recuerdos: memories,
      ...(hidden ? { recuerdosSinMostrar: hidden } : {}),
      habilidades: this.#activeSkills(agent).map((skill) => ({ nombre: skill.name, ...(skill.description ? { descripcion: skill.description } : {}) })),
      rutinas: this.#store.listRoutines(agent.id).map((routine) => ({ nombre: routine.name, horario: describeSchedule(routine.schedule), activa: routine.enabled })),
      canales: channels,
      loUltimo: recent,
    });
  }

  // ---------- imágenes que genera un agente ----------

  /**
   * Codex generó una imagen: se copia a la carpeta compartida (imagenes/<agente>/), se ve en su chat y va con lo
   * que le responda a quien se la pidió.
   */
  #imageGenerated(agentId: string, item: Record<string, unknown>, turnId: string | null): void {
    const agent = this.#store.getAgent(agentId);
    const state = this.#active.get(agentId);
    const failed = getString(item, "status") === "failed";
    let saved: SavedImage | null = null;
    if (agent && !failed) {
      try {
        saved = saveGeneratedImage({
          sharedDir: this.#options.sharedDir,
          folder: slugify(agent.name) || "agente",
          savedPath: getString(item, "savedPath") ?? getString(item, "saved_path"),
          result: getString(item, "result"),
        });
      } catch (error) {
        this.#log("warn", `No se pudo copiar la imagen de ${agent.name} a la carpeta compartida: ${errorText(error)}`);
      }
    }
    if (saved && state) state.images.push({ ...saved, sent: false });
    const message = this.#store.insertMessage({
      agentId,
      role: "activity",
      text: failed ? "No pudo generar una imagen." : saved ? `Generó una imagen: ${saved.relativePath}` : "Generó una imagen.",
      status: "completed",
      turnId,
      channelId: state?.channelId ?? null,
      ...(saved ? { payload: { kind: "image", path: saved.relativePath } } : {}),
    });
    this.#emit({ type: "message", agentId, message });
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
    const main = this.#isMain(agent);
    return {
      ...agent,
      // Las instrucciones pueden ser largas (hasta 32 000 caracteres): en la lista va solo el comienzo.
      instructions: agent.instructions.length > INSTRUCTIONS_PREVIEW ? `${agent.instructions.slice(0, INSTRUCTIONS_PREVIEW)}…` : agent.instructions,
      instructionsLength: agent.instructions.length,
      notify: this.#notifyLevel(agent),
      progress: this.#progressMap().get(agent.id) ?? null,
      state,
      queued,
      unread: agent.lastAt > agent.readAt,
      main,
    };
  }

  /** «Avisarme» del agente: lo que eligió el usuario o, si no eligió, todo en Claude Bot y lo necesario en los demás. */
  #notifyLevel(agent: AgentRecord): NotifyLevel {
    return agent.notify || (this.#isMain(agent) ? "all" : "needs");
  }

  #uniqueWorkspace(name: string): string {
    const base = slugify(name) || "agente";
    const taken = new Set(this.#store.listAgents().map((agent) => agent.workspace));
    // Una carpeta que ya existe (la de un agente eliminado) no se reutiliza: traería sus instrucciones y habilidades.
    let candidate = join(this.#options.workspacesDir, base);
    for (let index = 2; taken.has(candidate) || existsSync(candidate); index += 1) candidate = join(this.#options.workspacesDir, `${base}-${index}`);
    return candidate;
  }

  #updateMessageStatus(agentId: string, messageId: string, status: MessageRecord["status"]): void {
    // El mensaje del usuario en un canal puede ir a varios agentes: no sigue el estado de cada entrega.
    const current = this.#store.getMessage(messageId);
    if (!current || (current.channelId && current.role === "user")) return;
    const message = this.#store.updateMessage(messageId, { status });
    if (message) this.#emit({ type: "message", agentId, message });
  }

  /**
   * Notificación para el sistema según «Avisarme» del agente: con «Solo cuando me necesite», sus preguntas
   * y errores; con «Toda la actividad», además lo que responde. La interfaz la muestra si no está a la vista.
   */
  #alert(agentId: string, kind: AlertEvent["kind"], text: string, channelId: string | null): void {
    const agent = this.#store.getAgent(agentId);
    if (!agent) return;
    const level = this.#notifyLevel(agent);
    if (level === "none" || (kind === "reply" && level !== "all")) return;
    const channel = channelId ? this.#store.getChannel(channelId) : null;
    const body = clip(text.replace(/\s+/g, " "), 180);
    this.#emit({
      type: "alert",
      agentId,
      channelId: channel ? channel.id : null,
      kind,
      title: channel ? `${agent.name} en «${channel.name}»` : agent.name,
      body: kind === "question" ? `Pregunta: ${body}` : body,
    });
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

  #progressMap(): Map<string, AgentProgress> {
    if (this.#progress) return this.#progress;
    const map = new Map<string, AgentProgress>();
    try {
      const saved: unknown = JSON.parse(this.#store.getMeta(PROGRESS_META) ?? "{}");
      if (isRecord(saved)) {
        for (const [id, value] of Object.entries(saved)) {
          if (!isRecord(value) || typeof value.percent !== "number" || typeof value.at !== "number") continue;
          map.set(id, { percent: value.percent, step: typeof value.step === "string" ? value.step : "", at: value.at });
        }
      }
    } catch {
      // Un valor dañado no impide arrancar: se empieza sin avances.
    }
    this.#progress = map;
    return map;
  }

  #setProgress(agentId: string, progress: AgentProgress | null): void {
    const map = this.#progressMap();
    if (!progress && !map.has(agentId)) return;
    // El equipo se calcula con lo de antes de este informe (la primera vez se parte de lo que se veía).
    const teams = progress ? this.#updateTeamProgress(agentId, progress.percent, progress.at) : false;
    if (progress) map.set(agentId, progress);
    else map.delete(agentId);
    this.#store.setMeta(PROGRESS_META, JSON.stringify(Object.fromEntries(map)));
    this.#emitAgents();
    if (teams) this.#emitChannels();
  }

  // ---------- avance de cada equipo ----------
  // Pedido del usuario («iba en 60 y ahora 30, que sea consistente»): el avance de un equipo cuenta a todos sus
  // integrantes desde el principio (quien todavía no informa, 0) y no retrocede. Quien terminó sigue contando 100
  // aunque pase la media hora de su barra o reciba otro encargo. Así, sumarse con poco ya no lo baja: se contaba desde
  // antes. Está listo cuando todos informaron 100, o cuando los que informaron terminaron y nadie del equipo trabaja
  // hace 10 minutos. El trabajo siguiente empieza con el primer informe después de eso, tras 12 horas sin novedades o
  // cuando el encargado, que ya había terminado, recibe un encargo nuevo del usuario en su canal.

  #teamProgressMap(): Map<string, TeamProgressRecord> {
    if (this.#teamProgress) return this.#teamProgress;
    const map = new Map<string, TeamProgressRecord>();
    try {
      const saved: unknown = JSON.parse(this.#store.getMeta(TEAM_PROGRESS_META) ?? "{}");
      if (isRecord(saved)) {
        for (const [id, value] of Object.entries(saved)) {
          if (!isRecord(value) || typeof value.percent !== "number" || typeof value.at !== "number" || !isRecord(value.parts)) continue;
          const parts: Record<string, number> = {};
          for (const [agentId, percent] of Object.entries(value.parts)) if (typeof percent === "number") parts[agentId] = percent;
          map.set(id, { percent: value.percent, at: value.at, parts });
        }
      }
    } catch {
      // Un valor dañado no impide arrancar: los equipos empiezan sin avance.
    }
    this.#teamProgress = map;
    return map;
  }

  #saveTeamProgress(): void {
    const map = this.#teamProgressMap();
    const known = new Set([...this.#store.listChannels(), ...this.#store.listChannels({ deleted: true })].map((channel) => channel.id));
    for (const id of [...map.keys()]) if (!known.has(id)) map.delete(id);
    this.#store.setMeta(TEAM_PROGRESS_META, JSON.stringify(Object.fromEntries(map)));
  }

  /** Lo que informaron sus integrantes y todavía se ve (antes de la 0.9.12 la tarjeta promediaba solo eso). */
  #visibleParts(channel: ChannelRecord, now: number): Record<string, { percent: number; at: number }> {
    const parts: Record<string, { percent: number; at: number }> = {};
    const progress = this.#progressMap();
    for (const id of channel.memberIds) {
      const entry = progress.get(id);
      if (entry && progressShows(entry, now)) parts[id] = { percent: entry.percent, at: entry.at };
    }
    return parts;
  }

  /** Nadie del equipo (salvo `except`) está trabajando ni tiene mensajes esperando turno. */
  #teamIdle(channel: ChannelRecord, except: string | null = null): boolean {
    return channel.memberIds.every((id) => id === except || (!this.#active.has(id) && this.#store.countQueued(id) === 0));
  }

  /** Suma el informe de un integrante al trabajo de cada equipo suyo. Dice si cambió alguno. */
  #updateTeamProgress(agentId: string, percent: number, now: number): boolean {
    const map = this.#teamProgressMap();
    let changed = false;
    for (const channel of this.#store.listChannels()) {
      if (!channel.memberIds.includes(agentId)) continue;
      const record = map.get(channel.id);
      let parts: Record<string, number>;
      let floor = 0;
      if (!record) {
        // Primera vez (datos de antes de la 0.9.12): se parte de lo que se veía de cada uno.
        parts = Object.fromEntries(Object.entries(this.#visibleParts(channel, now)).map(([id, part]) => [id, part.percent]));
        floor = teamAverage(parts, channel.memberIds) ?? 0;
      } else if (!progressShows(record, now) || (percent < 100 && this.#teamFinished(channel, record, agentId, now))) {
        parts = {};
      } else {
        parts = { ...record.parts };
        floor = record.percent;
      }
      parts[agentId] = percent;
      for (const id of Object.keys(parts)) if (!channel.memberIds.includes(id)) delete parts[id];
      map.set(channel.id, { percent: Math.max(floor, teamAverage(parts, channel.memberIds) ?? 0), at: now, parts });
      changed = true;
    }
    if (changed) this.#saveTeamProgress();
    return changed;
  }

  /** El trabajo del equipo terminó: todos informaron 100, o los que informaron terminaron y el equipo quedó quieto. */
  #teamFinished(channel: ChannelRecord, record: TeamProgressRecord, reporter: string, now: number): boolean {
    if (record.percent >= 100) return true;
    return partsDone(record.parts, channel.memberIds) && now - record.at >= TEAM_SETTLE_MS && this.#teamIdle(channel, reporter);
  }

  /** El encargado ya había terminado y le llega un encargo nuevo del usuario en su canal: el equipo empieza otro trabajo. */
  #restartTeamProgress(channel: ChannelRecord): void {
    this.#teamProgressMap().set(channel.id, { percent: 0, at: Date.now(), parts: {} });
    this.#saveTeamProgress();
    this.#emitChannels();
  }

  #channelProgress(channel: ChannelRecord): ChannelView["progress"] {
    const record = this.#teamProgressMap().get(channel.id);
    if (record) {
      const parts = Object.fromEntries(Object.entries(record.parts).filter(([id]) => channel.memberIds.includes(id)));
      if (!Object.keys(parts).length) return null;
      return { percent: record.percent, at: record.at, done: partsDone(parts, channel.memberIds) };
    }
    // Sin registro todavía (de antes de la 0.9.12): lo que se ve de cada uno, contando a todo el equipo.
    const visible = this.#visibleParts(channel, Date.now());
    const parts = Object.fromEntries(Object.entries(visible).map(([id, part]) => [id, part.percent]));
    const percent = teamAverage(parts, channel.memberIds);
    if (percent === null) return null;
    return { percent, at: Math.max(...Object.values(visible).map((part) => part.at)), done: partsDone(parts, channel.memberIds) };
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

function variantsOf(model: Record<string, unknown>): { variants?: Record<string, string> } {
  const variants = Object.entries(getRecord(model, "variants") ?? {}).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "",
  );
  return variants.length ? { variants: Object.fromEntries(variants) } : {};
}

/** Cuánto se muestra de la ficha de un agente en read_agent. */
const READ_AGENT_LIMITS = { instructions: 8_000, memories: 6_000, recent: 6, message: 300 } as const;

/** Estado de un agente en palabras (para las herramientas). */
function agentStateLabel(state: AgentState): string {
  return state === "working" ? "trabajando" : state === "queued" ? "con cola" : state === "paused" ? "en pausa" : "libre";
}

/** La herramienta de las rondas de la 0.8.0, que un hilo de Codex de entonces todavía puede pedir. */
const RETIRED_ROUND_TOOL = "start_round";

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

const PROVIDER_LABELS: Record<ProviderId, string> = { claude: "Claude", codex: "Codex", grok: "Grok", gemini: "Gemini", local: "Qwen local", demo: "Demo" };

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

function cleanNotify(value: unknown): NotifyLevel | "" {
  if (value === null || value === "") return "";
  const level = toNotify(value);
  if (!level) throw new ServiceError("«Avisarme» debe ser all, needs o none.");
  return level;
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

/** Un número de tokens (entero, no negativo) de lo que manda un programa. */
function tokenNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function parseModelReading(value: unknown): ModelReading | null {
  if (!isRecord(value)) return null;
  const cost = typeof value.costUsd === "number" && Number.isFinite(value.costUsd) && value.costUsd >= 0 ? value.costUsd : null;
  return {
    input: tokenNumber(value.input),
    cacheRead: tokenNumber(value.cacheRead),
    cacheWrite: tokenNumber(value.cacheWrite),
    output: tokenNumber(value.output),
    costUsd: cost,
  };
}

/** `{ modelo: { input, cacheRead, cacheWrite, output, costUsd } }` → lectura; null si no trae ningún modelo. */
function parseReading(value: Record<string, unknown> | null): Reading | null {
  if (!value) return null;
  const reading: Reading = {};
  for (const [model, entry] of Object.entries(value)) {
    const parsed = parseModelReading(entry);
    if (parsed && model.trim()) reading[model.trim().slice(0, 120)] = parsed;
  }
  return Object.keys(reading).length ? reading : null;
}

function parseTurnUsage(value: Record<string, unknown> | null): (ModelReading & { model: string }) | null {
  const parsed = parseModelReading(value);
  const model = value && typeof value.model === "string" ? value.model.trim().slice(0, 120) : "";
  return parsed && model ? { ...parsed, model } : null;
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
    // Codex lo llama planType («plus», «pro»…).
    plan: typeof limits.plan === "string" && limits.plan ? limits.plan : typeof limits.planType === "string" && limits.planType ? limits.planType : null,
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

/** Huella de lo que recibe un hilo al abrirse (instrucciones, modelo, herramientas…). */
function paramsPrint(params: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(params)).digest("hex").slice(0, 24);
}

/** El color que elegiste para un equipo: «#rrggbb» (en minúsculas) o vacío para el automático. */
function channelColor(value: unknown): string {
  if (value === null || value === "") return "";
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value.trim())) throw new ServiceError("El color no es válido.");
  return value.trim().toLowerCase();
}

/** Si un avance todavía se muestra: el terminado, media hora; el que va en camino, 12 horas sin novedades. */
function progressShows(progress: { percent: number; at: number }, now: number): boolean {
  return now - progress.at <= (progress.percent >= 100 ? PROGRESS_DONE_MS : PROGRESS_STALE_MS);
}

/** El avance de un equipo: el promedio de todos sus integrantes (quien no informó, 0); null si nadie informó. */
function teamAverage(parts: Record<string, number>, memberIds: string[]): number | null {
  const reported = memberIds.filter((id) => typeof parts[id] === "number");
  if (!reported.length) return null;
  return Math.round(memberIds.reduce((sum, id) => sum + (parts[id] ?? 0), 0) / memberIds.length);
}

/** Los que informaron (al menos uno) ya terminaron. */
function partsDone(parts: Record<string, number>, memberIds: string[]): boolean {
  const reported = memberIds.filter((id) => typeof parts[id] === "number");
  return reported.length > 0 && reported.every((id) => (parts[id] ?? 0) >= 100);
}

function clip(text: string, max: number): string {
  const value = text.trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** «A», «A y B», «A, B y C». */
function joinNames(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;
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
