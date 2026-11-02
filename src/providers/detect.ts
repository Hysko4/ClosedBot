import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderStatus } from "../service.js";
import { redactDiagnostic } from "./codex.js";

export interface DetectOptions {
  enabled: boolean;
  codexBin: string;
  env?: NodeJS.ProcessEnv;
}

const DEMO: ProviderStatus = {
  id: "demo",
  label: "Demo",
  available: true,
  loggedIn: true,
  detail: "Siempre disponible. No usa IA: sirve para probar la app.",
};

/** Comprueba qué proveedores se pueden usar en este equipo, sin gastar créditos. */
export async function detectProviders(options: DetectOptions): Promise<ProviderStatus[]> {
  const env = options.env ?? process.env;
  if (!options.enabled) {
    const skipped = (id: "claude" | "codex", label: string): ProviderStatus => ({
      id,
      label,
      available: true,
      loggedIn: null,
      detail: "Detección desactivada (CUADRILLA_DETECT=0).",
    });
    return [skipped("claude", "Claude"), skipped("codex", "Codex"), DEMO];
  }
  const [claude, codex] = await Promise.all([detectClaude(env), detectCodex(options.codexBin, env)]);
  return [claude, codex, DEMO];
}

async function detectClaude(env: NodeJS.ProcessEnv): Promise<ProviderStatus> {
  const base = { id: "claude" as const, label: "Claude", available: true };
  if (env.ANTHROPIC_API_KEY?.trim()) {
    return { ...base, loggedIn: true, detail: "Usa tu clave de API de Anthropic (ANTHROPIC_API_KEY)." };
  }
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  if (env.CLAUDE_CODE_OAUTH_TOKEN?.trim() || existsSync(join(configDir, ".credentials.json"))) {
    return {
      ...base,
      loggedIn: true,
      detail: "Usará la sesión de Claude Code de este equipo. Anthropic recomienda una clave de API (ANTHROPIC_API_KEY) para apps propias.",
    };
  }
  return { ...base, loggedIn: false, detail: "Falta ANTHROPIC_API_KEY en el archivo de entorno del servidor." };
}

async function detectCodex(bin: string, env: NodeJS.ProcessEnv): Promise<ProviderStatus> {
  const base = { id: "codex" as const, label: "Codex" };
  const version = await run(bin, ["--version"], env);
  if (!version.ok) {
    return { ...base, available: false, loggedIn: null, detail: `No encontré Codex (${bin}). Instálalo con «npm install -g @openai/codex».` };
  }
  const login = await run(bin, ["login", "status"], env);
  const versionText = firstLine(version.output) || "Codex";
  if (!login.ok) {
    return { ...base, available: true, loggedIn: false, detail: `${versionText} instalado, sin sesión: ejecuta «codex login» en el servidor.` };
  }
  return { ...base, available: true, loggedIn: true, detail: `${versionText} · ${firstLine(login.output) || "sesión iniciada"}` };
}

function run(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { env, timeout: 8_000, windowsHide: true, shell: process.platform === "win32", maxBuffer: 256 * 1024 },
      (error, stdout, stderr) => {
        resolve({ ok: !error, output: redactDiagnostic(`${stdout}\n${stderr}`.trim()) });
      },
    );
  });
}

function firstLine(text: string): string {
  return (text.split(/\r?\n/).find((line) => line.trim()) ?? "").trim().slice(0, 160);
}
