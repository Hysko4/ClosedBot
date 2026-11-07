// Lo que gastan los agentes: de las lecturas que dan los programas a lo que muestra «Uso»
// (USD estimado con precios de API, tokens por tipo, coste diario y desglose por modelo, agente y día).

import type { TokenCounts, TokenUsageGroup } from "./db.js";
import { costOf, type ModelPrice, priceFor } from "./prices.js";
import type { ProviderId } from "./providers/client.js";

/** Tokens de un modelo y, si el programa lo calcula, su costo en USD. */
export interface ModelReading extends TokenCounts {
  costUsd: number | null;
}

/** Lo acumulado en una sesión, por modelo (Claude y Codex lo dan así: el total desde que empezó la sesión). */
export type Reading = Record<string, ModelReading>;

const ZERO: ModelReading = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costUsd: 0 };

/**
 * Lo nuevo desde la lectura anterior de la misma sesión. null si algo bajó: la sesión empezó de nuevo
 * (o se reanudó sin su total) y la lectura ya no sirve para restar.
 */
export function readingIncrement(current: Reading, previous: Reading): Reading | null {
  for (const model of Object.keys(previous)) if (!(model in current)) return null;
  const increment: Reading = {};
  for (const [model, now] of Object.entries(current)) {
    const before = previous[model] ?? ZERO;
    const counts = {
      input: now.input - before.input,
      cacheRead: now.cacheRead - before.cacheRead,
      cacheWrite: now.cacheWrite - before.cacheWrite,
      output: now.output - before.output,
    };
    if (counts.input < 0 || counts.cacheRead < 0 || counts.cacheWrite < 0 || counts.output < 0) return null;
    let costUsd: number | null = null;
    if (now.costUsd !== null) {
      costUsd = now.costUsd - (before.costUsd ?? 0);
      if (costUsd < -1e-9) return null;
      costUsd = Math.max(0, costUsd);
    }
    if (!tokensOf(counts) && !costUsd) continue;
    increment[model] = { ...counts, costUsd };
  }
  return increment;
}

/** Una lectura sin nada (los resultados de un arranque fallido llegan en cero): no se usa ni se guarda. */
export function emptyReading(reading: Reading): boolean {
  return Object.values(reading).every((entry) => !tokensOf(entry) && !entry.costUsd);
}

/** Los tokens que cuenta OpenBot como «sin lecturas de caché»: entrada, escritura en caché y salida. */
export function tokensOf(counts: TokenCounts): number {
  return counts.input + counts.cacheWrite + counts.output;
}

export interface SpendRow {
  key: string;
  label: string;
  provider: ProviderId | null;
  /** null: no hay precio para esos tokens. */
  usd: number | null;
  /** Parte del costo conocido (0 a 1). */
  share: number;
  tokens: number;
}

export interface SpendReport {
  /** Primer día del período (AAAA-MM-DD); null = desde el principio. */
  from: string | null;
  to: string;
  totalUsd: number;
  /** Tokens que no se pudieron pasar a USD (modelo sin precio en la lista). */
  unpricedTokens: number;
  agents: number;
  turns: number;
  providers: Array<SpendRow & { provider: ProviderId }>;
  /** Cada día del período, con lo de cada proveedor (para el gráfico). */
  days: Array<{ day: string; usd: number; byProvider: Partial<Record<ProviderId, number>> }>;
  totals: TokenCounts & { withoutCacheReads: number; withCacheReads: number };
  byModel: SpendRow[];
  byAgent: SpendRow[];
  byDay: SpendRow[];
  /** Cuándo se bajó la lista de precios; null si todavía no se tiene. */
  pricesAt: number | null;
}

export interface SpendOptions {
  from: string | null;
  to: string;
  prices: Record<string, ModelPrice>;
  pricesAt: number | null;
  /** Nombre de cada proveedor («Claude», «Codex»…). */
  providerLabel: (provider: ProviderId) => string;
  /** Nombre del modelo para mostrar («Claude Opus 5.5»). */
  modelLabel: (provider: ProviderId, model: string) => string;
  /** Nombre actual del agente; si ya no existe, se usa el que tenía. */
  agentName: (agentId: string) => string | null;
}

/** Arma el informe de «Uso» con las sumas guardadas. */
export function spendReport(groups: TokenUsageGroup[], options: SpendOptions): SpendReport {
  const providers = new Map<ProviderId, Bucket>();
  const models = new Map<string, Bucket>();
  const agents = new Map<string, Bucket>();
  const days = new Map<string, Bucket & { byProvider: Partial<Record<ProviderId, number>> }>();
  const totals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let turns = 0;
  for (const group of groups) {
    const price = group.costUsd === null ? priceFor(options.prices, group.model) : null;
    const usd = group.costUsd ?? (price ? costOf(group, price) : null);
    const tokens = tokensOf(group);
    turns += group.turns;
    totals.input += group.input;
    totals.cacheRead += group.cacheRead;
    totals.cacheWrite += group.cacheWrite;
    totals.output += group.output;
    add(providers, group.provider, { label: options.providerLabel(group.provider), provider: group.provider }, usd, tokens);
    add(models, `${group.provider}:${group.model}`, { label: options.modelLabel(group.provider, group.model), provider: group.provider }, usd, tokens);
    add(agents, group.agentId, { label: options.agentName(group.agentId) ?? group.agentName, provider: null }, usd, tokens);
    const day = add(days, group.day, { label: group.day, provider: null, byProvider: {} }, usd, tokens);
    if (usd !== null) day.byProvider[group.provider] = (day.byProvider[group.provider] ?? 0) + usd;
  }
  const totalUsd = sum([...providers.values()].map((bucket) => bucket.usd ?? 0));
  const unpricedTokens = sum([...providers.values()].map((bucket) => bucket.unpricedTokens));
  const first = options.from ?? [...days.keys()].sort()[0] ?? options.to;
  const calendar = dayRange(first, options.to);
  return {
    from: options.from,
    to: options.to,
    totalUsd,
    unpricedTokens,
    agents: agents.size,
    turns,
    providers: rows(providers, totalUsd) as Array<SpendRow & { provider: ProviderId }>,
    days: calendar.map((day) => ({ day, usd: days.get(day)?.usd ?? 0, byProvider: days.get(day)?.byProvider ?? {} })),
    totals: { ...totals, withoutCacheReads: tokensOf(totals), withCacheReads: tokensOf(totals) + totals.cacheRead },
    byModel: rows(models, totalUsd),
    byAgent: rows(agents, totalUsd),
    byDay: rows(days, totalUsd).sort((a, b) => b.key.localeCompare(a.key)),
    pricesAt: options.pricesAt,
  };
}

/** El día local (AAAA-MM-DD) de una fecha. */
export function localDay(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** El día `days - 1` antes de hoy (para «Hoy», 7 o 30 días); null = todo. */
export function rangeStart(days: number, now = Date.now()): string | null {
  if (!Number.isFinite(days) || days <= 0) return null;
  const date = new Date(now);
  date.setDate(date.getDate() - (Math.floor(days) - 1));
  return localDay(date.getTime());
}

interface Bucket {
  label: string;
  provider: ProviderId | null;
  usd: number | null;
  tokens: number;
  unpricedTokens: number;
}

function add<T extends Bucket>(map: Map<string, T>, key: string, base: Omit<T, "usd" | "tokens" | "unpricedTokens">, usd: number | null, tokens: number): T {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = { ...base, usd: null, tokens: 0, unpricedTokens: 0 } as T;
    map.set(key, bucket);
  }
  bucket.tokens += tokens;
  if (usd === null) bucket.unpricedTokens += tokens;
  else bucket.usd = (bucket.usd ?? 0) + usd;
  return bucket;
}

function rows(map: Map<string, Bucket>, totalUsd: number): SpendRow[] {
  return [...map]
    .map(([key, bucket]) => ({
      key,
      label: bucket.label,
      provider: bucket.provider,
      usd: bucket.usd,
      share: totalUsd > 0 && bucket.usd ? bucket.usd / totalUsd : 0,
      tokens: bucket.tokens,
    }))
    .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || b.tokens - a.tokens);
}

function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  const start = new Date(`${from}T12:00:00`);
  const end = new Date(`${to}T12:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [to];
  // Como mucho un año de barras: «Todo» con más historia muestra el último año.
  const first = new Date(Math.max(start.getTime(), end.getTime() - 365 * 86_400_000));
  for (const date = first; date <= end; date.setDate(date.getDate() + 1)) out.push(localDay(date.getTime()));
  return out;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
