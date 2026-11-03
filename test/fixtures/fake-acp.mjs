#!/usr/bin/env node
// Agente ACP falso para pruebas (como Grok o Gemini CLI): JSON-RPC por líneas en stdin/stdout.
// Se maneja con marcas en el mensaje (@comando, @editar, @herramienta…) y con variables FAKE_ACP_*.
import { appendFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const log = process.env.FAKE_ACP_LOG;
/**
 * ok: entra sin más · required: hace falta «authenticate» con la sesión guardada · never: no hay sesión ·
 * link: como Antigravity sin sesión, escribe el enlace para entrar y se queda esperando.
 */
const authMode = process.env.FAKE_ACP_AUTH ?? "ok";
/**
 * FAKE_ACP_USAGE=antigravity: contesta «/usage» como Antigravity 1.4.5 (sin pasar por el modelo);
 * model: como una versión que no lo conoce (el mensaje va al modelo). FAKE_ACP_BILLING: lo que devuelve
 * `_x.ai/billing` de Grok (sin la variable, el método no existe).
 */
const usageMode = process.env.FAKE_ACP_USAGE ?? "";
const billing = process.env.FAKE_ACP_BILLING ?? "";
// Texto exacto que devolvió Antigravity 1.4.5 en el PC del usuario.
const USAGE_TEXT = [
  "### Session Usage",
  "- **Session total:** data not available yet",
  "",
  "### Quota Limits",
  "- **Gemini Models**",
  "  *(Models within this group: Gemini Flash, Gemini Pro)*",
  "  - **Weekly Limit Remaining:** 96% remaining (resets Nov 09, 2026, 02:22 UTC)",
  "  - **Five Hour Limit Remaining:** 100% remaining (resets Nov 03, 2026, 21:00 UTC)",
  "- **Claude and GPT models**",
  "  *(Models within this group: Claude Opus, Claude Sonnet, GPT-OSS)*",
  "  - **Weekly Limit Remaining:** 100% remaining (resets Nov 08, 2026, 04:39 UTC)",
  "  - **Five Hour Limit Remaining:** 100% remaining (resets Nov 03, 2026, 21:00 UTC)",
  "- **Gemini 4 Argon**",
  "  *(For paid Pro plans, Argon quota is separate. Higher Argon quota (included as part of the larger Gemini quota bucket) is available on Ultra plans.)*",
  "  - **Gemini 4 Argon Weekly Limit:** 27% remaining (resets Nov 08, 2026, 18:22 UTC)",
].join("\n");
const noResume = process.env.FAKE_ACP_NO_RESUME === "1";
let authenticated = authMode === "ok";
const sessions = new Map();
let nextSession = 1;
let nextServerId = 5000;
const pending = new Map();

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const record = (message) => {
  if (log) appendFileSync(log, `${JSON.stringify(message)}\n`);
};
const update = (sessionId, body) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: body } });
const callClient = (method, params) =>
  new Promise((resolve) => {
    const id = nextServerId++;
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
const until = async (check) => {
  while (!check()) await new Promise((resolve) => setTimeout(resolve, 10));
};

// La carpeta temporal con la que arrancó (ClosedBot le da una propia a Antigravity).
record({ method: "_arranque", temp: process.env.TEMP ?? null, tmp: process.env.TMP ?? null, tmpdir: process.env.TMPDIR ?? null });

// Avisos sueltos, como los de algunos CLI al arrancar: no deben romper el protocolo.
process.stdout.write("Iniciando el agente falso…\n");
process.stderr.write("aviso: agente falso en modo de prueba\n");

// FAKE_ACP_MODELS=antigravity: como Antigravity 1.4.5 (visto en el PC del usuario). En la lista vieja cada nivel es
// otro modelo; en las opciones de la sesión vienen los modelos y los niveles por separado.
const antigravity = process.env.FAKE_ACP_MODELS === "antigravity";
const level = (name) => ({ value: name.toLowerCase(), name });
const MODELS = antigravity
  ? {
      availableModels: [
        ["gemini-4-argon-medium", "Gemini 4 Argon (Medium)"],
        ["gemini-4-argon-high", "Gemini 4 Argon (High)"],
        ["gemini-4-argon-low", "Gemini 4 Argon (Low)"],
        ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
        ["gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"],
        ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
      ].map(([modelId, name]) => ({ modelId, name, description: modelId })),
      currentModelId: "gemini-3.8-flash-high",
    }
  : {
      availableModels: [
        { modelId: "fake-pro", name: "Fake Pro", _meta: { reasoningEfforts: [{ value: "high" }, { value: "low" }] } },
        { modelId: "fake-mini", name: "Fake Mini" },
      ],
      currentModelId: "fake-pro",
    };
const CONFIG = antigravity
  ? [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "gemini-3.8-flash",
        options: [
          { value: "gemini-4-argon", name: "Gemini 4 Argon" },
          { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
        ],
      },
      { id: "thinking_level", name: "Thinking", category: "thought_level", type: "select", currentValue: "high", options: ["Low", "Medium", "High"].map(level) },
      { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default", options: ["default", "auto_edit", "yolo"].map((value) => ({ value, name: value })) },
    ]
  : [
      { id: "model", name: "Modelo", category: "model", type: "select", currentValue: "fake-pro", options: [] },
      { id: "reasoning_effort", name: "Razonamiento", category: "thought_level", type: "select", currentValue: "high", options: [] },
    ];
const PERMISSION_OPTIONS = [
  { optionId: "si", name: "Permitir", kind: "allow_once" },
  { optionId: "siempre", name: "Permitir siempre", kind: "allow_always" },
  { optionId: "no", name: "Rechazar", kind: "reject_once" },
];

/** Se conecta al servidor MCP que le pasa ClosedBot (el puente de las herramientas del equipo). */
async function connectMcp(servers) {
  const server = Array.isArray(servers) ? servers[0] : undefined;
  if (!server) return null;
  const env = Object.fromEntries((server.env ?? []).map((entry) => [entry.name, entry.value]));
  const client = new Client({ name: "fake-acp", version: "1.0.0" });
  await client.connect(new StdioClientTransport({ command: server.command, args: server.args, env }));
  const { tools } = await client.listTools();
  return { client, tools, env };
}

async function openSession(sessionId, params) {
  const previous = sessions.get(sessionId);
  await previous?.mcp?.client.close();
  sessions.set(sessionId, { cwd: params.cwd, mcp: await connectMcp(params.mcpServers), cancelled: false });
}

async function handle(method, params) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: noResume ? {} : { resume: {}, close: {} } },
        authMethods: [
          { id: "cached_token", name: "Sesión guardada" },
          { id: "browser", name: "Navegador" },
        ],
        agentInfo: { name: "fake-acp", title: "Agente falso", version: "9.9.9" },
      };
    case "authenticate":
      if (authMode === "never" || params.methodId !== "cached_token") throw { code: -32000, message: "Authentication required" };
      authenticated = true;
      return {};
    case "session/new": {
      if (authMode === "link") {
        // El aviso llega en dos trozos, como puede pasar con stderr.
        process.stderr.write("Open the following link to ");
        setTimeout(() => process.stderr.write("authenticate the ACP server:\nhttps://accounts.google.com/o/oauth2/v2/auth?client_id=prueba\n"), 50);
        await new Promise(() => undefined);
      }
      if (!authenticated) throw { code: -32000, message: "Authentication required" };
      const sessionId = `sesion-${nextSession++}`;
      await openSession(sessionId, params);
      return { sessionId, models: MODELS, configOptions: CONFIG };
    }
    case "session/load":
      if (!authenticated) throw { code: -32000, message: "Authentication required" };
      // «load» repite la conversación como avisos antes de responder.
      update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "conversación vieja" } });
      await openSession(params.sessionId, params);
      return { models: MODELS, configOptions: CONFIG };
    case "session/resume":
      if (!authenticated) throw { code: -32000, message: "Authentication required" };
      await openSession(params.sessionId, params);
      return { models: MODELS, configOptions: CONFIG };
    case "session/set_config_option":
      return { configOptions: CONFIG };
    case "session/set_model":
      return {};
    case "session/close": {
      await sessions.get(params.sessionId)?.mcp?.client.close();
      sessions.delete(params.sessionId);
      return {};
    }
    case "session/prompt":
      return runPrompt(params);
    case "_x.ai/billing":
      if (!billing) throw { code: -32601, message: "Method not found" };
      if (!authenticated) throw { code: -32000, message: "Authentication required" };
      return JSON.parse(billing);
    default:
      throw { code: -32601, message: `Método desconocido: ${method}` };
  }
}

async function ask(sessionId, toolCall) {
  const answer = await callClient("session/request_permission", { sessionId, toolCall, options: PERMISSION_OPTIONS });
  return answer?.outcome?.optionId ?? answer?.outcome?.outcome ?? "?";
}

async function runPrompt({ sessionId, prompt }) {
  const session = sessions.get(sessionId);
  if (!session) throw { code: -32602, message: "Sesión desconocida" };
  session.cancelled = false;
  const text = prompt.map((block) => block.text ?? "").join("\n");
  const say = (chunk) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } });
  if (text === "/usage" && usageMode === "antigravity") {
    // Local, sin pensar ni herramientas: un solo trozo de texto.
    say(USAGE_TEXT);
    return { stopReason: "end_turn" };
  }
  if (text.includes("@espera")) {
    say("Pensando…");
    await until(() => session.cancelled);
    return { stopReason: "cancelled" };
  }
  if (text.includes("@sordo")) {
    // No contesta nunca, ni siquiera a la cancelación.
    await new Promise(() => undefined);
  }
  update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "pensamiento interno" } });
  say("Hola ");
  say("desde ACP.");
  if (text.includes("@comando")) {
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t1", title: "Ejecutar ls", kind: "execute", status: "pending", rawInput: { command: "ls -la" } });
    const chosen = await ask(sessionId, { toolCallId: "t1", title: "Ejecutar ls", kind: "execute" });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: chosen === "si" ? "completed" : "failed" });
    say(` Comando: ${chosen}.`);
  }
  if (text.includes("@editar")) {
    const path = text.includes("@fuera") ? join(session.cwd, "..", "..", "fuera.txt") : join(session.cwd, "nota.txt");
    const chosen = await ask(sessionId, { toolCallId: "t2", title: "Editar", kind: "edit", locations: [{ path }] });
    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t2", title: "Editar nota", kind: "edit", status: chosen === "si" ? "completed" : "failed", locations: [{ path }] });
    say(` Edición: ${chosen}.`);
  }
  if (text.includes("@herramienta")) {
    const result = await session.mcp.client.callTool({ name: "list_agents", arguments: {} });
    const agents = JSON.parse(result.content[0].text).agentes;
    say(` Equipo: ${agents.map((agent) => agent.nombre).join(", ")}.`);
    const missing = await session.mcp.client.callTool({ name: "no_existe", arguments: {} });
    say(` Otra: ${missing.isError ? "rechazada" : "aceptada"}.`);
  }
  if (text.includes("@intruso")) {
    // Alguien que no tiene la clave del puente: ClosedBot debe cortar sin contestar.
    const outcome = await new Promise((resolve) => {
      const socket = connect(session.mcp.env.CLOSEDBOT_BRIDGE);
      let answered = false;
      socket.on("data", () => {
        answered = true;
      });
      socket.on("close", () => resolve(answered ? "contestó" : "rechazado"));
      socket.on("error", () => resolve("rechazado"));
      socket.write(`${JSON.stringify({ id: 1, token: "clave-falsa", key: session.mcp.env.CLOSEDBOT_BRIDGE_KEY, type: "tools" })}\n`);
    });
    say(` Intruso: ${outcome}.`);
  }
  return { stopReason: "end_turn" };
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  record(message);
  if (message.method === undefined) {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve?.(message.result ?? message.error);
    return;
  }
  if (message.id === undefined) {
    if (message.method === "session/cancel") {
      const session = sessions.get(message.params?.sessionId);
      if (session) session.cancelled = true;
    }
    return;
  }
  handle(message.method, message.params ?? {}).then(
    (result) => send({ jsonrpc: "2.0", id: message.id, result }),
    (error) => send({ jsonrpc: "2.0", id: message.id, error: { code: error?.code ?? -32603, message: error?.message ?? String(error) } }),
  );
});
rl.on("close", () => process.exit(0));
