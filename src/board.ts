// La pizarra del trabajo que lleva Claude Bot: el objetivo, quién hace qué y el avance. La reciben los
// agentes cuando él les escribe. Escrito para ClosedBot.

/** Largo máximo de la pizarra. */
export const BOARD_MAX = 6_000;

/** La pizarra tal como la recibe un agente, o null si está vacía. */
export function boardSection(board: string, mainName: string): string | null {
  const text = board.trim();
  if (!text) return null;
  return `Pizarra del trabajo (la lleva ${oneLine(mainName)}):\n<pizarra>\n${clip(text, BOARD_MAX)}\n</pizarra>`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
