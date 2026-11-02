import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CodexAppServerClient } from "../src/providers/codex.js";
import { DemoAgentClient } from "../src/providers/demo.js";
import { createHarness, tempDir, waitFor } from "./helpers.js";

const fixture = fileURLToPath(new URL("../../test/fixtures/fake-app-server.mjs", import.meta.url));

function readLog(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function codexHarness() {
  chmodSync(fixture, 0o755);
  const temp = tempDir("cuadrilla-codex-");
  const log = join(temp.path, "requests.jsonl");
  // En Windows un script .mjs no se ejecuta solo: se envuelve en un .cmd que llama a node.
  let executable = fixture;
  if (process.platform === "win32") {
    executable = join(temp.path, "fake-codex.cmd");
    writeFileSync(executable, `@"${process.execPath}" "${fixture}" %*\r\n`);
  }
  const h = await createHarness({
    createClient: (provider) =>
      provider === "codex"
        ? new CodexAppServerClient({ executable, env: { ...process.env, FAKE_LOG: log } })
        : new DemoAgentClient({ wordDelayMs: 0 }),
  });
  return {
    h,
    log,
    close: async () => {
      await h.close();
      temp.cleanup();
    },
  };
}

test("Codex: hilo, turno, herramientas del equipo y aprobaciones", async () => {
  const { h, log, close } = await codexHarness();
  try {
    h.service.createAgent({ name: "Ana", provider: "demo" });
    const codi = h.service.createAgent({ name: "Codi", provider: "codex", model: "gpt-fake", effort: "high" });
    const { message } = h.service.sendUserMessage(codi.id, "hola @herramienta @aprobacion");
    await waitFor(() => h.store.getMessage(message.id)?.status === "completed", 8_000, "turno de Codex");

    const messages = h.service.listMessages(codi.id);
    const reply = messages.find((item) => item.role === "assistant");
    assert.equal(reply?.text, "Hola desde Codex falso. Equipo: Ana, Codi. Decisión: decline.");
    assert.ok(messages.some((item) => item.role === "activity" && item.text === "Ejecutó: ls (salida 0)"));

    const requests = readLog(log);
    const initialize = requests.find((item) => item.method === "initialize") as { params: { capabilities: { experimentalApi: boolean } } };
    assert.equal(initialize.params.capabilities.experimentalApi, true);
    const start = requests.find((item) => item.method === "thread/start") as { params: Record<string, unknown> };
    assert.equal(start.params.sandbox, "workspace-write");
    assert.equal(start.params.approvalPolicy, "never");
    assert.equal((start.params.dynamicTools as Array<{ name: string }>)[0]?.name, "cuadrilla");
    assert.equal(start.params.effort, undefined, "Codex recibe el esfuerzo por turno, no al crear el hilo");
    const turn = requests.find((item) => item.method === "turn/start") as { params: Record<string, unknown> };
    assert.deepEqual((turn.params.input as Array<Record<string, unknown>>)[0]?.text_elements, []);
    assert.equal(turn.params.model, "gpt-fake");
    assert.equal(turn.params.effort, "high");
    const policy = turn.params.sandboxPolicy as { type: string; writableRoots: string[]; networkAccess: boolean };
    assert.equal(policy.type, "workspaceWrite");
    assert.ok(policy.writableRoots.includes(codi.workspace));
    assert.ok(requests.some((item) => item.method === "initialized" && item.id === undefined), "envía la notificación initialized");

    const models = await h.service.listModels("codex");
    assert.deepEqual(models, [{ model: "gpt-fake", displayName: "GPT Falso", isDefault: true, efforts: ["low", "high"] }]);
  } finally {
    await close();
  }
});

test("Codex: si el proceso muere, el turno falla y el siguiente mensaje reanuda el hilo", async () => {
  const { h, log, close } = await codexHarness();
  try {
    const codi = h.service.createAgent({ name: "Codi", provider: "codex" });
    const first = h.service.sendUserMessage(codi.id, "hola");
    await waitFor(() => h.store.getMessage(first.message.id)?.status === "completed", 8_000, "primer turno");
    const crash = h.service.sendUserMessage(codi.id, "@morir");
    await waitFor(() => h.store.getMessage(crash.message.id)?.status === "failed", 8_000, "turno fallido");
    assert.ok(h.service.listMessages(codi.id).some((item) => item.role === "notice" && /se detuvo/.test(item.text)));
    const again = h.service.sendUserMessage(codi.id, "sigo aquí");
    await waitFor(() => h.store.getMessage(again.message.id)?.status === "completed", 8_000, "turno tras reinicio");
    const resumed = readLog(log).filter((item) => item.method === "thread/resume") as Array<{ params: { threadId: string } }>;
    assert.equal(resumed.at(-1)?.params.threadId, "thr-1");
  } finally {
    await close();
  }
});
