#!/usr/bin/env node
// App-server de Codex falso para pruebas: habla el mismo JSON-RPC por líneas.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.env.FAKE_LOG;
const pending = new Map();
let nextServerId = 1000;
let turnCounter = 0;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const record = (message) => {
  if (log) appendFileSync(log, `${JSON.stringify(message)}\n`);
};
const callClient = (method, params) =>
  new Promise((resolve) => {
    const id = nextServerId++;
    pending.set(id, resolve);
    send({ id, method, params });
  });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTurn(threadId, turnId, text) {
  send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress" } } });
  if (text.includes("@morir")) {
    await sleep(20);
    process.exit(3);
  }
  const parts = ["Hola ", "desde ", "Codex falso."];
  if (text.includes("@herramienta")) {
    const result = await callClient("item/tool/call", {
      threadId,
      turnId,
      callId: "call-1",
      namespace: "cuadrilla",
      tool: "list_agents",
      arguments: {},
    });
    const agents = JSON.parse(result.contentItems[0].text).agentes;
    parts.push(` Equipo: ${agents.map((agent) => agent.nombre).join(", ")}.`);
  }
  if (text.includes("@aprobacion")) {
    const answer = await callClient("item/commandExecution/requestApproval", { threadId, turnId, itemId: "cmd-1", command: "rm -rf /" });
    parts.push(` Decisión: ${answer.decision}.`);
  }
  const itemId = `msg-${turnId}`;
  for (const delta of parts) send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId, delta } });
  send({ method: "item/completed", params: { threadId, turnId, item: { id: "cmd-2", type: "commandExecution", command: "ls", exitCode: 0 } } });
  send({ method: "item/completed", params: { threadId, turnId, item: { id: itemId, type: "agentMessage", text: parts.join("") } } });
  send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  record(message);
  if (message.id !== undefined && message.method === undefined) {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve?.(message.result ?? message.error);
    return;
  }
  if (message.id === undefined) return; // notificación (initialized)
  const reply = (result) => send({ id: message.id, result });
  switch (message.method) {
    case "initialize":
      return reply({ userAgent: "fake/1.0" });
    case "model/list":
      return reply({
        data: [
          { model: "gpt-fake", displayName: "GPT Falso", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }] },
          { model: "oculto", displayName: "Oculto", hidden: true },
        ],
      });
    case "thread/start":
      return reply({ thread: { id: "thr-1" } });
    case "thread/resume":
      return reply({ thread: { id: message.params.threadId } });
    case "turn/start": {
      const turnId = `turn-${++turnCounter}`;
      reply({ turn: { id: turnId, status: "inProgress" } });
      const text = message.params.input.map((item) => item.text).join("\n");
      void runTurn(message.params.threadId, turnId, text);
      return;
    }
    case "turn/interrupt":
      return reply({});
    default:
      return send({ id: message.id, error: { code: -32601, message: `no implementado: ${message.method}` } });
  }
});
