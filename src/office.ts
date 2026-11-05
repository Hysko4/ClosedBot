// La Oficina: los personajes de PixelLab de cada agente y el arte en alta resolución del dibujo.
//
// PixelLab (api.pixellab.ai, con el token que el usuario guarda en Ajustes) dibuja a cada agente según su
// aspecto: cuatro vistas y el caminar. ClosedBot guarda los cuadros en su carpeta de datos y la Oficina los
// pide a /api/agents/:id/character. El arte del salón y las salas viene en baja resolución con la app; al
// arrancar (o al abrir la Oficina, si aún falta) se descarga una vez el original, dibujado con fal.

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

export const DIRECTIONS = ["south", "west", "east", "north"] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const PIXELLAB_URL = "https://api.pixellab.ai/v2";
/** Tamaño de los personajes en píxeles (el lienzo de PixelLab; la figura ocupa algo menos). */
export const CHARACTER_SIZE = 64;
/** Cuadros del caminar. */
export const WALK_FRAMES = 6;
export const APPEARANCE_MAX = 300;

/** Arte original de la Oficina (dibujado con fal, 2752 × 1536): se descarga una vez y queda en la carpeta de datos. */
export const OFFICE_ART: Record<string, string> = {
  salon: "https://v3b.fal.media/files/b/0ab14aed/dXd6xFE67l61fcpjHPVPJ_dqOLvF67.png",
  sala: "https://v3b.fal.media/files/b/0ab14ae4/oKYfbG8Nx6B1tsjRbMkXG_YxEX9NHT.png",
  jefe: "https://v3b.fal.media/files/b/0ab14af6/VimjXq4ssFtu_fsP9NhFa_befa2a359d504806b056f9b496cab1f1.png",
  escritorio: "https://v3b.fal.media/files/b/0ab14af6/3LEFcSTAwuT8F0BOL6-Lw_2133ace3dd464fbfbea518233cb4dc13.png",
  silla: "https://v3b.fal.media/files/b/0ab14af5/9jk7SSqMxTUIzaQPRqYXX_e87e1378e88543a5a7f9946b3bb26587.png",
};
export const OFFICE_ART_SIZE = { width: 2752, height: 1536 };
const ART_MAX_BYTES = 40 * 1024 * 1024;
const ART_RETRY_MS = 6 * 60 * 60 * 1000;

export type CharacterStatus = "drawing" | "ready" | "failed";

/** Estado del personaje de un agente (se guarda con el agente). */
export interface CharacterState {
  status: CharacterStatus;
  /** Sube cada vez que queda listo un dibujo nuevo (la interfaz lo usa para no quedarse con el anterior). */
  version: number;
  error: string | null;
  updatedAt: number;
}

export interface CharacterManifest {
  version: number;
  size: number;
  rotations: Partial<Record<Direction, string>>;
  walk: Partial<Record<Direction, string[]>>;
}

// ---------- cliente de PixelLab ----------

export class PixelLabError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface PixelLabOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Espera entre consultas de un trabajo (3 s por defecto). */
  pollMs?: number;
  /** Tiempo máximo de cada trabajo (8 minutos por defecto). */
  timeoutMs?: number;
}

export interface CreatedCharacter {
  characterId: string | null;
  jobId: string | null;
  images: Partial<Record<Direction, Buffer>>;
}

/** Cliente mínimo de la API v2 de PixelLab: personaje de 4 direcciones, su animación y el ZIP con los cuadros. */
export class PixelLabClient {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #pollMs: number;
  readonly #timeoutMs: number;

  constructor(token: string, options: PixelLabOptions = {}) {
    this.#token = token;
    this.#baseUrl = (options.baseUrl ?? PIXELLAB_URL).replace(/\/+$/, "");
    this.#fetch = options.fetch ?? fetch;
    this.#pollMs = options.pollMs ?? 3_000;
    this.#timeoutMs = options.timeoutMs ?? 8 * 60_000;
  }

  /** Sirve para comprobar el token. */
  async balance(): Promise<Record<string, unknown>> {
    const response = await this.#request("GET", "/balance");
    return asRecord(await readJsonBody(response)) ?? {};
  }

  async createCharacter(description: string): Promise<CreatedCharacter> {
    const response = await this.#request("POST", "/create-character-with-4-directions", {
      description,
      image_size: { width: CHARACTER_SIZE, height: CHARACTER_SIZE },
      view: "low top-down",
      outline: "single color black outline",
      shading: "basic shading",
      detail: "medium detail",
    });
    const body = asRecord(await readJsonBody(response)) ?? {};
    const data = asRecord(body.data) ?? body;
    const character = asRecord(data.character);
    return {
      characterId: text(data.character_id) ?? text(character?.id) ?? text(data.id),
      jobId: text(data.background_job_id) ?? text(data.job_id),
      images: directionImages(data.images ?? asRecord(data.last_response)?.images),
    };
  }

  /** Pide la animación de caminar en las 4 direcciones; devuelve los trabajos que hay que esperar. */
  async animateWalk(characterId: string): Promise<string[]> {
    const response = await this.#request("POST", "/animate-character", {
      character_id: characterId,
      animation_name: "walk",
      action_description: "walking",
      frame_count: WALK_FRAMES,
    });
    const body = asRecord(await readJsonBody(response)) ?? {};
    const data = asRecord(body.data) ?? body;
    const ids = Array.isArray(data.background_job_ids) ? data.background_job_ids.filter((id): id is string => typeof id === "string" && Boolean(id)) : [];
    const single = text(data.background_job_id);
    return single && !ids.includes(single) ? [...ids, single] : ids;
  }

  /** Espera a que termine un trabajo en segundo plano. */
  async waitJob(jobId: string): Promise<Record<string, unknown>> {
    const started = Date.now();
    for (;;) {
      const response = await this.#request("GET", `/background-jobs/${encodeURIComponent(jobId)}`);
      const body = asRecord(await readJsonBody(response)) ?? {};
      const status = text(body.status)?.toLowerCase();
      if (status === "completed" || status === "succeeded" || status === "done") return body;
      if (status === "failed" || status === "error" || status === "cancelled") {
        const detail = errorDetail(asRecord(body.last_response) ?? body);
        throw new PixelLabError(detail ? `PixelLab no pudo terminar: ${detail}` : "PixelLab no pudo terminar el dibujo.", 502);
      }
      if (Date.now() - started > this.#timeoutMs) throw new PixelLabError("PixelLab tardó demasiado en dibujar.", 504);
      await delay(this.#pollMs);
    }
  }

  /** El ZIP del personaje (vistas y animaciones); mientras PixelLab sigue trabajando responde 423 y se reintenta. */
  async characterZip(characterId: string): Promise<Buffer> {
    const started = Date.now();
    for (;;) {
      const response = await this.#request("GET", `/characters/${encodeURIComponent(characterId)}/zip`, undefined, [423]);
      if (response.status !== 423) return Buffer.from(await response.arrayBuffer());
      await response.arrayBuffer().catch(() => undefined);
      if (Date.now() - started > this.#timeoutMs) throw new PixelLabError("PixelLab tardó demasiado en entregar el personaje.", 504);
      await delay(this.#pollMs);
    }
  }

  async #request(method: string, path: string, body?: unknown, allow: number[] = []): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#token}`,
          accept: "application/json, application/zip, */*",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new PixelLabError("No se pudo conectar con PixelLab.", 502);
    }
    if (response.ok || allow.includes(response.status)) return response;
    const detail = errorDetail(asRecord(await readJsonBody(response).catch(() => null)));
    throw new PixelLabError(pixelLabMessage(response.status, detail), response.status);
  }
}

function pixelLabMessage(status: number, detail: string | null): string {
  if (status === 401 || status === 403) return "PixelLab no aceptó el token: revísalo en Ajustes.";
  if (status === 402) return "Se acabaron los créditos de PixelLab.";
  if (status === 429) return "PixelLab está recibiendo demasiados pedidos: vuelve a intentarlo en un rato.";
  if (status === 422) return detail ? `PixelLab rechazó el pedido: ${detail}` : "PixelLab rechazó el pedido.";
  return `PixelLab respondió con un error (${status})${detail ? `: ${detail}` : ""}.`;
}

async function readJsonBody(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function errorDetail(body: Record<string, unknown> | null): string | null {
  if (!body) return null;
  const detail = body.detail ?? body.error ?? body.message;
  if (typeof detail === "string") return clip(detail, 200);
  if (Array.isArray(detail)) {
    const first = asRecord(detail[0]);
    const message = text(first?.msg) ?? text(first?.message);
    if (message) return clip(message, 200);
  }
  return null;
}

/** Imágenes por dirección de una respuesta de PixelLab ({ south: { base64 } } o una lista en ese orden). */
function directionImages(value: unknown): Partial<Record<Direction, Buffer>> {
  const images: Partial<Record<Direction, Buffer>> = {};
  const record = asRecord(value);
  if (record) {
    for (const dir of DIRECTIONS) {
      const image = decodeImage(record[dir]);
      if (image) images[dir] = image;
    }
  } else if (Array.isArray(value)) {
    value.slice(0, 4).forEach((item, index) => {
      const image = decodeImage(item);
      if (image) images[DIRECTIONS[index] as Direction] = image;
    });
  }
  return images;
}

function decodeImage(value: unknown): Buffer | null {
  const record = asRecord(value);
  const raw = typeof value === "string" ? value : (text(record?.base64) ?? text(record?.data));
  if (!raw) return null;
  const buffer = Buffer.from(raw.replace(/^data:image\/[a-z]+;base64,/i, ""), "base64");
  return isPng(buffer) ? buffer : null;
}

// ---------- ZIP ----------

/** Lee un ZIP en memoria (solo «stored» y «deflate», sin ZIP64). Devuelve archivo → contenido. */
export function readZip(buffer: Buffer, limits: { maxEntries?: number; maxBytes?: number } = {}): Map<string, Buffer> {
  const maxEntries = limits.maxEntries ?? 800;
  const maxBytes = limits.maxBytes ?? 60 * 1024 * 1024;
  const files = new Map<string, Buffer>();
  let end = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 22 - 65_535); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error("El ZIP del personaje está dañado.");
  const count = buffer.readUInt16LE(end + 10);
  let pointer = buffer.readUInt32LE(end + 16);
  if (count > maxEntries) throw new Error("El ZIP del personaje trae demasiados archivos.");
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (pointer + 46 > buffer.length || buffer.readUInt32LE(pointer) !== 0x02014b50) throw new Error("El ZIP del personaje está dañado.");
    const method = buffer.readUInt16LE(pointer + 10);
    const compressed = buffer.readUInt32LE(pointer + 20);
    const size = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const local = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString("utf8", pointer + 46, pointer + 46 + nameLength).replace(/\\/g, "/");
    pointer += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith("/") || size === 0xffffffff || compressed === 0xffffffff) continue;
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) continue;
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (start + compressed > buffer.length) continue;
    total += size;
    if (total > maxBytes) throw new Error("El ZIP del personaje es demasiado grande.");
    const raw = buffer.subarray(start, start + compressed);
    if (method === 0) files.set(name, Buffer.from(raw));
    else if (method === 8) {
      const data = inflateRawSync(raw, { maxOutputLength: Math.max(1, size) });
      if (data.length === size) files.set(name, data);
    }
  }
  return files;
}

/** Las vistas y el caminar que trae el ZIP de PixelLab (rotations/<dir>.png y animations/<nombre>/<dir>/frame_NNN.png). */
export function characterFrames(files: Map<string, Buffer>): { rotations: Partial<Record<Direction, Buffer>>; walk: Partial<Record<Direction, Buffer[]>> } {
  const rotations: Partial<Record<Direction, Buffer>> = {};
  const animations = new Map<string, Map<Direction, Array<[number, Buffer]>>>();
  for (const [name, data] of files) {
    if (!isPng(data)) continue;
    const rotation = /(?:^|\/)rotations\/(south|west|east|north)\.png$/i.exec(name);
    if (rotation) {
      rotations[rotation[1]!.toLowerCase() as Direction] = data;
      continue;
    }
    const frame = /(?:^|\/)animations\/([^/]+)\/(south|west|east|north)\/frame_?(\d+)\.png$/i.exec(name);
    if (!frame) continue;
    const animation = animations.get(frame[1]!) ?? new Map<Direction, Array<[number, Buffer]>>();
    const dir = frame[2]!.toLowerCase() as Direction;
    const list = animation.get(dir) ?? [];
    list.push([Number(frame[3]), data]);
    animation.set(dir, list);
    animations.set(frame[1]!, animation);
  }
  const names = [...animations.keys()].sort();
  const chosen = names.find((name) => /walk/i.test(name)) ?? names[0];
  const walk: Partial<Record<Direction, Buffer[]>> = {};
  if (chosen) {
    for (const [dir, list] of animations.get(chosen)!) walk[dir] = list.sort((a, b) => a[0] - b[0]).map(([, data]) => data).slice(0, 16);
  }
  return { rotations, walk };
}

// ---------- estudio de personajes y arte ----------

export interface CharacterSubject {
  id: string;
  name: string;
  role: string;
  appearance: string;
}

/** Lo que se le describe a PixelLab: el aspecto que dio quien creó al agente o, si no hay, su rol. */
export function characterDescription(agent: CharacterSubject): string {
  const look = agent.appearance.replace(/\s+/g, " ").trim();
  if (look) return clip(look, APPEARANCE_MAX);
  const role = agent.role.replace(/\s+/g, " ").trim();
  return clip(role ? `office worker: ${role}` : "friendly office worker", APPEARANCE_MAX);
}

export interface OfficeStudioOptions {
  dir: string;
  /** El token guardado en Ajustes (null si no hay). */
  token: () => string | null;
  pixelLab?: PixelLabOptions;
  /** Origen del arte en alta resolución (para las pruebas) y cómo bajarlo. */
  art?: { sources?: Record<string, string>; fetch?: typeof fetch };
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

/**
 * Dibuja los personajes de a uno (en cola) y guarda sus cuadros en <dir>/personajes/<agente>/. Emite
 * «character» (agentId, CharacterState sin la versión nueva hasta que está listo) y «art» cuando baja el arte.
 */
export class OfficeStudio extends EventEmitter {
  readonly #options: OfficeStudioOptions;
  readonly #queue: CharacterSubject[] = [];
  #current: string | null = null;
  #artTask: Promise<void> | null = null;
  #artFailedAt = 0;

  constructor(options: OfficeStudioOptions) {
    super();
    this.#options = options;
  }

  client(token = this.#options.token()): PixelLabClient | null {
    return token ? new PixelLabClient(token, this.#options.pixelLab) : null;
  }

  /** Encola el dibujo de un agente (si ya estaba en cola, se actualiza lo que se pide). */
  request(agent: CharacterSubject): boolean {
    if (!this.#options.token()) return false;
    const existing = this.#queue.find((item) => item.id === agent.id);
    if (existing) Object.assign(existing, agent);
    else this.#queue.push({ ...agent });
    void this.#drain();
    return true;
  }

  pending(agentId: string): boolean {
    return this.#current === agentId || this.#queue.some((item) => item.id === agentId);
  }

  /** El agente ya no existe: sale de la cola y se borran sus cuadros. */
  forget(agentId: string): void {
    const index = this.#queue.findIndex((item) => item.id === agentId);
    if (index >= 0) this.#queue.splice(index, 1);
    if (safeId(agentId)) rmSync(join(this.#options.dir, "personajes", agentId), { recursive: true, force: true });
  }

  manifest(agentId: string): CharacterManifest | null {
    if (!safeId(agentId)) return null;
    try {
      return JSON.parse(readFileSync(join(this.#options.dir, "personajes", agentId, "manifest.json"), "utf8")) as CharacterManifest;
    } catch {
      return null;
    }
  }

  /** Ruta de un cuadro del personaje, o null si el nombre no es válido o no existe. */
  file(agentId: string, name: string): string | null {
    if (!safeId(agentId) || !/^[a-z0-9-]{1,40}\.png$/.test(name)) return null;
    const path = join(this.#options.dir, "personajes", agentId, name);
    return existsSync(path) ? path : null;
  }

  async #drain(): Promise<void> {
    if (this.#current) return;
    const next = this.#queue.shift();
    if (!next) return;
    this.#current = next.id;
    this.emit("character", next.id, { status: "drawing", error: null });
    let result: { status: CharacterStatus; error: string | null; version?: number };
    let fatal = false;
    try {
      result = { status: "ready", error: null, version: await this.#draw(next) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#options.log?.("warn", `PixelLab no dibujó a ${next.name}: ${message}`);
      result = { status: "failed", error: clip(message, 240) };
      // Sin token válido o sin créditos, los que siguen fallarían igual: no se insiste.
      fatal = error instanceof PixelLabError && [401, 402, 403].includes(error.status);
    }
    this.#current = null;
    this.emit("character", next.id, result);
    if (fatal) {
      for (const item of this.#queue.splice(0)) this.emit("character", item.id, { ...result, quiet: true });
      return;
    }
    void this.#drain();
  }

  async #draw(agent: CharacterSubject): Promise<number> {
    const client = this.client();
    if (!client) throw new Error("Falta el token de PixelLab en Ajustes.");
    const created = await client.createCharacter(characterDescription(agent));
    if (created.jobId) await client.waitJob(created.jobId);
    let rotations = created.images;
    let walk: Partial<Record<Direction, Buffer[]>> = {};
    if (created.characterId) {
      try {
        for (const job of await client.animateWalk(created.characterId)) await client.waitJob(job);
      } catch (error) {
        // Sin el caminar igual sirve: se desliza con sus vistas.
        if (error instanceof PixelLabError && (error.status === 401 || error.status === 403)) throw error;
        this.#options.log?.("warn", `PixelLab no animó a ${agent.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const frames = characterFrames(readZip(await client.characterZip(created.characterId)));
      rotations = { ...rotations, ...frames.rotations };
      walk = frames.walk;
    }
    if (!rotations.south) throw new Error("PixelLab no devolvió el personaje.");
    return this.#save(agent.id, rotations, walk);
  }

  #save(agentId: string, rotations: Partial<Record<Direction, Buffer>>, walk: Partial<Record<Direction, Buffer[]>>): number {
    if (!safeId(agentId)) throw new Error("Agente inválido.");
    const root = join(this.#options.dir, "personajes");
    const final = join(root, agentId);
    const version = (this.manifest(agentId)?.version ?? 0) + 1;
    const temp = join(root, `.${agentId}-${version}`);
    rmSync(temp, { recursive: true, force: true });
    mkdirSync(temp, { recursive: true });
    const manifest: CharacterManifest = { version, size: CHARACTER_SIZE, rotations: {}, walk: {} };
    for (const dir of DIRECTIONS) {
      const image = rotations[dir];
      if (!image) continue;
      writeFileSync(join(temp, `${dir}.png`), image);
      manifest.rotations[dir] = `${dir}.png`;
    }
    for (const dir of DIRECTIONS) {
      const frames = walk[dir];
      if (!frames?.length) continue;
      manifest.walk[dir] = frames.map((frame, index) => {
        const name = `walk-${dir}-${index}.png`;
        writeFileSync(join(temp, name), frame);
        return name;
      });
    }
    writeFileSync(join(temp, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    rmSync(final, { recursive: true, force: true });
    renameSync(temp, final);
    return version;
  }

  // ---------- arte en alta resolución ----------

  /** El arte original ya está en la carpeta de datos. */
  artReady(): boolean {
    return Object.keys(this.#artSources()).every((name) => existsSync(this.#artPath(name)));
  }

  /** Ruta del arte original de una pieza, o null si aún no se descargó. */
  artFile(name: string): string | null {
    if (!(name in this.#artSources())) return null;
    const path = this.#artPath(name);
    return existsSync(path) ? path : null;
  }

  /** Descarga el arte que falte (una vez; si falla, se reintenta horas después). */
  ensureArt(): void {
    if (this.#artTask || this.artReady() || Date.now() - this.#artFailedAt < ART_RETRY_MS) return;
    this.#artTask = this.#downloadArt()
      .then(() => {
        if (!this.artReady()) return;
        this.#options.log?.("info", "Bajé el arte de la Oficina en alta resolución.");
        this.emit("art");
      })
      .catch((error: unknown) => {
        this.#artFailedAt = Date.now();
        this.#options.log?.("warn", `No se pudo bajar el arte de la Oficina en alta resolución: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.#artTask = null;
      });
  }

  async #downloadArt(): Promise<void> {
    const folder = join(this.#options.dir, "arte");
    mkdirSync(folder, { recursive: true });
    const fetcher = this.#options.art?.fetch ?? fetch;
    for (const [name, url] of Object.entries(this.#artSources())) {
      const path = this.#artPath(name);
      if (existsSync(path)) continue;
      const response = await fetcher(url, { signal: AbortSignal.timeout(180_000) });
      if (!response.ok) throw new Error(`${name}: respuesta ${response.status}`);
      const data = Buffer.from(await response.arrayBuffer());
      if (data.length > ART_MAX_BYTES) throw new Error(`${name}: demasiado grande`);
      const size = pngSize(data);
      if (!size || size.width !== OFFICE_ART_SIZE.width || size.height !== OFFICE_ART_SIZE.height) throw new Error(`${name}: no es el dibujo esperado`);
      writeFileSync(`${path}.tmp`, data);
      renameSync(`${path}.tmp`, path);
    }
  }

  #artSources(): Record<string, string> {
    return this.#options.art?.sources ?? OFFICE_ART;
  }

  #artPath(name: string): string {
    return join(this.#options.dir, "arte", `${name}.png`);
  }

  /** Versión del arte para la interfaz (cambia cuando llega el original). */
  artVersion(): number {
    if (!this.artReady()) return 0;
    try {
      return Math.floor(statSync(this.#artPath("salon")).mtimeMs / 1000);
    } catch {
      return 0;
    }
  }
}

// ---------- utilidades ----------

export function isPng(data: Buffer): boolean {
  return data.length > 24 && data.readUInt32BE(0) === 0x89504e47 && data.readUInt32BE(4) === 0x0d0a1a0a;
}

/** Ancho y alto de un PNG (del encabezado IHDR). */
export function pngSize(data: Buffer): { width: number; height: number } | null {
  if (!isPng(data) || data.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function safeId(id: string): boolean {
  return /^[A-Za-z0-9-]{1,80}$/.test(id);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
