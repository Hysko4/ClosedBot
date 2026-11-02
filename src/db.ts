import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { AccessLevel, ProviderId } from "./providers/client.js";

export interface AgentRecord {
  id: string;
  name: string;
  role: string;
  instructions: string;
  provider: ProviderId;
  model: string | null;
  effort: string | null;
  access: AccessLevel;
  workspace: string;
  threadId: string | null;
  paused: boolean;
  preview: string;
  createdAt: number;
  updatedAt: number;
}

export type MessageRole = "user" | "assistant" | "teammate" | "activity" | "notice";
export type MessageStatus =
  | "queued"
  | "running"
  | "streaming"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled";

export interface MessageRecord {
  id: string;
  agentId: string;
  role: MessageRole;
  fromAgentId: string | null;
  toAgentIds: string[];
  replyTo: string | null;
  text: string;
  status: MessageStatus;
  turnId: string | null;
  deliveryId: string | null;
  createdAt: number;
  updatedAt: number;
}

export type DeliveryStatus = "queued" | "starting" | "running" | "completed" | "failed" | "interrupted" | "cancelled";

export interface DeliveryRecord {
  id: string;
  agentId: string;
  messageId: string;
  senderKind: "user" | "agent";
  senderAgentId: string | null;
  text: string;
  replyTo: string | null;
  hops: number;
  status: DeliveryStatus;
  turnId: string | null;
  error: string | null;
  idempotencyKey: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

type Row = Record<string, SQLInputValue>;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  access TEXT NOT NULL DEFAULT 'carpeta',
  workspace TEXT NOT NULL,
  thread_id TEXT,
  paused INTEGER NOT NULL DEFAULT 0,
  preview TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS agents_name ON agents(name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  from_agent_id TEXT,
  to_agent_ids TEXT NOT NULL DEFAULT '[]',
  reply_to TEXT,
  text TEXT NOT NULL,
  status TEXT NOT NULL,
  turn_id TEXT,
  delivery_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_agent ON messages(agent_id, seq);
CREATE TABLE IF NOT EXISTS deliveries (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  sender_kind TEXT NOT NULL,
  sender_agent_id TEXT,
  text TEXT NOT NULL,
  reply_to TEXT,
  hops INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  turn_id TEXT,
  error TEXT,
  idempotency_key TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS deliveries_queue ON deliveries(agent_id, status, seq);
CREATE INDEX IF NOT EXISTS deliveries_turn ON deliveries(turn_id);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT
);
`;

/** Almacenamiento local en SQLite (módulo `node:sqlite`, sin dependencias nativas). */
export class Store {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.#db.exec(SCHEMA);
    if (!this.getMeta("schema_version")) this.setMeta("schema_version", "1");
  }

  close(): void {
    this.#db.close();
  }

  transaction<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  // ---------- meta ----------

  getMeta(key: string): string | null {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined;
    return row ? String(row.value) : null;
  }

  setMeta(key: string, value: string): void {
    this.#db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  // ---------- agentes ----------

  listAgents(): AgentRecord[] {
    return (this.#db.prepare("SELECT * FROM agents ORDER BY created_at, rowid").all() as Row[]).map(toAgent);
  }

  getAgent(id: string): AgentRecord | null {
    const row = this.#db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Row | undefined;
    return row ? toAgent(row) : null;
  }

  findAgentByName(name: string): AgentRecord | null {
    const row = this.#db.prepare("SELECT * FROM agents WHERE name = ? COLLATE NOCASE").get(name) as Row | undefined;
    return row ? toAgent(row) : null;
  }

  createAgent(input: Omit<AgentRecord, "id" | "threadId" | "paused" | "preview" | "createdAt" | "updatedAt">): AgentRecord {
    const now = Date.now();
    const id = randomUUID();
    this.#db
      .prepare(
        `INSERT INTO agents (id, name, role, instructions, provider, model, effort, access, workspace, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.name, input.role, input.instructions, input.provider, input.model, input.effort, input.access, input.workspace, now, now);
    return this.getAgent(id) as AgentRecord;
  }

  updateAgent(
    id: string,
    patch: Partial<Pick<AgentRecord, "name" | "role" | "instructions" | "provider" | "model" | "effort" | "access" | "threadId" | "paused" | "preview">>,
  ): AgentRecord {
    const columns: Record<string, string> = {
      name: "name",
      role: "role",
      instructions: "instructions",
      provider: "provider",
      model: "model",
      effort: "effort",
      access: "access",
      threadId: "thread_id",
      paused: "paused",
      preview: "preview",
    };
    const sets: string[] = [];
    const values: SQLInputValue[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const column = columns[key];
      if (!column || value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(typeof value === "boolean" ? (value ? 1 : 0) : (value as SQLInputValue));
    }
    if (sets.length) {
      sets.push("updated_at = ?");
      values.push(Date.now(), id);
      this.#db.prepare(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    const agent = this.getAgent(id);
    if (!agent) throw new Error("Agente no encontrado.");
    return agent;
  }

  deleteAgent(id: string): void {
    this.#db.prepare("DELETE FROM agents WHERE id = ?").run(id);
  }

  // ---------- mensajes ----------

  listMessages(agentId: string, limit = 200, beforeSeq?: number): Array<MessageRecord & { seq: number }> {
    const rows = (
      beforeSeq
        ? this.#db
            .prepare("SELECT * FROM messages WHERE agent_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?")
            .all(agentId, beforeSeq, limit)
        : this.#db.prepare("SELECT * FROM messages WHERE agent_id = ? ORDER BY seq DESC LIMIT ?").all(agentId, limit)
    ) as Row[];
    return rows.reverse().map((row) => ({ ...toMessage(row), seq: Number(row.seq) }));
  }

  getMessage(id: string): MessageRecord | null {
    const row = this.#db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as Row | undefined;
    return row ? toMessage(row) : null;
  }

  insertMessage(input: {
    id?: string;
    agentId: string;
    role: MessageRole;
    text: string;
    status: MessageStatus;
    fromAgentId?: string | null;
    toAgentIds?: string[];
    replyTo?: string | null;
    turnId?: string | null;
    deliveryId?: string | null;
  }): MessageRecord {
    const now = Date.now();
    const id = input.id ?? randomUUID();
    this.#db
      .prepare(
        `INSERT INTO messages (id, agent_id, role, from_agent_id, to_agent_ids, reply_to, text, status, turn_id, delivery_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.agentId,
        input.role,
        input.fromAgentId ?? null,
        JSON.stringify(input.toAgentIds ?? []),
        input.replyTo ?? null,
        input.text,
        input.status,
        input.turnId ?? null,
        input.deliveryId ?? null,
        now,
        now,
      );
    return this.getMessage(id) as MessageRecord;
  }

  updateMessage(id: string, patch: Partial<Pick<MessageRecord, "text" | "status" | "turnId" | "deliveryId">>): MessageRecord | null {
    const sets: string[] = [];
    const values: SQLInputValue[] = [];
    if (patch.text !== undefined) {
      sets.push("text = ?");
      values.push(patch.text);
    }
    if (patch.status !== undefined) {
      sets.push("status = ?");
      values.push(patch.status);
    }
    if (patch.turnId !== undefined) {
      sets.push("turn_id = ?");
      values.push(patch.turnId);
    }
    if (patch.deliveryId !== undefined) {
      sets.push("delivery_id = ?");
      values.push(patch.deliveryId);
    }
    if (sets.length) {
      sets.push("updated_at = ?");
      values.push(Date.now(), id);
      this.#db.prepare(`UPDATE messages SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    return this.getMessage(id);
  }

  appendMessageText(id: string, delta: string): void {
    this.#db.prepare("UPDATE messages SET text = text || ?, updated_at = ? WHERE id = ?").run(delta, Date.now(), id);
  }

  deleteMessagesForAgent(agentId: string): void {
    this.#db.prepare("DELETE FROM messages WHERE agent_id = ?").run(agentId);
  }

  // ---------- entregas (cola) ----------

  enqueueDelivery(input: {
    agentId: string;
    messageId: string;
    senderKind: "user" | "agent";
    senderAgentId?: string | null;
    text: string;
    replyTo?: string | null;
    hops?: number;
    idempotencyKey?: string | null;
  }): { delivery: DeliveryRecord; created: boolean } {
    if (input.idempotencyKey) {
      const existing = this.#db.prepare("SELECT * FROM deliveries WHERE idempotency_key = ?").get(input.idempotencyKey) as Row | undefined;
      if (existing) return { delivery: toDelivery(existing), created: false };
    }
    const id = randomUUID();
    this.#db
      .prepare(
        `INSERT INTO deliveries (id, agent_id, message_id, sender_kind, sender_agent_id, text, reply_to, hops, status, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      )
      .run(
        id,
        input.agentId,
        input.messageId,
        input.senderKind,
        input.senderAgentId ?? null,
        input.text,
        input.replyTo ?? null,
        input.hops ?? 0,
        input.idempotencyKey ?? null,
        Date.now(),
      );
    return { delivery: this.getDelivery(id) as DeliveryRecord, created: true };
  }

  getDelivery(id: string): DeliveryRecord | null {
    const row = this.#db.prepare("SELECT * FROM deliveries WHERE id = ?").get(id) as Row | undefined;
    return row ? toDelivery(row) : null;
  }

  findDeliveryByIdempotencyKey(key: string): DeliveryRecord | null {
    const row = this.#db.prepare("SELECT * FROM deliveries WHERE idempotency_key = ?").get(key) as Row | undefined;
    return row ? toDelivery(row) : null;
  }

  nextQueued(agentId: string): DeliveryRecord | null {
    const row = this.#db
      .prepare("SELECT * FROM deliveries WHERE agent_id = ? AND status = 'queued' ORDER BY seq LIMIT 1")
      .get(agentId) as Row | undefined;
    return row ? toDelivery(row) : null;
  }

  listQueue(agentId: string): DeliveryRecord[] {
    return (
      this.#db
        .prepare("SELECT * FROM deliveries WHERE agent_id = ? AND status IN ('queued', 'starting', 'running') ORDER BY seq")
        .all(agentId) as Row[]
    ).map(toDelivery);
  }

  countQueued(agentId: string): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE agent_id = ? AND status = 'queued'").get(agentId) as Row;
    return Number(row.n);
  }

  agentsWithQueuedWork(): string[] {
    return (this.#db.prepare("SELECT DISTINCT agent_id FROM deliveries WHERE status = 'queued'").all() as Row[]).map((row) => String(row.agent_id));
  }

  updateDelivery(id: string, patch: Partial<Pick<DeliveryRecord, "status" | "turnId" | "error" | "startedAt" | "finishedAt">>): DeliveryRecord | null {
    const columns: Record<string, string> = {
      status: "status",
      turnId: "turn_id",
      error: "error",
      startedAt: "started_at",
      finishedAt: "finished_at",
    };
    const sets: string[] = [];
    const values: SQLInputValue[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const column = columns[key];
      if (!column || value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(value as SQLInputValue);
    }
    if (sets.length) {
      values.push(id);
      this.#db.prepare(`UPDATE deliveries SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    return this.getDelivery(id);
  }

  /** Tras un reinicio, los turnos que estaban en curso ya no pueden terminar. */
  reconcileUnfinished(): DeliveryRecord[] {
    const rows = (this.#db.prepare("SELECT * FROM deliveries WHERE status IN ('starting', 'running')").all() as Row[]).map(toDelivery);
    const now = Date.now();
    for (const delivery of rows) {
      this.updateDelivery(delivery.id, { status: "interrupted", error: "La app se reinició durante este turno.", finishedAt: now });
      this.updateMessage(delivery.messageId, { status: "interrupted" });
    }
    this.#db.prepare("UPDATE messages SET status = 'interrupted', updated_at = ? WHERE status = 'streaming'").run(now);
    return rows;
  }

  cancelQueuedForAgent(agentId: string): number {
    const queued = (this.#db.prepare("SELECT * FROM deliveries WHERE agent_id = ? AND status = 'queued'").all(agentId) as Row[]).map(toDelivery);
    for (const delivery of queued) {
      this.updateDelivery(delivery.id, { status: "cancelled", finishedAt: Date.now() });
      this.updateMessage(delivery.messageId, { status: "cancelled" });
    }
    return queued.length;
  }

  // ---------- sesiones ----------

  insertSession(tokenHash: string, expiresAt: number, userAgent: string | null): void {
    this.#db
      .prepare("INSERT INTO sessions (token_hash, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?)")
      .run(tokenHash, Date.now(), expiresAt, userAgent);
  }

  getSession(tokenHash: string): { expiresAt: number } | null {
    const row = this.#db.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?").get(tokenHash) as Row | undefined;
    return row ? { expiresAt: Number(row.expires_at) } : null;
  }

  deleteSession(tokenHash: string): void {
    this.#db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
  }

  deleteAllSessions(): void {
    this.#db.prepare("DELETE FROM sessions").run();
  }

  purgeExpiredSessions(now = Date.now()): void {
    this.#db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  }
}

function str(value: SQLInputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toAgent(row: Row): AgentRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    role: String(row.role ?? ""),
    instructions: String(row.instructions ?? ""),
    provider: String(row.provider) as ProviderId,
    model: str(row.model),
    effort: str(row.effort),
    access: (String(row.access) === "total" ? "total" : "carpeta") as AccessLevel,
    workspace: String(row.workspace),
    threadId: str(row.thread_id),
    paused: Number(row.paused) === 1,
    preview: String(row.preview ?? ""),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toMessage(row: Row): MessageRecord {
  let toAgentIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(row.to_agent_ids ?? "[]"));
    if (Array.isArray(parsed)) toAgentIds = parsed.filter((item): item is string => typeof item === "string");
  } catch {
    toAgentIds = [];
  }
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    role: String(row.role) as MessageRole,
    fromAgentId: str(row.from_agent_id),
    toAgentIds,
    replyTo: str(row.reply_to),
    text: String(row.text ?? ""),
    status: String(row.status) as MessageStatus,
    turnId: str(row.turn_id),
    deliveryId: str(row.delivery_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toDelivery(row: Row): DeliveryRecord {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    messageId: String(row.message_id),
    senderKind: String(row.sender_kind) === "agent" ? "agent" : "user",
    senderAgentId: str(row.sender_agent_id),
    text: String(row.text ?? ""),
    replyTo: str(row.reply_to),
    hops: Number(row.hops ?? 0),
    status: String(row.status) as DeliveryStatus,
    turnId: str(row.turn_id),
    error: str(row.error),
    idempotencyKey: str(row.idempotency_key),
    createdAt: Number(row.created_at),
    startedAt: row.started_at === null || row.started_at === undefined ? null : Number(row.started_at),
    finishedAt: row.finished_at === null || row.finished_at === undefined ? null : Number(row.finished_at),
  };
}
