// La Oficina: cada equipo es una plataforma isométrica de neón con un escritorio por integrante, y cada
// agente es un robot que trabaja, pregunta, duerme o espera. Todo se dibuja aquí, en un solo canvas.
// Desde la 0.9.5 también se usa: los robots se arrastran de un equipo a otro, el «+» de cada tarjeta crea un
// agente en ese equipo, la plataforma punteada arma un equipo nuevo y la guía explica qué es cada cosa.

/** Colores de neón de las plataformas, en orden. */
const NEON = ["#2de2c8", "#3fb6ff", "#ff4fa3", "#f5d63d", "#9b7bff", "#ff8a3d", "#5cf27e", "#ff5d5d"];
const HALL_COLOR = "#8fa8ff";
const GHOST_COLOR = "#b4c2ff";
/** «Sin grupo» con varios agentes: no es un equipo, así que va en un color neutro. */
const LOOSE_COLOR = "#b9bfd4";
/** Mitad del ancho y del alto de una celda isométrica, en píxeles de mundo. */
const TILE_W = 74;
const TILE_H = 37;
const THICK = 14;
const CARD_W = 230;
const CARD_H = 62;
/** El «+» junto a la tarjeta de cada equipo. */
const ADD_R = 14;
/** Lo mismo que en el servidor: agentes por canal y canales activos. */
const MAX_MEMBERS = 12;
const MAX_TEAMS = 50;
/** En el teléfono, mantener presionado un robot lo levanta para arrastrarlo. */
const LONG_PRESS_MS = 380;
const DRAG_SLOP = 6;
const GUIDE_SEEN_KEY = "closedbot:oficina-guia-vista";
const HOMES_KEY = "closedbot:oficina-puestos";

/**
 * Dónde se sienta cada uno. El salón (Claude Bot) va primero; después, una plataforma por canal con un
 * escritorio para cada integrante (menos Claude Bot) y, si hay agentes sin grupo, la de «Sin grupo». Cada
 * agente tiene su plataforma de siempre: la del canal donde lo dejaste en la Oficina (`prefer`), si sigue en
 * él; si no, el primer canal que encarga o, si no, el primero en que está.
 */
export function planOffice({ agents, channels, mainId, prefer = null }) {
  const known = new Map(agents.map((agent) => [agent.id, agent]));
  const panels = [{ id: "hall", kind: "hall", title: "Claude Bot", channelId: null, members: 0, seats: [] }];
  if (mainId && known.has(mainId)) panels[0].seats.push({ agentId: mainId, kind: "boss", i: 0, j: 0 });
  const home = new Map();
  if (prefer) {
    for (const [agentId, channelId] of prefer) {
      if (agentId === mainId || !known.has(agentId)) continue;
      const channel = channels.find((item) => item.id === channelId);
      if (channel?.memberIds.includes(agentId)) home.set(agentId, channel.id);
    }
  }
  for (const channel of channels) {
    if (channel.leadId && channel.leadId !== mainId && known.has(channel.leadId) && !home.has(channel.leadId)) home.set(channel.leadId, channel.id);
  }
  for (const channel of channels) {
    for (const id of channel.memberIds) if (id !== mainId && known.has(id) && !home.has(id)) home.set(id, channel.id);
  }
  for (const channel of channels) {
    const members = channel.memberIds.filter((id) => id !== mainId && known.has(id));
    // El encargado, primero (en la esquina de adelante).
    members.sort((a, b) => (b === channel.leadId) - (a === channel.leadId));
    panels.push({
      id: `c:${channel.id}`,
      kind: "room",
      title: channel.name,
      topic: channel.topic ?? "",
      channelId: channel.id,
      leadId: channel.leadId,
      members: channel.memberIds.length,
      seats: platformSeats(members),
    });
  }
  const loose = agents.filter((agent) => agent.id !== mainId && !home.has(agent.id)).map((agent) => agent.id);
  if (loose.length) panels.push({ id: "loose", kind: "room", title: "Sin grupo", topic: "", channelId: null, leadId: null, members: loose.length, seats: platformSeats(loose) });
  return { panels, home };
}

/** Lado de la plataforma (en celdas) para `count` escritorios: crece con el equipo. */
export function platformSide(count) {
  return Math.max(2, Math.ceil(Math.sqrt(Math.max(1, count))));
}

/** Un escritorio por integrante, en filas de la plataforma (celda i, j desde la esquina de atrás). */
export function platformSeats(ids) {
  const side = platformSide(ids.length);
  return ids.map((agentId, index) => ({ agentId, kind: "desk", i: index % side, j: Math.floor(index / side) }));
}

/**
 * Qué pasa si sueltas a un agente sobre una plataforma: `ok` dice si se puede y `text`, lo que verá el usuario.
 * `from` es la plataforma de donde salió y `target`, la de abajo del puntero (o null).
 */
export function dropVerdict(name, from, target) {
  if (!target) return { ok: false, text: "Suéltalo sobre otro equipo" };
  if (target.kind === "hall") return { ok: false, text: "Ese es el salón de Claude Bot" };
  if (target.kind === "new") return { ok: true, text: `Armar un equipo nuevo con ${name}` };
  if (target.id === from?.id) return { ok: false, text: target.channelId ? `Ya está en «${target.title}»` : "Ya está sin grupo" };
  if (!target.channelId) {
    if (!from?.channelId) return { ok: false, text: "Ya está sin grupo" };
    return { ok: true, text: `Sacar a ${name} de «${from.title}»` };
  }
  if ((target.members ?? 0) >= MAX_MEMBERS) return { ok: false, text: `«${target.title}» ya tiene ${MAX_MEMBERS} agentes` };
  return { ok: true, text: `Mover a ${name} a «${target.title}»` };
}

/**
 * Color de una plataforma: con un solo agente, el de ese agente; un equipo de varios, el suyo (fijo por canal);
 * «Sin grupo» con varios, uno neutro. `agentColor(id)` da el color de un agente (o null si no se sabe).
 */
export function platformColor(spec, agentColor) {
  if (spec.kind === "hall") return HALL_COLOR;
  if (spec.seats?.length === 1) {
    const color = agentColor(spec.seats[0].agentId);
    if (color) return color;
  }
  if (spec.channelId) return NEON[hashText(spec.channelId) % NEON.length];
  return LOOSE_COLOR;
}

/** Punto relativo a la esquina de atrás de una plataforma → celda isométrica (i, j), con decimales. */
export function cellAt(dx, dy) {
  return { i: (dy / TILE_H + dx / TILE_W) / 2, j: (dy / TILE_H - dx / TILE_W) / 2 };
}

// ---------- utilidades ----------

function hashText(text) {
  let hash = 2166136261;
  for (const char of String(text)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function hexToRgb(hex) {
  const value = Number.parseInt(String(hex).replace("#", "").slice(0, 6), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function rgba(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const ICON_PATHS = {
  terminal: ["M5 7l4.5 5L5 17", "M12 17h7"],
  pencil: ["M5 19l1-4.2 9.6-9.6a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L9.2 18z", "M13.8 7l3.2 3.2"],
  globe: ["M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16", "M4 12h16", "M12 4c2.6 2.4 3.6 5 3.6 8s-1 5.6-3.6 8c-2.6-2.4-3.6-5-3.6-8s1-5.6 3.6-8z"],
  tool: ["M14.5 5.5a4 4 0 0 0-4.9 5.2l-5 5a1.8 1.8 0 0 0 2.6 2.6l5-5a4 4 0 0 0 5.2-4.9l-2.3 2.3-2.4-.5-.5-2.4z"],
  image: ["M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2z", "M4.5 16.5l4.3-4.3a1.5 1.5 0 0 1 2.1 0l5.6 5.6", "M15 7.8a1.3 1.3 0 1 0 0 2.6a1.3 1.3 0 1 0 0-2.6"],
  bookmark: ["M7 4.5h10v15l-5-3.6-5 3.6z"],
  team: ["M9.5 4.8a3.2 3.2 0 1 0 0 6.4a3.2 3.2 0 1 0 0-6.4", "M3.8 19c.6-3.2 3-5 5.7-5s5.1 1.8 5.7 5", "M18.5 8v6M15.5 11h6"],
  spark: ["M12 4.5l1.7 5.8 5.8 1.7-5.8 1.7-1.7 5.8-1.7-5.8-5.8-1.7 5.8-1.7z"],
  board: ["M4.5 5.5h15v10h-15z", "M8 19.5l2-4M16 19.5l-2-4", "M7.5 9h6M7.5 12h9"],
  hourglass: ["M7 4.5h10M7 19.5h10", "M8 4.5c0 4 4 5 4 7.5s-4 3.5-4 7.5", "M16 4.5c0 4-4 5-4 7.5s4 3.5 4 7.5"],
  plus: ["M12 6v12M6 12h12"],
};
const iconCache = new Map();

function iconPaths(name) {
  if (!iconCache.has(name)) iconCache.set(name, (ICON_PATHS[name] ?? []).map((d) => new Path2D(d)));
  return iconCache.get(name);
}

/** El ícono de una línea de actividad («Ejecutó: …», «Modificó: …»…). */
export function activityIcon(text, payload) {
  if (payload?.kind === "image") return "image";
  if (payload?.kind === "board-updated") return "board";
  if (payload?.kind === "agent-created" || payload?.kind === "agent-updated" || payload?.kind === "channel-created") return "team";
  if (payload?.kind === "memory-saved" || payload?.kind === "memory-deleted") return "bookmark";
  const value = String(text ?? "");
  if (/^Ejecut/i.test(value)) return "terminal";
  if (/^(Modific|Edit|Cre[oó] el archivo|Escribi)/i.test(value)) return "pencil";
  if (/^(Busc|Ley[oó] la p)/i.test(value)) return "globe";
  if (/^Us[oó]/i.test(value)) return "tool";
  if (/^Gener[oó] una imagen/i.test(value)) return "image";
  return "spark";
}

/** Celda isométrica (i, j) → punto en pantalla, desde la esquina de atrás de la plataforma. */
function iso(i, j) {
  return { x: (i - j) * TILE_W, y: (i + j) * TILE_H };
}

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

/** localStorage puede fallar (modo privado, almacenamiento bloqueado): la Oficina funciona igual sin él. */
const storage = {
  get(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Sin almacenamiento solo se pierde el recuerdo entre visitas.
    }
  },
};

// ---------- la oficina ----------

/**
 * `host` da los datos y acciones de la app: agents(), channels(), colorOf(agent), openAgent(id), openChannel(id),
 * openMain(), renderMarkdown(text, element), api(path), createAgent({ channelId }), createTeam(),
 * moveAgent(agentId, { from, to }), moveToNewTeam(agentId, from), agentMenu(agentId, place) y teamMenu(spec, place).
 */
export function createOffice(host) {
  const root = host.root;
  const scroller = root.querySelector(".office-scroll");
  const tip = root.querySelector(".office-tip");
  const boardView = root.querySelector(".office-board");
  const guide = root.querySelector(".office-guide");
  const emptyView = root.querySelector(".office-empty");
  const statusView = root.querySelector(".office-status");
  const helpButton = root.querySelector(".office-help");
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const canvas = document.createElement("canvas");
  canvas.className = "office-map";
  canvas.setAttribute("aria-hidden", "true");
  const lists = document.createElement("div");
  lists.className = "visually-hidden";
  scroller.replaceChildren(canvas, lists);
  const mapCtx = canvas.getContext("2d");
  /** Contexto donde se dibuja: el del mapa o, un momento, el de un ejemplo de la guía. */
  let ctx = mapCtx;

  const live = { board: "", activity: new Map(), asking: new Set(), failed: new Map(), typing: new Map() };
  /** Plataformas en el orden del plan, con su posición en el mundo. */
  let platforms = [];
  /** Dónde está cada agente: { agent, platform, seat }. */
  const robots = new Map();
  const pulses = [];
  const view = { width: 0, height: 0, client: 0, scale: 1, worldW: 0, worldH: 0, ox: 0, oy: 0, dpr: 1 };
  let visible = false;
  let raf = 0;
  let lastFrame = 0;
  let lastStatus = 0;
  let snapshotLoaded = false;
  let hovered = null;
  let seenMessages = new Set();
  let empty = false;

  // Lo que se toca y se arrastra.
  /** Un toque o clic que todavía no es arrastre: { pointerId, type, x, y, target, timer, menu }. */
  let press = null;
  /** El robot levantado: { agentId, from, client, pointer, target, verdict, touch, moved, startX, startY }. */
  let drag = null;
  /** Soltado, esperando al servidor (o el nombre del equipo nuevo): { agentId, point, color, lift }. */
  let pending = null;
  /** Vuelve volando a su escritorio: { agentId, point, lift, start }. */
  let returning = null;
  let suppressClickUntil = 0;

  // Llegadas: los agentes nuevos bajan con un haz de luz.
  const knownIds = new Set();
  let primed = false;
  const arrivals = new Map();
  let spotlight = null;
  /** El agente elegido: su chat y su ficha están abiertos junto a la Oficina. */
  let selectedId = null;

  /** El equipo donde dejaste a cada agente (para los que están en varios canales). */
  const prefer = new Map();
  try {
    for (const [agentId, channelId] of Object.entries(JSON.parse(storage.get(HOMES_KEY) ?? "{}"))) {
      if (typeof channelId === "string") prefer.set(agentId, channelId);
    }
  } catch {
    // Un valor dañado se ignora.
  }

  function remember(agentId, channelId) {
    if (channelId) prefer.set(agentId, channelId);
    else prefer.delete(agentId);
    const alive = new Set(host.agents().map((agent) => agent.id));
    for (const id of [...prefer.keys()]) if (!alive.has(id) && id !== agentId) prefer.delete(id);
    storage.set(HOMES_KEY, JSON.stringify(Object.fromEntries(prefer)));
  }

  // ---------- datos ----------

  async function loadSnapshot() {
    try {
      const data = await host.api("/api/office");
      live.board = data.board ?? "";
      live.activity = new Map(Object.entries(data.activity ?? {}));
      live.asking = new Set(data.asking ?? []);
      live.failed = new Map((data.failed ?? []).map((id) => [id, Date.now()]));
      snapshotLoaded = true;
      updateStatus();
    } catch {
      // Sin el resumen igual se ve la oficina: se completa con los eventos.
    }
  }

  // ---------- plataformas ----------

  function sync() {
    const agents = host.agents();
    const channels = host.channels();
    const main = agents.find((agent) => agent.main) ?? null;
    const plan = planOffice({ agents, channels, mainId: main?.id ?? null, prefer });
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    const agentColor = (id) => (byId.has(id) ? host.colorOf(byId.get(id)) : null);
    platforms = plan.panels.map((spec) => {
      const hall = spec.kind === "hall";
      const color = platformColor(spec, agentColor);
      return { ...spec, color, side: hall ? 2 : platformSide(spec.seats.length), x: 0, y: 0 };
    });
    empty = !agents.some((agent) => !agent.main);
    // La plataforma punteada: arma un equipo nuevo (o, sin agentes, crea el primero).
    if (empty || channels.length < MAX_TEAMS) {
      platforms.push({ id: "new", kind: "new", title: empty ? "Tu primer agente" : "Nuevo equipo", channelId: null, members: 0, seats: [], color: GHOST_COLOR, side: 2, x: 0, y: 0 });
    }
    // Cada agente en un solo puesto: el del canal para el que trabaja ahora o el de su plataforma de siempre.
    const workingIn = new Map();
    for (const channel of channels) for (const id of channel.working ?? []) if (!workingIn.has(id)) workingIn.set(id, `c:${channel.id}`);
    robots.clear();
    const now = performance.now();
    for (const agent of agents) {
      if (primed && !knownIds.has(agent.id) && !reducedMotion) arrivals.set(agent.id, now);
      knownIds.add(agent.id);
      const seats = [];
      for (const platform of platforms) for (const seat of platform.seats) if (seat.agentId === agent.id) seats.push({ platform, seat });
      if (!seats.length) continue;
      const target =
        seats.find((entry) => entry.platform.id === workingIn.get(agent.id)) ??
        seats.find((entry) => entry.platform.id === `c:${plan.home.get(agent.id)}`) ??
        seats[0];
      robots.set(agent.id, { agent: byId.get(agent.id), platform: target.platform, seat: target.seat, phase: (hashText(agent.id) % 1000) / 1000 });
    }
    primed = true;
    if (emptyView) emptyView.hidden = !empty;
    layout();
    if (drag && !robots.has(drag.agentId)) endDrag();
    if (drag) {
      // Se movió algo mientras arrastrabas: se recalcula sobre las plataformas nuevas.
      drag.from = robots.get(drag.agentId).platform;
      drag.pointer = toWorld(drag.client);
      retarget();
    }
    renderLists();
    updateStatus();
  }

  /** Tamaño en pantalla de una plataforma (sin la tarjeta). */
  function footprint(platform) {
    const w = platform.side * TILE_W * 2;
    const h = platform.side * TILE_H * 2 + THICK;
    return { w, h };
  }

  /** Ubica las plataformas en filas (con un desfase en zigzag) según el ancho disponible. */
  function layout() {
    const width = Math.max(280, scroller.clientWidth);
    let slotW = 0;
    let slotH = 0;
    for (const platform of platforms) {
      const { w, h } = footprint(platform);
      slotW = Math.max(slotW, w + 120, CARD_W + 2 * (ADD_R + 34));
      slotH = Math.max(slotH, h + CARD_H + 195);
    }
    const cols = Math.max(1, Math.min(3, Math.floor(width / (slotW * 0.62)), platforms.length));
    const shift = cols > 1 ? slotW * 0.32 : 0;
    const rows = Math.ceil(platforms.length / cols);
    platforms.forEach((platform, index) => {
      const row = Math.floor(index / cols);
      const col = index % cols;
      platform.cx = slotW * (col + 0.5) + (row % 2 ? shift : 0);
      platform.cy = slotH * row + CARD_H + 135 + footprint(platform).h / 2;
    });
    view.worldW = slotW * cols + shift;
    view.worldH = slotH * rows + 30;
    view.scale = Math.min(1.15, width / view.worldW);
    view.width = width;
    // Con la oficina vacía, la explicación ocupa el pie: el mapa deja lugar para que no la tape.
    const reserve = empty && emptyView ? Math.min(280, emptyView.offsetHeight + 48) : 0;
    view.client = scroller.clientHeight;
    view.height = Math.max(Math.ceil(view.worldH * view.scale) + reserve, view.client);
    view.ox = (width - view.worldW * view.scale) / 2;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${view.height}px`;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(view.height * dpr);
    view.dpr = dpr;
  }

  /** Esquina de atrás de la plataforma (su celda 0, 0) en el mundo. */
  function origin(platform) {
    return { x: platform.cx, y: platform.cy - (platform.side * TILE_H * 2 + THICK) / 2 };
  }

  /** Centro de una celda de la plataforma. */
  function cellPoint(platform, i, j) {
    const o = origin(platform);
    const p = iso(i + 0.5, j + 0.5);
    return { x: o.x + p.x, y: o.y + p.y };
  }

  function seatPoint(platform, seat) {
    if (platform.kind === "hall") return cellPoint(platform, 0.5, 0.5);
    return cellPoint(platform, seat.i, seat.j);
  }

  // ---------- estado de cada uno ----------

  function busy(agent) {
    return agent.state === "working" || live.asking.has(agent.id);
  }

  function teamOf(platform) {
    return platform.seats.map((seat) => robots.get(seat.agentId)).filter((robot) => robot && robot.platform === platform).map((robot) => robot.agent);
  }

  /** Qué hace el equipo, en pocas palabras (la línea de la tarjeta). */
  function teamStatus(platform) {
    const team = teamOf(platform);
    if (!team.length) return platform.channelId ? "Sin agentes: suma uno con +" : "Sin agentes aquí";
    if (team.some((agent) => live.asking.has(agent.id))) return "Te hizo una pregunta";
    const working = team.filter((agent) => agent.state === "working");
    if (working.length) {
      let latest = null;
      for (const agent of working) {
        const activity = live.activity.get(agent.id);
        if (activity && (!latest || activity.at > latest.at)) latest = activity;
      }
      if (latest && Date.now() - latest.at < 120_000) return latest.text;
      if (platform.kind === "hall") return "Trabajando";
      return working.length === 1 ? `${working[0].name} trabajando` : `${working.length} trabajando`;
    }
    if (team.some((agent) => agent.state === "queued")) return "Encargos en cola";
    if (team.every((agent) => agent.state === "paused")) return "En pausa";
    return "Libre";
  }

  /** Avance del equipo: el promedio de lo que informaron sus agentes (o el de Claude Bot en su plataforma). */
  function teamProgress(platform) {
    const values = teamOf(platform)
      .map((agent) => visibleProgress(agent))
      .filter(Boolean)
      .map((progress) => progress.percent);
    if (!values.length) return null;
    return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  }

  /** Cómo se ve un robot según lo que hace (los ejemplos de la guía pasan uno inventado). */
  function lookOf(agent) {
    const failedAt = live.failed.get(agent.id);
    const working = agent.state === "working";
    let icon = null;
    if (working) {
      const activity = live.activity.get(agent.id);
      const typing = live.typing.get(agent.id) ?? 0;
      if (activity && Date.now() - activity.at < 9000 && (!typing || activity.at >= typing - 400)) icon = activity.icon ?? activityIcon(activity.text);
    }
    return {
      working,
      paused: agent.state === "paused",
      queued: agent.state === "queued",
      asking: live.asking.has(agent.id),
      failed: Boolean(failedAt && Date.now() - failedAt < 45_000),
      progress: visibleProgress(agent),
      icon,
      eye: host.colorOf(agent),
    };
  }

  /** La línea del encabezado: cuántos son y qué está pasando. */
  function updateStatus() {
    if (!statusView || !visible) return;
    const agents = host.agents();
    const others = agents.filter((agent) => !agent.main);
    let text = "";
    if (others.length) {
      const teams = host.channels().length;
      const parts = [`${others.length} ${others.length === 1 ? "agente" : "agentes"}`];
      if (teams) parts.unshift(`${teams} ${teams === 1 ? "equipo" : "equipos"}`);
      const working = agents.filter((agent) => agent.state === "working").length;
      const asking = agents.filter((agent) => live.asking.has(agent.id)).length;
      if (working) parts.push(`${working} trabajando`);
      if (asking) parts.push(asking === 1 ? "1 pregunta para ti" : `${asking} preguntas para ti`);
      if (!working && !asking) parts.push("todos libres");
      text = parts.join(" · ");
    }
    if (statusView.textContent !== text) statusView.textContent = text;
  }

  // ---------- dibujo ----------

  function draw(now) {
    const t = reducedMotion ? 0 : now;
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    drawBackground(t);
    ctx.save();
    ctx.translate(view.ox, 0);
    ctx.scale(view.scale, view.scale);
    drawLinks(t);
    for (const platform of platforms) {
      if (platform.kind === "new") drawGhost(platform, t);
      else drawPlatform(platform, t, now);
    }
    drawPulses(now);
    for (const platform of platforms) {
      if (platform.kind === "new") drawGhostCard(platform, t);
      else drawCard(platform, t);
    }
    if (returning) drawReturning(now, t);
    if (pending) drawFloating(pending.agentId, pending.point, pending.color, t, pending.lift, true);
    if (drag?.lifted) drawFloating(drag.agentId, drag.pointer, drag.verdict?.ok ? drag.target.color : null, t, liftOf(drag), false);
    ctx.restore();
  }

  function drawBackground(t) {
    const w = view.width;
    const h = view.height;
    const gradient = ctx.createRadialGradient(w * 0.5, h * 0.35, 0, w * 0.5, h * 0.35, Math.max(w, h) * 0.85);
    gradient.addColorStop(0, "#1b2366");
    gradient.addColorStop(0.55, "#0f1442");
    gradient.addColorStop(1, "#070a24");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
    // Puntos tenues, como polvo de estrellas.
    ctx.fillStyle = "rgba(160, 185, 255, 0.10)";
    const step = 28;
    for (let y = 8; y < h; y += step) {
      for (let x = 8 + ((y / step) % 2) * (step / 2); x < w; x += step) {
        const k = hashText(`${x},${y}`) % 7;
        if (k > 1) continue;
        ctx.globalAlpha = 0.6 + 0.4 * Math.sin(t / 900 + x * 0.05 + y * 0.03);
        ctx.fillRect(x, y, 1.6, 1.6);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Líneas punteadas del salón a cada equipo. */
  function drawLinks(t) {
    const hall = platforms.find((platform) => platform.kind === "hall");
    if (!hall) return;
    for (const platform of platforms) {
      if (platform === hall || platform.kind === "new") continue;
      const active = teamOf(platform).some(busy);
      const path = linkPath(hall, platform);
      ctx.save();
      ctx.setLineDash([3, 9]);
      ctx.lineDashOffset = active ? -t / 40 : 0;
      ctx.lineCap = "round";
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = active ? rgba(platform.color, 0.55) : "rgba(150, 170, 255, 0.28)";
      ctx.beginPath();
      ctx.moveTo(path.a.x, path.a.y);
      ctx.quadraticCurveTo(path.c.x, path.c.y, path.b.x, path.b.y);
      ctx.stroke();
      ctx.restore();
      // Un nodo a mitad de camino.
      const mid = quad(path, 0.5);
      ctx.fillStyle = active ? rgba(platform.color, 0.9) : "rgba(190, 205, 255, 0.55)";
      ctx.beginPath();
      ctx.arc(mid.x, mid.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function linkPath(from, to) {
    const a = { x: from.cx, y: from.cy };
    const b = { x: to.cx, y: to.cy };
    const c = { x: (a.x + b.x) / 2 + (b.y - a.y) * 0.12, y: (a.y + b.y) / 2 - Math.abs(b.x - a.x) * 0.12 };
    return { a, b, c };
  }

  function quad(path, k) {
    const u = 1 - k;
    return {
      x: u * u * path.a.x + 2 * u * k * path.c.x + k * k * path.b.x,
      y: u * u * path.a.y + 2 * u * k * path.c.y + k * k * path.b.y,
    };
  }

  /** Las cuatro esquinas de la cara de arriba de una plataforma. */
  function corners(platform) {
    const o = origin(platform);
    const s = platform.side;
    return {
      top: { x: o.x, y: o.y },
      right: { x: o.x + s * TILE_W, y: o.y + s * TILE_H },
      bottom: { x: o.x, y: o.y + s * TILE_H * 2 },
      left: { x: o.x - s * TILE_W, y: o.y + s * TILE_H },
    };
  }

  function diamond({ top, right, bottom, left }, dy = 0) {
    ctx.beginPath();
    ctx.moveTo(top.x, top.y + dy);
    ctx.lineTo(right.x, right.y + dy);
    ctx.lineTo(bottom.x, bottom.y + dy);
    ctx.lineTo(left.x, left.y + dy);
    ctx.closePath();
  }

  /** Mientras arrastras: «target» es donde lo soltarías, «candidate» otro lugar posible. */
  function dropMode(platform) {
    if (!drag?.lifted) return null;
    // Sobre su propio equipo no pasa nada: ni verde ni rojo.
    if (platform.id === drag.from?.id) return null;
    if (drag.target === platform) return drag.verdict.ok ? "target" : "blocked";
    if (platform.kind === "hall") return null;
    return dropVerdict("", drag.from, platform).ok ? "candidate" : null;
  }

  function drawPlatform(platform, t, now) {
    const o = origin(platform);
    const s = platform.side;
    const { top, right, bottom, left } = corners(platform);
    const color = platform.color;
    const active = teamOf(platform).some(busy);
    const hall = platform.kind === "hall";
    const mode = dropMode(platform);

    // Órbita alrededor de Claude Bot y de los equipos que trabajan.
    if (hall || active) {
      const rx = s * TILE_W * (hall ? 1.45 : 1.22);
      const ry = rx * 0.5;
      ctx.save();
      ctx.strokeStyle = rgba(color, hall ? 0.35 : 0.22);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(platform.cx, platform.cy + THICK / 2, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
      const start = (t / 1600) % (Math.PI * 2);
      ctx.strokeStyle = rgba(color, 0.85);
      ctx.lineWidth = 2.5;
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.ellipse(platform.cx, platform.cy + THICK / 2, rx, ry, 0, start, start + 0.7);
      ctx.stroke();
      ctx.restore();
    }

    // Grosor (las dos caras de adelante).
    ctx.fillStyle = rgba(color, 0.32);
    ctx.beginPath();
    ctx.moveTo(left.x, left.y);
    ctx.lineTo(bottom.x, bottom.y);
    ctx.lineTo(bottom.x, bottom.y + THICK);
    ctx.lineTo(left.x, left.y + THICK);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = rgba(color, 0.2);
    ctx.beginPath();
    ctx.moveTo(bottom.x, bottom.y);
    ctx.lineTo(right.x, right.y);
    ctx.lineTo(right.x, right.y + THICK);
    ctx.lineTo(bottom.x, bottom.y + THICK);
    ctx.closePath();
    ctx.fill();

    // La cara de arriba, translúcida, con su cuadrícula (más clara si es donde soltarías al robot).
    const lift = mode === "target" ? 0.16 : mode === "candidate" ? 0.06 + 0.04 * Math.sin(t / 260) : 0;
    const face = ctx.createLinearGradient(left.x, top.y, right.x, bottom.y);
    face.addColorStop(0, rgba(color, 0.2 + lift));
    face.addColorStop(1, rgba(color, 0.07 + lift));
    ctx.fillStyle = face;
    diamond({ top, right, bottom, left });
    ctx.fill();
    ctx.strokeStyle = rgba(color, 0.16);
    ctx.lineWidth = 1;
    for (let k = 1; k < s * 2; k += 1) {
      const a = iso(k / 2, 0);
      const b = iso(k / 2, s);
      const c = iso(0, k / 2);
      const d = iso(s, k / 2);
      ctx.beginPath();
      ctx.moveTo(o.x + a.x, o.y + a.y);
      ctx.lineTo(o.x + b.x, o.y + b.y);
      ctx.moveTo(o.x + c.x, o.y + c.y);
      ctx.lineTo(o.x + d.x, o.y + d.y);
      ctx.stroke();
    }
    // Borde de neón.
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = mode === "target" ? 34 : active ? 22 : 14;
    ctx.strokeStyle = mode === "blocked" ? "rgba(255, 120, 130, 0.9)" : color;
    ctx.lineWidth = mode === "target" ? 4 : 2.6;
    diamond({ top, right, bottom, left });
    ctx.stroke();
    ctx.lineWidth = 1.4;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.moveTo(left.x, left.y + THICK);
    ctx.lineTo(bottom.x, bottom.y + THICK);
    ctx.lineTo(right.x, right.y + THICK);
    ctx.stroke();
    ctx.restore();

    // Escritorios y robots, de atrás hacia adelante.
    const seats = [...platform.seats].sort((a, b) => a.i + a.j - (b.i + b.j));
    for (const seat of seats) {
      const point = seatPoint(platform, seat);
      const robot = robots.get(seat.agentId);
      const away = drag?.lifted && drag.agentId === seat.agentId;
      const gone = pending?.agentId === seat.agentId || returning?.agentId === seat.agentId;
      const here = robot && robot.platform === platform && !away && !gone ? robot : null;
      drawSeat(platform, point, here, t, hall, now);
    }
  }

  function drawSeat(platform, point, robot, t, hall, now) {
    const color = platform.color;
    const working = robot && robot.agent.state === "working";
    // El robot va detrás de su escritorio.
    if (robot) {
      if (robot.agent.id === selectedId) drawSelection(point, color, t);
      const arrived = arrivals.get(robot.agent.id);
      const k = arrived === undefined ? 1 : Math.min(1, (now - arrived) / 1300);
      if (k < 1) drawBeam(point, color, k);
      const drop = k < 1 ? (1 - easeOut(k)) * 150 : 0;
      ctx.save();
      if (k < 1) ctx.globalAlpha = Math.min(1, k * 2.2);
      drawRobot(robot, { x: point.x, y: point.y - 4 - drop }, color, t);
      ctx.restore();
      if (arrived !== undefined && k >= 1) {
        if (now - arrived > 9000) arrivals.delete(robot.agent.id);
        else drawNewTag(point, color, now - arrived);
      }
      if (spotlight?.agentId === robot.agent.id) drawSpotlight(robot, color, now);
    }
    drawDesk(point, color, working, Boolean(robot), t, hall);
  }

  /** El agente elegido: un aro blanco en el piso, bajo su escritorio. */
  function drawSelection(point, color, t) {
    const pulse = t ? 0.5 + 0.5 * Math.sin(t / 420) : 1;
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 16;
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.75 + 0.25 * pulse})`;
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.ellipse(point.x, point.y + 18, 44, 22, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = rgba(color, 0.14 + 0.08 * pulse);
    ctx.fill();
    ctx.restore();
  }

  /** El haz de luz con el que llega un agente nuevo. */
  function drawBeam(point, color, k) {
    const fade = k < 0.75 ? 1 : 1 - (k - 0.75) / 0.25;
    const top = point.y - 260;
    const gradient = ctx.createLinearGradient(0, top, 0, point.y + 10);
    gradient.addColorStop(0, rgba(color, 0));
    gradient.addColorStop(0.7, rgba(color, 0.32 * fade));
    gradient.addColorStop(1, rgba("#ffffff", 0.5 * fade));
    ctx.save();
    ctx.fillStyle = gradient;
    ctx.fillRect(point.x - 22, top, 44, point.y + 10 - top);
    ctx.strokeStyle = rgba(color, 0.8 * fade);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(point.x, point.y + 2, 26 + k * 10, 13 + k * 5, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /** «Nuevo» bajo el escritorio del agente que acaba de llegar, unos segundos. */
  function drawNewTag(point, color, age) {
    const alpha = age > 7500 ? Math.max(0, 1 - (age - 7500) / 1500) : 1;
    const x = point.x;
    const y = point.y + 62;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `800 11px ${FONT}`;
    const w = ctx.measureText("NUEVO").width + 14;
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    roundRect(ctx, x - w / 2, y - 9, w, 17, 8.5);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = "#0b1036";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("NUEVO", x, y + 0.5);
    ctx.restore();
  }

  /** Un anillo que late alrededor del agente que acabas de crear o de mover. */
  function drawSpotlight(robot, color, now) {
    const age = now - spotlight.start;
    if (age > 4200) {
      spotlight = null;
      return;
    }
    if (!robot.box) return;
    const x = robot.box.left + robot.box.w / 2;
    const y = robot.box.top + robot.box.h - 8;
    const k = (age % 1400) / 1400;
    ctx.save();
    ctx.strokeStyle = rgba(color, 0.9 * (1 - k));
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.ellipse(x, y, 22 + k * 30, (22 + k * 30) / 2, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /** Escritorio: un bloque isométrico azul con la pantalla del color del equipo. */
  function drawDesk(point, color, working, occupied, t, hall) {
    const w = hall ? 66 : 54;
    const d = hall ? 33 : 27;
    const h = 15;
    const cx = point.x;
    const cy = point.y + 20;
    const topFace = [
      { x: cx, y: cy - d / 2 },
      { x: cx + w / 2, y: cy },
      { x: cx, y: cy + d / 2 },
      { x: cx - w / 2, y: cy },
    ];
    ctx.save();
    ctx.globalAlpha = occupied ? 1 : 0.55;
    ctx.fillStyle = "#1b2a9e";
    ctx.beginPath();
    ctx.moveTo(topFace[3].x, topFace[3].y);
    ctx.lineTo(topFace[2].x, topFace[2].y);
    ctx.lineTo(topFace[2].x, topFace[2].y + h);
    ctx.lineTo(topFace[3].x, topFace[3].y + h);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#14207c";
    ctx.beginPath();
    ctx.moveTo(topFace[2].x, topFace[2].y);
    ctx.lineTo(topFace[1].x, topFace[1].y);
    ctx.lineTo(topFace[1].x, topFace[1].y + h);
    ctx.lineTo(topFace[2].x, topFace[2].y + h);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#2c43d6";
    ctx.beginPath();
    ctx.moveTo(topFace[0].x, topFace[0].y);
    for (const corner of topFace.slice(1)) ctx.lineTo(corner.x, corner.y);
    ctx.closePath();
    ctx.fill();
    // Pantalla.
    const flicker = working ? 0.75 + 0.25 * Math.sin(t / 140 + cx) : occupied ? 0.65 : 0.25;
    ctx.fillStyle = rgba(color, flicker);
    ctx.shadowColor = color;
    ctx.shadowBlur = working ? 12 : 4;
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.2, cy - d * 0.05);
    ctx.lineTo(cx + w * 0.12, cy - d * 0.05 + w * 0.16);
    ctx.lineTo(cx + w * 0.12, cy - d * 0.05 + w * 0.16 - 13);
    ctx.lineTo(cx - w * 0.2, cy - d * 0.05 - 13);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /** Robot: cuerpo y cabeza blancos, visor oscuro con los ojos del color del agente y una antena. */
  function drawRobot(robot, base, color, t, look = lookOf(robot.agent)) {
    const eye = look.eye || color;
    const { working, paused, asking, failed } = look;
    const boss = robot.seat.kind === "boss";
    const k = boss ? 1.85 : 1.5;
    const bob = look.lifted ? Math.sin(t / 160) * 2.2 : working && t ? Math.sin(t / 220 + robot.phase * 6) * 1.6 : t ? Math.sin(t / 900 + robot.phase * 6) * 0.8 : 0;
    const x = base.x;
    const y = base.y + bob;

    // Ondas bajo el que trabaja.
    if (working && t && !look.lifted) {
      for (let index = 0; index < 2; index += 1) {
        const phase = (t / 1400 + index / 2 + robot.phase) % 1;
        ctx.strokeStyle = rgba(color, 0.55 * (1 - phase));
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(base.x, base.y + 4, 20 + phase * 34, (20 + phase * 34) / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.save();
    if (paused) ctx.globalAlpha *= 0.55;
    // Sombra (la del que está levantado queda abajo, en el piso).
    ctx.fillStyle = "rgba(5, 8, 30, 0.45)";
    ctx.beginPath();
    ctx.ellipse(base.x, base.y + (look.lifted ? 26 : 4), 11 * k, 5 * k, 0, 0, Math.PI * 2);
    ctx.fill();
    // Cuerpo.
    const body = ctx.createLinearGradient(x - 9 * k, 0, x + 9 * k, 0);
    body.addColorStop(0, "#ffffff");
    body.addColorStop(1, "#c9d4f2");
    ctx.fillStyle = body;
    roundRect(ctx, x - 8 * k, y - 20 * k, 16 * k, 20 * k, 7 * k);
    ctx.fill();
    // Franja del pecho, del color del equipo.
    ctx.fillStyle = rgba(color, working ? 0.95 : 0.6);
    roundRect(ctx, x - 5 * k, y - 12 * k, 10 * k, 3 * k, 1.5 * k);
    ctx.fill();
    // Cabeza.
    const headY = y - 37 * k;
    const head = ctx.createLinearGradient(x - 11 * k, 0, x + 11 * k, 0);
    head.addColorStop(0, "#ffffff");
    head.addColorStop(1, "#d3dcf5");
    ctx.fillStyle = head;
    roundRect(ctx, x - 11 * k, headY, 22 * k, 17 * k, 7 * k);
    ctx.fill();
    // Antena.
    ctx.strokeStyle = "#c9d4f2";
    ctx.lineWidth = 1.6 * k;
    ctx.beginPath();
    ctx.moveTo(x, headY);
    ctx.lineTo(x, headY - 5 * k);
    ctx.stroke();
    ctx.fillStyle = working ? eye : "#9fb0e0";
    if (working) {
      ctx.shadowColor = eye;
      ctx.shadowBlur = 8;
    }
    ctx.beginPath();
    ctx.arc(x, headY - 6 * k, 2.2 * k, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    // Visor y ojos.
    ctx.fillStyle = "#18204a";
    roundRect(ctx, x - 8 * k, headY + 5 * k, 16 * k, 7.5 * k, 3.5 * k);
    ctx.fill();
    const blink = t && (t / 1000 + robot.phase * 7) % 4 < 0.12;
    ctx.fillStyle = paused ? "#56608a" : eye;
    ctx.shadowColor = eye;
    ctx.shadowBlur = paused ? 0 : 6;
    if (paused || blink) {
      ctx.fillRect(x - 5 * k, headY + 8.5 * k, 3.5 * k, 1 * k);
      ctx.fillRect(x + 1.5 * k, headY + 8.5 * k, 3.5 * k, 1 * k);
    } else {
      roundRect(ctx, x - 5 * k, headY + 7 * k, 3.5 * k, 3.5 * k, 1 * k);
      ctx.fill();
      roundRect(ctx, x + 1.5 * k, headY + 7 * k, 3.5 * k, 3.5 * k, 1 * k);
      ctx.fill();
    }
    ctx.restore();

    robot.box = { left: x - 13 * k, top: headY - 9 * k, w: 26 * k, h: y - headY + 14 * k };
    robot.head = { x, y: headY - 8 * k };
    if (look.lifted) return;

    // Encima: avance, «?», «!», zzz o lo que hace.
    let top = robot.head.y;
    if (look.progress) {
      drawMiniProgress(x, top - 4, look.progress, color);
      top -= 18;
    }
    if (asking) bubble(x + 14 * k, top + 2, 26, { text: "?", fill: "#ffd23f", ink: "#2a2100", pulse: t });
    else if (failed) bubble(x + 14 * k, top + 2, 26, { text: "!", fill: "#ff5d6c", ink: "#fff", pulse: t });
    else if (paused) drawZzz(x + 8 * k, top + 4, 20, t);
    else if (look.queued) bubble(x + 14 * k, top + 2, 26, { icon: "hourglass", fill: "#e9eeff", ink: "#26306b" });
    else if (working) {
      if (look.icon) bubble(x + 14 * k, top + 2, 26, { icon: look.icon, fill: "#e9eeff", ink: "#26306b" });
      else bubble(x + 14 * k, top + 2, 26, { dots: t || 1, fill: "#e9eeff", ink: "#26306b" });
    }
  }

  function drawMiniProgress(x, y, progress, color) {
    const w = 46;
    const h = 8;
    const done = progress.percent >= 100;
    ctx.save();
    ctx.fillStyle = "rgba(8, 12, 40, 0.85)";
    roundRect(ctx, x - w / 2 - 1.5, y - h - 1.5, w + 3, h + 3, 4);
    ctx.fill();
    ctx.fillStyle = "rgba(255, 255, 255, 0.12)";
    roundRect(ctx, x - w / 2, y - h, w, h, 3);
    ctx.fill();
    if (progress.percent > 0) {
      ctx.fillStyle = done ? "#3ee07a" : color;
      ctx.shadowColor = done ? "#3ee07a" : color;
      ctx.shadowBlur = 6;
      roundRect(ctx, x - w / 2, y - h, Math.max(h, (w * progress.percent) / 100), h, 3);
      ctx.fill();
    }
    ctx.restore();
  }

  function bubble(x, y, size, options) {
    const pulse = options.pulse ? 1 + Math.sin(options.pulse / 220) * 0.06 : 1;
    const w = size * pulse;
    const h = size * pulse;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = options.fill;
    ctx.shadowColor = options.fill;
    ctx.shadowBlur = 8;
    roundRect(ctx, -w / 2, -h, w, h * 0.86, h * 0.32);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.moveTo(-w * 0.22, -h * 0.16);
    ctx.lineTo(-w * 0.36, h * 0.06);
    ctx.lineTo(-w * 0.02, -h * 0.16);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = options.ink;
    ctx.strokeStyle = options.ink;
    if (options.text) {
      ctx.font = `800 ${h * 0.62}px ${FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(options.text, 0, -h * 0.55);
    } else if (options.icon) {
      const k = (h * 0.6) / 24;
      ctx.translate(-12 * k, -h * 0.57 - 12 * k);
      ctx.scale(k, k);
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (const path of iconPaths(options.icon)) ctx.stroke(path);
    } else if (options.dots) {
      for (let index = 0; index < 3; index += 1) {
        const phase = (options.dots / 300 + index * 0.33) % 1;
        ctx.globalAlpha = 0.35 + 0.65 * Math.max(0, Math.sin(phase * Math.PI));
        ctx.beginPath();
        ctx.arc((index - 1) * w * 0.24, -h * 0.57, w * 0.075, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawZzz(x, y, size, t) {
    ctx.save();
    ctx.font = `800 ${size * 0.55}px ${FONT}`;
    ctx.textAlign = "left";
    for (let index = 0; index < 3; index += 1) {
      const phase = ((t || 0) / 1400 + index / 3) % 1;
      ctx.globalAlpha = t ? Math.sin(phase * Math.PI) : 0.8 - index * 0.25;
      ctx.fillStyle = "#cfe0ff";
      ctx.fillText("z", x + phase * size * 0.6, y - phase * size * 1.2);
    }
    ctx.restore();
  }

  /** Tarjeta de cristal sobre la plataforma: nombre, cuántos son, qué hacen y su avance; al lado, el «+». */
  function drawCard(platform, t) {
    const o = origin(platform);
    const hall = platform.kind === "hall";
    const x = platform.cx - CARD_W / 2;
    const y = o.y - CARD_H - 115;
    const color = platform.color;
    const team = teamOf(platform);
    const progress = teamProgress(platform);
    const asking = team.some((agent) => live.asking.has(agent.id));
    const working = team.some((agent) => agent.state === "working");
    platform.card = { x, y, w: CARD_W, h: CARD_H };

    // Hilo punteado de la tarjeta a la plataforma.
    ctx.save();
    ctx.setLineDash([2, 4]);
    ctx.strokeStyle = rgba(color, 0.5);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(platform.cx, y + CARD_H);
    ctx.lineTo(platform.cx, o.y - 8);
    ctx.stroke();
    ctx.restore();

    const hot = hovered?.platform === platform && (hovered.kind === "channel" || hovered.kind === "board" || hovered.kind === "loose");
    ctx.save();
    ctx.shadowColor = rgba(color, hot ? 0.9 : 0.6);
    ctx.shadowBlur = hot ? 24 : 16;
    ctx.fillStyle = hot ? "rgba(16, 22, 64, 0.94)" : "rgba(9, 13, 42, 0.88)";
    roundRect(ctx, x, y, CARD_W, CARD_H, 10);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = rgba(color, 0.9);
    ctx.lineWidth = hot ? 2 : 1.4;
    roundRect(ctx, x, y, CARD_W, CARD_H, 10);
    ctx.stroke();
    // Barra de color a la izquierda.
    ctx.fillStyle = color;
    roundRect(ctx, x + 7, y + 10, 4, CARD_H - 20, 2);
    ctx.fill();
    // Punto de estado.
    ctx.fillStyle = asking ? "#ffd23f" : working ? "#3ee07a" : "#5d6794";
    if (working || asking) {
      ctx.shadowColor = ctx.fillStyle;
      ctx.shadowBlur = 8;
    }
    ctx.beginPath();
    ctx.arc(x + CARD_W - 14, y + 15, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    // Textos.
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#ffffff";
    ctx.font = `700 15px ${FONT}`;
    ctx.fillText(clipText(ctx, platform.title, CARD_W - 46), x + 19, y + 22);
    const count = team.length;
    const who = hall ? "Coordina" : `${count} ${count === 1 ? "agente" : "agentes"}`;
    ctx.fillStyle = rgba(color, 0.95);
    ctx.font = `500 12px ${FONT}`;
    ctx.fillText(clipText(ctx, `${who} · ${teamStatus(platform)}`, CARD_W - 30), x + 19, y + 39);
    // Avance del equipo.
    const barX = x + 19;
    const barW = CARD_W - 64;
    const barY = y + CARD_H - 13;
    ctx.fillStyle = "rgba(255, 255, 255, 0.1)";
    roundRect(ctx, barX, barY, barW, 4, 2);
    ctx.fill();
    if (progress !== null) {
      ctx.fillStyle = progress >= 100 ? "#3ee07a" : color;
      ctx.shadowColor = ctx.fillStyle;
      ctx.shadowBlur = 6;
      roundRect(ctx, barX, barY, Math.max(4, (barW * progress) / 100), 4, 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#dfe6ff";
      ctx.font = `700 11px ${FONT}`;
      ctx.textAlign = "right";
      ctx.fillText(progress >= 100 ? "Listo" : `${progress} %`, x + CARD_W - 11, barY + 5);
    } else if (hall) {
      // La pizarra siempre se nombra: así se sabe que está ahí (más clara si tiene un plan).
      ctx.fillStyle = live.board.trim() ? "#dfe6ff" : "#7f8bbd";
      ctx.font = `600 11px ${FONT}`;
      ctx.textAlign = "right";
      ctx.fillText(live.board.trim() ? "Pizarra ›" : "Pizarra", x + CARD_W - 11, barY + 5);
    }
    ctx.textAlign = "left";

    // «+»: crear un agente en este equipo (o sin equipo, en «Sin grupo»).
    platform.add = null;
    if (!hall && (!platform.channelId || (platform.members ?? 0) < MAX_MEMBERS)) {
      const add = { x: x + CARD_W + ADD_R + 10, y: y + CARD_H / 2, r: ADD_R };
      platform.add = add;
      drawAddButton(add, color, hovered?.kind === "add" && hovered.platform === platform, t);
    }
  }

  function drawAddButton(add, color, hot, t) {
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = hot ? 18 : 8;
    ctx.fillStyle = hot ? rgba(color, 0.95) : "rgba(9, 13, 42, 0.92)";
    ctx.beginPath();
    ctx.arc(add.x, add.y, add.r * (hot ? 1.08 : 1), 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = rgba(color, 0.95);
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.strokeStyle = hot ? "#0b1036" : color;
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(add.x - 5.5, add.y);
    ctx.lineTo(add.x + 5.5, add.y);
    ctx.moveTo(add.x, add.y - 5.5);
    ctx.lineTo(add.x, add.y + 5.5);
    ctx.stroke();
    ctx.restore();
    void t;
  }

  /** La plataforma punteada: se toca para armar un equipo (o crear el primer agente) y recibe robots. */
  function drawGhost(platform, t) {
    const shape = corners(platform);
    const mode = dropMode(platform);
    const hot = mode === "target" || (hovered?.platform === platform && hovered.kind === "ghost");
    const color = platform.color;
    ctx.save();
    ctx.fillStyle = rgba(color, mode === "target" ? 0.2 : hot ? 0.1 : mode === "candidate" ? 0.07 + 0.04 * Math.sin(t / 260) : 0.04);
    diamond(shape);
    ctx.fill();
    ctx.setLineDash([9, 8]);
    ctx.lineDashOffset = drag?.lifted || hot ? -t / 50 : 0;
    ctx.strokeStyle = rgba(color, mode === "target" ? 0.95 : hot || mode === "candidate" ? 0.75 : 0.42);
    ctx.lineWidth = mode === "target" ? 3 : 2;
    if (mode === "target") {
      ctx.shadowColor = color;
      ctx.shadowBlur = 24;
    }
    diamond(shape);
    ctx.stroke();
    ctx.restore();
    // Un «+» grande en el medio.
    const cx = platform.cx;
    const cy = shape.left.y;
    const breathe = drag?.lifted || reducedMotion ? 1 : 1 + 0.04 * Math.sin(t / 500);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(breathe, breathe);
    ctx.fillStyle = rgba(color, hot ? 0.3 : 0.14);
    ctx.strokeStyle = rgba(color, hot ? 1 : 0.7);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, 0, 30, 15, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.lineCap = "round";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-9, 0);
    ctx.lineTo(9, 0);
    ctx.moveTo(0, -7);
    ctx.lineTo(0, 7);
    ctx.stroke();
    ctx.restore();
  }

  function drawGhostCard(platform, t) {
    const o = origin(platform);
    const x = platform.cx - CARD_W / 2;
    const y = o.y - CARD_H - 115;
    const color = platform.color;
    const mode = dropMode(platform);
    const hot = mode === "target" || (hovered?.platform === platform && hovered.kind === "ghost");
    platform.card = { x, y, w: CARD_W, h: CARD_H };
    ctx.save();
    ctx.setLineDash([2, 4]);
    ctx.strokeStyle = rgba(color, 0.35);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(platform.cx, y + CARD_H);
    ctx.lineTo(platform.cx, o.y - 8);
    ctx.stroke();
    ctx.setLineDash([6, 5]);
    ctx.lineDashOffset = hot ? -t / 50 : 0;
    ctx.fillStyle = hot ? "rgba(16, 22, 64, 0.9)" : "rgba(9, 13, 42, 0.6)";
    roundRect(ctx, x, y, CARD_W, CARD_H, 10);
    ctx.fill();
    ctx.strokeStyle = rgba(color, hot ? 0.95 : 0.55);
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.restore();
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "#ffffff";
    ctx.font = `700 15px ${FONT}`;
    ctx.fillText(`+ ${platform.title}`, x + 16, y + 25);
    ctx.fillStyle = rgba(color, 0.95);
    ctx.font = `500 12px ${FONT}`;
    const hint = empty ? "Toca para crearlo" : drag?.lifted ? "Suelta aquí para armarlo" : "Toca o arrastra un agente aquí";
    ctx.fillText(clipText(ctx, hint, CARD_W - 30), x + 16, y + 44);
  }

  /** Con el dedo, el robot va un poco más arriba para que se vea; con el mouse, el puntero lo toma del pecho. */
  function liftOf(current) {
    return current.touch ? -14 : 30;
  }

  /** El robot que llevas con el puntero (o que espera, ya soltado, a que el servidor responda). */
  function drawFloating(agentId, point, color, t, lift, waiting) {
    const robot = robots.get(agentId);
    if (!robot) return;
    const tint = color ?? robot.platform.color;
    const base = { x: point.x, y: point.y + lift };
    if (waiting) {
      const k = ((t || 0) % 1200) / 1200;
      ctx.save();
      ctx.strokeStyle = rgba(tint, 0.8 * (1 - k));
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(base.x, base.y + 26, 18 + k * 22, (18 + k * 22) / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    const copy = { ...robot, seat: { kind: "desk" } };
    drawRobot(copy, base, tint, t, { ...lookOf(robot.agent), lifted: true });
  }

  /** Lo soltaste donde no se puede: vuelve a su escritorio. */
  function drawReturning(now, t) {
    const robot = robots.get(returning.agentId);
    const k = Math.min(1, (now - returning.start) / 260);
    if (!robot || k >= 1) {
      returning = null;
      return;
    }
    const seat = seatPoint(robot.platform, robot.seat);
    const e = easeOut(k);
    const from = { x: returning.point.x, y: returning.point.y + returning.lift };
    const point = { x: from.x + (seat.x - from.x) * e, y: from.y + (seat.y - 4 - from.y) * e };
    const copy = { ...robot, seat: { kind: "desk" } };
    drawRobot(copy, point, robot.platform.color, t, { ...lookOf(robot.agent), lifted: true });
  }

  // ---------- encargos entre compañeros ----------

  function sendPulse(fromId, toId) {
    const from = robots.get(fromId);
    const to = robots.get(toId);
    if (!to || reducedMotion) return;
    pulses.push({ from: from ?? null, to, start: performance.now(), duration: from && from.platform === to.platform ? 900 : 1600 });
  }

  function drawPulses(now) {
    for (let index = pulses.length - 1; index >= 0; index -= 1) {
      const pulse = pulses[index];
      const k = (now - pulse.start) / pulse.duration;
      if (k > 1) {
        pulses.splice(index, 1);
        continue;
      }
      const to = pulse.to.head ?? { x: pulse.to.platform.cx, y: pulse.to.platform.cy };
      const fromPoint = pulse.from ? (pulse.from.head ?? { x: pulse.from.platform.cx, y: pulse.from.platform.cy }) : { x: to.x, y: to.y - 160 };
      drawTrail({ a: fromPoint, b: to, c: { x: (fromPoint.x + to.x) / 2, y: Math.min(fromPoint.y, to.y) - 60 } }, pulse.to.platform.color, k);
    }
  }

  function drawTrail(path, color, k) {
    const ease = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    for (let tail = 0; tail < 6; tail += 1) {
      const point = quad(path, Math.max(0, ease - tail * 0.025));
      ctx.fillStyle = rgba(tail ? color : "#ffffff", (1 - tail / 6) * 0.9);
      ctx.shadowColor = color;
      ctx.shadowBlur = tail ? 0 : 14;
      ctx.beginPath();
      ctx.arc(point.x, point.y, tail ? 3.4 - tail * 0.4 : 4.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }

  // ---------- puntero: tocar, arrastrar y menús ----------

  function toWorld(point) {
    const rect = canvas.getBoundingClientRect();
    return { x: (point.clientX - rect.left - view.ox) / view.scale, y: (point.clientY - rect.top) / view.scale };
  }

  function inside(point, box, pad = 0) {
    return box && point.x >= box.x - pad && point.x <= box.x + box.w + pad && point.y >= box.y - pad && point.y <= box.y + box.h + pad;
  }

  /** Qué hay bajo el puntero: un robot, un «+», una tarjeta o la plataforma punteada. */
  function hit(point) {
    let found = null;
    for (const robot of robots.values()) {
      const box = robot.box;
      if (!box || robot.agent.id === pending?.agentId) continue;
      if (point.x >= box.left - 6 && point.x <= box.left + box.w + 6 && point.y >= box.top - 6 && point.y <= box.top + box.h + 6) {
        if (!found || box.top > found.robot.box.top) found = { kind: "agent", robot };
      }
    }
    if (found) return found;
    for (const platform of platforms) {
      const add = platform.add;
      if (add && Math.hypot(point.x - add.x, point.y - add.y) <= add.r + 9) return { kind: "add", platform };
    }
    for (const platform of platforms) {
      if (!inside(point, platform.card)) continue;
      if (platform.kind === "new") return { kind: "ghost", platform };
      if (platform.kind === "hall") return { kind: "board", platform };
      if (platform.channelId) return { kind: "channel", platform };
      return { kind: "loose", platform };
    }
    const ghost = platforms.find((platform) => platform.kind === "new");
    if (ghost && onPlatform(point, ghost)) return { kind: "ghost", platform: ghost };
    return null;
  }

  /** Si el punto cae sobre la cara de una plataforma (con un margen, para que sea fácil soltar ahí). */
  function onPlatform(point, platform) {
    const o = origin(platform);
    const { i, j } = cellAt(point.x - o.x, point.y - o.y);
    const margin = 0.45;
    return i >= -margin && j >= -margin && i <= platform.side + margin && j <= platform.side + margin;
  }

  /** La plataforma bajo el puntero mientras arrastras (la tarjeta también cuenta). */
  function platformAt(point) {
    for (const platform of platforms) if (inside(point, platform.card, 8)) return platform;
    for (const platform of platforms) if (onPlatform(point, platform)) return platform;
    return null;
  }

  function draggable(target) {
    return target?.kind === "agent" && !target.robot.agent.main;
  }

  function onPointerDown(event) {
    if (!event.isPrimary || pending) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const target = hit(toWorld(event));
    clearPress();
    press = { pointerId: event.pointerId, type: event.pointerType, x: event.clientX, y: event.clientY, target, timer: null, menu: false };
    if (event.pointerType !== "mouse" && target) {
      // Mantener presionado: levanta al robot (y, si no lo mueves, muestra sus opciones).
      press.timer = setTimeout(() => {
        if (!press) return;
        press.timer = null;
        if (draggable(press.target)) {
          navigator.vibrate?.(10);
          startDrag(press.target.robot, { clientX: press.x, clientY: press.y }, true);
        } else {
          press.menu = true;
          navigator.vibrate?.(8);
          openMenu(press.target, press.x, press.y, true);
        }
      }, LONG_PRESS_MS);
    }
  }

  function onPointerMove(event) {
    if (drag) {
      if (event.pointerId !== drag.pointerId) return;
      moveDrag(event);
      return;
    }
    if (press && event.pointerId === press.pointerId) {
      const distance = Math.hypot(event.clientX - press.x, event.clientY - press.y);
      if (press.type === "mouse") {
        if (distance > DRAG_SLOP && draggable(press.target)) {
          startDrag(press.target.robot, event, false);
          canvas.setPointerCapture?.(event.pointerId);
          moveDrag(event);
          return;
        }
      } else if (press.timer && distance > 10) {
        // Se movió antes de tiempo: es para desplazar la oficina.
        clearPress();
      }
    }
    if (event.pointerType !== "mouse" && event.pointerType !== "pen") return;
    const target = hit(toWorld(event));
    canvas.style.cursor = target ? (draggable(target) ? "grab" : "pointer") : "";
    showHover(target, event);
  }

  function onPointerUp(event) {
    if (drag && event.pointerId === drag.pointerId) {
      suppressClickUntil = performance.now() + 450;
      const current = drag;
      clearPress();
      if (current.touch && !current.moved) {
        // Lo levantaste pero no lo moviste: sus opciones.
        endDrag();
        openMenu({ kind: "agent", robot: robots.get(current.agentId) }, event.clientX, event.clientY, true);
        return;
      }
      if (current.verdict?.ok) void dropOn(current);
      else {
        if (current.moved) returning = { agentId: current.agentId, point: { ...current.pointer }, lift: liftOf(current), start: performance.now() };
        endDrag();
      }
      return;
    }
    if (press?.menu) suppressClickUntil = performance.now() + 450;
    clearPress();
  }

  function onPointerCancel(event) {
    if (drag && event.pointerId === drag.pointerId) endDrag();
    clearPress();
  }

  function clearPress() {
    if (press?.timer) clearTimeout(press.timer);
    press = null;
  }

  function startDrag(robot, point, touch) {
    drag = {
      agentId: robot.agent.id,
      pointerId: press?.pointerId ?? null,
      name: robot.agent.name,
      from: robot.platform,
      client: { clientX: point.clientX, clientY: point.clientY },
      startX: point.clientX,
      startY: point.clientY,
      pointer: toWorld(point),
      target: null,
      verdict: null,
      touch,
      moved: false,
      lifted: true,
    };
    if (press) {
      clearTimeout(press.timer);
      press.timer = null;
    }
    canvas.classList.add("dragging");
    canvas.style.cursor = "grabbing";
    retarget();
  }

  function moveDrag(event) {
    drag.client = { clientX: event.clientX, clientY: event.clientY };
    drag.pointer = toWorld(event);
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 8) drag.moved = true;
    retarget();
  }

  /** Dónde caería el robot y qué pasaría: se muestra al lado del puntero. */
  function retarget() {
    if (!drag) return;
    drag.target = platformAt(drag.pointer);
    drag.verdict = dropVerdict(drag.name, drag.from, drag.target);
    const text = drag.moved || !drag.touch ? drag.verdict.text : "Arrástralo a otro equipo o suéltalo para ver sus opciones";
    const own = drag.target?.id === drag.from?.id;
    const tone = drag.verdict.ok ? "ok" : drag.target && !own ? "no" : null;
    setHover({ text, tone, x: drag.client.clientX, y: drag.client.clientY, above: drag.touch });
  }

  function endDrag() {
    drag = null;
    canvas.classList.remove("dragging");
    canvas.style.cursor = "";
    setHover(null);
  }

  /** Lo soltaste en otro equipo: se queda flotando ahí hasta que el servidor confirme. */
  async function dropOn(current) {
    const target = current.target;
    pending = { agentId: current.agentId, point: { ...current.pointer }, color: target.color, lift: liftOf(current) };
    endDrag();
    let result = null;
    try {
      if (target.kind === "new") result = await host.moveToNewTeam(current.agentId, current.from.channelId ?? null);
      else result = await host.moveAgent(current.agentId, { from: current.from.channelId ?? null, to: target.channelId ?? null });
    } finally {
      const left = pending;
      pending = null;
      if (result) {
        remember(current.agentId, result.team?.id ?? null);
        spotlight = { agentId: current.agentId, start: performance.now() };
      } else if (left) {
        returning = { agentId: current.agentId, point: left.point, lift: left.lift, start: performance.now() };
      }
      if (visible) sync();
    }
  }

  function onClick(event) {
    if (performance.now() < suppressClickUntil) return;
    const target = hit(toWorld(event));
    if (!target) return;
    setHover(null);
    if (target.kind === "agent") host.openAgent(target.robot.agent.id);
    else if (target.kind === "add") host.createAgent({ channelId: target.platform.channelId ?? null });
    else if (target.kind === "ghost") {
      if (empty) host.createAgent({});
      else host.createTeam();
    }
    else if (target.kind === "channel") host.openChannel(target.platform.channelId);
    else if (target.kind === "board") showBoard();
  }

  function onContextMenu(event) {
    event.preventDefault();
    // Android avisa «contextmenu» al mantener presionado: ya lo atendió el toque largo.
    if (drag || press?.menu || press?.type === "touch") return;
    const target = hit(toWorld(event));
    if (target) openMenu(target, event.clientX, event.clientY, false);
  }

  /** «touch»: se abrió con el dedo (la app lo pone donde el dedo no lo toque al soltar). */
  function openMenu(target, x, y, touch) {
    setHover(null);
    if (!target || (target.kind === "agent" && !target.robot)) return;
    if (target.kind === "agent") host.agentMenu(target.robot.agent.id, { x, y, touch, channelId: target.robot.platform.channelId ?? null });
    else if (target.kind !== "add") host.teamMenu({ kind: target.kind, channelId: target.platform.channelId ?? null, empty }, { x, y, touch });
  }

  /** La ayuda que aparece al pasar el mouse: qué es y qué pasa si lo tocas. */
  function showHover(target, event) {
    const at = { x: event.clientX, y: event.clientY };
    const previous = hovered;
    if (!target) setHover(null);
    else if (target.kind === "agent") setHover({ ...at, kind: "agent", agent: target.robot.agent, platform: target.robot.platform });
    else if (target.kind === "board") {
      setHover({
        ...at,
        kind: "board",
        platform: target.platform,
        title: "La pizarra de Claude Bot",
        text: live.board.trim() ? "El plan del trabajo que está repartiendo." : "Vacía: Claude Bot anota aquí el plan cuando reparte un trabajo.",
        hint: "Clic: verla",
      });
    } else if (target.kind === "channel") {
      const team = teamOf(target.platform);
      const lead = team.find((agent) => agent.id === target.platform.leadId);
      setHover({
        ...at,
        kind: "channel",
        platform: target.platform,
        title: `Equipo «${target.platform.title}»`,
        text: [target.platform.topic, lead ? `Encargado: ${lead.name}` : ""].filter(Boolean).join(" · ") || "Un canal donde sus agentes conversan y se reparten el trabajo.",
        hint: "Clic: abrir el chat del equipo · Clic derecho: más opciones",
      });
    } else if (target.kind === "loose") {
      setHover({ ...at, kind: "loose", platform: target.platform, title: "Sin grupo", text: "Agentes que todavía no están en un equipo.", hint: "Arrástralos a una plataforma para sumarlos" });
    } else if (target.kind === "add") {
      setHover({
        ...at,
        kind: "add",
        platform: target.platform,
        title: target.platform.channelId ? `Crear un agente en «${target.platform.title}»` : "Crear un agente sin equipo",
      });
    } else if (target.kind === "ghost") {
      setHover({
        ...at,
        kind: "ghost",
        platform: target.platform,
        title: empty ? "Crea tu primer agente" : "Nuevo equipo",
        text: empty ? "Después puedes sumarlo a un equipo o pedirle a Claude Bot que arme uno." : "Clic: armar un equipo con los agentes que elijas. También puedes arrastrar un agente aquí.",
      });
    }
    if (previous?.platform !== hovered?.platform || previous?.kind !== hovered?.kind) lastFrame = 0;
  }

  function setHover(info) {
    hovered = info;
    if (!info) {
      tip.hidden = true;
      return;
    }
    tip.replaceChildren();
    tip.dataset.tone = info.tone ?? "";
    const line = (className, text) => {
      if (!text) return;
      const element = document.createElement(className === "strong" ? "strong" : "span");
      if (className !== "strong") element.className = className;
      element.textContent = text;
      tip.append(element);
    };
    if (info.agent) {
      line("strong", info.agent.name);
      line("office-tip-role", info.agent.role);
      line("office-tip-state", describe(info.agent));
      line("office-tip-why", explain(info.agent));
      const open = host.wide?.() ? "Clic: su chat y su ficha aquí" : "Clic: abrir su chat";
      line("office-tip-hint", info.agent.main ? `${open} · Clic derecho: más opciones` : `${open} · Arrastra: cambiar de equipo · Clic derecho: opciones`);
    } else if (info.title) {
      line("strong", info.title);
      line("office-tip-state", info.text);
      line("office-tip-hint", info.hint);
    } else {
      tip.textContent = info.text;
    }
    tip.hidden = false;
    const bounds = root.getBoundingClientRect();
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    const left = Math.min(bounds.width - width - 8, Math.max(8, info.x - bounds.left + (info.above ? -width / 2 : 14)));
    const gap = info.above ? 96 : 12;
    const top = info.y - bounds.top - height - gap < 8 ? info.y - bounds.top + 18 : info.y - bounds.top - height - gap;
    tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  /** Qué está haciendo, en una línea. */
  function describe(agent) {
    const text = describeState(agent);
    const progress = visibleProgress(agent);
    if (!progress) return text;
    const amount = progress.percent >= 100 ? "terminó su tarea" : `${progress.percent} %`;
    return `${text} · ${amount}${progress.step ? ` (${progress.step})` : ""}`;
  }

  function describeState(agent) {
    if (live.asking.has(agent.id)) return "Te hizo una pregunta";
    const failed = live.failed.get(agent.id);
    if (failed && Date.now() - failed < 45_000) return "No pudo terminar";
    if (agent.state === "paused") return "En pausa";
    if (agent.state === "queued") return agent.queued > 1 ? `${agent.queued} encargos en cola` : "Encargo en cola";
    if (agent.state === "working") {
      const activity = live.activity.get(agent.id);
      return activity && Date.now() - activity.at < 60_000 ? activity.text : "Trabajando…";
    }
    return "Libre";
  }

  /** Qué conviene hacer según su estado (la guía en pequeño). */
  function explain(agent) {
    if (live.asking.has(agent.id)) return "Ábrelo y responde para que siga.";
    const failed = live.failed.get(agent.id);
    if (failed && Date.now() - failed < 45_000) return "Ábrelo para ver qué pasó.";
    if (agent.state === "paused") return "Sus encargos esperan hasta que lo reanudes.";
    if (agent.state === "queued") return "Espera su turno para empezar.";
    return "";
  }

  function showBoard() {
    closeGuide();
    const body = boardView.querySelector(".office-board-text");
    body.replaceChildren();
    if (live.board.trim()) host.renderMarkdown(live.board, body);
    else body.textContent = "La pizarra está vacía. Claude Bot anota aquí el plan cuando reparte un trabajo: quién hace qué y en qué orden.";
    boardView.hidden = false;
    boardView.querySelector("button")?.focus();
  }

  // ---------- la guía ----------

  function openGuide() {
    if (!guide) return;
    boardView.hidden = true;
    guide.hidden = false;
    // La guía trae los mismos botones que el cartel de la oficina vacía: no se muestran los dos a la vez.
    root.classList.add("guide-open");
    helpButton?.setAttribute("aria-expanded", "true");
    paintSamples(performance.now());
    guide.querySelector(".office-guide-close")?.focus({ preventScroll: true });
  }

  function closeGuide() {
    if (!guide || guide.hidden) return;
    guide.hidden = true;
    root.classList.remove("guide-open");
    helpButton?.setAttribute("aria-expanded", "false");
  }

  /** Los ejemplos de la guía: el mismo robot de la Oficina en cada estado. */
  function paintSamples(now) {
    if (!guide || guide.hidden) return;
    const t = reducedMotion ? 0 : now;
    for (const element of guide.querySelectorAll("canvas[data-sample]")) paintSample(element, element.dataset.sample, t);
  }

  const SAMPLE_ICONS = ["terminal", "pencil", "globe", "image"];

  function paintSample(element, kind, t) {
    const size = 56;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (element.width !== size * dpr) {
      element.width = size * dpr;
      element.height = size * dpr;
    }
    const sampleCtx = element.getContext("2d");
    if (!sampleCtx) return;
    const saved = ctx;
    ctx = sampleCtx;
    try {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      ctx.fillStyle = "#121852";
      roundRect(ctx, 0, 0, size, size, 12);
      ctx.fill();
      const color = "#3fb6ff";
      if (kind === "pulse") {
        const k = t ? (t % 1600) / 1600 : 0.6;
        drawTrail({ a: { x: 9, y: 42 }, b: { x: 47, y: 34 }, c: { x: 28, y: 4 } }, color, k);
        return;
      }
      ctx.translate(size / 2 - 4, size - 3);
      ctx.scale(0.5, 0.5);
      const look = { working: false, paused: false, queued: false, asking: false, failed: false, progress: null, icon: null, eye: color };
      if (kind === "working") {
        look.working = true;
        look.icon = t ? SAMPLE_ICONS[Math.floor(t / 1500) % SAMPLE_ICONS.length] : null;
      } else if (kind === "progress") look.progress = { percent: t ? 20 + Math.round(((t / 60) % 80)) : 60 };
      else if (kind in look) look[kind] = true;
      drawRobot({ agent: { id: `muestra-${kind}` }, seat: { kind: "desk" }, phase: 0.3 }, { x: 0, y: 0 }, color, t, look);
    } finally {
      ctx = saved;
    }
  }

  /** Lo mismo en texto, para lectores de pantalla: una lista por plataforma. */
  function renderLists() {
    const groups = platforms
      .filter((platform) => platform.kind !== "new")
      .map((platform) => {
        const group = document.createElement("section");
        group.className = "office-panel";
        group.dataset.panel = platform.id;
        const title = document.createElement("h3");
        title.textContent = platform.kind === "hall" ? "Claude Bot" : platform.channelId ? `Equipo ${platform.title}` : platform.title;
        const list = document.createElement("ul");
        for (const agent of teamOf(platform)) {
          const item = document.createElement("li");
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = `${agent.name}: ${describe(agent)}`;
          button.addEventListener("click", () => host.openAgent(agent.id));
          const more = document.createElement("button");
          more.type = "button";
          more.textContent = `Opciones de ${agent.name}`;
          more.addEventListener("click", () => {
            const rect = more.getBoundingClientRect();
            host.agentMenu(agent.id, { x: rect.left, y: rect.bottom, channelId: platform.channelId ?? null });
          });
          item.append(button, more);
          list.append(item);
        }
        group.append(title, list);
        if (platform.kind !== "hall") {
          const add = document.createElement("button");
          add.type = "button";
          add.textContent = platform.channelId ? `Crear un agente en ${platform.title}` : "Crear un agente sin equipo";
          add.addEventListener("click", () => host.createAgent({ channelId: platform.channelId ?? null }));
          group.append(add);
        }
        return group;
      });
    lists.replaceChildren(...groups);
  }

  // ---------- eventos de la app ----------

  function handle(event) {
    switch (event.type) {
      case "hello":
      case "agents":
      case "channels":
        if (visible) sync();
        if (event.type === "agents" && hovered?.agent) {
          const agent = host.agents().find((item) => item.id === hovered.agent.id);
          if (agent) setHover({ ...hovered, agent });
        }
        break;
      case "message":
        onMessage(event.agentId, event.message);
        break;
      case "delta":
        live.typing.set(event.agentId, Date.now());
        break;
      case "turn":
        if (event.status === "failed") live.failed.set(event.agentId, Date.now());
        else live.failed.delete(event.agentId);
        updateStatus();
        break;
      default:
        break;
    }
  }

  function onMessage(agentId, message) {
    if (!message) return;
    if (message.role === "activity") {
      const payload = message.payload ?? null;
      if (payload?.kind === "board-updated") live.board = typeof payload.board === "string" ? payload.board : "";
      live.activity.set(agentId, { text: message.text, icon: activityIcon(message.text, payload), at: Date.now() });
      return;
    }
    if (message.role === "decision") {
      const answered = message.payload?.answer !== null && message.payload?.answer !== undefined;
      if (answered) live.asking.delete(agentId);
      else live.asking.add(agentId);
      updateStatus();
      return;
    }
    // Si le escribiste en vez de tocar una opción, ya no espera respuesta.
    if (message.role === "user") {
      live.asking.delete(agentId);
      updateStatus();
      return;
    }
    if (message.role === "teammate" && message.fromAgentId && !seenMessages.has(message.id)) {
      seenMessages.add(message.id);
      if (seenMessages.size > 500) seenMessages = new Set([...seenMessages].slice(-200));
      if (visible) sendPulse(message.fromAgentId, agentId);
      return;
    }
    if (message.role === "assistant" && message.status === "streaming") live.typing.set(agentId, Date.now());
  }

  // ---------- ciclo ----------

  /** Mientras arrastras cerca del borde, la oficina se desplaza sola. */
  function autoScroll() {
    if (!drag?.lifted) return;
    const rect = scroller.getBoundingClientRect();
    const edge = 56;
    const y = drag.client.clientY;
    let delta = 0;
    if (y < rect.top + edge) delta = -Math.ceil((rect.top + edge - y) / 4);
    else if (y > rect.bottom - edge) delta = Math.ceil((y - (rect.bottom - edge)) / 4);
    if (!delta) return;
    const before = scroller.scrollTop;
    scroller.scrollTop = before + Math.max(-16, Math.min(16, delta));
    if (scroller.scrollTop !== before) {
      drag.pointer = toWorld(drag.client);
      retarget();
    }
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (document.hidden) return;
    if (now - lastFrame < 30) return;
    lastFrame = now;
    autoScroll();
    draw(now);
    paintSamples(now);
    if (now - lastStatus > 1000) {
      lastStatus = now;
      updateStatus();
    }
  }

  const resizer =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
          if (!visible) return;
          // También cuando cambia el alto (el chat de abajo se abre, se cierra o lo estiras).
          if (Math.abs(scroller.clientWidth - view.width) <= 1 && Math.abs(scroller.clientHeight - view.client) <= 1) return;
          layout();
          draw(performance.now());
        })
      : null;
  resizer?.observe(scroller);

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerCancel);
  canvas.addEventListener("pointerleave", () => {
    if (!drag) setHover(null);
  });
  canvas.addEventListener("click", onClick);
  canvas.addEventListener("contextmenu", onContextMenu);
  // Con el robot levantado, el dedo lo arrastra en vez de desplazar la oficina.
  canvas.addEventListener(
    "touchmove",
    (event) => {
      if (drag) event.preventDefault();
    },
    { passive: false },
  );
  document.addEventListener("keydown", (event) => {
    if (!visible || event.key !== "Escape") return;
    if (drag) {
      endDrag();
      clearPress();
    } else if (guide && !guide.hidden && guide.contains(document.activeElement)) {
      closeGuide();
      helpButton?.focus({ preventScroll: true });
    }
  });

  function show() {
    if (visible) return;
    visible = true;
    root.hidden = false;
    primed = false;
    sync();
    void loadSnapshot();
    lastFrame = 0;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
    // La primera vez, la guía se abre sola.
    if (guide && !storage.get(GUIDE_SEEN_KEY)) {
      storage.set(GUIDE_SEEN_KEY, "1");
      openGuide();
    }
  }

  function hide() {
    if (!visible) return;
    visible = false;
    root.hidden = true;
    cancelAnimationFrame(raf);
    endDrag();
    clearPress();
    setHover(null);
    boardView.hidden = true;
    closeGuide();
  }

  boardView.querySelector("button")?.addEventListener("click", () => {
    boardView.hidden = true;
  });
  scroller.addEventListener(
    "scroll",
    () => {
      if (!drag) setHover(null);
    },
    { passive: true },
  );
  helpButton?.addEventListener("click", () => (guide.hidden ? openGuide() : closeGuide()));
  guide?.querySelector(".office-guide-close")?.addEventListener("click", () => {
    closeGuide();
    helpButton?.focus({ preventScroll: true });
  });
  for (const button of root.querySelectorAll("[data-office-action]")) {
    button.addEventListener("click", () => {
      const action = button.dataset.officeAction;
      if (action === "create") host.createAgent({});
      else if (action === "main") host.openMain();
      else if (action === "guide") openGuide();
      else if (action === "team") host.createTeam();
    });
  }

  /** Desplaza la Oficina si el robot quedó fuera de la vista. */
  function reveal(agentId) {
    const robot = robots.get(agentId);
    if (!robot) return;
    const y = (seatPoint(robot.platform, robot.seat).y - 40) * view.scale;
    if (y < scroller.scrollTop + 40 || y > scroller.scrollTop + scroller.clientHeight - 40) {
      scroller.scrollTo({ top: Math.max(0, y - scroller.clientHeight / 2), behavior: reducedMotion ? "auto" : "smooth" });
    }
  }

  const api = {
    show,
    hide,
    handle,
    refresh: loadSnapshot,
    openGuide,
    showBoard,
    /** El agente elegido (su chat y su ficha están abiertos al lado), o null. */
    select(agentId) {
      const changed = agentId !== selectedId;
      selectedId = agentId;
      if (!changed || !agentId || !visible) return;
      // Al abrirse el chat abajo, la Oficina se achica: espera a que se acomode y muéstralo.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (selectedId !== agentId || !visible) return;
          if (!robots.has(agentId)) sync();
          reveal(agentId);
        }),
      );
    },
    get visible() {
      return visible;
    },
    /** Recuerda en qué equipo lo dejaste (cuando lo cambias con el menú) y lo resalta un momento. */
    placed(agentId, channelId) {
      remember(agentId, channelId);
      spotlight = { agentId, start: performance.now() };
      if (visible) sync();
    },
    /** Resalta a un agente (el que acabas de crear) y lo trae a la vista. */
    highlight(agentId) {
      if (!visible) return;
      if (!robots.has(agentId)) sync();
      if (!robots.has(agentId)) return;
      spotlight = { agentId, start: performance.now() };
      reveal(agentId);
    },
    /** Para las pruebas: dónde está cada agente y dónde está cada plataforma, en pantalla. */
    debug() {
      const rect = canvas.getBoundingClientRect();
      const screen = (point) => ({ x: Math.round(rect.left + view.ox + point.x * view.scale), y: Math.round(rect.top + point.y * view.scale) });
      return {
        robots: [...robots.entries()].map(([id, robot]) => ({ id, panel: robot.platform.id, ...screen(robot.head ?? { x: 0, y: 0 }), seat: screen(seatPoint(robot.platform, robot.seat)) })),
        panels: platforms.map((platform) => ({
          id: platform.id,
          kind: platform.kind,
          title: platform.title,
          color: platform.color,
          center: screen({ x: platform.cx, y: platform.cy }),
          card: platform.card ? screen({ x: platform.card.x + platform.card.w / 2, y: platform.card.y + platform.card.h / 2 }) : null,
          add: platform.add ? screen(platform.add) : null,
        })),
      };
    },
    get snapshotLoaded() {
      return snapshotLoaded;
    },
  };
  // Las pruebas de la interfaz leen dónde quedó cada cosa desde el propio canvas.
  canvas.officeDebug = () => api.debug();
  return api;
}

// ---------- utilidades de dibujo ----------

/** El avance que vale la pena mostrar: el de una tarea en curso (hasta 12 h) o «Listo» por media hora. */
export function visibleProgress(agent, now = Date.now()) {
  const progress = agent?.progress;
  if (!progress || typeof progress.percent !== "number") return null;
  const age = now - (progress.at ?? 0);
  if (progress.percent >= 100 ? age > 30 * 60_000 : age > 12 * 3_600_000) return null;
  return progress;
}

function easeOut(k) {
  return 1 - (1 - k) ** 3;
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function clipText(ctx, text, max) {
  const value = String(text ?? "");
  if (ctx.measureText(value).width <= max) return value;
  let end = value.length;
  while (end > 1 && ctx.measureText(`${value.slice(0, end)}…`).width > max) end -= 1;
  return `${value.slice(0, end).trimEnd()}…`;
}

/** Las primeras líneas de la pizarra, sin marcas de markdown. */
export function boardLines(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s*#{1,6}\s*/, "")
        .replace(/^\s*[-*+]\s+/, "• ")
        .replace(/^\s*\d+[.)]\s+/, (match) => match.trim() + " ")
        .replace(/\*\*|__|`/g, "")
        .trim(),
    )
    .filter(Boolean);
}
