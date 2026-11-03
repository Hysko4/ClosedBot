import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ProviderStatus } from "../service.js";
import { antigravityTokenPath, antigravityVersion } from "./antigravity.js";
import { type ClaudeCli, describeClaudeAuth, readClaudeAuth } from "./claude-cli.js";
import { redactDiagnostic } from "./codex.js";
import { describeSource, type LocatedCli, locateCli } from "./locate.js";
import { runCli } from "./spawn.js";

export interface DetectOptions {
  enabled: boolean;
  /** Ruta de Codex elegida a mano (CODEX_BIN); por defecto se busca. */
  codexBin: string;
  grokBin?: string | null;
  geminiBin?: string | null;
  env?: NodeJS.ProcessEnv;
  /** El Claude Code de la app (null si no está) y el entorno con la carpeta de su sesión. */
  claude?: { cli: ClaudeCli | null; env: NodeJS.ProcessEnv; configDir: string };
  /** Para las pruebas: dónde buscar los programas (por defecto, locateCli). */
  locate?: (name: "codex" | "grok" | "gemini") => LocatedCli | null;
  /** Carpeta personal donde Grok y Antigravity (Gemini) guardan su sesión (por defecto, la del usuario). */
  home?: string;
}

const DEMO: ProviderStatus = {
  id: "demo",
  label: "Demo",
  available: true,
  loggedIn: true,
  detail: "Siempre disponible. No usa IA: sirve para probar la app.",
};

export const CLAUDE_SIGNED_OUT = "Sin sesión. Pulsa «Iniciar sesión con Claude» y entra con tu cuenta en el navegador.";

/** Comprueba qué proveedores se pueden usar en este equipo, sin gastar créditos. */
export async function detectProviders(options: DetectOptions): Promise<ProviderStatus[]> {
  const env = options.env ?? process.env;
  if (!options.enabled) {
    const skipped = (id: "claude" | "codex" | "grok" | "gemini", label: string): ProviderStatus => ({
      id,
      label,
      available: true,
      loggedIn: null,
      detail: "Detección desactivada (CLOSEDBOT_DETECT=0).",
    });
    return [skipped("claude", "Claude"), skipped("codex", "Codex"), skipped("grok", "Grok"), skipped("gemini", "Gemini"), DEMO];
  }
  const locate =
    options.locate ??
    ((name: "codex" | "grok" | "gemini") =>
      locateCli(name, { env, configured: name === "codex" ? options.codexBin : name === "grok" ? options.grokBin : options.geminiBin }));
  const home = options.home ?? (env.USERPROFILE || env.HOME || homedir());
  const [claude, codex, grok, gemini] = await Promise.all([
    detectClaude(env, options.claude),
    detectCodex(locate("codex"), env),
    detectGrok(locate("grok"), env, home),
    detectGemini(locate("gemini"), env, home),
  ]);
  return [claude, codex, grok, gemini, DEMO];
}

async function detectClaude(env: NodeJS.ProcessEnv, claude: DetectOptions["claude"]): Promise<ProviderStatus> {
  const base = { id: "claude" as const, label: "Claude" };
  // Una credencial puesta en el entorno del servidor manda sobre la sesión: no hay nada que iniciar.
  if (env.ANTHROPIC_API_KEY?.trim()) {
    return { ...base, available: true, loggedIn: true, canSignIn: false, detail: "Usa tu clave de API de Anthropic (ANTHROPIC_API_KEY)." };
  }
  if (env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
    return { ...base, available: true, loggedIn: true, canSignIn: false, detail: "Usa el token de Claude Code de CLAUDE_CODE_OAUTH_TOKEN." };
  }
  if (!claude?.cli) {
    return {
      ...base,
      available: false,
      loggedIn: null,
      canSignIn: false,
      detail: "No encontré Claude Code, que viene con la app. Vuelve a ejecutar el instalador (o «npm ci»).",
    };
  }
  const auth = await readClaudeAuth(claude.cli, claude.env);
  if (auth?.loggedIn) {
    return {
      ...base,
      available: true,
      loggedIn: true,
      canSignIn: true,
      account: { email: auth.email, plan: auth.plan },
      detail: describeClaudeAuth(auth),
    };
  }
  if (auth) return { ...base, available: true, loggedIn: false, canSignIn: true, detail: CLAUDE_SIGNED_OUT };
  // No se pudo preguntar a Claude Code (tardó o falló): se mira si hay una sesión guardada.
  const saved = existsSync(join(claude.configDir, ".credentials.json"));
  return {
    ...base,
    available: true,
    loggedIn: saved,
    canSignIn: true,
    detail: saved ? "Hay una sesión de Claude guardada, pero ahora no pude comprobarla." : CLAUDE_SIGNED_OUT,
  };
}

async function detectCodex(found: LocatedCli | null, env: NodeJS.ProcessEnv): Promise<ProviderStatus> {
  const base = { id: "codex" as const, label: "Codex", canInstall: true };
  if (!found) return notInstalled(base, "Codex (de OpenAI, con tu cuenta de ChatGPT)");
  const version = await run(found.path, ["--version"], env);
  if (!version.ok) return broken(base, found, version.output);
  const login = await run(found.path, ["login", "status"], env);
  const versionText = `${firstLine(version.output) || "Codex"}${where(found)}`;
  if (!login.ok) {
    return { ...base, available: true, loggedIn: false, canSignIn: true, path: found.path, detail: `${versionText}, sin sesión: pulsa «Iniciar sesión con ChatGPT».` };
  }
  return { ...base, available: true, loggedIn: true, canSignIn: true, path: found.path, detail: `${versionText} · ${firstLine(login.output) || "sesión iniciada"}` };
}

/** Grok (xAI): la sesión que deja «grok login» queda en ~/.grok/auth.json; también sirve XAI_API_KEY. */
async function detectGrok(found: LocatedCli | null, env: NodeJS.ProcessEnv, home: string): Promise<ProviderStatus> {
  const base = { id: "grok" as const, label: "Grok", canInstall: true };
  if (!found) return notInstalled(base, "Grok (de xAI, con tu cuenta de Grok o X)");
  const version = await run(found.path, ["--no-auto-update", "--version"], env);
  if (!version.ok) return broken(base, found, version.output);
  const versionText = `${firstLine(version.output) || "Grok"}${where(found)}`;
  if (env.XAI_API_KEY?.trim()) {
    return { ...base, available: true, loggedIn: true, canSignIn: false, path: found.path, detail: `${versionText} · usa tu clave de API de xAI (XAI_API_KEY).` };
  }
  if (existsSync(join(home, ".grok", "auth.json"))) {
    return { ...base, available: true, loggedIn: true, canSignIn: true, path: found.path, detail: `${versionText} · sesión iniciada.` };
  }
  return { ...base, available: true, loggedIn: false, canSignIn: true, path: found.path, detail: `${versionText}, sin sesión: pulsa «Iniciar sesión con Grok».` };
}

/**
 * Gemini por Antigravity (Google): con AGY_ACP_FORCE_FILE_STORAGE=1 la sesión queda en
 * ~/.gemini/antigravity-acp/acp_token.json. También sirve GEMINI_API_KEY. No se ejecuta el programa para
 * ver su versión: cada arranque descomprime unos 300 MB; la versión sale de su carpeta.
 */
async function detectGemini(found: LocatedCli | null, env: NodeJS.ProcessEnv, home: string): Promise<ProviderStatus> {
  const base = { id: "gemini" as const, label: "Gemini", canInstall: true, canSignOut: false };
  if (!found) return notInstalled(base, "Gemini (Antigravity, de Google, con tu cuenta de Google)");
  const version = antigravityVersion(found.path);
  const versionText = `Antigravity${version ? ` ${version}` : ""}${where(found)}`;
  if (env.GEMINI_API_KEY?.trim()) {
    return { ...base, available: true, loggedIn: true, canSignIn: false, path: found.path, detail: `${versionText} · usa tu clave de API de Gemini (GEMINI_API_KEY).` };
  }
  if (existsSync(antigravityTokenPath(home))) {
    return { ...base, available: true, loggedIn: true, canSignIn: true, path: found.path, detail: `${versionText} · sesión iniciada con Google.` };
  }
  return { ...base, available: true, loggedIn: false, canSignIn: true, path: found.path, detail: `${versionText}, sin sesión: pulsa «Iniciar sesión con Google».` };
}


function notInstalled(base: { id: "codex" | "grok" | "gemini"; label: string }, what: string): ProviderStatus {
  return { ...base, available: false, loggedIn: null, canSignIn: false, canInstall: true, detail: `No está instalado en este equipo. Pulsa «Instalar» para agregar ${what}.` };
}

function broken(base: { id: "codex" | "grok" | "gemini"; label: string }, found: LocatedCli, output: string): ProviderStatus {
  return {
    ...base,
    available: false,
    loggedIn: null,
    canSignIn: false,
    canInstall: true,
    path: found.path,
    detail: `Encontré ${base.label} en ${found.path}, pero no respondió${output ? `: ${firstLine(output)}` : "."} Prueba con «Instalar».`,
  };
}

function where(found: LocatedCli): string {
  return found.source === "path" || found.source === "config" || found.source === "propia" ? "" : ` (de ${describeSource(found.source)})`;
}

async function run(bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 10_000): Promise<{ ok: boolean; output: string }> {
  const result = await runCli({ command: bin, args, env }, timeoutMs);
  return { ok: result.code === 0, output: redactDiagnostic(`${result.stdout}\n${result.stderr}`.trim()) };
}

function firstLine(text: string): string {
  return (text.split(/\r?\n/).find((line) => line.trim()) ?? "").trim().slice(0, 160);
}
