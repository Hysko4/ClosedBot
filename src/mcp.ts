/**
 * Los servidores MCP de un agente, como los muestra ClosedBot (la ficha → «MCP» y la Oficina por equipo).
 * Cada proveedor los informa a su manera; aquí quedan iguales para todos. Nunca se guarda ni se muestra la
 * configuración del servidor (comando, URL, variables o cabeceras): puede llevar claves.
 */

import { getArray, getString, isRecord } from "./providers/protocol.js";
import { TEAM_NAMESPACE } from "./team.js";

/**
 * connected: conectado · failed: no pudo conectarse · needs-auth: le falta iniciar sesión · pending: conectándose ·
 * disabled: apagado · included: ClosedBot se lo pasa al agente (su programa no informa si conectó) ·
 * configured: está configurado, pero su programa no dijo si conectó.
 */
export type McpStatus = "connected" | "failed" | "needs-auth" | "pending" | "disabled" | "included" | "configured";

export interface McpServerView {
  name: string;
  status: McpStatus;
  /** De dónde salió: closedbot, user, project, local, plugin, managed… (null si el programa no lo dice). */
  source: string | null;
  /** Nombres de sus herramientas (las que informó al conectarse). */
  tools: string[];
  error: string | null;
}

/** Lo que responden los clientes de ClosedBot a «closedbot/mcp». */
export interface McpListing {
  servers: McpServerView[];
  /** El programa del agente no le cuenta a ClosedBot los MCP que tiene configurados por su cuenta. */
  hidden?: boolean;
}

/** Lo que se muestra de los MCP de un agente (GET /api/agents/:id/mcp). */
export interface AgentMcpView {
  agentId: string;
  provider: string;
  /** El acceso con que se revisó: con acceso total, Claude Code carga también tus ajustes. */
  access: string;
  /** Cuándo se revisó (ISO). */
  checkedAt: string;
  servers: McpServerView[];
  /** Su programa (Gemini, Grok) no le cuenta a ClosedBot los MCP que tiene configurados por su cuenta. */
  hidden: boolean;
  error: string | null;
}

/** Los servidores que le pasa ClosedBot a Claude Code (las herramientas del equipo y, si está activado, el navegador). */
const CLOSEDBOT_SERVERS = new Set([TEAM_NAMESPACE, "playwright"]);
const STATUSES: readonly McpStatus[] = ["connected", "failed", "needs-auth", "pending", "disabled", "included", "configured"];
const MAX_TOOLS = 200;
const MAX_ERROR = 300;

/** Las herramientas de ClosedBot que recibe el agente (`dynamicTools` del orquestador), como un servidor más. */
export function closedbotServer(params: unknown, status: McpStatus): McpServerView {
  const tools: string[] = [];
  for (const group of getArray(params, "dynamicTools")) {
    if (!isRecord(group) || group.name !== TEAM_NAMESPACE) continue;
    for (const entry of getArray(group, "tools")) if (isRecord(entry) && typeof entry.name === "string") tools.push(entry.name);
  }
  return { name: TEAM_NAMESPACE, status, source: "closedbot", tools, error: null };
}

/** `mcpServerStatus()` del Agent SDK de Claude (o el `mcp_servers` de su mensaje de inicio). */
export function fromClaudeStatus(entries: unknown): McpServerView[] {
  if (!Array.isArray(entries)) return [];
  return entries.filter(isRecord).flatMap((entry) => {
    const name = getString(entry, "name");
    if (!name) return [];
    const status = getString(entry, "status");
    const source = getString(entry, "source") ?? getString(entry, "scope");
    return [
      {
        name,
        status: STATUSES.includes(status as McpStatus) ? (status as McpStatus) : "configured",
        // Los que agrega ClosedBot (su equipo y el navegador) llegan como «sdk» o «dynamic»: se muestran como de ClosedBot.
        source: CLOSEDBOT_SERVERS.has(name) && (source === "sdk" || source === "dynamic") ? "closedbot" : source,
        tools: toolNames(entry.tools),
        error: clip(getString(entry, "error")),
      },
    ];
  });
}

/**
 * `mcpServerStatus/list` del app-server de Codex: cada servidor con sus herramientas (un objeto por nombre) y
 * cómo inició sesión. Codex no dice si conectó: con herramientas se toma por conectado.
 */
export function fromCodexStatus(response: unknown): McpServerView[] {
  return getArray(response, "data")
    .filter(isRecord)
    .flatMap((entry) => {
      const name = getString(entry, "name");
      if (!name) return [];
      const tools = toolNames(entry.tools);
      const auth = getString(entry, "authStatus") ?? getString(entry, "auth_status");
      const status: McpStatus = auth === "notLoggedIn" || auth === "not_logged_in" ? "needs-auth" : tools.length ? "connected" : "configured";
      return [{ name, status, source: "codex", tools, error: null }];
    });
}

/** Las herramientas llegan como lista (Claude) o como objeto por nombre (Codex). */
function toolNames(value: unknown): string[] {
  const names = Array.isArray(value)
    ? value.map((tool) => (isRecord(tool) ? getString(tool, "name") : typeof tool === "string" ? tool : null))
    : isRecord(value)
      ? Object.entries(value).map(([key, tool]) => (isRecord(tool) ? (getString(tool, "name") ?? key) : key))
      : [];
  return [...new Set(names.filter((name): name is string => Boolean(name)))].slice(0, MAX_TOOLS);
}

function clip(text: string | null): string | null {
  if (!text) return null;
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > MAX_ERROR ? `${line.slice(0, MAX_ERROR - 1)}…` : line;
}
