// Voces de ElevenLabs (opcional), con la clave del propio usuario: las respuestas se leen con sus voces
// en vez de con las del sistema. El texto que se lee se envía a ElevenLabs; la clave nunca sale del servidor.
import type { Store } from "./db.js";
import { isRecord } from "./providers/protocol.js";

const META = "elevenlabs";
const API = "https://api.elevenlabs.io";
/** Rápido y con la mitad del costo por carácter; o la máxima calidad. */
export const ELEVEN_MODELS = ["eleven_flash_v2_5", "eleven_multilingual_v2"] as const;
export type ElevenModel = (typeof ELEVEN_MODELS)[number];
/** Lo más largo que se lee de una vez (la interfaz parte las respuestas largas en trozos). */
export const MAX_TTS_CHARS = 2_500;
const VOICES_TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 30_000;

export interface ElevenVoice {
  id: string;
  name: string;
  /** premade, cloned, professional, generated… */
  category: string;
  gender: string;
  accent: string;
  description: string;
  previewUrl: string | null;
}

export interface ElevenUsage {
  used: number;
  limit: number;
  tier: string;
}

export interface ElevenStatus {
  configured: boolean;
  model: ElevenModel;
  voices: ElevenVoice[];
  usage: ElevenUsage | null;
  error: string | null;
}

export class ElevenLabsError extends Error {
  constructor(
    message: string,
    /** Estado HTTP para la interfaz: nunca 401, que la app entiende como «sesión vencida». */
    readonly status = 502,
  ) {
    super(message);
    this.name = "ElevenLabsError";
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ElevenLabsOptions {
  store: Store;
  fetch?: FetchLike;
  baseUrl?: string;
}

export class ElevenLabs {
  readonly #store: Store;
  readonly #fetch: FetchLike;
  readonly #base: string;
  #cache: { key: string; at: number; voices: ElevenVoice[]; usage: ElevenUsage | null } | null = null;

  constructor(options: ElevenLabsOptions) {
    this.#store = options.store;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#base = (options.baseUrl ?? API).replace(/\/+$/, "");
  }

  get configured(): boolean {
    return Boolean(this.#read().key);
  }

  /** Si hay clave, sus voces y cuánto lleva usado del mes (lo pide de nuevo cada 10 minutos o con `refresh`). */
  async status({ refresh = false } = {}): Promise<ElevenStatus> {
    const { key, model } = this.#read();
    if (!key) return { configured: false, model, voices: [], usage: null, error: null };
    const cached = this.#cache?.key === key ? this.#cache : null;
    try {
      if (refresh || !cached || Date.now() - cached.at > VOICES_TTL_MS) await this.#load(key);
      const fresh = this.#cache as { voices: ElevenVoice[]; usage: ElevenUsage | null };
      return { configured: true, model, voices: fresh.voices, usage: fresh.usage, error: null };
    } catch (error) {
      return { configured: true, model, voices: cached?.voices ?? [], usage: cached?.usage ?? null, error: errorText(error) };
    }
  }

  /** Guarda (o quita, con "") la clave y elige el modelo. Una clave nueva se prueba antes de guardarla. */
  async configure(input: { key?: unknown; model?: unknown }): Promise<ElevenStatus> {
    const current = this.#read();
    let key = current.key;
    if (input.key !== undefined) {
      if (typeof input.key !== "string") throw new ElevenLabsError("La clave debe ser texto.", 400);
      key = input.key.trim();
      if (key && !/^[A-Za-z0-9_-]{20,200}$/.test(key)) {
        throw new ElevenLabsError("Esa no parece una clave de ElevenLabs: cópiala completa desde elevenlabs.io, en Developers → API Keys.", 400);
      }
    }
    let model = current.model;
    if (input.model !== undefined) {
      if (!ELEVEN_MODELS.includes(input.model as ElevenModel)) throw new ElevenLabsError("Ese modelo de ElevenLabs no está disponible.", 400);
      model = input.model as ElevenModel;
    }
    if (key && key !== current.key) await this.#load(key);
    if (!key) this.#cache = null;
    this.#store.setMeta(META, JSON.stringify({ key, model }));
    return this.status();
  }

  /** Lee un texto con una voz: devuelve la respuesta de ElevenLabs con el audio MP3 en camino. */
  async synthesize(voiceId: unknown, text: unknown, signal?: AbortSignal): Promise<Response> {
    const { key, model } = this.#read();
    if (!key) throw new ElevenLabsError("Agrega tu clave de ElevenLabs en Ajustes para usar sus voces.", 409);
    if (typeof voiceId !== "string" || !/^[A-Za-z0-9]{1,64}$/.test(voiceId)) throw new ElevenLabsError("Esa voz de ElevenLabs no es válida.", 400);
    const clean = typeof text === "string" ? text.trim() : "";
    if (!clean) throw new ElevenLabsError("No hay texto para leer.", 400);
    if (clean.length > MAX_TTS_CHARS) throw new ElevenLabsError(`Se leen hasta ${MAX_TTS_CHARS.toLocaleString("es")} caracteres por vez.`, 400);
    return this.#request(`/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128`, key, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text: clean, model_id: model }),
      ...(signal ? { signal } : {}),
    });
  }

  #read(): { key: string; model: ElevenModel } {
    let raw: unknown = null;
    try {
      raw = JSON.parse(this.#store.getMeta(META) ?? "null");
    } catch {
      raw = null;
    }
    const record = isRecord(raw) ? raw : {};
    const model = ELEVEN_MODELS.includes(record.model as ElevenModel) ? (record.model as ElevenModel) : ELEVEN_MODELS[0];
    return { key: typeof record.key === "string" ? record.key : "", model };
  }

  async #load(key: string): Promise<void> {
    const [voices, usage] = await Promise.all([this.#voices(key), this.#usage(key)]);
    this.#cache = { key, at: Date.now(), voices, usage };
  }

  async #voices(key: string): Promise<ElevenVoice[]> {
    const response = await this.#request("/v1/voices", key);
    const data: unknown = await response.json().catch(() => null);
    const list = isRecord(data) && Array.isArray(data.voices) ? data.voices : [];
    const voices: ElevenVoice[] = [];
    for (const item of list) {
      if (!isRecord(item) || typeof item.voice_id !== "string" || !/^[A-Za-z0-9]{1,64}$/.test(item.voice_id)) continue;
      const labels = isRecord(item.labels) ? item.labels : {};
      const label = (name: string) => (typeof labels[name] === "string" ? (labels[name] as string).slice(0, 60) : "");
      voices.push({
        id: item.voice_id,
        name: typeof item.name === "string" && item.name.trim() ? item.name.trim().slice(0, 80) : item.voice_id,
        category: typeof item.category === "string" ? item.category : "",
        gender: label("gender"),
        accent: label("accent"),
        description: (typeof item.description === "string" && item.description ? item.description : label("description")).slice(0, 160),
        previewUrl: typeof item.preview_url === "string" && /^https:\/\//.test(item.preview_url) ? item.preview_url : null,
      });
    }
    // Primero las tuyas (clonadas o agregadas), después las de ElevenLabs; cada grupo por nombre.
    const rank = (voice: ElevenVoice) => (voice.category === "premade" ? 1 : 0);
    return voices.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "es", { sensitivity: "base" }));
  }

  /** Caracteres usados y disponibles del mes. Una clave sin permiso para verlo no es un error. */
  async #usage(key: string): Promise<ElevenUsage | null> {
    try {
      const response = await this.#request("/v1/user/subscription", key);
      const data: unknown = await response.json();
      if (!isRecord(data)) return null;
      const used = Number(data.character_count);
      const limit = Number(data.character_limit);
      if (!Number.isFinite(used) || !Number.isFinite(limit)) return null;
      return { used, limit, tier: typeof data.tier === "string" ? data.tier : "" };
    } catch {
      return null;
    }
  }

  async #request(path: string, key: string, init: RequestInit = {}): Promise<Response> {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.#fetch(`${this.#base}${path}`, {
        ...init,
        headers: { ...((init.headers as Record<string, string> | undefined) ?? {}), "xi-api-key": key },
        signal,
      });
    } catch (error) {
      if (init.signal?.aborted) throw new ElevenLabsError("Lectura cancelada.", 499);
      throw new ElevenLabsError(
        timeout.aborted ? "ElevenLabs no respondió a tiempo." : `No se pudo conectar con ElevenLabs: revisa la conexión a internet (${errorText(error)}).`,
        502,
      );
    }
    if (response.ok) return response;
    throw await failure(response);
  }
}

/** Traduce los errores de ElevenLabs a algo que se entienda (y que la interfaz no confunda con la sesión). */
async function failure(response: Response): Promise<ElevenLabsError> {
  let status = "";
  let message = "";
  try {
    const data: unknown = await response.json();
    const detail = isRecord(data) ? data.detail : null;
    if (isRecord(detail)) {
      status = typeof detail.status === "string" ? detail.status : "";
      message = typeof detail.message === "string" ? detail.message : "";
    } else if (typeof detail === "string") {
      message = detail;
    }
  } catch {
    // Sin cuerpo JSON: se usa el estado HTTP.
  }
  if (status === "quota_exceeded" || /quota/i.test(status)) {
    return new ElevenLabsError("Se acabaron los caracteres de tu plan de ElevenLabs este mes.", 402);
  }
  if (status === "missing_permissions" || (response.status === 401 && /permission/i.test(message))) {
    return new ElevenLabsError(
      "La clave de ElevenLabs no tiene los permisos necesarios: créala con acceso a «Text to Speech», «Voices» y «User».",
      400,
    );
  }
  if (response.status === 401 || status === "invalid_api_key") return new ElevenLabsError("ElevenLabs rechazó la clave: revisa que esté completa y que no la hayas borrado.", 400);
  if (response.status === 404) return new ElevenLabsError("Esa voz ya no está en tu cuenta de ElevenLabs: elige otra en la ficha del agente.", 404);
  if (response.status === 429) return new ElevenLabsError("ElevenLabs está ocupado (demasiadas lecturas a la vez): prueba en un momento.", 429);
  const extra = message ? `: ${message.slice(0, 200)}` : "";
  return new ElevenLabsError(`ElevenLabs respondió con un error (${response.status})${extra}.`, 502);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
