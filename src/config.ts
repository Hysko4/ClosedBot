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
  playwright: boolean;
  detectProviders: boolean;
  sessionDays: number;
  secureCookies: "auto" | "always" | "never";
}

/** Lee la configuración de las variables de entorno CUADRILLA_* (ver README). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, appRoot = defaultAppRoot()): Config {
  const dataDir = resolve(expandHome(env.CUADRILLA_DATA_DIR?.trim() || join(homedir(), ".cuadrilla")));
  return {
    host: env.CUADRILLA_HOST?.trim() || "127.0.0.1",
    port: integer(env.CUADRILLA_PORT, 8787, 0, 65_535, "CUADRILLA_PORT"),
    dataDir,
    dbPath: join(dataDir, "cuadrilla.db"),
    workspacesDir: resolve(expandHome(env.CUADRILLA_WORKSPACES_DIR?.trim() || join(dataDir, "agentes"))),
    sharedDir: resolve(expandHome(env.CUADRILLA_SHARED_DIR?.trim() || join(dataDir, "compartida"))),
    publicDir: join(appRoot, "public"),
    maxHops: integer(env.CUADRILLA_MAX_HOPS, 6, 1, 50, "CUADRILLA_MAX_HOPS"),
    codexBin: env.CUADRILLA_CODEX_BIN?.trim() || "codex",
    claudeBin: env.CUADRILLA_CLAUDE_BIN?.trim() || null,
    playwright: flag(env.CUADRILLA_PLAYWRIGHT, false),
    detectProviders: flag(env.CUADRILLA_DETECT, true),
    sessionDays: integer(env.CUADRILLA_SESSION_DAYS, 30, 1, 365, "CUADRILLA_SESSION_DAYS"),
    secureCookies: cookieMode(env.CUADRILLA_SECURE_COOKIES),
  };
}

/** Carpeta raíz de la app (contiene public/), sea desde src/ o desde dist/src/. */
function defaultAppRoot(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  return /[\\/]dist[\\/]src[\\/]?$/.test(here) ? resolve(here, "..", "..") : resolve(here, "..");
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
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
