// Derivado de OpenBot v0.1.11 (src/backend/app-server-client.ts), Copyright 2026 Norbert Bodziony,
// con licencia Apache-2.0 (ver licenses/OPENBOT-APACHE-2.0.txt y NOTICE).
// Modificado para ClosedBot: opciones de arranque, entorno configurable y mensajes en español.

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { AgentClient, ProviderId } from "./client.js";
import { JsonLineDecoder } from "./jsonl.js";
import { spawnTarget } from "./spawn.js";
import {
  type AppServerNotification,
  type AppServerRequest,
  isRecord,
  type RequestId,
  type RpcError,
  type RpcMessage,
} from "./protocol.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface ClientEvents {
  notification: [notification: AppServerNotification];
  request: [request: AppServerRequest];
  exit: [error: Error];
  diagnostic: [message: string];
}

export class AppServerError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AppServerError";
  }
}

export interface CodexClientOptions {
  /** Ejecutable de Codex (por defecto `codex`). */
  executable: string;
  /** Argumentos extra después de `app-server --listen stdio://`. */
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
}

/** Cliente JSON-RPC (una línea JSON por mensaje) del `codex app-server`. */
export class CodexAppServerClient extends EventEmitter<ClientEvents> implements AgentClient {
  readonly provider: ProviderId = "codex";
  readonly #options: CodexClientOptions;
  readonly #requestTimeoutMs: number;
  #decoder = new JsonLineDecoder();
  readonly #pending = new Map<RequestId, PendingRequest>();
  #process: ChildProcessWithoutNullStreams | null = null;
  #nextId = 1;
  #stopping = false;

  constructor(options: CodexClientOptions) {
    super();
    this.#options = options;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  get running(): boolean {
    return this.#process !== null && this.#process.exitCode === null;
  }

  start(): void {
    if (this.running) return;
    this.#stopping = false;
    this.#decoder = new JsonLineDecoder();
    const target = spawnTarget(this.#options.executable, ["app-server", "--listen", "stdio://", ...(this.#options.extraArgs ?? [])]);
    const child = spawn(target.file, target.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.#options.env ?? process.env,
      shell: target.shell,
      windowsHide: true,
    });
    this.#process = child;

    child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const message of this.#decoder.push(chunk)) this.#handleMessage(message);
      } catch (error) {
        this.#fail(new Error(`Error de protocolo de Codex: ${String(error)}`), child);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const diagnostic = chunk.toString("utf8").trim();
      if (diagnostic) this.emit("diagnostic", redactDiagnostic(diagnostic));
    });
    child.once("error", (error) => this.#fail(error, child));
    child.once("exit", (code, signal) => {
      const suffix = signal ? `la señal ${signal}` : `el código ${code ?? "desconocido"}`;
      this.#fail(new Error(`Codex app-server terminó con ${suffix}.`), child);
    });
  }

  async stop(): Promise<void> {
    const child = this.#process;
    if (!child) return;
    this.#stopping = true;
    this.#process = null;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Codex app-server detenido."));
    }
    this.#pending.clear();
    child.stdin.end();
    if (child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const forceKill = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(forceKill);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  request<T>(method: string, params: unknown, timeoutMs = this.#requestTimeoutMs): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Codex no respondió a tiempo: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve: (value) => resolve(value as T), reject, timeout });
      try {
        this.#write({ method, id, params });
      } catch (error) {
        clearTimeout(timeout);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params: unknown = {}): void {
    this.#write({ method, params });
  }

  respond(id: RequestId, result: unknown): void {
    this.#write({ id, result });
  }

  respondError(id: RequestId, error: RpcError): void {
    this.#write({ id, error });
  }

  #write(message: unknown): void {
    if (!this.running || !this.#process) throw new Error("Codex app-server no está en marcha.");
    this.#process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleMessage(message: RpcMessage): void {
    if ("method" in message) {
      if ("id" in message) {
        this.emit("request", { method: message.method, id: message.id, params: message.params });
      } else {
        this.emit("notification", { method: message.method, params: message.params });
      }
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.#pending.delete(message.id);
    if (message.error && isRecord(message.error)) {
      const code = typeof message.error.code === "number" ? message.error.code : -1;
      const text = typeof message.error.message === "string" ? message.error.message : "Error desconocido";
      pending.reject(new AppServerError(text, code, message.error.data));
      return;
    }
    pending.resolve(message.result);
  }

  #fail(error: Error, child: ChildProcessWithoutNullStreams): void {
    if (this.#process !== child) return;
    this.#process = null;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
    if (child.exitCode === null) child.kill("SIGTERM");
    if (!this.#stopping) this.emit("exit", error);
  }
}

export function redactDiagnostic(message: string): string {
  return message
    .replace(/(?:sk|sess|Bearer|token)[-_a-zA-Z0-9.=]{8,}/gi, "[oculto]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[correo-oculto]")
    .slice(0, 2_000);
}
