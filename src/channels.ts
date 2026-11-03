// Canales: conversaciones con varios agentes. El encargado responde a lo que no nombra a nadie y
// reparte el trabajo; con @Nombre se le habla a un agente en particular (o a todos con @todos).

/** Agentes por canal como máximo, y largo del nombre y del tema. */
export const MAX_CHANNEL_MEMBERS = 12;
export const CHANNEL_LIMITS = { name: 60, topic: 300 } as const;

/** Quita tildes y mayúsculas para comparar nombres («@Diseñador» = «@disenador»). */
export function foldText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const BEFORE = "(^|[^\\p{L}\\p{N}_@])";
const AFTER = "(?![\\p{L}\\p{N}_])";
const EVERYONE = new RegExp(`${BEFORE}@(todos|todas|canal|everyone|all)${AFTER}`, "u");

/**
 * Agentes nombrados con @ en el texto, en el orden del canal. Los nombres pueden tener espacios
 * («@Diseñador de Niveles»); los largos se buscan primero para que «@Ana María» no cuente como «@Ana».
 */
export function findMentions(text: string, members: ReadonlyArray<{ id: string; name: string }>): string[] {
  let rest = foldText(text);
  if (EVERYONE.test(rest)) return members.map((member) => member.id);
  const found = new Set<string>();
  for (const member of [...members].sort((a, b) => b.name.length - a.name.length)) {
    const name = escapeRegExp(foldText(member.name.trim()));
    if (!name) continue;
    if (!new RegExp(`${BEFORE}@${name}${AFTER}`, "u").test(rest)) continue;
    found.add(member.id);
    rest = rest.replace(new RegExp(`${BEFORE}@${name}${AFTER}`, "gu"), "$1 ");
  }
  return members.filter((member) => found.has(member.id)).map((member) => member.id);
}

export interface ChannelContext {
  name: string;
  topic: string;
  /** Quién recibe el mensaje. */
  you: string;
  leadName: string | null;
  members: ReadonlyArray<{ name: string; role: string }>;
  /** Lo último que se dijo en el canal, del más viejo al más nuevo. */
  history: ReadonlyArray<{ author: string; text: string }>;
}

/** Lo que recibe un agente por un mensaje del canal: quién está, quién reparte y lo último que se dijo. */
export function composeChannelInput(context: ChannelContext, body: string): string {
  const lead = context.leadName;
  const isLead = lead !== null && foldText(lead) === foldText(context.you);
  const members = context.members
    .map((member) => {
      const role = oneLine(member.role);
      return `${oneLine(member.name)}${role ? ` (${clip(role, 80)})` : ""}${member.name === lead ? " — encargado" : ""}`;
    })
    .join("; ");
  const topic = oneLine(context.topic);
  // Cada parte del encabezado ocupa una sola línea: así «--- mensaje ---» siempre separa el mensaje.
  return [
    `[Canal «${oneLine(context.name).replace(/[«»]/g, "")}» de ClosedBot]`,
    topic ? `Para qué es el canal: ${clip(topic, 300)}` : null,
    `Miembros: ${members}.`,
    isLead
      ? "Eres el encargado de este canal: te llegan los mensajes del usuario que no nombran a nadie. Responde tú o reparte el trabajo con send_message entre los miembros que correspondan (te llegará su resultado) y después resume para el usuario."
      : `${lead ? `El encargado del canal es ${oneLine(lead)}. ` : ""}El usuario o un compañero te pidió esto a ti: respóndelo. Si hace falta coordinar con otro miembro, escríbele con send_message.`,
    "Lo que escribas en este turno se publica en el canal: lo ven el usuario y los demás miembros. Sé breve y no repitas lo que ya dijeron otros.",
    context.history.length
      ? ["Lo último del canal, para que tengas el contexto:", ...context.history.map((entry) => `- ${oneLine(entry.author)}: ${clip(oneLine(entry.text), 400)}`)].join("\n")
      : null,
    "--- mensaje ---",
    body,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Nombre libre entre los canales activos: «Ventas», «Ventas (2)»… */
export function uniqueName(name: string, taken: (candidate: string) => boolean, max = 60): string {
  if (!taken(name)) return name;
  for (let index = 2; index < 1000; index += 1) {
    const suffix = ` (${index})`;
    const candidate = `${name.slice(0, max - suffix.length)}${suffix}`;
    if (!taken(candidate)) return candidate;
  }
  return `${name.slice(0, max - 9)} (${Date.now() % 100_000})`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
