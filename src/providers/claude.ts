// Derivado de OpenBot v0.1.11 (src/backend/claude-client.ts), Copyright 2026 Norbert Bodziony,
// con licencia Apache-2.0 (ver licenses/OPENBOT-APACHE-2.0.txt y NOTICE).
// Modificado para ClosedBot: niveles de acceso con sandbox, herramientas del equipo,
// actividad de herramientas, reinicio por cambio de esfuerzo, cierre por inactividad y
// fallos aislados por hilo.

import { randomUUID, type UUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { resolve, sep } from "node:path";
import {
  type CanUseTool,
  createSdkMcpServer,
  type Options,
  type PermissionResult,
  type Query,
  query,
  type SDKMessage,
  type SDKUserMessage,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BOARD_MAX } from "../board.js";
import { CHANNEL_LIMITS, MAX_CHANNEL_MEMBERS } from "../channels.js";
import { MAX_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES } from "../schedule.js";
import {
  AGENT_FIELD_HELP,
  AGENT_LIMITS,
  AGENT_PROVIDERS,
  ASK_USER_DESCRIPTION,
  CHANNEL_FIELD_HELP,
  CREATE_AGENT_DESCRIPTION,
  CREATE_CHANNEL_DESCRIPTION,
  CREATE_ROUTINE_DESCRIPTION,
  DELETE_ROUTINE_DESCRIPTION,
  FORGET_MEMORY_DESCRIPTION,
  LIST_AGENTS_DESCRIPTION,
  LIST_MEMORIES_DESCRIPTION,
  LIST_ROUTINES_DESCRIPTION,
  QUESTION_LIMITS,
  READ_AGENT_DESCRIPTION,
  REMEMBER_DESCRIPTION,
  ROUTINE_LIMITS,
  SEARCH_MEMORIES_DESCRIPTION,
  SEND_MESSAGE_DESCRIPTION,
  SET_MEMORY_INCLUSION_DESCRIPTION,
  TEAM_NAMESPACE,
  TEAM_TOOLS,
  TOOL_ASK_USER,
  TOOL_CREATE_AGENT,
  TOOL_CREATE_CHANNEL,
  TOOL_CREATE_ROUTINE,
  TOOL_DELETE_ROUTINE,
  TOOL_REPORT_PROGRESS,
  REPORT_PROGRESS_DESCRIPTION,
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
  UPDATE_AGENT_DESCRIPTION,
  UPDATE_BOARD_DESCRIPTION,
  UPDATE_PROVIDER_HELP,
} from "../team.js";
import { MEMORY_LIMITS } from "../memories.js";
import { VERSION } from "../version.js";
import type { AccessLevel, AgentClient, ProviderId } from "./client.js";
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

interface ThreadConfig {
  cwd: string;
  model?: string;
  effort?: string;
  developerInstructions: string;
  additionalDirectories: string[];
  access: AccessLevel;
  /** Herramientas de ClosedBot que ve el agente (el bot principal tiene además las de equipos). Por defecto, las de todos. */
  teamTools?: string[];
}

interface ActiveTurn {
  id: string;
  itemId: string;
  text: string;
  /** Textos completos de cada mensaje del asistente en este turno, por uuid. */
  assistantMessages: Map<string, string>;
  /** Si el mensaje que se está transmitiendo ya aportó texto (para separar párrafos). */
  streamingMessageHasText: boolean;
  toolUseIds: Set<string>;
}

interface ThreadRuntime {
  id: string;
  config: ThreadConfig;
  input: AsyncMessageQueue;
  query: Query;
  activeTurn: ActiveTurn | null;
  consume: Promise<void>;
  lastActivity: number;
  closing: boolean;
}

interface PendingServerRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export type QueryFactory = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;

export interface ClaudeClientOptions {
  /** Inferencia local mediante Messages API; el SDK conserva herramientas y sesiones. */
  local?: { model: string; baseUrl: string; configDir: string; contextSize?: number; contextSizes?: Record<string, number>; models?: Array<{ model: string; displayName: string }> };
  /** Ruta opcional al ejecutable `claude`; si falta, el SDK usa el suyo. */
  executable?: string | null;
  /** Añade el servidor MCP de Playwright (navegador) a cada agente. */
  playwright?: boolean;
  /** Cierra los procesos de hilos sin actividad tras este tiempo (se reanudan solos). */
  idleMs?: number;
  /** Variables de entorno para Claude Code (por defecto, las del proceso). */
  env?: NodeJS.ProcessEnv;
  /** Sistema operativo (por defecto, el actual); se puede cambiar en las pruebas. */
  platform?: NodeJS.Platform;
  createQuery?: QueryFactory;
}

/** Herramientas que ejecutan comandos; en Windows no hay sandbox que las encierre en la carpeta. */
const SHELL_TOOLS = ["Bash", "PowerShell", "Monitor"];

const NO_SHELL_NOTE =
  "En este equipo (Windows) el modo «solo su carpeta» no tiene terminal: no puedes ejecutar comandos. Trabaja leyendo y escribiendo archivos en tus carpetas, con búsquedas web y con tus compañeros. Si una tarea exige comandos, explícale al usuario por qué.";

const NO_USER_MESSAGE =
  "El usuario no está mirando en vivo. Si la decisión le corresponde, pregúntale con la herramienta ask_user del grupo «closedbot» (te responderá en un mensaje nuevo) y termina tu turno; si no, decide con tu mejor criterio y explica tus supuestos.";

export const CLAUDE_MODELS = [
  { model: "claude-opus-5-5", displayName: "Claude Opus 5.5", isDefault: true },
  { model: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5", isDefault: false },
  { model: "claude-haiku-5-5", displayName: "Claude Haiku 5.5", isDefault: false },
  { model: "claude-fable-5-1", displayName: "Claude Fable 5.1", isDefault: false },
].map((entry) => ({
  ...entry,
  supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"].map((reasoningEffort) => ({
    reasoningEffort,
  })),
}));

/**
 * Emula el protocolo del app-server de Codex encima del Claude Agent SDK.
 * Cada hilo es una sesión de Claude Code con entrada en streaming.
 */
export class ClaudeAgentClient extends EventEmitter<ClientEvents> implements AgentClient {
  readonly provider: ProviderId;
  readonly #options: ClaudeClientOptions;
  readonly #createQuery: QueryFactory;
  readonly #threads = new Map<string, ThreadRuntime>();
  /** Última configuración de cada hilo, para reanudarlo tras cerrarlo por inactividad. */
  readonly #configs = new Map<string, ThreadConfig>();
  readonly #pendingServerRequests = new Map<RequestId, PendingServerRequest>();
  #running = false;
  #reaper: NodeJS.Timeout | null = null;

  constructor(options: ClaudeClientOptions = {}) {
    super();
    this.provider = options.local ? "local" : "claude";
    this.#options = options;
    this.#createQuery = options.createQuery ?? ((params) => query(params));
  }

  get running(): boolean {
    return this.#running;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    const idleMs = this.#options.idleMs ?? 20 * 60_000;
    if (idleMs > 0) {
      this.#reaper = setInterval(() => this.#reapIdle(idleMs), Math.min(idleMs, 60_000));
      this.#reaper.unref();
    }
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#reaper) clearInterval(this.#reaper);
    this.#reaper = null;
    const runtimes = [...this.#threads.values()];
    for (const runtime of runtimes) this.#closeRuntime(runtime);
    await Promise.allSettled(runtimes.map((runtime) => runtime.consume));
    this.#threads.clear();
    for (const pending of this.#pendingServerRequests.values()) {
      pending.reject(new Error("Sesión de Claude detenida."));
    }
    this.#pendingServerRequests.clear();
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    if (!this.#running) throw new Error("El cliente de Claude no está en marcha.");
    switch (method) {
      case "initialize":
        return {} as T;
      case "model/list":
        return { data: this.#options.local ? (this.#options.local.models ?? [{ model: this.#options.local.model, displayName: "Qwen local" }]).map(model => ({ ...model, isDefault: model.model === this.#options.local!.model, supportedReasoningEfforts: [] })) : CLAUDE_MODELS } as T;
      case "account/rateLimits/read":
        if (this.#options.local) return { rateLimits: { available: false, windows: [] } } as T;
        return { rateLimits: await this.#readRateLimits() } as T;
      case "thread/start": {
        const threadId = randomUUID();
        this.#startThread(threadId, readThreadConfig(params), false);
        return { thread: { id: threadId } } as T;
      }
      case "thread/resume": {
        const threadId = requiredString(params, "threadId");
        const config = readThreadConfig(params);
        const existing = this.#threads.get(threadId);
        if (existing && !sameRuntimeConfig(existing.config, config)) {
          await this.#restartRuntime(existing, config);
        } else if (!existing) {
          this.#startThread(threadId, config, true);
        }
        return { thread: { id: threadId } } as T;
      }
      case "turn/start":
        return (await this.#startTurn(params)) as T;
      case "turn/interrupt": {
        const runtime = this.#threads.get(requiredString(params, "threadId"));
        if (runtime?.activeTurn) await runtime.query.interrupt();
        return {} as T;
      }
      case "thread/close": {
        const runtime = this.#threads.get(requiredString(params, "threadId"));
        if (runtime) this.#closeRuntime(runtime);
        this.#configs.delete(requiredString(params, "threadId"));
        return {} as T;
      }
      default:
        throw new Error(`El adaptador de Claude no implementa ${method}.`);
    }
  }

  notify(): void {
    // El Agent SDK no necesita la notificación `initialized`.
  }

  respond(id: RequestId, result: unknown): void {
    const pending = this.#pendingServerRequests.get(id);
    if (!pending) return;
    this.#pendingServerRequests.delete(id);
    pending.resolve(result);
  }

  respondError(id: RequestId, error: RpcError): void {
    const pending = this.#pendingServerRequests.get(id);
    if (!pending) return;
    this.#pendingServerRequests.delete(id);
    pending.reject(new Error(error.message));
  }

  /**
   * Uso del plan de claude.ai (lo mismo que /usage en Claude Code): ventanas de 5 horas, semanal y por modelo.
   * Usa la sesión de un hilo abierto si hay alguno; si no, abre una consulta corta sin herramientas ni MCP.
   */
  async #readRateLimits(): Promise<{ available: boolean; plan: string | null; windows: Array<{ id: string; label?: string; usedPercent: number; resetsAt: string | null }> }> {
    const live = [...this.#threads.values()].find((runtime) => !runtime.closing);
    let probe: { input: AsyncMessageQueue; query: Query } | null = null;
    let target: Query;
    if (live) {
      target = live.query;
    } else {
      const input = new AsyncMessageQueue();
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(this.#options.env ?? process.env)) if (typeof value === "string") env[key] = value;
      env.CLAUDE_AGENT_SDK_CLIENT_APP = `closedbot/${VERSION}`;
      env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
      target = this.#createQuery({
        prompt: input,
        options: {
          ...(this.#options.executable ? { pathToClaudeCodeExecutable: this.#options.executable } : {}),
          mcpServers: {},
          strictMcpConfig: true,
          settingSources: [],
          persistSession: false,
          settings: { disableClaudeAiConnectors: true },
          env,
        },
      });
      probe = { input, query: target };
    }
    try {
      const reader = (target as unknown as Record<string, unknown>).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      if (typeof reader !== "function") throw new Error("Esta versión de Claude Code no informa el uso del plan.");
      const response = (await withTimeout(
        (reader as (opts: { skipBehaviors: boolean }) => Promise<unknown>).call(target, { skipBehaviors: true }),
        25_000,
        "Claude tardó demasiado en informar el uso.",
      )) as Record<string, unknown> | null;
      const limits = isRecord(response?.rate_limits) ? response.rate_limits : null;
      const plan = typeof response?.subscription_type === "string" ? response.subscription_type : null;
      if (response?.rate_limits_available !== true || !limits) return { available: false, plan, windows: [] };
      const windows: Array<{ id: string; label?: string; usedPercent: number; resetsAt: string | null }> = [];
      for (const id of ["seven_day", "five_hour", "seven_day_opus", "seven_day_sonnet"]) {
        const window = limits[id];
        if (!isRecord(window) || typeof window.utilization !== "number") continue;
        windows.push({ id, usedPercent: window.utilization, resetsAt: typeof window.resets_at === "string" ? window.resets_at : null });
      }
      if (Array.isArray(limits.model_scoped)) {
        for (const window of limits.model_scoped.filter(isRecord)) {
          if (typeof window.utilization !== "number" || typeof window.display_name !== "string") continue;
          windows.push({
            id: `model:${window.display_name}`,
            label: `Semanal · ${window.display_name}`,
            usedPercent: window.utilization,
            resetsAt: typeof window.resets_at === "string" ? window.resets_at : null,
          });
        }
      }
      return { available: true, plan, windows };
    } finally {
      if (probe) {
        probe.input.close();
        try {
          probe.query.close();
        } catch {
          // Ya había terminado.
        }
      }
    }
  }

  /** Opciones del SDK para un hilo; se exporta para poder probar la política de acceso. */
  buildOptions(threadId: string, config: ThreadConfig, resume: boolean): Options {
    const allowedDirs = [...new Set([config.cwd, ...config.additionalDirectories].map((dir) => resolve(dir)))];
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.#options.env ?? process.env)) if (typeof value === "string") env[key] = value;
    env.CLAUDE_AGENT_SDK_CLIENT_APP = `closedbot/${VERSION}`;
    // Los agentes entran con la cuenta de claude.ai de la persona. Sin esto, Claude Code cargaría los
    // conectores de esa cuenta (servidores, bancos, brókeres…) y en acceso total podría usarlos sin preguntar.
    env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
    const local = this.#options.local ? { ...this.#options.local, model: config.model || this.#options.local.model } : undefined;
    if (local) {
      for (const key of ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_FOUNDRY_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) delete env[key];
      env.ANTHROPIC_BASE_URL = local.baseUrl;
      env.ANTHROPIC_API_KEY = "local";
      env.CLAUDE_CONFIG_DIR = local.configDir;
      env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
      for (const key of ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_CUSTOM_HEADERS"]) delete env[key];
      env.DISABLE_TELEMETRY = "1";
      env.DISABLE_ERROR_REPORTING = "1";
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = local.model;
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = local.model;
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = local.model;
      env.ENABLE_TOOL_SEARCH = "false";
      env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = "2048";
      // El SDK no conoce las ventanas de los modelos externos: no debe asumir 200k.
      const contextSize = local.contextSizes?.[local.model] ?? (local.model === this.#options.local?.model ? local.contextSize : undefined) ?? 8192;
      env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(contextSize);
      env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(contextSize);
      env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = "70";
      delete env.DISABLE_COMPACT;
      delete env.DISABLE_AUTO_COMPACT;
      env.MAX_THINKING_TOKENS = "0";
    }

    const mcpServers: NonNullable<Options["mcpServers"]> = { [TEAM_NAMESPACE]: this.#createTeamServer(threadId, config.teamTools ?? [...TEAM_TOOLS]) };
    if (this.#options.playwright) {
      mcpServers.playwright = {
        type: "stdio",
        command: "npx",
        args: ["-y", "@playwright/mcp@0.0.84", "--headless", "--isolated"],
      };
    }

    const options: Options = {
      cwd: config.cwd,
      ...(this.#options.executable ? { pathToClaudeCodeExecutable: this.#options.executable } : {}),
      ...(local ? { model: config.model || local.model, thinking: { type: "disabled" as const }, tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"] } : config.model ? { model: normalizeClaudeModel(config.model) } : {}),
      ...(!local && config.effort ? { effort: normalizeClaudeEffort(config.effort) } : {}),
      ...(resume ? { resume: threadId } : { sessionId: threadId }),
      systemPrompt: local ? `Eres un asistente local que trabaja en ClosedBot. Responde en español. Usa las herramientas disponibles para leer archivos, escribir y trabajar con el equipo; no inventes resultados de herramientas.\nCarpeta de trabajo: ${config.cwd}\n${config.developerInstructions}${this.#withoutShell(config) ? `\n${NO_SHELL_NOTE}` : ""}` : {
        type: "preset",
        preset: "claude_code",
        append: this.#withoutShell(config) ? `${config.developerInstructions}\n${NO_SHELL_NOTE}` : config.developerInstructions,
      },
      includePartialMessages: true,
      additionalDirectories: allowedDirs.filter((dir) => dir !== resolve(config.cwd)),
      canUseTool: createPermissionPolicy(config.access, allowedDirs),
      mcpServers,
      // Segunda barrera para lo mismo: ninguna fuente de ajustes puede volver a activar los conectores.
      settings: { disableClaudeAiConnectors: true, ...(local ? { env: { ANTHROPIC_BASE_URL: local.baseUrl, ANTHROPIC_API_KEY: "local" } } : {}) },
      ...(local ? { strictMcpConfig: true } : {}),
      env,
    };

    if (config.access === "total") {
      return {
        ...options,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: local ? [] : ["user", "project", "local"],
      };
    }
    if (this.#withoutShell(config)) {
      // Windows: Claude Code no puede encerrar los comandos en una carpeta, así que en este
      // modo el agente no tiene terminal; los archivos los sigue limitando canUseTool.
      return { ...options, permissionMode: "acceptEdits", settingSources: [], disallowedTools: SHELL_TOOLS };
    }
    return {
      ...options,
      permissionMode: "acceptEdits",
      // Sin ajustes de disco: el agente puede escribir en su carpeta y no debe poder
      // darse permisos ni hooks con un .claude/settings.json propio.
      settingSources: [],
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        filesystem: { allowWrite: allowedDirs },
      },
    };
  }

  #withoutShell(config: ThreadConfig): boolean {
    return config.access === "carpeta" && (this.#options.platform ?? process.platform) === "win32";
  }

  #startThread(threadId: string, config: ThreadConfig, resume: boolean): ThreadRuntime {
    const input = new AsyncMessageQueue();
    const claudeQuery = this.#createQuery({ prompt: input, options: this.buildOptions(threadId, config, resume) });
    const runtime: ThreadRuntime = {
      id: threadId,
      config,
      input,
      query: claudeQuery,
      activeTurn: null,
      consume: Promise.resolve(),
      lastActivity: Date.now(),
      closing: false,
    };
    runtime.consume = this.#consume(runtime);
    this.#threads.set(threadId, runtime);
    this.#configs.set(threadId, config);
    return runtime;
  }

  async #restartRuntime(runtime: ThreadRuntime, config: ThreadConfig): Promise<ThreadRuntime> {
    if (runtime.activeTurn) throw new Error("No se puede reconfigurar un hilo de Claude con un turno activo.");
    this.#closeRuntime(runtime);
    await runtime.consume.catch(() => undefined);
    return this.#startThread(runtime.id, config, true);
  }

  #closeRuntime(runtime: ThreadRuntime): void {
    runtime.closing = true;
    runtime.input.close();
    try {
      runtime.query.close();
    } catch {
      // El proceso puede haber terminado ya.
    }
    if (this.#threads.get(runtime.id) === runtime) this.#threads.delete(runtime.id);
  }

  #reapIdle(idleMs: number): void {
    const now = Date.now();
    for (const runtime of this.#threads.values()) {
      if (!runtime.activeTurn && now - runtime.lastActivity > idleMs) this.#closeRuntime(runtime);
    }
  }

  async #startTurn(params: unknown): Promise<unknown> {
    const threadId = requiredString(params, "threadId");
    let runtime = this.#threads.get(threadId);
    if (!runtime) {
      const saved = this.#configs.get(threadId);
      if (!saved) throw new Error(`Hilo de Claude desconocido: ${threadId}`);
      runtime = this.#startThread(threadId, saved, true);
    }
    if (runtime.activeTurn) throw new Error("El hilo de Claude ya tiene un turno activo.");

    const requestedEffort = getString(params, "effort");
    if (requestedEffort && requestedEffort !== runtime.config.effort) {
      runtime = await this.#restartRuntime(runtime, { ...runtime.config, effort: requestedEffort });
    }
    const requestedModel = getString(params, "model");
    if (requestedModel && requestedModel !== runtime.config.model) {
      await runtime.query.setModel(this.#options.local ? requestedModel : normalizeClaudeModel(requestedModel));
      runtime.config.model = requestedModel;
    }

    const clientId = getString(params, "clientUserMessageId");
    const turnId = clientId && isUuid(clientId) ? clientId : randomUUID();
    runtime.activeTurn = {
      id: turnId,
      itemId: `${turnId}:assistant`,
      text: "",
      assistantMessages: new Map(),
      streamingMessageHasText: false,
      toolUseIds: new Set(),
    };
    runtime.lastActivity = Date.now();
    this.emit("notification", {
      method: "turn/started",
      params: { threadId, turn: { id: turnId, status: "inProgress" } },
    });
    runtime.input.push({
      type: "user",
      message: { role: "user", content: readInputText(params) },
      parent_tool_use_id: null,
      uuid: turnId as UUID,
      session_id: threadId,
    });
    return { turn: { id: turnId, status: "inProgress" } };
  }

  async #consume(runtime: ThreadRuntime): Promise<void> {
    try {
      for await (const message of runtime.query) {
        runtime.lastActivity = Date.now();
        this.#handleMessage(runtime, message);
      }
      if (!runtime.closing) this.#failThread(runtime, new Error("La sesión de Claude terminó inesperadamente."));
    } catch (error) {
      if (!runtime.closing) this.#failThread(runtime, error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** Un fallo afecta solo a su hilo: se cierra el turno y el próximo mensaje lo reanuda. */
  #failThread(runtime: ThreadRuntime, error: Error): void {
    if (runtime.activeTurn) this.#completeTurn(runtime, "failed", error.message);
    else this.emit("notification", { method: "error", params: { threadId: runtime.id, error: { message: error.message }, willRetry: false } });
    this.#closeRuntime(runtime);
  }

  #handleMessage(runtime: ThreadRuntime, message: SDKMessage): void {
    if (message.type === "stream_event") {
      if (message.parent_tool_use_id !== null) return;
      const event = message.event as unknown;
      if (!isRecord(event)) return;
      if (event.type === "message_start" && runtime.activeTurn) {
        runtime.activeTurn.streamingMessageHasText = false;
        return;
      }
      const delta = isRecord(event.delta) ? event.delta : null;
      if (event.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string") {
        this.#appendStreamingText(runtime, delta.text);
      }
      return;
    }

    if (message.type === "assistant") {
      if (message.parent_tool_use_id !== null) return;
      const turn = runtime.activeTurn;
      if (!turn) return;
      for (const block of contentBlocks(message.message)) {
        if (block.type === "tool_use" && typeof block.id === "string" && !turn.toolUseIds.has(block.id)) {
          turn.toolUseIds.add(block.id);
          this.emit("notification", {
            method: "item/completed",
            params: {
              threadId: runtime.id,
              turnId: turn.id,
              item: { type: "toolCall", id: block.id, tool: String(block.name ?? "herramienta"), input: block.input },
            },
          });
        }
      }
      const text = messageText(message.message);
      if (!text) return;
      turn.assistantMessages.set(message.uuid, text);
      const completeText = [...turn.assistantMessages.values()].join("\n\n");
      if (completeText.startsWith(turn.text)) this.#emitDelta(runtime, completeText.slice(turn.text.length));
      return;
    }

    if (message.type !== "result") return;
    const turn = runtime.activeTurn;
    const fallback = message.subtype === "success" ? message.result : "";
    if (turn) {
      const completeText = [...turn.assistantMessages.values()].join("\n\n");
      if (completeText && completeText.startsWith(turn.text)) this.#emitDelta(runtime, completeText.slice(turn.text.length));
      else if (!turn.text && fallback) this.#emitDelta(runtime, fallback);
    }
    const errors = "errors" in message && Array.isArray(message.errors) ? message.errors : [];
    const terminal = (message as { terminal_reason?: unknown }).terminal_reason;
    const interrupted =
      terminal === "aborted_streaming" || terminal === "aborted_tools" || errors.some((error) => /interrupt|abort/i.test(error));
    const status = interrupted ? "interrupted" : message.subtype === "success" ? "completed" : "failed";
    this.#completeTurn(runtime, status, errors.length ? errors.join("\n") : null);
  }

  #appendStreamingText(runtime: ThreadRuntime, text: string): void {
    const turn = runtime.activeTurn;
    if (!turn || !text) return;
    const separator = !turn.streamingMessageHasText && turn.text ? "\n\n" : "";
    turn.streamingMessageHasText = true;
    this.#emitDelta(runtime, separator + text);
  }

  #emitDelta(runtime: ThreadRuntime, delta: string): void {
    const turn = runtime.activeTurn;
    if (!turn || !delta) return;
    turn.text += delta;
    this.emit("notification", {
      method: "item/agentMessage/delta",
      params: { threadId: runtime.id, turnId: turn.id, itemId: turn.itemId, delta },
    });
  }

  #completeTurn(runtime: ThreadRuntime, status: string, error: string | null): void {
    const turn = runtime.activeTurn;
    if (!turn) return;
    if (turn.text) {
      this.emit("notification", {
        method: "item/completed",
        params: { threadId: runtime.id, turnId: turn.id, item: { id: turn.itemId, type: "agentMessage", text: turn.text } },
      });
    }
    if (status === "failed" && error) {
      this.emit("notification", {
        method: "error",
        params: { threadId: runtime.id, turnId: turn.id, error: { message: explainClaudeError(error) }, willRetry: false },
      });
    }
    runtime.activeTurn = null;
    runtime.lastActivity = Date.now();
    this.emit("notification", {
      method: "turn/completed",
      params: { threadId: runtime.id, turn: { id: turn.id, status } },
    });
  }

  #createTeamServer(threadId: string, names: string[]) {
    const call = (name: string, args: unknown) => this.#callDynamicTool(threadId, name, args);
    const tools = [
      tool(TOOL_LIST_AGENTS, LIST_AGENTS_DESCRIPTION, {}, (args) => call(TOOL_LIST_AGENTS, args)),
      tool(
        TOOL_SEND_MESSAGE,
        SEND_MESSAGE_DESCRIPTION,
        {
          to: z.array(z.string()).min(1).max(16),
          text: z.string().min(1).max(50_000),
          replyToMessageId: z.string().nullable().optional(),
        },
        (args) => call(TOOL_SEND_MESSAGE, args),
      ),
      tool(
        TOOL_ASK_USER,
        ASK_USER_DESCRIPTION,
        {
          question: z.string().min(1).max(QUESTION_LIMITS.question),
          options: z
            .array(
              z.object({
                label: z.string().min(1).max(QUESTION_LIMITS.label),
                detail: z.string().max(QUESTION_LIMITS.detail).optional(),
              }),
            )
            .min(QUESTION_LIMITS.minOptions)
            .max(QUESTION_LIMITS.maxOptions),
          recommended: z.number().int().min(0).max(QUESTION_LIMITS.maxOptions - 1).nullable().optional(),
        },
        (args) => call(TOOL_ASK_USER, args),
      ),
      tool(
        TOOL_CREATE_ROUTINE,
        CREATE_ROUTINE_DESCRIPTION,
        {
          name: z.string().min(1).max(ROUTINE_LIMITS.name),
          prompt: z.string().min(1).max(ROUTINE_LIMITS.prompt),
          times: z
            .array(z.string().regex(/^\d{1,2}:\d{2}$/))
            .min(1)
            .max(ROUTINE_LIMITS.times)
            .optional(),
          days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
          everyMinutes: z.number().int().min(MIN_INTERVAL_MINUTES).max(MAX_INTERVAL_MINUTES).optional(),
        },
        (args) => call(TOOL_CREATE_ROUTINE, args),
      ),
      tool(TOOL_LIST_ROUTINES, LIST_ROUTINES_DESCRIPTION, {}, (args) => call(TOOL_LIST_ROUTINES, args)),
      tool(TOOL_DELETE_ROUTINE, DELETE_ROUTINE_DESCRIPTION, { id: z.string().min(1) }, (args) => call(TOOL_DELETE_ROUTINE, args)),
      tool(
        TOOL_REPORT_PROGRESS,
        REPORT_PROGRESS_DESCRIPTION,
        {
          percent: z.number().min(0).max(100).describe("Cuánto llevas, de 0 a 100."),
          step: z.string().max(200).optional().describe("En qué paso vas, en pocas palabras."),
        },
        (args) => call(TOOL_REPORT_PROGRESS, args),
      ),
      tool(
        TOOL_REMEMBER,
        REMEMBER_DESCRIPTION,
        {
          text: z.string().min(1).max(MEMORY_LIMITS.text).describe("Lo que debes recordar, en una o dos frases claras."),
          always: z.boolean().optional().describe("true: se usa siempre. false o sin indicar: solo cuando lo buscas."),
        },
        (args) => call(TOOL_REMEMBER, args),
      ),
      tool(TOOL_FORGET_MEMORY, FORGET_MEMORY_DESCRIPTION, { id: z.string().min(1) }, (args) => call(TOOL_FORGET_MEMORY, args)),
      tool(
        TOOL_SEARCH_MEMORIES,
        SEARCH_MEMORIES_DESCRIPTION,
        { query: z.string().min(1).max(300).describe("Palabras clave del tema.") },
        (args) => call(TOOL_SEARCH_MEMORIES, args),
      ),
      tool(TOOL_LIST_MEMORIES, LIST_MEMORIES_DESCRIPTION, {}, (args) => call(TOOL_LIST_MEMORIES, args)),
      tool(
        TOOL_SET_MEMORY_INCLUSION,
        SET_MEMORY_INCLUSION_DESCRIPTION,
        { id: z.string().min(1), always: z.boolean() },
        (args) => call(TOOL_SET_MEMORY_INCLUSION, args),
      ),
      tool(
        TOOL_CREATE_AGENT,
        CREATE_AGENT_DESCRIPTION,
        {
          name: z.string().min(1).max(AGENT_LIMITS.name).describe(AGENT_FIELD_HELP.name),
          role: z.string().min(1).max(AGENT_LIMITS.role).describe(AGENT_FIELD_HELP.role),
          description: z.string().max(AGENT_LIMITS.description).optional().describe(AGENT_FIELD_HELP.description),
          instructions: z.string().min(1).max(AGENT_LIMITS.instructions).describe(AGENT_FIELD_HELP.instructions),
          project: z.string().min(1).max(AGENT_LIMITS.project).describe(AGENT_FIELD_HELP.project),
          provider: z.enum(AGENT_PROVIDERS).optional().describe(AGENT_FIELD_HELP.provider),
          model: z.string().max(AGENT_LIMITS.model).optional().describe(AGENT_FIELD_HELP.model),
        },
        (args) => call(TOOL_CREATE_AGENT, args),
      ),
      tool(
        TOOL_UPDATE_AGENT,
        UPDATE_AGENT_DESCRIPTION,
        {
          agent: z.string().min(1).describe("Id o nombre actual del agente."),
          name: z.string().min(1).max(AGENT_LIMITS.name).optional().describe("Nombre nuevo."),
          role: z.string().min(1).max(AGENT_LIMITS.role).optional().describe(AGENT_FIELD_HELP.role),
          description: z.string().max(AGENT_LIMITS.description).optional().describe("Descripción nueva; vacía la borra."),
          instructions: z.string().min(1).max(AGENT_LIMITS.instructions).optional().describe(AGENT_FIELD_HELP.instructions),
          project: z.string().max(AGENT_LIMITS.project).optional().describe("Proyecto nuevo; vacío lo saca de su grupo."),
          provider: z.enum(AGENT_PROVIDERS).optional().describe(UPDATE_PROVIDER_HELP),
          model: z.string().max(AGENT_LIMITS.model).optional().describe("Modelo nuevo; vacío vuelve al modelo por defecto."),
        },
        (args) => call(TOOL_UPDATE_AGENT, args),
      ),
      tool(
        TOOL_CREATE_CHANNEL,
        CREATE_CHANNEL_DESCRIPTION,
        {
          name: z.string().min(1).max(CHANNEL_LIMITS.name).describe(CHANNEL_FIELD_HELP.name),
          members: z.array(z.string().min(1)).min(1).max(MAX_CHANNEL_MEMBERS).describe(CHANNEL_FIELD_HELP.members),
          lead: z.string().min(1).optional().describe(CHANNEL_FIELD_HELP.lead),
          topic: z.string().max(CHANNEL_LIMITS.topic).optional().describe(CHANNEL_FIELD_HELP.topic),
        },
        (args) => call(TOOL_CREATE_CHANNEL, args),
      ),
      tool(TOOL_READ_AGENT, READ_AGENT_DESCRIPTION, { agent: z.string().min(1).describe("Id o nombre del agente.") }, (args) => call(TOOL_READ_AGENT, args)),
      tool(
        TOOL_UPDATE_BOARD,
        UPDATE_BOARD_DESCRIPTION,
        { text: z.string().max(BOARD_MAX).describe("La pizarra completa, en pocas líneas.") },
        (args) => call(TOOL_UPDATE_BOARD, args),
      ),
    ];
    const allowed = new Set(names);
    // Siempre cargadas (sin pasar por ToolSearch): son pocas y el agente las necesita en cada turno.
    return createSdkMcpServer({ name: TEAM_NAMESPACE, version: VERSION, alwaysLoad: true, tools: tools.filter((entry) => allowed.has(entry.name)) });
  }

  async #callDynamicTool(threadId: string, name: string, args: unknown): Promise<CallToolResult> {
    const runtime = this.#threads.get(threadId);
    const result = await this.#callServerRequest("item/tool/call", {
      threadId,
      turnId: runtime?.activeTurn?.id ?? randomUUID(),
      callId: randomUUID(),
      namespace: TEAM_NAMESPACE,
      tool: name,
      arguments: args,
    });
    if (!isRecord(result)) return { content: [{ type: "text" as const, text: String(result) }] };
    const content: CallToolResult["content"] = [];
    if (Array.isArray(result.contentItems)) {
      for (const item of result.contentItems) {
        if (isRecord(item) && item.type === "inputText" && typeof item.text === "string") {
          content.push({ type: "text" as const, text: item.text });
        }
      }
    }
    return { content, isError: result.success === false };
  }

  #callServerRequest(method: string, params: unknown): Promise<unknown> {
    const id = randomUUID();
    return new Promise((resolvePromise, reject) => {
      this.#pendingServerRequests.set(id, { resolve: resolvePromise, reject });
      this.emit("request", { id, method, params });
    });
  }
}

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const HARMLESS_TOOLS = new Set(["WebSearch", "WebFetch", "TodoWrite", "Task", "Agent", "ToolSearch", "Skill", "ExitPlanMode"]);

/**
 * Política para lo que el SDK no aprueba por sí solo. En modo «carpeta», Bash corre dentro
 * del sandbox (aprobado automáticamente) y las ediciones dentro de las carpetas permitidas se
 * aceptan solas; esta función decide el resto sin preguntar a nadie.
 */
export function createPermissionPolicy(access: AccessLevel, allowedDirs: string[]): CanUseTool {
  return async (toolName, input): Promise<PermissionResult> => {
    if (toolName === "AskUserQuestion") return { behavior: "deny", message: NO_USER_MESSAGE };
    if (access === "total") return { behavior: "allow", updatedInput: input };
    if (toolName.startsWith(`mcp__${TEAM_NAMESPACE}__`) || toolName.startsWith("mcp__playwright__")) {
      return { behavior: "allow", updatedInput: input };
    }
    if (HARMLESS_TOOLS.has(toolName)) return { behavior: "allow", updatedInput: input };
    if (READ_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName)) {
      const target = toolPath(input);
      if (!target || isInside(target, allowedDirs)) return { behavior: "allow", updatedInput: input };
      return {
        behavior: "deny",
        message: `Modo «solo su carpeta»: ${toolName} solo puede usarse dentro de ${allowedDirs.join(" y ")}.`,
      };
    }
    return {
      behavior: "deny",
      message: `Modo «solo su carpeta»: ${toolName} necesita acceso total. Si es imprescindible, explícale al usuario por qué para que cambie el nivel de acceso del agente.`,
    };
  };
}

function toolPath(input: Record<string, unknown>): string | null {
  for (const key of ["file_path", "notebook_path", "path"]) {
    if (typeof input[key] === "string" && input[key]) return input[key] as string;
  }
  return null;
}

export function isInside(target: string, dirs: string[]): boolean {
  // En Windows las rutas no distinguen mayúsculas (C:\ y c:\ son la misma unidad).
  const normalize = (value: string) => (process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value));
  const absolute = normalize(target);
  return dirs.some((dir) => {
    const base = normalize(dir);
    return absolute === base || absolute.startsWith(base.endsWith(sep) ? base : base + sep);
  });
}

function explainClaudeError(error: string): string {
  if (/sandbox|bubblewrap|bwrap|socat/i.test(error)) {
    return `${error}\nEl modo «solo su carpeta» necesita el sandbox de Claude Code. En Linux: sudo apt install bubblewrap socat. Otra opción es dar acceso total a este agente, solo en una máquina dedicada.`;
  }
  return error;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

class AsyncMessageQueue implements AsyncIterable<SDKUserMessage> {
  readonly #values: SDKUserMessage[] = [];
  readonly #waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  #closed = false;

  push(value: SDKUserMessage): void {
    if (this.#closed) throw new Error("La cola de entrada de Claude está cerrada.");
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.#values.push(value);
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value) return Promise.resolve({ done: false, value });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolvePromise) => this.#waiters.push(resolvePromise));
      },
    };
  }
}

function readThreadConfig(params: unknown): ThreadConfig {
  const roots =
    isRecord(params) && Array.isArray(params.runtimeWorkspaceRoots)
      ? params.runtimeWorkspaceRoots.filter((value): value is string => typeof value === "string")
      : [];
  const cwd = requiredString(params, "cwd");
  const sandbox = getString(params, "sandbox");
  return {
    cwd,
    model: getString(params, "model") ?? undefined,
    effort: getString(params, "effort") ?? undefined,
    developerInstructions: getString(params, "developerInstructions") ?? "",
    additionalDirectories: [...new Set([cwd, ...roots])],
    access: sandbox === "danger-full-access" ? "total" : "carpeta",
    teamTools: readTeamTools(params),
  };
}

/** Nombres de las herramientas de ClosedBot que pide el orquestador (como `dynamicTools` del app-server). */
function readTeamTools(params: unknown): string[] {
  if (!isRecord(params) || !Array.isArray(params.dynamicTools)) return [...TEAM_TOOLS];
  const names = new Set<string>();
  for (const group of params.dynamicTools) {
    if (!isRecord(group) || group.name !== TEAM_NAMESPACE || !Array.isArray(group.tools)) continue;
    for (const entry of group.tools) if (isRecord(entry) && typeof entry.name === "string") names.add(entry.name);
  }
  return [...names];
}

function sameRuntimeConfig(a: ThreadConfig, b: ThreadConfig): boolean {
  return (
    a.cwd === b.cwd &&
    a.access === b.access &&
    a.effort === b.effort &&
    a.developerInstructions === b.developerInstructions &&
    a.additionalDirectories.join("\n") === b.additionalDirectories.join("\n") &&
    teamToolsKey(a) === teamToolsKey(b)
  );
}

function teamToolsKey(config: ThreadConfig): string {
  return [...(config.teamTools ?? TEAM_TOOLS)].sort().join("\n");
}

function requiredString(value: unknown, key: string): string {
  const result = getString(value, key);
  if (!result) throw new Error(`Falta ${key}.`);
  return result;
}

function readInputText(params: unknown): string {
  if (!isRecord(params) || !Array.isArray(params.input)) return "";
  return params.input
    .filter(isRecord)
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
}

function contentBlocks(message: unknown): Array<Record<string, unknown>> {
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.filter(isRecord);
}

function messageText(message: unknown): string {
  if (!isRecord(message)) return "";
  if (typeof message.content === "string") return message.content;
  return contentBlocks(message)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

export function normalizeClaudeModel(model: string): string {
  if (/^(opus|sonnet|haiku|fable)$/.test(model)) return model;
  return model.startsWith("claude-") ? model : "claude-opus-5-5";
}

function normalizeClaudeEffort(effort: string): "low" | "medium" | "high" | "xhigh" | "max" {
  return (["low", "medium", "high", "xhigh", "max"] as const).find((value) => value === effort) ?? "high";
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
