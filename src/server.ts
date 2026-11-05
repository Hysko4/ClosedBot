import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { createApp } from "./app.js";
import { Auth } from "./auth.js";
import { prepareConfig, setting } from "./config.js";
import { Store } from "./db.js";
import { AcpClient } from "./providers/acp.js";
import { ANTIGRAVITY_SIGN_IN_PROMPT, antigravityArgs, antigravityEnv, antigravityHasUsage, antigravityVersion, cleanStaleTemps } from "./providers/antigravity.js";
import { ClaudeAgentClient } from "./providers/claude.js";
import { claudeEnv, claudeLoginCommand, claudeLogoutCommand, resolveClaudeCli } from "./providers/claude-cli.js";
import type { AgentClient, ProviderId } from "./providers/client.js";
import { CodexAppServerClient } from "./providers/codex.js";
import { DemoAgentClient } from "./providers/demo.js";
import { detectProviders } from "./providers/detect.js";
import { type CliName, locateCli } from "./providers/locate.js";
import { acpAuthMethods, GROK_AGENT_ARGS, installCommand, providerEnv, signInCommands } from "./providers/presets.js";
import { AgentService, VERSION } from "./service.js";
import { SpeechEngine } from "./speech.js";
import { LocalVoices, openBotVoiceDirs } from "./voices.js";

function log(level: "info" | "warn" | "error", message: string): void {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
  if (level === "error") console.error(line);
  else console.log(line);
}

async function main(): Promise<void> {
  const { config } = prepareConfig(process.env, log);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(config.dataDir, 0o700);
  } catch {
    // Si la carpeta es de otro usuario, se deja como está.
  }
  // La contraseña no debe llegar al entorno de los agentes.
  const envPassword = setting(process.env, "PASSWORD") ?? null;
  // Tampoco el token del lanzador de escritorio (con él se abre sesión y se apaga la app).
  let controlToken = setting(process.env, "CONTROL_TOKEN")?.trim() || null;
  for (const name of ["PASSWORD", "NEW_PASSWORD", "CONTROL_TOKEN"]) {
    delete process.env[`CLOSEDBOT_${name}`];
    delete process.env[`CUADRILLA_${name}`];
  }
  if (controlToken && controlToken.length < 32) {
    log("warn", "CLOSEDBOT_CONTROL_TOKEN es demasiado corto (mínimo 32 caracteres); se ignora.");
    controlToken = null;
  }
  const store = new Store(config.dbPath);
  // Agentes creados cuando los datos estaban en ~/.cuadrilla: su carpeta ahora está en ~/.closedbot.
  const legacyDir = join(homedir(), ".cuadrilla");
  if (!config.legacyDataDir && config.dataDir === join(homedir(), ".closedbot") && !existsSync(legacyDir)) {
    const moved = store.moveWorkspaces(legacyDir + sep, config.dataDir + sep);
    if (moved) log("info", `Actualicé la carpeta de ${moved} agente(s) a ${config.dataDir}.`);
  }
  const auth = new Auth({ store, sessionDays: config.sessionDays, envPassword });
  if (!(await auth.isConfigured())) {
    console.error("ClosedBot necesita una contraseña antes de arrancar.\nCréala con:  npm run password   (o: npm run password -- --generate)");
    store.close();
    process.exitCode = 1;
    return;
  }

  // Claude Code guarda la sesión de los agentes en su propia carpeta: iniciar o cerrar sesión en la app
  // no toca el Claude Code que se use aparte en este equipo.
  mkdirSync(config.claudeConfigDir, { recursive: true, mode: 0o700 });
  const claudeCli = resolveClaudeCli(config.claudeBin);
  // Cada proveedor ve solo sus propias claves.
  const claudeEnvironment = claudeEnv(providerEnv("claude"), config.claudeConfigDir);
  const codexEnvironment = providerEnv("codex");
  const grokEnvironment = providerEnv("grok");
  const geminiEnvironment = providerEnv("gemini");
  if (!claudeCli) log("warn", "No encontré Claude Code (viene con @anthropic-ai/claude-agent-sdk); reinstala las dependencias con «npm ci».");

  // Codex, Grok y Gemini (Antigravity) se buscan cada vez: si se instalan con la app abierta, se encuentran solos.
  const configured: Record<CliName, string | null> = { codex: config.codexBin, grok: config.grokBin, gemini: config.geminiBin };
  // «Instalar» de Gemini deja Antigravity en <datos>/programas; cada proceso suyo usa una carpeta en <datos>/tmp.
  const programsDir = join(config.dataDir, "programas");
  const tempRoot = join(config.dataDir, "tmp");
  cleanStaleTemps(tempRoot);
  const locate = (name: CliName) => locateCli(name, { configured: configured[name], programsDir });
  const program = (name: CliName) => locate(name)?.path ?? configured[name] ?? name;

  const createClient = (provider: ProviderId): AgentClient => {
    switch (provider) {
      case "claude":
        return new ClaudeAgentClient({
          executable: config.claudeBin,
          playwright: config.playwright,
          env: claudeEnvironment,
        });
      case "codex":
        return new CodexAppServerClient({
          executable: program("codex"),
          env: codexEnvironment,
        });
      case "grok":
        return new AcpClient({
          provider,
          label: "Grok",
          command: program("grok"),
          args: GROK_AGENT_ARGS,
          env: grokEnvironment,
          authMethods: acpAuthMethods("grok", grokEnvironment),
          usage: "grok",
        });
      case "gemini": {
        const command = program("gemini");
        return new AcpClient({
          provider,
          label: "Gemini",
          command,
          args: antigravityArgs(),
          env: antigravityEnv(geminiEnvironment, { chat: true }),
          authMethods: acpAuthMethods("gemini", geminiEnvironment),
          signInPrompt: ANTIGRAVITY_SIGN_IN_PROMPT,
          tempRoot,
          // El uso del plan con «/usage», si la versión lo contesta sin pasar por el modelo.
          ...(antigravityHasUsage(antigravityVersion(command)) ? { usage: "antigravity" as const } : {}),
        });
      }
      case "demo":
        return new DemoAgentClient();
    }
  };
  const environments = { codex: codexEnvironment, grok: grokEnvironment, gemini: geminiEnvironment };

  const service = new AgentService({
    store,
    workspacesDir: config.workspacesDir,
    sharedDir: config.sharedDir,
    maxHops: config.maxHops,
    createClient,
    // Claude Bot: el bot principal que arma los equipos de agentes.
    mainAgent: true,
    detectProviders: () =>
      detectProviders({
        enabled: config.detectProviders,
        codexBin: config.codexBin,
        grokBin: config.grokBin,
        geminiBin: config.geminiBin,
        locate,
        claude: { cli: claudeCli, env: claudeEnvironment, configDir: config.claudeConfigDir },
      }),
    // Como en OpenBot: se inicia sesión con la cuenta mediante el propio CLI, que abre el navegador.
    signInCommands: (provider) => {
      if (provider === "claude") {
        if (!claudeCli) return null;
        return {
          login: claudeLoginCommand(claudeCli, claudeEnvironment),
          logout: claudeLogoutCommand(claudeCli, claudeEnvironment),
          acceptsCode: true,
        };
      }
      const found = locate(provider);
      if (!found) return null;
      return signInCommands(provider, found.path, { env: environments[provider], tempRoot });
    },
    // «Instalar» en Ajustes: npm (Codex), el instalador oficial de Grok o el .zip de Antigravity de Google (Gemini).
    installCommands: (provider) =>
      installCommand(provider, {
        env: envWithout(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "XAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"]),
        programsDir,
      }),
    // La Oficina: personajes de PixelLab y el arte en alta resolución.
    officeDir: join(config.dataDir, "oficina"),
    log,
  });
  await service.start();
  service.prefetchOfficeArt();

  // Dictado local: el modelo se descarga en <datos>/voz la primera vez que alguien lo pide.
  const speech = new SpeechEngine({ dir: join(config.dataDir, "voz"), log });
  // Voces locales (Supertonic 3): la copia de OpenBot si ya la bajó; si no, se descargan en <datos>/voz/voces.
  const voices = new LocalVoices({ dir: join(config.dataDir, "voz"), shared: openBotVoiceDirs(), log });

  const app = createApp({
    service,
    auth,
    publicDir: config.publicDir,
    sharedDir: config.sharedDir,
    workspacesDir: config.workspacesDir,
    maxHops: config.maxHops,
    secureCookies: config.secureCookies,
    controlToken,
    onShutdown: () => void shutdown("la orden de cierre del lanzador"),
    speech,
    voices,
    log,
  });

  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(config.port, config.host, () => resolve());
  });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  log("info", `ClosedBot ${VERSION} escuchando en http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${port}`);
  log("info", `Datos en ${config.dataDir}`);
  if (!["127.0.0.1", "::1", "localhost"].includes(config.host)) {
    log("warn", "Escuchas fuera de localhost: asegúrate de que solo tu red privada (Tailscale) llegue a este puerto.");
  }

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("info", `Recibí ${signal}; cerrando…`);
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    app.closeStreams();
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    await service.stop();
    await speech.stop();
    await voices.stop();
    store.close();
    clearTimeout(force);
    log("info", "ClosedBot se cerró.");
    // Si algo quedara colgado (un proceso de un proveedor), no impide salir.
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

/** Copia del entorno sin las claves de otro proveedor: cada agente ve solo lo que necesita. */
function envWithout(keys: string[]): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of keys) delete env[key];
  return env;
}

main().catch((error: unknown) => {
  log("error", error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
