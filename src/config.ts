import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  workspacesDir: string;
  sharedDir: string;
  publicDir: string;
  maxHops: number;
  codexBin: string;
  claudeBin: string | null;
  /** Carpeta de la sesión de Claude Code de los agentes, aparte de la que la persona use por su cuenta. */
  claudeConfigDir: string;
  playwright: boolean;
  detectProviders: boolean;
  sessionDays: number;
  secureCookies: "auto" | "always" | "never";
  /**
   * Carpeta de datos de cuando la app se llamaba Cuadrilla (~/.cuadrilla), si todavía se usa porque
   * aún no se pudo renombrar a ~/.closedbot. Solo con la carpeta por defecto.
   */
  legacyDataDir: string | null;
}

/** Nombre anterior de la app: sus variables CUADRILLA_* y su carpeta ~/.cuadrilla se siguen aceptando. */
const LEGACY_DIR = ".cuadrilla";
const DATA_DIR = ".closedbot";

/**
 * Lee una variable de configuración: CLOSEDBOT_<nombre>, o CUADRILLA_<nombre> (el nombre anterior de la app).
 */
export function setting(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[`CLOSEDBOT_${name}`] ?? env[`CUADRILLA_${name}`];
}

/** Lee la configuración de las variables de entorno CLOSEDBOT_* (ver README). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, appRoot = defaultAppRoot(), home = homedir()): Config {
  const explicit = setting(env, "DATA_DIR")?.trim();
  const fresh = join(home, DATA_DIR);
  const legacy = join(home, LEGACY_DIR);
  // Sin carpeta elegida: ~/.closedbot, salvo que solo exista la de antes (se renombra al arrancar).
  const usesLegacy = !explicit && !existsSync(fresh) && existsSync(legacy);
  const dataDir = resolve(explicit ? expandHome(explicit, home) : usesLegacy ? legacy : fresh);
  return {
    host: setting(env, "HOST")?.trim() || "127.0.0.1",
    port: integer(setting(env, "PORT"), 8787, 0, 65_535, "CLOSEDBOT_PORT"),
    dataDir,
    dbPath: databasePath(dataDir),
    workspacesDir: resolve(expandHome(setting(env, "WORKSPACES_DIR")?.trim() || join(dataDir, "agentes"), home)),
    sharedDir: resolve(expandHome(setting(env, "SHARED_DIR")?.trim() || join(dataDir, "compartida"), home)),
    publicDir: join(appRoot, "public"),
    maxHops: integer(setting(env, "MAX_HOPS"), 6, 1, 50, "CLOSEDBOT_MAX_HOPS"),
    codexBin: setting(env, "CODEX_BIN")?.trim() || "codex",
    claudeBin: setting(env, "CLAUDE_BIN")?.trim() || null,
    claudeConfigDir: resolve(expandHome(setting(env, "CLAUDE_CONFIG_DIR")?.trim() || join(dataDir, "claude"), home)),
    playwright: flag(setting(env, "PLAYWRIGHT"), false),
    detectProviders: flag(setting(env, "DETECT"), true),
    sessionDays: integer(setting(env, "SESSION_DAYS"), 30, 1, 365, "CLOSEDBOT_SESSION_DAYS"),
    secureCookies: cookieMode(setting(env, "SECURE_COOKIES")),
    legacyDataDir: usesLegacy ? dataDir : null,
  };
}

/**
 * Configuración lista para abrir los datos. Si solo existe la carpeta de cuando la app se llamaba
 * Cuadrilla, la renombra a ~/.closedbot (con la app cerrada no hay nada abierto dentro). Si no se
 * puede, sigue usando la de antes y lo vuelve a intentar en el próximo arranque.
 */
export function prepareConfig(
  env: NodeJS.ProcessEnv = process.env,
  log: (level: "info" | "warn", message: string) => void = () => undefined,
  home = homedir(),
): { config: Config; movedFrom: string | null } {
  const config = loadConfig(env, defaultAppRoot(), home);
  if (!config.legacyDataDir) return { config, movedFrom: null };
  const target = join(home, DATA_DIR);
  try {
    renameSync(config.legacyDataDir, target);
  } catch (error) {
    log("warn", `No pude renombrar ${config.legacyDataDir} a ${target} (${(error as Error).message}); por ahora sigo usando la carpeta de antes.`);
    return { config, movedFrom: null };
  }
  log("info", `Moví los datos de ${config.legacyDataDir} a ${target}.`);
  return { config: loadConfig(env, defaultAppRoot(), home), movedFrom: config.legacyDataDir };
}

/** closedbot.db; en las instalaciones de antes del cambio de nombre, su cuadrilla.db de siempre. */
function databasePath(dataDir: string): string {
  const legacy = join(dataDir, "cuadrilla.db");
  const current = join(dataDir, "closedbot.db");
  return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

/** Carpeta raíz de la app (contiene public/), sea desde src/ o desde dist/src/. */
function defaultAppRoot(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  return /[\\/]dist[\\/]src[\\/]?$/.test(here) ? resolve(here, "..", "..") : resolve(here, "..");
}

function expandHome(path: string, home = homedir()): string {
  return path === "~" || path.startsWith("~/") ? join(home, path.slice(1)) : path;
}

function integer(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} debe ser un número entero entre ${min} y ${max}.`);
  }
  return value;
}

function flag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

function cookieMode(raw: string | undefined): Config["secureCookies"] {
  const value = raw?.trim().toLowerCase();
  if (!value || value === "auto") return "auto";
  return flag(value, true) ? "always" : "never";
}
