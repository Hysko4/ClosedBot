// Voces locales para leer en voz alta: Supertonic 3 (Supertone), las mismas de OpenBot. Corren en este equipo con
// sherpa-onnx (el motor del dictado local), gratis y sin internet; el modelo se descarga una vez (unos 145 MB) o se
// usa la copia que ya bajó OpenBot.

import { type ChildProcess, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createWriteStream, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { availableParallelism, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface VoiceFile {
  name: string;
  bytes: number;
  sha256: string;
}

/** Los archivos que pide sherpa-onnx para Supertonic, con el nombre de su opción. */
export interface SupertonicFiles {
  durationPredictor: VoiceFile;
  textEncoder: VoiceFile;
  vectorEstimator: VoiceFile;
  vocoder: VoiceFile;
  ttsJson: VoiceFile;
  unicodeIndexer: VoiceFile;
  voiceStyle: VoiceFile;
}

export interface LocalVoice {
  id: string;
  /** Número de la voz dentro del modelo. */
  sid: number;
  label: string;
}

export interface LocalVoiceModel {
  id: string;
  label: string;
  /** Carpeta publicada, fijada a una revisión: cada archivo se baja de <baseUrl><nombre>. */
  baseUrl: string;
  /** Carpeta donde queda en <datos>/voz/voces (y nombre de la de OpenBot). */
  dir: string;
  files: SupertonicFiles;
  /** Archivos que acompañan al modelo (licencia): se bajan y se comprueban, pero no se usan. */
  extra: VoiceFile[];
  voices: LocalVoice[];
  /** Idiomas que habla (códigos de dos letras). */
  languages: string[];
  numSteps: number;
}

/**
 * Supertonic 3 en int8 para sherpa-onnx, la misma revisión y los mismos archivos que fija OpenBot 0.58.0 (tamaños y
 * SHA-256 comprobados en el PC del usuario el 2026-11-03). Pesos de Supertone con licencia OpenRAIL-M.
 */
export const SUPERTONIC_3: LocalVoiceModel = {
  id: "supertonic-3-int8",
  label: "Supertonic 3",
  baseUrl:
    "https://huggingface.co/csukuangfj2/sherpa-onnx-supertonic-3-tts-int8-2026-05-11/resolve/cca5a0e6c96e1d2c720986bf7e75fcc81dee3ae4/",
  dir: "supertonic-3-int8",
  files: {
    durationPredictor: {
      name: "duration_predictor.int8.onnx",
      bytes: 3_700_147,
      sha256: "c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db",
    },
    textEncoder: { name: "text_encoder.int8.onnx", bytes: 36_416_150, sha256: "c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff" },
    vectorEstimator: {
      name: "vector_estimator.int8.onnx",
      bytes: 78_400_833,
      sha256: "20cd86fa5c6effedfda0e7cffe5b0569ca401c440a0c3a1d72bf39286c0db3fd",
    },
    vocoder: { name: "vocoder.int8.onnx", bytes: 25_991_073, sha256: "e923d60f53f95eb1ce235f1dc33ec56d9c057823c96fa6f8acf98f32b0da6152" },
    ttsJson: { name: "tts.json", bytes: 8_253, sha256: "42078d3aef1cd43ab43021f3c54f47d2d75ceb4e75f627f118890128b06a0d09" },
    unicodeIndexer: { name: "unicode_indexer.bin", bytes: 262_144, sha256: "8402ca48e5189a8950138580b0fff64db6f072f24ac07cd54ba8b2fbb9883b30" },
    voiceStyle: { name: "voice.bin", bytes: 517_168, sha256: "67d5209b0ee8ce6c74105ffbe12fe6a7628aea3b4ba2fcb308a4a67938a93ce8" },
  },
  extra: [{ name: "LICENSE", bytes: 1_070, sha256: "0dfe0d0ba84416fe3879d9a34f4909d8d0137c78d1e95834177b0414ac096fa2" }],
  // El número de cada voz es su lugar en voice.bin: F1–F5 son de mujer y M1–M5 de hombre.
  voices: [
    { id: "F1", sid: 0, label: "Voz femenina 1" },
    { id: "F2", sid: 1, label: "Voz femenina 2" },
    { id: "F3", sid: 2, label: "Voz femenina 3" },
    { id: "F4", sid: 3, label: "Voz femenina 4" },
    { id: "F5", sid: 4, label: "Voz femenina 5" },
    { id: "M1", sid: 5, label: "Voz masculina 1" },
    { id: "M2", sid: 6, label: "Voz masculina 2" },
    { id: "M3", sid: 7, label: "Voz masculina 3" },
    { id: "M4", sid: 8, label: "Voz masculina 4" },
    { id: "M5", sid: 9, label: "Voz masculina 5" },
  ],
  languages: "ar bg cs da de el en es et fi fr hi hr hu id it ja ko lt lv nl pl pt ro ru sk sl sv tr uk vi".split(" "),
  numSteps: 8,
};

export type LocalVoicesState = "missing" | "downloading" | "ready" | "error";

export interface LocalVoicesStatus {
  state: LocalVoicesState;
  model: string;
  /** Tamaño de la descarga, en MB. */
  sizeMb: number;
  /** 0 a 1 mientras se descarga; null en los demás estados. */
  progress: number | null;
  error: string | null;
  /** De dónde salen los archivos: la descarga propia o la copia de OpenBot. */
  source: "closedbot" | "openbot" | null;
  voices: Array<{ id: string; label: string }>;
  languages: string[];
}

export interface SynthesisRequest {
  text: string;
  sid: number;
  speed: number;
  lang: string;
  numSteps: number;
}

/** Genera el audio de un texto; en las pruebas reemplaza al proceso de sherpa-onnx. */
export type Synthesize = (request: SynthesisRequest) => Promise<{ samples: Float32Array; sampleRate: number }>;

export interface LocalVoicesOptions {
  /** Carpeta de la voz de ClosedBot (<datos>/voz); el modelo queda en <dir>/voces. */
  dir: string;
  model?: LocalVoiceModel;
  /** Carpetas donde otras apps (OpenBot) guardan el mismo modelo; se usan si están completas. */
  shared?: string[];
  fetch?: typeof fetch;
  synthesize?: Synthesize;
  /** Tras este tiempo sin leer nada se cierra el proceso de las voces y libera la memoria. */
  idleMs?: number;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

export class LocalVoicesError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Lo máximo que se lee de una vez: la ventana manda frases mucho más cortas. */
export const MAX_SPEAK_CHARS = 1_000;
const DOWNLOAD_STALL_MS = 60_000;
const WORKER_LOAD_MS = 120_000;
const DEFAULT_IDLE_MS = 15 * 60_000;
const STAGING_PREFIX = ".descargando-";

/** Variables que necesita el proceso de las voces; nunca recibe claves ni tokens del servidor. */
const WORKER_ENV = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LANG", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH"];

/** Dónde guarda OpenBot (una app de Electron) sus modelos de voz en cada sistema. */
export function openBotVoiceDirs(model: LocalVoiceModel = SUPERTONIC_3, env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
  const home = env.USERPROFILE || env.HOME || homedir();
  const userData =
    platform === "win32"
      ? join(env.APPDATA || join(home, "AppData", "Roaming"), "OpenBot")
      : platform === "darwin"
        ? join(home, "Library", "Application Support", "OpenBot")
        : join(env.XDG_CONFIG_HOME || join(home, ".config"), "OpenBot");
  return [join(userData, "runtimes", model.dir)];
}

interface Pending {
  resolve: (audio: { samples: Float32Array; sampleRate: number }) => void;
  reject: (error: Error) => void;
}

interface Worker {
  child: ChildProcess;
  ready: Promise<void>;
  /** Carpeta del modelo que cargó: si cambia (se descargó el propio), se vuelve a cargar. */
  dir: string;
}

export class LocalVoices extends EventEmitter {
  readonly #dir: string;
  readonly #model: LocalVoiceModel;
  readonly #shared: string[];
  readonly #fetch: typeof fetch;
  readonly #synthesizeOverride: Synthesize | null;
  readonly #idleMs: number;
  readonly #log: (level: "info" | "warn" | "error", message: string) => void;
  #state: LocalVoicesState = "missing";
  #progress: number | null = null;
  #error: string | null = null;
  #installing: Promise<void> | null = null;
  #worker: Worker | null = null;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #queue: Promise<unknown> = Promise.resolve();
  #idleTimer: NodeJS.Timeout | null = null;
  #lastEmit = 0;
  #stopped = false;

  constructor(options: LocalVoicesOptions) {
    super();
    this.#dir = options.dir;
    this.#model = options.model ?? SUPERTONIC_3;
    this.#shared = options.shared ?? [];
    this.#fetch = options.fetch ?? fetch;
    this.#synthesizeOverride = options.synthesize ?? null;
    this.#idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.#log = options.log ?? (() => undefined);
    this.#state = this.#location() ? "ready" : "missing";
  }

  status(): LocalVoicesStatus {
    const location = this.#location();
    // Si alguien borró el modelo mientras la app corría, se vuelve a ofrecer la descarga; si OpenBot lo bajó, ya está.
    if (location && this.#state !== "downloading") this.#state = "ready";
    else if (!location && this.#state === "ready") this.#state = "missing";
    return {
      state: this.#state,
      model: this.#model.label,
      sizeMb: Math.round(totalBytes(this.#model) / 1_000_000),
      progress: this.#progress,
      error: this.#state === "error" ? this.#error : null,
      source: this.#state === "ready" ? (location?.source ?? null) : null,
      voices: this.#model.voices.map((voice) => ({ id: voice.id, label: voice.label })),
      languages: [...this.#model.languages],
    };
  }

  /** Descarga el modelo si falta. Se puede llamar varias veces: hay una sola descarga a la vez. */
  install(): Promise<void> {
    if (this.#stopped) return Promise.reject(new LocalVoicesError(503, "Las voces se están cerrando."));
    if (this.#location()) {
      this.#setState("ready");
      return Promise.resolve();
    }
    this.#installing ??= this.#download()
      .then(() => this.#setState("ready"))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.#log("warn", `No se pudieron descargar las voces: ${message}`);
        this.#setState("error", null, `No se pudieron descargar las voces: ${message}`);
        throw error;
      })
      .finally(() => {
        this.#installing = null;
      });
    return this.#installing;
  }

  /** Lee un texto con una de las voces: devuelve un WAV (PCM de 16 bits, mono). */
  async speak(input: { text: unknown; voice?: unknown; speed?: unknown; lang?: unknown }): Promise<Buffer> {
    const text = cleanText(input.text);
    if (!text) throw new LocalVoicesError(400, "No hay nada que leer.");
    if (text.length > MAX_SPEAK_CHARS) throw new LocalVoicesError(413, "El texto es demasiado largo para leerlo de una vez.");
    if (this.#stopped) throw new LocalVoicesError(503, "Las voces se están cerrando.");
    const location = this.#location();
    if (!location) throw new LocalVoicesError(409, "Las voces de este PC todavía no están descargadas.");
    const voice = this.#model.voices.find((item) => item.id === input.voice) ?? this.#model.voices[0]!;
    const speed = Number(input.speed);
    const request: SynthesisRequest = {
      text,
      sid: voice.sid,
      speed: Number.isFinite(speed) ? Math.min(2, Math.max(0.5, speed)) : 1,
      lang: this.#language(input.lang),
      numSteps: this.#model.numSteps,
    };
    const run = this.#queue.then(() => this.#synthesize(request, location.dir));
    this.#queue = run.catch(() => undefined);
    const audio = await run;
    return encodeWav(audio.samples, audio.sampleRate);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
    this.#killWorker("Las voces se cerraron.");
  }

  // ---------- modelo ----------

  #ownDir(): string {
    return join(this.#dir, "voces", this.#model.dir);
  }

  /** La copia que se usa: la propia si está completa; si no, la de OpenBot. */
  #location(): { dir: string; source: "closedbot" | "openbot" } | null {
    if (modelComplete(this.#model, this.#ownDir())) return { dir: this.#ownDir(), source: "closedbot" };
    const shared = this.#shared.find((dir) => modelComplete(this.#model, dir));
    return shared ? { dir: shared, source: "openbot" } : null;
  }

  #language(value: unknown): string {
    const base = String(value ?? "")
      .trim()
      .toLowerCase()
      .split(/[-_]/)[0];
    return base && this.#model.languages.includes(base) ? base : "es";
  }

  async #download(): Promise<void> {
    const root = join(this.#dir, "voces");
    mkdirSync(root, { recursive: true });
    // Restos de una descarga cortada (la app se cerró a mitad): se borran antes de empezar.
    for (const entry of readdirSync(root)) {
      if (entry.startsWith(STAGING_PREFIX)) rmSync(join(root, entry), { recursive: true, force: true });
    }
    const staging = join(root, `${STAGING_PREFIX}${Date.now()}`);
    mkdirSync(staging, { recursive: true });
    const files = allFiles(this.#model);
    const total = totalBytes(this.#model);
    let done = 0;
    this.#setState("downloading", 0);
    this.#log("info", `Descargando las voces ${this.#model.label} (${Math.round(total / 1_000_000)} MB)…`);
    try {
      for (const file of files) {
        await downloadFile(this.#fetch, `${this.#model.baseUrl}${file.name}`, join(staging, file.name), file, (received) => {
          this.#setState("downloading", Math.min(0.999, (done + received) / total));
        });
        done += file.bytes;
      }
      if (!modelComplete(this.#model, staging)) throw new Error("faltan partes del modelo");
      // Se descarga aparte y se mueve entero al final: un corte a mitad nunca deja un modelo a medias.
      rmSync(this.#ownDir(), { recursive: true, force: true });
      await renameWithRetry(staging, this.#ownDir());
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    this.#log("info", "Las voces quedaron descargadas.");
  }

  #setState(state: LocalVoicesState, progress: number | null = null, error: string | null = null): void {
    const changed = state !== this.#state || error !== this.#error;
    const now = Date.now();
    // El avance de la descarga se avisa como mucho dos veces por segundo.
    if (!changed && state === "downloading" && now - this.#lastEmit < 500) {
      this.#progress = progress;
      return;
    }
    this.#state = state;
    this.#progress = state === "downloading" ? progress : null;
    this.#error = state === "error" ? error : null;
    this.#lastEmit = now;
    this.emit("status", this.status());
  }

  // ---------- lectura ----------

  async #synthesize(request: SynthesisRequest, dir: string): Promise<{ samples: Float32Array; sampleRate: number }> {
    this.#touch();
    if (this.#synthesizeOverride) return this.#synthesizeOverride(request);
    const worker = await this.#ensureWorker(dir);
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.#pending.delete(id);
          reject(new LocalVoicesError(504, "La voz tardó demasiado."));
          // Un proceso trabado no sirve para la siguiente frase.
          this.#killWorker("La voz tardó demasiado.");
        },
        30_000 + request.text.length * 200,
      );
      this.#pending.set(id, {
        resolve: (audio) => {
          clearTimeout(timer);
          this.#touch();
          resolve(audio);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      worker.child.send({ type: "generate", id, ...request });
    });
  }

  #ensureWorker(dir: string): Promise<Worker> {
    if (this.#worker && this.#worker.dir !== dir) this.#killWorker("Cambió el modelo de las voces.");
    if (this.#worker) return this.#worker.ready.then(() => this.#worker as Worker);
    const script = fileURLToPath(new URL("./voice-worker.js", import.meta.url));
    const env: NodeJS.ProcessEnv = {};
    for (const name of WORKER_ENV) if (process.env[name] !== undefined) env[name] = process.env[name];
    const child = fork(script, [], { execArgv: [], env, serialization: "advanced", stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-2_000);
    });
    let settle: { resolve: () => void; reject: (error: Error) => void } | null = null;
    const ready = new Promise<void>((resolve, reject) => {
      settle = { resolve, reject };
    });
    const loadTimer = setTimeout(() => {
      settle?.reject(new LocalVoicesError(504, "Las voces tardaron demasiado en cargar."));
      this.#killWorker("Las voces tardaron demasiado en cargar.");
    }, WORKER_LOAD_MS);
    const worker: Worker = { child, ready, dir };
    this.#worker = worker;
    child.on("message", (message: unknown) => {
      if (!isRecord(message)) return;
      if (message.type === "ready") {
        clearTimeout(loadTimer);
        this.#log("info", `Voces ${this.#model.label} listas (cargaron en ${Number(message.ms) || 0} ms, ${Number(message.speakers) || 0} voces).`);
        settle?.resolve();
        settle = null;
        return;
      }
      if (message.type === "error" && message.id === undefined) {
        clearTimeout(loadTimer);
        const error = new LocalVoicesError(500, `No se pudieron cargar las voces: ${String(message.message ?? "error desconocido")}`);
        settle?.reject(error);
        settle = null;
        this.#killWorker(error.message);
        return;
      }
      const pending = this.#pending.get(Number(message.id));
      if (!pending) return;
      this.#pending.delete(Number(message.id));
      if (message.type === "result" && message.samples instanceof Float32Array && typeof message.sampleRate === "number") {
        pending.resolve({ samples: message.samples, sampleRate: message.sampleRate });
      } else {
        pending.reject(new LocalVoicesError(500, `La voz falló: ${String(message.message ?? "respuesta inválida")}`));
      }
    });
    child.once("exit", (code, signal) => {
      clearTimeout(loadTimer);
      if (this.#worker !== worker) return;
      this.#worker = null;
      const detail = lastLine(stderr);
      const error = new LocalVoicesError(500, `El proceso de las voces se cerró (${signal ?? code ?? "?"})${detail ? `: ${detail}` : ""}.`);
      if (code !== 0 && !this.#stopped) this.#log("warn", error.message);
      settle?.reject(error);
      settle = null;
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    });
    child.once("error", (error) => {
      clearTimeout(loadTimer);
      settle?.reject(new LocalVoicesError(500, `No se pudieron arrancar las voces: ${error.message}`));
      settle = null;
    });
    child.send({ type: "load", config: supertonicConfig(this.#model, dir) });
    return ready.then(() => worker);
  }

  #killWorker(reason: string): void {
    const worker = this.#worker;
    if (!worker) return;
    this.#worker = null;
    const error = new LocalVoicesError(500, reason);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    worker.child.kill();
  }

  /** Reinicia la cuenta de inactividad: sin leer nada un rato, se libera la memoria del modelo. */
  #touch(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      if (this.#worker) {
        this.#log("info", "Cierro las voces por inactividad.");
        this.#killWorker("Las voces se cerraron por inactividad.");
      }
    }, this.#idleMs);
    this.#idleTimer.unref();
  }
}

/** Configuración de sherpa-onnx para Supertonic con los archivos de esa carpeta. */
export function supertonicConfig(model: LocalVoiceModel, dir: string): Record<string, unknown> {
  const files = Object.fromEntries(Object.entries(model.files).map(([key, file]) => [key, join(dir, (file as VoiceFile).name)]));
  return {
    model: { supertonic: files, numThreads: Math.max(1, Math.min(4, availableParallelism() - 1)), provider: "cpu", debug: 0 },
    maxNumSentences: 1,
  };
}

function allFiles(model: LocalVoiceModel): VoiceFile[] {
  return [...Object.values(model.files), ...model.extra];
}

function totalBytes(model: LocalVoiceModel): number {
  return allFiles(model).reduce((sum, file) => sum + file.bytes, 0);
}

/** Los archivos que usa sherpa-onnx están y tienen el tamaño publicado. */
function modelComplete(model: LocalVoiceModel, dir: string): boolean {
  return Object.values(model.files).every((file) => {
    try {
      return statSync(join(dir, file.name)).size === file.bytes;
    } catch {
      return false;
    }
  });
}

/** Baja un archivo y comprueba su tamaño y su SHA-256 antes de dejarlo con su nombre. */
async function downloadFile(fetcher: typeof fetch, url: string, destination: string, file: VoiceFile, onProgress: (received: number) => void): Promise<void> {
  const partial = `${destination}.part`;
  const controller = new AbortController();
  let stall = setTimeout(() => controller.abort(), DOWNLOAD_STALL_MS);
  const hash = createHash("sha256");
  let received = 0;
  try {
    const response = await fetcher(url, { redirect: "follow", signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`el servidor respondió ${response.status}`);
    const out = createWriteStream(partial);
    const closed = new Promise<void>((resolve, reject) => {
      out.once("error", reject);
      out.once("close", resolve);
    });
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        clearTimeout(stall);
        stall = setTimeout(() => controller.abort(), DOWNLOAD_STALL_MS);
        hash.update(chunk);
        received += chunk.length;
        if (received > file.bytes) throw new Error(`${file.name} es más grande de lo publicado`);
        if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", resolve));
        onProgress(received);
      }
    } finally {
      out.end();
      await closed;
    }
  } catch (error) {
    rmSync(partial, { force: true });
    if (controller.signal.aborted) throw new Error("la descarga se quedó detenida; revisa la conexión a internet");
    throw error;
  } finally {
    clearTimeout(stall);
  }
  if (received !== file.bytes) {
    rmSync(partial, { force: true });
    throw new Error(`de ${file.name} llegaron ${received} bytes y se esperaban ${file.bytes}`);
  }
  if (hash.digest("hex") !== file.sha256) {
    rmSync(partial, { force: true });
    throw new Error(`${file.name} no coincide con el publicado (SHA-256 distinto)`);
  }
  renameSync(partial, destination);
}

/** Texto para leer: sin espacios de más ni caracteres de control. */
function cleanText(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** WAV PCM de 16 bits, mono. */
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index] ?? 0));
    data.writeInt16LE(Math.round(value < 0 ? value * 32_768 : value * 32_767), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** En Windows el antivirus puede tener abiertos un momento los archivos recién descargados. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 6 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}

function lastLine(text: string): string {
  return (
    text
      .trim()
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .pop() ?? ""
  ).slice(0, 300);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
