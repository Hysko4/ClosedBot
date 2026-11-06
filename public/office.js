// La Oficina: cada equipo es una plataforma isométrica de neón con un escritorio por integrante, y cada
// agente es un robot que trabaja, pregunta, duerme o espera. Todo se dibuja aquí, en un solo canvas.

/** Colores de neón de las plataformas, en orden. */
const NEON = ["#2de2c8", "#3fb6ff", "#ff4fa3", "#f5d63d", "#9b7bff", "#ff8a3d", "#5cf27e", "#ff5d5d"];
const HALL_COLOR = "#8fa8ff";
/** Mitad del ancho y del alto de una celda isométrica, en píxeles de mundo. */
const TILE_W = 74;
const TILE_H = 37;
const THICK = 14;
const CARD_W = 230;
const CARD_H = 62;

/**
 * Dónde se sienta cada uno. El salón (Claude Bot) va primero; después, una plataforma por canal con un
 * escritorio para cada integrante (menos Claude Bot) y, si hay agentes sin grupo, la de «Sin grupo». Cada
 * agente tiene su plataforma de siempre: el primer canal que encarga o, si no, el primero en que está.
 */
export function planOffice({ agents, channels, mainId }) {
  const known = new Map(agents.map((agent) => [agent.id, agent]));
  const panels = [{ id: "hall", kind: "hall", title: "Claude Bot", channelId: null, seats: [] }];
  if (mainId && known.has(mainId)) panels[0].seats.push({ agentId: mainId, kind: "boss", i: 0, j: 0 });
  const home = new Map();
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
      seats: platformSeats(members),
    });
  }
  const loose = agents.filter((agent) => agent.id !== mainId && !home.has(agent.id)).map((agent) => agent.id);
  if (loose.length) panels.push({ id: "loose", kind: "room", title: "Sin grupo", topic: "", channelId: null, leadId: null, seats: platformSeats(loose) });
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

// ---------- la oficina ----------

/**
 * `host` da los datos y acciones de la app: agents(), channels(), colorOf(agent), openAgent(id),
 * openChannel(id), renderMarkdown(text, element) y api(path).
 */
export function createOffice(host) {
  const root = host.root;
  const scroller = root.querySelector(".office-scroll");
  const tip = root.querySelector(".office-tip");
  const boardView = root.querySelector(".office-board");
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const canvas = document.createElement("canvas");
  canvas.className = "office-map";
  canvas.setAttribute("aria-hidden", "true");
  const lists = document.createElement("div");
  lists.className = "visually-hidden";
  scroller.replaceChildren(canvas, lists);
  const ctx = canvas.getContext("2d");

  const live = { board: "", activity: new Map(), asking: new Set(), failed: new Map(), typing: new Map() };
  /** Plataformas en el orden del plan, con su posición en el mundo. */
  let platforms = [];
  /** Dónde está cada agente: { agent, platform, seat }. */
  const robots = new Map();
  const pulses = [];
  const view = { width: 0, height: 0, scale: 1, worldW: 0, worldH: 0, ox: 0, oy: 0 };
  let visible = false;
  let raf = 0;
  let lastFrame = 0;
  let snapshotLoaded = false;
  let hovered = null;
  let seenMessages = new Set();

  // ---------- datos ----------

  async function loadSnapshot() {
    try {
      const data = await host.api("/api/office");
      live.board = data.board ?? "";
      live.activity = new Map(Object.entries(data.activity ?? {}));
      live.asking = new Set(data.asking ?? []);
      live.failed = new Map((data.failed ?? []).map((id) => [id, Date.now()]));
      snapshotLoaded = true;
    } catch {
      // Sin el resumen igual se ve la oficina: se completa con los eventos.
    }
  }

  // ---------- plataformas ----------

  function sync() {
    const agents = host.agents();
    const channels = host.channels();
    const main = agents.find((agent) => agent.main) ?? null;
    const plan = planOffice({ agents, channels, mainId: main?.id ?? null });
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    let roomIndex = 0;
    platforms = plan.panels.map((spec) => {
      const hall = spec.kind === "hall";
      const color = hall ? HALL_COLOR : NEON[(spec.channelId ? hashText(spec.channelId) : roomIndex) % NEON.length];
      if (!hall) roomIndex += 1;
      return { ...spec, color, side: hall ? 2 : platformSide(spec.seats.length), x: 0, y: 0 };
    });
    // Cada agente en un solo puesto: el del canal para el que trabaja ahora o el de su plataforma de siempre.
    const workingIn = new Map();
    for (const channel of channels) for (const id of channel.working ?? []) if (!workingIn.has(id)) workingIn.set(id, `c:${channel.id}`);
    robots.clear();
    for (const agent of agents) {
      const seats = [];
      for (const platform of platforms) for (const seat of platform.seats) if (seat.agentId === agent.id) seats.push({ platform, seat });
      if (!seats.length) continue;
      const target =
        seats.find((entry) => entry.platform.id === workingIn.get(agent.id)) ??
        seats.find((entry) => entry.platform.id === `c:${plan.home.get(agent.id)}`) ??
        seats[0];
      robots.set(agent.id, { agent: byId.get(agent.id), platform: target.platform, seat: target.seat, phase: (hashText(agent.id) % 1000) / 1000 });
    }
    layout();
    renderLists();
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
      slotW = Math.max(slotW, w + 120, CARD_W + 80);
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
    view.height = Math.max(Math.ceil(view.worldH * view.scale), scroller.clientHeight);
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
    if (!team.length) return "Sin agentes aquí";
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

  function teamCount(platform) {
    return teamOf(platform).length;
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
    for (const platform of platforms) drawPlatform(platform, t);
    drawPulses(now);
    for (const platform of platforms) drawCard(platform, t);
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
      if (platform === hall) continue;
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

  function drawPlatform(platform, t) {
    const o = origin(platform);
    const s = platform.side;
    const top = { x: o.x, y: o.y };
    const right = { x: o.x + s * TILE_W, y: o.y + s * TILE_H };
    const bottom = { x: o.x, y: o.y + s * TILE_H * 2 };
    const left = { x: o.x - s * TILE_W, y: o.y + s * TILE_H };
    const color = platform.color;
    const active = teamOf(platform).some(busy);
    const hall = platform.kind === "hall";

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
      if (active || hall) {
        const start = (t / 1600) % (Math.PI * 2);
        ctx.strokeStyle = rgba(color, 0.85);
        ctx.lineWidth = 2.5;
        ctx.shadowColor = color;
        ctx.shadowBlur = 12;
        ctx.beginPath();
        ctx.ellipse(platform.cx, platform.cy + THICK / 2, rx, ry, 0, start, start + 0.7);
        ctx.stroke();
      }
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

    // La cara de arriba, translúcida, con su cuadrícula.
    const face = ctx.createLinearGradient(left.x, top.y, right.x, bottom.y);
    face.addColorStop(0, rgba(color, 0.2));
    face.addColorStop(1, rgba(color, 0.07));
    ctx.fillStyle = face;
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(right.x, right.y);
    ctx.lineTo(bottom.x, bottom.y);
    ctx.lineTo(left.x, left.y);
    ctx.closePath();
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
    ctx.shadowBlur = active ? 22 : 14;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(right.x, right.y);
    ctx.lineTo(bottom.x, bottom.y);
    ctx.lineTo(left.x, left.y);
    ctx.closePath();
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
      const here = robot && robot.platform === platform ? robot : null;
      drawSeat(platform, point, here, t, hall);
    }
  }

  function drawSeat(platform, point, robot, t, hall) {
    const color = platform.color;
    const working = robot && robot.agent.state === "working";
    // El robot va detrás de su escritorio.
    if (robot) drawRobot(robot, { x: point.x, y: point.y - 4 }, color, t);
    drawDesk(point, color, working, Boolean(robot), t, hall);
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
  function drawRobot(robot, base, color, t) {
    const agent = robot.agent;
    const eye = host.colorOf(agent) || color;
    const working = agent.state === "working";
    const paused = agent.state === "paused";
    const asking = live.asking.has(agent.id);
    const failedAt = live.failed.get(agent.id);
    const failed = failedAt && Date.now() - failedAt < 45_000;
    const boss = robot.seat.kind === "boss";
    const k = boss ? 1.85 : 1.5;
    const bob = working && t ? Math.sin(t / 220 + robot.phase * 6) * 1.6 : t ? Math.sin(t / 900 + robot.phase * 6) * 0.8 : 0;
    const x = base.x;
    const y = base.y + bob;

    // Ondas bajo el que trabaja.
    if (working && t) {
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
    if (paused) ctx.globalAlpha = 0.55;
    // Sombra.
    ctx.fillStyle = "rgba(5, 8, 30, 0.45)";
    ctx.beginPath();
    ctx.ellipse(base.x, base.y + 4, 11 * k, 5 * k, 0, 0, Math.PI * 2);
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

    // Encima: avance, «?», «!», zzz o lo que hace.
    const progress = visibleProgress(agent);
    let top = robot.head.y;
    if (progress) {
      drawMiniProgress(x, top - 4, progress, color);
      top -= 18;
    }
    if (asking) bubble(x + 14 * k, top + 2, 26, { text: "?", fill: "#ffd23f", ink: "#2a2100", pulse: t });
    else if (failed) bubble(x + 14 * k, top + 2, 26, { text: "!", fill: "#ff5d6c", ink: "#fff", pulse: t });
    else if (paused) drawZzz(x + 8 * k, top + 4, 20, t);
    else if (agent.state === "queued") bubble(x + 14 * k, top + 2, 26, { icon: "hourglass", fill: "#e9eeff", ink: "#26306b" });
    else if (working) {
      const activity = live.activity.get(agent.id);
      const typing = live.typing.get(agent.id) ?? 0;
      if (activity && Date.now() - activity.at < 9000 && (!typing || activity.at >= typing - 400)) {
        bubble(x + 14 * k, top + 2, 26, { icon: activity.icon ?? activityIcon(activity.text), fill: "#e9eeff", ink: "#26306b" });
      } else bubble(x + 14 * k, top + 2, 26, { dots: t || 1, fill: "#e9eeff", ink: "#26306b" });
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

  /** Tarjeta de cristal sobre la plataforma: nombre, cuántos son, qué hacen y su avance. */
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

    ctx.save();
    ctx.shadowColor = rgba(color, 0.6);
    ctx.shadowBlur = 16;
    ctx.fillStyle = "rgba(9, 13, 42, 0.88)";
    roundRect(ctx, x, y, CARD_W, CARD_H, 10);
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = rgba(color, 0.9);
    ctx.lineWidth = 1.4;
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
    } else if (hall && live.board.trim()) {
      ctx.fillStyle = "#aab6e8";
      ctx.font = `600 11px ${FONT}`;
      ctx.textAlign = "right";
      ctx.fillText("Pizarra", x + CARD_W - 11, barY + 5);
    }
    ctx.textAlign = "left";
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
      const path = { a: fromPoint, b: to, c: { x: (fromPoint.x + to.x) / 2, y: Math.min(fromPoint.y, to.y) - 60 } };
      const color = pulse.to.platform.color;
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
  }

  // ---------- puntero ----------

  function toWorld(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left - view.ox) / view.scale, y: (event.clientY - rect.top) / view.scale };
  }

  function hit(point) {
    let found = null;
    for (const robot of robots.values()) {
      const box = robot.box;
      if (!box) continue;
      if (point.x >= box.left - 6 && point.x <= box.left + box.w + 6 && point.y >= box.top - 6 && point.y <= box.top + box.h + 6) {
        if (!found || box.top > found.robot.box.top) found = { kind: "agent", robot };
      }
    }
    if (found) return found;
    for (const platform of platforms) {
      const card = platform.card;
      if (card && point.x >= card.x && point.x <= card.x + card.w && point.y >= card.y && point.y <= card.y + card.h) {
        if (platform.kind === "hall") return { kind: "board", platform };
        if (platform.channelId) return { kind: "channel", platform };
      }
    }
    return null;
  }

  function onPointerMove(event) {
    const target = hit(toWorld(event));
    canvas.style.cursor = target ? "pointer" : "";
    if (event.pointerType === "touch") return;
    if (target?.kind === "agent") return setHover({ agent: target.robot.agent, x: event.clientX, y: event.clientY });
    if (target?.kind === "board") return setHover({ text: live.board.trim() ? "Ver la pizarra de Claude Bot" : "Claude Bot aún no anota un plan", x: event.clientX, y: event.clientY });
    if (target?.kind === "channel") return setHover({ text: `Abrir el canal «${target.platform.title}»`, x: event.clientX, y: event.clientY });
    setHover(null);
  }

  function onClick(event) {
    const target = hit(toWorld(event));
    if (!target) return;
    setHover(null);
    if (target.kind === "agent") host.openAgent(target.robot.agent.id);
    else if (target.kind === "channel") host.openChannel(target.platform.channelId);
    else if (target.kind === "board") showBoard();
  }

  function setHover(info) {
    hovered = info;
    if (!info) {
      tip.hidden = true;
      return;
    }
    tip.replaceChildren();
    if (info.agent) {
      const name = document.createElement("strong");
      name.textContent = info.agent.name;
      tip.append(name);
      if (info.agent.role) {
        const role = document.createElement("span");
        role.className = "office-tip-role";
        role.textContent = info.agent.role;
        tip.append(role);
      }
      const status = document.createElement("span");
      status.className = "office-tip-state";
      status.textContent = describe(info.agent);
      tip.append(status);
    } else {
      tip.textContent = info.text;
    }
    tip.hidden = false;
    const bounds = root.getBoundingClientRect();
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    const left = Math.min(bounds.width - width - 8, Math.max(8, info.x - bounds.left + 14));
    const top = info.y - bounds.top - height - 12 < 8 ? info.y - bounds.top + 18 : info.y - bounds.top - height - 12;
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

  function showBoard() {
    const body = boardView.querySelector(".office-board-text");
    body.replaceChildren();
    if (live.board.trim()) host.renderMarkdown(live.board, body);
    else body.textContent = "La pizarra está vacía. Claude Bot anota aquí el plan cuando reparte un trabajo.";
    boardView.hidden = false;
    boardView.querySelector("button")?.focus();
  }

  /** Lo mismo en texto, para lectores de pantalla: una lista por plataforma. */
  function renderLists() {
    const groups = platforms.map((platform) => {
      const group = document.createElement("section");
      group.className = "office-panel";
      group.dataset.panel = platform.id;
      const title = document.createElement("h3");
      title.textContent = platform.kind === "hall" ? "Claude Bot" : `Equipo ${platform.title}`;
      const list = document.createElement("ul");
      for (const agent of teamOf(platform)) {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `${agent.name}: ${describe(agent)}`;
        button.addEventListener("click", () => host.openAgent(agent.id));
        item.append(button);
        list.append(item);
      }
      group.append(title, list);
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
      return;
    }
    // Si le escribiste en vez de tocar una opción, ya no espera respuesta.
    if (message.role === "user") {
      live.asking.delete(agentId);
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

  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (document.hidden) return;
    if (now - lastFrame < 30) return;
    lastFrame = now;
    draw(now);
  }

  const resizer =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
          if (visible && Math.abs(scroller.clientWidth - view.width) > 1) layout();
        })
      : null;
  resizer?.observe(scroller);

  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerleave", () => setHover(null));
  canvas.addEventListener("click", onClick);

  function show() {
    if (visible) return;
    visible = true;
    root.hidden = false;
    sync();
    void loadSnapshot();
    lastFrame = 0;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(loop);
  }

  function hide() {
    if (!visible) return;
    visible = false;
    root.hidden = true;
    cancelAnimationFrame(raf);
    setHover(null);
    boardView.hidden = true;
  }

  boardView.querySelector("button")?.addEventListener("click", () => {
    boardView.hidden = true;
  });
  scroller.addEventListener("scroll", () => setHover(null), { passive: true });

  return {
    show,
    hide,
    handle,
    refresh: loadSnapshot,
    get visible() {
      return visible;
    },
    /** Para las pruebas: dónde está cada agente. */
    debug() {
      return [...robots.entries()].map(([id, robot]) => ({ id, panel: robot.platform.id, x: Math.round(robot.head?.x ?? 0), y: Math.round(robot.head?.y ?? 0) }));
    },
    get snapshotLoaded() {
      return snapshotLoaded;
    },
  };
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
