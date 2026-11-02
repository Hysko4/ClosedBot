import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.js";
import type { AgentClient, ProviderId } from "../src/providers/client.js";
import { DemoAgentClient } from "../src/providers/demo.js";
import { AgentService, type ProviderStatus, type ServiceEvent, type ServiceOptions } from "../src/service.js";

export function tempDir(prefix = "closedbot-test-"): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

export async function waitFor<T>(check: () => T | null | undefined | false, timeoutMs = 5_000, label = "condición"): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`Tiempo agotado esperando: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export const TEST_PROVIDERS: ProviderStatus[] = [
  { id: "claude", label: "Claude", available: true, loggedIn: null, detail: "prueba" },
  { id: "codex", label: "Codex", available: true, loggedIn: null, detail: "prueba" },
  { id: "demo", label: "Demo", available: true, loggedIn: true, detail: "prueba" },
];

export interface Harness {
  dir: string;
  store: Store;
  service: AgentService;
  events: ServiceEvent[];
  close: () => Promise<void>;
}

/** Servicio real con base de datos temporal; por defecto todos los proveedores usan la demo. */
export async function createHarness(options: {
  maxHops?: number;
  createClient?: (provider: ProviderId) => AgentClient;
  dir?: string;
  keepDir?: boolean;
  detectProviders?: ServiceOptions["detectProviders"];
  signInCommands?: ServiceOptions["signInCommands"];
  signInTimeoutMs?: number;
} = {}): Promise<Harness> {
  const temp = options.dir ? { path: options.dir, cleanup: () => undefined } : tempDir();
  const store = new Store(join(temp.path, "closedbot.db"));
  const events: ServiceEvent[] = [];
  const service = new AgentService({
    store,
    workspacesDir: join(temp.path, "agentes"),
    sharedDir: join(temp.path, "compartida"),
    maxHops: options.maxHops ?? 6,
    createClient: options.createClient ?? (() => new DemoAgentClient({ wordDelayMs: 0 })),
    detectProviders: options.detectProviders ?? (async () => TEST_PROVIDERS),
    ...(options.signInCommands ? { signInCommands: options.signInCommands } : {}),
    ...(options.signInTimeoutMs ? { signInTimeoutMs: options.signInTimeoutMs } : {}),
  });
  service.on("event", (event) => events.push(event));
  await service.start();
  return {
    dir: temp.path,
    store,
    service,
    events,
    close: async () => {
      await service.stop();
      store.close();
      if (!options.keepDir) temp.cleanup();
    },
  };
}
