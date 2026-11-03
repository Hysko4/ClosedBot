// Lo que un agente sabe y que vive en su carpeta, como en OpenBot: sus instrucciones (AGENTS.md, que
// también puede editar él mismo) y sus habilidades (carpetas con un SKILL.md). Escrito para ClosedBot.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export const INSTRUCTIONS_FILE = "AGENTS.md";
/** Lo mismo que lee Codex de un AGENTS.md (32 KiB); más largo se corta. */
export const INSTRUCTIONS_MAX = 32_000;
/** Dónde se buscan las habilidades, dentro de la carpeta del agente. */
export const SKILL_ROOTS = [".agents/skills", ".claude/skills"] as const;
export const SKILL_FILE = "SKILL.md";
export const SKILL_LIMITS = { name: 64, description: 300, text: 32_000, list: 40 } as const;

export interface SkillInfo {
  /** Carpeta relativa a la del agente, con «/» (p. ej. «.agents/skills/resumen»): sirve de id. */
  id: string;
  name: string;
  description: string;
  /** Ruta del SKILL.md relativa a la carpeta del agente. */
  file: string;
  updatedAt: number;
}

// ---------- instrucciones ----------

/** El texto de AGENTS.md, o null si no existe. Los saltos de línea quedan como «\n». */
export function readInstructions(workspace: string): string | null {
  const path = join(workspace, INSTRUCTIONS_FILE);
  let raw: string;
  try {
    if (!statSync(path).isFile()) return null;
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return cleanInstructions(raw);
}

export function cleanInstructions(text: string): string {
  return text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").trim().slice(0, INSTRUCTIONS_MAX).trimEnd();
}

/** Guarda AGENTS.md (sin texto, lo borra). Escribe en un archivo aparte y lo cambia de nombre: nunca queda a medias. */
export function writeInstructions(workspace: string, text: string): void {
  const path = join(workspace, INSTRUCTIONS_FILE);
  const clean = cleanInstructions(text);
  if (!clean) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(workspace, { recursive: true });
  writeAtomic(path, `${clean}\n`);
}

/**
 * Al pasar a la 0.7.0, las instrucciones guardadas en la base pasan a AGENTS.md. Si ya había un AGENTS.md
 * distinto (lo escribió el agente para otra cosa), se guarda aparte como AGENTS.anterior.md.
 * Devuelve el texto que vale desde ahora.
 */
export function migrateInstructions(workspace: string, saved: string): string {
  const current = readInstructions(workspace);
  const clean = cleanInstructions(saved);
  if (current === null || current === clean) {
    if (current === null && clean) writeInstructions(workspace, clean);
    return clean;
  }
  if (!clean) return current;
  try {
    renameSync(join(workspace, INSTRUCTIONS_FILE), join(workspace, "AGENTS.anterior.md"));
  } catch {
    // Si no se puede apartar, se sobrescribe igual: lo que manda es lo que configuró el usuario.
  }
  writeInstructions(workspace, clean);
  return clean;
}

// ---------- habilidades ----------

/** Las habilidades que hay en la carpeta del agente (las de .agents primero), ordenadas por nombre. */
export function listSkills(workspace: string): SkillInfo[] {
  const skills: SkillInfo[] = [];
  const seen = new Set<string>();
  for (const root of SKILL_ROOTS) {
    const dir = join(workspace, ...root.split("/"));
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const file = join(dir, entry.name, SKILL_FILE);
      let text: string;
      let updatedAt: number;
      try {
        const info = statSync(file);
        if (!info.isFile()) continue;
        updatedAt = Math.round(info.mtimeMs);
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const parsed = parseSkill(text, entry.name);
      const key = parsed.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      skills.push({ id: `${root}/${entry.name}`, name: parsed.name, description: parsed.description, file: `${root}/${entry.name}/${SKILL_FILE}`, updatedAt });
      if (skills.length >= SKILL_LIMITS.list) break;
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name, "es", { sensitivity: "base", numeric: true }));
}

/** Nombre y descripción de un SKILL.md: los del encabezado (`---` name / description `---`) o, si faltan, la carpeta y el primer párrafo. */
export function parseSkill(text: string, folder: string): { name: string; description: string; body: string } {
  const normalized = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized);
  const fields: Record<string, string> = {};
  if (match) {
    let key: string | null = null;
    for (const line of (match[1] ?? "").split("\n")) {
      const field = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
      if (field) {
        key = (field[1] ?? "").toLowerCase();
        const value = (field[2] ?? "").trim();
        fields[key] = /^[>|][+-]?$/.test(value) ? "" : unquote(value);
      } else if (key && /^\s+\S/.test(line)) {
        // Continuación de un valor en varias líneas («description: >» y sus líneas con sangría).
        fields[key] = `${fields[key] ? `${fields[key]} ` : ""}${line.trim()}`;
      }
    }
  }
  const body = match ? normalized.slice(match[0].length) : normalized;
  const firstParagraph = body
    .split(/\n\s*\n/)
    .map((part) => part.replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim())
    .find(Boolean);
  return {
    name: oneLine(fields.name || folder).slice(0, SKILL_LIMITS.name),
    description: oneLine(fields.description || firstParagraph || "").slice(0, SKILL_LIMITS.description),
    body: body.trim(),
  };
}

/** Arma un SKILL.md con su encabezado. */
export function composeSkill(name: string, description: string, body: string): string {
  return `---\nname: ${yamlValue(oneLine(name))}\ndescription: ${yamlValue(oneLine(description))}\n---\n\n${body.replace(/\r\n?/g, "\n").trim()}\n`;
}

/** Carpeta para una habilidad nueva («Resumen del día» → .agents/skills/resumen-del-dia), sin pisar otra. */
export function newSkillId(workspace: string, name: string): string {
  const base =
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "habilidad";
  for (let index = 1; ; index += 1) {
    const id = `${SKILL_ROOTS[0]}/${index === 1 ? base : `${base}-${index}`}`;
    if (!existsSync(join(workspace, ...id.split("/")))) return id;
  }
}

/**
 * Carpeta real de una habilidad a partir de su id, comprobando que sea una de las raíces de
 * habilidades y que no salga de la carpeta del agente (ni por «..» ni por un enlace).
 */
export function skillDir(workspace: string, id: string): string {
  const parts = String(id ?? "").split("/");
  const folder = parts.pop() ?? "";
  const root = parts.join("/");
  if (!(SKILL_ROOTS as readonly string[]).includes(root) || !folder || folder === "." || folder === ".." || folder.startsWith(".") || /[\\\0:]/.test(folder)) {
    throw new Error("Esa habilidad no es válida.");
  }
  const dir = resolve(workspace, ...root.split("/"), folder);
  if (existsSync(dir)) {
    const base = realpathSync.native(workspace);
    const real = realpathSync.native(dir);
    const inside = relative(base, real);
    if (!inside || inside.startsWith("..") || isAbsolute(inside) || lstatSync(dir).isSymbolicLink()) throw new Error("Esa habilidad no es válida.");
  }
  return dir;
}

export function readSkill(workspace: string, id: string): string | null {
  try {
    return readFileSync(join(skillDir(workspace, id), SKILL_FILE), "utf8").replace(/\r\n?/g, "\n");
  } catch (error) {
    if (error instanceof Error && error.message === "Esa habilidad no es válida.") throw error;
    return null;
  }
}

export function writeSkill(workspace: string, id: string, text: string): void {
  const dir = skillDir(workspace, id);
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, SKILL_FILE), `${text.replace(/\r\n?/g, "\n").trim()}\n`);
}

export function deleteSkill(workspace: string, id: string): void {
  rmSync(skillDir(workspace, id), { recursive: true, force: true });
}

// ---------- ayudas ----------

function writeAtomic(path: string, content: string): void {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, content, "utf8");
  try {
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function unquote(value: string): string {
  const match = /^(["'])(.*)\1$/.exec(value);
  return match ? (match[1] === '"' ? (match[2] ?? "").replace(/\\"/g, '"') : (match[2] ?? "").replace(/''/g, "'")) : value;
}

/** Un valor de una línea seguro para el encabezado: entre comillas si tiene algo que YAML leería distinto. */
function yamlValue(value: string): string {
  return /^[\w\sáéíóúüñÁÉÍÓÚÜÑ.,()¿?¡!-]*$/.test(value) && !/^[\s-]/.test(value) && value !== "" ? value : JSON.stringify(value);
}
