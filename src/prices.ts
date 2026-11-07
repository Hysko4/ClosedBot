// Precios de las API (USD por token) para estimar lo que gasta un agente cuyo programa no lo calcula
// (Codex, Gemini y Grok dan tokens; Claude da su propio costo). Salen de la lista pública de LiteLLM
// (licencia MIT): se baja una vez al día y solo se guardan los modelos de Anthropic, OpenAI, Google y xAI.

import type { TokenCounts } from "./db.js";

export const PRICES_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** USD por token. Sin precio de caché: se cobra como la entrada. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
}

/** Proveedores de la lista que interesan, del que manda al que se usa si falta (Vertex repite los de Gemini). */
const SOURCES = ["anthropic", "openai", "xai", "gemini", "vertex_ai-language-models"];

/** De la lista completa de LiteLLM, los modelos de chat de esos proveedores, por su nombre sin prefijo. */
export function pickPrices(data: unknown): Record<string, ModelPrice> {
  const picked = new Map<string, { rank: number; price: ModelPrice }>();
  if (!isRecord(data)) return {};
  for (const [key, value] of Object.entries(data)) {
    if (!isRecord(value)) continue;
    const rank = SOURCES.indexOf(String(value.litellm_provider ?? ""));
    if (rank < 0) continue;
    if (value.mode !== undefined && value.mode !== "chat" && value.mode !== "responses") continue;
    const input = perToken(value.input_cost_per_token);
    const output = perToken(value.output_cost_per_token);
    if (input === null || output === null) continue;
    const name = normalizeModel(key.slice(key.lastIndexOf("/") + 1));
    if (!name) continue;
    const previous = picked.get(name);
    if (previous && previous.rank <= rank) continue;
    picked.set(name, {
      rank,
      price: { input, output, cacheRead: perToken(value.cache_read_input_token_cost), cacheWrite: perToken(value.cache_creation_input_token_cost) },
    });
  }
  return Object.fromEntries([...picked].map(([name, entry]) => [name, entry.price]));
}

/** «claude-opus-4-8[1m]», «models/gemini-3.1-pro», «OpenAI/GPT-5.5» → el nombre con que se busca el precio. */
export function normalizeModel(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/^(models|openai|anthropic|xai|gemini|google)\//, "")
    .trim();
}

/** El precio de un modelo: su nombre exacto, sin la fecha de versión, o la versión «-preview» (Gemini). */
export function priceFor(prices: Record<string, ModelPrice>, model: string): ModelPrice | null {
  const name = normalizeModel(model);
  if (!name) return null;
  const undated = name.replace(/-(\d{8}|\d{4}-\d{2}-\d{2}|\d{4})$/, "");
  for (const candidate of [name, undated, `${name}-preview`, `${undated}-preview`, `${name}-latest`]) {
    const price = prices[candidate];
    if (price) return price;
  }
  return null;
}

/** Lo que costarían esos tokens con la API (USD). */
export function costOf(counts: TokenCounts, price: ModelPrice): number {
  return (
    counts.input * price.input +
    counts.cacheRead * (price.cacheRead ?? price.input) +
    counts.cacheWrite * (price.cacheWrite ?? price.input) +
    counts.output * price.output
  );
}

/** Baja la lista y deja solo lo que interesa. */
export async function downloadPrices(fetcher: typeof fetch = fetch, timeoutMs = 30_000): Promise<Record<string, ModelPrice>> {
  const response = await fetcher(PRICES_URL, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`La lista de precios respondió ${response.status}.`);
  const prices = pickPrices(await response.json());
  if (!Object.keys(prices).length) throw new Error("La lista de precios llegó vacía.");
  return prices;
}

function perToken(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
