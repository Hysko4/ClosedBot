// ClosedBot — la Oficina: tus agentes trabajando en un dibujo (Canvas 2D, sin dependencias).
//
// Arriba, el salón de Claude Bot con su escritorio y la pizarra; debajo, una sala por grupo (canal) con un
// escritorio para cada integrante: la sala se ordena según cuántos sean. Cada agente es su personaje de
// PixelLab (o uno dibujado aquí mientras llega el suyo): se sienta a trabajar, se levanta cuando está libre,
// muestra lo que hace y lleva un sobre a quien le escribe. Clic en un personaje abre su chat.

const WORLD_W = 2752;
const WORLD_H = 1536;
const DIRECTIONS = ["south", "west", "east", "north"];

// ---------- geometría del dibujo (coordenadas del mundo, 2752 × 1536) ----------

/** El escritorio de las salas: su punto de apoyo (centro del borde de abajo) en el dibujo original. */
const DESK_ANCHOR = { x: 1377, y: 1165 };

const HALL = {
  floor: { x: 120, y: 700, w: 2560, h: 800 },
  obstacles: [
    { x: 130, y: 980, w: 400, h: 190 }, // patas de la pizarra
    { x: 560, y: 1060, w: 690, h: 200 }, // escritorio de Claude Bot
    { x: 610, y: 880, w: 220, h: 100 }, // su sillón
    { x: 1800, y: 640, w: 190, h: 120 }, // sillón de la sala de estar
    { x: 1990, y: 560, w: 340, h: 110 }, // sofá
    { x: 2120, y: 690, w: 190, h: 90 }, // mesa de centro
    { x: 2370, y: 600, w: 250, h: 250 }, // mueble de la cafetera
    { x: 2560, y: 760, w: 130, h: 130 }, // planta
  ],
  boss: { x: 720, y: 1010, headTop: 640, clipY: 905, height: 410, glow: { x: 905, y: 815 } },
  board: { tl: [157, 683], tr: [473, 606], bl: [184, 950], br: [493, 851] },
  spots: [
    { x: 1430, y: 760, dir: "north", tag: "window" },
    { x: 2080, y: 830, dir: "north", tag: "lounge" },
    { x: 1700, y: 1010, dir: "south", tag: "floor" },
    { x: 2300, y: 950, dir: "west", tag: "lounge" },
  ],
  boardSpot: { x: 360, y: 1200, dir: "north" },
};

const ROOM = {
  floor: { x: 240, y: 600, w: 2230, h: 890 },
  obstacles: [
    { x: 2400, y: 560, w: 270, h: 360 }, // estante
    { x: 0, y: 1080, w: 250, h: 456 }, // planta izquierda
    { x: 2490, y: 1080, w: 262, h: 456 }, // planta derecha
    { x: 885, y: 560, w: 80, h: 70 }, // pilar
    { x: 1760, y: 560, w: 80, h: 70 }, // pilar
  ],
  plaque: { x: 1240, y: 225, w: 272, h: 115 },
  cork: { x: 1905, y: 205, w: 420, h: 270 },
  spots: [
    { x: 560, y: 760, dir: "north" },
    { x: 900, y: 690, dir: "south" },
    { x: 1880, y: 690, dir: "south" },
    { x: 2120, y: 760, dir: "west" },
    { x: 2300, y: 1000, dir: "west" },
    { x: 420, y: 1060, dir: "east" },
    { x: 700, y: 1360, dir: "north" },
    { x: 2080, y: 1380, dir: "north" },
    { x: 1376, y: 1440, dir: "north" },
  ],
  /** Zona donde caben los escritorios (bordes del mueble, no del personaje). */
  desks: { left: 290, right: 2430, top: 560, bottom: 1460 },
};

const GRID = 40;

/**
 * Dónde se sienta cada uno. El salón (Claude Bot) va primero; después, una sala por canal con un escritorio
 * para cada integrante (menos Claude Bot) y, si hay agentes sin grupo, la sala «Sin grupo». Cada agente tiene
 * su sala de siempre: el primer canal que encarga o, si no, el primero en que está.
 */
export function planOffice({ agents, channels, mainId }) {
  const known = new Map(agents.map((agent) => [agent.id, agent]));
  const panels = [{ id: "hall", kind: "hall", title: "Salón", channelId: null, seats: [] }];
  if (mainId && known.has(mainId)) panels[0].seats.push({ agentId: mainId, kind: "boss", ...HALL.boss });
  const home = new Map();
  for (const channel of channels) {
    if (channel.leadId && channel.leadId !== mainId && known.has(channel.leadId) && !home.has(channel.leadId)) home.set(channel.leadId, channel.id);
  }
  for (const channel of channels) {
    for (const id of channel.memberIds) if (id !== mainId && known.has(id) && !home.has(id)) home.set(id, channel.id);
  }
  for (const channel of channels) {
    const members = channel.memberIds.filter((id) => id !== mainId && known.has(id));
    // El encargado, primero (al centro de la fila de adelante si hay varias).
    members.sort((a, b) => (b === channel.leadId) - (a === channel.leadId));
    panels.push({
      id: `c:${channel.id}`,
      kind: "room",
      title: channel.name,
      topic: channel.topic ?? "",
      channelId: channel.id,
      leadId: channel.leadId,
      seats: arrangeDesks(members),
    });
  }
  const loose = agents.filter((agent) => agent.id !== mainId && !home.has(agent.id)).map((agent) => agent.id);
  if (loose.length) panels.push({ id: "loose", kind: "room", title: "Sin grupo", topic: "", channelId: null, leadId: null, seats: arrangeDesks(loose) });
  return { panels, home };
}

/** Escritorios de una sala para `ids`: elige filas y columnas para que quepan lo más grandes posible. */
export function arrangeDesks(ids) {
  const n = ids.length;
  if (!n) return [];
  const area = ROOM.desks;
  const width = area.right - area.left;
  const height = area.bottom - area.top;
  const ROW = 470;
  const DEPTH = 590; // del respaldo de la silla al borde de abajo del escritorio
  let best = null;
  for (let cols = 1; cols <= n; cols += 1) {
    const rows = Math.ceil(n / cols);
    const scale = Math.min(0.92, width / (cols * 767 + (cols - 1) * 130), height / ((rows - 1) * ROW + DEPTH));
    if (!best || scale > best.scale + 0.012 || (Math.abs(scale - best.scale) <= 0.012 && rows < best.rows)) best = { cols, rows, scale };
  }
  const { cols, rows, scale } = best;
  const block = (rows - 1) * ROW * scale + DEPTH * scale;
  const top = area.top + Math.max(0, height - block) * 0.62;
  const seats = [];
  // La fila de adelante (la más baja) se llena primero: ahí va el encargado.
  for (let index = 0; index < n; index += 1) {
    const row = rows - 1 - Math.floor(index / cols);
    const inRow = Math.min(cols, n - Math.floor(index / cols) * cols);
    const col = index % cols;
    const span = inRow * 767 * scale + (inRow - 1) * 130 * scale;
    const order = centerOrder(inRow)[col];
    const x = 1360 - span / 2 + (767 * scale) / 2 + order * (767 + 130) * scale;
    const anchorY = top + DEPTH * scale + row * ROW * scale;
    seats.push(deskSeat(ids[index], x, anchorY, scale));
  }
  return seats;
}

/** Orden de los puestos de una fila: el primero al centro y los demás hacia los lados. */
function centerOrder(count) {
  const slots = Array.from({ length: count }, (_, index) => index);
  const middle = (count - 1) / 2;
  return slots.sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle) || a - b);
}

function deskSeat(agentId, x, anchorY, scale) {
  return {
    agentId,
    kind: "desk",
    scale,
    anchorX: x,
    anchorY,
    x,
    y: anchorY - 150 * scale,
    headTop: anchorY - 548 * scale,
    clipY: anchorY - 262 * scale,
    height: 430 * scale,
    glow: { x: x + 59 * scale, y: anchorY - 338 * scale },
    plate: { x, y: anchorY - 196 * scale },
  };
}

// ---------- caminos ----------

class Walkway {
  constructor(floor, obstacles) {
    this.cols = Math.ceil(WORLD_W / GRID);
    this.rows = Math.ceil(WORLD_H / GRID);
    this.blocked = new Uint8Array(this.cols * this.rows);
    for (let row = 0; row < this.rows; row += 1) {
      for (let col = 0; col < this.cols; col += 1) {
        const x = (col + 0.5) * GRID;
        const y = (row + 0.5) * GRID;
        const inside = x >= floor.x && x <= floor.x + floor.w && y >= floor.y && y <= floor.y + floor.h;
        const hit = obstacles.some((box) => x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h);
        this.blocked[row * this.cols + col] = !inside || hit ? 1 : 0;
      }
    }
  }

  cell(x, y) {
    return [Math.max(0, Math.min(this.cols - 1, Math.floor(x / GRID))), Math.max(0, Math.min(this.rows - 1, Math.floor(y / GRID)))];
  }

  free(x, y) {
    const [col, row] = this.cell(x, y);
    return !this.blocked[row * this.cols + col];
  }

  /** Camino corto (búsqueda en anchura) entre dos puntos; el inicio y el final valen aunque estén junto a un mueble. */
  path(from, to) {
    const [sc, sr] = this.cell(from.x, from.y);
    const [ec, er] = this.cell(to.x, to.y);
    const start = sr * this.cols + sc;
    const end = er * this.cols + ec;
    if (start === end) return [{ x: to.x, y: to.y }];
    const previous = new Int32Array(this.cols * this.rows).fill(-1);
    previous[start] = start;
    const queue = [start];
    const steps = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    let found = false;
    for (let head = 0; head < queue.length && !found; head += 1) {
      const current = queue[head];
      const col = current % this.cols;
      const row = (current - col) / this.cols;
      for (const [dc, dr] of steps) {
        const nc = col + dc;
        const nr = row + dr;
        if (nc < 0 || nr < 0 || nc >= this.cols || nr >= this.rows) continue;
        const next = nr * this.cols + nc;
        if (previous[next] !== -1) continue;
        if (this.blocked[next] && next !== end) continue;
        // En diagonal, sin cortar esquinas de muebles.
        if (dc && dr && (this.blocked[row * this.cols + nc] || this.blocked[nr * this.cols + col])) continue;
        previous[next] = current;
        if (next === end) {
          found = true;
          break;
        }
        queue.push(next);
      }
    }
    if (!found) return [{ x: to.x, y: to.y }];
    const cells = [];
    for (let current = end; current !== start; current = previous[current]) cells.push(current);
    cells.reverse();
    const points = cells.map((index) => ({ x: ((index % this.cols) + 0.5) * GRID, y: (Math.floor(index / this.cols) + 0.5) * GRID }));
    points[points.length - 1] = { x: to.x, y: to.y };
    return this.#smooth({ x: from.x, y: from.y }, points);
  }

  /** Quita los quiebres que no hacen falta: va en línea recta mientras no choque con nada. */
  #smooth(from, points) {
    const result = [];
    let anchor = from;
    let index = 0;
    while (index < points.length) {
      let far = index;
      for (let probe = points.length - 1; probe > index; probe -= 1) {
        if (this.#clear(anchor, points[probe])) {
          far = probe;
          break;
        }
      }
      result.push(points[far]);
      anchor = points[far];
      index = far + 1;
    }
    return result;
  }

  #clear(a, b) {
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    const steps = Math.ceil(distance / (GRID / 3));
    for (let step = 1; step < steps; step += 1) {
      const t = step / steps;
      if (!this.free(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) return false;
    }
    return true;
  }
}

// ---------- personajes ----------

const SKINS = ["#f3cfb3", "#e6b48f", "#c98e63", "#9a6343", "#f6dcc7", "#d9a27a"];
const HAIRS = ["#2b1d14", "#5a3620", "#8c5a2e", "#d6a24b", "#1d1d22", "#a8452a", "#7d7d86", "#e9dcb8"];
const PANTS = ["#2f3446", "#3a2f2b", "#26323c", "#463b5e", "#33402f"];
const OUTLINE = [27, 20, 16];
const FRAME_W = 32;
const FRAME_H = 40;

function hashText(text) {
  let hash = 2166136261;
  for (const char of String(text)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function hexToRgb(hex) {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function shade(hex, amount) {
  const [r, g, b] = hexToRgb(hex);
  const mix = (channel) => Math.round(amount < 0 ? channel * (1 + amount) : channel + (255 - channel) * amount);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

/**
 * Personaje dibujado aquí (mientras llega el de PixelLab): 4 direcciones × 4 cuadros de 32 × 40 px, con el
 * color del agente en la camisa y pelo y piel elegidos por su id.
 */
function proceduralSprite(agent, color) {
  const seed = hashText(agent.id);
  const palette = {
    shirt: color,
    shirtDark: shade(color, -0.28),
    shirtLight: shade(color, 0.18),
    skin: SKINS[seed % SKINS.length],
    skinDark: shade(SKINS[seed % SKINS.length], -0.16),
    hair: HAIRS[(seed >>> 4) % HAIRS.length],
    hairDark: shade(HAIRS[(seed >>> 4) % HAIRS.length], -0.3),
    pants: PANTS[(seed >>> 8) % PANTS.length],
    pantsDark: shade(PANTS[(seed >>> 8) % PANTS.length], -0.3),
    shoes: "#2a1f19",
    eyes: "#22150e",
    long: (seed >>> 12) % 3 === 0,
  };
  const canvas = document.createElement("canvas");
  canvas.width = FRAME_W * 4;
  canvas.height = FRAME_H * 4;
  const ctx = canvas.getContext("2d");
  DIRECTIONS.forEach((dir, row) => {
    for (let frame = 0; frame < 4; frame += 1) {
      const ox = frame * FRAME_W;
      const oy = row * FRAME_H;
      paintPerson((x, y, w, h, fill) => {
        ctx.fillStyle = fill;
        ctx.fillRect(ox + x, oy + y, w, h);
      }, dir, frame, palette);
    }
  });
  outline(ctx, canvas.width, canvas.height);
  return {
    kind: "drawn",
    bounds: { top: 6, bottom: 38, cx: 16 },
    frame(dir, moving, time) {
      const row = DIRECTIONS.indexOf(dir);
      const frame = moving ? Math.floor(time / 140) % 4 : 0;
      return { image: canvas, sx: frame * FRAME_W, sy: Math.max(0, row) * FRAME_H, sw: FRAME_W, sh: FRAME_H };
    },
  };
}

function paintPerson(px, dir, frame, p) {
  const stride = frame === 1 ? 1 : frame === 3 ? -1 : 0;
  const lift = frame === 1 || frame === 3 ? -1 : 0;
  const side = dir === "east" || dir === "west";
  const flip = dir === "west";
  const fx = (x, w) => (flip ? FRAME_W - x - w : x);
  const rect = (x, y, w, h, fill) => px(fx(x, w), y + lift, w, h, fill);
  if (!side) {
    // Piernas y zapatos (el pie que avanza baja un poco).
    const left = stride > 0 ? 1 : stride < 0 ? -1 : 0;
    rect(12, 31, 4, 5 + left, p.pants);
    rect(16, 31, 4, 5 - left, p.pants);
    rect(19, 31, 1, 5 - left, p.pantsDark);
    rect(11, 36 + left, 5, 2, p.shoes);
    rect(16, 36 - left, 5, 2, p.shoes);
    // Brazos (se balancean al revés que las piernas).
    rect(9, 21 - left, 2, 8, p.shirtDark);
    rect(21, 21 + left, 2, 8, p.shirtDark);
    rect(9, 29 - left, 2, 2, p.skin);
    rect(21, 29 + left, 2, 2, p.skin);
    // Torso.
    rect(11, 20, 10, 11, p.shirt);
    rect(19, 21, 2, 10, p.shirtDark);
    rect(11, 20, 10, 1, p.shirtLight);
    rect(11, 30, 10, 1, p.pantsDark);
    if (dir === "south") rect(15, 20, 2, 2, p.skinDark);
    // Cabeza.
    rect(14, 18, 4, 2, p.skinDark);
    rect(10, 8, 12, 11, p.skin);
    if (dir === "south") {
      rect(9, 9, 1, 6, p.hair);
      rect(22, 9, 1, 6, p.hair);
      rect(10, 6, 12, 4, p.hair);
      rect(12, 5, 8, 1, p.hair);
      rect(10, 10, 3, 1, p.hair);
      rect(16, 10, 6, 1, p.hair);
      rect(10, 9, 12, 1, p.hairDark);
      if (p.long) {
        rect(9, 15, 2, 6, p.hair);
        rect(21, 15, 2, 6, p.hair);
      }
      rect(13, 13, 1, 2, p.eyes);
      rect(18, 13, 1, 2, p.eyes);
      rect(12, 15, 1, 1, "#e98b8b");
      rect(19, 15, 1, 1, "#e98b8b");
      rect(15, 16, 2, 1, p.skinDark);
    } else {
      rect(9, 7, 14, 11, p.hair);
      rect(12, 5, 8, 2, p.hair);
      rect(10, 16, 12, 2, p.hairDark);
      if (p.long) rect(10, 18, 12, 3, p.hair);
    }
    return;
  }
  // De perfil, mirando a la derecha (a la izquierda se refleja).
  const front = stride * 2;
  rect(13 - front, 31, 3, 5, p.pantsDark);
  rect(16 + front, 31, 3, 5, p.pants);
  rect(12 - front, 36, 5, 2, p.shoes);
  rect(16 + front, 36, 5, 2, p.shoes);
  rect(12, 20, 8, 11, p.shirt);
  rect(12, 20, 2, 11, p.shirtDark);
  rect(12, 20, 8, 1, p.shirtLight);
  rect(12, 30, 8, 1, p.pantsDark);
  rect(15 + stride, 21, 3, 8, p.shirtDark);
  rect(15 + stride, 29, 3, 2, p.skin);
  rect(14, 18, 4, 2, p.skinDark);
  rect(11, 8, 11, 11, p.skin);
  rect(22, 13, 1, 2, p.skin);
  rect(10, 6, 12, 4, p.hair);
  rect(12, 5, 8, 1, p.hair);
  rect(10, 9, 5, 7, p.hair);
  rect(10, 9, 1, 7, p.hairDark);
  if (p.long) rect(10, 15, 4, 6, p.hair);
  rect(19, 13, 1, 2, p.eyes);
  rect(20, 16, 1, 1, p.skinDark);
}

/** Contorno oscuro de 1 px alrededor de lo dibujado, como en el pixel art. */
function outline(ctx, width, height) {
  const image = ctx.getImageData(0, 0, width, height);
  const data = image.data;
  const solid = (x, y) => x >= 0 && y >= 0 && x < width && y < height && data[(y * width + x) * 4 + 3] > 0;
  const marks = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (solid(x, y)) continue;
      if (solid(x + 1, y) || solid(x - 1, y) || solid(x, y + 1) || solid(x, y - 1)) marks.push((y * width + x) * 4);
    }
  }
  for (const index of marks) {
    data[index] = OUTLINE[0];
    data[index + 1] = OUTLINE[1];
    data[index + 2] = OUTLINE[2];
    data[index + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}

/** Personaje de PixelLab: sus 4 vistas y, si las tiene, los cuadros de caminar. */
async function pixelLabSprite(agentId, character) {
  const base = `/api/agents/${encodeURIComponent(agentId)}/character`;
  const response = await fetch(`${base}?v=${character.version}`, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`personaje ${response.status}`);
  const manifest = await response.json();
  const load = (file) =>
    new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(file));
      image.src = `${base}/${encodeURIComponent(file)}?v=${character.version}`;
    });
  const rotations = {};
  for (const dir of DIRECTIONS) if (manifest.rotations?.[dir]) rotations[dir] = await load(manifest.rotations[dir]);
  if (!rotations.south) throw new Error("sin vista de frente");
  const walk = {};
  for (const dir of DIRECTIONS) {
    const frames = manifest.walk?.[dir];
    if (Array.isArray(frames) && frames.length) walk[dir] = await Promise.all(frames.map(load));
  }
  const bounds = opaqueBounds(rotations.south);
  return {
    kind: "pixellab",
    bounds,
    frame(dir, moving, time) {
      const frames = moving ? walk[dir] : null;
      const image = frames?.length ? frames[Math.floor(time / 110) % frames.length] : (rotations[dir] ?? rotations.south);
      return { image, sx: 0, sy: 0, sw: image.naturalWidth, sh: image.naturalHeight };
    },
  };
}

function opaqueBounds(image) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let top = height;
  let bottom = 0;
  let left = width;
  let right = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] < 24) continue;
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      left = Math.min(left, x);
      right = Math.max(right, x);
    }
  }
  if (top > bottom) return { top: 0, bottom: height - 1, cx: width / 2 };
  return { top, bottom, cx: (left + right + 1) / 2 };
}

// ---------- iconos (los mismos trazos que la app) ----------

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

// ---------- la oficina ----------

/**
 * `host` da los datos y acciones de la app: agents(), channels(), colorOf(agent), openAgent(id),
 * openChannel(id), imageUrl(agentId, path), renderMarkdown(text, element) y api(path).
 */
export function createOffice(host) {
  const root = host.root;
  const scroller = root.querySelector(".office-scroll");
  const tip = root.querySelector(".office-tip");
  const boardView = root.querySelector(".office-board");
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const art = { images: new Map(), rects: null, hd: false, version: 0, loading: null };
  const walkways = new Map();
  const panels = new Map();
  const actors = new Map();
  const sprites = new Map();
  const envelopes = [];
  const pinned = new Map();
  const live = { board: "", images: [], activity: new Map(), asking: new Set(), failed: new Map(), typing: new Map() };
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
      live.images = Array.isArray(data.images) ? data.images : [];
      live.activity = new Map(Object.entries(data.activity ?? {}));
      live.asking = new Set(data.asking ?? []);
      live.failed = new Map((data.failed ?? []).map((id) => [id, Date.now()]));
      if (data.art) {
        const changed = data.art.hd !== art.hd || data.art.version !== art.version;
        art.hd = Boolean(data.art.hd);
        art.version = data.art.version ?? 0;
        if (changed && art.rects) void loadArt(true);
      }
      root.dispatchEvent(new CustomEvent("office-status", { detail: data }));
      snapshotLoaded = true;
      for (const panel of panels.values()) panel.dirty = true;
    } catch {
      // Sin el resumen igual se ve la oficina: se completa con los eventos.
    }
  }

  async function loadArt(force = false) {
    if (art.loading && !force) return art.loading;
    art.loading = (async () => {
      if (!art.rects) {
        const response = await fetch("/office/arte.json", { credentials: "same-origin" });
        art.rects = (await response.json()).pieces;
      }
      const names = ["salon", "sala", "jefe", "escritorio", "silla"];
      const images = await Promise.all(
        names.map(
          (name) =>
            new Promise((resolve) => {
              const image = new Image();
              image.decoding = "async";
              image.onload = () => resolve([name, image]);
              image.onerror = () => resolve([name, null]);
              image.src = `/api/office/art/${name}?v=${art.version}${art.hd ? "-hd" : ""}`;
            }),
        ),
      );
      for (const [name, image] of images) if (image) art.images.set(name, image);
      for (const panel of panels.values()) panel.dirty = true;
    })();
    return art.loading;
  }

  // ---------- salas ----------

  function sync() {
    const agents = host.agents();
    const channels = host.channels();
    const main = agents.find((agent) => agent.main) ?? null;
    const plan = planOffice({ agents, channels, mainId: main?.id ?? null });
    const keep = new Set(plan.panels.map((panel) => panel.id));
    for (const [id, panel] of panels) {
      if (!keep.has(id)) {
        panel.element.remove();
        panels.delete(id);
      }
    }
    let previous = null;
    for (const spec of plan.panels) {
      let panel = panels.get(spec.id);
      if (!panel) {
        panel = createPanel(spec);
        panels.set(spec.id, panel);
      }
      Object.assign(panel, { title: spec.title, topic: spec.topic, channelId: spec.channelId, leadId: spec.leadId, seats: spec.seats, dirty: true });
      panel.walkway = walkwayFor(panel);
      panel.element.setAttribute("aria-label", panel.kind === "hall" ? "Salón de Claude Bot" : `Sala ${spec.title}`);
      // Mismo orden que el plan: el salón arriba y las salas debajo.
      if (previous ? previous.element.nextElementSibling !== panel.element : scroller.firstElementChild !== panel.element) {
        if (previous) previous.element.after(panel.element);
        else scroller.prepend(panel.element);
      }
      previous = panel;
    }
    // Cada agente en su puesto: el de la sala del canal para el que trabaja ahora o el de su sala de siempre.
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    const workingIn = new Map();
    for (const channel of channels) for (const id of channel.working ?? []) if (!workingIn.has(id)) workingIn.set(id, `c:${channel.id}`);
    const placed = new Set();
    for (const agent of agents) {
      const seats = [];
      for (const panel of panels.values()) for (const seat of panel.seats) if (seat.agentId === agent.id) seats.push({ panel, seat });
      if (!seats.length) continue;
      const preferred = workingIn.get(agent.id);
      const target =
        seats.find((entry) => entry.panel.id === preferred) ??
        seats.find((entry) => entry.panel.id === `c:${plan.home.get(agent.id)}`) ??
        seats[0];
      placed.add(agent.id);
      let actor = actors.get(agent.id);
      if (!actor) {
        actor = { id: agent.id, x: target.seat.x, y: target.seat.y, dir: "south", pose: "sit", path: [], nextMoveAt: performance.now() + 4000 + Math.random() * 8000, errand: null, fade: 1 };
        actors.set(agent.id, actor);
      }
      actor.agent = agent;
      if (actor.panel !== target.panel || actor.seat?.kind !== target.seat.kind || actor.seat.x !== target.seat.x || actor.seat.y !== target.seat.y) {
        const moved = actor.panel && actor.panel !== target.panel;
        actor.panel = target.panel;
        actor.seat = target.seat;
        if (moved || !actor.placed) {
          // Entra a otra sala: aparece en su puesto.
          Object.assign(actor, { x: target.seat.x, y: target.seat.y, pose: "sit", path: [], dir: "south", fade: moved ? 0 : 1 });
        } else if (actor.pose === "sit") {
          Object.assign(actor, { x: target.seat.x, y: target.seat.y });
        } else {
          actor.path = [];
        }
        actor.placed = true;
      }
      ensureSprite(agent);
    }
    for (const id of [...actors.keys()]) if (!placed.has(id) || !byId.has(id)) actors.delete(id);
    root.dispatchEvent(new CustomEvent("office-agents", { detail: { agents } }));
  }

  function walkwayFor(panel) {
    const key = `${panel.kind}:${panel.seats.map((seat) => `${seat.kind}${Math.round(seat.anchorX ?? seat.x)},${Math.round(seat.anchorY ?? seat.y)},${seat.scale ?? 1}`).join(";")}`;
    if (walkways.has(key)) return walkways.get(key);
    const base = panel.kind === "hall" ? HALL : ROOM;
    const obstacles = [...base.obstacles];
    for (const seat of panel.seats) {
      if (seat.kind !== "desk") continue;
      const s = seat.scale;
      obstacles.push({ x: seat.anchorX - 395 * s, y: seat.anchorY - 125 * s, w: 790 * s, h: 135 * s });
    }
    const walkway = new Walkway(base.floor, obstacles);
    walkways.set(key, walkway);
    return walkway;
  }

  function createPanel(spec) {
    const element = document.createElement("div");
    element.className = "office-panel";
    element.dataset.panel = spec.id;
    element.setAttribute("role", "group");
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    const list = document.createElement("ul");
    list.className = "visually-hidden";
    element.append(canvas, list);
    const panel = { id: spec.id, kind: spec.kind, element, canvas, list, ctx: canvas.getContext("2d"), visible: false, dirty: true, width: 0, height: 0 };
    observer?.observe(element);
    resizer?.observe(element);
    canvas.addEventListener("pointermove", (event) => onPointerMove(panel, event));
    canvas.addEventListener("pointerleave", () => setHover(null));
    canvas.addEventListener("click", (event) => onClick(panel, event));
    return panel;
  }

  const observer =
    typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => {
          for (const entry of entries) {
            const panel = [...panels.values()].find((item) => item.element === entry.target);
            if (panel) panel.visible = entry.isIntersecting;
          }
        }, { root: scroller, rootMargin: "120px" })
      : null;

  const resizer =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => {
          for (const panel of panels.values()) panel.dirty = true;
        })
      : null;

  // ---------- sprites ----------

  function ensureSprite(agent) {
    const color = host.colorOf(agent);
    const character = agent.character && agent.character.status === "ready" ? agent.character : null;
    const key = character ? `px:${character.version}` : `drawn:${color}`;
    const current = sprites.get(agent.id);
    if (current?.key === key || current?.pending === key) return;
    if (!current || current.sprite.kind !== "pixellab" || character) {
      // Mientras carga el de PixelLab, queda el dibujado.
      if (!current || !character) sprites.set(agent.id, { key: character ? `drawn:${color}` : key, sprite: proceduralSprite(agent, color) });
    }
    if (!character) return;
    const holder = sprites.get(agent.id);
    holder.pending = key;
    pixelLabSprite(agent.id, character)
      .then((sprite) => sprites.set(agent.id, { key, sprite }))
      .catch(() => {
        holder.pending = null;
      });
  }

  function spriteOf(actor) {
    return sprites.get(actor.id)?.sprite ?? null;
  }

  // ---------- comportamiento ----------

  function busy(agent) {
    return agent.state === "working" || agent.state === "queued" || agent.state === "paused" || live.asking.has(agent.id);
  }

  function update(actor, dt, now) {
    const agent = actor.agent;
    if (!agent || !actor.panel) return;
    if (actor.fade < 1) actor.fade = Math.min(1, actor.fade + dt * 2.5);
    const seat = actor.seat;
    const walkway = actor.panel.walkway;
    // Recado de Claude Bot: escribir en la pizarra.
    if (actor.errand && now > actor.errand.until && actor.errand.phase === "writing") actor.errand = null;
    if (actor.errand?.phase === "going" && !actor.path.length && actor.pose !== "walk") actor.errand.phase = "writing";
    if (reducedMotion) {
      Object.assign(actor, { x: seat.x, y: seat.y, pose: "sit", path: [], dir: "south" });
      return;
    }
    if (actor.pose === "walk") {
      step(actor, dt);
      return;
    }
    if (actor.errand) {
      if (actor.errand.phase === "start") {
        go(actor, walkway, HALL.boardSpot, "north");
        actor.errand.phase = "going";
      }
      return;
    }
    if (busy(agent)) {
      if (actor.pose !== "sit") go(actor, walkway, seat, "south", true);
      return;
    }
    if (now < actor.nextMoveAt) return;
    // Libre: a veces se levanta a dar una vuelta; a veces vuelve a su puesto.
    const spots = (actor.panel.kind === "hall" ? HALL.spots : ROOM.spots).filter((spot) => walkway.free(spot.x, spot.y));
    const roam = actor.pose === "sit" ? Math.random() < 0.7 : Math.random() < 0.45;
    if (roam && spots.length) {
      const taken = new Set([...actors.values()].filter((other) => other !== actor && other.panel === actor.panel && other.goal).map((other) => `${other.goal.x},${other.goal.y}`));
      const options = spots.filter((spot) => !taken.has(`${spot.x},${spot.y}`) && Math.hypot(spot.x - actor.x, spot.y - actor.y) > 120);
      const spot = options[Math.floor(Math.random() * options.length)];
      if (spot) go(actor, walkway, spot, spot.dir);
      actor.nextMoveAt = now + 6000 + Math.random() * 9000;
    } else if (actor.pose !== "sit") {
      go(actor, walkway, seat, "south", true);
      actor.nextMoveAt = now + 9000 + Math.random() * 14000;
    } else {
      actor.nextMoveAt = now + 5000 + Math.random() * 8000;
    }
  }

  function go(actor, walkway, target, facing, sit = false) {
    if (actor.goal && actor.goal.x === target.x && actor.goal.y === target.y && actor.pose === "walk") return;
    if (actor.pose === "sit") {
      // Se levanta hacia un lado del escritorio antes de caminar.
      actor.pose = "stand";
    }
    actor.goal = { x: target.x, y: target.y, facing, sit };
    actor.path = walkway.path({ x: actor.x, y: actor.y }, target);
    actor.pose = "walk";
  }

  function step(actor, dt) {
    const scale = actor.seat?.scale ?? 1;
    let budget = (actor.panel.kind === "hall" ? 330 : 300) * Math.max(0.55, scale) * dt;
    while (budget > 0 && actor.path.length) {
      const next = actor.path[0];
      const dx = next.x - actor.x;
      const dy = next.y - actor.y;
      const distance = Math.hypot(dx, dy);
      if (distance > 0.5) actor.dir = Math.abs(dx) > Math.abs(dy) * 0.9 ? (dx > 0 ? "east" : "west") : dy > 0 ? "south" : "north";
      if (distance <= budget) {
        actor.x = next.x;
        actor.y = next.y;
        actor.path.shift();
        budget -= distance;
      } else {
        actor.x += (dx / distance) * budget;
        actor.y += (dy / distance) * budget;
        budget = 0;
      }
    }
    if (!actor.path.length) {
      const goal = actor.goal;
      actor.pose = goal?.sit ? "sit" : "stand";
      actor.dir = goal?.facing ?? "south";
      if (goal?.sit) {
        actor.x = actor.seat.x;
        actor.y = actor.seat.y;
      }
      actor.goal = goal?.sit ? null : goal;
    }
  }

  // ---------- dibujo ----------

  function resize(panel) {
    const rect = panel.element.getBoundingClientRect();
    const ratio = Math.min(2.5, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round((rect.width * ratio * WORLD_H) / WORLD_W));
    if (panel.canvas.width !== width || panel.canvas.height !== height) {
      panel.canvas.width = width;
      panel.canvas.height = height;
    }
    panel.cssWidth = rect.width;
    panel.scale = width / WORLD_W;
  }

  function drawPanel(panel, now) {
    if (panel.dirty) {
      resize(panel);
      panel.dirty = false;
      renderList(panel);
    }
    const ctx = panel.ctx;
    const scale = panel.scale;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    const background = art.images.get(panel.kind === "hall" ? "salon" : "sala");
    if (background) ctx.drawImage(background, 0, 0, WORLD_W, WORLD_H);
    else {
      ctx.fillStyle = "#3b2a1e";
      ctx.fillRect(0, 0, WORLD_W, WORLD_H);
    }
    if (panel.kind === "hall") drawBoard(ctx);
    else {
      drawPlaque(ctx, panel);
      drawCork(ctx, panel);
    }
    // Lo de más atrás primero: sillas, personajes y escritorios ordenados por su base.
    const items = [];
    for (const seat of panel.seats) {
      if (seat.kind === "desk") {
        items.push({ depth: seat.y - 30 * seat.scale, draw: () => drawPiece(ctx, "silla", seat) });
        items.push({ depth: seat.anchorY, draw: () => drawDesk(ctx, panel, seat, now) });
      } else {
        items.push({ depth: 1240, draw: () => drawBoss(ctx, seat, now) });
      }
    }
    for (const actor of actors.values()) {
      if (actor.panel !== panel) continue;
      const depth = actor.pose === "sit" ? actor.seat.y : actor.y;
      items.push({ depth, draw: () => drawActor(ctx, actor, now) });
    }
    items.sort((a, b) => a.depth - b.depth);
    for (const item of items) item.draw();
    for (const actor of actors.values()) if (actor.panel === panel) drawOverhead(ctx, actor, now);
    drawEnvelopes(ctx, panel, now);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Dibuja un recorte (escritorio, silla) donde va según el puesto. */
  function drawPiece(ctx, name, seat) {
    const image = art.images.get(name);
    const rect = art.rects?.[name];
    if (!image || !rect) return;
    const s = seat.scale;
    const dx = seat.anchorX + (rect[0] - DESK_ANCHOR.x) * s;
    const dy = seat.anchorY + (rect[1] - DESK_ANCHOR.y) * s;
    drawCut(ctx, image, rect, dx, dy, rect[2] * s, rect[3] * s);
  }

  function drawCut(ctx, image, rect, dx, dy, dw, dh) {
    if (art.hd) {
      // En alta resolución el recorte viene en el lienzo completo del dibujo.
      const k = image.naturalWidth / WORLD_W;
      ctx.drawImage(image, rect[0] * k, rect[1] * k, rect[2] * k, rect[3] * k, dx, dy, dw, dh);
    } else {
      ctx.drawImage(image, dx, dy, dw, dh);
    }
  }

  function drawDesk(ctx, panel, seat, now) {
    const s = seat.scale;
    // Sombra suave bajo el escritorio (el recorte viene sin ella).
    ctx.save();
    ctx.globalAlpha = 0.35;
    const shadow = ctx.createRadialGradient(seat.anchorX, seat.anchorY - 12 * s, 10 * s, seat.anchorX, seat.anchorY - 12 * s, 430 * s);
    shadow.addColorStop(0, "rgba(20, 10, 4, 0.9)");
    shadow.addColorStop(1, "rgba(20, 10, 4, 0)");
    ctx.fillStyle = shadow;
    ctx.beginPath();
    ctx.ellipse(seat.anchorX, seat.anchorY - 12 * s, 430 * s, 70 * s, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    drawPiece(ctx, "escritorio", seat);
    const actor = actors.get(seat.agentId);
    const agent = actor?.agent;
    if (agent?.state === "working" && actor.panel === panel && actor.pose === "sit") drawGlow(ctx, seat.glow.x, seat.glow.y, 120 * s, now);
    if (agent) drawPlate(ctx, seat, agent, panel);
  }

  function drawBoss(ctx, seat, now) {
    const image = art.images.get("jefe");
    const rect = art.rects?.jefe;
    if (image && rect) drawCut(ctx, image, rect, rect[0], rect[1], rect[2], rect[3]);
    const actor = actors.get(seat.agentId);
    if (actor?.agent?.state === "working" && actor.pose === "sit") drawGlow(ctx, seat.glow.x, seat.glow.y, 150, now);
  }

  /** Luz de la pantalla del portátil mientras trabaja. */
  function drawGlow(ctx, x, y, radius, now) {
    const flicker = 0.85 + Math.sin(now / 180) * 0.05 + Math.sin(now / 47) * 0.03;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
    glow.addColorStop(0, `rgba(140, 200, 255, ${0.42 * flicker})`);
    glow.addColorStop(1, "rgba(140, 200, 255, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    ctx.restore();
  }

  /** Placa con el nombre al frente del escritorio. */
  function drawPlate(ctx, seat, agent, panel) {
    const s = seat.scale;
    const size = Math.max(30 * s, 11 / panel.scale);
    ctx.save();
    ctx.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    const name = clipText(ctx, agent.name, 300 * s);
    const width = ctx.measureText(name).width + size * 1.1;
    const height = size * 1.55;
    const x = seat.plate.x - width / 2;
    const y = seat.plate.y - height / 2;
    ctx.fillStyle = "rgba(38, 24, 14, 0.82)";
    roundRect(ctx, x, y, width, height, height * 0.3);
    ctx.fill();
    ctx.strokeStyle = "rgba(214, 170, 96, 0.75)";
    ctx.lineWidth = Math.max(2, 3 * s);
    ctx.stroke();
    ctx.fillStyle = "#f6e7c9";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(name, seat.plate.x, seat.plate.y + size * 0.04);
    ctx.restore();
  }

  function drawActor(ctx, actor, now) {
    const sprite = spriteOf(actor);
    if (!sprite) return;
    const seat = actor.seat;
    const moving = actor.pose === "walk";
    const sitting = actor.pose === "sit";
    const frame = sprite.frame(sitting ? "south" : actor.dir, moving, now + (hashText(actor.id) % 500));
    const bounds = sprite.bounds;
    const height = seat.height;
    // Escala entera en píxeles de pantalla para que el pixel art no se deforme.
    const raw = height / (bounds.bottom - bounds.top + 1);
    const device = Math.max(1, Math.round(raw * actor.panel.scale));
    const k = device / actor.panel.scale;
    const working = sitting && actor.agent.state === "working";
    const bob = working ? (Math.floor(now / 260 + (hashText(actor.id) % 7)) % 2) * k * 0.6 : 0;
    const feetY = sitting ? seat.headTop + (bounds.bottom - bounds.top + 1) * k : actor.y;
    const dx = Math.round((actor.x - bounds.cx * k) * actor.panel.scale) / actor.panel.scale;
    const dy = Math.round((feetY - (bounds.bottom + 1) * k + bob) * actor.panel.scale) / actor.panel.scale;
    ctx.save();
    ctx.globalAlpha = actor.fade;
    if (!sitting) {
      ctx.fillStyle = "rgba(15, 8, 3, 0.32)";
      ctx.beginPath();
      ctx.ellipse(actor.x, actor.y, 60 * (height / 430), 16 * (height / 430), 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Sentado: lo que queda bajo la cubierta del escritorio no se ve.
      ctx.beginPath();
      ctx.rect(0, 0, WORLD_W, seat.clipY);
      ctx.clip();
    }
    if (actor.agent.state === "paused") ctx.filter = "saturate(0.35) brightness(0.85)";
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(frame.image, frame.sx, frame.sy, frame.sw, frame.sh, dx, dy, frame.sw * k, frame.sh * k);
    ctx.restore();
    actor.box = { x: dx + (bounds.cx - (bounds.cx - 0)) * 0, y: dy + bounds.top * k, w: frame.sw * k, h: (bounds.bottom - bounds.top + 1) * k, left: dx, top: dy + bounds.top * k };
    actor.head = { x: actor.x, y: dy + bounds.top * k + bob };
  }

  /** Burbujas y avisos sobre la cabeza: ?, !, zzz, reloj de arena o lo que está haciendo. */
  function drawOverhead(ctx, actor, now) {
    if (!actor.head || actor.fade < 0.6) return;
    const agent = actor.agent;
    const unit = 1 / actor.panel.scale;
    const size = Math.max(30 * unit, Math.min(64, 54 * (actor.seat.height / 430)) * 1.1);
    const progress = visibleProgress(agent);
    if (progress) drawProgress(ctx, actor, progress, size, unit);
    const x = actor.head.x + size * 0.55;
    const y = actor.head.y - size * 0.35;
    const failed = live.failed.get(agent.id);
    if (live.asking.has(agent.id)) return bubble(ctx, x, y, size, { text: "?", fill: "#ffd23f", ink: "#3a2a00", pulse: now });
    if (failed && now - failed < 0) return;
    if (failed && Date.now() - failed < 45_000) return bubble(ctx, x, y, size, { text: "!", fill: "#e5484d", ink: "#fff", pulse: now });
    if (agent.state === "paused") return drawZzz(ctx, actor.head.x + size * 0.4, actor.head.y, size, now);
    if (agent.state === "queued") return bubble(ctx, x, y, size, { icon: "hourglass", fill: "#f4ead7", ink: "#5b4630" });
    if (agent.state !== "working") return;
    const activity = live.activity.get(agent.id);
    const typing = live.typing.get(agent.id) ?? 0;
    if (activity && Date.now() - activity.at < 9000 && (!typing || activity.at >= typing - 400)) {
      return bubble(ctx, x, y, size, { icon: activity.icon ?? activityIcon(activity.text), fill: "#f7f2ea", ink: "#2c2118" });
    }
    return bubble(ctx, x, y, size, { dots: now, fill: "#f7f2ea", ink: "#2c2118" });
  }

  /** Barra con el porcentaje de su tarea, bajo la burbuja. */
  function drawProgress(ctx, actor, progress, size, unit) {
    const w = Math.max(70 * unit, size * 1.9);
    const h = Math.max(15 * unit, size * 0.34);
    const x = actor.head.x - w / 2;
    const y = actor.head.y - size * 1.42 - h;
    const done = progress.percent >= 100;
    ctx.save();
    ctx.fillStyle = "rgba(20, 12, 4, 0.78)";
    roundRect(ctx, x - 2 * unit, y - 2 * unit, w + 4 * unit, h + 4 * unit, h * 0.5);
    ctx.fill();
    ctx.fillStyle = "rgba(255, 255, 255, 0.14)";
    roundRect(ctx, x, y, w, h, h * 0.45);
    ctx.fill();
    if (progress.percent > 0) {
      ctx.fillStyle = done ? "#46a758" : "#e0a526";
      roundRect(ctx, x, y, Math.max(h, (w * progress.percent) / 100), h, h * 0.45);
      ctx.fill();
    }
    ctx.fillStyle = "#fff";
    ctx.font = `800 ${h * 0.78}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0, 0, 0, 0.7)";
    ctx.shadowBlur = 2 * unit;
    ctx.fillText(done ? "Listo" : `${progress.percent} %`, x + w / 2, y + h / 2 + h * 0.04);
    ctx.restore();
  }

  function bubble(ctx, x, y, size, options) {
    const pulse = options.pulse ? 1 + Math.sin(options.pulse / 220) * 0.05 : 1;
    const w = size * pulse;
    const h = size * pulse;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = "rgba(10, 6, 2, 0.28)";
    roundRect(ctx, -w / 2 + w * 0.06, -h + h * 0.08, w, h * 0.86, h * 0.3);
    ctx.fill();
    ctx.fillStyle = options.fill;
    roundRect(ctx, -w / 2, -h, w, h * 0.86, h * 0.3);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-w * 0.22, -h * 0.16);
    ctx.lineTo(-w * 0.38, h * 0.06);
    ctx.lineTo(-w * 0.02, -h * 0.16);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(40, 26, 12, 0.55)";
    ctx.lineWidth = w * 0.05;
    roundRect(ctx, -w / 2, -h, w, h * 0.86, h * 0.3);
    ctx.stroke();
    ctx.fillStyle = options.ink;
    ctx.strokeStyle = options.ink;
    if (options.text) {
      ctx.font = `800 ${h * 0.62}px system-ui, -apple-system, "Segoe UI", sans-serif`;
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

  function drawZzz(ctx, x, y, size, now) {
    ctx.save();
    ctx.font = `800 ${size * 0.5}px system-ui, sans-serif`;
    ctx.textAlign = "left";
    for (let index = 0; index < 3; index += 1) {
      const phase = (now / 1400 + index / 3) % 1;
      ctx.globalAlpha = Math.sin(phase * Math.PI);
      ctx.fillStyle = "#dbe8ff";
      ctx.strokeStyle = "rgba(20, 30, 60, 0.6)";
      ctx.lineWidth = size * 0.06;
      const zx = x + phase * size * 0.6;
      const zy = y - phase * size * 1.2;
      ctx.strokeText("z", zx, zy);
      ctx.fillText("z", zx, zy);
    }
    ctx.restore();
  }

  // ---------- pizarra, cartel y corcho ----------

  function drawBoard(ctx) {
    const lines = boardLines(live.board);
    if (!lines.length) return;
    const { tl, tr, bl } = HALL.board;
    const W = 300;
    const H = 260;
    ctx.save();
    // Del rectángulo W × H al cuadrilátero de la pizarra del dibujo.
    ctx.transform((tr[0] - tl[0]) / W, (tr[1] - tl[1]) / W, (bl[0] - tl[0]) / H, (bl[1] - tl[1]) / H, tl[0], tl[1]);
    ctx.fillStyle = "#24407a";
    ctx.textBaseline = "top";
    ctx.globalAlpha = 0.88;
    const PAD = 18;
    const rows = [];
    lines.slice(0, 12).forEach((line, index) => {
      const size = index === 0 ? 30 : 24;
      const font = `${index === 0 ? 700 : 500} ${size}px "Segoe Print", "Bradley Hand", "Comic Sans MS", "Chalkboard SE", cursive`;
      ctx.font = font;
      for (const text of wrapText(ctx, line, W - PAD * 2)) rows.push({ text, size, font });
    });
    let y = PAD;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const next = rows[index + 1];
      // Si la fila siguiente ya no cabe, esta termina en «…».
      const cut = next && y + row.size * 1.3 + next.size > H - 10;
      ctx.font = row.font;
      ctx.fillText(clipText(ctx, cut ? `${row.text}…` : row.text, W - PAD * 2), PAD, y);
      if (cut) break;
      y += row.size * 1.3;
    }
    ctx.restore();
  }

  function drawPlaque(ctx, panel) {
    const { x, y, w, h } = ROOM.plaque;
    ctx.save();
    let size = 62;
    ctx.font = `700 ${size}px Georgia, "Times New Roman", serif`;
    while (size > 30 && ctx.measureText(panel.title).width > w - 10) {
      size -= 2;
      ctx.font = `700 ${size}px Georgia, "Times New Roman", serif`;
    }
    const text = clipText(ctx, panel.title, w - 6);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(30, 16, 6, 0.75)";
    ctx.fillText(text, x + w / 2 + 3, y + h / 2 + 4);
    ctx.fillStyle = "#f4dfb4";
    ctx.fillText(text, x + w / 2, y + h / 2);
    ctx.restore();
  }

  function drawCork(ctx, panel) {
    const { x, y, w, h } = ROOM.cork;
    const members = new Set(panel.seats.map((seat) => seat.agentId));
    const images = live.images.filter((image) => (panel.channelId && image.channelId === panel.channelId) || (!image.channelId && members.has(image.agentId))).slice(0, 4);
    const notes = [];
    if (!images.length && panel.topic) notes.push(panel.topic);
    const slots = [
      { x: x + 18, y: y + 14, r: -0.06 },
      { x: x + 222, y: y + 22, r: 0.05 },
      { x: x + 120, y: y + 118, r: 0.03 },
      { x: x + 300, y: y + 126, r: -0.04 },
    ];
    panel.pins = [];
    images.forEach((item, index) => {
      const slot = slots[index];
      const image = pinnedImage(item);
      const frameW = 168;
      const frameH = 150;
      ctx.save();
      ctx.translate(slot.x + frameW / 2, slot.y + frameH / 2);
      ctx.rotate(slot.r);
      ctx.fillStyle = "rgba(20, 10, 2, 0.35)";
      ctx.fillRect(-frameW / 2 + 6, -frameH / 2 + 8, frameW, frameH);
      ctx.fillStyle = "#f8f4ea";
      ctx.fillRect(-frameW / 2, -frameH / 2, frameW, frameH);
      if (image?.complete && image.naturalWidth) {
        const inner = coverRect(image.naturalWidth, image.naturalHeight, frameW - 20, frameH - 38);
        ctx.save();
        ctx.beginPath();
        ctx.rect(-frameW / 2 + 10, -frameH / 2 + 10, frameW - 20, frameH - 38);
        ctx.clip();
        ctx.drawImage(image, -frameW / 2 + 10 + inner.x, -frameH / 2 + 10 + inner.y, inner.w, inner.h);
        ctx.restore();
      } else {
        ctx.fillStyle = "#d9d1c0";
        ctx.fillRect(-frameW / 2 + 10, -frameH / 2 + 10, frameW - 20, frameH - 38);
      }
      ctx.fillStyle = "#c0392b";
      ctx.beginPath();
      ctx.arc(0, -frameH / 2 + 4, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      panel.pins.push({ x: slot.x, y: slot.y, w: frameW, h: frameH, item });
    });
    notes.forEach((note) => {
      ctx.save();
      ctx.translate(x + 120, y + 40);
      ctx.rotate(-0.03);
      ctx.fillStyle = "rgba(20, 10, 2, 0.3)";
      ctx.fillRect(6, 8, 190, 170);
      ctx.fillStyle = "#fbe9a6";
      ctx.fillRect(0, 0, 190, 170);
      ctx.fillStyle = "#4b3a1a";
      ctx.font = `500 24px "Segoe Print", "Bradley Hand", "Comic Sans MS", cursive`;
      ctx.textBaseline = "top";
      wrapText(ctx, note, 170).slice(0, 5).forEach((line, index) => ctx.fillText(line, 12, 14 + index * 30));
      ctx.fillStyle = "#2d6cdf";
      ctx.beginPath();
      ctx.arc(95, 6, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
  }

  function pinnedImage(item) {
    const key = `${item.agentId}:${item.path}`;
    if (!pinned.has(key)) {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => {
        for (const panel of panels.values()) panel.dirty = true;
      };
      image.src = host.imageUrl(item.agentId, item.path);
      pinned.set(key, image);
    }
    return pinned.get(key);
  }

  // ---------- sobres entre agentes ----------

  function sendEnvelope(fromId, toId) {
    const from = actors.get(fromId);
    const to = actors.get(toId);
    if (!to) return;
    const start = performance.now();
    if (from && from.panel === to.panel) {
      envelopes.push({ panel: to.panel, from, to, start, duration: 1300 });
      return;
    }
    // De una sala a otra: sale por arriba de una y entra por arriba de la otra.
    if (from) envelopes.push({ panel: from.panel, from, to: null, start, duration: 900 });
    envelopes.push({ panel: to.panel, from: null, to, start: start + (from ? 600 : 0), duration: 1000 });
  }

  function drawEnvelopes(ctx, panel, now) {
    for (let index = envelopes.length - 1; index >= 0; index -= 1) {
      const envelope = envelopes[index];
      const t = (now - envelope.start) / envelope.duration;
      if (t > 1) {
        envelopes.splice(index, 1);
        continue;
      }
      if (envelope.panel !== panel || t < 0) continue;
      const a = envelope.from ? headPoint(envelope.from) : { x: (envelope.to?.x ?? WORLD_W / 2) + 300, y: -80 };
      const b = envelope.to ? headPoint(envelope.to) : { x: a.x + 200, y: -120 };
      const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      const lift = Math.sin(ease * Math.PI) * 220;
      const x = a.x + (b.x - a.x) * ease;
      const y = a.y + (b.y - a.y) * ease - lift;
      const size = Math.max(70, 26 / panel.scale);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.sin(t * Math.PI * 2) * 0.18);
      ctx.globalAlpha = Math.min(1, (1 - t) * 4, t * 6);
      ctx.fillStyle = "rgba(10, 6, 2, 0.3)";
      ctx.fillRect(-size / 2 + size * 0.06, -size * 0.32 + size * 0.08, size, size * 0.66);
      ctx.fillStyle = "#fff8e8";
      ctx.strokeStyle = "#7a5a32";
      ctx.lineWidth = size * 0.05;
      ctx.fillRect(-size / 2, -size * 0.33, size, size * 0.66);
      ctx.strokeRect(-size / 2, -size * 0.33, size, size * 0.66);
      ctx.beginPath();
      ctx.moveTo(-size / 2, -size * 0.33);
      ctx.lineTo(0, size * 0.06);
      ctx.lineTo(size / 2, -size * 0.33);
      ctx.stroke();
      ctx.fillStyle = "#c0392b";
      ctx.beginPath();
      ctx.arc(0, size * 0.04, size * 0.09, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function headPoint(actor) {
    return actor.head ? { x: actor.head.x, y: actor.head.y - 20 } : { x: actor.x, y: actor.y - (actor.seat?.height ?? 400) };
  }

  // ---------- puntero ----------

  function toWorld(panel, event) {
    const rect = panel.canvas.getBoundingClientRect();
    return { x: ((event.clientX - rect.left) / rect.width) * WORLD_W, y: ((event.clientY - rect.top) / rect.height) * WORLD_H };
  }

  function hit(panel, point) {
    let found = null;
    for (const actor of actors.values()) {
      if (actor.panel !== panel || !actor.box) continue;
      const box = actor.box;
      const pad = 12;
      const bottom = actor.pose === "sit" ? actor.seat.clipY : box.top + box.h;
      if (point.x >= box.left - pad && point.x <= box.left + box.w + pad && point.y >= box.top - pad && point.y <= bottom + pad) {
        if (!found || actor.y > found.actor.y) found = { kind: "agent", actor };
      }
    }
    if (found) return found;
    for (const seat of panel.seats) {
      if (seat.kind !== "desk") continue;
      const s = seat.scale;
      if (Math.abs(point.x - seat.anchorX) < 380 * s && point.y > seat.anchorY - 440 * s && point.y < seat.anchorY) return { kind: "desk", agentId: seat.agentId };
    }
    if (panel.kind === "hall") {
      const { tl, br } = HALL.board;
      if (point.x > tl[0] && point.x < br[0] && point.y > HALL.board.tr[1] && point.y < HALL.board.bl[1]) return { kind: "board" };
      if (point.x > 552 && point.x < 1250 && point.y > 713 && point.y < 1260) return { kind: "desk", agentId: panel.seats[0]?.agentId };
    } else {
      for (const pin of panel.pins ?? []) {
        if (point.x > pin.x && point.x < pin.x + pin.w && point.y > pin.y && point.y < pin.y + pin.h) return { kind: "image", item: pin.item };
      }
      const plaque = ROOM.plaque;
      if (panel.channelId && point.x > plaque.x - 30 && point.x < plaque.x + plaque.w + 30 && point.y > plaque.y - 30 && point.y < plaque.y + plaque.h + 30) {
        return { kind: "channel", channelId: panel.channelId };
      }
    }
    return null;
  }

  function onPointerMove(panel, event) {
    const target = hit(panel, toWorld(panel, event));
    panel.canvas.style.cursor = target ? "pointer" : "";
    if (event.pointerType === "touch") return;
    if (target?.kind === "agent" || target?.kind === "desk") {
      const agent = target.kind === "agent" ? target.actor.agent : host.agents().find((item) => item.id === target.agentId);
      if (agent) return setHover({ agent, x: event.clientX, y: event.clientY });
    }
    if (target?.kind === "board") return setHover({ text: "Pizarra de Claude Bot", x: event.clientX, y: event.clientY });
    if (target?.kind === "channel") return setHover({ text: `Abrir el canal «${panel.title}»`, x: event.clientX, y: event.clientY });
    if (target?.kind === "image") return setHover({ text: "Abrir la imagen", x: event.clientX, y: event.clientY });
    setHover(null);
  }

  function onClick(panel, event) {
    const target = hit(panel, toWorld(panel, event));
    if (!target) return;
    setHover(null);
    if (target.kind === "agent") host.openAgent(target.actor.id);
    else if (target.kind === "desk" && target.agentId) host.openAgent(target.agentId);
    else if (target.kind === "channel") host.openChannel(target.channelId);
    else if (target.kind === "board") showBoard();
    else if (target.kind === "image") window.open(host.imageUrl(target.item.agentId, target.item.path), "_blank", "noopener");
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
    if (agent.character?.status === "drawing") return "Libre · PixelLab está dibujando su personaje";
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

  function renderList(panel) {
    const items = panel.seats
      .map((seat) => actors.get(seat.agentId)?.agent)
      .filter(Boolean)
      .map((agent) => {
        const item = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `${agent.name}: ${describe(agent)}`;
        button.addEventListener("click", () => host.openAgent(agent.id));
        item.append(button);
        return item;
      });
    panel.list.replaceChildren(...items);
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
        if (visible) for (const panel of panels.values()) renderList(panel);
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
      case "office":
        if (event.art) {
          art.hd = Boolean(event.art.hd);
          art.version = event.art.version ?? art.version;
          if (art.rects) void loadArt(true);
        }
        break;
      default:
        break;
    }
  }

  function onMessage(agentId, message) {
    if (!message) return;
    if (message.role === "activity") {
      const payload = message.payload ?? null;
      if (payload?.kind === "image" && typeof payload.path === "string") {
        if (!live.images.some((item) => item.agentId === agentId && item.path === payload.path)) {
          live.images.unshift({ agentId, channelId: message.channelId ?? null, path: payload.path, at: message.createdAt });
          live.images = live.images.slice(0, 40);
        }
      }
      if (payload?.kind === "board-updated") {
        live.board = typeof payload.board === "string" ? payload.board : "";
        const main = actors.get(agentId);
        if (main && main.panel?.kind === "hall" && !reducedMotion) main.errand = { phase: "start", until: performance.now() + 4200 };
      }
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
      if (visible) sendEnvelope(message.fromAgentId, agentId);
      return;
    }
    if (message.role === "assistant" && message.status === "streaming") live.typing.set(agentId, Date.now());
  }

  // ---------- ciclo ----------

  function loop(now) {
    raf = requestAnimationFrame(loop);
    if (document.hidden) return;
    const elapsed = now - lastFrame;
    if (elapsed < 30) return;
    const dt = Math.min(0.1, elapsed / 1000);
    lastFrame = now;
    for (const actor of actors.values()) update(actor, dt, now);
    for (const panel of panels.values()) if (panel.visible || !observer) drawPanel(panel, now);
  }

  function show() {
    if (visible) return;
    visible = true;
    root.hidden = false;
    sync();
    void loadArt();
    void loadSnapshot();
    lastFrame = performance.now();
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
      return [...actors.values()].map((actor) => ({ id: actor.id, panel: actor.panel?.id, pose: actor.pose, x: Math.round(actor.x), y: Math.round(actor.y) }));
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

function wrapText(ctx, text, max) {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > max && line) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
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

function coverRect(width, height, boxW, boxH) {
  const scale = Math.max(boxW / width, boxH / height);
  const w = width * scale;
  const h = height * scale;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}
