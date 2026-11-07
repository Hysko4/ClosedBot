import assert from "node:assert/strict";
import { test } from "node:test";
import { costOf, normalizeModel, pickPrices, priceFor } from "../src/prices.js";
import { DemoAgentClient } from "../src/providers/demo.js";
import { TOKEN_READINGS_META } from "../src/service.js";
import { localDay, rangeStart, readingIncrement, spendReport } from "../src/spend.js";
import { createHarness, waitFor } from "./helpers.js";

const LITELLM = {
  sample_spec: { input_cost_per_token: 0 },
  "gpt-5.5": { litellm_provider: "openai", mode: "chat", input_cost_per_token: 5e-6, output_cost_per_token: 3e-5, cache_read_input_token_cost: 5e-7 },
  "xai/grok-4.3": { litellm_provider: "xai", mode: "chat", input_cost_per_token: 1.25e-6, output_cost_per_token: 2.5e-6, cache_read_input_token_cost: 2e-7 },
  "gemini/gemini-3.1-pro-preview": { litellm_provider: "gemini", mode: "chat", input_cost_per_token: 2e-6, output_cost_per_token: 1.2e-5 },
  "vertex_ai/gemini-3.1-pro-preview": { litellm_provider: "vertex_ai-language-models", mode: "chat", input_cost_per_token: 9, output_cost_per_token: 9 },
  "text-embedding-3-large": { litellm_provider: "openai", mode: "embedding", input_cost_per_token: 1.3e-7, output_cost_per_token: 0 },
  "mistral/mistral-large": { litellm_provider: "mistral", mode: "chat", input_cost_per_token: 2e-6, output_cost_per_token: 6e-6 },
};

test("precios: solo los modelos de chat de las cuatro IA, por su nombre sin prefijo", () => {
  const prices = pickPrices(LITELLM);
  assert.deepEqual(Object.keys(prices).sort(), ["gemini-3.1-pro-preview", "gpt-5.5", "grok-4.3"]);
  // Vertex repite los de Gemini: manda el de Google.
  assert.equal(prices["gemini-3.1-pro-preview"]?.input, 2e-6);
  assert.equal(normalizeModel("claude-opus-4-8[1m]"), "claude-opus-4-8");
  assert.equal(normalizeModel("models/Gemini-3.1-Pro"), "gemini-3.1-pro");
  assert.equal(priceFor(prices, "gpt-5.5-2026-04-23")?.output, 3e-5, "sin la fecha de versión");
  assert.equal(priceFor(prices, "gemini-3.1-pro")?.input, 2e-6, "la versión «-preview»");
  assert.equal(priceFor(prices, "modelo-desconocido"), null);
  // Lo leído de caché va a su precio; sin precio de caché se cobra como la entrada.
  const gpt = prices["gpt-5.5"];
  assert.ok(gpt);
  assert.equal(Math.round(costOf({ input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 100_000 }, gpt) * 100) / 100, 8.5);
  assert.equal(costOf({ input: 0, cacheRead: 0, cacheWrite: 1_000_000, output: 0 }, gpt), 5);
});

test("gasto: de cada lectura acumulada se cuenta solo lo nuevo; si baja, no sirve para restar", () => {
  const base = { "claude-opus-5-5": { input: 100, cacheRead: 1_000, cacheWrite: 50, output: 40, costUsd: 0.5 } };
  const next = { "claude-opus-5-5": { input: 150, cacheRead: 1_600, cacheWrite: 50, output: 90, costUsd: 0.8 }, "claude-haiku-5-5": { input: 10, cacheRead: 0, cacheWrite: 0, output: 5, costUsd: 0.01 } };
  const increment = readingIncrement(next, base);
  assert.deepEqual(increment?.["claude-opus-5-5"], { input: 50, cacheRead: 600, cacheWrite: 0, output: 50, costUsd: 0.30000000000000004 });
  assert.deepEqual(increment?.["claude-haiku-5-5"], { input: 10, cacheRead: 0, cacheWrite: 0, output: 5, costUsd: 0.01 });
  assert.deepEqual(readingIncrement(next, next), {}, "sin novedades no cuenta nada");
  assert.equal(readingIncrement(base, next), null, "bajó: la sesión empezó de nuevo");
  assert.equal(readingIncrement({ "claude-haiku-5-5": next["claude-haiku-5-5"] }, next), null, "un modelo que desaparece también");
});

test("gasto: el informe suma por IA, modelo, agente y día, y pone precio a lo que no lo trae", () => {
  const today = localDay(Date.now());
  const yesterday = localDay(Date.now() - 86_400_000);
  const group = (day: string, provider: "claude" | "codex" | "grok", model: string, agentId: string, tokens: number, costUsd: number | null) => ({
    day,
    provider,
    model,
    agentId,
    agentName: agentId,
    input: tokens,
    cacheRead: tokens * 10,
    cacheWrite: 0,
    output: tokens / 10,
    costUsd,
    turns: 1,
  });
  const report = spendReport(
    [
      group(yesterday, "claude", "claude-opus-5-5", "dev", 10_000, 1.5),
      group(today, "claude", "claude-opus-5-5", "dev", 10_000, 0.5),
      group(today, "codex", "gpt-5.5", "arte", 100_000, null),
      group(today, "grok", "grok-sin-precio", "qa", 1_000, null),
    ],
    {
      from: yesterday,
      to: today,
      prices: pickPrices(LITELLM),
      pricesAt: 1,
      providerLabel: (provider) => ({ claude: "Claude", codex: "Codex", grok: "Grok" })[provider as string] ?? provider,
      modelLabel: (_provider, model) => (model === "claude-opus-5-5" ? "Claude Opus 5.5" : model),
      agentName: (id) => (id === "dev" ? "4FTER Dev" : null),
    },
  );
  // Codex: 100.000 de entrada a 5 USD/M + 1.000.000 de caché a 0,5 + 10.000 de salida a 30 = 1,3 USD.
  assert.equal(Math.round(report.totalUsd * 100) / 100, 3.3);
  assert.deepEqual(
    report.providers.map((row) => [row.provider, row.usd === null ? null : Math.round(row.usd * 100) / 100]),
    [
      ["claude", 2],
      ["codex", 1.3],
      ["grok", null],
    ],
  );
  assert.equal(report.unpricedTokens, 1_100, "lo de Grok queda sin precio");
  assert.equal(report.agents, 3);
  assert.equal(report.days.length, 2);
  assert.equal(Math.round((report.days[1]?.usd ?? 0) * 100) / 100, 1.8);
  assert.equal(report.byModel[0]?.label, "Claude Opus 5.5");
  assert.deepEqual(report.byAgent.map((row) => row.label), ["4FTER Dev", "arte", "qa"], "nombre actual o el que tenía");
  assert.equal(report.byDay[0]?.key, today, "los días, del más nuevo al más viejo");
  assert.equal(report.totals.withCacheReads - report.totals.withoutCacheReads, report.totals.cacheRead);
  assert.equal(rangeStart(0), null);
  assert.equal(rangeStart(1), today);
});

/** Codex informa el total del hilo con `thread/tokenUsage/updated` al terminar cada respuesta (y no como la demo). */
class CodexLike extends DemoAgentClient {
  total = 0;
  override emit(...args: unknown[]): boolean {
    const [event, payload] = args as [string, { method?: string } | undefined];
    if (event === "notification" && payload?.method === "closedbot/tokenUsage") return false;
    return (super.emit as (...rest: unknown[]) => boolean)(...args);
  }
  constructor() {
    super({ wordDelayMs: 0 });
    this.on("notification", (notification) => {
      if (notification.method !== "turn/completed") return;
      const threadId = (notification.params as { threadId: string }).threadId;
      this.total += 1_000;
      this.emit("notification", {
        method: "thread/tokenUsage/updated",
        params: {
          threadId,
          turnId: "t",
          tokenUsage: {
            total: { totalTokens: this.total + 100, inputTokens: this.total, cachedInputTokens: this.total / 2, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0 },
            last: { totalTokens: 1_100, inputTokens: 1_000, cachedInputTokens: 500, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0 },
            modelContextWindow: 400_000,
          },
        },
      });
    });
  }
}

test("gasto: cada turno se guarda una vez, también de Codex, y «Uso» lo muestra con precio", async () => {
  const h = await createHarness({
    createClient: (provider) => (provider === "codex" ? new CodexLike() : new DemoAgentClient({ wordDelayMs: 0 })),
    fetchPrices: async () => pickPrices(LITELLM),
  });
  try {
    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    const cata = h.service.createAgent({ name: "Cata", provider: "codex", model: "gpt-5.5" });
    for (const text of ["uno", "dos"]) {
      const { message } = h.service.sendUserMessage(ana.id, text);
      await waitFor(() => h.store.getMessage(message.id)?.status === "completed", 5_000, "respuesta de Ana");
      const sent = h.service.sendUserMessage(cata.id, text);
      await waitFor(() => h.store.getMessage(sent.message.id)?.status === "completed", 5_000, "respuesta de Cata");
    }
    await waitFor(() => h.store.tokenUsageGroups(null).reduce((sum, group) => sum + group.turns, 0) >= 4, 5_000, "cuatro turnos contados");
    const groups = h.store.tokenUsageGroups(null);
    const demo = groups.find((group) => group.provider === "demo");
    const codex = groups.find((group) => group.provider === "codex");
    // La demo suma 1.000 de caché por turno: dos turnos, 2.000 (no 3.000, que sería contar dos veces el primero).
    assert.equal(demo?.cacheRead, 2_000);
    assert.equal(demo?.turns, 2);
    // Codex: total 2.000 de entrada con 1.000 de caché → 1.000 sin caché, 1.000 de caché; salida 100 (el total no se repite).
    assert.deepEqual([codex?.input, codex?.cacheRead, codex?.output, codex?.model], [1_000, 1_000, 100, "gpt-5.5"]);
    assert.ok(h.events.some((event) => event.type === "spend"), "avisa a la ventana «Uso»");
    const saved = JSON.parse(h.store.getMeta(TOKEN_READINGS_META) ?? "{}") as Record<string, unknown>;
    assert.equal(Object.keys(saved).length, 2, "guarda la última lectura de cada sesión");
    const report = await h.service.spendReport(30);
    const codexRow = report.providers.find((row) => row.provider === "codex");
    assert.ok(codexRow?.usd && codexRow.usd > 0, "Codex con precio de la lista");
    assert.equal(report.providers.find((row) => row.provider === "demo")?.usd, null, "la demo no tiene precio");
    assert.equal(report.agents, 2);
  } finally {
    await h.close();
  }
});
