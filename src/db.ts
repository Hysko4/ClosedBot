import { randomUUID } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { AccessLevel, ProviderId } from "./providers/client.js";
import type { Schedule } from "./schedule.js";

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
  /** Grupo en la barra lateral (como los proyectos de la app de referencia); vacío = sin grupo. */
  project: string;
  /**
   * Número de avatar (figura y color en la interfaz). Los automáticos van de 0 en adelante, distintos
   * para cada agente nuevo; desde AVATAR_CUSTOM_BASE son una figura y un color elegidos por el usuario.
   */
  avatar: number;
  /** Fijado arriba de la barra lateral. */
  pinned: boolean;
  /** Oculto de la barra lateral (sigue apareciendo al buscar). */
  hidden: boolean;
  /** Cómo lee en voz alta sus respuestas (voz, velocidad e idioma). */
  voice: VoiceSettings;
  /** Última vez que el usuario abrió la conversación (para el aviso de no leído). */
  readAt: number;
  /** Último mensaje del agente (o para el usuario) en su conversación. */
  lastAt: number;
  createdAt: number;
  updatedAt: number;
}

/** Ajustes de voz de un agente. `name` vacío = la mejor voz del equipo para el idioma; `lang` "auto" = detectar. */
export interface VoiceSettings {
  name: string;
  rate: number;
  lang: string;
  /** Lee en voz alta todas sus respuestas, no solo las de mensajes enviados hablando. */
  autoRead: boolean;
}

export const DEFAULT_VOICE: VoiceSettings = { name: "", rate: 1, lang: "auto", autoRead: false };

/** Desde aquí, el número de avatar es una figura y un color elegidos: base + figura × 100 + color. */
export const AVATAR_CUSTOM_BASE = 10_000;
export const AVATAR_MAX = 100_000;

/** decision = pregunta de opción múltiple al usuario; routine = aviso de que corrió una rutina. */
export type MessageRole = "user" | "assistant" | "teammate" | "activity" | "notice" | "decision" | "routine";
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
  /** Canal donde se ve el mensaje; null = la conversación privada con el agente. */
  channelId: string | null;
  role: MessageRole;
  fromAgentId: string | null;
  toAgentIds: string[];
  replyTo: string | null;
  text: string;
  status: MessageStatus;
  turnId: string | null;
  deliveryId: string | null;
  /** Datos extra según el rol (opciones de una decisión, rutina asociada…). */
  payload: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
}

export interface RoutineRecord {
  id: string;
  agentId: string;
  name: string;
  prompt: string;
  schedule: Schedule;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastDeliveryId: string | null;
  createdAt: number;
  updatedAt: number;
}

export type DeliveryStatus = "queued" | "starting" | "running" | "completed" | "failed" | "interrupted" | "cancelled";

export interface DeliveryRecord {
  id: string;
  agentId: string;
  /** Canal del que viene el encargo: lo que responda el agente se ve en ese canal. */
  channelId: string | null;
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

/** Canal: una conversación con varios agentes. El encargado responde salvo que se nombre a otro con @. */
export interface ChannelRecord {
  id: string;
  name: string;
  /** Para qué es el canal (opcional); los agentes lo ven. */
  topic: string;
  leadId: string | null;
  memberIds: string[];
  preview: string;
  readAt: number;
  /** Último mensaje de un agente en el canal (para el aviso de no leído). */
  lastAt: number;
  /** Fecha en que se movió a «Canales eliminados»; null si está activo. */
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
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
  project TEXT NOT NULL DEFAULT '',
  read_at INTEGER NOT NULL DEFAULT 0,
  avatar INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  voice TEXT,
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
  payload TEXT,
  channel_id TEXT,
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
  channel_id TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS deliveries_queue ON deliveries(agent_id, status, seq);
CREATE INDEX IF NOT EXISTS deliveries_turn ON deliveries(turn_id);
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER,
  last_run_at INTEGER,
  last_delivery_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS routines_due ON routines(enabled, next_run_at);
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  lead_agent_id TEXT,
  member_ids TEXT NOT NULL DEFAULT '[]',
  preview TEXT NOT NULL DEFAULT '',
  read_at INTEGER NOT NULL DEFAULT 0,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS channels_active_name ON channels(name COLLATE NOCASE) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT
);
`;

/** Columnas añadidas después de la 0.1: una base creada antes las recibe al abrirse (y `backfill` las rellena). */
const ADDED_COLUMNS: Array<{ table: string; column: string; ddl: string; backfill?: string }> = [
  { table: "agents", column: "project", ddl: "ALTER TABLE agents ADD COLUMN project TEXT NOT NULL DEFAULT ''" },
  { table: "agents", column: "read_at", ddl: "ALTER TABLE agents ADD COLUMN read_at INTEGER NOT NULL DEFAULT 0" },
  {
    table: "agents",
    column: "avatar",
    ddl: "ALTER TABLE agents ADD COLUMN avatar INTEGER NOT NULL DEFAULT 0",
    // Los agentes que ya existían reciben avatares distintos, por orden de creación.
    backfill: `UPDATE agents SET avatar = (
      SELECT COUNT(*) FROM agents b WHERE b.created_at < agents.created_at OR (b.created_at = agents.created_at AND b.rowid < agents.rowid)
    )`,
  },
  { table: "messages", column: "payload", ddl: "ALTER TABLE messages ADD COLUMN payload TEXT" },
  { table: "agents", column: "pinned", ddl: "ALTER TABLE agents ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0" },
  { table: "agents", column: "hidden", ddl: "ALTER TABLE agents ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0" },
  { table: "agents", column: "voice", ddl: "ALTER TABLE agents ADD COLUMN voice TEXT" },
  { table: "messages", column: "channel_id", ddl: "ALTER TABLE messages ADD COLUMN channel_id TEXT" },
  { table: "deliveries", column: "channel_id", ddl: "ALTER TABLE deliveries ADD COLUMN channel_id TEXT" },
];

/** Índices sobre columnas añadidas: se crean después de añadirlas. */
const ADDED_INDEXES = ["CREATE INDEX IF NOT EXISTS messages_channel ON messages(channel_id, seq)"];

const SCHEMA_VERSION = "4";

/** Roles cuyos mensajes cuentan como novedad para el aviso de no leído. */
const UNREAD_ROLES = "('assistant', 'teammate', 'notice', 'decision', 'routine')";
/** En un canal, los encargos entre agentes se ven una sola vez (como aviso), no como mensaje recibido. */
const CHANNEL_UNREAD_ROLES = "('assistant', 'notice', 'decision')";

/** Almacenamiento local en SQLite (módulo `node:sqlite`, sin dependencias nativas). */
export class Store {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.#db.exec(SCHEMA);
    this.#migrate();
  }

  #migrate(): void {
    for (const { table, column, ddl, backfill } of ADDED_COLUMNS) {
      const columns = this.#db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
      if (columns.some((row) => row.name === column)) continue;
      this.#db.exec(ddl);
      if (backfill) this.#db.exec(backfill);
    }
    for (const ddl of ADDED_INDEXES) this.#db.exec(ddl);
    if (this.getMeta("schema_version") !== SCHEMA_VERSION) this.setMeta("schema_version", SCHEMA_VERSION);
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

  /**
   * Cambia la carpeta de los agentes que estaban en `fromPrefix` (al renombrar la carpeta de datos).
   * Solo toca las rutas que empiezan así; devuelve cuántas cambió.
   */
  moveWorkspaces(fromPrefix: string, toPrefix: string): number {
    const result = this.#db
      .prepare("UPDATE agents SET workspace = ? || substr(workspace, ?) WHERE substr(workspace, 1, ?) = ?")
      .run(toPrefix, fromPrefix.length + 1, fromPrefix.length, fromPrefix);
    return Number(result.changes);
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
    return (this.#db.prepare(`${AGENT_SELECT} ORDER BY a.created_at, a.rowid`).all() as Row[]).map(toAgent);
  }

  getAgent(id: string): AgentRecord | null {
    const row = this.#db.prepare(`${AGENT_SELECT} WHERE a.id = ?`).get(id) as Row | undefined;
    return row ? toAgent(row) : null;
  }

  findAgentByName(name: string): AgentRecord | null {
    const row = this.#db.prepare(`${AGENT_SELECT} WHERE a.name = ? COLLATE NOCASE`).get(name) as Row | undefined;
    return row ? toAgent(row) : null;
  }

  createAgent(
    input: Omit<
      AgentRecord,
      "id" | "threadId" | "paused" | "preview" | "project" | "avatar" | "pinned" | "hidden" | "voice" | "readAt" | "lastAt" | "createdAt" | "updatedAt"
    > & {
      project?: string;
      /** Figura y color elegidos; si falta, el siguiente automático. */
      avatar?: number;
    },
  ): AgentRecord {
    const now = Date.now();
    const id = randomUUID();
    const avatar = input.avatar ?? this.#nextAutoAvatar();
    this.#db
      .prepare(
        `INSERT INTO agents (id, name, role, instructions, provider, model, effort, access, workspace, project, read_at, avatar, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.name, input.role, input.instructions, input.provider, input.model, input.effort, input.access, input.workspace, input.project ?? "", now, avatar, now, now);
    return this.getAgent(id) as AgentRecord;
  }

  /** Los avatares automáticos siguen su propia numeración: los elegidos a mano no la mueven. */
  #nextAutoAvatar(): number {
    const row = this.#db.prepare("SELECT COALESCE(MAX(avatar) + 1, 0) AS next FROM agents WHERE avatar < ?").get(AVATAR_CUSTOM_BASE) as Row;
    return Number(row.next ?? 0);
  }

  updateAgent(
    id: string,
    patch: Partial<
      Pick<
        AgentRecord,
        | "name"
        | "role"
        | "instructions"
        | "provider"
        | "model"
        | "effort"
        | "access"
        | "threadId"
        | "paused"
        | "preview"
        | "project"
        | "readAt"
        | "avatar"
        | "pinned"
        | "hidden"
        | "voice"
      >
    >,
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
      project: "project",
      readAt: "read_at",
      avatar: "avatar",
      pinned: "pinned",
      hidden: "hidden",
      voice: "voice",
    };
    const sets: string[] = [];
    const values: SQLInputValue[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const column = columns[key];
      if (!column || value === undefined) continue;
      sets.push(`${column} = ?`);
      if (key === "voice") values.push(JSON.stringify(value));
      else values.push(typeof value === "boolean" ? (value ? 1 : 0) : (value as SQLInputValue));
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

  /** La conversación privada con el agente (lo de los canales se ve en cada canal). */
  listMessages(agentId: string, limit = 200, beforeSeq?: number): Array<MessageRecord & { seq: number }> {
    const rows = (
      beforeSeq
        ? this.#db
            .prepare("SELECT * FROM messages WHERE agent_id = ? AND channel_id IS NULL AND seq < ? ORDER BY seq DESC LIMIT ?")
            .all(agentId, beforeSeq, limit)
        : this.#db.prepare("SELECT * FROM messages WHERE agent_id = ? AND channel_id IS NULL ORDER BY seq DESC LIMIT ?").all(agentId, limit)
    ) as Row[];
    return rows.reverse().map((row) => ({ ...toMessage(row), seq: Number(row.seq) }));
  }

  /** Lo que se ve en un canal: todo menos la copia que recibe cada agente de un encargo de otro. */
  listChannelMessages(channelId: string, limit = 200, beforeSeq?: number): Array<MessageRecord & { seq: number }> {
    const base = "SELECT * FROM messages WHERE channel_id = ? AND role <> 'teammate'";
    const rows = (
      beforeSeq
        ? this.#db.prepare(`${base} AND seq < ? ORDER BY seq DESC LIMIT ?`).all(channelId, beforeSeq, limit)
        : this.#db.prepare(`${base} ORDER BY seq DESC LIMIT ?`).all(channelId, limit)
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
    payload?: Record<string, unknown> | null;
    channelId?: string | null;
  }): MessageRecord {
    const now = Date.now();
    const id = input.id ?? randomUUID();
    this.#db
      .prepare(
        `INSERT INTO messages (id, agent_id, channel_id, role, from_agent_id, to_agent_ids, reply_to, text, status, turn_id, delivery_id, payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.agentId,
        input.channelId ?? null,
        input.role,
        input.fromAgentId ?? null,
        JSON.stringify(input.toAgentIds ?? []),
        input.replyTo ?? null,
        input.text,
        input.status,
        input.turnId ?? null,
        input.deliveryId ?? null,
        input.payload ? JSON.stringify(input.payload) : null,
        now,
        now,
      );
    return this.getMessage(id) as MessageRecord;
  }

  updateMessage(
    id: string,
    patch: Partial<Pick<MessageRecord, "text" | "status" | "turnId" | "deliveryId" | "payload">>,
  ): MessageRecord | null {
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
    if (patch.payload !== undefined) {
      sets.push("payload = ?");
      values.push(patch.payload ? JSON.stringify(patch.payload) : null);
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

  /** Borra la conversación privada con el agente; lo que dijo en los canales se queda. */
  deleteMessagesForAgent(agentId: string): void {
    this.#db.prepare("DELETE FROM messages WHERE agent_id = ? AND channel_id IS NULL").run(agentId);
  }

  /** Pasa a otro agente los mensajes del usuario en canales que guardaba uno que se va a eliminar. */
  moveChannelUserMessages(fromAgentId: string, toAgentId: string): void {
    this.#db
      .prepare("UPDATE messages SET agent_id = ? WHERE agent_id = ? AND channel_id IS NOT NULL AND role = 'user'")
      .run(toAgentId, fromAgentId);
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
    channelId?: string | null;
  }): { delivery: DeliveryRecord; created: boolean } {
    if (input.idempotencyKey) {
      const existing = this.#db.prepare("SELECT * FROM deliveries WHERE idempotency_key = ?").get(input.idempotencyKey) as Row | undefined;
      if (existing) return { delivery: toDelivery(existing), created: false };
    }
    const id = randomUUID();
    this.#db
      .prepare(
        `INSERT INTO deliveries (id, agent_id, message_id, sender_kind, sender_agent_id, text, reply_to, hops, status, idempotency_key, channel_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
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
        input.channelId ?? null,
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

  /** Cancela lo que esperaba turno en un canal (al moverlo a «Canales eliminados»). */
  cancelQueuedForChannel(channelId: string): DeliveryRecord[] {
    const queued = (this.#db.prepare("SELECT * FROM deliveries WHERE channel_id = ? AND status = 'queued'").all(channelId) as Row[]).map(toDelivery);
    for (const delivery of queued) {
      this.updateDelivery(delivery.id, { status: "cancelled", finishedAt: Date.now() });
      const message = this.getMessage(delivery.messageId);
      // El mensaje del usuario se queda como estaba: lo pudieron recibir otros agentes del canal.
      if (message && message.role !== "user") this.updateMessage(delivery.messageId, { status: "cancelled" });
    }
    return queued;
  }

  cancelQueuedForAgent(agentId: string): number {
    const queued = (this.#db.prepare("SELECT * FROM deliveries WHERE agent_id = ? AND status = 'queued'").all(agentId) as Row[]).map(toDelivery);
    for (const delivery of queued) {
      this.updateDelivery(delivery.id, { status: "cancelled", finishedAt: Date.now() });
      this.updateMessage(delivery.messageId, { status: "cancelled" });
    }
    return queued.length;
  }

  // ---------- canales ----------

  listChannels(options: { deleted?: boolean } = {}): ChannelRecord[] {
    const where = options.deleted ? "c.deleted_at IS NOT NULL ORDER BY c.deleted_at DESC" : "c.deleted_at IS NULL ORDER BY c.created_at, c.rowid";
    return (this.#db.prepare(`${CHANNEL_SELECT} WHERE ${where}`).all() as Row[]).map(toChannel);
  }

  getChannel(id: string): ChannelRecord | null {
    const row = this.#db.prepare(`${CHANNEL_SELECT} WHERE c.id = ?`).get(id) as Row | undefined;
    return row ? toChannel(row) : null;
  }

  /** Canal activo con ese nombre (sin distinguir mayúsculas). */
  findChannelByName(name: string): ChannelRecord | null {
    const row = this.#db.prepare(`${CHANNEL_SELECT} WHERE c.name = ? COLLATE NOCASE AND c.deleted_at IS NULL`).get(name) as Row | undefined;
    return row ? toChannel(row) : null;
  }

  createChannel(input: { name: string; topic: string; leadId: string | null; memberIds: string[] }): ChannelRecord {
    const now = Date.now();
    const id = randomUUID();
    this.#db
      .prepare(
        `INSERT INTO channels (id, name, topic, lead_agent_id, member_ids, read_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.name, input.topic, input.leadId, JSON.stringify(input.memberIds), now, now, now);
    return this.getChannel(id) as ChannelRecord;
  }

  updateChannel(
    id: string,
    patch: Partial<Pick<ChannelRecord, "name" | "topic" | "leadId" | "memberIds" | "preview" | "readAt" | "deletedAt">>,
  ): ChannelRecord {
    const columns: Record<string, string> = {
      name: "name",
      topic: "topic",
      leadId: "lead_agent_id",
      memberIds: "member_ids",
      preview: "preview",
      readAt: "read_at",
      deletedAt: "deleted_at",
    };
    const sets: string[] = [];
    const values: SQLInputValue[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const column = columns[key];
      if (!column || value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(key === "memberIds" ? JSON.stringify(value) : (value as SQLInputValue));
    }
    if (sets.length) {
      sets.push("updated_at = ?");
      values.push(Date.now(), id);
      this.#db.prepare(`UPDATE channels SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    const channel = this.getChannel(id);
    if (!channel) throw new Error("Canal no encontrado.");
    return channel;
  }

  /** Borra el canal para siempre, con sus mensajes. */
  deleteChannel(id: string): void {
    this.transaction(() => {
      this.#db.prepare("DELETE FROM messages WHERE channel_id = ?").run(id);
      this.#db.prepare("DELETE FROM deliveries WHERE channel_id = ? AND status NOT IN ('queued', 'starting', 'running')").run(id);
      this.#db.prepare("DELETE FROM channels WHERE id = ?").run(id);
    });
  }

  // ---------- rutinas ----------

  insertRoutine(input: { agentId: string; name: string; prompt: string; schedule: Schedule; nextRunAt: number | null }): RoutineRecord {
    const now = Date.now();
    const id = randomUUID();
    this.#db
      .prepare(
        `INSERT INTO routines (id, agent_id, name, prompt, schedule, enabled, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(id, input.agentId, input.name, input.prompt, JSON.stringify(input.schedule), input.nextRunAt, now, now);
    return this.getRoutine(id) as RoutineRecord;
  }

  getRoutine(id: string): RoutineRecord | null {
    const row = this.#db.prepare("SELECT * FROM routines WHERE id = ?").get(id) as Row | undefined;
    return row ? toRoutine(row) : null;
  }

  listRoutines(agentId?: string): RoutineRecord[] {
    const rows = (
      agentId
        ? this.#db.prepare("SELECT * FROM routines WHERE agent_id = ? ORDER BY created_at, rowid").all(agentId)
        : this.#db.prepare("SELECT * FROM routines ORDER BY created_at, rowid").all()
    ) as Row[];
    return rows.map(toRoutine);
  }

  dueRoutines(now: number): RoutineRecord[] {
    return (
      this.#db
        .prepare("SELECT * FROM routines WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at")
        .all(now) as Row[]
    ).map(toRoutine);
  }

  nextRoutineAt(): number | null {
    const row = this.#db.prepare("SELECT MIN(next_run_at) AS next FROM routines WHERE enabled = 1 AND next_run_at IS NOT NULL").get() as Row;
    return row.next === null || row.next === undefined ? null : Number(row.next);
  }

  updateRoutine(
    id: string,
    patch: Partial<Pick<RoutineRecord, "enabled" | "nextRunAt" | "lastRunAt" | "lastDeliveryId">>,
  ): RoutineRecord | null {
    const columns: Record<string, string> = {
      enabled: "enabled",
      nextRunAt: "next_run_at",
      lastRunAt: "last_run_at",
      lastDeliveryId: "last_delivery_id",
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
      this.#db.prepare(`UPDATE routines SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    return this.getRoutine(id);
  }

  deleteRoutine(id: string): void {
    this.#db.prepare("DELETE FROM routines WHERE id = ?").run(id);
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

const AGENT_SELECT = `SELECT a.*, (
  SELECT MAX(m.updated_at) FROM messages m WHERE m.agent_id = a.id AND m.channel_id IS NULL AND m.role IN ${UNREAD_ROLES}
) AS last_at FROM agents a`;

const CHANNEL_SELECT = `SELECT c.*, (
  SELECT MAX(m.updated_at) FROM messages m WHERE m.channel_id = c.id AND m.role IN ${CHANNEL_UNREAD_ROLES}
) AS last_at FROM channels c`;

function parseIds(value: SQLInputValue | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function toChannel(row: Row): ChannelRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    topic: String(row.topic ?? ""),
    leadId: str(row.lead_agent_id),
    memberIds: parseIds(row.member_ids),
    preview: String(row.preview ?? ""),
    readAt: Number(row.read_at ?? 0),
    lastAt: row.last_at === null || row.last_at === undefined ? 0 : Number(row.last_at),
    deletedAt: row.deleted_at === null || row.deleted_at === undefined ? null : Number(row.deleted_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function parseJsonRecord(value: SQLInputValue | undefined): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Ajustes de voz guardados; lo que falte o no sirva vuelve al valor por defecto. */
export function toVoice(value: SQLInputValue | undefined | Record<string, unknown>): VoiceSettings {
  const raw = value && typeof value === "object" && !(value instanceof Uint8Array) ? (value as Record<string, unknown>) : parseJsonRecord(value as SQLInputValue | undefined);
  if (!raw) return { ...DEFAULT_VOICE };
  const rate = Number(raw.rate);
  return {
    name: typeof raw.name === "string" ? raw.name.slice(0, 200) : DEFAULT_VOICE.name,
    rate: Number.isFinite(rate) && rate >= 0.5 && rate <= 2 ? Math.round(rate * 100) / 100 : DEFAULT_VOICE.rate,
    lang: typeof raw.lang === "string" && /^(auto|[a-z]{2,3}(-[A-Za-z0-9]{2,8})*)$/.test(raw.lang) ? raw.lang : DEFAULT_VOICE.lang,
    autoRead: raw.autoRead === true,
  };
}

function toRoutine(row: Row): RoutineRecord {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    name: String(row.name),
    prompt: String(row.prompt),
    schedule: (parseJsonRecord(row.schedule) ?? {}) as Schedule,
    enabled: Number(row.enabled) === 1,
    nextRunAt: row.next_run_at === null || row.next_run_at === undefined ? null : Number(row.next_run_at),
    lastRunAt: row.last_run_at === null || row.last_run_at === undefined ? null : Number(row.last_run_at),
    lastDeliveryId: str(row.last_delivery_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
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
    project: String(row.project ?? ""),
    avatar: Number(row.avatar ?? 0),
    pinned: Number(row.pinned ?? 0) === 1,
    hidden: Number(row.hidden ?? 0) === 1,
    voice: toVoice(row.voice),
    readAt: Number(row.read_at ?? 0),
    lastAt: row.last_at === null || row.last_at === undefined ? 0 : Number(row.last_at),
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
    channelId: str(row.channel_id),
    role: String(row.role) as MessageRole,
    fromAgentId: str(row.from_agent_id),
    toAgentIds,
    replyTo: str(row.reply_to),
    text: String(row.text ?? ""),
    status: String(row.status) as MessageStatus,
    turnId: str(row.turn_id),
    deliveryId: str(row.delivery_id),
    payload: parseJsonRecord(row.payload),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toDelivery(row: Row): DeliveryRecord {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    channelId: str(row.channel_id),
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
