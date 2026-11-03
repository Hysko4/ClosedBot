// Puente de las herramientas del equipo para los agentes ACP (Grok, Gemini): el agente lo arranca como
// servidor MCP por stdio y cada llamada viaja a ClosedBot por una tubería local, con una clave aleatoria
// que solo conocen ClosedBot y este proceso. No guarda nada ni toca la red.

import { connect } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, type CallToolResult, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const path = process.env.CLOSEDBOT_BRIDGE;
const token = process.env.CLOSEDBOT_BRIDGE_TOKEN;
const key = process.env.CLOSEDBOT_BRIDGE_KEY;
if (!path || !token || !key) {
  process.stderr.write("Faltan los datos del puente de ClosedBot.\n");
  process.exit(1);
}

type Reply = Record<string, unknown>;
const pending = new Map<number, (reply: Reply) => void>();
let nextId = 1;
let buffer = "";
let closed = false;

const socket = connect(path);
socket.setEncoding("utf8");
socket.on("data", (chunk: string) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (!line) continue;
    try {
      const reply = JSON.parse(line) as Reply;
      const resolve = pending.get(Number(reply.id));
      pending.delete(Number(reply.id));
      resolve?.(reply);
    } catch {
      // Línea rota: se ignora.
    }
  }
});
const fail = (message: string) => {
  closed = true;
  for (const resolve of pending.values()) resolve({ error: message });
  pending.clear();
};
/** Sin ClosedBot o sin el agente, el puente no sirve: se cierra para no quedar colgado. */
const quit = () => {
  socket.destroy();
  setTimeout(() => process.exit(0), 50).unref();
};
socket.on("error", (error) => fail(`No pude hablar con ClosedBot: ${error.message}`));
socket.on("close", () => {
  fail("ClosedBot cerró la conexión.");
  quit();
});
// El agente que lo abrió terminó (su lado de la tubería se cerró).
process.stdin.on("end", quit);
process.stdin.on("close", quit);

function ask(payload: Reply): Promise<Reply> {
  if (closed) return Promise.resolve({ error: "ClosedBot no está disponible." });
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    socket.write(`${JSON.stringify({ id, token, key, ...payload })}\n`);
  });
}

const server = new Server({ name: "closedbot", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const reply = await ask({ type: "tools" });
  return { tools: Array.isArray(reply.tools) ? (reply.tools as Array<{ name: string; description: string; inputSchema: { type: "object" } }>) : [] };
});

server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  const reply = await ask({ type: "call", tool: request.params.name, arguments: request.params.arguments ?? {} });
  if (typeof reply.error === "string") return { content: [{ type: "text", text: reply.error }], isError: true };
  const result = reply.result as CallToolResult | undefined;
  return result ?? { content: [{ type: "text", text: "Sin respuesta de ClosedBot." }], isError: true };
});

server.onclose = quit;

await server.connect(new StdioServerTransport());
