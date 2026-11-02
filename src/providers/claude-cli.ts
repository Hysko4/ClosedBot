import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { type CliCommand, runCli } from "./spawn.js";

/**
 * El programa de Claude Code que la app usa para iniciar y cerrar sesión. `prefixArgs` va antes de los
 * argumentos (en las pruebas, el programa es node y el primer argumento, un script falso).
 */
export interface ClaudeCli {
  command: string;
  prefixArgs: string[];
}

export interface ClaudeAuth {
  loggedIn: boolean;
  /** «claude.ai», «oauth_token», «api_key»… tal como lo informa Claude Code. */
  method: string | null;
  email: string | null;
  /** Plan de la cuenta: «pro», «max», «team»… */
  plan: string | null;
  org: string | null;
}

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/**
 * Claude Code viene dentro del Agent SDK (es el mismo que ejecutan los agentes). Se busca igual que lo
 * hace el SDK; CLOSEDBOT_CLAUDE_BIN lo reemplaza por otro instalado aparte.
 */
export function resolveClaudeCli(
  configured: string | null,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  resolvePackage: (specifier: string) => string = createRequire(import.meta.url).resolve,
): ClaudeCli | null {
  if (configured) return { command: configured, prefixArgs: [] };
  const extension = platform === "win32" ? ".exe" : "";
  const linux = isMusl(platform) ? [`linux-${arch}-musl`, `linux-${arch}`] : [`linux-${arch}`, `linux-${arch}-musl`];
  const variants = platform === "linux" ? linux : [`${platform}-${arch}`];
  for (const variant of variants) {
    try {
      const path = resolvePackage(`${SDK_PACKAGE}-${variant}/claude${extension}`);
      if (existsSync(path)) return { command: path, prefixArgs: [] };
    } catch {
      // Ese paquete no está instalado en este equipo.
    }
  }
  return null;
}

function isMusl(platform: NodeJS.Platform): boolean {
  if (platform !== "linux" || process.platform !== "linux") return false;
  const report = process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return report?.header?.glibcVersionRuntime === undefined;
}

/**
 * Entorno de Claude Code para la app: la sesión de los agentes vive en su propia carpeta (CLAUDE_CONFIG_DIR),
 * así iniciar o cerrar sesión aquí no toca el Claude Code que la persona usa por su cuenta.
 */
export function claudeEnv(base: NodeJS.ProcessEnv, configDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, CLAUDE_CONFIG_DIR: configDir, DISABLE_AUTOUPDATER: "1" };
  // Si la app se abrió desde una sesión de Claude Code, sus variables no deben pasar a los agentes.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

export function claudeLoginCommand(cli: ClaudeCli, env: NodeJS.ProcessEnv): CliCommand {
  return { command: cli.command, args: [...cli.prefixArgs, "auth", "login", "--claudeai"], env };
}

export function claudeLogoutCommand(cli: ClaudeCli, env: NodeJS.ProcessEnv): CliCommand {
  return { command: cli.command, args: [...cli.prefixArgs, "auth", "logout"], env };
}

/**
 * Pregunta a Claude Code si hay sesión. `auth status --json` sale con 1 cuando no la hay, pero igual
 * imprime su estado; null si no se pudo saber (no arrancó, tardó demasiado o la salida no se entiende).
 */
export async function readClaudeAuth(cli: ClaudeCli, env: NodeJS.ProcessEnv, timeoutMs = 20_000): Promise<ClaudeAuth | null> {
  const result = await runCli({ command: cli.command, args: [...cli.prefixArgs, "auth", "status", "--json"], env }, timeoutMs, 64 * 1024);
  if (result.timedOut || result.error) return null;
  const status = parseJsonObject(result.stdout);
  if (!status || typeof status.loggedIn !== "boolean") return null;
  if (status.loggedIn && result.code !== 0 && result.code !== null) return null;
  return {
    loggedIn: status.loggedIn,
    method: text(status.authMethod),
    email: text(status.email),
    plan: text(status.subscriptionType),
    org: text(status.orgName),
  };
}

/** Descripción breve de una sesión de Claude, para Ajustes. */
export function describeClaudeAuth(auth: ClaudeAuth): string {
  if (auth.method === "api_key") return "Conectado con una clave de API.";
  if (auth.method === "oauth_token") return "Conectado con un token de Claude Code.";
  const who = auth.email ? `Conectado como ${auth.email}` : "Conectado con tu cuenta de Claude";
  return auth.plan ? `${who} · plan ${planLabel(auth.plan)}.` : `${who}.`;
}

export function planLabel(plan: string): string {
  const known: Record<string, string> = { pro: "Pro", max: "Max", team: "Team", enterprise: "Enterprise", free: "gratuito" };
  return known[plan.toLowerCase()] ?? plan;
}

function parseJsonObject(output: string): Record<string, unknown> | null {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value: unknown = JSON.parse(output.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
