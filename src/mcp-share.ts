/**
 * MCP del equipo (0.9.13). Pedido del usuario: «¿por qué 4FTER Dev no tiene los MCP como Codex?… que los MCP además
 * me den info de qué son cada uno». Los servidores MCP que ya configuraste en este PC (en tu Codex o en tu Claude Code)
 * se le pueden dar a un equipo: desde entonces los tienen todos sus agentes, sea cual sea su IA.
 *
 * La configuración (comando, variables, URL, cabeceras) se lee aquí y se le pasa al programa de cada agente; nunca se
 * guarda en ClosedBot ni se manda a la app: puede llevar claves. Los conectores de tu cuenta (claude.ai, las apps de
 * ChatGPT) no se comparten nunca.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TEAM_NAMESPACE } from "./team.js";

export interface SharedMcpServer {
  name: string;
  /** Dónde lo configuraste. */
  origin: "codex" | "claude";
  transport: "stdio" | "http";
  command: string | null;
  args: string[];
  env: Record<string, string>;
  url: string | null;
  headers: Record<string, string>;
}

/** Lo que se muestra de un MCP del PC: nada de su configuración. */
export interface SharedMcpView {
  name: string;
  origin: "codex" | "claude";
  transport: "stdio" | "http";
  description: string;
}

const NAME = /^[A-Za-z0-9_.-]{1,64}$/;
/** Lo que ClosedBot ya les da (sus herramientas y el navegador) y los conectores de tu cuenta. */
const RESERVED = new Set([TEAM_NAMESPACE, "playwright", "codex_apps"]);

export function isAccountConnector(name: string): boolean {
  return RESERVED.has(name) || /^claude[._ -]?ai/i.test(name) || /^codex[_-]?apps?$/i.test(name);
}

/** Los MCP configurados en este PC: primero los de tu Codex y después los de tu Claude Code (sin repetir nombres). */
export function readPcMcpServers(home: string, codexHome = process.env.CODEX_HOME || join(home, ".codex")): SharedMcpServer[] {
  const servers: SharedMcpServer[] = [];
  const seen = new Set<string>();
  const add = (list: SharedMcpServer[]) => {
    for (const server of list) {
      if (seen.has(server.name.toLowerCase()) || isAccountConnector(server.name)) continue;
      seen.add(server.name.toLowerCase());
      servers.push(server);
    }
  };
  add(safeRead(join(codexHome, "config.toml"), parseCodexMcp));
  add(safeRead(join(home, ".claude.json"), parseClaudeMcp));
  return servers;
}

function safeRead(path: string, parse: (text: string) => SharedMcpServer[]): SharedMcpServer[] {
  try {
    return existsSync(path) ? parse(readFileSync(path, "utf8")) : [];
  } catch {
    // Un archivo que no se entiende no impide lo demás.
    return [];
  }
}

/** `mcpServers` de ~/.claude.json (los de alcance «usuario» de Claude Code). */
export function parseClaudeMcp(text: string): SharedMcpServer[] {
  const data: unknown = JSON.parse(text);
  const table = record(record(data)?.mcpServers);
  if (!table) return [];
  return Object.entries(table).flatMap(([name, value]): SharedMcpServer[] => {
    const entry = record(value);
    if (!entry || !NAME.test(name) || entry.disabled === true) return [];
    const type = typeof entry.type === "string" ? entry.type : "";
    if (typeof entry.url === "string" && (type === "http" || type === "sse" || !entry.command)) {
      return [{ name, origin: "claude" as const, transport: "http" as const, command: null, args: [], env: {}, url: entry.url, headers: strings(entry.headers) }];
    }
    if (typeof entry.command !== "string" || !entry.command) return [];
    return [{ name, origin: "claude" as const, transport: "stdio" as const, command: entry.command, args: list(entry.args), env: strings(entry.env), url: null, headers: {} }];
  });
}

/** `[mcp_servers.<nombre>]` de ~/.codex/config.toml (solo lo que hace falta de TOML). */
export function parseCodexMcp(text: string): SharedMcpServer[] {
  const tables = new Map<string, Record<string, unknown>>();
  let current: Record<string, unknown> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw).trim();
    if (!line) continue;
    const header = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (header) {
      const path = splitKey(header[1] ?? "");
      if (path[0] !== "mcp_servers" || path.length < 2 || path.length > 3) {
        current = null;
        continue;
      }
      const name = path[1] ?? "";
      const table = tables.get(name) ?? {};
      tables.set(name, table);
      if (path.length === 3) {
        const sub = record(table[path[2] ?? ""]) ?? {};
        table[path[2] ?? ""] = sub;
        current = sub;
      } else current = table;
      continue;
    }
    if (!current) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = splitKey(line.slice(0, eq)).join(".");
    const value = parseValue(line.slice(eq + 1).trim());
    if (value !== undefined) current[key] = value;
  }
  return [...tables.entries()].flatMap(([name, table]): SharedMcpServer[] => {
    if (!NAME.test(name) || table.enabled === false) return [];
    if (typeof table.url === "string" && table.url) {
      const headers = strings(table.http_headers);
      const bearer = typeof table.bearer_token_env_var === "string" ? process.env[table.bearer_token_env_var] : undefined;
      if (bearer) headers.Authorization = `Bearer ${bearer}`;
      return [{ name, origin: "codex" as const, transport: "http" as const, command: null, args: [], env: {}, url: table.url, headers }];
    }
    if (typeof table.command !== "string" || !table.command) return [];
    return [{ name, origin: "codex" as const, transport: "stdio" as const, command: table.command, args: list(table.args), env: strings(table.env), url: null, headers: {} }];
  });
}

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === "\\" && quote === '"') index += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "#") return line.slice(0, index);
  }
  return line;
}

function splitKey(key: string): string[] {
  return [...key.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|([^.\s]+)/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

/** Un valor de TOML: texto, número, verdadero/falso, lista o tabla en línea (lo que usan los MCP). */
function parseValue(text: string): unknown {
  const reader = { text, at: 0 };
  try {
    return readValue(reader);
  } catch {
    return undefined;
  }
}

function readValue(reader: { text: string; at: number }): unknown {
  skipSpace(reader);
  const char = reader.text[reader.at];
  if (char === '"' || char === "'") return readString(reader);
  if (char === "[") {
    reader.at += 1;
    const items: unknown[] = [];
    for (;;) {
      skipSpace(reader);
      if (reader.text[reader.at] === "]") {
        reader.at += 1;
        return items;
      }
      items.push(readValue(reader));
      skipSpace(reader);
      if (reader.text[reader.at] === ",") reader.at += 1;
      else if (reader.text[reader.at] !== "]") throw new Error("lista");
    }
  }
  if (char === "{") {
    reader.at += 1;
    const table: Record<string, unknown> = {};
    for (;;) {
      skipSpace(reader);
      if (reader.text[reader.at] === "}") {
        reader.at += 1;
        return table;
      }
      const eq = reader.text.indexOf("=", reader.at);
      if (eq < 0) throw new Error("tabla");
      const key = splitKey(reader.text.slice(reader.at, eq)).join(".");
      reader.at = eq + 1;
      table[key] = readValue(reader);
      skipSpace(reader);
      if (reader.text[reader.at] === ",") reader.at += 1;
      else if (reader.text[reader.at] !== "}") throw new Error("tabla");
    }
  }
  const word = /^[^,\]}\s]+/.exec(reader.text.slice(reader.at))?.[0] ?? "";
  reader.at += word.length;
  if (word === "true") return true;
  if (word === "false") return false;
  const number = Number(word);
  if (word && Number.isFinite(number)) return number;
  throw new Error("valor");
}

function readString(reader: { text: string; at: number }): string {
  const quote = reader.text[reader.at];
  reader.at += 1;
  let out = "";
  while (reader.at < reader.text.length) {
    const char = reader.text[reader.at] ?? "";
    reader.at += 1;
    if (char === quote) return out;
    if (char === "\\" && quote === '"') {
      const next = reader.text[reader.at] ?? "";
      reader.at += 1;
      const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" };
      if (next === "u" || next === "U") {
        const size = next === "u" ? 4 : 8;
        out += String.fromCodePoint(Number.parseInt(reader.text.slice(reader.at, reader.at + size), 16));
        reader.at += size;
      } else out += escapes[next] ?? next;
    } else out += char;
  }
  throw new Error("texto");
}

function skipSpace(reader: { text: string; at: number }): void {
  while (/\s/.test(reader.text[reader.at] ?? "")) reader.at += 1;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function strings(value: unknown): Record<string, string> {
  const table = record(value) ?? {};
  return Object.fromEntries(Object.entries(table).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

// ---------- qué es cada uno ----------

/** Lo que hacen los MCP más comunes (por su nombre); el resto se explica con sus herramientas. */
const KNOWN: Array<[RegExp, string]> = [
  [/unity/i, "Controla el editor de Unity: escenas, objetos, componentes, scripts y la consola."],
  [/godot/i, "Controla el editor de Godot: escenas, nodos y scripts."],
  [/unreal/i, "Controla el editor de Unreal Engine."],
  [/blender/i, "Controla Blender: modelos 3D, materiales, luces y renders."],
  [/aseprite/i, "Dibuja y edita sprites pixel art en Aseprite."],
  [/pixel ?lab/i, "Genera personajes y sprites pixel art con PixelLab."],
  [/^fal|fal[-_ ]?ai/i, "Genera imágenes, video y audio con los modelos de fal."],
  [/eleven ?labs/i, "Voces, efectos de sonido y música con ElevenLabs."],
  [/figma/i, "Lee los diseños de Figma (pantallas, componentes y estilos)."],
  [/github/i, "Repositorios, issues y pull requests de GitHub."],
  [/gitlab/i, "Repositorios, issues y merge requests de GitLab."],
  [/^git$|git[-_]?mcp/i, "Opera con git en repositorios de este PC (historial, ramas, cambios)."],
  [/playwright|puppeteer|chrome|browser|navegador/i, "Maneja un navegador: abre páginas, hace clic, escribe y toma capturas."],
  [/filesystem|files?$/i, "Lee y escribe archivos en las carpetas que tiene permitidas."],
  [/fetch|web[-_]?search|brave|tavily|exa/i, "Busca en internet o descarga páginas y las pasa a texto."],
  [/context7|docs?$/i, "Documentación al día de librerías y frameworks de programación."],
  [/memory|memoria/i, "Una memoria que dura entre conversaciones (un grafo de datos)."],
  [/sequential|thinking/i, "Ayuda a pensar paso a paso problemas largos."],
  [/notion/i, "Páginas y bases de datos de Notion."],
  [/slack/i, "Canales y mensajes de Slack."],
  [/linear/i, "Tareas y proyectos de Linear."],
  [/jira|atlassian|confluence/i, "Tareas de Jira y páginas de Confluence."],
  [/sentry/i, "Errores y fallos registrados en Sentry."],
  [/supabase/i, "Base de datos y servicios de Supabase."],
  [/postgres|mysql|sqlite|database|\bdb\b/i, "Consulta y modifica una base de datos."],
  [/docker/i, "Contenedores e imágenes de Docker."],
  [/obsidian/i, "Notas de tu bóveda de Obsidian."],
  [/drive|gdrive/i, "Archivos de Google Drive."],
  [/gmail|mail|correo/i, "Correo electrónico."],
  [/calendar|calendario/i, "Eventos del calendario."],
  [/youtube/i, "Videos y transcripciones de YouTube."],
  [/stripe/i, "Pagos y clientes de Stripe."],
];

/** Qué es un MCP, en una frase (por su nombre o, si no se conoce, por sus herramientas). */
export function describeMcp(name: string, tools: readonly string[] = []): string {
  if (name === TEAM_NAMESPACE) return "Las herramientas de ClosedBot: hablar con sus compañeros, preguntarte, rutinas, recuerdos y su lista de tareas.";
  for (const [pattern, text] of KNOWN) if (pattern.test(name)) return text;
  if (tools.length) {
    const shown = tools.slice(0, 5).join(", ");
    return `Servidor MCP con ${tools.length} ${tools.length === 1 ? "herramienta" : "herramientas"}: ${shown}${tools.length > 5 ? "…" : ""}.`;
  }
  return "Servidor MCP configurado en este PC; sus herramientas se ven cuando un agente lo conecta.";
}

export function sharedView(server: SharedMcpServer): SharedMcpView {
  return { name: server.name, origin: server.origin, transport: server.transport, description: describeMcp(server.name) };
}

/** Los MCP del equipo que vienen en los parámetros de un hilo (`sharedMcpServers`), ya revisados. */
export function sharedFromParams(params: unknown): SharedMcpServer[] {
  const raw = record(params)?.sharedMcpServers;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value: unknown): SharedMcpServer[] => {
    const entry = record(value);
    if (!entry || typeof entry.name !== "string" || !NAME.test(entry.name) || isAccountConnector(entry.name)) return [];
    const origin: SharedMcpServer["origin"] = entry.origin === "claude" ? "claude" : "codex";
    if (entry.transport === "http" && typeof entry.url === "string") {
      return [{ name: entry.name, origin, transport: "http" as const, command: null, args: [], env: {}, url: entry.url, headers: strings(entry.headers) }];
    }
    if (typeof entry.command !== "string" || !entry.command) return [];
    return [{ name: entry.name, origin, transport: "stdio" as const, command: entry.command, args: list(entry.args), env: strings(entry.env), url: null, headers: {} }];
  });
}

/** Para comparar si cambiaron (sin guardar la configuración en ningún lado). */
export function sharedKey(servers: readonly SharedMcpServer[]): string {
  return JSON.stringify(servers.map((server) => [server.name, server.transport, server.command, server.args, server.env, server.url, server.headers]));
}
