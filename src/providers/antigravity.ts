// Gemini por Antigravity, como OpenBot. Google ya no acepta Gemini CLI con cuentas personales («This
// client is no longer supported for Gemini Code Assist for individuals… migrate to Antigravity»), así
// que ClosedBot usa el servidor ACP de Antigravity (agy_acp_server), que Google publica en el registro
// de ACP. La sesión con Google queda en ~/.gemini/antigravity-acp/acp_token.json y la comparten las
// apps que usan ese servidor (OpenBot incluido).

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, createWriteStream, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface AntigravityBuild {
  /** .zip oficial de Google. */
  archive: string;
  /** Programa dentro del .zip. */
  cmd: string;
  args: string[];
  sha256: string;
}

/** Del registro de ACP (https://github.com/agentclientprotocol/registry, antigravity-acp/agent.json). */
export const ANTIGRAVITY = {
  version: "1.4.5",
  builds: {
    "darwin-arm64": {
      archive: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.5-darwin-arm64.zip",
      cmd: "./agy_acp_server.par",
      args: [],
      sha256: "886fff7767d08994ca39eb02c3d01a7532c7325a94aa33aaf52d52068733284f",
    },
    "darwin-x64": {
      archive: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.5-darwin-x86_64.zip",
      cmd: "./agy_acp_server.par",
      args: [],
      sha256: "b39f3573c03b9acb9df028853f647527f1f3133f32bd77e78b796e48a205114a",
    },
    "linux-x64": {
      archive: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.5-linux-x86_64.zip",
      cmd: "./agy_acp_server.par",
      args: ["--uid="],
      sha256: "923923a0d7dc8073f66cc6f78647a3107e3a7ee2b7e1a24df8b3927b5188013b",
    },
    "linux-arm64": {
      archive: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.5-linux-arm64.zip",
      cmd: "./agy_acp_server.par",
      args: ["--uid="],
      sha256: "7d64246633ae094f67e3bbcd2d679e89048f91346d5339313336e7483f40f056",
    },
    "win32-x64": {
      archive: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.5-windows-x86_64.zip",
      cmd: "./agy_acp_server.exe",
      args: [],
      sha256: "d24f4c73c9f96d4f44384e281c855a56c72d8eaa9c5b0fad7ccb1635c6b63f50",
    },
    "win32-arm64": {
      archive: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.5-windows-arm64.zip",
      cmd: "./agy_acp_server.exe",
      args: [],
      sha256: "ab0a9aac8349e08ef289be6d16da8f89e3abe60eba5158032ef78c4a1220261c",
    },
  } as Record<string, AntigravityBuild>,
};

export function antigravityBuild(platform: NodeJS.Platform = process.platform, arch: string = process.arch): AntigravityBuild | null {
  return ANTIGRAVITY.builds[`${platform}-${arch}`] ?? null;
}

/** Nombre del programa: un .exe en Windows y un .par (un Python empaquetado) en macOS y Linux. */
export function antigravityProgram(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par";
}

export function antigravityArgs(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string[] {
  return [...(antigravityBuild(platform, arch)?.args ?? (platform === "linux" ? ["--uid="] : []))];
}

/** Donde el servidor guarda la sesión con Google (con AGY_ACP_FORCE_FILE_STORAGE=1). */
export function antigravityTokenPath(home: string): string {
  return join(home, ".gemini", "antigravity-acp", "acp_token.json");
}

/** Lo que escribe el servidor cuando no tiene sesión: se queda esperando hasta 5 minutos a que alguien entre. */
export const ANTIGRAVITY_SIGN_IN_PROMPT = /open the following link to authenticate/i;

/**
 * Entorno del servidor: la sesión va en un archivo (no en el llavero), así ClosedBot ve si está iniciada.
 * Al atender chats, BROWSER=true: si le falta la sesión, no abre el navegador en medio de un turno.
 */
export function antigravityEnv(base: NodeJS.ProcessEnv, options: { chat: boolean }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, AGY_ACP_FORCE_FILE_STORAGE: "1" };
  if (options.chat) env.BROWSER = "true";
  return env;
}

// ---------- carpeta temporal propia ----------

const TEMP_PREFIX = "agente-";

/**
 * Cada vez que arranca, el servidor descomprime unos 300 MB en la carpeta temporal y, si muere, los deja
 * ahí. Por eso cada proceso recibe una carpeta propia dentro de <datos>/tmp, que se borra al terminar.
 */
export function makePrivateTemp(root: string): string {
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, TEMP_PREFIX));
}

export function withTemp(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  return { ...env, TEMP: dir, TMP: dir, TMPDIR: dir };
}

/** Borra la carpeta. En Windows, un proceso que termina de cerrarse o el antivirus pueden tenerla tomada un rato. */
export function removePrivateTemp(dir: string, attempts = 5): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch {
    if (attempts > 1) setTimeout(() => removePrivateTemp(dir, attempts - 1), 2_000).unref();
  }
}

/** Restos de procesos que no alcanzaron a limpiar (la app se cerró de golpe). */
export function cleanStaleTemps(root: string): void {
  for (const entry of listDir(root)) {
    if (entry.startsWith(TEMP_PREFIX)) removePrivateTemp(join(root, entry));
  }
}

// ---------- instalación ----------

export interface InstallOptions {
  /** Carpeta de programas de ClosedBot (<datos>/programas). */
  dir: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Para las pruebas: otro archivo y otra versión. */
  build?: AntigravityBuild;
  version?: string;
  fetch?: typeof fetch;
  extract?: (archive: string, destination: string) => Promise<void>;
  onProgress?: (received: number, total: number | null) => void;
}

const STAGING_PREFIX = ".instalando-";
const DOWNLOAD_STALL_MS = 60_000;

/**
 * Descarga el .zip oficial de Google, comprueba su SHA-256 publicado y lo deja en
 * <dir>/antigravity/<versión>. Devuelve la ruta del programa.
 */
export async function installAntigravity(options: InstallOptions): Promise<string> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const build = options.build ?? antigravityBuild(platform, arch);
  if (!build) throw new Error(`Google no publica Antigravity para este sistema (${platform}-${arch}).`);
  const version = options.version ?? ANTIGRAVITY.version;
  const root = join(options.dir, "antigravity");
  const downloads = join(options.dir, "descargas");
  mkdirSync(root, { recursive: true });
  mkdirSync(downloads, { recursive: true });
  // Restos de una instalación cortada (la app se cerró a mitad): se borran antes de empezar.
  for (const entry of listDir(root)) {
    if (entry.startsWith(STAGING_PREFIX)) rmSync(join(root, entry), { recursive: true, force: true });
  }
  const archive = join(downloads, `antigravity-${version}.zip`);
  const partial = `${archive}.part`;
  rmSync(partial, { force: true });

  const controller = new AbortController();
  let stall = setTimeout(() => controller.abort(), DOWNLOAD_STALL_MS);
  const hash = createHash("sha256");
  try {
    const response = await (options.fetch ?? fetch)(build.archive, { redirect: "follow", signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`el servidor de Google respondió ${response.status}`);
    const total = Number(response.headers.get("content-length")) || null;
    const out = createWriteStream(partial);
    const closed = new Promise<void>((resolve, reject) => {
      out.once("error", reject);
      out.once("close", resolve);
    });
    let received = 0;
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        clearTimeout(stall);
        stall = setTimeout(() => controller.abort(), DOWNLOAD_STALL_MS);
        hash.update(chunk);
        received += chunk.length;
        if (!out.write(chunk)) await new Promise<void>((resolve) => out.once("drain", resolve));
        options.onProgress?.(received, total);
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
  if (hash.digest("hex") !== build.sha256) {
    rmSync(partial, { force: true });
    throw new Error("el archivo descargado no coincide con el que publica Google (SHA-256 distinto)");
  }
  renameSync(partial, archive);

  // Se descomprime aparte y se mueve entero al final: un corte a mitad nunca deja un programa a medias.
  const staging = join(root, `${STAGING_PREFIX}${Date.now()}`);
  try {
    mkdirSync(staging, { recursive: true });
    await (options.extract ?? ((file: string, destination: string) => extractZip(file, destination, platform)))(archive, staging);
    const name = basename(build.cmd);
    if (!isFile(join(staging, name))) throw new Error(`al archivo le falta ${name}`);
    if (platform !== "win32") chmodSync(join(staging, name), 0o755);
    const target = join(root, version);
    rmSync(target, { recursive: true, force: true });
    await renameWithRetry(staging, target);
    return join(target, name);
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(archive, { force: true });
  }
}

/** Descomprime un .zip con lo que trae el sistema: tar.exe en Windows 10 y 11, tar en macOS, unzip o Python en Linux. */
export function extractZip(archive: string, destination: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === "win32") {
    const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    if (isFile(tar)) return runTool(tar, ["-xf", archive, "-C", destination]);
    const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
    return runTool("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(destination)} -Force`,
    ]);
  }
  if (platform === "darwin") return runTool("tar", ["-xf", archive, "-C", destination]);
  return runTool("unzip", ["-q", "-o", archive, "-d", destination]).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return runTool("python3", ["-m", "zipfile", "-e", archive, destination]);
  });
}

function runTool(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-1_000);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(lastLine(stderr) || `${basename(command)} terminó con el código ${code}`));
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

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
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

/** «…/antigravity/1.4.5/agy_acp_server.exe» (de ClosedBot) o «…/1.4.5/bin/agy_acp_server.exe» (de OpenBot) → «1.4.5». */
export function antigravityVersion(path: string): string | null {
  for (const dir of [dirname(path), dirname(dirname(path))]) {
    const name = basename(dir);
    if (/^\d+\.\d+\.\d+(?:[-+.][\w.-]+)?$/.test(name)) return name;
  }
  return null;
}

/** Desde la 1.4.1, Antigravity contesta «/usage» sin pasar por el modelo: así se lee el uso del plan. */
export function antigravityHasUsage(version: string | null): boolean {
  if (!version) return false;
  const [major = 0, minor = 0, patch = 0] = version.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  return major !== 1 ? major > 1 : minor !== 4 ? minor > 4 : patch >= 1;
}
