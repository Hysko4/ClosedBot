import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaudeAgentClient } from "../src/providers/claude.js";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLocalModelConfig } from "../src/providers/local.js";
import { LocalModelRuntime } from "../src/providers/local.js";
import { localContextWindows } from "../src/providers/local.js";
import { createServer } from "node:http";
import { DemoAgentClient } from "../src/providers/demo.js";
import { createHarness, waitFor } from "./helpers.js";

test('local context limits follow each preset and trigger early SDK compaction', () => {
  const limits = localContextWindows('[q5]\nctx-size = 32768\n[q4]\nctx-size = 16384\n[gemma]\nctx-size = 8192\n');
  assert.deepEqual(limits, { q5: 32768, q4: 16384, gemma: 8192 });
  const client = new ClaudeAgentClient({ local: { model: 'q5', baseUrl: 'http://127.0.0.1:8089', configDir: 'C:/test', contextSize: 32768, contextSizes: limits }, env: { DISABLE_COMPACT: '1', DISABLE_AUTO_COMPACT: '1' } });
  for (const [model, size] of Object.entries(limits)) {
    const options = client.buildOptions(crypto.randomUUID(), { cwd: process.cwd(), model, developerInstructions: '', additionalDirectories: [], access: 'carpeta' }, false);
    assert.equal(options.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS, String(size));
    assert.equal(options.env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW, String(size));
    assert.equal(options.env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '70');
    assert.equal(options.env?.DISABLE_COMPACT, undefined);
    assert.equal(options.env?.DISABLE_AUTO_COMPACT, undefined);
  }
});

test("catálogo local ofrece ambos modelos y cada hilo conserva su modelo auxiliar", async () => {
  const local = { model: "qwen27b", baseUrl: "http://127.0.0.1:8089", configDir: "C:/local-test", models: [{ model: "qwen27b", displayName: "Qwen 27B" }, { model: "qwen9b", displayName: "Qwen 9B" }] };
  const client = new ClaudeAgentClient({ ...{ local } });
  const options = client.buildOptions(crypto.randomUUID(), { cwd: process.cwd(), model: "qwen9b", developerInstructions: "Prueba", additionalDirectories: [], access: "carpeta" }, false);
  assert.equal(options.model, "qwen9b");
  assert.equal(options.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL, "qwen9b");
  client.start();
  try {
    const list = await client.request<{ data: Array<{ model: string; isDefault: boolean }> }>("model/list", {});
    assert.deepEqual(list.data.map(m => m.model), ["qwen27b", "qwen9b"]);
    assert.equal(list.data[0]?.isDefault, true);
    assert.equal(list.data[1]?.isDefault, false);
  } finally { await client.stop(); }
});

test("configuración router conserva presets y catálogo y rechaza identificadores duplicados", () => {
  const dir = mkdtempSync(join(tmpdir(), "closedbot-router-"));
  try {
    const config = { model: "qwen27b", executable: process.execPath, modelsPresetPath: join(dir, "models.ini"), models: [{ model: "qwen27b", displayName: "27B" }, { model: "qwen9b", displayName: "9B" }] };
    writeFileSync(join(dir, "local-model.json"), JSON.stringify(config));
    const parsed = readLocalModelConfig(dir) as unknown as typeof config;
    assert.equal(parsed.modelsPresetPath, config.modelsPresetPath);
    assert.deepEqual(parsed.models, config.models);
    writeFileSync(join(dir, "local-model.json"), JSON.stringify({ ...config, models: [config.models[0], config.models[0]] }));
    assert.throws(() => readLocalModelConfig(dir), /duplicado/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Detener durante el inicio del proveedor impide ejecutar el mensaje después de cargar", async () => {
  let release!: () => void;
  const loading = new Promise<void>((resolve) => { release = resolve; });
  let starting = false;
  let turns = 0;
  class SlowStart extends DemoAgentClient {
    override async request<T>(method: string, params: unknown): Promise<T> {
      if (method === "thread/start") { starting = true; await loading; }
      if (method === "turn/start") turns += 1;
      return super.request<T>(method, params);
    }
  }
  const h = await createHarness({ createClient: () => new SlowStart({ wordDelayMs: 0 }) });
  try {
    const agent = h.service.createAgent({ name: "Qwen", provider: "local" });
    const { message } = h.service.sendUserMessage(agent.id, "No ejecutar si se detiene durante la carga.");
    await waitFor(() => starting);
    await h.service.interrupt(agent.id);
    release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(h.store.getMessage(message.id)?.status, "interrupted");
    assert.equal(turns, 0);
  } finally { release(); await h.close(); }
});

test("cerrar durante el sondeo inicial no inicia llama.cpp después de stop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "closedbot-local-stop-"));
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let received = false;
  const server = createServer(async (_req, res) => { received = true; await pending; res.writeHead(503); res.end('{}'); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const runtime = new LocalModelRuntime({ model: "qwen", baseUrl: `http://127.0.0.1:${address.port}`, configDir: join(dir, "state"), executable: process.execPath, modelPath: join(dir, "model.gguf"), contextSize: 4096, gpuLayers: 0 });
  const ready = runtime.ensureReady();
  try {
    await waitFor(() => received);
    await runtime.stop();
    release();
    await assert.rejects(ready, /cancelado|detenido/);
    assert.equal(existsSync(join(dir, "state")), false);
  } finally { release(); await ready.catch(() => undefined); await runtime.stop(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test("runtime local reconoce servidor ajeno y no lo detiene, y detecta modelo incorrecto", async () => {
  let model = "qwen-test";
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/health" ? { status: "ok" } : { data: [{ id: model }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const config = { model, baseUrl: `http://127.0.0.1:${address.port}`, configDir: tmpdir(), contextSize: 32768, gpuLayers: "auto" as const };
  const runtime = new LocalModelRuntime(config);
  try {
    await runtime.ensureReady();
    await runtime.stop();
    assert.equal((await fetch(`${config.baseUrl}/health`)).status, 200);
    model = "another-model";
    const incorrect = new LocalModelRuntime(config);
    await assert.rejects(incorrect.ensureReady(), /modelo configurado/);
    await incorrect.stop();
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("configuración local opcional conserva modelo y rechaza endpoints remotos o con credenciales", () => {
  const dir = mkdtempSync(join(tmpdir(), "closedbot-local-"));
  try {
    assert.equal(readLocalModelConfig(dir), null);
    const config = { model: "qwen-local", baseUrl: "http://127.0.0.1:8089" };
    writeFileSync(join(dir, "local-model.json"), JSON.stringify(config));
    assert.equal((readLocalModelConfig(dir) as typeof config).model, config.model);
    const chatTemplatePath = join(dir, "qwen.jinja");
    writeFileSync(join(dir, "local-model.json"), JSON.stringify({ ...config, chatTemplatePath }));
    assert.equal((readLocalModelConfig(dir) as unknown as { chatTemplatePath: string }).chatTemplatePath, chatTemplatePath);
    for (const baseUrl of ["https://example.com", "http://user:secret@127.0.0.1:8089", "http://127.0.0.1:8089/other", "http://127.0.0.1:8089?api_key=secret"]) {
      writeFileSync(join(dir, "local-model.json"), JSON.stringify({ ...config, baseUrl }));
      assert.throws(() => readLocalModelConfig(dir), /loopback|local|credenciales|ruta/i);
    }
    writeFileSync(join(dir, "local-model.json"), "{}");
    assert.throws(() => readLocalModelConfig(dir), /model/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SDK local conserva el modelo, herramientas y permisos sin usar configuración de nube", async () => {
  const local = { model: "qwen3.8-unleashed", baseUrl: "http://127.0.0.1:8089", configDir: "C:/local-test" };
  const client = new ClaudeAgentClient({ ...{ local }, env: { ANTHROPIC_API_KEY: "cloud-secret", CLAUDE_CODE_OAUTH_TOKEN: "cloud-oauth" } });
  const config = { cwd: process.cwd(), model: local.model, developerInstructions: "Responde en español.", additionalDirectories: [], access: "carpeta" as const };
  const options = client.buildOptions(crypto.randomUUID(), config, false);
  assert.equal(options.model, local.model);
  assert.equal(options.env?.ANTHROPIC_BASE_URL, local.baseUrl);
  assert.equal(options.env?.ANTHROPIC_API_KEY, "local");
  assert.equal(options.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.deepEqual(options.settingSources, []);
  assert.ok(options.mcpServers?.closedbot);
  assert.equal(options.permissionMode, "acceptEdits");
  assert.equal(typeof options.systemPrompt, "string");
  assert.equal(client.provider, "local");
  client.start();
  try {
    const list = await client.request<{ data: Array<{ model: string }> }>("model/list", {});
    assert.equal(list.data[0]?.model, local.model);
  } finally { await client.stop(); }
});
