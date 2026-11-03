// Uso del plan de Grok y de Gemini (Antigravity), en el mismo formato que `account/rateLimits/read`
// del adaptador de Claude: { available, plan, windows: [{ id, label, usedPercent, resetsAt }] }.
// Escrito para ClosedBot a partir de lo que responden los programas oficiales.

import { getRecord, isRecord } from "./protocol.js";

export interface UsageWindowData {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
}

export interface RateLimitsData {
  available: boolean;
  plan: string | null;
  windows: UsageWindowData[];
}

const NONE: RateLimitsData = { available: false, plan: null, windows: [] };
const WEEK_MINUTES = 7 * 24 * 60;

/**
 * Grok: respuesta de `_x.ai/billing`. `config.creditUsagePercent` es el crédito usado en el período
 * (si falta, es 0: así omite los ceros su JSON) y `config.currentPeriod` dice cuándo empieza y termina.
 */
export function grokUsage(response: unknown): RateLimitsData {
  const config = getRecord(response, "config");
  if (!config) return NONE;
  const period = getRecord(config, "currentPeriod");
  const start = toMillis(period?.start ?? config.billingPeriodStart);
  const end = toMillis(period?.end ?? config.billingPeriodEnd);
  const type = String(period?.type ?? period?.periodType ?? "");
  let percent = numberOf(config.creditUsagePercent);
  if (percent === null) {
    const limit = moneyOf(config.monthlyLimit);
    const used = moneyOf(config.used);
    percent = limit && used !== null ? (used / limit) * 100 : 0;
  }
  const minutes = start !== null && end !== null && end > start ? Math.round((end - start) / 60_000) : null;
  return {
    available: true,
    plan: grokPlan(isRecord(response) ? (response.subscription_tier ?? response.subscriptionTier) : null),
    windows: [{ id: "credit", label: periodLabel(type, minutes), usedPercent: clampPercent(percent), resetsAt: end === null ? null : new Date(end).toISOString() }],
  };
}

/** «USAGE_PERIOD_TYPE_WEEKLY» o 7 días → «Semanal». */
function periodLabel(type: string, minutes: number | null): string {
  if (/week/i.test(type) || (minutes !== null && Math.abs(minutes - WEEK_MINUTES) <= 60)) return "Semanal";
  if (/month/i.test(type) || (minutes !== null && minutes >= 27 * 24 * 60)) return "Mensual";
  if (/day|daily/i.test(type) || (minutes !== null && Math.abs(minutes - 24 * 60) <= 60)) return "Diario";
  if (minutes !== null && minutes >= 24 * 60) return `${Math.round(minutes / (24 * 60))} días`;
  if (minutes !== null && minutes > 0) return `${Math.round(minutes / 60)} horas`;
  return "Crédito";
}

/** «SUBSCRIPTION_TIER_SUPER_GROK_HEAVY» → «SuperGrok Heavy»; un nombre ya legible queda igual. */
function grokPlan(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim();
  if (!/^[A-Z0-9_]+$/.test(raw)) return raw;
  const words = raw.replace(/^(SUBSCRIPTION_)?TIER_/, "").split("_").filter(Boolean);
  if (!words.length || words.join("_") === "UNSPECIFIED" || words.join("_") === "NONE") return null;
  return words
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(" ")
    .replace(/\bSuper Grok\b/, "SuperGrok");
}

/**
 * Gemini por Antigravity: la respuesta de «/usage» (Antigravity la contesta sin pasar por el modelo).
 * Bajo «Quota Limits» viene cada grupo de modelos con sus ventanas, así:
 *   - **Gemini Models**
 *     - **Weekly Limit Remaining:** 96% remaining (resets Nov 09, 2026, 02:22 UTC)
 *     - **Five Hour Limit Remaining:** 100% remaining (resets Nov 03, 2026, 21:00 UTC)
 *   - **Gemini 4 Argon**
 *     - **Gemini 4 Argon Weekly Limit:** 27% remaining (resets Nov 08, 2026, 18:22 UTC)
 * Se muestran los grupos de Gemini: el principal como «Semanal» y «5 horas», y los demás con su nombre
 * («Semanal · Gemini 4 Argon»). Los de otros modelos (Claude y GPT dentro de Antigravity) no.
 */
export function antigravityUsage(text: string): RateLimitsData {
  const heading = /^#{1,6}\s*Quota Limits\s*$/im.exec(text);
  if (!heading) return NONE;
  const groups: Array<{ name: string; windows: Array<{ name: string; remaining: number; resetsAt: number | null }> }> = [];
  for (const line of text.slice(heading.index + heading[0].length).split(/\r?\n/)) {
    if (/^#{1,6}\s/.test(line)) break;
    const group = /^[-*]\s+\*\*(.+?)\*\*\s*:?\s*$/.exec(line);
    if (group) {
      groups.push({ name: (group[1] ?? "").replace(/:$/, "").trim(), windows: [] });
      continue;
    }
    const window = /^\s+[-*]\s+\*\*(.+?):?\*\*\s*:?\s*(\d+(?:[.,]\d+)?)\s*%\s*remaining(?:\s*\(\s*resets\s+([^)]+)\))?/i.exec(line);
    const current = groups[groups.length - 1];
    if (!window || !current) continue;
    current.windows.push({
      name: (window[1] ?? "").trim(),
      remaining: Number((window[2] ?? "").replace(",", ".")),
      resetsAt: window[3] ? resetTime(window[3]) : null,
    });
  }
  const gemini = groups.filter((group) => /^gemini\b/i.test(group.name) && group.windows.length);
  const main = gemini.find((group) => /^gemini models?$/i.test(group.name)) ?? gemini[0];
  if (!main) return NONE;
  const windows: UsageWindowData[] = [];
  for (const group of [main, ...gemini.filter((item) => item !== main)]) {
    for (const window of group.windows) {
      const kind = windowKind(window.name);
      const suffix = group === main ? "" : ` · ${group.name}`;
      windows.push({
        id: group === main ? (kind?.id ?? `gemini:${window.name}`) : `model:${group.name}:${kind?.id ?? window.name}`,
        label: kind ? `${kind.label}${suffix}` : `${window.name}${group === main ? "" : ` (${group.name})`}`,
        usedPercent: clampPercent(100 - window.remaining),
        resetsAt: window.resetsAt === null ? null : new Date(window.resetsAt).toISOString(),
      });
    }
  }
  return { available: windows.length > 0, plan: null, windows };
}

function windowKind(name: string): { id: string; label: string } | null {
  if (/five[\s-]*hours?|\b5[\s-]*h(ours?)?\b/i.test(name)) return { id: "five_hour", label: "5 horas" };
  if (/week/i.test(name)) return { id: "seven_day", label: "Semanal" };
  if (/daily|\bday\b/i.test(name)) return { id: "daily", label: "Diario" };
  if (/month/i.test(name)) return { id: "monthly", label: "Mensual" };
  return null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** «Nov 09, 2026, 02:22 UTC» → milisegundos (siempre en UTC). */
function resetTime(value: string): number | null {
  const match = /^([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2}),?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})/.exec(value.trim());
  if (match) {
    const month = MONTHS.indexOf((match[1] ?? "").toLowerCase());
    if (month >= 0) return Date.UTC(Number(match[3]), month, Number(match[2]), Number(match[4]), Number(match[5]));
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function toMillis(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e11 ? value * 1000 : value;
  if (typeof value !== "string" || !value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function numberOf(value: unknown): number | null {
  const number = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

/** Montos de xAI: un número o { val } (en centavos; aquí solo importa la proporción). */
function moneyOf(value: unknown): number | null {
  return numberOf(isRecord(value) ? value.val : value);
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}
