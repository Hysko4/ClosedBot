// Modelos de un agente ACP tal como se eligen en ClosedBot.
//
// Los agentes informan sus modelos de dos maneras:
// - la lista vieja «models.availableModels» (Grok la usa, con los niveles de razonamiento de cada modelo);
// - las opciones de la sesión (configOptions), la forma nueva del protocolo: una de categoría «model» con los
//   modelos (pueden venir agrupados) y otra de categoría «thought_level» con los niveles.
// Antigravity (Gemini) manda las dos: en la vieja da cada nivel como otro modelo («Gemini 4 Argon (Medium)»), y en
// las opciones, los modelos («Gemini 4 Argon») y los niveles por separado. Como OpenBot, ClosedBot usa las opciones,
// así «Modelo» y «Esfuerzo» se eligen por separado. Lo guardado con la 0.6.1 (la variante como modelo) se reconoce
// y se traduce a modelo + nivel.

import { getArray, getRecord, getString, isRecord } from "./protocol.js";

export interface AcpModel {
  modelId: string;
  name: string;
  /** Niveles de razonamiento que acepta. */
  efforts: string[];
}

/** Un modelo para elegir en ClosedBot. */
export interface AcpModelChoice extends AcpModel {
  /** Nivel → id del modelo que lleva ese nivel, cuando el agente da cada nivel como otro modelo. */
  variants: Record<string, string>;
  /** El nivel se elige eligiendo su variante (no hay una opción de razonamiento para este modelo). */
  levelsAsModels: boolean;
}

/** Lo que el agente informó de sus modelos. */
export interface AgentModels {
  list: AcpModel[];
  listCurrent: string | null;
  /** Valores de la opción de la sesión de categoría «model». */
  options: AcpModel[];
  optionCurrent: string | null;
  /** Valores de la opción de la sesión de categoría «thought_level». */
  levels: string[];
}

export const NO_MODELS: AgentModels = { list: [], listCurrent: null, options: [], optionCurrent: null, levels: [] };

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

const EFFORT_WORDS: Record<string, string> = {
  none: "none",
  minimal: "minimal",
  minimum: "minimal",
  low: "low",
  medium: "medium",
  mid: "medium",
  high: "high",
  xhigh: "xhigh",
  "x high": "xhigh",
  "extra high": "xhigh",
  "very high": "xhigh",
  max: "max",
  maximum: "max",
};

/** «Gemini 4 Argon (Medium)» → { base: "Gemini 4 Argon", effort: "medium" }. Si lo del paréntesis no es un nivel, null. */
export function effortVariant(name: string): { base: string; effort: string } | null {
  const match = /^(.*\S)\s*\(([^()]+)\)\s*$/.exec(name);
  if (!match?.[1] || !match[2]) return null;
  const effort = EFFORT_WORDS[match[2].trim().toLowerCase().replace(/[-_\s]+/g, " ")];
  return effort ? { base: match[1], effort } : null;
}

/** Opción de la sesión de esa categoría («model», «thought_level»), si el agente la tiene. */
export function findOption(options: Record<string, unknown>[], category: "model" | "thought_level"): Record<string, unknown> | undefined {
  return (
    options.find((option) => getString(option, "category") === category) ??
    (category === "model"
      ? options.find((option) => getString(option, "id") === "model")
      : options.find((option) => /effort|reasoning|thought|thinking/i.test(getString(option, "id") ?? "")))
  );
}

/** Valores de una opción «select» (pueden venir en grupos, cada uno con sus propias opciones). */
function selectValues(option: Record<string, unknown>): AcpModel[] {
  const values: AcpModel[] = [];
  const visit = (list: unknown[]) => {
    for (const item of list) {
      if (!isRecord(item)) continue;
      const value = getString(item, "value");
      if (!value) {
        visit(getArray(item, "options"));
        continue;
      }
      if (!values.some((entry) => entry.modelId === value)) values.push({ modelId: value, name: getString(item, "name") ?? value, efforts: [] });
    }
  };
  visit(getArray(option, "options"));
  return values;
}

/**
 * Suma lo que trae una respuesta del agente (initialize, session/new, session/resume…); lo que no trae queda como
 * estaba. `current: false` para las sesiones retomadas, que traen el modelo de esa conversación y no el predeterminado.
 */
export function mergeSessionModels(previous: AgentModels, response: unknown, { current = true } = {}): AgentModels {
  const next = { ...previous };
  const options = getArray(response, "configOptions").filter(isRecord);
  const model = findOption(options, "model");
  if (model) {
    const values = selectValues(model);
    if (values.length) next.options = values;
    if (current) next.optionCurrent = getString(model, "currentValue") ?? next.optionCurrent;
  }
  const level = findOption(options, "thought_level");
  if (level) {
    const values = selectValues(level).map((entry) => entry.modelId);
    if (values.length) next.levels = values;
  }
  const state = getRecord(response, "models");
  if (state) {
    const list = getArray(state, "availableModels")
      .filter(isRecord)
      .map((entry) => ({
        modelId: getString(entry, "modelId") ?? "",
        name: getString(entry, "name") ?? getString(entry, "modelId") ?? "",
        efforts: getArray(getRecord(entry, "_meta"), "reasoningEfforts")
          .map((item) => (isRecord(item) ? (getString(item, "value") ?? getString(item, "id") ?? "") : typeof item === "string" ? item : ""))
          .filter(Boolean),
      }))
      .filter((entry) => entry.modelId);
    if (list.length) next.list = list;
    if (current) next.listCurrent = getString(state, "currentModelId") ?? next.listCurrent;
  }
  return next;
}

/**
 * Los modelos para elegir y el que el agente usa por omisión. Como OpenBot: si los modelos de las opciones no son
 * los de la lista vieja y esa lista no trae niveles, mandan las opciones (con los niveles de «thought_level»).
 */
export function modelChoices(models: AgentModels): { choices: AcpModelChoice[]; current: string | null } {
  const useOptions =
    models.options.length > 0 &&
    !models.options.some((option) => models.list.some((entry) => entry.modelId === option.modelId)) &&
    !models.list.some((entry) => entry.efforts.length);
  if (!useOptions) return { choices: groupModelVariants(models.list), current: models.listCurrent };

  const choices = models.options.map((option) => ({ ...option, efforts: [...models.levels], variants: {} as Record<string, string>, levelsAsModels: false }));
  // Las variantes de la lista vieja quedan como alias, para reconocer lo guardado con ellas.
  for (const entry of models.list) {
    const variant = effortVariant(entry.name);
    if (!variant) continue;
    const owner = choices.find((choice) => choice.name === variant.base || entry.modelId === `${choice.modelId}-${variant.effort}`);
    if (owner && !owner.variants[variant.effort]) owner.variants[variant.effort] = entry.modelId;
  }
  return { choices, current: models.optionCurrent };
}

/**
 * Junta las variantes de nivel de un mismo modelo de la lista vieja, para un agente que no tenga opciones de sesión.
 * Si existe también el modelo sin nivel («Gemini 3 Pro» junto a «Gemini 3 Pro (High)»), ese es el predeterminado
 * del grupo. El id del grupo es el de un modelo real y no cambia de una vez a otra: el sin nivel, si no la variante
 * «Medium», si no la primera.
 */
export function groupModelVariants(models: AcpModel[]): AcpModelChoice[] {
  const parsed = models.map((model) => ({ model, variant: model.efforts.length ? null : effortVariant(model.name) }));
  const bases = new Set(parsed.flatMap((entry) => (entry.variant ? [entry.variant.base] : [])));
  const groups = new Map<string, { plain: AcpModel | null; variants: Array<{ effort: string; model: AcpModel }> }>();
  const order: Array<{ group: string } | { model: AcpModel }> = [];
  for (const { model, variant } of parsed) {
    const base = variant?.base ?? (bases.has(model.name) && !model.efforts.length ? model.name : null);
    if (!base) {
      order.push({ model });
      continue;
    }
    let group = groups.get(base);
    if (!group) {
      group = { plain: null, variants: [] };
      groups.set(base, group);
      order.push({ group: base });
    }
    if (!variant) {
      if (group.plain) order.push({ model });
      else group.plain = model;
    } else if (group.variants.some((entry) => entry.effort === variant.effort)) {
      order.push({ model }); // Dos con el mismo nivel: el segundo queda aparte, con su nombre completo.
    } else {
      group.variants.push({ effort: variant.effort, model });
    }
  }

  return order.map((entry) => {
    if ("model" in entry) return { ...entry.model, variants: {}, levelsAsModels: false };
    const group = groups.get(entry.group)!;
    const variants = [...group.variants].sort((a, b) => EFFORT_ORDER.indexOf(a.effort) - EFFORT_ORDER.indexOf(b.effort));
    const representative = group.plain ?? variants.find((variant) => variant.effort === "medium")?.model ?? variants[0]!.model;
    return {
      modelId: representative.modelId,
      name: entry.group,
      efforts: variants.map((variant) => variant.effort),
      variants: Object.fromEntries(variants.map((variant) => [variant.effort, variant.model.modelId])),
      levelsAsModels: true,
    };
  });
}

/** El modelo al que pertenece ese id (el suyo o el de cualquiera de sus variantes). */
export function choiceFor(choices: AcpModelChoice[], modelId: string): AcpModelChoice | undefined {
  return choices.find((choice) => choice.modelId === modelId) ?? choices.find((choice) => Object.values(choice.variants).includes(modelId));
}

/**
 * Qué hay que fijarle a la sesión para ese modelo y nivel: el id del modelo y el nivel de la opción de
 * razonamiento (null si no hay que tocarlos, o si el nivel ya va en el modelo elegido).
 */
export function resolveModel(
  choices: AcpModelChoice[],
  current: string | null,
  model: string | null,
  effort: string | null,
): { model: string | null; effort: string | null } {
  const base = model || (effort ? current : null);
  const choice = base ? choiceFor(choices, base) : undefined;
  if (!choice) return { model: model || null, effort: effort || null };
  if (choice.levelsAsModels) return { model: (effort ? choice.variants[effort] : undefined) ?? (model || null), effort: null };
  const saved = model && model !== choice.modelId ? (Object.entries(choice.variants).find(([, id]) => id === model)?.[0] ?? null) : null;
  return { model: model ? choice.modelId : null, effort: effort || saved };
}
