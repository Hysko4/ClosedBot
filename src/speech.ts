// Dictado local: reconoce la voz en este mismo equipo con sherpa-onnx y el modelo Parakeet TDT v3
// (25 idiomas europeos, con puntuación). Sirve donde el reconocimiento del navegador no funciona,
// como en Edge, cuyo servicio de voz suele fallar con «network». La voz nunca sale del equipo.

import { type ChildProcess, fork, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface SpeechModel {
  id: string;
  label: string;
  /** Archivo .tar.bz2 publicado por el proyecto sherpa-onnx. */
  url: string;
  /** Tamaño exacto del archivo, para comprobar la descarga y mostrar el avance. */
  bytes: number;
  /** SHA-256 publicado del archivo (null: no se comprueba). */
  sha256: string | null;
  /** Carpeta que trae el archivo al descomprimirlo. */
  dir: string;
  files: { encoder: string; decoder: string; joiner: string; tokens: string };
}

/** Parakeet TDT 0.6B v3 (NVIDIA), convertido por sherpa-onnx: español, inglés, portugués y otros 22 idiomas. */
export const PARAKEET_V3: SpeechModel = {
  id: "parakeet-tdt-0.6b-v3",
  label: "Parakeet v3 (25 idiomas)",
  url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2",
  bytes: 487_170_055,
  // Publicado por GitHub para el archivo (release «asr-models», 2025-08-16).
  sha256: "5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf",
  dir: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
  files: { encoder: "encoder.int8.onnx", decoder: "decoder.int8.onnx", joiner: "joiner.int8.onnx", tokens: "tokens.txt" },
};

export type SpeechState = "missing" | "downloading" | "extracting" | "ready" | "error";

export interface SpeechStatus {
  state: SpeechState;
  model: string;
  /** Tamaño de la descarga, en MB. */
  sizeMb: number;
  /** 0 a 1 mientras se descarga; null en los demás estados. */
  progress: number | null;
  error: string | null;
}

/** Reconoce un audio ya decodificado; en las pruebas reemplaza al proceso de sherpa-onnx. */
export type Recognize = (samples: Float32Array, sampleRate: number) => Promise<string>;

export interface SpeechOptions {
  /** Carpeta de los modelos y las descargas (por defecto <datos>/voz). */
  dir: string;
  model?: SpeechModel;
  fetch?: typeof fetch;
  /** Descomprime un .tar.bz2 en una carpeta (por defecto, el tar del sistema). */
  extract?: (archive: string, destination: string) => Promise<void>;
  recognize?: Recognize;
  /** Tras este tiempo sin dictar se cierra el proceso de reconocimiento y libera la memoria. */
  idleMs?: number;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

export class SpeechError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Audio de hasta seis minutos por petición; el navegador lo manda por trozos mucho más cortos. */
export const MAX_SPEECH_SECONDS = 360;
export const MAX_SPEECH_BYTES = 24 * 1024 * 1024;
const MIN_SPEECH_SECONDS = 0.2;
const DOWNLOAD_STALL_MS = 60_000;
const WORKER_LOAD_MS = 120_000;
const DEFAULT_IDLE_MS = 15 * 60_000;
const STAGING_PREFIX = ".instalando-";

/** Variables que necesita el proceso de reconocimiento; nunca recibe claves ni tokens del servidor. */
const WORKER_ENV = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "WINDIR", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LANG", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH"];

interface Pending {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
}

interface Worker {
  child: ChildProcess;
  ready: Promise<void>;
}

export class SpeechEngine extends EventEmitter {
  readonly #dir: string;
  readonly #model: SpeechModel;
  readonly #fetch: typeof fetch;
  readonly #extract: (archive: string, destination: string) => Promise<void>;
  readonly #recognizeOverride: Recognize | null;
  readonly #idleMs: number;
  readonly #log: (level: "info" | "warn" | "error", message: string) => void;
  #state: SpeechState = "missing";
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

  constructor(options: SpeechOptions) {
    super();
    this.#dir = options.dir;
    this.#model = options.model ?? PARAKEET_V3;
    this.#fetch = options.fetch ?? fetch;
    this.#extract = options.extract ?? extractTarBz2;
    this.#recognizeOverride = options.recognize ?? null;
    this.#idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
    this.#log = options.log ?? (() => undefined);
    this.#state = this.#modelReady() ? "ready" : "missing";
  }

  status(): SpeechStatus {
    // Si alguien borró el modelo mientras la app corría, se vuelve a ofrecer la descarga.
    if (this.#state === "ready" && !this.#modelReady()) this.#state = "missing";
    return {
      state: this.#state,
      model: this.#model.label,
      sizeMb: Math.round(this.#model.bytes / 1_000_000),
      progress: this.#progress,
      error: this.#error,
    };
  }

  /** Descarga y descomprime el modelo si falta. Se puede llamar varias veces: hay una sola descarga a la vez. */
  install(): Promise<void> {
    if (this.#stopped) return Promise.reject(new SpeechError(503, "El dictado se está cerrando."));
    if (this.#modelReady()) {
      this.#setState("ready");
      return Promise.resolve();
    }
    this.#installing ??= this.#download()
      .then(() => this.#setState("ready"))
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.#log("warn", `No se pudo instalar el dictado local: ${message}`);
        this.#setState("error", null, `No se pudo descargar el dictado: ${message}`);
        throw error;
      })
      .finally(() => {
        this.#installing = null;
      });
    return this.#installing;
  }

  /** Arranca el reconocimiento por adelantado (mientras la persona habla) para que el primer trozo no espere. */
  prepare(): void {
    if (this.#recognizeOverride || this.#stopped || !this.#modelReady()) return;
    this.#ensureWorker().catch(() => undefined);
    this.#touch();
  }

  /** Texto de un audio WAV (PCM de 16 bits o flotante, cualquier frecuencia). */
  transcribe(wav: Buffer): Promise<string> {
    const audio = decodeWav(wav);
    const seconds = audio.samples.length / audio.sampleRate;
    if (seconds > MAX_SPEECH_SECONDS) throw new SpeechError(413, "El audio es demasiado largo para dictarlo de una vez.");
    if (seconds < MIN_SPEECH_SECONDS) return Promise.resolve("");
    if (this.#stopped) throw new SpeechError(503, "El dictado se está cerrando.");
    if (!this.#modelReady()) throw new SpeechError(409, "El dictado local todavía no está instalado.");
    const run = this.#queue.then(() => this.#recognize(audio.samples, audio.sampleRate));
    this.#queue = run.catch(() => undefined);
    return run.then((text) => cleanTranscript(text));
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
    this.#killWorker("El dictado se cerró.");
  }

  // ---------- modelo ----------

  #modelDir(): string {
    return join(this.#dir, "modelos", this.#model.dir);
  }

  #modelFiles(dir = this.#modelDir()): { encoder: string; decoder: string; joiner: string; tokens: string } {
    const files = this.#model.files;
    return { encoder: join(dir, files.encoder), decoder: join(dir, files.decoder), joiner: join(dir, files.joiner), tokens: join(dir, files.tokens) };
  }

  #modelReady(dir = this.#modelDir()): boolean {
    return Object.values(this.#modelFiles(dir)).every((file) => {
      try {
        return statSync(file).size > 0;
      } catch {
        return false;
      }
    });
  }

  async #download(): Promise<void> {
    const downloads = join(this.#dir, "descargas");
    const models = join(this.#dir, "modelos");
    mkdirSync(downloads, { recursive: true });
    mkdirSync(models, { recursive: true });
    const archive = join(downloads, `${this.#model.dir}.tar.bz2`);
    const partial = `${archive}.part`;
    rmSync(partial, { force: true });
    // Restos de una instalación cortada (la app se cerró a mitad): se borran antes de empezar.
    for (const entry of readdirSync(models)) {
      if (entry.startsWith(STAGING_PREFIX)) rmSync(join(models, entry), { recursive: true, force: true });
    }
    this.#setState("downloading", 0);
    this.#log("info", `Descargando el dictado local (${this.#model.label}, ${Math.round(this.#model.bytes / 1_000_000)} MB)…`);

    const controller = new AbortController();
    let stall = setTimeout(() => controller.abort(), DOWNLOAD_STALL_MS);
    const hash = createHash("sha256");
    let received = 0;
    try {
      const response = await this.#fetch(this.#model.url, { redirect: "follow", signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`el servidor respondió ${response.status}`);
      const total = Number(response.headers.get("content-length")) || this.#model.bytes;
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
          if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", resolve));
          this.#setState("downloading", Math.min(0.999, received / total));
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
    if (received !== this.#model.bytes) {
      rmSync(partial, { force: true });
      throw new Error(`llegaron ${received} bytes y se esperaban ${this.#model.bytes}`);
    }
    const digest = hash.digest("hex");
    if (this.#model.sha256 && digest !== this.#model.sha256) {
      rmSync(partial, { force: true });
      throw new Error("el archivo descargado no coincide con el publicado (SHA-256 distinto)");
    }
    renameSync(partial, archive);
    this.#setState("extracting");
    // Se descomprime aparte y se mueve entero al final: un corte a mitad nunca deja un modelo a medias.
    const staging = join(models, `${STAGING_PREFIX}${Date.now()}`);
    try {
      mkdirSync(staging, { recursive: true });
      await this.#extract(archive, staging);
      const extracted = join(staging, this.#model.dir);
      if (!this.#modelReady(extracted)) throw new Error("al archivo le faltan partes del modelo");
      // Los audios de ejemplo que trae el archivo no hacen falta.
      rmSync(join(extracted, "test_wavs"), { recursive: true, force: true });
      rmSync(this.#modelDir(), { recursive: true, force: true });
      await renameWithRetry(extracted, this.#modelDir());
    } catch (error) {
      throw new Error(`no se pudo descomprimir el modelo: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      rmSync(staging, { recursive: true, force: true });
      rmSync(archive, { force: true });
    }
    this.#log("info", "El dictado local quedó instalado.");
  }

  #setState(state: SpeechState, progress: number | null = null, error: string | null = null): void {
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

  // ---------- reconocimiento ----------

  async #recognize(samples: Float32Array, sampleRate: number): Promise<string> {
    this.#touch();
    if (this.#recognizeOverride) return this.#recognizeOverride(samples, sampleRate);
    const worker = await this.#ensureWorker();
    const id = this.#nextId++;
    const seconds = samples.length / sampleRate;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.#pending.delete(id);
          reject(new SpeechError(504, "El reconocimiento tardó demasiado."));
          // Un proceso trabado no sirve para el siguiente trozo.
          this.#killWorker("El reconocimiento tardó demasiado.");
        },
        30_000 + seconds * 5_000,
      );
      this.#pending.set(id, {
        resolve: (text) => {
          clearTimeout(timer);
          this.#touch();
          resolve(text);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      worker.child.send({ type: "transcribe", id, samples, sampleRate });
    });
  }

  #ensureWorker(): Promise<Worker> {
    if (this.#worker) return this.#worker.ready.then(() => this.#worker as Worker);
    const script = fileURLToPath(new URL("./speech-worker.js", import.meta.url));
    const env: NodeJS.ProcessEnv = {};
    for (const name of WORKER_ENV) if (process.env[name] !== undefined) env[name] = process.env[name];
    const child = fork(script, [], {
      execArgv: [],
      env,
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
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
      settle?.reject(new SpeechError(504, "El dictado tardó demasiado en cargar."));
      this.#killWorker("El dictado tardó demasiado en cargar.");
    }, WORKER_LOAD_MS);
    const worker: Worker = { child, ready };
    this.#worker = worker;
    child.on("message", (message: unknown) => {
      if (!isRecord(message)) return;
      if (message.type === "ready") {
        clearTimeout(loadTimer);
        this.#log("info", `Dictado local listo (cargó en ${Number(message.ms) || 0} ms).`);
        settle?.resolve();
        settle = null;
        return;
      }
      if (message.type === "error" && message.id === undefined) {
        clearTimeout(loadTimer);
        const error = new SpeechError(500, `El dictado no pudo cargar el modelo: ${String(message.message ?? "error desconocido")}`);
        settle?.reject(error);
        settle = null;
        this.#killWorker(error.message);
        return;
      }
      const id = Number(message.id);
      const pending = this.#pending.get(id);
      if (!pending) return;
      this.#pending.delete(id);
      if (message.type === "result") pending.resolve(typeof message.text === "string" ? message.text : "");
      else pending.reject(new SpeechError(500, `El reconocimiento falló: ${String(message.message ?? "error desconocido")}`));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(loadTimer);
      if (this.#worker !== worker) return;
      this.#worker = null;
      const detail = lastLine(stderr);
      const error = new SpeechError(500, `El proceso del dictado se cerró (${signal ?? code ?? "?"})${detail ? `: ${detail}` : ""}.`);
      if (code !== 0 && !this.#stopped) this.#log("warn", error.message);
      settle?.reject(error);
      settle = null;
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    });
    child.once("error", (error) => {
      clearTimeout(loadTimer);
      settle?.reject(new SpeechError(500, `No se pudo arrancar el dictado: ${error.message}`));
      settle = null;
    });
    const files = this.#modelFiles();
    child.send({
      type: "load",
      config: {
        featConfig: { sampleRate: 16_000, featureDim: 80 },
        modelConfig: {
          transducer: { encoder: files.encoder, decoder: files.decoder, joiner: files.joiner },
          tokens: files.tokens,
          numThreads: Math.max(2, Math.min(8, availableParallelism() - 2)),
          provider: "cpu",
          debug: 0,
          modelType: "nemo_transducer",
        },
        decodingMethod: "greedy_search",
      },
    });
    return ready.then(() => worker);
  }

  #killWorker(reason: string): void {
    const worker = this.#worker;
    if (!worker) return;
    this.#worker = null;
    const error = new SpeechError(500, reason);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    worker.child.kill();
  }

  /** Reinicia la cuenta de inactividad: sin dictar un rato, se libera la memoria del modelo. */
  #touch(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      if (this.#worker) {
        this.#log("info", "Cierro el dictado local por inactividad.");
        this.#killWorker("El dictado se cerró por inactividad.");
      }
    }, this.#idleMs);
    this.#idleTimer.unref();
  }
}

// ---------- audio ----------

export interface DecodedAudio {
  samples: Float32Array;
  sampleRate: number;
}

/** Lee un WAV PCM (8, 16, 24 o 32 bits, o flotante de 32 bits). Varios canales se mezclan en uno. */
export function decodeWav(buffer: Buffer): DecodedAudio {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new SpeechError(400, "El audio no es un WAV válido.");
  }
  let offset = 12;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let data: Buffer | null = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(buffer.length, start + size);
    if (id === "fmt " && end - start >= 16) {
      format = buffer.readUInt16LE(start);
      channels = buffer.readUInt16LE(start + 2);
      sampleRate = buffer.readUInt32LE(start + 4);
      bits = buffer.readUInt16LE(start + 14);
      // WAVE_FORMAT_EXTENSIBLE: el formato real va en los dos primeros bytes del subformato.
      if (format === 0xfffe && end - start >= 26) format = buffer.readUInt16LE(start + 24);
    } else if (id === "data") {
      data = buffer.subarray(start, end);
      break;
    }
    offset = start + size + (size % 2);
  }
  if (!data || !channels || !sampleRate || sampleRate < 8_000 || sampleRate > 192_000) throw new SpeechError(400, "El audio no es un WAV válido.");
  const pcm = format === 1 && [8, 16, 24, 32].includes(bits);
  const float = format === 3 && bits === 32;
  if (!pcm && !float) throw new SpeechError(400, "Formato de audio no compatible: usa WAV PCM.");
  const bytes = bits / 8;
  const frame = bytes * channels;
  const frames = Math.floor(data.length / frame);
  const samples = new Float32Array(frames);
  for (let index = 0; index < frames; index += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const at = index * frame + channel * bytes;
      if (float) sum += data.readFloatLE(at);
      else if (bits === 16) sum += data.readInt16LE(at) / 32_768;
      else if (bits === 8) sum += (data.readUInt8(at) - 128) / 128;
      else if (bits === 24) sum += data.readIntLE(at, 3) / 8_388_608;
      else sum += data.readInt32LE(at) / 2_147_483_648;
    }
    samples[index] = Math.max(-1, Math.min(1, sum / channels));
  }
  return { samples, sampleRate };
}

/** Texto final: sin espacios de más. */
export function cleanTranscript(text: string): string {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Descomprime con el tar del sistema; en Windows, el de System32 (el de Git no entiende rutas «C:\»). */
export function extractTarBz2(archive: string, destination: string): Promise<void> {
  const command = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  if (process.platform === "win32" && !existsSync(command)) {
    return Promise.reject(new Error("no encontré tar.exe en Windows"));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["-xjf", archive, "-C", destination], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-1_000);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(lastLine(stderr) || `tar terminó con el código ${code}`));
    });
  });
}

/** En Windows el antivirus puede tener abiertos un momento los archivos recién descomprimidos. */
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
