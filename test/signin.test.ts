import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type ClaudeCli,
  claudeEnv,
  claudeLoginCommand,
  claudeLogoutCommand,
  readClaudeAuth,
  resolveClaudeCli,
} from "../src/providers/claude-cli.js";
import { CLAUDE_SIGNED_OUT, detectProviders } from "../src/providers/detect.js";
import { findSignInUrl } from "../src/providers/signin.js";
import { spawnTarget } from "../src/providers/spawn.js";
import type { ProviderStatus, ServiceEvent } from "../src/service.js";
import { createHarness, tempDir, waitFor } from "./helpers.js";

const fixture = fileURLToPath(new URL("../../test/fixtures/fake-claude.mjs", import.meta.url));
const FAKE_CLI: ClaudeCli = { command: process.execPath, prefixArgs: [fixture] };

/** Entorno limpio: sin las credenciales que pudiera tener el equipo donde corren las pruebas. */
function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "FAKE_CLAUDE_LOGIN"]) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

async function signInHarness(mode: string, options: { timeoutMs?: number } = {}) {
  const temp = tempDir("closedbot-signin-");
  const configDir = join(temp.path, "claude");
  // CLAUDECODE simula que la app se abrió desde una sesión de Claude Code: no debe llegar al CLI.
  const env = claudeEnv(baseEnv({ FAKE_CLAUDE_LOGIN: mode, CLAUDECODE: "1" }), configDir);
  const detect = () =>
    detectProviders({ enabled: true, codexBin: join(temp.path, "no-existe-codex"), env, claude: { cli: FAKE_CLI, env, configDir } });
  const h = await createHarness({
    dir: temp.path,
    detectProviders: detect,
    signInCommands: (provider) =>
      provider === "claude"
        ? { login: claudeLoginCommand(FAKE_CLI, env), logout: claudeLogoutCommand(FAKE_CLI, env), acceptsCode: true }
        : null,
    ...(options.timeoutMs ? { signInTimeoutMs: options.timeoutMs } : {}),
  });
  const claude = () => h.service.providers().find((provider) => provider.id === "claude") as ProviderStatus;
  await waitFor(() => claude().canSignIn, 10_000, "detección inicial");
  return {
    h,
    configDir,
    claude,
    notices: () => h.events.filter((event): event is Extract<ServiceEvent, { type: "notice" }> => event.type === "notice"),
    close: async () => {
      await h.close();
      temp.cleanup();
    },
  };
}

test("inicio de sesión: dirección de la página, con o sin enlace de terminal", () => {
  const url = "https://claude.ai/oauth/authorize?code=true&state=abc";
  assert.equal(findSignInUrl(`If the browser didn't open, visit: \u001b]8;;${url}\u001b\\${url}\u001b]8;;\u001b\\\n`), url);
  assert.equal(findSignInUrl(`Starting local login server on http://localhost:1455.\nnavigate to this URL:\n\n${url}\n`), url);
  assert.equal(findSignInUrl("Opening browser to sign in…\n"), null);
  assert.equal(findSignInUrl("http://localhost:1455/callback"), null);
});

test("lanzar programas: en Windows los .cmd pasan por cmd.exe con la línea armada", () => {
  assert.deepEqual(spawnTarget("/usr/bin/codex", ["login"], "linux"), { file: "/usr/bin/codex", args: ["login"], shell: false });
  assert.deepEqual(spawnTarget("C:\\app\\claude.exe", ["auth", "status"], "win32"), {
    file: "C:\\app\\claude.exe",
    args: ["auth", "status"],
    shell: false,
  });
  assert.deepEqual(spawnTarget("C:\\Program Files\\codex.cmd", ["app-server", "--listen", "stdio://"], "win32"), {
    file: '"C:\\Program Files\\codex.cmd" app-server --listen stdio://',
    args: [],
    shell: true,
  });
  assert.deepEqual(spawnTarget("codex", ["login", "status"], "win32"), { file: "codex login status", args: [], shell: true });
});

test("Claude Code de la app: se busca el que trae el Agent SDK, como hace el SDK", () => {
  const temp = tempDir("closedbot-cli-");
  try {
    const binary = join(temp.path, "claude.exe");
    writeFileSync(binary, "");
    const asked: string[] = [];
    const found = resolveClaudeCli(null, "win32", "x64", (specifier) => {
      asked.push(specifier);
      return binary;
    });
    assert.deepEqual(found, { command: binary, prefixArgs: [] });
    assert.deepEqual(asked, ["@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe"]);
    assert.deepEqual(resolveClaudeCli("/opt/claude", "linux", "x64"), { command: "/opt/claude", prefixArgs: [] });
    const missing = resolveClaudeCli(null, "darwin", "arm64", () => {
      throw new Error("no instalado");
    });
    assert.equal(missing, null);
    // En este equipo, el paquete de su sistema viene con las dependencias.
    assert.ok(resolveClaudeCli(null), "npm instaló el Claude Code del SDK");
  } finally {
    temp.cleanup();
  }
});

test("detección de Claude: pregunta a Claude Code por la sesión de la carpeta de la app", async () => {
  const temp = tempDir("closedbot-detect-");
  try {
    const configDir = join(temp.path, "claude");
    const env = claudeEnv(baseEnv(), configDir);
    const options = { enabled: true, codexBin: join(temp.path, "no-existe-codex"), env, claude: { cli: FAKE_CLI, env, configDir } };

    const out = await readClaudeAuth(FAKE_CLI, env);
    assert.deepEqual(out, { loggedIn: false, method: "none", email: null, plan: null, org: null });
    let [claude, codex] = await detectProviders(options);
    assert.equal(claude?.loggedIn, false);
    assert.equal(claude?.canSignIn, true);
    assert.equal(claude?.detail, CLAUDE_SIGNED_OUT);
    assert.equal(codex?.available, false);
    assert.equal(codex?.canSignIn, false);

    writeFileSync(join(configDir, ".credentials.json"), "{}");
    [claude] = await detectProviders(options);
    assert.equal(claude?.loggedIn, true);
    assert.deepEqual(claude?.account, { email: "persona@example.com", plan: "max" });
    assert.equal(claude?.detail, "Conectado como persona@example.com · plan Max.");

    // Una clave en el entorno del servidor manda: no hay sesión que abrir desde la app.
    const withKey = { ...env, ANTHROPIC_API_KEY: "sk-ant-prueba" };
    [claude] = await detectProviders({ ...options, env: withKey, claude: { cli: FAKE_CLI, env: withKey, configDir } });
    assert.equal(claude?.loggedIn, true);
    assert.equal(claude?.canSignIn, false);

    [claude] = await detectProviders({ ...options, claude: { cli: null, env, configDir } });
    assert.equal(claude?.available, false);
    assert.match(claude?.detail ?? "", /No encontré Claude Code/);
  } finally {
    temp.cleanup();
  }
});

test("inicio de sesión con el código de la página: conecta Claude sin tocar otra carpeta", async () => {
  const s = await signInHarness("code");
  try {
    assert.equal(s.claude().loggedIn, false);
    s.h.service.startSignIn("claude");
    const pending = await waitFor(() => (s.claude().signIn?.url ? s.claude().signIn : null), 5_000, "página de inicio de sesión");
    assert.equal(pending.url, "https://claude.ai/oauth/authorize?code=true&client_id=prueba&state=estado");
    assert.equal(pending.acceptsCode, true);

    const loginEnv = JSON.parse(readFileSync(join(s.configDir, "login-env.json"), "utf8")) as Record<string, unknown>;
    assert.deepEqual(loginEnv.args, ["--claudeai"]);
    assert.equal(loginEnv.CLAUDE_CONFIG_DIR, s.configDir);
    assert.equal(loginEnv.DISABLE_AUTOUPDATER, "1");
    assert.equal(loginEnv.CLAUDECODE, null);

    assert.throws(() => s.h.service.submitSignInCode("claude", "sin-almohadilla"), /no está completo/);
    assert.throws(() => s.h.service.submitSignInCode("claude", "   "), /Pega el código/);
    s.h.service.submitSignInCode("claude", " codigo#estado ");
    await waitFor(() => s.claude().loggedIn === true, 10_000, "sesión iniciada");
    assert.equal(s.claude().signIn, undefined);
    assert.ok(existsSync(join(s.configDir, ".credentials.json")));
    await waitFor(() => s.notices().find((notice) => notice.message === "Claude quedó conectado como persona@example.com."), 5_000, "aviso");
    assert.throws(() => s.h.service.submitSignInCode("claude", "codigo#estado"), /No hay un inicio de sesión esperando/);

    // Cerrar sesión borra solo la sesión de la app.
    const after = await s.h.service.signOut("claude");
    assert.equal(after.find((provider) => provider.id === "claude")?.loggedIn, false);
    assert.equal(existsSync(join(s.configDir, ".credentials.json")), false);
  } finally {
    await s.close();
  }
});

test("inicio de sesión: si el navegador vuelve solo, se conecta sin pegar nada", async () => {
  const s = await signInHarness("browser");
  try {
    s.h.service.startSignIn("claude");
    await waitFor(() => s.claude().loggedIn === true, 10_000, "sesión iniciada");
    assert.equal(s.claude().account?.email, "persona@example.com");
  } finally {
    await s.close();
  }
});

test("inicio de sesión: un código equivocado o un rechazo se avisan en español", async () => {
  const s = await signInHarness("code");
  try {
    s.h.service.startSignIn("claude");
    await waitFor(() => s.claude().signIn?.url, 5_000, "página");
    s.h.service.submitSignInCode("claude", "otro#codigo");
    const wrong = await waitFor(() => s.notices().find((notice) => notice.level === "error"), 5_000, "aviso de error");
    assert.equal(wrong.message, "No se pudo iniciar sesión: Invalid authorization code");
    await waitFor(() => !s.claude().signIn, 5_000, "fin del intento");
    assert.equal(s.claude().loggedIn, false);
  } finally {
    await s.close();
  }

  const rejected = await signInHarness("fail");
  try {
    rejected.h.service.startSignIn("claude");
    const notice = await waitFor(() => rejected.notices().find((item) => item.level === "error"), 5_000, "aviso de rechazo");
    assert.equal(notice.message, "No se pudo iniciar sesión: Request failed with status code 403");
  } finally {
    await rejected.close();
  }
});

test("inicio de sesión: se puede cancelar y se corta si pasa el tiempo", async () => {
  const s = await signInHarness("hang", { timeoutMs: 400 });
  try {
    s.h.service.startSignIn("claude");
    await waitFor(() => s.claude().signIn, 5_000, "inicio");
    const cancelled = s.h.service.cancelSignIn("claude");
    assert.equal(cancelled.find((provider) => provider.id === "claude")?.signIn, undefined);
    assert.equal(s.notices().length, 0, "cancelar no es un error");

    s.h.service.startSignIn("claude");
    const timeout = await waitFor(() => s.notices().find((notice) => notice.level === "error"), 5_000, "tiempo agotado");
    assert.match(timeout.message, /Se acabó el tiempo para iniciar sesión/);
    assert.equal(s.claude().signIn, undefined);
  } finally {
    await s.close();
  }
});

test("inicio de sesión: proveedores sin login o no disponibles responden con un error claro", async () => {
  const h = await createHarness();
  try {
    assert.throws(() => h.service.startSignIn("demo"), /no tiene inicio de sesión/);
    assert.throws(() => h.service.startSignIn("claude"), /no se puede iniciar sesión en Claude desde la app/);
    await assert.rejects(h.service.signOut("codex"), /no se puede iniciar sesión en Codex desde la app/);
  } finally {
    await h.close();
  }
});
