import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { detectProviders, geminiAuthMethod } from "../src/providers/detect.js";
import { findOnPath, type LocatedCli, locateCli, npmCommand } from "../src/providers/locate.js";
import { acpAuthMethods, GROK_INSTALL, installCommand, providerEnv, signInCommands } from "../src/providers/presets.js";
import { type ProviderStatus, type ServiceEvent, ServiceError } from "../src/service.js";
import { createHarness, tempDir, waitFor } from "./helpers.js";

/** Crea un archivo vacío (y sus carpetas). */
function touch(path: string, mtime?: number): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "");
  if (mtime) utimesSync(path, mtime / 1000, mtime / 1000);
  return path;
}

/** Programa falso de un proveedor: un script de Node con un lanzador que se puede ejecutar. */
function fakeCli(dir: string, name: string, script: string): string {
  mkdirSync(dir, { recursive: true });
  const js = join(dir, `${name}-falso.cjs`);
  writeFileSync(js, script);
  if (process.platform === "win32") {
    const cmd = join(dir, `${name}.cmd`);
    writeFileSync(cmd, `@"${process.execPath}" "${js}" %*\r\n`);
    return cmd;
  }
  const bin = join(dir, name);
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`);
  chmodSync(bin, 0o755);
  return bin;
}

const CODEX = `const a = process.argv.slice(2);
if (a[0] === "--version") { console.log("codex-cli 0.99.0"); process.exit(0); }
if (a[0] === "login" && a[1] === "status") {
  if (process.env.FAKE_CODEX_LOGIN === "1") { console.log("Logged in using ChatGPT"); process.exit(0); }
  console.error("Not logged in"); process.exit(1);
}
process.exit(2);`;
const GROK = `const a = process.argv.slice(2);
if (a[0] === "--no-auto-update" && a[1] === "--version") { console.log("grok 0.9.1"); process.exit(0); }
process.exit(2);`;
const GEMINI = `if (process.argv[2] === "--version") { console.log("0.66.0"); process.exit(0); } process.exit(2);`;
const BROKEN = `console.error("Error: falta una biblioteca"); process.exit(1);`;

/** Entorno sin las claves de proveedores que pudiera tener el equipo de pruebas. */
function cleanEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "FAKE_CODEX_LOGIN"]) {
    delete env[key];
  }
  return { ...env, ...extra };
}

test("buscar programas en Windows: PATH, npm, la app de Codex, el instalador de Grok y la copia de OpenBot", () => {
  const temp = tempDir("closedbot-locate-");
  try {
    const appData = join(temp.path, "Roaming");
    const local = join(temp.path, "Local");
    const home = join(temp.path, "Usuario");
    const env = { PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD", APPDATA: appData, LOCALAPPDATA: local, USERPROFILE: home };
    const find = (name: "codex" | "grok" | "gemini", extra: NodeJS.ProcessEnv = {}, configured?: string) =>
      locateCli(name, { env: { ...env, ...extra }, platform: "win32", configured: configured ?? null });

    for (const name of ["codex", "grok", "gemini"] as const) assert.equal(find(name), null, name);

    // La app de escritorio de Codex: la versión más nueva.
    touch(join(local, "OpenAI", "Codex", "bin", "1.0", "codex.exe"), Date.now() - 60_000);
    const newest = touch(join(local, "OpenAI", "Codex", "bin", "2.0", "codex.exe"), Date.now());
    assert.deepEqual(find("codex"), { path: newest, source: "app" });
    // Lo que instala npm va antes; lo del PATH, antes todavía; y una ruta elegida a mano, primero.
    const npm = touch(join(appData, "npm", "codex.cmd"));
    assert.deepEqual(find("codex"), { path: npm, source: "npm" });
    const pathDir = join(temp.path, "bin con espacios");
    const onPath = touch(join(pathDir, "codex.exe"));
    assert.deepEqual(find("codex", { PATH: `"${pathDir}";${join(temp.path, "otra")}` }), { path: onPath, source: "path" });
    const chosen = touch(join(temp.path, "mi-codex.exe"));
    assert.deepEqual(find("codex", {}, chosen), { path: chosen, source: "config" });
    // Una ruta elegida que ya no existe no impide encontrarlo en otro lado.
    assert.deepEqual(find("codex", {}, join(temp.path, "borrado.exe")), { path: npm, source: "npm" });

    // Grok: la copia de OpenBot sirve si no está el instalador oficial.
    const openbot = touch(join(appData, "OpenBot", "provider-runtimes", "grok", "win32-x64", "0.9.1", "bin", "grok.exe"));
    assert.deepEqual(find("grok"), { path: openbot, source: "openbot" });
    const official = touch(join(home, ".grok", "bin", "grok.exe"));
    assert.deepEqual(find("grok"), { path: official, source: "oficial" });

    const gemini = touch(join(appData, "npm", "gemini.cmd"));
    assert.deepEqual(find("gemini"), { path: gemini, source: "npm" });
    // npm no deja «.ps1» ni nada que no sea .exe/.cmd en el PATH: no se toma.
    const psDir = join(temp.path, "ps");
    touch(join(psDir, "gemini.ps1"));
    assert.equal(findOnPath("gemini", { PATH: psDir, PATHEXT: ".PS1;.EXE" }, "win32"), null);
  } finally {
    temp.cleanup();
  }
});

test("buscar programas en Linux y macOS, y el npm del mismo Node", () => {
  const temp = tempDir("closedbot-locate-");
  try {
    const home = join(temp.path, "casa");
    const env = { PATH: join(temp.path, "vacio"), HOME: home, USERPROFILE: "" };
    assert.equal(locateCli("grok", { env, platform: "linux" }), null);
    const grok = touch(join(home, ".grok", "bin", "grok"));
    assert.deepEqual(locateCli("grok", { env, platform: "linux" }), { path: grok, source: "oficial" });
    const prefix = join(temp.path, "npm-global");
    const gemini = touch(join(prefix, "bin", "gemini"));
    assert.deepEqual(locateCli("gemini", { env: { ...env, npm_config_prefix: prefix }, platform: "darwin" }), { path: gemini, source: "npm" });

    const nodeDir = join(temp.path, "nodejs");
    const node = touch(join(nodeDir, "node.exe"));
    assert.equal(npmCommand("win32", node), "npm.cmd");
    const npm = touch(join(nodeDir, "npm.cmd"));
    assert.equal(npmCommand("win32", node), npm);
    assert.equal(npmCommand("linux", join(temp.path, "otro", "node")), "npm");
  } finally {
    temp.cleanup();
  }
});

test("detección de Codex, Grok y Gemini: sin instalar, sin sesión, con sesión, con clave y averiado", async () => {
  const temp = tempDir("closedbot-detect-");
  try {
    const home = join(temp.path, "casa");
    mkdirSync(home, { recursive: true });
    const bins = join(temp.path, "bin");
    const found: Record<string, LocatedCli | null> = { codex: null, grok: null, gemini: null };
    const detect = (env: NodeJS.ProcessEnv = cleanEnv()) =>
      detectProviders({ enabled: true, codexBin: "codex", env, home, locate: (name) => found[name] ?? null, claude: { cli: null, env, configDir: home } });
    const byId = (list: ProviderStatus[]) => Object.fromEntries(list.map((status) => [status.id, status])) as Record<string, ProviderStatus>;

    let status = byId(await detect());
    assert.deepEqual(
      Object.keys(status),
      ["claude", "codex", "grok", "gemini", "demo"],
    );
    for (const id of ["codex", "grok", "gemini"]) {
      assert.equal(status[id]?.available, false, id);
      assert.equal(status[id]?.canInstall, true, id);
      assert.equal(status[id]?.canSignIn, false, id);
      assert.match(status[id]?.detail ?? "", /No está instalado en este equipo\. Pulsa «Instalar»/);
    }

    found.codex = { path: fakeCli(bins, "codex", CODEX), source: "app" };
    found.grok = { path: fakeCli(bins, "grok", GROK), source: "openbot" };
    found.gemini = { path: fakeCli(bins, "gemini", GEMINI), source: "npm" };
    status = byId(await detect());
    assert.equal(status.codex?.loggedIn, false);
    assert.equal(status.codex?.path, found.codex.path);
    assert.match(status.codex?.detail ?? "", /^codex-cli 0\.99\.0 \(de la app de escritorio\), sin sesión: pulsa «Iniciar sesión con ChatGPT»/);
    assert.match(status.grok?.detail ?? "", /^grok 0\.9\.1 \(de la copia de OpenBot\), sin sesión: pulsa «Iniciar sesión con Grok»/);
    assert.match(status.gemini?.detail ?? "", /^Gemini CLI 0\.66\.0 \(de los programas de npm\), sin sesión: pulsa «Iniciar sesión con Google»/);
    assert.equal(status.gemini?.canSignOut, false, "Gemini CLI no tiene cómo cerrar la sesión");
    for (const id of ["codex", "grok", "gemini"]) {
      assert.equal(status[id]?.available, true, id);
      assert.equal(status[id]?.canSignIn, true, id);
    }

    // Con sesión: Codex lo dice él; Grok deja ~/.grok/auth.json y Gemini guarda el método en su configuración.
    mkdirSync(join(home, ".grok"));
    writeFileSync(join(home, ".grok", "auth.json"), "{}");
    mkdirSync(join(home, ".gemini"));
    writeFileSync(join(home, ".gemini", "settings.json"), JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } } }));
    assert.equal(geminiAuthMethod(home), "oauth-personal");
    status = byId(await detect(cleanEnv({ FAKE_CODEX_LOGIN: "1" })));
    for (const id of ["codex", "grok", "gemini"]) assert.equal(status[id]?.loggedIn, true, id);
    assert.match(status.codex?.detail ?? "", /Logged in using ChatGPT/);
    assert.match(status.gemini?.detail ?? "", /sesión iniciada con Google/);

    // Una clave en el entorno manda: no hay sesión que abrir desde la app.
    status = byId(await detect(cleanEnv({ XAI_API_KEY: "xai-prueba", GEMINI_API_KEY: "gem-prueba" })));
    assert.equal(status.grok?.canSignIn, false);
    assert.match(status.grok?.detail ?? "", /XAI_API_KEY/);
    assert.equal(status.gemini?.canSignIn, false);
    assert.ok(!JSON.stringify(status).includes("xai-prueba"), "la clave no aparece");

    // Si el programa no responde, se ofrece instalarlo de nuevo.
    found.grok = { path: fakeCli(join(temp.path, "roto"), "grok", BROKEN), source: "oficial" };
    status = byId(await detect());
    assert.equal(status.grok?.available, false);
    assert.equal(status.grok?.canInstall, true);
    assert.match(status.grok?.detail ?? "", /pero no respondió: Error: falta una biblioteca Prueba con «Instalar»/);

    const off = await detectProviders({ enabled: false, codexBin: "codex" });
    assert.deepEqual(
      off.map((item) => [item.id, item.detail.startsWith("Detección desactivada") || item.id === "demo"]),
      [
        ["claude", true],
        ["codex", true],
        ["grok", true],
        ["gemini", true],
        ["demo", true],
      ],
    );
  } finally {
    temp.cleanup();
  }
});

test("cada proveedor ve solo sus claves; comandos oficiales para instalar y para entrar", () => {
  const base = { PATH: "/bin", ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o", CODEX_API_KEY: "c", XAI_API_KEY: "x", GEMINI_API_KEY: "g", GOOGLE_API_KEY: "go" };
  const keys = (env: NodeJS.ProcessEnv) => Object.keys(env).sort();
  assert.deepEqual(keys(providerEnv("grok", base)), ["PATH", "XAI_API_KEY"]);
  assert.deepEqual(keys(providerEnv("gemini", base)), ["GEMINI_API_KEY", "GOOGLE_API_KEY", "PATH"]);
  assert.deepEqual(keys(providerEnv("codex", base)), ["CODEX_API_KEY", "OPENAI_API_KEY", "PATH"]);
  assert.deepEqual(keys(providerEnv("claude", base)), ["ANTHROPIC_API_KEY", "PATH"]);

  const env = { PATH: "/bin" };
  assert.deepEqual(installCommand("grok", { platform: "win32", env }), {
    command: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "irm https://x.ai/cli/install.ps1 | iex"],
    env,
  });
  assert.deepEqual(installCommand("grok", { platform: "linux", env }), { command: "sh", args: ["-c", GROK_INSTALL.unix], env });
  assert.deepEqual(installCommand("codex", { platform: "win32", env, npm: "C:\\nodejs\\npm.cmd" }), {
    command: "C:\\nodejs\\npm.cmd",
    args: ["install", "-g", "@openai/codex", "--no-fund", "--no-audit"],
    env,
  });
  assert.deepEqual(installCommand("gemini", { platform: "linux", env, npm: "/usr/bin/npm" }).args, ["install", "-g", "@google/gemini-cli", "--no-fund", "--no-audit"]);

  const grok = signInCommands("grok", "C:\\grok.exe", { env });
  assert.deepEqual(grok.login, { command: "C:\\grok.exe", args: ["--no-auto-update", "login", "--oauth"], env });
  assert.deepEqual(grok.logout, { command: "C:\\grok.exe", args: ["--no-auto-update", "logout"], env });
  const gemini = signInCommands("gemini", "C:\\npm\\gemini.cmd", { env, nodePath: "C:\\node.exe", acpLoginScript: "C:\\app\\acp-login.js" });
  assert.deepEqual(gemini.login, { command: "C:\\node.exe", args: ["C:\\app\\acp-login.js", "oauth-personal", "C:\\npm\\gemini.cmd", "--acp"], env });
  assert.equal(gemini.logout, null);
  assert.ok(existsSync(String(signInCommands("gemini", "gemini").login.args[0])), "el script de inicio de sesión existe junto a la app");
  assert.deepEqual(signInCommands("codex", "/bin/codex", { env }).login.args, ["login"]);
});

test("métodos de autenticación que ClosedBot pide solo, sin abrir el navegador", () => {
  const temp = tempDir("closedbot-auth-");
  try {
    assert.deepEqual(acpAuthMethods("grok", {}, temp.path), ["cached_token"]);
    assert.deepEqual(acpAuthMethods("gemini", {}, temp.path), []);
    assert.deepEqual(acpAuthMethods("gemini", { GEMINI_API_KEY: "g" }, temp.path), ["gemini-api-key"]);
    mkdirSync(join(temp.path, ".gemini"));
    // El formato antiguo de la configuración también vale.
    writeFileSync(join(temp.path, ".gemini", "settings.json"), '{ "selectedAuthType": "oauth-personal" }');
    assert.deepEqual(acpAuthMethods("gemini", {}, temp.path), ["oauth-personal"]);
  } finally {
    temp.cleanup();
  }
});

test("«Instalar» en Ajustes: muestra el progreso, avisa al terminar y explica si falla", async () => {
  const temp = tempDir("closedbot-install-");
  const marker = join(temp.path, "grok-instalado");
  const statuses = (): ProviderStatus[] => [
    { id: "claude", label: "Claude", available: true, loggedIn: true, detail: "prueba" },
    { id: "codex", label: "Codex", available: false, loggedIn: null, canInstall: true, detail: "No está instalado" },
    existsSync(marker)
      ? { id: "grok", label: "Grok", available: true, loggedIn: false, canSignIn: true, canInstall: true, detail: "sin sesión" }
      : { id: "grok", label: "Grok", available: false, loggedIn: null, canInstall: true, detail: "No está instalado" },
    { id: "gemini", label: "Gemini", available: true, loggedIn: true, canSignIn: true, canSignOut: false, canInstall: true, detail: "prueba" },
    { id: "demo", label: "Demo", available: true, loggedIn: true, detail: "prueba" },
  ];
  const node = (code: string) => ({ command: process.execPath, args: ["-e", code] });
  mkdirSync(join(temp.path, "datos"));
  const h = await createHarness({
    dir: join(temp.path, "datos"),
    detectProviders: async () => statuses(),
    installCommands: (provider) => {
      if (provider === "grok") return node(`setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "x"), 300)`);
      if (provider === "codex") {
        return node(
          `console.error("npm error code EACCES"); console.error("npm error Error: EACCES: permission denied, mkdir '/x'"); console.error("npm error A complete log of this run can be found in: /tmp/x.log"); process.exit(1)`,
        );
      }
      return node("setTimeout(() => undefined, 60000)");
    },
    signInCommands: (provider) =>
      provider === "gemini" ? { login: node("process.exit(0)"), logout: null, acceptsCode: false } : null,
  });
  const provider = (id: string) => h.service.providers().find((item) => item.id === id) as ProviderStatus;
  const notices = () => h.events.filter((event): event is Extract<ServiceEvent, { type: "notice" }> => event.type === "notice").map((event) => event.message);
  try {
    await waitFor(() => provider("grok").canInstall, 5_000, "detección");
    h.service.startInstall("grok");
    assert.ok(provider("grok").install?.startedAt, "se ve que está instalando");
    // Pulsarlo otra vez no abre otra instalación.
    h.service.startInstall("grok");
    await waitFor(() => notices().includes("Grok quedó instalado. Ahora pulsa «Iniciar sesión con Grok»."), 10_000, "aviso de instalado");
    assert.equal(provider("grok").install, undefined);
    assert.equal(provider("grok").available, true);

    h.service.startInstall("codex");
    await waitFor(() => notices().some((text) => text.startsWith("Codex: ")), 10_000, "aviso de fallo");
    assert.ok(notices().includes("Codex: No se pudo instalar: Error: EACCES: permission denied, mkdir '/x'"), notices().join(" | "));

    h.service.startInstall("gemini");
    assert.ok(provider("gemini").install);
    h.service.cancelInstall("gemini");
    assert.equal(provider("gemini").install, undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(!notices().some((text) => text.startsWith("Gemini")), "cancelar no es un error");

    assert.throws(() => h.service.startInstall("claude"), (error: unknown) => error instanceof ServiceError && error.status === 400);
    await assert.rejects(h.service.signOut("gemini"), (error: unknown) => error instanceof ServiceError && error.status === 409 && /no tiene un comando para cerrar la sesión/.test(error.message));
  } finally {
    await h.close();
    temp.cleanup();
  }

  // Sin comandos de instalación (por ejemplo, la detección apagada) se dice en vez de fallar.
  const bare = await createHarness();
  try {
    assert.throws(() => bare.service.startInstall("grok"), (error: unknown) => error instanceof ServiceError && error.status === 409);
  } finally {
    await bare.close();
  }
});
