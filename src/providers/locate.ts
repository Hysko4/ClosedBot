// Dónde están los programas de los proveedores (Codex, Grok, Gemini) en este equipo. Como OpenBot, se
// busca en el PATH y en los lugares donde los dejan sus instaladores, para no pedir que se instale de
// nuevo lo que ya está.

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

export type CliName = "codex" | "grok" | "gemini";

export interface LocatedCli {
  path: string;
  /** De dónde salió, para mostrarlo en Ajustes. */
  source: "config" | "path" | "npm" | "app" | "oficial" | "openbot";
}

export interface LocateOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Ruta elegida a mano (CODEX_BIN, GROK_BIN, GEMINI_BIN); si no existe, se busca igual en los demás lugares. */
  configured?: string | null;
}

const SOURCE_LABEL: Record<LocatedCli["source"], string> = {
  config: "la ruta configurada",
  path: "el PATH",
  npm: "los programas de npm",
  app: "la app de escritorio",
  oficial: "su instalador oficial",
  openbot: "la copia de OpenBot",
};

export function describeSource(source: LocatedCli["source"]): string {
  return SOURCE_LABEL[source];
}

/** Busca el programa del proveedor; null si no está en ninguno de los lugares conocidos. */
export function locateCli(name: CliName, options: LocateOptions = {}): LocatedCli | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const configured = options.configured?.trim();
  if (configured && configured !== name) {
    if (existsSync(configured)) return { path: configured, source: "config" };
    const fromPath = findOnPath(configured, env, platform);
    if (fromPath) return { path: fromPath, source: "config" };
  }
  const onPath = findOnPath(name, env, platform);
  if (onPath) return { path: onPath, source: "path" };
  for (const candidate of knownLocations(name, env, platform)) {
    const found = candidate.find();
    if (found) return { path: found, source: candidate.source };
  }
  return null;
}

/** Busca un programa en el PATH (en Windows, con las extensiones de PATHEXT). */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  if (name.includes("/") || name.includes("\\")) return isFile(name) ? name : null;
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const separator = platform === "win32" ? ";" : delimiter;
  const extensions =
    platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
          .split(";")
          .map((ext) => ext.trim().toLowerCase())
          .filter((ext) => [".exe", ".cmd", ".bat", ".com"].includes(ext))
      : [""];
  for (const dir of pathValue.split(separator)) {
    const clean = dir.trim().replace(/^"(.*)"$/, "$1");
    if (!clean) continue;
    for (const ext of extensions) {
      const candidate = join(clean, name + ext);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

interface Candidate {
  source: LocatedCli["source"];
  find: () => string | null;
}

function knownLocations(name: CliName, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Candidate[] {
  const home = env.USERPROFILE || env.HOME || homedir();
  const appData = env.APPDATA || join(home, "AppData", "Roaming");
  const localAppData = env.LOCALAPPDATA || join(home, "AppData", "Local");
  const file = (path: string) => () => (isFile(path) ? path : null);
  const list: Candidate[] = [];
  if (platform === "win32") {
    // npm install -g deja un .cmd en %APPDATA%\npm.
    if (name !== "grok") list.push({ source: "npm", find: file(join(appData, "npm", `${name}.cmd`)) });
    if (name === "codex") {
      // La app de escritorio de Codex trae su propio codex.exe en una carpeta que cambia con cada versión.
      list.push({ source: "app", find: () => newestIn(join(localAppData, "OpenAI", "Codex", "bin"), (dir) => join(dir, "codex.exe")) });
    }
    if (name === "grok") {
      list.push({ source: "oficial", find: file(join(home, ".grok", "bin", "grok.exe")) });
      list.push({ source: "oficial", find: file(join(localAppData, "Programs", "grok", "grok.exe")) });
      list.push({ source: "oficial", find: file(join(localAppData, "grok", "bin", "grok.exe")) });
    }
    // OpenBot descarga los suyos en %APPDATA%\OpenBot\provider-runtimes\<proveedor>\win32-x64\<versión>\bin.
    if (name === "codex" || name === "grok") {
      list.push({
        source: "openbot",
        find: () => newestIn(join(appData, "OpenBot", "provider-runtimes", name, "win32-x64"), (dir) => join(dir, "bin", `${name}.exe`)),
      });
    }
  } else {
    const npmPrefix = env.npm_config_prefix || env.NPM_CONFIG_PREFIX;
    if (npmPrefix) list.push({ source: "npm", find: file(join(npmPrefix, "bin", name)) });
    list.push({ source: "npm", find: file(join(home, ".npm-global", "bin", name)) });
    list.push({ source: "npm", find: file(join(dirname(process.execPath), name)) });
    if (name === "grok") {
      list.push({ source: "oficial", find: file(join(home, ".grok", "bin", "grok")) });
      list.push({ source: "oficial", find: file(join(home, ".local", "bin", "grok")) });
    }
    if (name === "codex" || name === "gemini") list.push({ source: "path", find: file(join(home, ".local", "bin", name)) });
    for (const dir of ["/usr/local/bin", "/opt/homebrew/bin"]) list.push({ source: "path", find: file(join(dir, name)) });
  }
  return list;
}

/** De las subcarpetas de `root`, la versión más nueva que tenga el programa (por fecha de modificación). */
function newestIn(root: string, pick: (dir: string) => string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  let best: { path: string; time: number } | null = null;
  for (const entry of entries) {
    const candidate = pick(join(root, entry));
    try {
      const info = statSync(candidate);
      if (!info.isFile()) continue;
      if (!best || info.mtimeMs > best.time) best = { path: candidate, time: info.mtimeMs };
    } catch {
      // Sin el programa en esa carpeta.
    }
  }
  return best?.path ?? null;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** npm del mismo Node que corre ClosedBot (en Windows, npm.cmd junto a node.exe). */
export function npmCommand(platform: NodeJS.Platform = process.platform, execPath = process.execPath): string {
  const local = join(dirname(execPath), platform === "win32" ? "npm.cmd" : "npm");
  return existsSync(local) ? local : platform === "win32" ? "npm.cmd" : "npm";
}
