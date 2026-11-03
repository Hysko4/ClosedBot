// Lo que sabe Claude Bot de los agentes y canales del usuario. El usuario también los crea, elimina,
// mueve y cambia desde la barra lateral, y el bot no se entera: lo que recuerda de su conversación
// queda viejo. Por eso se guarda una foto de lo que se le contó y, antes de cada mensaje, se le
// cuentan las diferencias (o cómo está todo, si su conversación es nueva).

import { createHash } from "node:crypto";

/** Lo que hace falta de un agente para la foto. */
export interface TeamAgentInfo {
  id: string;
  name: string;
  role: string;
  instructions: string;
  project: string;
  provider: string;
  model: string | null;
  paused: boolean;
}

/** Lo que hace falta de un canal para la foto. */
export interface TeamChannelInfo {
  id: string;
  name: string;
  memberIds: string[];
  leadId: string | null;
  deletedAt: number | null;
}

export interface AgentSnapshot {
  name: string;
  role: string;
  /** Huella de las instrucciones: basta para avisar que cambiaron. */
  instructions: string;
  project: string;
  provider: string;
  model: string | null;
  paused: boolean;
}

export interface ChannelSnapshot {
  name: string;
  members: string[];
  lead: string | null;
  deleted: boolean;
}

export interface TeamSnapshot {
  /** Conversación del bot en la que se le contó este estado: si cambia, se le cuenta todo de nuevo. */
  threadId: string | null;
  agents: Record<string, AgentSnapshot>;
  channels: Record<string, ChannelSnapshot>;
}

/** Nombre de un proveedor para mostrar («codex» → «Codex»). */
export type ProviderLabel = (provider: string) => string;

/** Primera parte de las notas: el bot la reconoce como de ClosedBot (y la demo la salta). */
export const TEAM_NOTE_PREFIX = "[ClosedBot · ";
const CHANGES_HEADER = `${TEAM_NOTE_PREFIX}cambios que hizo el usuario en sus agentes y canales desde tu último mensaje; esto manda sobre lo que recuerdes]`;
const FULL_HEADER = `${TEAM_NOTE_PREFIX}así están ahora los agentes y canales del usuario; esto manda sobre lo que recuerdes de la conversación]`;
/** Líneas como máximo en una nota, para que no tape el mensaje. */
const MAX_LINES = 30;
const ROLE_MAX = 80;

export function snapshotAgent(agent: TeamAgentInfo): AgentSnapshot {
  return {
    name: agent.name,
    role: agent.role,
    instructions: fingerprint(agent.instructions),
    project: agent.project,
    provider: agent.provider,
    model: agent.model,
    paused: agent.paused,
  };
}

export function snapshotChannel(channel: TeamChannelInfo): ChannelSnapshot {
  return { name: channel.name, members: [...channel.memberIds], lead: channel.leadId, deleted: channel.deletedAt !== null };
}

export function snapshotTeam(threadId: string | null, agents: TeamAgentInfo[], channels: TeamChannelInfo[]): TeamSnapshot {
  const snapshot: TeamSnapshot = { threadId, agents: {}, channels: {} };
  for (const agent of agents) snapshot.agents[agent.id] = snapshotAgent(agent);
  for (const channel of channels) snapshot.channels[channel.id] = snapshotChannel(channel);
  return snapshot;
}

/** Lee la foto guardada; null si no hay o no se entiende (entonces se le cuenta todo). */
export function parseTeamSnapshot(raw: string | null): TeamSnapshot | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isObject(value) || !isObject(value.agents) || !isObject(value.channels)) return null;
    const snapshot: TeamSnapshot = { threadId: typeof value.threadId === "string" ? value.threadId : null, agents: {}, channels: {} };
    for (const [id, item] of Object.entries(value.agents)) {
      if (!isObject(item) || typeof item.name !== "string") continue;
      snapshot.agents[id] = {
        name: item.name,
        role: text(item.role),
        instructions: text(item.instructions),
        project: text(item.project),
        provider: text(item.provider),
        model: typeof item.model === "string" ? item.model : null,
        paused: item.paused === true,
      };
    }
    for (const [id, item] of Object.entries(value.channels)) {
      if (!isObject(item) || typeof item.name !== "string") continue;
      snapshot.channels[id] = {
        name: item.name,
        members: Array.isArray(item.members) ? item.members.filter((member): member is string => typeof member === "string") : [],
        lead: typeof item.lead === "string" ? item.lead : null,
        deleted: item.deleted === true,
      };
    }
    return snapshot;
  } catch {
    return null;
  }
}

/** Cómo está todo ahora: para una conversación nueva (o la primera vez que se le cuenta). */
export function describeTeam(snapshot: TeamSnapshot, label: ProviderLabel): string {
  const lines: string[] = [];
  const sections = new Map<string, string[]>();
  for (const agent of Object.values(snapshot.agents)) {
    const key = agent.project.trim();
    if (!sections.has(key)) sections.set(key, []);
    const details = [oneLine(agent.role, ROLE_MAX), agent.provider === "claude" ? "" : label(agent.provider), agent.paused ? "cola en pausa" : ""].filter(Boolean);
    sections.get(key)?.push(`${quote(agent.name)}${details.length ? ` (${details.join("; ")})` : ""}`);
  }
  // Primero las secciones con nombre, en el orden en que aparecen; al final, los que no tienen.
  for (const [section, names] of [...sections].sort(([a], [b]) => Number(a === "") - Number(b === ""))) {
    lines.push(`${section ? `Sección ${quote(section)}` : "Sin sección"}: ${names.join(", ")}.`);
  }
  const active = Object.values(snapshot.channels).filter((channel) => !channel.deleted);
  const deleted = Object.values(snapshot.channels).filter((channel) => channel.deleted);
  const agentName = (id: string) => snapshot.agents[id]?.name ?? null;
  if (active.length) {
    const described = active.map((channel) => {
      const members = channel.members.map(agentName).filter((name): name is string => name !== null);
      const lead = channel.lead ? agentName(channel.lead) : null;
      if (!members.length) return `${quote(channel.name)} (sin miembros)`;
      return `${quote(channel.name)} (${joinList(members.map(quote))}${lead ? `; encargado: ${quote(lead)}` : ""})`;
    });
    lines.push(`Canales: ${described.join(", ")}.`);
  }
  if (deleted.length) lines.push(`En «Canales eliminados»: ${joinList(deleted.map((channel) => quote(channel.name)))}.`);
  if (!lines.length) lines.push("No hay otros agentes ni canales.");
  return formatNote(FULL_HEADER, lines);
}

/** Lo que cambió entre lo que sabía el bot y ahora; null si no cambió nada que le importe. */
export function describeChanges(before: TeamSnapshot, after: TeamSnapshot, label: ProviderLabel): string | null {
  const lines: string[] = [];
  const nameOf = (id: string) => after.agents[id]?.name ?? before.agents[id]?.name ?? "un agente";

  // Agentes eliminados y creados, agrupados por sección.
  const removed = Object.keys(before.agents).filter((id) => !after.agents[id]);
  for (const [section, ids] of groupBy(removed, (id) => before.agents[id]?.project.trim() ?? "")) {
    lines.push(`Eliminó a ${joinList(ids.map((id) => quote(nameOf(id))))}${section ? ` (de la sección ${quote(section)})` : ""}.`);
  }
  const added = Object.keys(after.agents).filter((id) => !before.agents[id]);
  for (const [section, ids] of groupBy(added, (id) => after.agents[id]?.project.trim() ?? "")) {
    const names = ids.map((id) => {
      const role = oneLine(after.agents[id]?.role ?? "", ROLE_MAX);
      return `${quote(nameOf(id))}${role ? ` (${role})` : ""}`;
    });
    lines.push(`Creó a ${joinList(names)}${section ? ` en la sección ${quote(section)}` : " sin sección"}.`);
  }

  // Cambios en los que siguen.
  const kept = Object.keys(after.agents).filter((id) => before.agents[id]);
  const moves = new Map<string, string[]>();
  for (const id of kept) {
    const old = before.agents[id] as AgentSnapshot;
    const now = after.agents[id] as AgentSnapshot;
    if (old.name !== now.name) lines.push(`Cambió el nombre de ${quote(old.name)} a ${quote(now.name)}.`);
    if (old.project.trim() !== now.project.trim()) {
      const key = JSON.stringify([old.project.trim(), now.project.trim()]);
      if (!moves.has(key)) moves.set(key, []);
      moves.get(key)?.push(id);
    }
    if (old.role !== now.role) {
      const role = oneLine(now.role, ROLE_MAX);
      lines.push(role ? `Cambió el rol de ${quote(now.name)}: ${quote(role)}.` : `Le quitó el rol a ${quote(now.name)}.`);
    }
    if (old.instructions !== now.instructions) lines.push(`Cambió las instrucciones de ${quote(now.name)} (léelas con list_agents).`);
    if (old.provider !== now.provider) {
      lines.push(`${quote(now.name)} ahora trabaja con ${label(now.provider)}${now.model ? ` (${now.model})` : ""}.`);
    } else if (old.model !== now.model) {
      lines.push(`Cambió el modelo de ${quote(now.name)} a ${now.model ?? "el predeterminado"}.`);
    }
    if (old.paused !== now.paused) {
      lines.push(now.paused ? `Pausó la cola de ${quote(now.name)}: no atiende mensajes hasta que la reanude.` : `Reanudó la cola de ${quote(now.name)}.`);
    }
  }
  for (const [key, ids] of moves) {
    const [from = "", to = ""] = JSON.parse(key) as string[];
    const names = joinList(ids.map((id) => quote(nameOf(id))));
    // Si se fueron todos los de una sección a otra que no existía, el usuario le cambió el nombre.
    const wholeSection =
      from &&
      to &&
      Object.entries(after.agents).every(([id, agent]) => agent.project.trim() !== from || !before.agents[id]) &&
      Object.entries(before.agents).every(([id, agent]) => agent.project.trim() !== to || !after.agents[id]) &&
      Object.entries(before.agents).filter(([, agent]) => agent.project.trim() === from).every(([id]) => !after.agents[id] || ids.includes(id));
    if (wholeSection) lines.push(`Cambió el nombre de la sección ${quote(from)} a ${quote(to)} (con ${names}).`);
    else if (!from) lines.push(`Puso a ${names} en la sección ${quote(to)}.`);
    else if (!to) lines.push(`Sacó a ${names} de la sección ${quote(from)}: ${ids.length === 1 ? "quedó" : "quedaron"} sin sección.`);
    else lines.push(`Movió a ${names} de la sección ${quote(from)} a ${quote(to)}.`);
  }

  // Canales.
  for (const [id, old] of Object.entries(before.channels)) {
    if (after.channels[id]) continue;
    lines.push(old.deleted ? `Borró para siempre el canal ${quote(old.name)}, que estaba en «Canales eliminados».` : `Borró el canal ${quote(old.name)}.`);
  }
  const memberNames = (ids: string[]) => joinList(ids.map((id) => quote(nameOf(id))));
  for (const [id, now] of Object.entries(after.channels)) {
    const old = before.channels[id];
    if (!old) {
      if (now.deleted) continue;
      const lead = now.lead ? `; encargado: ${quote(nameOf(now.lead))}` : "";
      lines.push(`Creó el canal ${quote(now.name)} (${now.members.length ? memberNames(now.members) : "sin miembros"}${lead}).`);
      continue;
    }
    if (!old.deleted && now.deleted) {
      lines.push(`Eliminó el canal ${quote(old.name)}: quedó en «Canales eliminados» y ya no se usa.`);
      continue;
    }
    if (old.deleted && now.deleted) continue;
    if (old.deleted && !now.deleted) {
      lines.push(`Restauró el canal ${quote(now.name)} (${now.members.length ? memberNames(now.members) : "sin miembros"}).`);
      continue;
    }
    if (old.name !== now.name) lines.push(`Cambió el nombre del canal ${quote(old.name)} a ${quote(now.name)}.`);
    const joined = now.members.filter((member) => !old.members.includes(member));
    // Los que salieron porque se eliminaron ya se contaron arriba.
    const left = old.members.filter((member) => !now.members.includes(member) && after.agents[member]);
    if (joined.length) lines.push(`Sumó a ${memberNames(joined)} al canal ${quote(now.name)}.`);
    if (left.length) lines.push(`Sacó a ${memberNames(left)} del canal ${quote(now.name)}.`);
    if (old.lead !== now.lead) {
      lines.push(now.lead ? `Ahora el encargado del canal ${quote(now.name)} es ${quote(nameOf(now.lead))}.` : `El canal ${quote(now.name)} se quedó sin miembros.`);
    }
  }
  return lines.length ? formatNote(CHANGES_HEADER, lines) : null;
}

/** Separa una nota de ClosedBot del mensaje que la sigue (la demo la usa para no repetirla). */
export function splitTeamNote(input: string): { note: string | null; rest: string } {
  if (!input.startsWith(CHANGES_HEADER) && !input.startsWith(FULL_HEADER)) return { note: null, rest: input };
  const end = input.indexOf("\n\n");
  if (end < 0) return { note: input, rest: "" };
  return { note: input.slice(0, end), rest: input.slice(end + 2) };
}

function formatNote(header: string, lines: string[]): string {
  const shown = lines.length > MAX_LINES ? lines.slice(0, MAX_LINES - 1) : lines;
  const more = lines.length - shown.length;
  return [header, ...shown.map((line) => `- ${line}`), ...(more ? [`- …y ${more} cambios más: míralos con list_agents.`] : [])].join("\n");
}

function groupBy(ids: string[], key: (id: string) => string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const value = key(id);
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value)?.push(id);
  }
  return groups;
}

/** «A», «A y B», «A, B y C»; con muchos, los primeros y cuántos más. */
function joinList(items: string[], max = 12): string {
  const shown = items.length > max ? items.slice(0, max - 1) : items;
  const rest = items.length - shown.length;
  if (rest) return `${shown.join(", ")} y ${rest} más`;
  if (shown.length <= 1) return shown[0] ?? "";
  return `${shown.slice(0, -1).join(", ")} y ${shown[shown.length - 1]}`;
}

function quote(name: string): string {
  return `«${oneLine(name, 80)}»`;
}

/** En una sola línea y con un largo máximo: la nota no debe partirse (ni dejar que un nombre la parta). */
function oneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value.trim()).digest("hex").slice(0, 16);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
