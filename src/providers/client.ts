// Derivado de OpenBot v0.1.11 (src/backend/agent-client.ts), Copyright 2026 Norbert Bodziony,
// con licencia Apache-2.0 (ver licenses/OPENBOT-APACHE-2.0.txt y NOTICE).
// Modificado para ClosedBot: proveedores propios y nivel de acceso.

import type { AppServerNotification, AppServerRequest, RequestId, RpcError } from "./protocol.js";

export type ProviderId = "claude" | "codex" | "grok" | "gemini" | "demo";

/** Todos los proveedores, en el orden en que se muestran. */
export const PROVIDER_IDS: readonly ProviderId[] = ["claude", "codex", "grok", "gemini", "demo"];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

/** Nivel de acceso de un agente: solo su carpeta (por defecto) o el equipo completo. */
export type AccessLevel = "carpeta" | "total";

/**
 * Todos los proveedores hablan el mismo protocolo que el app-server de Codex
 * (thread/start, turn/start, item/agentMessage/delta, turn/completed...).
 * Claude y el modo demo lo emulan, así el orquestador trata a todos igual.
 */
export interface AgentClient {
  readonly provider: ProviderId;
  readonly running: boolean;
  start(): void;
  stop(): Promise<void>;
  request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
  notify(method: string, params?: unknown): void;
  respond(id: RequestId, result: unknown): void;
  respondError(id: RequestId, error: RpcError): void;
  on(event: "notification", listener: (notification: AppServerNotification) => void): this;
  on(event: "request", listener: (request: AppServerRequest) => void): this;
  on(event: "diagnostic", listener: (message: string) => void): this;
  once(event: "exit", listener: (error: Error) => void): this;
  removeAllListeners(): this;
}
