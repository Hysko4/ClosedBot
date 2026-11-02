// Derivado de OpenBot v0.1.11 (src/backend/protocol.ts), Copyright 2026 Norbert Bodziony,
// con licencia Apache-2.0 (ver licenses/OPENBOT-APACHE-2.0.txt y NOTICE).
// Modificado para Cuadrilla: tipos reducidos y ayudas adicionales.

export type RequestId = string | number;

export interface RpcRequest {
  method: string;
  id: RequestId;
  params?: unknown;
}

export interface RpcNotification {
  method: string;
  params?: unknown;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcResponse {
  id: RequestId;
  result?: unknown;
  error?: RpcError;
}

export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

/** Petición `item/tool/call` del protocolo app-server (herramientas dinámicas). */
export interface DynamicToolCallParams {
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
}

export interface DynamicToolResult {
  contentItems: Array<{ type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string }>;
  success: boolean;
}

export interface AppServerNotification {
  method: string;
  params: unknown;
}

export interface AppServerRequest {
  method: string;
  id: RequestId;
  params: unknown;
}

export interface ThreadResponse {
  thread: { id: string };
}

export interface TurnResponse {
  turn: { id: string; status?: string };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRpcMessage(value: unknown): value is RpcMessage {
  if (!isRecord(value)) return false;
  if ("method" in value) return typeof value.method === "string";
  return (
    (typeof value.id === "string" || typeof value.id === "number") &&
    ("result" in value || "error" in value)
  );
}

export function getString(record: unknown, key: string): string | null {
  return isRecord(record) && typeof record[key] === "string" ? record[key] : null;
}

export function getNumber(record: unknown, key: string): number | null {
  return isRecord(record) && typeof record[key] === "number" && Number.isFinite(record[key])
    ? record[key]
    : null;
}

export function getRecord(record: unknown, key: string): Record<string, unknown> | null {
  return isRecord(record) && isRecord(record[key]) ? record[key] : null;
}

export function getArray(record: unknown, key: string): unknown[] {
  return isRecord(record) && Array.isArray(record[key]) ? record[key] : [];
}

export function isDynamicToolCall(value: unknown): value is DynamicToolCallParams {
  return (
    isRecord(value) &&
    typeof value.threadId === "string" &&
    typeof value.turnId === "string" &&
    typeof value.callId === "string" &&
    (typeof value.namespace === "string" || value.namespace === null) &&
    typeof value.tool === "string"
  );
}
