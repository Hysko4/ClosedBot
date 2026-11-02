import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProviderStatus } from "../service.js";
import { type ClaudeCli, describeClaudeAuth, readClaudeAuth } from "./claude-cli.js";
import { redactDiagnostic } from "./codex.js";
import { runCli } from "./spawn.js";

export interface DetectOptions {
  enabled: boolean;
  codexBin: string;
  env?: NodeJS.ProcessEnv;
  /** El Claude Code de la app (null si no está) y el entorno con la carpeta de su sesión. */
  claude?: { cli: ClaudeCli | null; env: NodeJS.ProcessEnv; configDir: string };
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
    const skipped = (id: "claude" | "codex", label: string): ProviderStatus => ({
      id,
      label,
      available: true,
      loggedIn: null,
      detail: "Detección desactivada (CLOSEDBOT_DETECT=0).",
    });
    return [skipped("claude", "Claude"), skipped("codex", "Codex"), DEMO];
  }
  const [claude, codex] = await Promise.all([detectClaude(env, options.claude), detectCodex(options.codexBin, env)]);
  return [claude, codex, DEMO];
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

async function detectCodex(bin: string, env: NodeJS.ProcessEnv): Promise<ProviderStatus> {
  const base = { id: "codex" as const, label: "Codex" };
  const version = await run(bin, ["--version"], env);
  if (!version.ok) {
    return {
      ...base,
      available: false,
      loggedIn: null,
      canSignIn: false,
      detail: `No encontré Codex (${bin}). Instálalo con «npm install -g @openai/codex».`,
    };
  }
  const login = await run(bin, ["login", "status"], env);
  const versionText = firstLine(version.output) || "Codex";
  if (!login.ok) {
    return { ...base, available: true, loggedIn: false, canSignIn: true, detail: `${versionText} instalado, sin sesión: pulsa «Iniciar sesión con ChatGPT».` };
  }
  return { ...base, available: true, loggedIn: true, canSignIn: true, detail: `${versionText} · ${firstLine(login.output) || "sesión iniciada"}` };
}

async function run(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ ok: boolean; output: string }> {
  const result = await runCli({ command: bin, args, env }, 8_000);
  return { ok: result.code === 0, output: redactDiagnostic(`${result.stdout}\n${result.stderr}`.trim()) };
}

function firstLine(text: string): string {
  return (text.split(/\r?\n/).find((line) => line.trim()) ?? "").trim().slice(0, 160);
}
