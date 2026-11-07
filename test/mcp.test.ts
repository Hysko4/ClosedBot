import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { McpServerStatus, Options, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createApp } from "../src/app.js";
import { Auth, hashPassword, PASSWORD_META } from "../src/auth.js";
import { fromClaudeStatus, fromCodexStatus } from "../src/mcp.js";
import type { ProviderId } from "../src/providers/client.js";
import { ClaudeAgentClient, type QueryFactory } from "../src/providers/claude.js";
import { AppServerError } from "../src/providers/codex.js";
import { DemoAgentClient } from "../src/providers/demo.js";
import { createHarness, TEST_PROVIDERS } from "./helpers.js";

test("MCP: lo que informan Claude y Codex queda igual para todos, sin la configuración del servidor", () => {
  const claude = fromClaudeStatus([
    { name: "closedbot", status: "connected", source: "sdk", tools: [{ name: "list_agents" }, { name: "send_message" }] },
    {
      name: "github",
      status: "failed",
      scope: "user",
      error: "  no  se pudo\n conectar ",
      config: { type: "stdio", command: "npx", env: { GITHUB_TOKEN: "secreto" } },
    },
    { name: "drive", status: "needs-auth", source: "plugin" },
    { name: "raro", status: "otro-estado" },
    { status: "connected" },
  ]);
  assert.deepEqual(claude, [
    { name: "closedbot", status: "connected", source: "closedbot", tools: ["list_agents", "send_message"], error: null },
    { name: "github", status: "failed", source: "user", tools: [], error: "no se pudo conectar" },
    { name: "drive", status: "needs-auth", source: "plugin", tools: [], error: null },
    { name: "raro", status: "configured", source: null, tools: [], error: null },
  ]);
  assert.ok(!JSON.stringify(claude).includes("secreto"), "nunca se copia su configuración (puede llevar claves)");

  const codex = fromCodexStatus({
    data: [
      { name: "figma", tools: { get_file: { name: "get_file" }, list: {} }, authStatus: "oAuth" },
      { name: "linear", tools: {}, authStatus: "notLoggedIn" },
      { name: "vacio", tools: {}, authStatus: "unsupported" },
    ],
    nextCursor: null,
  });
  assert.deepEqual(
    codex.map((server) => [server.name, server.status, server.tools.join(",")]),
    [
      ["figma", "connected", "get_file,list"],
      ["linear", "needs-auth", ""],
      ["vacio", "configured", ""],
    ],
  );
});

/**
 * Una consulta del SDK de mentira que solo cuenta sus MCP, como el Claude Code real recién abierto: primero sin
 * ninguno (todavía no los carga), después con los suyos «pending» y al final conectados.
 */
function probeFactory(seen: { options: Options[]; closed: number; inputClosed: number; calls: number }): QueryFactory {
  return ({ prompt, options }) => {
    seen.options.push(options);
    const iterator = (prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
    let calls = 0;
    async function* run() {
      // Ninguna revisión manda mensajes: si llega uno, la prueba falla.
      const next = await iterator.next();
      if (next.done) seen.inputClosed += 1;
      else throw new Error("La revisión de MCP no debe mandar mensajes.");
    }
    const generator = run();
    void generator.next();
    return Object.assign(generator, {
      mcpServerStatus: async (): Promise<McpServerStatus[]> => {
        calls += 1;
        seen.calls += 1;
        if (calls === 1) return [];
        return [
          { name: "closedbot", status: "connected", source: "sdk", tools: [{ name: "list_agents" }] },
          { name: "github", status: calls === 2 ? "pending" : "connected", scope: "user", tools: calls === 2 ? [] : [{ name: "create_issue" }] },
        ] as McpServerStatus[];
      },
      close: () => {
        seen.closed += 1;
      },
    }) as unknown as Query;
  };
}

test("MCP (Claude): sin sesión abierta se revisan con una sesión corta, sin mensajes ni conectores de claude.ai", async () => {
  const seen = { options: [] as Options[], closed: 0, inputClosed: 0, calls: 0 };
  const client = new ClaudeAgentClient({ createQuery: probeFactory(seen), idleMs: 0 });
  client.start();
  try {
    const listing = await client.request<{ servers: Array<{ name: string; status: string; tools: string[] }> }>("closedbot/mcp", {
      cwd: "/tmp/agente",
      runtimeWorkspaceRoots: ["/tmp/agente", "/tmp/compartida"],
      sandbox: "danger-full-access",
      developerInstructions: "",
      threadId: null,
    });
    assert.deepEqual(
      listing.servers.map((server) => [server.name, server.status, server.tools.join(",")]),
      [
        ["closedbot", "connected", "list_agents"],
        ["github", "connected", "create_issue"],
      ],
      "espera a que cargue los de ClosedBot y a que el que estaba «pending» termine de conectarse",
    );
    assert.equal(seen.calls, 3);
    const options = seen.options[0];
    assert.ok(options);
    assert.equal(options.persistSession, false, "la revisión no deja una conversación guardada");
    assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false", "los conectores de la cuenta siguen apagados");
    assert.deepEqual(options.settings, { disableClaudeAiConnectors: true });
    assert.deepEqual(options.settingSources, ["user", "project", "local"], "con acceso total, los mismos ajustes que usa al trabajar");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(seen.closed, 1, "la sesión corta se cierra");
    assert.equal(seen.inputClosed, 1, "y nunca recibe un mensaje");
  } finally {
    await client.stop();
  }
});

/** Un Codex de mentira: solo responde la lista de MCP (o, si es antiguo, con el nombre de antes). */
class FakeCodex extends DemoAgentClient {
  readonly calls: string[] = [];
  constructor(private readonly legacy: boolean) {
    super({ wordDelayMs: 0 });
  }
  override async request<T>(method: string, params: unknown): Promise<T> {
    if (method === "mcpServerStatus/list" || method === "mcpServers/list") {
      this.calls.push(method);
      if (method === "mcpServerStatus/list" && this.legacy) throw new AppServerError("Invalid request: unknown variant `mcpServerStatus/list`", -32600);
      return { data: [{ name: "figma", tools: { get_file: {} }, authStatus: "oAuth" }], nextCursor: null } as T;
    }
    return super.request<T>(method, params);
  }
}

test("MCP (servicio): Codex suma los suyos a los de ClosedBot; Gemini avisa que no cuenta los propios; se guardan unos minutos", async () => {
  const codex = new FakeCodex(true);
  const opened: ProviderId[] = [];
  const h = await createHarness({
    createClient: (provider) => {
      opened.push(provider);
      return provider === "codex" ? codex : new DemoAgentClient({ wordDelayMs: 0 });
    },
    detectProviders: async () => [...TEST_PROVIDERS, { id: "gemini", label: "Gemini", available: true, loggedIn: true, detail: "prueba" }],
  });
  try {
    await h.service.refreshProviders();
    const demo = h.service.createAgent({ name: "Demi", provider: "demo" });
    const first = await h.service.agentMcp(demo.id);
    assert.deepEqual(first.servers.map((server) => server.name), ["closedbot"]);
    assert.ok(first.servers[0]?.tools.includes("send_message"), "las herramientas del equipo de ClosedBot");
    assert.equal(first.hidden, false);
    assert.equal(first.access, "carpeta");
    const again = await h.service.agentMcp(demo.id);
    assert.equal(again.checkedAt, first.checkedAt, "dentro de unos minutos responde lo de la última revisión");

    const codi = h.service.createAgent({ name: "Codi", provider: "codex" });
    const listing = await h.service.agentMcp(codi.id);
    assert.deepEqual(
      listing.servers.map((server) => [server.name, server.status, server.source]),
      [
        ["closedbot", "included", "closedbot"],
        ["figma", "connected", "codex"],
      ],
    );
    assert.deepEqual(codex.calls, ["mcpServerStatus/list", "mcpServers/list"], "un Codex antiguo responde con el nombre de antes");
    await h.service.agentMcp(codi.id, { refresh: true });
    assert.equal(codex.calls.length, 4, "«Revisar de nuevo» vuelve a preguntar");

    const gemi = h.service.createAgent({ name: "Gemi", provider: "gemini" });
    const hidden = await h.service.agentMcp(gemi.id);
    assert.equal(hidden.hidden, true);
    assert.deepEqual(hidden.servers.map((server) => [server.name, server.status]), [["closedbot", "included"]]);
    assert.ok(!opened.includes("gemini"), "Gemini no se abre solo para esto");
  } finally {
    await h.close();
  }
});

test("MCP HTTP: GET /api/agents/:id/mcp responde lo del agente y 404 si no existe", async () => {
  const h = await createHarness();
  h.store.setMeta(PASSWORD_META, await hashPassword("clave-de-prueba-123"));
  const auth = new Auth({ store: h.store, sessionDays: 7, envPassword: null });
  const app = createApp({ service: h.service, auth, publicDir: "public", sharedDir: h.dir, workspacesDir: h.dir, maxHops: 6, secureCookies: "never" });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cuadrilla": "1" },
      body: JSON.stringify({ password: "clave-de-prueba-123" }),
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const agent = h.service.createAgent({ name: "Demi", provider: "demo" });
    const response = await fetch(`${base}/api/agents/${agent.id}/mcp?refresh=1`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { mcp: { agentId: string; servers: Array<{ name: string }> } };
    assert.equal(body.mcp.agentId, agent.id);
    assert.deepEqual(body.mcp.servers.map((server) => server.name), ["closedbot"]);
    const missing = await fetch(`${base}/api/agents/no-existe/mcp`, { headers: { cookie } });
    assert.equal(missing.status, 404);
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    await h.close();
  }
});
