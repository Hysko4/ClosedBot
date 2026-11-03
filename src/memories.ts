// Recuerdos de un agente, como en OpenBot: los que «siempre se usan» van en sus instrucciones y los
// demás los busca cuando hacen falta (search_memories). Escrito para ClosedBot.

import type { MemoryRecord } from "./db.js";

export const MEMORY_LIMITS = {
  /** Recuerdos por agente. */
  perAgent: 64,
  text: 1_000,
  /** Lo que ocupan, como mucho, los de «siempre» en las instrucciones. */
  alwaysChars: 8_000,
  /** Resultados de una búsqueda. */
  results: 10,
} as const;

/** Lo que el usuario o el agente quiere guardar, limpio: una sola línea de espacios, sin bordes. */
export function cleanMemory(value: unknown): string {
  if (typeof value !== "string") throw new Error("El recuerdo debe ser texto.");
  const text = value.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) throw new Error("Escribe qué debe recordar.");
  if (text.length > MEMORY_LIMITS.text) throw new Error(`Un recuerdo admite hasta ${MEMORY_LIMITS.text} caracteres.`);
  return text;
}

/** Palabras de búsqueda: minúsculas, sin tildes y sin palabras vacías. */
function words(text: string): string[] {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9ñ]+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

const STOP_WORDS = new Set(
  "que con por para los las del una uno unos unas sus mis tus como pero mas sin sobre este esta estos estas ese esa eso the and for with from that this you your are was".split(" "),
);

/**
 * Busca entre los recuerdos: cuenta las palabras de la consulta que aparecen en cada uno (también
 * como comienzo de palabra: «program» encuentra «programación») y devuelve los mejores.
 */
export function searchMemories(memories: MemoryRecord[], query: string, limit: number = MEMORY_LIMITS.results): MemoryRecord[] {
  const terms = [...new Set(words(query))];
  if (!terms.length) return [];
  const scored = memories.map((memory) => {
    const have = words(memory.text);
    let score = 0;
    for (const term of terms) {
      if (have.includes(term)) score += 2;
      else if (have.some((word) => word.startsWith(term) || (term.length > 4 && term.startsWith(word) && word.length > 3))) score += 1;
    }
    return { memory, score };
  });
  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt)
    .slice(0, limit)
    .map((entry) => entry.memory);
}

/**
 * Lo que va en las instrucciones del agente: sus recuerdos de «siempre» (los más nuevos si no caben)
 * y cuántos más puede buscar.
 */
export function describeMemories(memories: MemoryRecord[]): string | null {
  if (!memories.length) return null;
  const always = memories.filter((memory) => memory.always);
  const kept: MemoryRecord[] = [];
  let used = 0;
  for (const memory of [...always].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (used + memory.text.length > MEMORY_LIMITS.alwaysChars) continue;
    kept.push(memory);
    used += memory.text.length;
  }
  kept.sort((a, b) => a.createdAt - b.createdAt);
  const searchable = memories.length - kept.length;
  const lines: string[] = [];
  if (kept.length) {
    lines.push("<recuerdos_siempre>", ...kept.map((memory) => `- ${memory.text.replace(/\n+/g, " ")}`), "</recuerdos_siempre>");
  }
  if (searchable > 0) {
    lines.push(
      `Además tienes ${searchable} ${searchable === 1 ? "recuerdo que se usa" : "recuerdos que se usan"} solo si hace falta: búscalos con search_memories cuando el tema pueda tenerlos (preferencias, datos del usuario, decisiones anteriores).`,
    );
  }
  return lines.join("\n");
}
