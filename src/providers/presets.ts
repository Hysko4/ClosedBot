// Cómo se arranca, se instala y se conecta cada proveedor que es un programa aparte (Codex, Grok y
// Gemini CLI). Como en OpenBot, se usan los programas oficiales y la persona entra con su cuenta.

import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { SignInCommands } from "../service.js";
import { geminiAuthMethod } from "./detect.js";
import { npmCommand } from "./locate.js";
import type { CliCommand } from "./spawn.js";

export type ExternalProvider = "codex" | "grok" | "gemini";

/** Claves de cada proveedor: ninguno ve las de los demás. */
const PROVIDER_KEYS: Record<"claude" | ExternalProvider, string[]> = {
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
  codex: ["OPENAI_API_KEY", "CODEX_API_KEY"],
  grok: ["XAI_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

/** Copia del entorno sin las claves de los otros proveedores. */
export function providerEnv(provider: "claude" | ExternalProvider, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const [owner, keys] of Object.entries(PROVIDER_KEYS)) {
    if (owner === provider) continue;
    for (const key of keys) delete env[key];
  }
  return env;
}

/** Argumentos para hablar ACP. Grok sin actualizarse solo: así no cambia la copia que use otra app (OpenBot). */
export const GROK_AGENT_ARGS = ["--no-auto-update", "agent", "stdio"];
export const GEMINI_AGENT_ARGS = ["--acp"];

/**
 * Métodos de `authenticate` que ClosedBot puede pedir solo, sin abrir el navegador. Grok usa la sesión
 * que dejó «grok login»; Gemini, la que eligió al iniciar sesión con Google o la clave del entorno.
 */
export function acpAuthMethods(provider: "grok" | "gemini", env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  if (provider === "grok") return ["cached_token"];
  const methods: string[] = [];
  if (geminiAuthMethod(home) === "oauth-personal") methods.push("oauth-personal");
  if (env.GEMINI_API_KEY?.trim()) methods.push("gemini-api-key");
  return methods;
}

export interface CommandOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** npm del Node de ClosedBot (por defecto, el que está junto a node.exe). */
  npm?: string;
  /** Node y el script que inicia sesión en los agentes ACP sin comando propio (Gemini CLI). */
  nodePath?: string;
  acpLoginScript?: string;
}

/** Paquetes oficiales de npm. */
export const NPM_PACKAGES = { codex: "@openai/codex", gemini: "@google/gemini-cli" } as const;
/** Instalador oficial de Grok (lo publica xAI en https://x.ai/cli). */
export const GROK_INSTALL = {
  windows: "irm https://x.ai/cli/install.ps1 | iex",
  unix: "curl -fsSL https://x.ai/cli/install.sh | bash",
} as const;

/** Cómo instalar el proveedor para el usuario actual, sin permisos de administrador. */
export function installCommand(provider: ExternalProvider, options: CommandOptions = {}): CliCommand {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  if (provider === "grok") {
    return platform === "win32"
      ? { command: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", GROK_INSTALL.windows], env }
      : { command: "sh", args: ["-c", GROK_INSTALL.unix], env };
  }
  // --no-fund y --no-audit: menos salida y nada que preguntar.
  return { command: options.npm ?? npmCommand(platform), args: ["install", "-g", NPM_PACKAGES[provider], "--no-fund", "--no-audit"], env };
}

/** Comandos para entrar y salir con la cuenta. `bin` es el programa que encontró la app. */
export function signInCommands(provider: ExternalProvider, bin: string, options: CommandOptions = {}): SignInCommands {
  const env = options.env ?? process.env;
  switch (provider) {
    case "codex":
      return { login: { command: bin, args: ["login"], env }, logout: { command: bin, args: ["logout"], env }, acceptsCode: false };
    case "grok":
      return {
        login: { command: bin, args: ["--no-auto-update", "login", "--oauth"], env },
        logout: { command: bin, args: ["--no-auto-update", "logout"], env },
        acceptsCode: false,
      };
    case "gemini":
      // Gemini CLI no tiene «login»: se le pide por ACP que inicie sesión con Google (abre el navegador).
      return {
        login: {
          command: options.nodePath ?? process.execPath,
          args: [options.acpLoginScript ?? defaultLoginScript(), "oauth-personal", bin, ...GEMINI_AGENT_ARGS],
          env,
        },
        logout: null,
        acceptsCode: false,
      };
  }
}

function defaultLoginScript(): string {
  return fileURLToPath(new URL("./acp-login.js", import.meta.url));
}
