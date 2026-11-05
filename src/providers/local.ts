import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ProviderStatus } from "../service.js";
import { ClaudeAgentClient, type ClaudeClientOptions } from "./claude.js";

export interface LocalModelConfig {
  model: string;
  baseUrl: string;
  configDir: string;
  executable?: string;
  modelPath?: string;
  chatTemplatePath?: string;
  modelsPresetPath?: string;
  models?: Array<{ model: string; displayName: string }>;
  contextSize: number;
  gpuLayers: number | "auto";
}

/** Ventanas reales de cada modelo del router, para no mezclar 8k/16k/32k en el SDK. */
export function localContextWindows(presets: string): Record<string, number> {
  const windows: Record<string, number> = {};
  let section = "";
  for (const line of presets.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) { section = header[1]!.trim(); continue; }
    const size = line.match(/^\s*ctx-size\s*=\s*(\d+)\s*(?:[;#].*)?$/);
    if (section && section !== "*" && size) {
      const value = Number(size[1]);
      if (value >= 4096 && value <= 262144) windows[section] = value;
    }
  }
  return windows;
}

/** Solo localhost: nunca se envían conversaciones a un proveedor remoto por error. */
export function readLocalModelConfig(dataDir: string): LocalModelConfig | null {
  const file = join(dataDir, "local-model.json");
  if (!existsSync(file)) return null;
  const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  if (!value || typeof value.model !== "string" || !value.model.trim()) throw new Error("local-model.json necesita model.");
  const url = new URL(String(value.baseUrl ?? "http://127.0.0.1:8089"));
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("El servidor local debe usar HTTP en loopback, sin credenciales ni ruta.");
  }
  const executable = typeof value.executable === "string" ? value.executable : undefined;
  const modelPath = typeof value.modelPath === "string" ? value.modelPath : undefined;
  const chatTemplatePath = typeof value.chatTemplatePath === "string" ? value.chatTemplatePath : undefined;
  const modelsPresetPath = typeof value.modelsPresetPath === "string" ? value.modelsPresetPath : undefined;
  if (modelsPresetPath && !isAbsolute(modelsPresetPath)) throw new Error("modelsPresetPath debe ser una ruta local absoluta.");
  let models: LocalModelConfig["models"];
  if (value.models !== undefined) {
    if (!Array.isArray(value.models) || !value.models.length) throw new Error("models debe ser un catálogo no vacío.");
    models = value.models.map((item: unknown) => {
      if (!item || typeof item !== "object" || !("model" in item) || typeof item.model !== "string" || !item.model.trim()) throw new Error("Cada modelo necesita un identificador.");
      return { model: item.model.trim(), displayName: "displayName" in item && typeof item.displayName === "string" ? item.displayName : item.model.trim() };
    });
    if (new Set(models.map(m => m.model)).size !== models.length) throw new Error("El catálogo contiene un modelo duplicado.");
    if (!models.some(m => m.model === value.model)) throw new Error("El catálogo debe incluir el modelo predeterminado.");
  }
  if (chatTemplatePath && !isAbsolute(chatTemplatePath)) throw new Error("chatTemplatePath debe ser una ruta local absoluta.");
  const modelSource = modelsPresetPath || modelPath;
  if ((executable && (!modelSource || !isAbsolute(executable) || !isAbsolute(modelSource))) || (!executable && modelPath && !modelsPresetPath)) throw new Error("executable y modelPath o modelsPresetPath deben ser rutas absolutas y configurarse juntos.");
  const contextSize = value.contextSize ?? 32768;
  const gpuLayers = value.gpuLayers ?? "auto";
  if (!Number.isInteger(contextSize) || Number(contextSize) < 4096 || Number(contextSize) > 262144) throw new Error("contextSize debe estar entre 4096 y 262144.");
  if (gpuLayers !== "auto" && (!Number.isInteger(gpuLayers) || Number(gpuLayers) < 0 || Number(gpuLayers) > 999)) throw new Error("gpuLayers debe ser auto o un entero entre 0 y 999.");
  return { model: value.model.trim(), baseUrl: url.origin, configDir: join(dataDir, "local-model", "agent-state"), executable, modelPath, chatTemplatePath, modelsPresetPath, models, contextSize: Number(contextSize), gpuLayers: gpuLayers as number | "auto" };
}

export function localProviderStatus(config: LocalModelConfig): ProviderStatus {
  const available = (!config.executable || (existsSync(config.executable) && existsSync(config.modelsPresetPath || config.modelPath!))) && (config.modelsPresetPath ? existsSync(config.modelsPresetPath) : !config.chatTemplatePath || existsSync(config.chatTemplatePath));
  return { id: "local", label: "Qwen local", available, loggedIn: available, canSignIn: false, canInstall: false,
    detail: available ? `${config.model} · ${config.baseUrl} · inferencia en este PC; se inicia al usarlo.` : "Falta el ejecutable de llama.cpp, el GGUF o la plantilla configurada en local-model.json." };
}

/** Comparte un servidor entre agentes. Solo termina el proceso que esta instancia inició. */
export class LocalModelRuntime {
  #child: ChildProcess | null = null;
  #ready: Promise<void> | null = null;
  #stopped = false;
  constructor(readonly config: LocalModelConfig) {}

  async #healthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
      return response.ok;
    } catch { return false; }
  }

  async ensureReady(): Promise<void> {
    if (this.#stopped) throw new Error("El servidor local está detenido.");
    if (!this.#ready) this.#ready = this.#start().catch((error: unknown) => { this.#ready = null; throw error; });
    await this.#ready;
    if (this.#stopped) throw new Error("El servidor local está detenido.");
    if (!(await this.#healthy())) { this.#ready = null; throw new Error("Qwen local no responde. Vuelve a intentar para reiniciarlo."); }
  }

  async #start(): Promise<void> {
    const healthy = await this.#healthy();
    if (this.#stopped) throw new Error("Inicio local cancelado.");
    if (!healthy) {
      if (!this.config.executable || (!this.config.modelsPresetPath && !this.config.modelPath)) throw new Error(`Inicia el servidor local en ${this.config.baseUrl}.`);
      if (!this.#child || this.#child.exitCode !== null) {
        const url = new URL(this.config.baseUrl);
        mkdirSync(this.config.configDir, { recursive: true });
        const fd = openSync(join(this.config.configDir, "..", "server.log"), "a");
        const args = this.config.modelsPresetPath ? ["--models-preset", this.config.modelsPresetPath, "--models-max", "1", "--host", url.hostname.replace(/[\[\]]/g, ""), "--port", url.port || "80"] : ["-m", this.config.modelPath!, "--alias", this.config.model,
          "--host", url.hostname.replace(/[\[\]]/g, ""), "--port", url.port || "80", "-c", String(this.config.contextSize),
          "-ngl", String(this.config.gpuLayers), "--fit", "on", "--fit-target", "1024", "--parallel", "1", "-b", "512", "-ub", "128",
          "--jinja", ...(this.config.chatTemplatePath ? ["--chat-template-file", this.config.chatTemplatePath] : []), "-fa", "on", "--cache-type-k", "q8_0", "--cache-type-v", "q8_0", "--reasoning", "off"];
        const child = spawn(this.config.executable, args,
          { windowsHide: true, stdio: ["ignore", fd, fd] });
        closeSync(fd);
        this.#child = child;
        let launchError: Error | null = null;
        child.on("error", (error) => { launchError = error; });
        child.once("exit", () => { if (this.#child === child) { this.#child = null; this.#ready = null; } });
        for (let attempt = 0; attempt < 180; attempt += 1) {
          if (this.#stopped) throw new Error("Inicio local cancelado.");
          if (launchError) throw launchError;
          if (child.exitCode !== null || !this.#child) throw new Error("llama.cpp no pudo cargar Qwen. Revisa local-model/server.log.");
          if (await this.#healthy()) break;
          await delay(1000);
        }
      }
      if (!(await this.#healthy())) throw new Error("Qwen tardó demasiado en cargar. Revisa local-model/server.log.");
    }
    const response = await fetch(`${this.config.baseUrl}/v1/models`, { signal: AbortSignal.timeout(3000) });
    const models = await response.json() as { data?: Array<{ id: string }> };
    if (!response.ok || !models.data?.some((model) => model.id === this.config.model)) throw new Error("El servidor local no ofrece el modelo configurado.");
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    const child = this.#child;
    if (!child) return;
    if (this.config.modelsPresetPath) {
      await Promise.allSettled((this.config.models ?? [{ model: this.config.model }]).map(({ model }) => fetch(`${this.config.baseUrl}/models/unload`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }), signal: AbortSignal.timeout(5000) })));
    }
    child.kill();
    await Promise.race([new Promise<void>((resolve) => child.once("exit", () => resolve())), delay(3000)]);
    this.#child = null;
  }
}

export class LocalAgentClient extends ClaudeAgentClient {
  constructor(readonly runtime: LocalModelRuntime, options: Omit<ClaudeClientOptions, "local"> = {}) {
    const contextSizes = runtime.config.modelsPresetPath && existsSync(runtime.config.modelsPresetPath)
      ? localContextWindows(readFileSync(runtime.config.modelsPresetPath, "utf8")) : {};
    super({ ...options, local: { ...runtime.config, contextSizes } });
  }
  override async request<T>(method: string, params: unknown): Promise<T> {
    if (["thread/start", "thread/resume"].includes(method)) await this.runtime.ensureReady();
    return super.request<T>(method, params);
  }
}
