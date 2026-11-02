import { chmodSync, mkdirSync } from "node:fs";
import { createApp } from "./app.js";
import { Auth } from "./auth.js";
import { loadConfig } from "./config.js";
import { Store } from "./db.js";
import { ClaudeAgentClient } from "./providers/claude.js";
import type { AgentClient, ProviderId } from "./providers/client.js";
import { CodexAppServerClient } from "./providers/codex.js";
import { DemoAgentClient } from "./providers/demo.js";
import { detectProviders } from "./providers/detect.js";
import { AgentService, VERSION } from "./service.js";

function log(level: "info" | "warn" | "error", message: string): void {
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
  if (level === "error") console.error(line);
  else console.log(line);
}

async function main(): Promise<void> {
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(config.dataDir, 0o700);
  } catch {
    // Si la carpeta es de otro usuario, se deja como está.
  }
  // La contraseña no debe llegar al entorno de los agentes.
  const envPassword = process.env.CUADRILLA_PASSWORD ?? null;
  delete process.env.CUADRILLA_PASSWORD;
  delete process.env.CUADRILLA_NEW_PASSWORD;
  const store = new Store(config.dbPath);
  const auth = new Auth({ store, sessionDays: config.sessionDays, envPassword });
  if (!(await auth.isConfigured())) {
    console.error("Cuadrilla necesita una contraseña antes de arrancar.\nCréala con:  npm run password   (o: npm run password -- --generate)");
    store.close();
    process.exitCode = 1;
    return;
  }

  const createClient = (provider: ProviderId): AgentClient => {
    switch (provider) {
      case "claude":
        return new ClaudeAgentClient({
          executable: config.claudeBin,
          playwright: config.playwright,
          env: envWithout(["OPENAI_API_KEY", "CODEX_API_KEY"]),
        });
      case "codex":
        return new CodexAppServerClient({
          executable: config.codexBin,
          env: envWithout(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]),
        });
      case "demo":
        return new DemoAgentClient();
    }
  };

  const service = new AgentService({
    store,
    workspacesDir: config.workspacesDir,
    sharedDir: config.sharedDir,
    maxHops: config.maxHops,
    createClient,
    detectProviders: () => detectProviders({ enabled: config.detectProviders, codexBin: config.codexBin }),
    log,
  });
  await service.start();

  const app = createApp({
    service,
    auth,
    publicDir: config.publicDir,
    sharedDir: config.sharedDir,
    workspacesDir: config.workspacesDir,
    maxHops: config.maxHops,
    secureCookies: config.secureCookies,
    log,
  });

  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(config.port, config.host, () => resolve());
  });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  log("info", `Cuadrilla ${VERSION} escuchando en http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${port}`);
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
    store.close();
    clearTimeout(force);
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
