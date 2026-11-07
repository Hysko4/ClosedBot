// Cliente ACP (Agent Client Protocol, https://agentclientprotocol.com): conecta agentes como Grok o
// Antigravity (el de Gemini), que hablan JSON-RPC por stdin/stdout, y los traduce al protocolo tipo app-server de Codex
// que usa el orquestador (thread/start, turn/start, item/agentMessage/delta, turn/completed…).
// Escrito para ClosedBot a partir de la especificación pública del protocolo.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TEAM_NAMESPACE, TEAM_TOOLS } from "../team.js";
import { VERSION } from "../version.js";
import {
  type AcpModelChoice,
  type AgentModels,
  choiceFor,
  findOption,
  mergeSessionModels,
  modelChoices,
  NO_MODELS,
  resolveModel,
} from "./acp-models.js";
import { makePrivateTemp, removePrivateTemp, withTemp } from "./antigravity.js";
import type { AgentClient, ProviderId } from "./client.js";
import { AppServerError, redactDiagnostic } from "./codex.js";
import { JsonLineDecoder } from "./jsonl.js";
import {
  type AppServerNotification,
  type AppServerRequest,
  getArray,
  getRecord,
  getString,
  isRecord,
  type RequestId,
  type RpcError,
  type RpcMessage,
} from "./protocol.js";
import { spawnTarget, stopProcessTree } from "./spawn.js";
import { antigravityUsage, grokUsage } from "./usage.js";
import { type SharedMcpServer, sharedFromParams } from "../mcp-share.js";

interface ClientEvents {
  notification: [notification: AppServerNotification];
  request: [request: AppServerRequest];
  exit: [error: Error];
  diagnostic: [message: string];
}

export interface AcpClientOptions {
  provider: ProviderId;
  /** Nombre para los mensajes («Grok», «Gemini»). */
  label: string;
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /**
   * Métodos de `authenticate` que se pueden usar sin abrir el navegador (sesión ya guardada o clave en
   * el entorno), en orden de preferencia. Solo se piden si el agente responde que falta la sesión.
   */
  authMethods?: string[];
  /** Nombre con que ClosedBot se presenta al agente. */
  clientName?: string;
  requestTimeoutMs?: number;
  /** Puente MCP de las herramientas del equipo (por defecto, team-bridge.js junto a este archivo). */
  bridgeScript?: string;
  /** Node que ejecuta el puente (por defecto, el mismo de ClosedBot). */
  nodePath?: string;
  /** Si el agente no confirma la cancelación en este tiempo, el turno se da por interrumpido igual. */
  cancelGraceMs?: number;
  /**
   * Lo que escribe el agente por stderr cuando no tiene sesión y se queda esperando que alguien entre
   * (Antigravity espera hasta 5 minutos): al verlo se corta enseguida y se pide entrar desde Ajustes.
   */
  signInPrompt?: RegExp;
  /** Cada proceso recibe una carpeta temporal propia dentro de esta, que se borra al terminar. */
  tempRoot?: string;
  /**
   * Cómo se lee el uso del plan: «grok», con su método `_x.ai/billing`; «antigravity», con el comando
   * «/usage» en una sesión aparte (Antigravity 1.4.1 o más nuevo lo contesta sin pasar por el modelo).
   */
  usage?: "grok" | "antigravity";
}

/** El agente pidió entrar con la cuenta: no sirve reintentar ni autenticar con lo guardado. */
class SignInRequiredError extends AppServerError {
  override name = "SignInRequiredError";
}

export type { AcpModel, AcpModelChoice } from "./acp-models.js";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout | null;
}

interface ToolCallState {
  title: string;
  kind: string;
  status: string;
  rawInput: unknown;
  locations: string[];
  reported: boolean;
}

interface AcpTurn {
  id: string;
  /** Mensaje del agente que se está escribiendo (cada herramienta corta uno y empieza otro). */
  itemId: string | null;
  text: string;
  count: number;
  tools: Map<string, ToolCallState>;
  cancelled: boolean;
  finished: boolean;
}

interface AcpThread {
  id: string;
  cwd: string;
  roots: string[];
  total: boolean;
  instructions: string;
  /** Instrucciones que ya vio el agente en esta sesión del proceso (null: todavía ninguna). */
  sentInstructions: string | null;
  model: string | null;
  appliedModel: string | null;
  effort: string | null;
  appliedEffort: string | null;
  /** Opciones de la sesión (modelo, razonamiento…) tal como las informa el agente. */
  configOptions: Record<string, unknown>[];
  key: string;
  turn: AcpTurn | null;
  replaying: boolean;
}

interface ThreadConfig {
  cwd: string;
  roots: string[];
  total: boolean;
  instructions: string;
  model: string | null;
  effort: string | null;
  tools: McpToolSpec[];
  /** Los MCP de este PC que le diste a su equipo (ver mcp-share.ts). */
  shared: SharedMcpServer[];
}

interface McpToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const DEFAULT_BRIDGE = fileURLToPath(new URL("./team-bridge.js", import.meta.url));
const SESSION_TIMEOUT_MS = 120_000;
/** Leer el uso del plan: lo que se espera a la respuesta. */
const USAGE_TIMEOUT_MS = 30_000;
const DIAGNOSTIC_BURST = 30;
const DIAGNOSTIC_WINDOW_MS = 60_000;
/** Variables que el puente MCP necesita para arrancar en cualquier sistema; ninguna es secreta. */
const BRIDGE_ENV = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOME"];
const TEAM_TOOL_PATTERN = new RegExp(`\\b(${[TEAM_NAMESPACE, ...TEAM_TOOLS].join("|")})\\b`, "i");

/** Cliente de un agente ACP: un proceso por proveedor y una sesión ACP por agente de ClosedBot. */
export class AcpClient extends EventEmitter<ClientEvents> implements AgentClient {
  readonly provider: ProviderId;
  readonly #options: AcpClientOptions;
  readonly #requestTimeoutMs: number;
  #decoder = this.#newDecoder();
  #process: ChildProcessWithoutNullStreams | null = null;
  #stopping = false;
  #nextId = 1;
  readonly #pending = new Map<RequestId, Pending>();
  /** Peticiones que este cliente le hizo al orquestador (las herramientas del equipo). */
  readonly #serverPending = new Map<RequestId, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  readonly #threads = new Map<string, AcpThread>();
  #capabilities: Record<string, unknown> = {};
  #authMethods: string[] = [];
  #authenticated = false;
  #models: AgentModels = NO_MODELS;
  #modelsProbe: Promise<void> | null = null;
  #bridge: { server: Server; path: string; token: string; sockets: Set<Socket> } | null = null;
  #bridgeStarting: Promise<{ path: string; token: string }> | null = null;
  readonly #bridgeTools = new Map<string, McpToolSpec[]>();
  readonly #bridgeThreads = new Map<string, string>();
  #diagnostics = { windowStart: 0, count: 0 };
  /** Lo último que escribió por stderr, para reconocer el pedido de entrar aunque llegue en trozos. */
  #stderrTail = "";
  /** Sesión aparte donde se pide «/usage» (Antigravity), y lo que va respondiendo mientras tanto. */
  #usageSession: Promise<string> | null = null;
  readonly #usageReplies = new Map<string, { text: string; modelTurn: boolean }>();
  /** Si «/usage» no sirvió en este proceso, por qué: no se vuelve a pedir hasta que arranque otro. */
  #usageUnsupported: string | null = null;

  constructor(options: AcpClientOptions) {
    super();
    this.provider = options.provider;
    this.#options = options;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  }

  get running(): boolean {
    return this.#process !== null && this.#process.exitCode === null;
  }

  start(): void {
    if (this.running) return;
    this.#stopping = false;
    this.#decoder = this.#newDecoder();
    this.#stderrTail = "";
    this.#usageSession = null;
    this.#usageReplies.clear();
    this.#usageUnsupported = null;
    const target = spawnTarget(this.#options.command, this.#options.args);
    const temp = this.#options.tempRoot ? makePrivateTemp(this.#options.tempRoot) : null;
    const env = this.#options.env ?? process.env;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(target.file, target.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: temp ? withTemp(env, temp) : env,
        cwd: this.#options.cwd,
        shell: target.shell,
        windowsHide: true,
      });
    } catch (error) {
      if (temp) removePrivateTemp(temp);
      throw error;
    }
    if (temp) {
      child.once("close", () => removePrivateTemp(temp));
      child.once("error", () => removePrivateTemp(temp));
    }
    this.#process = child;
    child.stdout.on("data", (chunk: Buffer) => {
      let messages: RpcMessage[];
      try {
        messages = this.#decoder.push(chunk);
      } catch (error) {
        // Solo pasa con una línea gigante sin salto: se descarta y se sigue.
        this.#diagnostic(error instanceof Error ? error.message : String(error));
        this.#decoder = this.#newDecoder();
        return;
      }
      for (const message of messages) {
        try {
          this.#handleMessage(message);
        } catch (error) {
          this.#diagnostic(`No pude procesar un mensaje: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const raw = chunk.toString("utf8");
      const text = raw.trim();
      if (text) this.#diagnostic(text);
      const prompt = this.#options.signInPrompt;
      if (!prompt) return;
      this.#stderrTail = (this.#stderrTail + raw).slice(-2_000);
      if (prompt.test(this.#stderrTail)) {
        this.#stderrTail = "";
        this.#fail(
          new SignInRequiredError(`${this.#options.label} no tiene la sesión iniciada: entra en Ajustes y pulsa «Iniciar sesión».`, -32000),
          child,
        );
      }
    });
    child.stdin.on("error", () => undefined);
    child.once("error", (error) => this.#fail(new Error(`No se pudo abrir ${this.#options.label}: ${error.message}`), child));
    child.once("exit", (code, signal) => {
      const suffix = signal ? `la señal ${signal}` : `el código ${code ?? "desconocido"}`;
      this.#fail(new Error(`${this.#options.label} terminó con ${suffix}.`), child);
    });
  }

  async stop(): Promise<void> {
    const child = this.#process;
    this.#stopping = true;
    this.#process = null;
    this.#rejectAll(new Error(`${this.#options.label} se detuvo.`));
    this.#closeBridge();
    if (!child) return;
    child.stdin.end();
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolveStop) => {
      const force = setTimeout(() => stopProcessTree(child), 2_000);
      child.once("exit", () => {
        clearTimeout(force);
        resolveStop();
      });
      // En Windows los .cmd (Gemini) corren dentro de cmd.exe: hay que cerrar el árbol entero.
      if (process.platform === "win32") stopProcessTree(child);
      else child.kill("SIGTERM");
    });
  }

  request<T>(method: string, params: unknown, timeoutMs = this.#requestTimeoutMs): Promise<T> {
    const work = this.#dispatch(method, params) as Promise<T>;
    if (!timeoutMs) return work;
    return new Promise<T>((resolveRequest, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.#options.label} no respondió a tiempo: ${method}`)), timeoutMs);
      work.then(
        (value) => {
          clearTimeout(timer);
          resolveRequest(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  notify(_method: string, _params?: unknown): void {
    // «initialized» y similares no tienen equivalente en ACP.
  }

  respond(id: RequestId, result: unknown): void {
    const pending = this.#serverPending.get(id);
    if (!pending) return;
    this.#serverPending.delete(id);
    pending.resolve(result);
  }

  respondError(id: RequestId, error: RpcError): void {
    const pending = this.#serverPending.get(id);
    if (!pending) return;
    this.#serverPending.delete(id);
    pending.reject(new AppServerError(error.message, error.code, error.data));
  }

  /** Algunos agentes escriben avisos sueltos por stdout: se cuentan como diagnóstico y se sigue leyendo. */
  #newDecoder(): JsonLineDecoder {
    return new JsonLineDecoder({ onInvalidLine: (line) => this.#diagnostic(`Salida que no es del protocolo: ${line.slice(0, 200)}`) });
  }

  /** Modelos que ofreció el agente en la última sesión. */
  get models(): AcpModelChoice[] {
    return modelChoices(this.#models).choices;
  }

  // ---------- métodos del orquestador ----------

  async #dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "initialize":
        return this.#initialize();
      case "model/list":
        return this.#listModels();
      case "thread/start":
        return this.#startThread(params);
      case "thread/resume":
        return this.#resumeThread(params);
      case "thread/close":
        return this.#closeThread(params);
      case "turn/start":
        return this.#startTurn(params);
      case "turn/interrupt":
        return this.#interrupt(params);
      case "account/rateLimits/read":
        return this.#readUsage();
      default:
        throw new AppServerError(`${this.#options.label} no implementa ${method}.`, -32601);
    }
  }

  async #initialize(): Promise<unknown> {
    const response = await this.#call(
      "initialize",
      {
        protocolVersion: 1,
        // Sin archivos ni terminal prestados: el agente usa sus propias herramientas en la carpeta del agente.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: this.#options.clientName ?? "closedbot", title: "ClosedBot", version: VERSION },
      },
      SESSION_TIMEOUT_MS,
    );
    this.#capabilities = getRecord(response, "agentCapabilities") ?? {};
    this.#authMethods = getArray(response, "authMethods")
      .filter(isRecord)
      .map((method) => getString(method, "id") ?? "")
      .filter(Boolean);
    // Grok adelanta sus modelos en el saludo: así no hace falta abrir una sesión para listarlos.
    const modelState = getRecord(getRecord(response, "_meta"), "modelState");
    if (modelState) this.#rememberModels({ models: modelState });
    const info = getRecord(response, "agentInfo");
    const name = info ? [getString(info, "title") ?? getString(info, "name"), getString(info, "version")].filter(Boolean).join(" ") : "";
    if (name) this.emit("diagnostic", `Conectado a ${name} por ACP.`);
    return { userAgent: name || this.#options.label };
  }

  async #listModels(): Promise<unknown> {
    // Los modelos llegan al abrir una sesión: si todavía no hay ninguna, se abre una vacía para verlos.
    if (!modelChoices(this.#models).choices.length) {
      this.#modelsProbe ??= this.#probeModels().finally(() => {
        this.#modelsProbe = null;
      });
      await this.#modelsProbe;
    }
    // Un modelo por familia, con sus niveles aparte (Antigravity da cada nivel también como otro modelo).
    const { choices, current: currentId } = modelChoices(this.#models);
    const current = currentId ? choiceFor(choices, currentId) : undefined;
    return {
      data: choices.map((model) => ({
        id: model.modelId,
        model: model.modelId,
        displayName: model.name,
        isDefault: model === current,
        supportedReasoningEfforts: model.efforts,
        ...(Object.keys(model.variants).length ? { variants: model.variants } : {}),
      })),
    };
  }

  async #probeModels(): Promise<void> {
    const cwd = join(tmpdir(), `closedbot-${this.provider}-modelos`);
    mkdirSync(cwd, { recursive: true });
    const response = await this.#withAuth(() => this.#call("session/new", { cwd, mcpServers: [] }, SESSION_TIMEOUT_MS));
    this.#rememberModels(response);
    const sessionId = getString(response, "sessionId");
    if (sessionId && this.#canClose()) await this.#call("session/close", { sessionId }, 10_000).catch(() => undefined);
  }

  async #startThread(params: unknown): Promise<unknown> {
    const config = threadConfig(params);
    const key = randomBytes(12).toString("hex");
    const servers = await this.#mcpServers(key, config.tools, config.shared);
    let response: unknown;
    try {
      response = await this.#withAuth(() => this.#call("session/new", { cwd: config.cwd, mcpServers: servers }, SESSION_TIMEOUT_MS));
    } catch (error) {
      this.#bridgeTools.delete(key);
      throw error;
    }
    const sessionId = getString(response, "sessionId");
    if (!sessionId) {
      this.#bridgeTools.delete(key);
      throw new AppServerError(`${this.#options.label} no devolvió una sesión.`, -32603);
    }
    this.#rememberModels(response);
    const thread: AcpThread = {
      id: sessionId,
      ...withoutTools(config),
      sentInstructions: null,
      appliedModel: null,
      appliedEffort: null,
      configOptions: configOptionsOf(response),
      key,
      turn: null,
      replaying: false,
    };
    this.#threads.set(sessionId, thread);
    this.#bridgeThreads.set(key, sessionId);
    return { thread: { id: sessionId } };
  }

  async #resumeThread(params: unknown): Promise<unknown> {
    const threadId = getString(params, "threadId");
    if (!threadId) throw new AppServerError("Falta la conversación que se quiere retomar.", -32602);
    const config = threadConfig(params);
    const existing = this.#threads.get(threadId);
    if (existing) {
      Object.assign(existing, withoutTools(config));
      this.#bridgeTools.set(existing.key, config.tools);
      return { thread: { id: threadId } };
    }
    if (this.#capabilities.loadSession !== true && !getRecord(getRecord(this.#capabilities, "sessionCapabilities"), "resume")) {
      throw new AppServerError(`${this.#options.label} no puede retomar conversaciones anteriores.`, -32601);
    }
    const key = randomBytes(12).toString("hex");
    const servers = await this.#mcpServers(key, config.tools, config.shared);
    const thread: AcpThread = {
      id: threadId,
      ...withoutTools(config),
      sentInstructions: null,
      appliedModel: null,
      appliedEffort: null,
      configOptions: [],
      key,
      turn: null,
      replaying: true,
    };
    this.#threads.set(threadId, thread);
    this.#bridgeThreads.set(key, threadId);
    // «resume» retoma sin repetir la conversación; «load» la repite como avisos, que se ignoran (ya están en ClosedBot).
    const method = getRecord(getRecord(this.#capabilities, "sessionCapabilities"), "resume") ? "session/resume" : "session/load";
    try {
      const response = await this.#withAuth(() => this.#call(method, { sessionId: threadId, cwd: config.cwd, mcpServers: servers }, SESSION_TIMEOUT_MS));
      this.#rememberModels(response, { current: false });
      thread.configOptions = configOptionsOf(response);
    } catch (error) {
      this.#threads.delete(threadId);
      this.#bridgeThreads.delete(key);
      this.#bridgeTools.delete(key);
      throw error;
    } finally {
      thread.replaying = false;
    }
    return { thread: { id: threadId } };
  }

  async #closeThread(params: unknown): Promise<unknown> {
    const threadId = getString(params, "threadId");
    const thread = threadId ? this.#threads.get(threadId) : undefined;
    if (!thread) return {};
    if (thread.turn) this.#cancelTurn(thread, thread.turn);
    this.#threads.delete(thread.id);
    this.#bridgeThreads.delete(thread.key);
    this.#bridgeTools.delete(thread.key);
    if (this.#canClose() && this.running) await this.#call("session/close", { sessionId: thread.id }, 10_000).catch(() => undefined);
    return {};
  }

  #startTurn(params: unknown): unknown {
    const threadId = getString(params, "threadId");
    const thread = threadId ? this.#threads.get(threadId) : undefined;
    if (!thread) throw new AppServerError("Esa conversación no está abierta.", -32602);
    if (thread.turn) throw new AppServerError(`${this.#options.label} todavía está respondiendo el mensaje anterior.`, -32000);
    const policy = getRecord(params, "sandboxPolicy");
    if (policy) thread.total = getString(policy, "type") === "dangerFullAccess";
    const model = getString(params, "model");
    if (model) thread.model = model;
    const effort = getString(params, "effort");
    if (effort) thread.effort = effort;
    const text = getArray(params, "input")
      .filter(isRecord)
      .map((item) => (item.type === "text" ? (getString(item, "text") ?? "") : ""))
      .filter(Boolean)
      .join("\n\n");
    const turn: AcpTurn = { id: randomUUID(), itemId: null, text: "", count: 0, tools: new Map(), cancelled: false, finished: false };
    thread.turn = turn;
    this.#emitNotification("turn/started", { threadId: thread.id, turn: { id: turn.id, status: "inProgress" } });
    void this.#runTurn(thread, turn, this.#composePrompt(thread, text));
    return { turn: { id: turn.id, status: "inProgress" } };
  }

  #interrupt(params: unknown): unknown {
    const threadId = getString(params, "threadId");
    const thread = threadId ? this.#threads.get(threadId) : undefined;
    if (thread?.turn) this.#cancelTurn(thread, thread.turn);
    return {};
  }

  #cancelTurn(thread: AcpThread, turn: AcpTurn): void {
    if (turn.cancelled || turn.finished) return;
    turn.cancelled = true;
    try {
      this.#send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: thread.id } });
    } catch {
      // El proceso ya no está: el turno se cierra igual.
    }
    // Si el agente no confirma la cancelación, el turno se da por interrumpido igual.
    setTimeout(() => this.#finishTurn(thread, turn, "interrupted", null), this.#options.cancelGraceMs ?? 15_000).unref();
  }

  async #runTurn(thread: AcpThread, turn: AcpTurn, prompt: string): Promise<void> {
    let status = "completed";
    let problem: string | null = null;
    try {
      await this.#applySettings(thread);
      // Un turno puede durar lo que el agente necesite: sin límite de tiempo (se detiene con «Detener»).
      const result = await this.#call("session/prompt", { sessionId: thread.id, prompt: [{ type: "text", text: prompt }] }, 0);
      this.#emitTurnUsage(thread, turn, result);
      const stop = getString(result, "stopReason");
      if (stop === "cancelled" || turn.cancelled) status = "interrupted";
      else if (stop === "refusal") problem = `${this.#options.label} se negó a responder ese mensaje.`;
      else if (stop === "max_tokens") problem = "La respuesta se cortó porque llegó al largo máximo.";
      else if (stop === "max_turn_requests") problem = `${this.#options.label} llegó al máximo de pasos seguidos en este turno.`;
    } catch (error) {
      if (turn.cancelled) status = "interrupted";
      else {
        status = "failed";
        problem = error instanceof Error ? error.message : String(error);
      }
    }
    this.#finishTurn(thread, turn, status, problem);
  }

  /**
   * Lo gastado en el turno, si el agente lo informa (`usage` de la respuesta, aún no estándar en ACP: los tokens
   * de este turno). Según el agente, la entrada incluye o no lo leído de caché y la salida, el razonamiento:
   * se deduce del total para no contarlo dos veces.
   */
  #emitTurnUsage(thread: AcpThread, turn: AcpTurn, result: unknown): void {
    const usage = getRecord(result, "usage");
    if (!usage) return;
    const count = (key: string): number => {
      const value = Number(usage[key]);
      return Number.isFinite(value) && value > 0 ? value : 0;
    };
    const reported = count("inputTokens");
    const cacheRead = count("cachedReadTokens");
    const cacheWrite = count("cachedWriteTokens");
    const thought = count("thoughtTokens");
    const total = count("totalTokens");
    const cacheApart = !total || total >= reported + count("outputTokens") + cacheRead + cacheWrite;
    const input = cacheApart ? reported : Math.max(0, reported - cacheRead);
    const thoughtApart = Boolean(total) && total >= reported + count("outputTokens") + thought + (cacheApart ? cacheRead + cacheWrite : 0);
    const output = count("outputTokens") + (thought && thoughtApart ? thought : 0);
    if (!input && !output && !cacheRead && !cacheWrite) return;
    const model = thread.appliedModel ?? modelChoices(this.#models).current ?? this.#options.label;
    this.#emitNotification("closedbot/tokenUsage", { threadId: thread.id, turnId: turn.id, turn: { model, input, cacheRead, cacheWrite, output } });
  }

  #finishTurn(thread: AcpThread, turn: AcpTurn, status: string, problem: string | null): void {
    if (turn.finished) return;
    turn.finished = true;
    this.#closeMessage(thread, turn);
    if (thread.turn === turn) thread.turn = null;
    if (problem) this.#emitNotification("error", { threadId: thread.id, turnId: turn.id, error: { message: problem }, willRetry: false });
    this.#emitNotification("turn/completed", { threadId: thread.id, turn: { id: turn.id, status } });
  }

  /** Las instrucciones de ClosedBot van al principio del primer mensaje (ACP no tiene «instrucciones de sistema»). */
  #composePrompt(thread: AcpThread, text: string): string {
    if (!thread.instructions || thread.sentInstructions === thread.instructions) return text;
    thread.sentInstructions = thread.instructions;
    return [
      "<instrucciones_de_closedbot>",
      "Estas son tus instrucciones permanentes en ClosedBot. Síguelas durante toda la conversación, aunque no se repitan.",
      "",
      thread.instructions,
      "</instrucciones_de_closedbot>",
      "",
      text,
    ].join("\n");
  }

  /** Modelo y nivel de razonamiento del agente, si cambiaron desde el último turno. */
  async #applySettings(thread: AcpThread): Promise<void> {
    const { choices, current } = modelChoices(this.#models);
    const { model, effort } = resolveModel(choices, current, thread.model, thread.effort);
    if (model && model !== thread.appliedModel) {
      const option = findConfigOption(thread.configOptions, "model");
      try {
        if (option) await this.#call("session/set_config_option", { sessionId: thread.id, configId: option, value: model }, 30_000);
        else await this.#call("session/set_model", { sessionId: thread.id, modelId: model }, 30_000);
      } catch (error) {
        this.#diagnostic(`No pude elegir el modelo ${model}: ${error instanceof Error ? error.message : String(error)}`);
      }
      thread.appliedModel = model;
      // Al cambiar de modelo, el agente puede volver al nivel de ese modelo: se fija otra vez.
      thread.appliedEffort = null;
    }
    if (effort && effort !== thread.appliedEffort) {
      const option = findConfigOption(thread.configOptions, "thought_level");
      if (option) {
        try {
          await this.#call("session/set_config_option", { sessionId: thread.id, configId: option, value: effort }, 30_000);
        } catch (error) {
          this.#diagnostic(`No pude cambiar el razonamiento a ${effort}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      thread.appliedEffort = effort;
    }
  }

  #rememberModels(response: unknown, options: { current?: boolean } = {}): void {
    this.#models = mergeSessionModels(this.#models, response, options);
  }

  // ---------- uso del plan ----------

  async #readUsage(): Promise<unknown> {
    const unsupported = () => new AppServerError(`${this.#options.label} no implementa account/rateLimits/read.`, -32601);
    if (this.#options.usage === "grok") {
      // Como al abrir una sesión: con la sesión guardada de «grok login», sin abrir el navegador.
      await this.#authenticateQuietly().catch(() => undefined);
      try {
        return { rateLimits: grokUsage(await this.#withAuth(() => this.#call("_x.ai/billing", {}, USAGE_TIMEOUT_MS))) };
      } catch (error) {
        if (error instanceof AppServerError && error.code === -32601) throw unsupported();
        throw error;
      }
    }
    if (this.#options.usage !== "antigravity" || this.#usageUnsupported) throw unsupported();
    if (!this.#usageSession) {
      const opening = this.#openUsageSession();
      this.#usageSession = opening;
      opening.catch(() => {
        if (this.#usageSession === opening) this.#usageSession = null;
      });
    }
    const sessionId = await this.#usageSession;
    const reply = { text: "", modelTurn: false };
    this.#usageReplies.set(sessionId, reply);
    try {
      await this.#call("session/prompt", { sessionId, prompt: [{ type: "text", text: "/usage" }] }, USAGE_TIMEOUT_MS);
    } catch (error) {
      // La próxima lectura abre otra sesión (esta pudo quedar ocupada o cerrarse).
      this.#usageSession = null;
      throw error;
    } finally {
      this.#usageReplies.delete(sessionId);
    }
    const limits = antigravityUsage(reply.text);
    if (reply.modelTurn || !limits.available) {
      // Esta versión no conoce «/usage» (o lo mandó al modelo): no se vuelve a pedir en este proceso.
      this.#usageUnsupported = reply.modelTurn ? "«/usage» pasó por el modelo" : "respuesta de «/usage» desconocida";
      this.#diagnostic(`No pude leer el uso del plan: ${this.#usageUnsupported}.`);
      throw unsupported();
    }
    return { rateLimits: limits };
  }

  async #openUsageSession(): Promise<string> {
    const cwd = join(tmpdir(), `closedbot-${this.provider}-uso`);
    mkdirSync(cwd, { recursive: true });
    const response = await this.#withAuth(() => this.#call("session/new", { cwd, mcpServers: [] }, SESSION_TIMEOUT_MS));
    const sessionId = getString(response, "sessionId");
    if (!sessionId) throw new AppServerError(`${this.#options.label} no devolvió una sesión.`, -32603);
    return sessionId;
  }

  /** Lo que llega de la sesión de «/usage»: el texto, y si en vez de contestarlo solo pasó al modelo. */
  #collectUsage(sessionId: string, reply: { text: string; modelTurn: boolean }, update: Record<string, unknown> | null): void {
    switch (getString(update, "sessionUpdate")) {
      case "agent_message_chunk":
        reply.text += contentText(getRecord(update, "content"));
        return;
      case "agent_thought_chunk":
      case "tool_call":
        if (reply.modelTurn) return;
        reply.modelTurn = true;
        try {
          this.#send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
        } catch {
          // El proceso ya no está.
        }
        return;
    }
  }

  /** Se autentica con lo guardado (sin abrir el navegador), si todavía no lo hizo y hay cómo. */
  async #authenticateQuietly(): Promise<void> {
    if (this.#authenticated) return;
    const method = (this.#options.authMethods ?? []).find((id) => this.#authMethods.includes(id));
    if (!method) return;
    await this.#call("authenticate", { methodId: method }, SESSION_TIMEOUT_MS);
    this.#authenticated = true;
  }

  #canClose(): boolean {
    return Boolean(getRecord(getRecord(this.#capabilities, "sessionCapabilities"), "close"));
  }

  /**
   * Abre la sesión; si el agente contesta que falta iniciar sesión y hay un método que no necesita el
   * navegador (la sesión guardada), se autentica y lo intenta otra vez.
   */
  async #withAuth<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof SignInRequiredError || !isAuthError(error)) throw error;
      const method = this.#authenticated ? null : (this.#options.authMethods ?? []).find((id) => this.#authMethods.includes(id));
      if (!method) throw this.#signInNeeded(error);
      try {
        await this.#call("authenticate", { methodId: method }, SESSION_TIMEOUT_MS);
      } catch (authError) {
        throw authError instanceof SignInRequiredError ? authError : this.#signInNeeded(authError);
      }
      this.#authenticated = true;
      try {
        return await run();
      } catch (retryError) {
        throw isAuthError(retryError) && !(retryError instanceof SignInRequiredError) ? this.#signInNeeded(retryError) : retryError;
      }
    }
  }

  #signInNeeded(error: unknown): AppServerError {
    const detail = error instanceof Error ? error.message : String(error);
    return new AppServerError(
      `${this.#options.label} no tiene la sesión iniciada: entra en Ajustes y pulsa «Iniciar sesión». (${detail})`,
      error instanceof AppServerError ? error.code : -32000,
    );
  }

  // ---------- mensajes del agente ----------

  #handleMessage(message: RpcMessage): void {
    if ("method" in message) {
      if ("id" in message && message.id !== undefined) {
        this.#handleAgentRequest(message.id, message.method, message.params);
      } else if (message.method === "session/update") {
        this.#handleUpdate(message.params);
      }
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    if (pending.timeout) clearTimeout(pending.timeout);
    this.#pending.delete(message.id);
    if (message.error && isRecord(message.error)) {
      const code = typeof message.error.code === "number" ? message.error.code : -1;
      const text = typeof message.error.message === "string" ? message.error.message : "Error desconocido";
      const data = message.error.data;
      // Algunos agentes ponen el detalle útil en data.
      const extra = typeof data === "string" ? data : isRecord(data) ? (getString(data, "message") ?? getString(data, "details")) : null;
      pending.reject(new AppServerError(extra && !text.includes(extra) ? `${text}: ${extra}` : text, code, data));
      return;
    }
    pending.resolve(message.result);
  }

  #handleUpdate(params: unknown): void {
    const sessionId = getString(params, "sessionId") ?? "";
    const usage = this.#usageReplies.get(sessionId);
    if (usage) {
      this.#collectUsage(sessionId, usage, getRecord(params, "update"));
      return;
    }
    const thread = this.#threads.get(sessionId);
    const update = getRecord(params, "update");
    if (!thread || !update || thread.replaying) return;
    if (getString(update, "sessionUpdate") === "config_option_update") {
      const options = getArray(update, "configOptions").filter(isRecord);
      if (options.length) thread.configOptions = options;
      return;
    }
    const turn = thread.turn;
    if (!turn || turn.finished) return;
    switch (getString(update, "sessionUpdate")) {
      case "agent_message_chunk": {
        const text = contentText(getRecord(update, "content"));
        if (!text) return;
        if (!turn.itemId) {
          turn.count += 1;
          turn.itemId = `${turn.id}-mensaje-${turn.count}`;
          turn.text = "";
        }
        turn.text += text;
        this.#emitNotification("item/agentMessage/delta", { threadId: thread.id, turnId: turn.id, itemId: turn.itemId, delta: text });
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        const id = getString(update, "toolCallId");
        if (!id) return;
        this.#closeMessage(thread, turn);
        const known = turn.tools.get(id);
        const call: ToolCallState = known ?? { title: "", kind: "other", status: "pending", rawInput: null, locations: [], reported: false };
        call.title = getString(update, "title") ?? call.title;
        call.kind = getString(update, "kind") ?? call.kind;
        call.status = getString(update, "status") ?? call.status;
        if (update.rawInput !== undefined) call.rawInput = update.rawInput;
        const locations = getArray(update, "locations")
          .filter(isRecord)
          .map((location) => getString(location, "path") ?? "")
          .filter(Boolean);
        if (locations.length) call.locations = locations;
        turn.tools.set(id, call);
        if ((call.status === "completed" || call.status === "failed") && !call.reported) {
          call.reported = true;
          this.#reportTool(thread, turn, id, call);
        }
        return;
      }
      default:
        // Pensamientos, planes, comandos disponibles, modos y uso: no se muestran en el chat.
        return;
    }
  }

  /** Cierra el mensaje del agente en curso (el texto que viene después de una herramienta es otro mensaje). */
  #closeMessage(thread: AcpThread, turn: AcpTurn): void {
    if (!turn.itemId) return;
    this.#emitNotification("item/completed", {
      threadId: thread.id,
      turnId: turn.id,
      item: { id: turn.itemId, type: "agentMessage", text: turn.text },
    });
    turn.itemId = null;
    turn.text = "";
  }

  /** Deja una línea de actividad («Ejecutó…», «Modificó…»), igual que con Codex. */
  #reportTool(thread: AcpThread, turn: AcpTurn, id: string, call: ToolCallState): void {
    if (call.kind === "think" || call.kind === "read" || call.kind === "search") return;
    if (TEAM_TOOL_PATTERN.test(call.title) || (isRecord(call.rawInput) && TEAM_TOOL_PATTERN.test(String(call.rawInput.server ?? "")))) return;
    const itemId = `${turn.id}-herramienta-${id}`;
    const input = isRecord(call.rawInput) ? call.rawInput : {};
    const command = getString(input, "command") ?? (Array.isArray(input.command) ? input.command.join(" ") : null);
    let item: Record<string, unknown>;
    if (call.status === "failed") {
      // No se hizo (por ejemplo, se negó el permiso): que la línea no diga «Ejecutó» ni «Modificó».
      const detail = command ?? call.locations[0] ?? null;
      item = { id: itemId, type: "toolCall", tool: `${call.title || "Herramienta"} (no se hizo)`, input: detail ? { description: detail } : {} };
    } else if (call.kind === "execute") {
      item = { id: itemId, type: "commandExecution", command: command ?? call.title };
    } else if ((call.kind === "edit" || call.kind === "delete" || call.kind === "move") && call.locations.length) {
      item = { id: itemId, type: "fileChange", changes: call.locations.map((path) => ({ path })) };
    } else {
      item = { id: itemId, type: "toolCall", tool: call.title || "herramienta", input };
    }
    this.#emitNotification("item/completed", { threadId: thread.id, turnId: turn.id, item });
  }

  #handleAgentRequest(id: RequestId, method: string, params: unknown): void {
    if (method === "session/request_permission") {
      this.#answerPermission(id, params);
      return;
    }
    // Archivos y terminal no se prestan (no se anunciaron en initialize).
    this.#sendError(id, -32601, `ClosedBot no implementa ${method}.`);
  }

  /**
   * Permisos, sin preguntar a nadie (los agentes trabajan solos): con acceso total, todo; si no, todo
   * menos ejecutar comandos y tocar archivos fuera de sus carpetas. Se elige «permitir una vez» para no
   * dejar permisos guardados en la configuración del propio agente.
   */
  #answerPermission(id: RequestId, params: unknown): void {
    const thread = this.#threads.get(getString(params, "sessionId") ?? "");
    const options = getArray(params, "options").filter(isRecord);
    const pick = (...kinds: string[]) => {
      for (const kind of kinds) {
        const option = options.find((entry) => entry.kind === kind && typeof entry.optionId === "string");
        if (option) return option.optionId as string;
      }
      return null;
    };
    if (!thread || !thread.turn || thread.turn.cancelled) {
      this.#sendResult(id, { outcome: { outcome: "cancelled" } });
      return;
    }
    const allowed = permissionAllowed(thread, getRecord(params, "toolCall"));
    const optionId = allowed ? pick("allow_once", "allow_always") : pick("reject_once", "reject_always");
    if (!allowed) {
      const title = getString(getRecord(params, "toolCall"), "title") ?? "una acción";
      this.#diagnostic(`Negué «${title}»: el agente no tiene acceso total.`);
    }
    this.#sendResult(id, optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } });
  }

  // ---------- puente MCP de las herramientas del equipo ----------

  async #mcpServers(key: string, tools: McpToolSpec[], shared: SharedMcpServer[] = []): Promise<unknown[]> {
    this.#bridgeTools.set(key, tools);
    // Los de su equipo, como los pide ACP (los remotos solo si el programa dice que los acepta).
    const http = getRecord(getRecord(this.#capabilities, "mcpCapabilities"), "http") !== null || getRecord(this.#capabilities, "mcpCapabilities")?.http === true;
    const team = shared.flatMap((server): Array<Record<string, unknown>> =>
      server.transport === "stdio"
        ? [{ name: server.name, command: server.command, args: server.args, env: Object.entries(server.env).map(([name, value]) => ({ name, value })) }]
        : http
          ? [{ type: "http", name: server.name, url: server.url, headers: Object.entries(server.headers).map(([name, value]) => ({ name, value })) }]
          : [],
    );
    if (!tools.length) return team;
    const bridge = await this.#ensureBridge();
    const env = BRIDGE_ENV.filter((name) => process.env[name] !== undefined).map((name) => ({ name, value: String(process.env[name]) }));
    env.push({ name: "CLOSEDBOT_BRIDGE", value: bridge.path }, { name: "CLOSEDBOT_BRIDGE_TOKEN", value: bridge.token }, { name: "CLOSEDBOT_BRIDGE_KEY", value: key });
    return [{ name: TEAM_NAMESPACE, command: this.#options.nodePath ?? process.execPath, args: [this.#options.bridgeScript ?? DEFAULT_BRIDGE], env }, ...team];
  }

  #ensureBridge(): Promise<{ path: string; token: string }> {
    if (this.#bridge) return Promise.resolve(this.#bridge);
    this.#bridgeStarting ??= new Promise<{ path: string; token: string }>((resolveBridge, reject) => {
      const token = randomBytes(24).toString("hex");
      const name = `closedbot-${process.pid}-${randomBytes(6).toString("hex")}`;
      const path = process.platform === "win32" ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
      const sockets = new Set<Socket>();
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        this.#onBridgeConnection(socket, token);
      });
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        server.on("error", (error) => this.#diagnostic(`Puente de herramientas: ${error.message}`));
        this.#bridge = { server, path, token, sockets };
        resolveBridge({ path, token });
      });
    }).finally(() => {
      this.#bridgeStarting = null;
    });
    return this.#bridgeStarting;
  }

  #closeBridge(): void {
    const bridge = this.#bridge;
    this.#bridge = null;
    if (!bridge) return;
    bridge.server.close();
    // Las conexiones abiertas de los puentes también se cortan: así esos procesos terminan.
    for (const socket of bridge.sockets) socket.destroy();
    bridge.sockets.clear();
    if (process.platform !== "win32") rmSync(bridge.path, { force: true });
  }

  #onBridgeConnection(socket: Socket, token: string): void {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 8 * 1024 * 1024) {
        socket.destroy();
        return;
      }
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        if (!line) continue;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          socket.destroy();
          return;
        }
        if (!isRecord(message) || !sameSecret(message.token, token)) {
          socket.destroy();
          return;
        }
        void this.#handleBridgeMessage(socket, message);
      }
    });
    socket.on("error", () => undefined);
  }

  async #handleBridgeMessage(socket: Socket, message: Record<string, unknown>): Promise<void> {
    const reply = (body: Record<string, unknown>) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify({ id: message.id, ...body })}\n`);
    };
    const key = getString(message, "key") ?? "";
    const tools = this.#bridgeTools.get(key);
    if (!tools) {
      reply({ error: "Esta sesión de ClosedBot ya no existe." });
      return;
    }
    if (message.type === "tools") {
      reply({ tools });
      return;
    }
    if (message.type !== "call") {
      reply({ error: "Petición desconocida." });
      return;
    }
    const tool = getString(message, "tool") ?? "";
    if (!tools.some((entry) => entry.name === tool)) {
      reply({ result: { content: [{ type: "text", text: `No existe la herramienta ${tool}.` }], isError: true } });
      return;
    }
    const threadId = this.#bridgeThreads.get(key);
    const thread = threadId ? this.#threads.get(threadId) : undefined;
    if (!thread) {
      reply({ result: { content: [{ type: "text", text: "La conversación todavía no está lista; vuelve a intentarlo." }], isError: true } });
      return;
    }
    try {
      const result = await this.#serverRequest("item/tool/call", {
        threadId: thread.id,
        turnId: thread.turn?.id ?? randomUUID(),
        callId: randomUUID(),
        namespace: TEAM_NAMESPACE,
        tool,
        arguments: isRecord(message.arguments) ? message.arguments : {},
      });
      reply({ result: toMcpResult(result) });
    } catch (error) {
      reply({ result: { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true } });
    }
  }

  #serverRequest(method: string, params: unknown): Promise<unknown> {
    const id = `acp-${randomUUID()}`;
    return new Promise((resolveRequest, reject) => {
      this.#serverPending.set(id, { resolve: resolveRequest, reject });
      this.emit("request", { id, method, params });
    });
  }

  // ---------- transporte ----------

  #call(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolveCall, reject) => {
      const timeout = timeoutMs
        ? setTimeout(() => {
            this.#pending.delete(id);
            reject(new Error(`${this.#options.label} no respondió a tiempo (${method}).`));
          }, timeoutMs)
        : null;
      this.#pending.set(id, { resolve: resolveCall, reject, timeout });
      try {
        this.#send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        if (timeout) clearTimeout(timeout);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  #sendResult(id: RequestId, result: unknown): void {
    try {
      this.#send({ jsonrpc: "2.0", id, result });
    } catch {
      // El proceso terminó entre medio.
    }
  }

  #sendError(id: RequestId, code: number, message: string): void {
    try {
      this.#send({ jsonrpc: "2.0", id, error: { code, message } });
    } catch {
      // El proceso terminó entre medio.
    }
  }

  #send(message: unknown): void {
    if (!this.running || !this.#process) throw new Error(`${this.#options.label} no está en marcha.`);
    this.#process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #emitNotification(method: string, params: unknown): void {
    this.emit("notification", { method, params });
  }

  #diagnostic(text: string): void {
    const now = Date.now();
    if (now - this.#diagnostics.windowStart > DIAGNOSTIC_WINDOW_MS) this.#diagnostics = { windowStart: now, count: 0 };
    this.#diagnostics.count += 1;
    if (this.#diagnostics.count > DIAGNOSTIC_BURST) return;
    this.emit("diagnostic", redactDiagnostic(text));
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
    for (const pending of this.#serverPending.values()) pending.reject(error);
    this.#serverPending.clear();
  }

  #fail(error: Error, child: ChildProcessWithoutNullStreams): void {
    if (this.#process !== child) return;
    this.#process = null;
    this.#rejectAll(error);
    for (const thread of this.#threads.values()) {
      if (thread.turn) this.#finishTurn(thread, thread.turn, "failed", null);
    }
    this.#threads.clear();
    this.#bridgeThreads.clear();
    this.#bridgeTools.clear();
    this.#usageSession = null;
    this.#usageReplies.clear();
    this.#closeBridge();
    if (child.exitCode === null) stopProcessTree(child);
    if (!this.#stopping) this.emit("exit", error);
  }
}

// ---------- ayudas ----------

function threadConfig(params: unknown): ThreadConfig {
  const cwd = getString(params, "cwd") ?? process.cwd();
  const roots = getArray(params, "runtimeWorkspaceRoots").filter((root): root is string => typeof root === "string");
  return {
    cwd,
    roots: roots.length ? roots : [cwd],
    total: getString(params, "sandbox") === "danger-full-access",
    instructions: getString(params, "developerInstructions") ?? "",
    model: getString(params, "model"),
    effort: getString(params, "effort"),
    tools: teamTools(params),
    shared: sharedFromParams(params),
  };
}

function withoutTools(config: ThreadConfig): Omit<ThreadConfig, "tools"> {
  const { tools: _tools, ...rest } = config;
  return rest;
}

/** Las herramientas de ClosedBot que pidió el orquestador, en el formato de MCP. */
function teamTools(params: unknown): McpToolSpec[] {
  const tools: McpToolSpec[] = [];
  for (const group of getArray(params, "dynamicTools")) {
    if (!isRecord(group) || group.name !== TEAM_NAMESPACE) continue;
    for (const entry of getArray(group, "tools")) {
      if (!isRecord(entry) || typeof entry.name !== "string") continue;
      tools.push({
        name: entry.name,
        description: getString(entry, "description") ?? "",
        inputSchema: getRecord(entry, "inputSchema") ?? { type: "object", properties: {} },
      });
    }
  }
  return tools;
}

function configOptionsOf(response: unknown): Record<string, unknown>[] {
  return getArray(response, "configOptions").filter(isRecord);
}

/** Id de la opción de la sesión para esa categoría («model», «thought_level»), si el agente la tiene. */
function findConfigOption(options: Record<string, unknown>[], category: "model" | "thought_level"): string | null {
  const match = findOption(options, category);
  return match ? getString(match, "id") : null;
}

function toMcpResult(result: unknown): { content: Array<{ type: "text"; text: string }>; isError: boolean } {
  if (!isRecord(result)) return { content: [{ type: "text", text: String(result ?? "") }], isError: false };
  const content = getArray(result, "contentItems")
    .filter(isRecord)
    .filter((item) => item.type === "inputText" && typeof item.text === "string")
    .map((item) => ({ type: "text" as const, text: String(item.text) }));
  return { content, isError: result.success === false };
}

function contentText(content: Record<string, unknown> | null): string {
  if (!content) return "";
  if (content.type === "text") return getString(content, "text") ?? "";
  // Enlaces o recursos que manda como parte de la respuesta: se muestran como texto.
  if (content.type === "resource_link") return getString(content, "uri") ?? "";
  return "";
}

function permissionAllowed(thread: AcpThread, toolCall: Record<string, unknown> | null): boolean {
  if (thread.total) return true;
  const kind = getString(toolCall, "kind") ?? "other";
  if (kind === "execute") return false;
  if (kind === "edit" || kind === "delete" || kind === "move") {
    const paths = getArray(toolCall, "locations")
      .filter(isRecord)
      .map((location) => getString(location, "path") ?? "")
      .filter(Boolean);
    return paths.length > 0 && paths.every((path) => thread.roots.some((root) => isInside(root, isAbsolute(path) ? path : resolve(thread.cwd, path))));
  }
  return true;
}

export function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isAuthError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof AppServerError && error.code === -32000) return true;
  return /auth|log ?in|sign ?in|credential|api key|unauthori[sz]ed/i.test(error.message);
}

function sameSecret(given: unknown, expected: string): boolean {
  if (typeof given !== "string" || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
