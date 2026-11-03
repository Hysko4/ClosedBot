// ClosedBot — interfaz web (sin dependencias ni paso de compilación).

const $ = (selector) => document.querySelector(selector);
const SVG_NS = "http://www.w3.org/2000/svg";
const LETTERS = "ABCD";
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
const AudioCtx = window.AudioContext || window.webkitAudioContext || null;
/** Grabar el micrófono para el dictado en este PC (el navegador solo lo permite en localhost o https). */
const CanRecord = Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia && AudioCtx);
const DICTATION_KEY = "closedbot:dictado";
const BROWSER_FAILED_KEY = "closedbot:dictado-navegador-falla";
/** Dictado en este PC (segundos): cortes en las pausas para que el texto aparezca mientras hablas. */
const LOCAL_DICTATION = {
  calibrate: 0.4,
  preroll: 0.4,
  pause: 0.8,
  softMax: 15,
  hardMax: 28,
  minVoiced: 0.3,
  voiceEnd: 1.4,
  voiceNoSpeech: 8,
  dictateIdle: 45,
  maxTotal: 300,
};
const Synth = "speechSynthesis" in window && typeof window.SpeechSynthesisUtterance === "function" ? window.speechSynthesis : null;
/** Los avatares elegidos a mano se guardan como 10000 + figura × 100 + color (los automáticos son 0, 1, 2…). */
const AVATAR_CUSTOM_BASE = 10_000;
const LONG_PRESS_MS = 500;
const COLLAPSED_KEY = "closedbot:secciones-plegadas";

const state = {
  agents: [],
  providers: [],
  routines: [],
  settings: { botName: "ClosedBot", userName: "", fullAccess: false },
  paths: null,
  version: "",
  maxHops: 0,
  platform: "",
  currentId: null,
  messages: new Map(), // agentId -> array de mensajes en orden
  hasMore: new Map(),
  queues: new Map(),
  attachments: new Map(), // agentId -> archivos adjuntos aún sin enviar
  models: new Map(), // proveedor -> modelos
  queueOpen: false,
  navigatedInApp: false,
  search: "",
  sections: [], // secciones creadas a mano, en orden
  usage: [], // uso del plan por proveedor
  speech: null, // dictado en este PC: { state, model, sizeMb, progress, error } o null si el servidor no lo tiene
  showHidden: false,
  keepUnread: new Set(), // «Marcar como no leído» en la conversación abierta: sigue así hasta que vuelvas a entrar
  collapsed: loadCollapsed(),
};

const elements = new Map(); // id de mensaje -> elemento del DOM (solo el agente abierto)
const dirty = new Set();
const answering = new Set(); // tarjetas de decisión con la respuesta en camino
let renderScheduled = false;
let events = null;
let reconnectTimer = null;
let toastTimer = null;
let readTimer = null;
let editingAgentId = null;
let routinesFilter = null;
let recognition = null;
let dictation = null; // { engine: "browser" | "local", mode: "dictate" | "voice", agentId, cancelled, … }
/** Código de inicio de sesión que se está escribiendo, por proveedor (sobrevive a los repintados). */
const signInCodes = new Map();

const coarsePointer = window.matchMedia("(pointer: coarse)").matches;

// ---------- API ----------

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(path, { method = "GET", body } = {}) {
  const headers = {};
  if (method !== "GET") headers["x-cuadrilla"] = "1";
  if (body !== undefined) headers["content-type"] = "application/json";
  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError("No hay conexión con el servidor.", 0);
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && !path.startsWith("/api/login")) {
    showLogin();
    throw new ApiError(data.error || "Inicia sesión.", 401);
  }
  if (!response.ok) throw new ApiError(data.error || `Error ${response.status}`, response.status);
  return data;
}

async function uploadFile(agentId, file) {
  let response;
  try {
    response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/files?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "x-cuadrilla": "1", "content-type": "application/octet-stream" },
      body: file,
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError("No hay conexión con el servidor.", 0);
  }
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    showLogin();
    throw new ApiError(data.error || "Inicia sesión.", 401);
  }
  if (!response.ok) throw new ApiError(data.error || `Error ${response.status}`, response.status);
  return data.file;
}

// ---------- arranque y sesión ----------

async function boot() {
  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }
  bindUi();
  renderMascots();
  // El acceso directo de escritorio abre la app con un código de un solo uso en ?acceso=.
  const params = new URLSearchParams(location.search);
  const code = params.get("acceso");
  if (code !== null) {
    params.delete("acceso");
    const query = params.toString();
    history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
  }
  let session = null;
  try {
    session = await api("/api/session");
  } catch {
    session = null;
  }
  let problem = "";
  if (!session?.authenticated && code) {
    try {
      await api("/api/login/code", { method: "POST", body: { code } });
      session = { authenticated: true };
    } catch (error) {
      problem = error.message;
    }
  }
  $("#boot").hidden = true;
  if (session?.authenticated) {
    try {
      await enterApp();
    } catch (error) {
      if (error.status !== 401) {
        showLogin();
        $("#login-error").textContent = `No se pudo cargar ClosedBot: ${error.message}`;
      }
    }
  } else {
    showLogin();
    if (problem) $("#login-error").textContent = problem;
  }
}

function showLogin() {
  if (events) {
    events.close();
    events = null;
  }
  clearTimeout(reconnectTimer);
  stopDictation({ cancel: true });
  $("#app").hidden = true;
  $("#boot").hidden = true;
  $("#login").hidden = false;
  $("#login-password").value = "";
  setTimeout(() => $("#login-password").focus(), 50);
}

async function login(event) {
  event.preventDefault();
  const button = $("#login-submit");
  const error = $("#login-error");
  error.textContent = "";
  button.disabled = true;
  try {
    await api("/api/login", { method: "POST", body: { password: $("#login-password").value } });
    $("#login").hidden = true;
    await enterApp();
  } catch (problem) {
    error.textContent = problem.message;
  } finally {
    button.disabled = false;
  }
}

async function enterApp() {
  const data = await api("/api/state");
  state.agents = data.agents;
  state.providers = data.providers;
  state.routines = data.routines ?? [];
  state.settings = data.settings ?? state.settings;
  state.paths = data.paths;
  state.version = data.version;
  state.maxHops = data.maxHops;
  state.platform = data.platform ?? "";
  state.sections = data.sections ?? [];
  state.usage = data.usage ?? [];
  $("#login").hidden = true;
  $("#app").hidden = false;
  renderIdentity();
  renderSidebar();
  renderProviders();
  renderUsage();
  connectEvents();
  await route();
}

async function logout() {
  try {
    await api("/api/logout", { method: "POST" });
  } catch {
    // Igual mostramos el acceso.
  }
  closeDialog($("#settings-dialog"));
  showLogin();
}

// ---------- eventos en vivo ----------

function connectEvents() {
  if (events) events.close();
  clearTimeout(reconnectTimer);
  setConnection("connecting");
  const source = new EventSource("/api/events");
  events = source;
  source.onopen = () => setConnection("live");
  source.onmessage = (message) => {
    let data;
    try {
      data = JSON.parse(message.data);
    } catch {
      return;
    }
    handleEvent(data);
  };
  source.onerror = async () => {
    if (events !== source) return;
    if (source.readyState !== EventSource.CLOSED) {
      setConnection("connecting");
      return;
    }
    setConnection("offline");
    const session = await fetch("/api/session", { credentials: "same-origin" })
      .then((response) => response.json())
      .catch(() => null);
    if (session && !session.authenticated) {
      showLogin();
      return;
    }
    reconnectTimer = setTimeout(connectEvents, 4_000);
  };
}

function setConnection(value) {
  const label = { live: "Conectado", connecting: "Conectando…", offline: "Sin conexión con el servidor" }[value];
  const node = $("#connection");
  node.dataset.state = value;
  node.title = label;
  node.setAttribute("aria-label", label);
}

function handleEvent(event) {
  switch (event.type) {
    case "hello":
      state.agents = event.agents;
      state.providers = event.providers;
      if (event.routines) state.routines = event.routines;
      if (event.settings) state.settings = event.settings;
      if (event.sections) state.sections = event.sections;
      if (event.usage) state.usage = event.usage;
      applySpeechStatus(event.speech ?? null);
      renderIdentity();
      renderPermissions();
      renderSidebar();
      renderProviders();
      renderRoutinesIfOpen();
      renderUsage();
      renderDetailsIfOpen();
      // Tras reconectar pudimos perder eventos: recargamos la conversación abierta.
      if (state.currentId) void loadConversation(state.currentId, { keepScroll: true });
      break;
    case "agents":
      state.agents = event.agents;
      renderSidebar();
      renderHeader();
      updateWorkingIndicator();
      updateActionButton();
      renderDetailsIfOpen();
      noteVoiceTurn();
      if (state.currentId && !findAgent(state.currentId)) void navigate(null);
      else if (state.currentId && findAgent(state.currentId)?.unread) scheduleMarkRead(state.currentId);
      break;
    case "sections":
      state.sections = event.sections;
      renderSidebar();
      break;
    case "usage":
      state.usage = event.usage;
      renderUsage();
      break;
    case "speech":
      applySpeechStatus(event.speech);
      break;
    case "providers": {
      // Si un proveedor se instaló o cambió de sesión, su lista de modelos se vuelve a pedir.
      const before = new Map(state.providers.map((provider) => [provider.id, `${provider.available}:${provider.loggedIn}`]));
      state.providers = event.providers;
      for (const provider of state.providers) {
        if (before.get(provider.id) !== `${provider.available}:${provider.loggedIn}`) state.models.delete(provider.id);
      }
      renderProviders();
      break;
    }
    case "routines":
      state.routines = event.routines;
      renderRoutinesIfOpen();
      renderDetailsIfOpen();
      break;
    case "settings":
      state.settings = event.settings;
      renderIdentity();
      renderPermissions();
      renderHeader();
      break;
    case "queue":
      state.queues.set(event.agentId, event.queue);
      if (event.agentId === state.currentId) renderQueue();
      break;
    case "message":
      upsertMessage(event.agentId, event.message);
      break;
    case "delta":
      applyDelta(event.agentId, event.messageId, event.delta);
      break;
    case "notice":
      if (!event.agentId || event.agentId !== state.currentId) showToast(event.message, event.level === "error" ? "error" : "info");
      break;
    default:
      break;
  }
}

// ---------- navegación ----------

function currentRouteId() {
  const match = location.hash.match(/^#\/a\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

async function navigate(agentId) {
  const target = agentId ? `#/a/${encodeURIComponent(agentId)}` : "#/";
  if (location.hash === target) return route();
  state.navigatedInApp = true;
  location.hash = target;
}

async function route() {
  const id = currentRouteId();
  const agent = id ? findAgent(id) : null;
  closeContextMenu();
  if (!agent) {
    if (state.currentId) {
      stopDictation({ cancel: true });
      stopSpeaking();
    }
    closeDialog($("#details-dialog"));
    state.currentId = null;
    elements.clear();
    document.body.classList.remove("show-chat");
    $("#conversation").hidden = true;
    $("#chat-empty").hidden = false;
    renderSidebar();
    return;
  }
  const changed = state.currentId !== agent.id;
  if (changed) {
    stopDictation({ cancel: true });
    stopSpeaking();
    closeDialog($("#details-dialog"));
    // Volver a entrar a una conversación marcada como no leída la marca como leída.
    state.keepUnread.delete(agent.id);
  }
  state.currentId = agent.id;
  document.body.classList.add("show-chat");
  $("#chat-empty").hidden = true;
  $("#conversation").hidden = false;
  renderSidebar();
  renderHeader();
  if (changed) {
    restoreDraft();
    renderAttachments();
    await loadConversation(agent.id);
    if (!coarsePointer) $("#composer-input").focus();
  }
  scheduleMarkRead(agent.id, 0);
}

function goBack() {
  if (state.navigatedInApp && history.length > 1) history.back();
  else location.replace("#/");
}

/** Avisa al servidor de que el usuario ya vio la conversación abierta. */
function scheduleMarkRead(agentId, delay = 700) {
  clearTimeout(readTimer);
  readTimer = setTimeout(() => {
    const agent = findAgent(agentId);
    if (!agent?.unread || agentId !== state.currentId || document.hidden || state.keepUnread.has(agentId)) return;
    api(`/api/agents/${encodeURIComponent(agentId)}/read`, { method: "POST" }).catch(() => undefined);
  }, delay);
}

// ---------- avatares ----------

const BLOB_COLORS = [
  "#8b5cf6",
  "#e5484d",
  "#4cbb73",
  "#ef9f3a",
  "#6f6f6f",
  "#3b82f6",
  "#e0609d",
  "#22b3a3",
  "#c9a227",
  "#a07cf0",
  "#38bdf8",
  "#84cc16",
];
/** Los avatares automáticos de antes solo usaban las 7 primeras figuras y los 10 primeros colores: así no cambian. */
const LEGACY_SHAPES = 7;
const LEGACY_COLORS = 10;

const TENT = "M15.6 11.4Q20 3.6 24.4 11.4L34 28.2Q38.2 35 30.6 35H9.4Q1.8 35 6 28.2Z";

/** Figuras con ojos al estilo de la app de referencia (viewBox 40×40). */
const BLOB_SHAPES = [
  {
    body: [["rect", { x: 3.5, y: 10.5, width: 33, height: 20, rx: 10, transform: "rotate(-12 20 20.5)" }]],
    eyes: [[22.6, 18.6], [28.2, 17.4]],
    eye: { rx: 1.25, ry: 2.5, rotate: -12 },
  },
  { body: [["circle", { cx: 20, cy: 20, r: 15.5 }]], eyes: [[15.8, 20.5], [23.4, 20.5]], eye: { rx: 1.9, ry: 3.1, rotate: 0 } },
  { body: [["path", { d: TENT }]], eyes: [[16.9, 25.5], [23.1, 25.5]], eye: { rx: 1.5, ry: 2.7, rotate: 0 } },
  {
    body: [["path", { d: "M16.2 12.6Q20 6.6 23.8 12.6L35.4 29Q38.9 34.4 32.4 34.4H7.6Q1.1 34.4 4.6 29Z" }]],
    eyes: [[17.3, 27.2], [22.7, 27.2]],
    eye: { rx: 1.35, ry: 1.35, rotate: 0 },
  },
  { body: [["path", { d: TENT, transform: "rotate(26 20 23)" }]], eyes: [[19.6, 19.8], [24.2, 22.2]], eye: { rx: 1.15, ry: 2.4, rotate: -64 } },
  {
    body: [
      ["circle", { cx: 14.5, cy: 15.5, r: 8.5 }],
      ["circle", { cx: 24.5, cy: 13.5, r: 8 }],
      ["circle", { cx: 30, cy: 23, r: 7.8 }],
      ["circle", { cx: 21, cy: 27.5, r: 9.2 }],
      ["circle", { cx: 10.5, cy: 25, r: 7.8 }],
    ],
    eyes: [[18.4, 23.8], [25.2, 21.6]],
    eye: { rx: 2.3, ry: 3.6, rotate: -38 },
  },
  {
    body: [["rect", { x: 7, y: 7.5, width: 26, height: 25, rx: 9, transform: "rotate(-16 20 20)" }]],
    eyes: [[17.2, 21.4], [22.4, 19.8]],
    eye: { rx: 1.1, ry: 2.2, rotate: -16 },
  },
  { body: [["rect", { x: 11, y: 3.5, width: 18, height: 33, rx: 9 }]], eyes: [[16.7, 14.5], [23.3, 14.5]], eye: { rx: 1.4, ry: 2.6, rotate: 0 } },
  { body: [["rect", { x: 5, y: 5, width: 30, height: 30, rx: 11 }]], eyes: [[15.6, 19], [24.4, 19]], eye: { rx: 1.7, ry: 3, rotate: 0 } },
  {
    body: [["rect", { x: 8.5, y: 8.5, width: 23, height: 23, rx: 6.5, transform: "rotate(45 20 20)" }]],
    eyes: [[16.9, 20.4], [23.1, 20.4]],
    eye: { rx: 1.3, ry: 2.4, rotate: 0 },
  },
  {
    body: [["path", { d: "M20 3.5C26.6 11.6 33 18.8 33 25.3A13 13 0 0 1 7 25.3C7 18.8 13.4 11.6 20 3.5Z" }]],
    eyes: [[16.2, 25.2], [23.8, 25.2]],
    eye: { rx: 1.5, ry: 2.7, rotate: 0 },
  },
  {
    body: [["path", { d: "M7 18.5a13 13 0 0 1 26 0V34.2l-4.33-2.7-4.34 2.7L20 31.5l-4.33 2.7-4.34-2.7L7 34.2Z" }]],
    eyes: [[15.8, 18.6], [24.2, 18.6]],
    eye: { rx: 1.7, ry: 3, rotate: 0 },
  },
  {
    body: [
      ["circle", { cx: 20, cy: 10.8, r: 8.2 }],
      ["circle", { cx: 29.2, cy: 20, r: 8.2 }],
      ["circle", { cx: 20, cy: 29.2, r: 8.2 }],
      ["circle", { cx: 10.8, cy: 20, r: 8.2 }],
      ["circle", { cx: 20, cy: 20, r: 9 }],
    ],
    eyes: [[16.9, 20], [23.1, 20]],
    eye: { rx: 1.4, ry: 2.6, rotate: 0 },
  },
  {
    body: [["path", { d: "M4.5 30.2a15.5 15.5 0 0 1 31 0q0 3.3-3.3 3.3H7.8q-3.3 0-3.3-3.3Z" }]],
    eyes: [[16, 25], [24, 25]],
    eye: { rx: 1.5, ry: 2.7, rotate: 0 },
  },
];

const MASCOT = { body: [["circle", { cx: 20, cy: 20, r: 17.5 }]], eyes: [[22.6, 13.8], [28.6, 12.9]], eye: { rx: 1.7, ry: 3, rotate: -22 } };

function svgElement(tag, attributes = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) if (value !== null && value !== undefined) node.setAttribute(key, String(value));
  return node;
}

function hashString(text) {
  let hash = 2166136261;
  for (const char of text) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function drawBlob(shape, color) {
  const svg = svgElement("svg", { viewBox: "0 0 40 40", class: "blob", "aria-hidden": "true", focusable: "false" });
  const body = svgElement("g", { class: "body", fill: color });
  for (const [tag, attributes] of shape.body) body.append(svgElement(tag, attributes));
  svg.append(body);
  for (const [cx, cy] of shape.eyes) {
    svg.append(
      svgElement("ellipse", {
        class: "eye",
        cx,
        cy,
        rx: shape.eye.rx,
        ry: shape.eye.ry,
        transform: shape.eye.rotate ? `rotate(${shape.eye.rotate} ${cx} ${cy})` : null,
      }),
    );
  }
  return svg;
}

/** Primeras combinaciones (figura, color): los primeros agentes salen todos distintos, como en la referencia. */
const AVATAR_SEQUENCE = [
  [0, "#8b5cf6"],
  [1, "#e5484d"],
  [2, "#4cbb73"],
  [3, "#ef9f3a"],
  [4, "#7a7a7a"],
  [5, "#e0609d"],
  [6, "#3b82f6"],
  [1, "#22b3a3"],
  [0, "#c9a227"],
  [2, "#a07cf0"],
  [5, "#ef9f3a"],
  [6, "#4cbb73"],
];

/** Figura y color de un agente: los que eligió el usuario o, si no, los automáticos (estables desde que se creó). */
function avatarParts(agent) {
  if (Number.isInteger(agent.avatar) && agent.avatar >= AVATAR_CUSTOM_BASE) {
    const rest = agent.avatar - AVATAR_CUSTOM_BASE;
    return [Math.floor(rest / 100) % BLOB_SHAPES.length, BLOB_COLORS[(rest % 100) % BLOB_COLORS.length]];
  }
  const index = Number.isInteger(agent.avatar) ? agent.avatar : hashString(agent.id ?? String(agent));
  return AVATAR_SEQUENCE[index] ?? [index % LEGACY_SHAPES, BLOB_COLORS[Math.floor(index / LEGACY_SHAPES) % LEGACY_COLORS]];
}

/** Número que guarda el servidor para una figura y un color elegidos a mano. */
function customAvatar(shape, color) {
  return AVATAR_CUSTOM_BASE + shape * 100 + color;
}

/** Avatar estable de un agente. Claude Bot usa la mascota. */
function blobAvatar(agent) {
  if (agent?.main) return drawBlob(MASCOT, "#f2f2f2");
  const [shape, color] = avatarParts(agent);
  return drawBlob(BLOB_SHAPES[shape], color);
}

function renderMascots() {
  $("#login-mascot").replaceChildren(drawBlob(MASCOT, "#f2f2f2"));
  $("#empty-mascot").replaceChildren(drawBlob(MASCOT, "#f2f2f2"));
  $("#intro-mascot").replaceChildren(drawBlob(MASCOT, "#f2f2f2"));
  $("#bot-avatar").prepend(drawBlob(MASCOT, "#f2f2f2"));
}

// ---------- iconos ----------

const ICONS = {
  clock: ["M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16", "M12 8v4.2l2.6 1.6"],
  terminal: ["M5 7l4.5 5L5 17", "M12 17h7"],
  file: ["M7.5 3.5h6.5l4.5 4.5v12.5h-11z", "M14 3.5V8h4.5"],
  search: ["M11 5a6 6 0 1 0 0 12a6 6 0 1 0 0-12", "M16 16l4 4"],
  spark: ["M12 4.5l1.7 5.8 5.8 1.7-5.8 1.7-1.7 5.8-1.7-5.8-5.8-1.7 5.8-1.7z"],
  clip: ["M8.5 12.5l6-6a3 3 0 0 1 4.2 4.2l-7.4 7.4a5 5 0 0 1-7-7L11 4.4"],
  close: ["M7 7l10 10M17 7L7 17"],
  team: ["M9.5 4.8a3.2 3.2 0 1 0 0 6.4a3.2 3.2 0 1 0 0-6.4", "M3.8 19c.6-3.2 3-5 5.7-5s5.1 1.8 5.7 5", "M18.5 8v6M15.5 11h6"],
  pencil: ["M5 19l1-4.2 9.6-9.6a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L9.2 18z", "M13.8 7l3.2 3.2"],
  pin: ["M9 4.5h6l-1 5 3 3H7l3-3z", "M12 12.5V20"],
  folder: ["M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"],
  move: ["M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z", "M9.5 13h6M13 10.5l2.5 2.5-2.5 2.5"],
  folderPlus: ["M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z", "M12 10.5v5M9.5 13h5"],
  unread: ["M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  allRead: ["M2.5 12.5l4 4 9-9", "M10.5 16.5l1 1 9-9"],
  eye: ["M2.5 12C3.5 10.5 7 6 12 6s8.5 4.5 9.5 6c-1 1.5-4.5 6-9.5 6s-8.5-4.5-9.5-6z", "M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6"],
  eyeOff: [
    "M3.5 3.5l17 17",
    "M10.6 6.1A9.4 9.4 0 0 1 12 6c5 0 8.5 4.5 9.5 6-.5.8-1.6 2.3-3.1 3.6",
    "M6.4 7.6C4.6 8.9 3.2 10.7 2.5 12c1 1.5 4.5 6 9.5 6 1.6 0 3-.4 4.3-1.1",
    "M9.9 9.9a3 3 0 0 0 4.2 4.2",
  ],
  trash: ["M4.5 7h15", "M9.5 7V4.8h5V7", "M6.5 7l1 12.5h9l1-12.5", "M10 11v5M14 11v5"],
  plus: ["M12 5v14M5 12h14"],
  section: ["M4 6.5h16M4 12h9M4 17.5h7", "M17.5 14.5v6M14.5 17.5h6"],
  chevron: ["M10 6l6 6-6 6"],
  speaker: ["M4.5 9.5h3l4-3.5v12l-4-3.5h-3z", "M15.5 9a4 4 0 0 1 0 6", "M18 6.5a7.5 7.5 0 0 1 0 11"],
  stop: ["M8 8h8v8H8z"],
  download: ["M12 4.5v10", "M7.5 10.5l4.5 4.5 4.5-4.5", "M5 19.5h14"],
  upload: ["M12 15V4.5", "M7.5 9L12 4.5 16.5 9", "M5 19.5h14"],
  external: ["M14 4.5h5.5V10", "M19.5 4.5L11 13", "M18 14v4.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1H10"],
  more: ["M6 12h.01M12 12h.01M18 12h.01"],
  details: ["M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16", "M12 11v5", "M12 8h.01"],
};

function icon(name, className = "") {
  const svg = svgElement("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false", class: className || null });
  for (const d of ICONS[name] ?? []) svg.append(svgElement("path", { d }));
  return svg;
}

// ---------- identidad y barra lateral ----------

function renderIdentity() {
  const name = state.settings.userName?.trim() || "Tú";
  $("#user-name").textContent = name;
  $("#user-avatar").textContent = name.charAt(0).toUpperCase();
  renderBotCard();
  updateTitle();
}

function findAgent(id) {
  return state.agents.find((agent) => agent.id === id) ?? null;
}

/** El bot principal (Claude Bot): arma los equipos y va fijo arriba de la lista. */
function mainAgent() {
  return state.agents.find((agent) => agent.main) ?? null;
}

function openMainAgent() {
  const main = mainAgent();
  if (main) void navigate(main.id);
}

/** Tarjeta de arriba de la barra lateral: abre la conversación con Claude Bot y muestra si trabaja o tiene novedades. */
function renderBotCard() {
  const main = mainAgent();
  const card = $("#bot-card");
  const name = main?.name ?? state.settings.botName ?? "ClosedBot";
  $("#bot-name").textContent = name;
  for (const node of document.querySelectorAll(".main-name")) node.textContent = name;
  card.disabled = !main;
  card.setAttribute("aria-current", String(Boolean(main) && main.id === state.currentId));
  card.title = main ? `Habla con ${name}: arma tus equipos de agentes` : name;
  const unread = Boolean(main) && isUnread(main);
  $("#bot-unread").hidden = !unread;
  const status = $("#bot-status");
  status.hidden = !main;
  if (!main) return;
  status.dataset.tone = "";
  if (main.state === "working") {
    status.textContent = "Trabajando…";
    status.dataset.tone = "working";
  } else if (hasPendingDecision(main.id) || main.preview?.startsWith("Pregunta:")) {
    status.textContent = "Te hizo una pregunta";
    status.dataset.tone = "question";
  } else if (main.state === "paused") {
    status.textContent = "Cola en pausa";
    status.dataset.tone = "paused";
  } else {
    status.textContent = "Arma tus equipos de agentes";
  }
}

function agentName(id) {
  return findAgent(id)?.name ?? "un agente eliminado";
}

/** El agente abierto en una ventana visible no cuenta como no leído, salvo que lo marcaras así a propósito. */
function isUnread(agent) {
  if (!agent.unread) return false;
  if (state.keepUnread.has(agent.id)) return true;
  return !(agent.id === state.currentId && !document.hidden);
}

function fold(text) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function loadCollapsed() {
  try {
    const parsed = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed() {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...state.collapsed]));
  } catch {
    // Sin almacenamiento local: se pliega solo mientras dure la sesión.
  }
}

/** Todas las secciones: primero las creadas a mano (en su orden) y después las que salen de los agentes. */
function allSections() {
  const seen = new Set();
  const result = [];
  const add = (name) => {
    const key = name.toLowerCase();
    if (!name || seen.has(key)) return;
    seen.add(key);
    result.push(name);
  };
  for (const name of state.sections) add(name);
  const derived = [...new Set(state.agents.filter((agent) => !agent.main && agent.project).map((agent) => agent.project))];
  derived.sort((a, b) => a.localeCompare(b, "es", { sensitivity: "base" }));
  for (const name of derived) add(name);
  return result;
}

function sectionKey(name) {
  return `s:${name.toLowerCase()}`;
}

function renderSidebar() {
  const container = $("#agent-groups");
  const scroll = container.scrollTop;
  container.replaceChildren();
  renderBotCard();
  // Claude Bot va en la tarjeta de arriba; la lista muestra los equipos.
  const team = state.agents.filter((agent) => !agent.main);
  const query = fold(state.search.trim());
  if (query) {
    // Buscando: todos los que coinciden, también los ocultos.
    const found = team.filter((agent) => fold(`${agent.name} ${agent.role} ${agent.project}`).includes(query));
    if (found.length) container.append(sidebarGroup({ title: "Resultados", agents: found }));
    else container.append(sidebarNote("Ningún agente coincide con la búsqueda."));
    updateTitle();
    return;
  }
  const shown = team.filter((agent) => !agent.hidden);
  const hidden = team.filter((agent) => agent.hidden);
  const pinned = shown.filter((agent) => agent.pinned);
  const rest = shown.filter((agent) => !agent.pinned);
  const explicit = new Set(state.sections.map((name) => name.toLowerCase()));
  const sections = allSections();
  if (pinned.length) container.append(sidebarGroup({ key: "\0pinned", title: "Fijados", agents: pinned }));
  for (const name of sections) {
    const lower = name.toLowerCase();
    const agents = rest.filter((agent) => agent.project.toLowerCase() === lower);
    // Una sección que sale solo de agentes fijados u ocultos no se repite vacía.
    if (!agents.length && !explicit.has(lower)) continue;
    const anyAgent = team.some((agent) => agent.project.toLowerCase() === lower);
    container.append(sidebarGroup({ key: sectionKey(name), title: name, agents, section: name, empty: anyAgent ? "" : "Sin agentes todavía" }));
  }
  const loose = rest.filter((agent) => !agent.project);
  if (loose.length) {
    const alone = !pinned.length && !container.childElementCount;
    container.append(sidebarGroup({ key: "\0none", title: alone ? "Tu equipo" : "Sin asignar", agents: loose }));
  }
  if (hidden.length) container.append(sidebarGroup({ key: "\0hidden", title: `Ocultos (${hidden.length})`, agents: hidden }));
  container.scrollTop = scroll;
  updateTitle();
}

function isCollapsed(key) {
  return key === "\0hidden" ? !state.showHidden : state.collapsed.has(key);
}

function toggleGroup(key) {
  if (key === "\0hidden") state.showHidden = !state.showHidden;
  else if (state.collapsed.has(key)) state.collapsed.delete(key);
  else state.collapsed.add(key);
  saveCollapsed();
  renderSidebar();
}

/** Un grupo de la barra lateral (Fijados, una sección, Sin asignar, Ocultos). Con `key` se puede plegar. */
function sidebarGroup({ key = null, title, agents, section = null, empty = "" }) {
  const group = document.createElement("section");
  group.className = "group";
  const heading = document.createElement("h2");
  heading.className = "group-title";
  const collapsed = key ? isCollapsed(key) : false;
  if (key) {
    const head = document.createElement("button");
    head.type = "button";
    head.className = "group-head";
    head.setAttribute("aria-expanded", String(!collapsed));
    if (section) head.dataset.section = section;
    const label = document.createElement("span");
    label.className = "group-label";
    label.textContent = title;
    head.append(label, icon("chevron", "group-chevron"));
    head.addEventListener("click", () => toggleGroup(key));
    heading.append(head);
  } else {
    heading.textContent = title;
  }
  group.append(heading);
  if (collapsed) return group;
  if (agents.length) {
    const list = document.createElement("ul");
    list.className = "agent-list";
    for (const agent of agents) list.append(agentRow(agent));
    group.append(list);
  } else if (empty) {
    group.append(sidebarNote(empty, "group-empty"));
  }
  return group;
}

function sidebarNote(text, className = "sidebar-note") {
  const note = document.createElement("p");
  note.className = className;
  note.textContent = text;
  return note;
}

function agentRow(agent) {
  const item = document.createElement("li");
  item.className = "agent-item";
  item.dataset.id = agent.id;
  if (agent.hidden) item.dataset.hidden = "true";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "agent-row";
  button.setAttribute("aria-current", String(agent.id === state.currentId));
  button.addEventListener("click", () => navigate(agent.id));

  const texts = document.createElement("span");
  texts.className = "texts";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = agent.name;
  const preview = document.createElement("span");
  preview.className = "preview";
  if (agent.state === "working") {
    preview.textContent = "Trabajando…";
    preview.dataset.tone = "working";
  } else if (agent.state === "paused") {
    preview.textContent = "Cola en pausa";
    preview.dataset.tone = "paused";
  } else {
    preview.textContent = agent.preview || agent.role || "Sin mensajes todavía";
  }
  texts.append(name, preview);

  const mark = document.createElement("span");
  mark.className = "mark";
  if (isUnread(agent)) {
    mark.dataset.kind = "unread";
    mark.title = "Mensajes nuevos";
    button.classList.add("unread");
  } else if (agent.state === "working") {
    mark.dataset.kind = "working";
    mark.title = "Trabajando";
  } else if (agent.queued > 0) {
    mark.dataset.kind = "queued";
    mark.title = `${agent.queued} en cola`;
  }
  button.append(blobAvatar(agent), texts, mark);
  button.title = [agent.name, agent.role].filter(Boolean).join(" · ");

  // «⋯»: el mismo menú del clic derecho (en el celular se abre manteniendo presionado).
  const more = document.createElement("button");
  more.type = "button";
  more.className = "row-more";
  more.title = "Más opciones";
  more.setAttribute("aria-label", `Opciones de ${agent.name}`);
  more.setAttribute("aria-haspopup", "menu");
  more.append(icon("more", "dots"));
  more.addEventListener("click", (event) => {
    event.stopPropagation();
    openContextMenu(agentMenuItems(agent.id), { anchor: more, source: more });
  });
  item.append(button, more);
  return item;
}

function updateTitle() {
  const count = state.agents.filter(isUnread).length;
  document.title = count ? `(${count}) ClosedBot` : "ClosedBot";
}

function stateLabel(agent) {
  return { working: "Trabajando", queued: "Con mensajes en cola", paused: "En pausa", idle: "Libre" }[agent.state] ?? "";
}

function providerLabel(provider) {
  return { claude: "Claude", codex: "Codex", grok: "Grok", gemini: "Gemini", demo: "Demo" }[provider] ?? provider;
}

function toggleSearch(force) {
  const box = $("#search-box");
  const open = force ?? box.hidden;
  box.hidden = !open;
  $("#search-toggle").setAttribute("aria-expanded", String(open));
  if (open) {
    $("#search-input").focus();
  } else {
    state.search = "";
    $("#search-input").value = "";
    renderSidebar();
  }
}

// ---------- conversación ----------

function renderHeader() {
  const agent = findAgent(state.currentId);
  if (!agent) return;
  const avatar = $("#chat-avatar");
  const avatarKey = `${agent.id}:${agent.avatar}`;
  if (avatar.dataset.key !== avatarKey) {
    avatar.replaceChildren(blobAvatar(agent));
    avatar.dataset.key = avatarKey;
  }
  $("#chat-name").textContent = agent.name;
  const label =
    agent.state === "working" ? "trabajando…" : agent.state === "paused" ? "en pausa" : agent.queued > 0 ? `${agent.queued} en cola` : "";
  const stateNode = $("#chat-state");
  stateNode.textContent = label;
  stateNode.hidden = !label;
  $("#details-button").title = `Ficha de ${agent.name}: rutinas, voz, archivos y carpeta`;
  updatePlaceholder();
}

function hasPendingDecision(agentId) {
  return (state.messages.get(agentId) ?? []).some((message) => message.role === "decision" && !Number.isInteger(message.payload?.answer));
}

function updatePlaceholder() {
  const agent = findAgent(state.currentId);
  if (!agent) return;
  $("#composer-input").placeholder = hasPendingDecision(agent.id)
    ? "Escribe tu respuesta o habla de otra cosa"
    : agent.main
      ? "Cuéntale qué necesitas…"
      : `Escribe a ${agent.name}…`;
}

/** Ideas para empezar a hablar con Claude Bot: llenan el cuadro de texto para que las ajustes antes de enviar. */
const MAIN_IDEAS = [
  "Arma un equipo para crear un videojuego de plataformas para PC",
  "Quiero un equipo que investigue un tema y me entregue un informe cada lunes",
  "Necesito agentes que mantengan y mejoren mi página web",
];

/** Pantalla de inicio de Claude Bot: se ve mientras su conversación está vacía. */
function renderMainIntro() {
  const agent = findAgent(state.currentId);
  const intro = $("#main-intro");
  const show = Boolean(agent?.main) && !(state.messages.get(agent.id) ?? []).length && !state.hasMore.get(agent.id);
  intro.hidden = !show;
  if (!show) return;
  $("#intro-title").textContent = `Hola, soy ${agent.name}`;
  const ideas = $("#intro-ideas");
  if (ideas.childElementCount) return;
  for (const idea of MAIN_IDEAS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "idea";
    button.textContent = idea;
    button.addEventListener("click", () => {
      const input = $("#composer-input");
      input.value = idea;
      autosize(input);
      saveDraft();
      updateActionButton();
      input.focus();
      input.setSelectionRange(idea.length, idea.length);
    });
    ideas.append(button);
  }
}

async function loadConversation(agentId, { keepScroll = false } = {}) {
  try {
    const [messages, queue] = await Promise.all([
      api(`/api/agents/${encodeURIComponent(agentId)}/messages?limit=100`),
      api(`/api/agents/${encodeURIComponent(agentId)}/queue`),
    ]);
    if (state.currentId !== agentId) return;
    const scroller = $("#messages");
    const atBottom = isNearBottom(scroller);
    state.messages.set(agentId, messages.messages);
    state.hasMore.set(agentId, messages.hasMore);
    state.queues.set(agentId, queue.queue);
    renderAllMessages();
    renderQueue();
    updatePlaceholder();
    if (!keepScroll || atBottom) scrollToBottom(true);
  } catch (error) {
    if (error.status !== 401) showToast(error.message, "error");
  }
}

async function loadOlder() {
  const agentId = state.currentId;
  const list = state.messages.get(agentId) ?? [];
  const oldest = list.find((message) => typeof message.seq === "number");
  if (!oldest) return;
  const button = $("#load-more");
  button.disabled = true;
  try {
    const data = await api(`/api/agents/${encodeURIComponent(agentId)}/messages?limit=100&before=${oldest.seq}`);
    if (state.currentId !== agentId) return;
    const scroller = $("#messages");
    const previousHeight = scroller.scrollHeight;
    const known = new Set(list.map((message) => message.id));
    state.messages.set(agentId, [...data.messages.filter((message) => !known.has(message.id)), ...list]);
    state.hasMore.set(agentId, data.hasMore);
    renderAllMessages();
    scroller.scrollTop = scroller.scrollHeight - previousHeight;
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

function renderAllMessages() {
  const container = $("#message-list");
  container.replaceChildren();
  elements.clear();
  dirty.clear();
  for (const message of state.messages.get(state.currentId) ?? []) {
    const node = buildMessage(message);
    elements.set(message.id, node);
    container.append(node);
  }
  $("#load-more").hidden = !state.hasMore.get(state.currentId);
  renderMainIntro();
  updateWorkingIndicator();
}

function upsertMessage(agentId, message) {
  const list = state.messages.get(agentId);
  let finished = false;
  if (list) {
    const index = list.findIndex((item) => item.id === message.id);
    const before = index >= 0 ? list[index].status : null;
    if (index >= 0) list[index] = { ...list[index], ...message };
    else list.push(message);
    finished = message.role === "assistant" && message.status === "completed" && before !== "completed";
  }
  if (agentId !== state.currentId || !list) return;
  if (finished) maybeAutoRead(agentId, list.find((item) => item.id === message.id) ?? message);
  const scroller = $("#messages");
  const atBottom = isNearBottom(scroller);
  const existing = elements.get(message.id);
  const merged = list.find((item) => item.id === message.id);
  const node = buildMessage(merged);
  if (existing) existing.replaceWith(node);
  else $("#message-list").append(node);
  elements.set(message.id, node);
  if (!$("#main-intro").hidden) renderMainIntro();
  updateWorkingIndicator();
  if (message.role === "decision") {
    updatePlaceholder();
    renderBotCard();
  }
  if (atBottom || (!existing && message.role === "user")) scrollToBottom();
}

function refreshMessage(agentId, messageId) {
  if (agentId !== state.currentId) return;
  const message = (state.messages.get(agentId) ?? []).find((item) => item.id === messageId);
  const existing = elements.get(messageId);
  if (!message || !existing) return;
  const node = buildMessage(message);
  existing.replaceWith(node);
  elements.set(messageId, node);
}

function applyDelta(agentId, messageId, delta) {
  const list = state.messages.get(agentId);
  const message = list?.find((item) => item.id === messageId);
  if (!message) return;
  message.text += delta;
  if (agentId !== state.currentId) return;
  dirty.add(messageId);
  if (!renderScheduled) {
    renderScheduled = true;
    requestAnimationFrame(flushDirty);
  }
}

function flushDirty() {
  renderScheduled = false;
  const scroller = $("#messages");
  const atBottom = isNearBottom(scroller);
  const list = state.messages.get(state.currentId) ?? [];
  for (const id of dirty) {
    const message = list.find((item) => item.id === id);
    const existing = elements.get(id);
    if (!message || !existing) continue;
    const node = buildMessage(message);
    existing.replaceWith(node);
    elements.set(id, node);
  }
  dirty.clear();
  updateWorkingIndicator();
  if (atBottom) scrollToBottom();
}

function buildMessage(message) {
  if (message.role === "decision") return buildDecision(message);
  const node = document.createElement("div");
  node.dataset.id = message.id;
  node.dataset.status = message.status;
  const time = formatTime(message.createdAt);
  node.title = time;

  if (message.role === "activity") {
    node.className = "msg msg-activity";
    const kind = message.payload?.kind;
    // El pedido del saludo inicial no se muestra: solo se ve la respuesta del agente.
    if (kind === "greeting") {
      node.hidden = true;
      return node;
    }
    if (kind === "agent-created" || kind === "agent-updated") {
      const target = findAgent(message.payload.agentId);
      const created = kind === "agent-created";
      const name = target?.name ?? message.text.match(/«(.+?)»/)?.[1] ?? "un agente";
      const link = document.createElement(target ? "button" : "span");
      link.className = "what";
      link.textContent = name;
      if (target) {
        link.type = "button";
        link.title = `Abrir la conversación con ${name}`;
        link.addEventListener("click", () => navigate(target.id));
      }
      const detail = created ? message.payload.project : (message.payload.changes ?? []).join(", ");
      node.append(icon(created ? "team" : "pencil"), created ? "Creó a" : "Ajustó a", link);
      if (detail) node.append(`· ${detail}`);
      return node;
    }
    const created = message.text.match(/^(Creó|Creaste) la rutina «(.+)» · (.+)$/s);
    if (created) {
      const what = document.createElement("span");
      what.className = "what";
      what.textContent = created[2];
      node.append(`${created[1]} la rutina`, icon("clock"), what, `· ${created[3]}`);
    } else {
      const kind = /^Ejecutó/.test(message.text) ? "terminal" : /^Modificó/.test(message.text) ? "file" : /^Buscó/.test(message.text) ? "search" : "spark";
      const text = document.createElement("span");
      text.textContent = message.text;
      node.append(icon(kind), text);
    }
    return node;
  }

  if (message.role === "routine") {
    node.className = "msg msg-routine";
    const what = document.createElement("span");
    what.className = "what";
    what.textContent = message.text;
    node.append(message.payload?.manual ? "Rutina (a mano)" : "Rutina", icon("clock"), what);
    const status = routineStatus(message.status);
    if (status) {
      const statusNode = document.createElement("span");
      statusNode.className = "status";
      statusNode.textContent = `· ${status}`;
      node.append(statusNode);
    }
    node.title = [message.payload?.schedule, time].filter(Boolean).join(" · ");
    return node;
  }

  if (message.role === "notice" && !(message.toAgentIds ?? []).length) {
    node.className = "msg msg-notice";
    node.textContent = message.text;
    return node;
  }

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  const meta = document.createElement("div");
  meta.className = "meta";
  let label = null;

  switch (message.role) {
    case "user":
      node.className = "msg msg-user";
      bubble.textContent = message.text;
      meta.textContent = userStatus(message.status);
      break;
    case "assistant":
      node.className = "msg msg-assistant";
      if (!message.text && message.status === "streaming") bubble.append(thinkingDots());
      else renderMarkdown(message.text, bubble);
      if (message.status === "streaming" && message.text) bubble.classList.add("typing");
      meta.textContent = assistantStatus(message.status);
      break;
    case "teammate":
      node.className = "msg msg-teammate";
      label = `${message.replyTo ? "Respuesta de" : "Mensaje de"} ${agentName(message.fromAgentId)}`;
      renderMarkdown(message.text, bubble);
      meta.textContent = teammateStatus(message.status);
      break;
    case "notice":
      node.className = "msg msg-outgoing";
      label = `${message.replyTo ? "Respuesta para" : "Enviado a"} ${message.toAgentIds.map(agentName).join(", ")}`;
      renderMarkdown(message.text, bubble);
      break;
    default:
      node.className = "msg msg-notice";
      node.textContent = message.text;
      return node;
  }

  if (label) {
    const labelNode = document.createElement("div");
    labelNode.className = "msg-label";
    labelNode.textContent = label;
    bubble.prepend(labelNode);
  }
  if (message.role !== "user") bubble.classList.add("md");
  node.append(bubble, meta);
  if (message.role === "assistant" && message.status === "completed" && Synth && message.text.trim()) node.append(messageTools(message));
  return node;
}

/** Botones bajo una respuesta terminada: por ahora, leerla en voz alta. */
function messageTools(message) {
  const tools = document.createElement("div");
  tools.className = "msg-tools";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "speak-button";
  button.dataset.id = message.id;
  setSpeakButton(button, speech.current?.messageId === message.id);
  button.addEventListener("click", () => toggleSpeakMessage(message.agentId, message.id));
  tools.append(button);
  return tools;
}

function setSpeakButton(button, active) {
  button.setAttribute("aria-pressed", String(active));
  const label = active ? "Dejar de leer" : "Leer en voz alta";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.replaceChildren(icon(active ? "stop" : "speaker"));
}

function buildDecision(message) {
  const node = document.createElement("div");
  node.className = "msg msg-decision";
  node.dataset.id = message.id;
  const payload = message.payload ?? {};
  const options = Array.isArray(payload.options) ? payload.options : [];
  const answered = Number.isInteger(payload.answer);
  const card = document.createElement("div");
  card.className = "decision";
  card.dataset.answered = String(answered);
  const question = document.createElement("p");
  question.className = "decision-question";
  question.textContent = message.text;
  const list = document.createElement("ul");
  list.className = "decision-options";
  options.forEach((option, index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "decision-option";
    button.disabled = answered || answering.has(message.id);
    if (answered) button.dataset.chosen = String(payload.answer === index);
    const letter = document.createElement("span");
    letter.className = "decision-letter";
    letter.textContent = LETTERS[index] ?? String(index + 1);
    const text = document.createElement("span");
    const labelNode = document.createElement("span");
    labelNode.className = "decision-label";
    labelNode.textContent = option.label ?? "";
    text.append(labelNode);
    if (!answered && payload.recommended === index) {
      const tag = document.createElement("span");
      tag.className = "decision-tag";
      tag.textContent = "Recomendada";
      text.append(tag);
    }
    if (option.detail) {
      const detail = document.createElement("span");
      detail.className = "decision-detail";
      detail.textContent = option.detail;
      text.append(detail);
    }
    button.append(letter, text);
    button.addEventListener("click", () => void answerDecision(message, index));
    item.append(button);
    list.append(item);
  });
  card.append(question, list);
  if (answered && payload.answeredAt) {
    const note = document.createElement("p");
    note.className = "decision-note";
    note.textContent = `Respondiste ${formatTime(payload.answeredAt)}`;
    card.append(note);
  }
  node.append(card);
  return node;
}

async function answerDecision(message, index) {
  if (answering.has(message.id)) return;
  answering.add(message.id);
  refreshMessage(message.agentId, message.id);
  try {
    const result = await api(`/api/agents/${encodeURIComponent(message.agentId)}/decisions/${encodeURIComponent(message.id)}`, {
      method: "POST",
      body: { choice: index },
    });
    upsertMessage(message.agentId, result.decision);
    upsertMessage(message.agentId, result.message);
    scrollToBottom();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    answering.delete(message.id);
    refreshMessage(message.agentId, message.id);
    updatePlaceholder();
  }
}

function thinkingDots() {
  const dots = document.createElement("span");
  dots.className = "thinking";
  dots.setAttribute("aria-label", "Pensando");
  dots.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));
  return dots;
}

/** Muestra «pensando…» mientras el agente trabaja y aún no ha escrito nada en este turno. */
function updateWorkingIndicator() {
  const container = $("#message-list");
  let indicator = $("#working-indicator");
  const agent = findAgent(state.currentId);
  const list = state.messages.get(state.currentId) ?? [];
  const streaming = list.some((message) => message.role === "assistant" && message.status === "streaming");
  const show = agent?.state === "working" && !streaming;
  if (!show) {
    indicator?.remove();
    return;
  }
  if (!indicator) {
    indicator = document.createElement("div");
    indicator.id = "working-indicator";
    indicator.className = "msg msg-assistant";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.append(thinkingDots());
    indicator.append(bubble);
  }
  container.append(indicator);
}

function userStatus(status) {
  return { queued: "en cola", running: "procesando…", failed: "no se pudo entregar", cancelled: "cancelado", interrupted: "detenido" }[status] ?? "";
}

function assistantStatus(status) {
  return { failed: "falló", interrupted: "detenido" }[status] ?? "";
}

function teammateStatus(status) {
  return { queued: "en cola", running: "atendiendo…", failed: "falló", cancelled: "cancelado", interrupted: "detenido" }[status] ?? "";
}

function routineStatus(status) {
  return { queued: "en cola", running: "en curso…", failed: "falló", cancelled: "cancelada", interrupted: "detenida" }[status] ?? "";
}

function formatTime(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? date.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString("es", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function formatWhen(timestamp) {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleString("es", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function isNearBottom(scroller) {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
}

function scrollToBottom(instant = false) {
  const scroller = $("#messages");
  requestAnimationFrame(() => {
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: instant ? "instant" : "smooth" });
  });
}

// ---------- Markdown sencillo y seguro (solo nodos de texto, sin innerHTML) ----------

const INLINE = /`([^`\n]+)`|\*\*([^*\n]+)\*\*|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>"')\]]*[^\s<>"')\].,;:!?])/g;

function renderMarkdown(text, target) {
  target.replaceChildren();
  const segments = text.split("```");
  segments.forEach((segment, index) => {
    if (index % 2 === 1) {
      const newline = segment.indexOf("\n");
      const first = newline >= 0 ? segment.slice(0, newline).trim() : "";
      const body = newline >= 0 && /^[\w#+.-]*$/.test(first) ? segment.slice(newline + 1) : segment;
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = body.replace(/\n$/, "");
      pre.append(code);
      target.append(pre);
    } else {
      renderBlocks(segment, target);
    }
  });
}

function renderBlocks(text, target) {
  let paragraph = null;
  let list = null;
  let quote = null;
  const reset = () => {
    paragraph = null;
    list = null;
    quote = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      reset();
      continue;
    }
    let match = line.match(/^#{1,6}\s+(.*)$/);
    if (match) {
      reset();
      const heading = document.createElement("p");
      heading.className = "heading";
      renderInline(match[1], heading);
      target.append(heading);
      continue;
    }
    match = line.match(/^\s*[-*•]\s+(.*)$/) ?? line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (match) {
      const ordered = match.length === 3;
      const tag = ordered ? "OL" : "UL";
      if (!list || list.tagName !== tag) {
        reset();
        list = document.createElement(tag.toLowerCase());
        if (ordered && Number(match[1]) > 1) list.start = Number(match[1]);
        target.append(list);
      }
      const item = document.createElement("li");
      renderInline(ordered ? match[2] : match[1], item);
      list.append(item);
      continue;
    }
    match = line.match(/^>\s?(.*)$/);
    if (match) {
      if (!quote) {
        reset();
        quote = document.createElement("blockquote");
        target.append(quote);
      } else {
        quote.append(document.createElement("br"));
      }
      renderInline(match[1], quote);
      continue;
    }
    if (list && /^\s{2,}/.test(raw) && list.lastElementChild) {
      list.lastElementChild.append(" ");
      renderInline(line.trim(), list.lastElementChild);
      continue;
    }
    if (!paragraph) {
      reset();
      paragraph = document.createElement("p");
      target.append(paragraph);
    } else {
      paragraph.append(document.createElement("br"));
    }
    renderInline(line, paragraph);
  }
}

function renderInline(text, parent) {
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) parent.append(text.slice(last, match.index));
    if (match[1] !== undefined) {
      const code = document.createElement("code");
      code.textContent = match[1];
      parent.append(code);
    } else if (match[2] !== undefined) {
      const strong = document.createElement("strong");
      strong.textContent = match[2];
      parent.append(strong);
    } else if (match[3] !== undefined) {
      parent.append(link(match[4], match[3]));
    } else {
      parent.append(link(match[5], match[5]));
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

function link(href, label) {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.textContent = label;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  return anchor;
}

// ---------- cola ----------

function renderQueue() {
  const queue = state.queues.get(state.currentId) ?? [];
  const waiting = queue.filter((delivery) => delivery.status === "queued");
  const bar = $("#queue-bar");
  bar.hidden = waiting.length === 0;
  $("#queue-summary").textContent = waiting.length === 1 ? "1 mensaje esperando turno" : `${waiting.length} mensajes esperando turno`;
  const toggle = $("#queue-toggle");
  toggle.setAttribute("aria-expanded", String(state.queueOpen));
  const list = $("#queue-list");
  list.hidden = !state.queueOpen;
  list.replaceChildren();
  for (const delivery of queue) {
    const item = document.createElement("li");
    item.className = "queue-item";
    const body = document.createElement("div");
    const from = document.createElement("div");
    from.className = "from";
    from.textContent = delivery.senderKind === "user" ? "Tú" : `De ${agentName(delivery.senderAgentId)}`;
    const text = document.createElement("div");
    text.className = "text";
    text.textContent = delivery.text;
    body.append(from, text);
    item.append(body);
    if (delivery.status === "queued") {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "button ghost";
      cancel.textContent = "Quitar";
      cancel.addEventListener("click", () => cancelDelivery(delivery.id));
      item.append(cancel);
    } else {
      const running = document.createElement("span");
      running.className = "running";
      running.textContent = "En curso";
      item.append(running);
    }
    list.append(item);
  }
}

async function cancelDelivery(deliveryId) {
  try {
    await api(`/api/agents/${encodeURIComponent(state.currentId)}/queue/${encodeURIComponent(deliveryId)}`, { method: "DELETE" });
  } catch (error) {
    showToast(error.message, "error");
  }
}

// ---------- redactar ----------

function draftKey(agentId) {
  return `cuadrilla:borrador:${agentId}`;
}

function saveDraft() {
  if (!state.currentId) return;
  try {
    const value = $("#composer-input").value;
    if (value) localStorage.setItem(draftKey(state.currentId), value);
    else localStorage.removeItem(draftKey(state.currentId));
  } catch {
    // Sin almacenamiento local: no pasa nada.
  }
}

function restoreDraft() {
  let value = "";
  try {
    value = localStorage.getItem(draftKey(state.currentId)) ?? "";
  } catch {
    value = "";
  }
  const input = $("#composer-input");
  input.value = value;
  autosize(input);
  updateActionButton();
}

function autosize(textarea) {
  if (!textarea.value) {
    // Vacío: una sola línea aunque el texto de ayuda sea largo.
    textarea.style.height = "";
    return;
  }
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight + 2, window.innerHeight * 0.4)}px`;
}

function currentAttachments() {
  return state.attachments.get(state.currentId) ?? [];
}

/** Modo del botón morado: enviar, hablar (dictado que se envía solo) o detener al agente. */
function updateActionButton() {
  const button = $("#send");
  const agent = findAgent(state.currentId);
  const text = $("#composer-input").value.trim();
  const files = currentAttachments();
  const ready = files.some((file) => file.status === "ready");
  const uploading = files.some((file) => file.status === "uploading");
  const voiceActive = dictation?.mode === "voice";
  let mode = "send";
  if (voiceActive) mode = "voice";
  else if (text || ready || uploading) mode = "send";
  else if (agent?.state === "working") mode = "stop";
  else if (dictationAvailable()) mode = "voice";
  button.dataset.mode = mode;
  const label = {
    send: "Enviar",
    voice: voiceActive ? "Terminar y enviar" : "Hablar y enviar al terminar",
    stop: `Detener a ${agent?.name ?? "el agente"}`,
  }[mode];
  button.setAttribute("aria-label", label);
  button.title = label;
  button.setAttribute("aria-pressed", String(voiceActive));
  button.disabled = !agent || (mode === "send" && (uploading || (!text && !ready))) || (voiceActive && dictation.finishing);
}

function onComposerSubmit(event) {
  event.preventDefault();
  const mode = $("#send").dataset.mode;
  if (mode === "stop") void stopAgent();
  else if (mode === "voice") toggleDictation("voice");
  else void sendMessage();
}

async function sendMessage() {
  // Enviar mientras dictas con este PC: primero se escribe lo último que dijiste.
  const pendingDictation = dictation?.engine === "local" && !dictation.cancelled ? dictation : null;
  if (pendingDictation) {
    await finishLocalDictation(pendingDictation, { send: false });
    if (pendingDictation.mode === "voice") {
      voiceReply = { agentId: pendingDictation.agentId, startedAt: Date.now(), sawWorking: false, until: null };
    }
  }
  const input = $("#composer-input");
  const agentId = state.currentId;
  if (!agentId) return;
  const files = currentAttachments();
  if (files.some((file) => file.status === "uploading")) {
    showToast("Espera a que terminen de subir los archivos.");
    return;
  }
  const ready = files.filter((file) => file.status === "ready");
  const original = input.value;
  let text = original.trim();
  if (ready.length) {
    const list = ready.map((file) => `- ${file.relativePath}`).join("\n");
    const intro = ready.length === 1 ? "Adjunté este archivo en tu carpeta:" : "Adjunté estos archivos en tu carpeta:";
    text = `${text ? `${text}\n\n` : ""}${intro}\n${list}`;
  }
  if (!text) return;
  stopDictation({ cancel: true });
  stopSpeaking();
  state.keepUnread.delete(agentId);
  const button = $("#send");
  button.disabled = true;
  try {
    const result = await api(`/api/agents/${encodeURIComponent(agentId)}/messages`, { method: "POST", body: { text } });
    // Solo se vacía si no escribiste otra cosa mientras se enviaba.
    if (state.currentId === agentId && input.value === original) {
      input.value = "";
      autosize(input);
      saveDraft();
    }
    state.attachments.set(
      agentId,
      (state.attachments.get(agentId) ?? []).filter((file) => !ready.includes(file)),
    );
    if (state.currentId === agentId) renderAttachments();
    upsertMessage(agentId, result.message);
    scrollToBottom();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    updateActionButton();
    if (!coarsePointer) input.focus();
  }
}

// ---------- archivos adjuntos ----------

function renderAttachments() {
  const box = $("#attachments");
  box.replaceChildren();
  const files = currentAttachments();
  box.hidden = files.length === 0;
  for (const file of files) {
    const chip = document.createElement("span");
    chip.className = "attachment";
    chip.dataset.state = file.status;
    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = file.status === "uploading" ? `${file.name} · subiendo…` : file.name;
    name.title = file.relativePath ?? file.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", `Quitar ${file.name}`);
    remove.title = "Quitar";
    remove.append(icon("close"));
    remove.addEventListener("click", () => {
      state.attachments.set(
        file.agentId,
        (state.attachments.get(file.agentId) ?? []).filter((item) => item !== file),
      );
      renderAttachments();
    });
    chip.append(icon("clip"), name, remove);
    box.append(chip);
  }
  updateActionButton();
}

async function addFiles(fileList) {
  const agentId = state.currentId;
  if (!agentId) return;
  for (const file of [...fileList]) {
    if (file.size > MAX_UPLOAD_BYTES) {
      showToast(`«${file.name}» supera los 25 MB.`, "error");
      continue;
    }
    if (file.size === 0) {
      showToast(`«${file.name}» está vacío.`, "error");
      continue;
    }
    const entry = { agentId, name: file.name, status: "uploading", relativePath: null };
    state.attachments.set(agentId, [...(state.attachments.get(agentId) ?? []), entry]);
    if (state.currentId === agentId) renderAttachments();
    try {
      const saved = await uploadFile(agentId, file);
      entry.status = "ready";
      entry.name = saved.name;
      entry.relativePath = saved.relativePath;
    } catch (error) {
      state.attachments.set(
        agentId,
        (state.attachments.get(agentId) ?? []).filter((item) => item !== entry),
      );
      if (error.status !== 401) showToast(`No se pudo subir «${file.name}»: ${error.message}`, "error");
    }
    if (state.currentId === agentId) renderAttachments();
  }
}

// ---------- dictado por voz ----------

function speechLanguage() {
  const language = navigator.language || "es-ES";
  return language.toLowerCase().startsWith("es") ? language : "es-ES";
}

/** Idioma del dictado: el elegido en el chat de voz del agente o, en automático, el español del navegador. */
function dictationLanguage() {
  const lang = findAgent(state.currentId)?.voice?.lang;
  return lang && lang !== "auto" ? lang : speechLanguage();
}

function toggleDictation(mode) {
  if (dictation) {
    // Mientras termina de transcribir lo último, un segundo toque no hace nada.
    if (!dictation.finishing) stopDictation();
    return;
  }
  void startDictation(mode);
}

/** mode «dictate» escribe en el cuadro; «voice» además envía el mensaje al terminar de hablar. */
async function startDictation(mode) {
  if (!state.currentId) return;
  if (useLocalDictation()) await startLocalDictation(mode);
  else if (Recognition) startBrowserDictation(mode);
}

// ---------- dictado: motor elegido ----------

function dictationChoice() {
  try {
    const value = localStorage.getItem(DICTATION_KEY);
    return value === "local" || value === "navegador" ? value : "auto";
  } catch {
    return "auto";
  }
}

function rememberDictation(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // Sin almacenamiento local: vale solo hasta recargar.
  }
}

function browserDictationFailed() {
  try {
    return localStorage.getItem(BROWSER_FAILED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Edge de escritorio, como la ventana de ClosedBot: su servicio de voz en línea suele fallar con «network». */
function isDesktopEdge() {
  return /\bEdg\//.test(navigator.userAgent) && !coarsePointer;
}

/** El reconocimiento en este PC: hace falta grabar audio (contexto seguro) y que el servidor lo ofrezca. */
function localDictationPossible() {
  return CanRecord && Boolean(state.speech);
}

function useLocalDictation() {
  if (!localDictationPossible()) return false;
  if (!Recognition) return true;
  const choice = dictationChoice();
  if (choice !== "auto") return choice === "local";
  return isDesktopEdge() || state.speech.state === "ready" || browserDictationFailed();
}

function dictationAvailable() {
  return Boolean(Recognition) || localDictationPossible();
}

function updateDictateButton() {
  $("#dictate").hidden = !dictationAvailable();
  updateActionButton();
}

// ---------- dictado del navegador ----------

function startBrowserDictation(mode) {
  // Si el agente está leyendo en voz alta, se calla: el micrófono no debe escucharlo.
  stopSpeaking();
  primeSpeech();
  const input = $("#composer-input");
  const rec = new Recognition();
  rec.lang = dictationLanguage();
  rec.interimResults = true;
  rec.continuous = mode === "dictate";
  rec.maxAlternatives = 1;
  const base = input.value && !/\s$/.test(input.value) ? `${input.value} ` : input.value;
  const session = { engine: "browser", mode, base, final: "", agentId: state.currentId, cancelled: false, failed: false };
  rec.onresult = (event) => {
    if (dictation !== session) return;
    let interim = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (result.isFinal) session.final += result[0].transcript;
      else interim += result[0].transcript;
    }
    if (state.currentId !== session.agentId) return;
    input.value = session.base + session.final + interim;
    autosize(input);
    updateActionButton();
  };
  rec.onerror = (event) => {
    if (event.error === "no-speech" || event.error === "aborted") return;
    // El servicio de voz del navegador no funciona aquí: se pasa al reconocimiento de este PC.
    if (["network", "service-not-allowed", "language-not-supported"].includes(event.error) && localDictationPossible()) {
      session.failed = true;
      rememberDictation(BROWSER_FAILED_KEY, "1");
      return;
    }
    const messages = {
      "not-allowed": "Permite el uso del micrófono para dictar.",
      "service-not-allowed": "El navegador no permite el dictado aquí.",
      "audio-capture": "No se encontró un micrófono.",
      network: "El dictado del navegador necesita su servicio de voz en internet y no respondió.",
      "language-not-supported": "El dictado no está disponible en ese idioma en este navegador.",
    };
    showToast(messages[event.error] ?? `El dictado falló (${event.error}).`, "error");
  };
  rec.onend = () => {
    if (dictation !== session) return;
    dictation = null;
    recognition = null;
    updateDictationUi();
    saveDraft();
    if (session.failed && !session.cancelled && state.currentId === session.agentId) {
      showToast("El dictado del navegador no funciona aquí: uso el de este PC.");
      void startLocalDictation(session.mode);
      return;
    }
    if (session.mode === "voice" && !session.cancelled && state.currentId === session.agentId && input.value.trim()) {
      // Le hablaste: la respuesta se lee en voz alta aunque «Leer sus respuestas» esté apagado.
      voiceReply = { agentId: session.agentId, startedAt: Date.now(), sawWorking: false, until: null };
      void sendMessage();
    }
  };
  try {
    rec.start();
  } catch (error) {
    showToast(`No se pudo iniciar el dictado: ${error.message}`, "error");
    return;
  }
  dictation = session;
  recognition = rec;
  updateDictationUi();
}

// ---------- dictado en este PC ----------

/**
 * Graba el micrófono, corta el audio en las pausas y manda cada trozo al servidor, que lo reconoce
 * en este mismo equipo. El texto se va agregando al cuadro en orden.
 */
async function startLocalDictation(mode) {
  if (!state.speech || !state.currentId || dictation) return;
  if (state.speech.state !== "ready") {
    await ensureLocalModel();
    return;
  }
  stopSpeaking();
  primeSpeech();
  const session = {
    engine: "local",
    mode,
    agentId: state.currentId,
    cancelled: false,
    opening: true,
    finishing: false,
    sendAfter: false,
    done: null,
    stream: null,
    context: null,
    source: null,
    node: null,
    sink: null,
    rate: 16_000,
    elapsed: 0,
    floor: null,
    calibration: [],
    preroll: [],
    prerollSamples: 0,
    segment: null,
    heard: false,
    quiet: 0,
    level: 0,
    pending: 0,
    chain: Promise.resolve(),
    errorShown: false,
  };
  dictation = session;
  updateDictationUi();
  // Mientras se abre el micrófono, el servidor carga el modelo: el primer trozo no espera.
  void api("/api/speech/prepare", { method: "POST" }).catch(() => undefined);
  try {
    await openMicrophone(session);
  } catch (error) {
    releaseMicrophone(session);
    if (dictation === session) {
      dictation = null;
      updateDictationUi();
    }
    if (!session.cancelled) showToast(microphoneError(error), "error");
    return;
  }
  session.opening = false;
  if (dictation !== session || session.cancelled) {
    releaseMicrophone(session);
    return;
  }
  updateDictationUi();
}

async function openMicrophone(session) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  session.stream = stream;
  if (session.cancelled) return;
  // A 16 kHz, la frecuencia del modelo; si el navegador no deja, a la suya (el servidor la convierte).
  let context = null;
  let source = null;
  try {
    context = new AudioCtx({ sampleRate: 16_000 });
    source = context.createMediaStreamSource(stream);
  } catch {
    if (context) void context.close().catch(() => undefined);
    context = new AudioCtx();
    source = context.createMediaStreamSource(stream);
  }
  session.context = context;
  session.source = source;
  session.rate = context.sampleRate;
  // Silencio hacia los parlantes: el nodo tiene que estar conectado para recibir audio, pero no se oye.
  const sink = context.createGain();
  sink.gain.value = 0;
  sink.connect(context.destination);
  session.sink = sink;
  let node = null;
  if (context.audioWorklet && typeof AudioWorkletNode === "function") {
    try {
      await context.audioWorklet.addModule("/pcm-capture.js");
      node = new AudioWorkletNode(context, "pcm-capture", { channelCount: 1, channelCountMode: "explicit" });
      node.port.onmessage = (event) => onLocalAudio(session, event.data);
    } catch {
      node = null;
    }
  }
  if (!node) {
    node = context.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (event) => onLocalAudio(session, new Float32Array(event.inputBuffer.getChannelData(0)));
  }
  session.node = node;
  source.connect(node);
  node.connect(sink);
  if (context.state === "suspended") await context.resume();
}

function releaseMicrophone(session) {
  const node = session.node;
  if (node) {
    try {
      node.port?.postMessage("stop");
    } catch {
      // Ya estaba cerrado.
    }
    if (node.port) node.port.onmessage = null;
    node.onaudioprocess = null;
  }
  for (const part of [session.source, node, session.sink]) {
    try {
      part?.disconnect();
    } catch {
      // Ya estaba desconectado.
    }
  }
  for (const track of session.stream?.getTracks() ?? []) track.stop();
  if (session.context && session.context.state !== "closed") void session.context.close().catch(() => undefined);
  session.stream = null;
  session.context = null;
  session.source = null;
  session.node = null;
  session.sink = null;
}

function microphoneError(error) {
  const name = error?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "Permite el uso del micrófono para dictar.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No se encontró un micrófono.";
  if (name === "NotReadableError" || name === "AbortError") return "Otro programa está usando el micrófono.";
  return `No se pudo abrir el micrófono: ${error?.message ?? error}`;
}

/** Cada ~100 ms de audio: detecta si hablas, junta el trozo y lo corta en la siguiente pausa. */
function onLocalAudio(session, chunk) {
  if (dictation !== session || session.finishing || session.cancelled || !chunk?.length) return;
  const seconds = chunk.length / session.rate;
  let sum = 0;
  for (let index = 0; index < chunk.length; index += 1) sum += chunk[index] * chunk[index];
  const rms = Math.sqrt(sum / chunk.length);
  session.elapsed += seconds;
  session.level = session.level * 0.6 + Math.min(1, rms / 0.12) * 0.4;
  setDictationLevel(session.level);

  // Los primeros instantes miden el ruido del lugar; lo grabado se guarda por si ya empezaste a hablar.
  if (session.floor === null) {
    session.calibration.push(rms);
    keepPreroll(session, chunk);
    if (session.elapsed < LOCAL_DICTATION.calibrate) return;
    session.floor = Math.min(0.05, Math.max(0.0015, Math.min(...session.calibration)));
  }
  const threshold = Math.max(0.008, session.floor * 2.5);
  const loud = rms > threshold;
  // El ruido de fondo se sigue de cerca cuando baja y muy despacio cuando sube (más aún mientras hablas).
  const rise = session.segment ? 0.003 : 0.03;
  session.floor += (rms - session.floor) * (rms < session.floor ? 0.3 : rise);
  session.floor = Math.min(0.05, Math.max(0.0015, session.floor));

  const segment = session.segment;
  if (segment) {
    segment.chunks.push(chunk);
    segment.samples += chunk.length;
    if (loud) {
      segment.voiced += seconds;
      segment.silence = 0;
    } else {
      segment.silence += seconds;
    }
    const length = segment.samples / session.rate;
    const pause = segment.silence >= LOCAL_DICTATION.pause;
    if (pause || length >= LOCAL_DICTATION.hardMax || (length >= LOCAL_DICTATION.softMax && !loud)) flushLocalSegment(session);
  } else if (loud) {
    session.segment = {
      chunks: [...session.preroll, chunk],
      samples: session.prerollSamples + chunk.length,
      voiced: seconds,
      silence: 0,
    };
    session.preroll = [];
    session.prerollSamples = 0;
  } else {
    keepPreroll(session, chunk);
  }

  if (loud) {
    session.heard = true;
    session.quiet = 0;
  } else {
    session.quiet += seconds;
  }
  if (session.mode === "voice") {
    if (session.heard && session.quiet >= LOCAL_DICTATION.voiceEnd) {
      void finishLocalDictation(session);
    } else if (!session.heard && session.elapsed >= LOCAL_DICTATION.voiceNoSpeech) {
      cancelLocalDictation(session);
      showToast("No te escuché. Pulsa de nuevo y habla cerca del micrófono.");
    }
  } else if (session.quiet >= LOCAL_DICTATION.dictateIdle) {
    void finishLocalDictation(session);
    showToast("Dejé de dictar porque no te escuché un rato.");
  }
  if (dictation === session && !session.finishing && session.elapsed >= LOCAL_DICTATION.maxTotal) {
    void finishLocalDictation(session);
    showToast("Dictaste cinco minutos seguidos: lo corté aquí. Pulsa de nuevo para seguir.");
  }
}

function keepPreroll(session, chunk) {
  session.preroll.push(chunk);
  session.prerollSamples += chunk.length;
  while (session.preroll.length > 1 && session.prerollSamples - session.preroll[0].length >= LOCAL_DICTATION.preroll * session.rate) {
    session.prerollSamples -= session.preroll.shift().length;
  }
}

/** Manda el trozo grabado al servidor; los textos se agregan en el orden en que hablaste. */
function flushLocalSegment(session) {
  const segment = session.segment;
  session.segment = null;
  if (!segment || segment.voiced < LOCAL_DICTATION.minVoiced) return;
  // El silencio del final no aporta nada: se deja un poco y se recorta el resto.
  const trailing = Math.floor(Math.max(0, segment.silence - 0.3) * session.rate);
  const wav = encodeWav(segment.chunks, segment.samples - trailing, session.rate);
  session.pending += 1;
  renderDictationStatus();
  const job = transcribeAudio(wav).catch((error) => {
    if (!session.cancelled) reportLocalDictationError(session, error);
    return "";
  });
  session.chain = session.chain
    .then(() => job)
    .then((text) => {
      session.pending -= 1;
      if (!session.cancelled && text) appendDictation(session, text);
      renderDictationStatus();
    });
}

function appendDictation(session, text) {
  if (state.currentId !== session.agentId) return;
  const input = $("#composer-input");
  const current = input.value;
  input.value = current && !/\s$/.test(current) ? `${current} ${text}` : current + text;
  autosize(input);
  input.scrollTop = input.scrollHeight;
  saveDraft();
  updateActionButton();
}

function reportLocalDictationError(session, error) {
  if (error.status === 409 && state.speech) {
    // Alguien borró el modelo: se vuelve a ofrecer la descarga.
    applySpeechStatus({ ...state.speech, state: "missing", progress: null, error: null });
  }
  if (session.errorShown) return;
  session.errorShown = true;
  showToast(error.message, "error");
}

/** Termina de grabar, espera los últimos textos y, en el modo de voz, envía el mensaje. */
function finishLocalDictation(session, { send = session.mode === "voice" } = {}) {
  if (session.done) {
    if (!send) session.sendAfter = false;
    return session.done;
  }
  session.sendAfter = send;
  session.finishing = true;
  flushLocalSegment(session);
  releaseMicrophone(session);
  updateDictationUi();
  session.done = session.chain.then(() => {
    if (dictation !== session) return;
    dictation = null;
    updateDictationUi();
    saveDraft();
    const input = $("#composer-input");
    if (session.sendAfter && !session.cancelled && state.currentId === session.agentId && input.value.trim()) {
      // Le hablaste: la respuesta se lee en voz alta aunque «Leer sus respuestas» esté apagado.
      voiceReply = { agentId: session.agentId, startedAt: Date.now(), sawWorking: false, until: null };
      void sendMessage();
    }
  });
  return session.done;
}

function cancelLocalDictation(session) {
  session.cancelled = true;
  releaseMicrophone(session);
  if (dictation === session) {
    dictation = null;
    updateDictationUi();
  }
}

async function transcribeAudio(wav) {
  let response;
  try {
    response = await fetch("/api/speech/transcribe", {
      method: "POST",
      headers: { "x-cuadrilla": "1", "content-type": "audio/wav" },
      body: wav,
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError("No hay conexión con el servidor.", 0);
  }
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    showLogin();
    throw new ApiError(data.error || "Inicia sesión.", 401);
  }
  if (!response.ok) throw new ApiError(data.error || `El dictado falló (${response.status}).`, response.status);
  return typeof data.text === "string" ? data.text : "";
}

/** WAV PCM de 16 bits, mono, con los primeros «total» valores de los trozos. */
function encodeWav(chunks, total, rate) {
  const count = Math.max(0, total);
  const buffer = new ArrayBuffer(44 + count * 2);
  const view = new DataView(buffer);
  const text = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + count * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, count * 2, true);
  let offset = 44;
  let written = 0;
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length && written < count; index += 1, written += 1) {
      const value = Math.max(-1, Math.min(1, chunk[index]));
      view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

// ---------- dictado: descarga del modelo y avisos ----------

/** Pide permiso y descarga el reconocimiento de voz la primera vez. Devuelve true si ya está listo. */
async function ensureLocalModel() {
  const status = state.speech;
  if (!status) return false;
  if (status.state === "ready") return true;
  if (status.state === "downloading" || status.state === "extracting") {
    showToast(`${speechProgressText(status)}. Te aviso cuando esté listo.`);
    return false;
  }
  const ok = await confirmAction(
    "¿Descargar el dictado?",
    `Para dictar, ClosedBot descarga una sola vez el reconocimiento de voz (${status.sizeMb} MB). Después funciona en este PC: gratis, sin internet y sin enviar tu voz a nadie.`,
    "Descargar",
    "primary",
  );
  if (!ok) return false;
  await installLocalModel();
  return false;
}

async function installLocalModel(button = null) {
  if (button) button.disabled = true;
  try {
    const result = await api("/api/speech/install", { method: "POST" });
    applySpeechStatus(result.speech);
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    if (button) button.disabled = false;
  }
}

function speechProgressText(status) {
  if (status.state === "extracting") return "Instalando el dictado";
  return `Descargando el dictado: ${Math.floor((status.progress ?? 0) * 100)} % de ${status.sizeMb} MB`;
}

function applySpeechStatus(status) {
  const previous = state.speech?.state ?? null;
  state.speech = status ?? null;
  const next = state.speech?.state ?? null;
  if (previous && next && previous !== next) {
    if (next === "ready" && (previous === "downloading" || previous === "extracting")) {
      showToast("El dictado ya está listo: pulsa el micrófono para hablar.");
    } else if (next === "error") {
      showToast(state.speech.error ?? "No se pudo descargar el dictado.", "error");
    }
  }
  renderDictationStatus();
  renderSpeechSettings();
  updateDictateButton();
}

function renderDictationStatus() {
  const box = $("#dictation-status");
  if (!box) return;
  const session = dictation?.engine === "local" ? dictation : null;
  const status = state.speech;
  let message = "";
  let progress = null;
  let listening = false;
  if (session) {
    if (session.opening) message = "Abriendo el micrófono…";
    else if (session.finishing) message = "Escribiendo lo que dijiste…";
    else {
      listening = true;
      message = session.mode === "voice" ? "Te escucho. Cuando dejes de hablar, lo envío." : "Te escucho. Pulsa el micrófono para terminar.";
    }
  } else if (status?.state === "downloading" || status?.state === "extracting") {
    message = `${speechProgressText(status)}…`;
    if (status.state === "downloading") progress = status.progress ?? 0;
  }
  box.hidden = !message;
  box.dataset.listening = String(listening);
  $("#dictation-status-text").textContent = message;
  const bar = $("#dictation-progress");
  bar.hidden = progress === null;
  if (progress !== null) bar.value = progress;
  if (!listening) setDictationLevel(0);
}

function setDictationLevel(level) {
  $("#dictation-status")?.style.setProperty("--level", level.toFixed(3));
}

/** Ajustes → Dictado por voz: estado del reconocimiento en este PC y qué motor usar. */
function renderSpeechSettings() {
  const list = $("#speech-settings");
  if (!list) return;
  list.replaceChildren();
  const status = state.speech;
  const item = document.createElement("li");
  item.className = "provider";
  const title = document.createElement("div");
  title.className = "title";
  const name = document.createElement("span");
  name.textContent = "Reconocimiento en este PC";
  const badge = document.createElement("span");
  badge.className = "state";
  const detail = document.createElement("div");
  detail.className = "detail";
  let action = null;
  if (!status || !CanRecord) {
    badge.textContent = "No disponible";
    badge.dataset.tone = "bad";
    detail.textContent = !status
      ? "Este servidor no tiene el dictado local."
      : "Esta ventana no puede grabar audio (hace falta abrir ClosedBot en este PC o con https).";
  } else if (status.state === "ready") {
    badge.textContent = "Listo";
    badge.dataset.tone = "ok";
    detail.textContent = `${status.model}. Funciona sin internet y tu voz no sale de este PC.`;
  } else if (status.state === "downloading" || status.state === "extracting") {
    badge.textContent = status.state === "downloading" ? `${Math.floor((status.progress ?? 0) * 100)} %` : "Instalando…";
    badge.dataset.tone = "warn";
    detail.textContent = `${speechProgressText(status)}. Puedes seguir usando ClosedBot mientras tanto.`;
  } else {
    badge.textContent = status.state === "error" ? "Falló" : "Sin descargar";
    badge.dataset.tone = status.state === "error" ? "bad" : "warn";
    detail.textContent =
      status.state === "error" && status.error
        ? status.error
        : `${status.model}, ${status.sizeMb} MB. Se descarga una vez; después funciona sin internet y tu voz no sale de este PC.`;
    action = smallButton(status.state === "error" ? "Reintentar" : "Descargar", "primary");
    action.addEventListener("click", () => void installLocalModel(action));
  }
  title.append(name, badge);
  item.append(title, detail);
  if (action) item.append(actionRow(action));
  if (Recognition && status && CanRecord) {
    const field = document.createElement("label");
    field.className = "field speech-engine";
    const label = document.createElement("span");
    label.textContent = "Para dictar, usar";
    const select = document.createElement("select");
    select.id = "dictation-engine";
    for (const [value, text] of [
      ["auto", "Automático"],
      ["local", "Este PC (privado, sin internet)"],
      ["navegador", "El servicio de voz del navegador"],
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      select.append(option);
    }
    select.value = dictationChoice();
    select.addEventListener("change", () => {
      rememberDictation(DICTATION_KEY, select.value === "auto" ? null : select.value);
      // Elegir a mano el navegador le da otra oportunidad aunque antes fallara.
      if (select.value === "navegador") rememberDictation(BROWSER_FAILED_KEY, null);
      renderSpeechSettings();
    });
    field.append(label, select);
    const hint = document.createElement("div");
    hint.className = "detail";
    hint.textContent = useLocalDictation() ? "Ahora dictas con este PC." : "Ahora dictas con el servicio de voz del navegador (manda tu voz a internet).";
    item.append(field, hint);
  }
  list.append(item);
}

function stopDictation({ cancel = false } = {}) {
  const session = dictation;
  if (!session) return;
  if (session.engine === "local") {
    if (cancel) cancelLocalDictation(session);
    else void finishLocalDictation(session);
    return;
  }
  if (!recognition) return;
  if (cancel) session.cancelled = true;
  try {
    recognition.stop();
  } catch {
    // Ya estaba detenido.
  }
}

function updateDictationUi() {
  const button = $("#dictate");
  const active = dictation?.mode === "dictate" && !dictation.finishing;
  button.setAttribute("aria-pressed", String(active));
  button.title = active ? "Dejar de dictar" : "Dictar";
  renderDictationStatus();
  updateActionButton();
}

// ---------- acciones del agente ----------

async function agentAction(action, agentId = state.currentId) {
  closeContextMenu();
  const agent = findAgent(agentId);
  if (!agent) return;
  const path = `/api/agents/${encodeURIComponent(agent.id)}`;
  try {
    if (action === "edit") {
      await openAgentDialog(agent);
    } else if (action === "routines") {
      openRoutines(agent.id);
    } else if (action === "pause") {
      await api(`${path}/pause`, { method: "POST", body: { paused: !agent.paused } });
      showToast(agent.paused ? "Cola reanudada." : "Cola en pausa: los mensajes nuevos esperarán.");
    } else if (action === "reset") {
      const ok = await confirmAction(
        "¿Empezar de cero?",
        `Se borra el historial de ${agent.name} y su cola, y empieza una conversación nueva. Los archivos de su carpeta y sus rutinas no se tocan.`,
        "Empezar de cero",
      );
      if (!ok) return;
      await api(`${path}/reset`, { method: "POST" });
      state.messages.set(agent.id, []);
      state.hasMore.set(agent.id, false);
      if (agent.id === state.currentId) {
        renderAllMessages();
        renderQueue();
        updatePlaceholder();
      }
    } else if (action === "delete") {
      // Claude Bot no se elimina: se puede empezar de cero.
      if (agent.main) return;
      const ok = await confirmAction(
        `¿Eliminar a ${agent.name}?`,
        "Se borran el agente, su historial, su cola y sus rutinas. Su carpeta de trabajo queda en el equipo por si la necesitas.",
        "Eliminar",
      );
      if (!ok) return;
      await api(path, { method: "DELETE" });
      state.messages.delete(agent.id);
      state.attachments.delete(agent.id);
      state.keepUnread.delete(agent.id);
      state.agents = state.agents.filter((item) => item.id !== agent.id);
      if (details.agentId === agent.id) closeDialog($("#details-dialog"));
      if (agent.id === state.currentId) await navigate(null);
      else renderSidebar();
    }
  } catch (error) {
    showToast(error.message, "error");
  }
}

/** Guarda un cambio del agente y actualiza la interfaz sin esperar al aviso del servidor. */
async function patchAgent(agentId, body) {
  try {
    const result = await api(`/api/agents/${encodeURIComponent(agentId)}`, { method: "PATCH", body });
    replaceAgent(result.agent);
    return result.agent;
  } catch (error) {
    showToast(error.message, "error");
    return null;
  }
}

function replaceAgent(agent) {
  const index = state.agents.findIndex((item) => item.id === agent.id);
  if (index >= 0) state.agents[index] = agent;
  else state.agents.push(agent);
  renderSidebar();
  renderHeader();
  renderDetailsIfOpen();
}

async function renameAgent(agentId) {
  const agent = findAgent(agentId);
  if (!agent) return;
  await promptText({
    title: "Cambiar nombre",
    label: "Nombre",
    value: agent.name,
    okLabel: "Guardar",
    submit: async (name) => {
      if (name === agent.name) return;
      const result = await api(`/api/agents/${encodeURIComponent(agentId)}`, { method: "PATCH", body: { name } });
      replaceAgent(result.agent);
    },
  });
}

async function toggleHidden(agentId) {
  const agent = findAgent(agentId);
  if (!agent) return;
  const updated = await patchAgent(agentId, { hidden: !agent.hidden });
  if (updated?.hidden) showToast(`Ocultaste a ${updated.name}: está al final de la lista, en «Ocultos», y en la búsqueda.`);
}

async function setUnread(agentId, unread) {
  // Antes de pedirlo: el aviso del servidor puede llegar antes que la respuesta.
  if (unread) state.keepUnread.add(agentId);
  else state.keepUnread.delete(agentId);
  try {
    const result = await api(`/api/agents/${encodeURIComponent(agentId)}/${unread ? "unread" : "read"}`, { method: "POST" });
    replaceAgent(result.agent);
  } catch (error) {
    if (unread) state.keepUnread.delete(agentId);
    showToast(error.message, "error");
  }
}

async function markAllRead() {
  state.keepUnread.clear();
  try {
    await api("/api/read-all", { method: "POST" });
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function moveAgent(agentId, project) {
  await patchAgent(agentId, { project });
}

/** Crea la sección si no existe (si ya existe, se usa esa). */
async function ensureSection(name) {
  try {
    const result = await api("/api/sections", { method: "POST", body: { name } });
    state.sections = result.sections;
  } catch (error) {
    if (error.status !== 409) throw error;
  }
}

async function createSectionFor(agentId) {
  await promptText({
    title: "Nueva sección",
    label: "Nombre de la sección",
    placeholder: "Ej.: Creación de Juegos",
    okLabel: "Crear y mover",
    submit: async (name) => {
      await ensureSection(name);
      const result = await api(`/api/agents/${encodeURIComponent(agentId)}`, { method: "PATCH", body: { project: name } });
      replaceAgent(result.agent);
    },
  });
}

async function newSection() {
  await promptText({
    title: "Nueva sección",
    label: "Nombre de la sección",
    placeholder: "Ej.: Creación de Juegos",
    okLabel: "Crear",
    submit: async (name) => {
      const result = await api("/api/sections", { method: "POST", body: { name } });
      state.sections = result.sections;
      renderSidebar();
    },
  });
}

async function renameSection(name) {
  await promptText({
    title: "Cambiar nombre de la sección",
    label: "Nombre",
    value: name,
    okLabel: "Guardar",
    submit: async (to) => {
      if (to === name) return;
      const result = await api("/api/sections/rename", { method: "POST", body: { from: name, to } });
      state.sections = result.sections;
      if (state.collapsed.delete(sectionKey(name))) {
        state.collapsed.add(sectionKey(to));
        saveCollapsed();
      }
      renderSidebar();
    },
  });
}

async function deleteSection(name) {
  const count = state.agents.filter((agent) => !agent.main && agent.project.toLowerCase() === name.toLowerCase()).length;
  const text = count
    ? `${count === 1 ? "Su agente pasa" : `Sus ${count} agentes pasan`} a «Sin asignar». No se borra ningún agente.`
    : "No tiene agentes, así que no se borra nada más.";
  if (!(await confirmAction(`¿Eliminar la sección «${name}»?`, text, "Eliminar sección"))) return;
  try {
    const result = await api("/api/sections/delete", { method: "POST", body: { name } });
    state.sections = result.sections;
    if (state.collapsed.delete(sectionKey(name))) saveCollapsed();
    renderSidebar();
  } catch (error) {
    showToast(error.message, "error");
  }
}

// ---------- menús contextuales (clic derecho, «⋯» o mantener presionado) ----------

let menuState = null; // { source, openedAt, submenuFor }

function agentMenuItems(agentId) {
  const agent = findAgent(agentId);
  if (!agent) return [];
  const readItem = agent.unread
    ? { label: "Marcar como leído", icon: "check", run: () => setUnread(agent.id, false) }
    : { label: "Marcar como no leído", icon: "unread", run: () => setUnread(agent.id, true) };
  if (agent.main) {
    // Claude Bot va fijo arriba: no se mueve, no se oculta ni se elimina.
    return [
      { label: "Ver su ficha", icon: "details", run: () => openDetails(agent.id) },
      readItem,
      { label: "Cambiar nombre", icon: "pencil", run: () => renameAgent(agent.id) },
    ];
  }
  return [
    { label: agent.pinned ? "Desfijar" : "Fijar", icon: "pin", run: () => patchAgent(agent.id, { pinned: !agent.pinned }) },
    { label: "Mover a", icon: "move", submenu: () => moveMenuItems(agent.id) },
    readItem,
    { label: "Cambiar nombre", icon: "pencil", run: () => renameAgent(agent.id) },
    agent.hidden
      ? { label: "Mostrar en la barra lateral", icon: "eye", run: () => toggleHidden(agent.id) }
      : { label: "Ocultar de la barra lateral", icon: "eyeOff", run: () => toggleHidden(agent.id) },
    "-",
    { label: "Eliminar", icon: "trash", danger: true, run: () => agentAction("delete", agent.id) },
  ];
}

function moveMenuItems(agentId) {
  const agent = findAgent(agentId);
  if (!agent) return [];
  const current = agent.project.toLowerCase();
  const items = allSections().map((name) => ({
    label: name,
    checked: name.toLowerCase() === current,
    run: () => moveAgent(agentId, name),
  }));
  items.push({ label: "Sin asignar", checked: !agent.project, run: () => moveAgent(agentId, "") });
  items.push("-", { label: "Crear sección", icon: "folderPlus", run: () => createSectionFor(agentId) });
  return items;
}

function sidebarMenuItems() {
  return [
    { label: "Nuevo agente", icon: "plus", run: () => openCreateDialog() },
    { label: "Nueva sección", icon: "section", run: () => newSection() },
    "-",
    { label: "Marcar todo como leído", icon: "allRead", disabled: !state.agents.some((agent) => agent.unread), run: () => markAllRead() },
  ];
}

function sectionMenuItems(name) {
  return [
    { label: "Nuevo agente aquí", icon: "plus", run: () => openCreateDialog({ project: name }) },
    { label: "Cambiar nombre de la sección", icon: "pencil", run: () => renameSection(name) },
    "-",
    { label: "Eliminar sección", icon: "trash", danger: true, run: () => deleteSection(name) },
  ];
}

/** Qué menú corresponde a lo que se tocó en la barra lateral (o nada, si es un campo o un botón de arriba). */
function sidebarMenuFor(target) {
  if (!(target instanceof Element)) return null;
  if (target.closest("input, textarea, select, .sidebar-footer, .search-box, .sidebar-tools")) return null;
  const row = target.closest(".agent-item");
  if (row) return findAgent(row.dataset.id) ? { items: agentMenuItems(row.dataset.id), anchor: row.querySelector(".row-more") ?? row } : null;
  if (target.closest("#bot-card")) {
    const main = mainAgent();
    return main ? { items: agentMenuItems(main.id), anchor: $("#bot-card") } : null;
  }
  const head = target.closest(".group-head[data-section]");
  if (head) return { items: sectionMenuItems(head.dataset.section), anchor: head };
  return { items: sidebarMenuItems(), anchor: null };
}

function openContextMenu(items, { x = 0, y = 0, anchor = null, source = null } = {}) {
  if (!items.length) return;
  closeContextMenu();
  const menu = $("#context-menu");
  fillMenu(menu, items, false);
  menu.hidden = false;
  placeMenu(menu, anchor?.getBoundingClientRect() ?? null, x, y);
  menuState = { source: source ?? anchor, openedAt: Date.now(), submenuFor: null };
  if (menuState.source?.getAttribute?.("aria-haspopup") === "menu") menuState.source.setAttribute("aria-expanded", "true");
  menu.focus({ preventScroll: true });
}

function fillMenu(menu, items, isSub) {
  menu.replaceChildren();
  for (const item of items) {
    if (item === "-") {
      const line = document.createElement("div");
      line.className = "menu-sep";
      line.setAttribute("role", "separator");
      menu.append(line);
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = item.danger ? "menu-item danger" : "menu-item";
    button.disabled = Boolean(item.disabled);
    const checkable = item.checked !== undefined;
    button.setAttribute("role", checkable ? "menuitemradio" : "menuitem");
    if (checkable) button.setAttribute("aria-checked", String(item.checked));
    const lead = checkable ? (item.checked ? icon("check") : document.createElement("span")) : item.icon ? icon(item.icon) : document.createElement("span");
    lead.classList.add("menu-icon");
    const label = document.createElement("span");
    label.className = "menu-label";
    label.textContent = item.label;
    button.append(lead, label);
    if (item.submenu) {
      button.setAttribute("aria-haspopup", "menu");
      button.setAttribute("aria-expanded", "false");
      button.append(icon("chevron", "menu-trail"));
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        openSubmenu(button, item.submenu, { focus: true });
      });
      if (!coarsePointer) button.addEventListener("pointerenter", () => openSubmenu(button, item.submenu, { focus: false }));
    } else {
      button.addEventListener("click", () => {
        closeContextMenu();
        void item.run();
      });
      if (!isSub && !coarsePointer) button.addEventListener("pointerenter", closeSubmenu);
    }
    menu.append(button);
  }
}

function placeMenu(menu, anchorRect, x, y) {
  menu.style.left = "0px";
  menu.style.top = "0px";
  const rect = menu.getBoundingClientRect();
  const width = window.innerWidth;
  const height = window.innerHeight;
  let left;
  let top;
  if (anchorRect) {
    left = anchorRect.right - rect.width;
    top = anchorRect.bottom + 4;
    if (top + rect.height > height - 8) top = anchorRect.top - rect.height - 4;
  } else {
    left = x + 2;
    top = y + 2;
    if (left + rect.width > width - 8) left = x - rect.width - 2;
    if (top + rect.height > height - 8) top = y - rect.height - 2;
  }
  left = Math.max(8, Math.min(left, width - rect.width - 8));
  top = Math.max(8, Math.min(top, height - rect.height - 8));
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

function openSubmenu(parent, items, { focus = false } = {}) {
  const sub = $("#context-submenu");
  if (menuState?.submenuFor === parent && !sub.hidden) {
    if (focus) focusMenuItem(sub, 0);
    return;
  }
  closeSubmenu();
  fillMenu(sub, typeof items === "function" ? items() : items, true);
  sub.hidden = false;
  sub.style.left = "0px";
  sub.style.top = "0px";
  const parentRect = parent.getBoundingClientRect();
  const menuRect = $("#context-menu").getBoundingClientRect();
  const rect = sub.getBoundingClientRect();
  let left = menuRect.right - 4;
  let top = parentRect.top - 6;
  if (left + rect.width > window.innerWidth - 8) left = menuRect.left - rect.width + 4;
  if (left < 8) {
    // Pantalla angosta: el submenú va debajo de la opción, encima del menú.
    left = Math.max(8, Math.min(menuRect.left + 16, window.innerWidth - rect.width - 8));
    top = parentRect.bottom + 2;
  }
  top = Math.max(8, Math.min(top, window.innerHeight - rect.height - 8));
  sub.style.left = `${Math.round(left)}px`;
  sub.style.top = `${Math.round(top)}px`;
  parent.setAttribute("aria-expanded", "true");
  if (menuState) menuState.submenuFor = parent;
  if (focus) focusMenuItem(sub, 0);
}

function closeSubmenu() {
  const sub = $("#context-submenu");
  if (sub.hidden) return;
  sub.hidden = true;
  sub.replaceChildren();
  menuState?.submenuFor?.setAttribute("aria-expanded", "false");
  if (menuState) menuState.submenuFor = null;
}

function closeContextMenu({ restoreFocus = false } = {}) {
  closeSubmenu();
  const menu = $("#context-menu");
  const source = menuState?.source;
  menuState = null;
  if (source?.getAttribute?.("aria-haspopup") === "menu") source.setAttribute("aria-expanded", "false");
  if (menu.hidden) return;
  menu.hidden = true;
  menu.replaceChildren();
  if (restoreFocus && source?.isConnected) source.focus({ preventScroll: true });
}

function menuItemsOf(menu) {
  return [...menu.querySelectorAll(".menu-item:not(:disabled)")];
}

function focusMenuItem(menu, index) {
  const items = menuItemsOf(menu);
  if (!items.length) {
    menu.focus({ preventScroll: true });
    return;
  }
  items[((index % items.length) + items.length) % items.length].focus({ preventScroll: true });
}

function onMenuKeydown(event) {
  const menu = event.currentTarget;
  const items = menuItemsOf(menu);
  const current = items.indexOf(document.activeElement);
  const isSub = menu.id === "context-submenu";
  const backToParent = () => {
    const parent = menuState?.submenuFor;
    closeSubmenu();
    parent?.focus({ preventScroll: true });
  };
  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      focusMenuItem(menu, current + 1);
      break;
    case "ArrowUp":
      event.preventDefault();
      focusMenuItem(menu, current < 0 ? -1 : current - 1);
      break;
    case "Home":
      event.preventDefault();
      focusMenuItem(menu, 0);
      break;
    case "End":
      event.preventDefault();
      focusMenuItem(menu, -1);
      break;
    case "ArrowRight":
      if (!isSub && document.activeElement?.getAttribute("aria-haspopup") === "menu") {
        event.preventDefault();
        document.activeElement.click();
      }
      break;
    case "ArrowLeft":
      if (isSub) {
        event.preventDefault();
        backToParent();
      }
      break;
    case "Escape":
      event.preventDefault();
      event.stopPropagation();
      if (isSub) backToParent();
      else closeContextMenu({ restoreFocus: true });
      break;
    case "Tab":
      event.preventDefault();
      closeContextMenu({ restoreFocus: true });
      break;
    default:
      break;
  }
}

/** Clic derecho y mantener presionado (celular) en la barra lateral. */
function bindSidebarMenus() {
  const sidebar = $(".sidebar");
  const press = { timer: null, x: 0, y: 0, target: null, fired: false, releasedAt: 0 };
  const cancel = () => {
    clearTimeout(press.timer);
    press.timer = null;
  };
  sidebar.addEventListener("pointerdown", (event) => {
    press.fired = false;
    if (event.pointerType !== "touch") return;
    cancel();
    press.x = event.clientX;
    press.y = event.clientY;
    press.target = event.target;
    press.timer = setTimeout(() => {
      press.timer = null;
      const spec = sidebarMenuFor(press.target);
      if (!spec) return;
      press.fired = true;
      navigator.vibrate?.(8);
      openContextMenu(spec.items, { x: press.x, y: press.y + 8 });
    }, LONG_PRESS_MS);
  });
  sidebar.addEventListener("pointermove", (event) => {
    if (press.timer && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) cancel();
  });
  sidebar.addEventListener("pointerup", () => {
    cancel();
    if (press.fired) press.releasedAt = Date.now();
  });
  sidebar.addEventListener("pointercancel", cancel);
  // El toque que abrió el menú no debe abrir además la conversación.
  sidebar.addEventListener(
    "click",
    (event) => {
      if (!press.fired) return;
      press.fired = false;
      if (Date.now() - press.releasedAt < 600) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true,
  );
  sidebar.addEventListener("contextmenu", (event) => {
    // Android también avisa «contextmenu» al mantener presionado: un solo menú.
    if (press.fired) {
      event.preventDefault();
      return;
    }
    const spec = sidebarMenuFor(event.target);
    if (!spec) return;
    event.preventDefault();
    const touch = Boolean(press.timer) || event.pointerType === "touch";
    cancel();
    if (touch) {
      press.fired = true;
      openContextMenu(spec.items, { x: event.clientX, y: event.clientY + 8 });
    } else if (event.button !== 2 && !event.clientX && !event.clientY) {
      // Teclado (Mayús+F10 o la tecla de menú): junto al elemento.
      openContextMenu(spec.items, { anchor: spec.anchor ?? event.target, source: event.target });
    } else {
      openContextMenu(spec.items, { x: event.clientX, y: event.clientY, source: event.target.closest("button") });
    }
  });
}

async function stopAgent() {
  const agent = findAgent(state.currentId);
  if (!agent) return;
  try {
    await api(`/api/agents/${encodeURIComponent(agent.id)}/interrupt`, { method: "POST" });
  } catch (error) {
    showToast(error.message, "error");
  }
}

// ---------- diálogo de agente ----------

async function openAgentDialog(agent = null) {
  editingAgentId = agent?.id ?? null;
  const form = $("#agent-form");
  form.reset();
  $("#agent-error").textContent = "";
  $("#agent-dialog-title").textContent = agent ? `Editar a ${agent.name}` : "Nuevo agente";
  const main = Boolean(agent?.main);
  $("#project-field").hidden = main;
  $("#instructions-label").textContent = main ? "Tus preferencias para armar equipos" : "Instrucciones permanentes";
  form.elements.instructions.placeholder = main
    ? "Opcional. Ej.: equipos de 3 agentes como máximo; usa Sonnet para tareas simples; escríbeme siempre en español."
    : "Cómo quieres que trabaje, qué debe priorizar, cuándo pedir ayuda…";
  form.elements.name.value = agent?.name ?? "";
  form.elements.project.value = agent ? agent.project : (findAgent(state.currentId)?.project ?? "");
  form.elements.role.placeholder = main ? "Ej.: Bot principal: arma y coordina mis equipos" : "Ej.: Investigadora, Programador, Revisora";
  form.elements.role.value = agent?.role ?? "";
  form.elements.instructions.value = agent?.instructions ?? "";
  form.elements.access.value = agent?.access ?? "carpeta";
  $("#project-options").replaceChildren(...allSections().map((section) => new Option(section, section)));
  fillProviders(agent?.provider);
  updateAccessWarning();
  openDialog($("#agent-dialog"));
  await refreshModelOptions(agent?.model ?? "", agent?.effort ?? "");
  if (!coarsePointer) form.elements.name.focus();
}

/** Proveedor para un agente nuevo: el primero con IA instalado y con sesión; si no hay, Demo. */
function preferredProvider() {
  return state.providers.find((provider) => provider.id !== "demo" && provider.available && provider.loggedIn !== false)?.id ?? "demo";
}

function fillProviders(selected) {
  const select = $("#agent-form").elements.provider;
  select.replaceChildren();
  const preferred = selected ?? preferredProvider();
  for (const provider of state.providers) {
    const option = document.createElement("option");
    option.value = provider.id;
    const suffix = !provider.available ? " (no instalado)" : provider.loggedIn === false ? " (sin sesión)" : provider.id === "demo" ? " (sin IA)" : "";
    option.textContent = `${provider.label}${suffix}`;
    select.append(option);
  }
  select.value = preferred;
  updateProviderHint();
}

function updateProviderHint() {
  const providerId = $("#agent-form").elements.provider.value;
  const provider = state.providers.find((item) => item.id === providerId);
  const hint = $("#provider-hint");
  hint.textContent = provider?.detail ?? "";
  hint.dataset.tone = provider && (!provider.available || provider.loggedIn === false) ? "warn" : "";
}

async function refreshModelOptions(model = "", effort = "") {
  const form = $("#agent-form");
  const provider = form.elements.provider.value;
  const modelSelect = form.elements.model;
  modelSelect.replaceChildren(new Option("Predeterminado", ""));
  modelSelect.disabled = true;
  let models = state.models.get(provider);
  if (!models) {
    try {
      models = (await api(`/api/models?provider=${encodeURIComponent(provider)}`)).models;
      state.models.set(provider, models);
    } catch {
      models = [];
    }
  }
  if (form.elements.provider.value !== provider) return;
  for (const entry of models) modelSelect.append(new Option(entry.displayName || entry.model, entry.model));
  if (model && !models.some((entry) => entry.model === model)) modelSelect.append(new Option(model, model));
  modelSelect.value = model;
  modelSelect.disabled = false;
  refreshEffortOptions(effort);
}

function refreshEffortOptions(effort = "") {
  const form = $("#agent-form");
  const provider = form.elements.provider.value;
  const models = state.models.get(provider) ?? [];
  const selected = models.find((entry) => entry.model === form.elements.model.value) ?? models.find((entry) => entry.isDefault) ?? models[0];
  const efforts = selected?.efforts ?? [];
  const select = form.elements.effort;
  select.replaceChildren(new Option("Predeterminado", ""));
  const labels = { none: "Ninguno", minimal: "Mínimo", low: "Bajo", medium: "Medio", high: "Alto", xhigh: "Muy alto", max: "Máximo" };
  for (const value of efforts) select.append(new Option(labels[value] ?? value, value));
  if (effort && !efforts.includes(effort)) select.append(new Option(effort, effort));
  select.value = effort;
  select.disabled = efforts.length === 0 && !effort;
}

function updateAccessWarning() {
  const form = $("#agent-form");
  // Con «Acceso total para todos» en Ajustes, el nivel de cada agente no se usa: se muestra sin poder cambiarlo.
  const forced = Boolean(state.settings.fullAccess);
  for (const radio of form.querySelectorAll('input[name="access"]')) radio.disabled = forced;
  $("#access-forced").hidden = !forced;
  $("#access-warning").hidden = forced || form.elements.access.value !== "total";
  $("#access-hint").hidden =
    forced || !(state.platform === "win32" && form.elements.provider.value === "claude" && form.elements.access.value === "carpeta");
}

async function saveAgent(event) {
  event.preventDefault();
  const form = $("#agent-form");
  const error = $("#agent-error");
  error.textContent = "";
  const name = form.elements.name.value.trim();
  if (!name) {
    error.textContent = "Ponle un nombre al agente.";
    form.elements.name.focus();
    return;
  }
  const editing = editingAgentId ? findAgent(editingAgentId) : null;
  const body = {
    name,
    ...(editing?.main ? {} : { project: form.elements.project.value }),
    role: form.elements.role.value,
    instructions: form.elements.instructions.value,
    provider: form.elements.provider.value,
    model: form.elements.model.value || null,
    effort: form.elements.effort.value || null,
    access: form.elements.access.value === "total" ? "total" : "carpeta",
  };
  const button = $("#agent-save");
  button.disabled = true;
  try {
    if (editingAgentId) {
      await api(`/api/agents/${encodeURIComponent(editingAgentId)}`, { method: "PATCH", body });
      closeDialog($("#agent-dialog"));
    } else {
      const result = await api("/api/agents", { method: "POST", body });
      closeDialog($("#agent-dialog"));
      if (!findAgent(result.agent.id)) state.agents.push(result.agent);
      renderSidebar();
      await navigate(result.agent.id);
    }
  } catch (problem) {
    error.textContent = problem.message;
  } finally {
    button.disabled = false;
  }
}

// ---------- crear agente: figura, color y nombre ----------

const COLOR_NAMES = ["Morado", "Rojo", "Verde", "Naranja", "Gris", "Azul", "Rosado", "Turquesa", "Mostaza", "Lavanda", "Celeste", "Lima"];
const createState = { shape: 0, color: 0, project: "", agentId: null };

/** «+»: nombre, figura y color, como en la app de referencia. Con agentId cambia la apariencia de uno que ya existe. */
function openCreateDialog({ project = "", agentId = null } = {}) {
  closeContextMenu();
  const agent = agentId ? findAgent(agentId) : null;
  createState.agentId = agent?.id ?? null;
  createState.project = agent ? agent.project : project;
  if (agent) {
    const [shape, color] = avatarParts(agent);
    const index = BLOB_COLORS.indexOf(color);
    createState.shape = shape;
    createState.color = index >= 0 ? index : 4;
  } else {
    createState.shape = Math.floor(Math.random() * BLOB_SHAPES.length);
    createState.color = Math.floor(Math.random() * BLOB_COLORS.length);
  }
  $("#create-title").textContent = agent ? `Apariencia de ${agent.name}` : project ? `Nuevo agente en «${project}»` : "Crear nuevo agente";
  $("#create-save").textContent = agent ? "Guardar" : "Crear";
  const name = $("#create-name");
  name.value = agent?.name ?? "";
  $("#create-error").textContent = "";
  renderCreatePickers();
  openDialog($("#create-dialog"));
  if (!coarsePointer) name.focus();
}

function renderCreatePickers(focusKind = null) {
  const color = BLOB_COLORS[createState.color];
  $("#create-preview").replaceChildren(drawBlob(BLOB_SHAPES[createState.shape], color));
  $("#shape-grid").replaceChildren(
    ...BLOB_SHAPES.map((shape, index) => pickerButton("shape", index, drawBlob(shape, color), `Figura ${index + 1}`)),
  );
  $("#color-row").replaceChildren(
    ...BLOB_COLORS.map((value, index) => {
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.background = value;
      return pickerButton("color", index, swatch, COLOR_NAMES[index] ?? `Color ${index + 1}`);
    }),
  );
  if (focusKind) $(`#${focusKind === "shape" ? "shape-grid" : "color-row"} [aria-checked="true"]`)?.focus();
}

function pickerButton(kind, index, content, label) {
  const selected = createState[kind] === index;
  const button = document.createElement("button");
  button.type = "button";
  button.className = kind === "shape" ? "shape-option" : "color-option";
  button.setAttribute("role", "radio");
  button.setAttribute("aria-checked", String(selected));
  button.setAttribute("aria-label", label);
  button.title = label;
  button.tabIndex = selected ? 0 : -1;
  button.append(content);
  button.addEventListener("click", () => {
    createState[kind] = index;
    renderCreatePickers(kind);
  });
  return button;
}

/** Flechas dentro de las figuras o los colores (grupo de opciones). */
function onPickerKeydown(event, kind) {
  const total = kind === "shape" ? BLOB_SHAPES.length : BLOB_COLORS.length;
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
  if (!step) return;
  event.preventDefault();
  createState[kind] = (createState[kind] + step + total) % total;
  renderCreatePickers(kind);
}

async function saveCreate(event) {
  event.preventDefault();
  const input = $("#create-name");
  const error = $("#create-error");
  error.textContent = "";
  const name = input.value.trim();
  if (!name) {
    error.textContent = "Ponle un nombre a tu agente.";
    input.focus();
    return;
  }
  const avatar = customAvatar(createState.shape, createState.color);
  const button = $("#create-save");
  button.disabled = true;
  try {
    if (createState.agentId) {
      const result = await api(`/api/agents/${encodeURIComponent(createState.agentId)}`, { method: "PATCH", body: { name, avatar } });
      closeDialog($("#create-dialog"));
      replaceAgent(result.agent);
    } else {
      // greet: como lo creaste tú, se presenta con un primer mensaje (los que arma Claude Bot no).
      const body = { name, avatar, project: createState.project, provider: preferredProvider(), greet: true };
      const result = await api("/api/agents", { method: "POST", body });
      closeDialog($("#create-dialog"));
      if (!findAgent(result.agent.id)) state.agents.push(result.agent);
      renderSidebar();
      await navigate(result.agent.id);
    }
  } catch (problem) {
    error.textContent = problem.message;
  } finally {
    button.disabled = false;
  }
}

// ---------- pedir un nombre (renombrar, secciones) ----------

/** Pide un texto corto. `submit` puede fallar: el error se muestra y el cuadro sigue abierto. */
function promptText({ title, label, value = "", placeholder = "", okLabel = "Guardar", maxLength = 60, submit = null }) {
  closeContextMenu();
  const dialog = $("#prompt-dialog");
  const form = $("#prompt-form");
  const input = $("#prompt-input");
  const error = $("#prompt-error");
  const ok = $("#prompt-ok");
  const cancelButton = $("#prompt-cancel");
  $("#prompt-title").textContent = title;
  $("#prompt-label").textContent = label;
  input.value = value;
  input.placeholder = placeholder;
  input.maxLength = maxLength;
  ok.textContent = okLabel;
  ok.disabled = false;
  error.textContent = "";
  openDialog(dialog);
  input.focus();
  input.select();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      form.removeEventListener("submit", onSubmit);
      cancelButton.removeEventListener("click", onCancel);
      dialog.removeEventListener("close", onCancel);
      closeDialog(dialog);
      resolve(result);
    };
    const onSubmit = async (event) => {
      event.preventDefault();
      const text = input.value.trim().replace(/\s+/g, " ");
      if (!text) {
        error.textContent = "Escribe un nombre.";
        input.focus();
        return;
      }
      if (submit) {
        ok.disabled = true;
        error.textContent = "";
        try {
          await submit(text);
        } catch (problem) {
          ok.disabled = false;
          error.textContent = problem.message;
          input.focus();
          return;
        }
      }
      finish(text);
    };
    const onCancel = () => finish(null);
    form.addEventListener("submit", onSubmit);
    cancelButton.addEventListener("click", onCancel);
    dialog.addEventListener("close", onCancel);
  });
}

// ---------- rutinas ----------

const DAYS = [
  [1, "L", "lunes"],
  [2, "M", "martes"],
  [3, "M", "miércoles"],
  [4, "J", "jueves"],
  [5, "V", "viernes"],
  [6, "S", "sábado"],
  [0, "D", "domingo"],
];

function buildDayPicker() {
  const picker = $("#day-picker");
  for (const [value, short, long] of DAYS) {
    const label = document.createElement("label");
    label.title = long;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "days";
    input.value = String(value);
    input.checked = true;
    input.setAttribute("aria-label", long);
    const text = document.createElement("span");
    text.textContent = short;
    label.append(input, text);
    picker.append(label);
  }
}

function openRoutines(agentId = null) {
  routinesFilter = agentId;
  $("#routines-title").textContent = agentId ? `Rutinas de ${agentName(agentId)}` : "Rutinas";
  const form = $("#routine-form");
  form.reset();
  $("#routine-error").textContent = "";
  const select = form.elements.agentId;
  select.replaceChildren(...state.agents.map((agent) => new Option(agent.name, agent.id)));
  const preselect = agentId ?? state.currentId;
  if (preselect && findAgent(preselect)) select.value = preselect;
  updateRoutineKind();
  renderRoutines();
  openDialog($("#routines-dialog"));
}

function renderRoutinesIfOpen() {
  if ($("#routines-dialog").open) renderRoutines();
}

function renderRoutines() {
  const list = $("#routine-list");
  list.replaceChildren();
  const routines = state.routines.filter((routine) => !routinesFilter || routine.agentId === routinesFilter);
  $("#routines-empty").hidden = routines.length > 0;
  for (const routine of routines) list.append(routineItem(routine));
  const form = $("#routine-form");
  const noAgents = state.agents.length === 0;
  form.hidden = noAgents;
  if (noAgents) $("#routines-empty").textContent = "Crea un agente primero: las rutinas siempre las hace un agente.";
}

function routineItem(routine) {
  const item = document.createElement("li");
  item.className = "routine";
  item.dataset.enabled = String(routine.enabled);
  const title = document.createElement("div");
  title.className = "r-title";
  title.textContent = routine.name;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "switch";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-checked", String(routine.enabled));
  toggle.setAttribute("aria-label", routine.enabled ? `Pausar «${routine.name}»` : `Activar «${routine.name}»`);
  toggle.title = routine.enabled ? "Activa" : "En pausa";
  toggle.addEventListener("click", () => void routineRequest(`/api/routines/${encodeURIComponent(routine.id)}`, "PATCH", { enabled: !routine.enabled }));
  const meta = document.createElement("div");
  meta.className = "r-meta";
  const when = routine.enabled ? (routine.nextRunAt ? `próxima: ${formatWhen(routine.nextRunAt)}` : "sin próxima ejecución") : "en pausa";
  meta.textContent = [routine.agentName, routine.description, routine.running ? "en curso…" : when].filter(Boolean).join(" · ");
  const prompt = document.createElement("div");
  prompt.className = "r-prompt";
  prompt.textContent = routine.prompt;
  const actions = document.createElement("div");
  actions.className = "r-actions";
  const run = document.createElement("button");
  run.type = "button";
  run.className = "button ghost";
  run.textContent = "Ejecutar ahora";
  run.disabled = routine.running;
  run.addEventListener("click", async () => {
    if (await routineRequest(`/api/routines/${encodeURIComponent(routine.id)}/run`, "POST")) showToast(`«${routine.name}» quedó en la cola de ${routine.agentName}.`);
  });
  const open = document.createElement("button");
  open.type = "button";
  open.className = "button ghost";
  open.textContent = "Ver conversación";
  open.addEventListener("click", () => {
    closeDialog($("#routines-dialog"));
    void navigate(routine.agentId);
  });
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "button danger-soft";
  remove.textContent = "Eliminar";
  remove.addEventListener("click", async () => {
    const ok = await confirmAction(`¿Eliminar la rutina «${routine.name}»?`, "Deja de ejecutarse. Lo que ya hizo queda en la conversación.", "Eliminar");
    if (ok) await routineRequest(`/api/routines/${encodeURIComponent(routine.id)}`, "DELETE");
  });
  actions.append(run, open, remove);
  item.append(title, toggle, meta, prompt, actions);
  return item;
}

async function routineRequest(path, method, body) {
  try {
    await api(path, { method, body });
    return true;
  } catch (error) {
    showToast(error.message, "error");
    return false;
  }
}

function updateRoutineKind() {
  const form = $("#routine-form");
  const interval = form.elements.kind.value === "interval";
  $("#routine-times").hidden = interval;
  $("#routine-interval").hidden = !interval;
}

/** Acepta «9», «9:30», «9.30» o «9h» y los deja como HH:MM; lo demás lo valida el servidor. */
function parseTimes(raw) {
  return raw
    .split(/[,;\s]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/^(\d{1,2})(?:[:.h](\d{2})?)?$/i);
      return match ? `${match[1].padStart(2, "0")}:${match[2] ?? "00"}` : part;
    });
}

async function saveRoutine(event) {
  event.preventDefault();
  const form = $("#routine-form");
  const error = $("#routine-error");
  error.textContent = "";
  const body = {
    agentId: form.elements.agentId.value,
    name: form.elements.name.value.trim(),
    prompt: form.elements.prompt.value.trim(),
  };
  if (!body.name || !body.prompt) {
    error.textContent = "Ponle un nombre y escribe qué debe hacer.";
    return;
  }
  if (form.elements.kind.value === "interval") {
    body.everyMinutes = Number(form.elements.everyMinutes.value);
  } else {
    body.times = parseTimes(form.elements.times.value);
    if (!body.times.length) {
      error.textContent = "Indica al menos una hora, por ejemplo 09:00.";
      return;
    }
    const days = [...form.querySelectorAll('input[name="days"]:checked')].map((input) => Number(input.value));
    if (!days.length) {
      error.textContent = "Elige al menos un día.";
      return;
    }
    if (days.length < 7) body.days = days;
  }
  const button = $("#routine-save");
  button.disabled = true;
  try {
    const result = await api("/api/routines", { method: "POST", body });
    form.elements.name.value = "";
    form.elements.prompt.value = "";
    showToast(`Rutina creada: ${result.routine.description}.`);
  } catch (problem) {
    error.textContent = problem.message;
  } finally {
    button.disabled = false;
  }
}

// ---------- ajustes ----------

function openSettings({ focusName = false } = {}) {
  renderProviders();
  const names = $("#names-form");
  names.elements.userName.value = state.settings.userName ?? "";
  const paths = $("#paths");
  paths.replaceChildren();
  for (const [label, value] of [
    ["Agentes", state.paths?.workspaces],
    ["Compartida", state.paths?.shared],
  ]) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value ?? "—";
    paths.append(dt, dd);
  }
  $("#version").textContent = `ClosedBot ${state.version} · límite de ${state.maxHops} reenvíos seguidos entre agentes.`;
  renderPermissions();
  renderSpeechSettings();
  openDialog($("#settings-dialog"));
  if (focusName) names.elements.userName.focus();
}

function renderPermissions() {
  const enabled = Boolean(state.settings.fullAccess);
  $("#full-access").checked = enabled;
  $("#full-access-warning").hidden = !enabled;
}

async function toggleFullAccess() {
  const box = $("#full-access");
  const enable = box.checked;
  if (enable) {
    const ok = await confirmAction(
      "¿Dar acceso total a todos los agentes?",
      "Podrán ejecutar comandos, instalar programas y borrar o leer cualquier archivo del equipo sin preguntarte. En este PC eso incluye permisos de administrador. Los conectores de tu cuenta de Claude siguen fuera de su alcance.",
      "Dar acceso total",
    );
    if (!ok) {
      renderPermissions();
      return;
    }
  }
  box.disabled = true;
  try {
    const result = await api("/api/settings", { method: "PATCH", body: { fullAccess: enable } });
    state.settings = result.settings;
    showToast(enable ? "Listo: todos los agentes tienen acceso total." : "Cada agente vuelve a su propio nivel de acceso.");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    box.disabled = false;
    renderPermissions();
    renderHeader();
  }
}

async function saveNames(event) {
  event.preventDefault();
  const form = $("#names-form");
  const button = $("#names-save");
  button.disabled = true;
  try {
    const result = await api("/api/settings", {
      method: "PATCH",
      body: { userName: form.elements.userName.value },
    });
    state.settings = result.settings;
    renderIdentity();
    showToast("Nombre guardado.");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

function renderProviders() {
  renderConnectCallout();
  const list = $("#provider-list");
  if (!list) return;
  // Un evento puede repintar la lista mientras se escribe el código: se conserva el foco.
  const focusKey = list.contains(document.activeElement) ? document.activeElement.dataset.focusKey : null;
  list.replaceChildren();
  for (const provider of state.providers) {
    const item = document.createElement("li");
    item.className = "provider";
    const title = document.createElement("div");
    title.className = "title";
    const name = document.createElement("span");
    name.textContent = provider.label;
    const status = document.createElement("span");
    status.className = "state";
    if (provider.install) {
      status.textContent = "Instalando…";
      status.dataset.tone = "warn";
    } else if (provider.signIn) {
      status.textContent = "Esperando al navegador…";
      status.dataset.tone = "warn";
    } else if (!provider.available) {
      status.textContent = provider.canInstall && !provider.path ? "No instalado" : "No disponible";
      status.dataset.tone = "bad";
    } else if (provider.loggedIn === false) {
      status.textContent = "Sin sesión";
      status.dataset.tone = "warn";
    } else if (provider.loggedIn === null) {
      status.textContent = "Sin comprobar";
      status.dataset.tone = "warn";
    } else {
      status.textContent = "Listo";
      status.dataset.tone = "ok";
    }
    title.append(name, status);
    const detail = document.createElement("div");
    detail.className = "detail";
    detail.textContent = provider.detail;
    // Mientras se espera al navegador o se instala, las instrucciones reemplazan al «Sin sesión…».
    if (provider.signIn || provider.install) item.append(title);
    else item.append(title, detail);
    const signIn = renderSignIn(provider);
    if (signIn) item.append(signIn);
    list.append(item);
  }
  if (focusKey) list.querySelector(`[data-focus-key="${focusKey}"]`)?.focus();
}

/**
 * Botones para instalar el proveedor o para iniciar y cerrar sesión con su cuenta (lo hace su propio
 * programa, como en OpenBot).
 */
function renderSignIn(provider) {
  const installable = Boolean(provider.canInstall) && !provider.available;
  if (!provider.canSignIn && !provider.signIn && !provider.install && !installable) return null;
  const box = document.createElement("div");
  box.className = "signin";
  const pending = provider.signIn;
  if (provider.install) {
    const text = document.createElement("p");
    text.className = "signin-text";
    text.textContent = `Instalando ${provider.label}. Puede tardar unos minutos; te aviso cuando termine.`;
    const cancel = smallButton("Cancelar", "ghost");
    cancel.addEventListener("click", () => void cancelInstall(provider.id, cancel));
    box.append(text, actionRow(cancel));
  } else if (installable && !pending) {
    const install = smallButton(`Instalar ${provider.label}`, "primary");
    install.dataset.focusKey = `install-${provider.id}`;
    install.addEventListener("click", () => void startInstall(provider, install));
    box.append(actionRow(install));
  } else if (pending) {
    const text = document.createElement("p");
    text.className = "signin-text";
    text.textContent = isThisComputer()
      ? "Abrí el navegador para que entres con tu cuenta. Cuando termines, vuelve aquí: se conecta solo."
      : "Abrí el navegador en el equipo donde corre la app: entra allí con tu cuenta, o usa el enlace de abajo.";
    box.append(text);
    if (pending.url) {
      const help = document.createElement("p");
      help.className = "signin-text muted";
      const link = document.createElement("a");
      link.href = pending.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "abre la página de inicio de sesión";
      help.append("¿No se abrió? ", link, pending.acceptsCode ? " y pega aquí el código que te muestre." : ".");
      box.append(help);
      if (pending.acceptsCode) box.append(signInCodeForm(provider));
    }
    const cancel = smallButton("Cancelar", "ghost");
    cancel.addEventListener("click", () => void cancelSignIn(provider.id, cancel));
    box.append(actionRow(cancel));
  } else if (provider.loggedIn === true) {
    // Gemini CLI no tiene cómo cerrar la sesión: no se ofrece.
    if (provider.canSignOut === false || !provider.canSignIn) return null;
    const logout = smallButton(`Cerrar sesión de ${provider.label}`, "danger-soft");
    logout.addEventListener("click", () => void signOutProvider(provider, logout));
    box.append(actionRow(logout));
  } else if (!provider.canSignIn) {
    return null;
  } else {
    const login = smallButton(signInLabel(provider), "primary");
    login.dataset.focusKey = `login-${provider.id}`;
    login.addEventListener("click", () => void startSignIn(provider.id, login));
    box.append(actionRow(login));
  }
  return box;
}

function signInCodeForm(provider) {
  const form = document.createElement("form");
  form.className = "signin-code";
  form.noValidate = true;
  const input = document.createElement("input");
  input.name = "code";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = "Pega el código";
  input.setAttribute("aria-label", "Código de inicio de sesión");
  input.dataset.focusKey = `code-${provider.id}`;
  input.value = signInCodes.get(provider.id) ?? "";
  input.addEventListener("input", () => signInCodes.set(provider.id, input.value));
  const send = smallButton("Enviar código", "ghost");
  send.type = "submit";
  form.append(input, send);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitSignInCode(provider.id, input.value, send);
  });
  return form;
}

function smallButton(label, tone) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `button ${tone} small`;
  button.textContent = label;
  return button;
}

function actionRow(...buttons) {
  const row = document.createElement("div");
  row.className = "signin-actions";
  row.append(...buttons);
  return row;
}

function signInLabel(provider) {
  if (provider.id === "codex") return "Iniciar sesión con ChatGPT";
  if (provider.id === "gemini") return "Iniciar sesión con Google";
  return `Iniciar sesión con ${provider.label}`;
}

/** Qué instala cada botón «Instalar», para contarlo antes de empezar. */
const INSTALL_NOTES = {
  codex: "Se instala Codex, el programa oficial de OpenAI (paquete @openai/codex de npm), solo para tu usuario. Después entras con tu cuenta de ChatGPT.",
  grok: "Se instala Grok con el instalador oficial de xAI (x.ai/cli), solo para tu usuario. Después entras con tu cuenta de Grok o de X.",
  gemini: "Se instala Gemini CLI, el programa oficial de Google (paquete @google/gemini-cli de npm), solo para tu usuario. Después entras con tu cuenta de Google.",
};

async function startInstall(provider, button) {
  const note = `${INSTALL_NOTES[provider.id] ?? `Se instala ${provider.label} en este equipo.`} Tarda unos minutos y necesita internet.`;
  if (!(await confirmAction(`¿Instalar ${provider.label}?`, note, "Instalar", "primary"))) return;
  button.disabled = true;
  try {
    const data = await api(`/api/providers/${encodeURIComponent(provider.id)}/install`, { method: "POST" });
    state.providers = data.providers;
    renderProviders();
  } catch (error) {
    showToast(error.message, "error");
    button.disabled = false;
  }
}

async function cancelInstall(providerId, button) {
  button.disabled = true;
  try {
    const data = await api(`/api/providers/${encodeURIComponent(providerId)}/install/cancel`, { method: "POST" });
    state.providers = data.providers;
    renderProviders();
  } catch (error) {
    showToast(error.message, "error");
    button.disabled = false;
  }
}

/** El navegador que abre el inicio de sesión es el del equipo donde corre la app. */
function isThisComputer() {
  return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(location.hostname);
}

async function startSignIn(providerId, button) {
  if (button) button.disabled = true;
  try {
    const data = await api(`/api/providers/${encodeURIComponent(providerId)}/login`, { method: "POST" });
    state.providers = data.providers;
    signInCodes.delete(providerId);
    renderProviders();
  } catch (error) {
    showToast(error.message, "error");
    if (button) button.disabled = false;
  }
}

async function submitSignInCode(providerId, code, button) {
  button.disabled = true;
  try {
    const data = await api(`/api/providers/${encodeURIComponent(providerId)}/login/code`, { method: "POST", body: { code } });
    state.providers = data.providers;
    signInCodes.delete(providerId);
    showToast("Código enviado. Terminando de conectar…");
    renderProviders();
  } catch (error) {
    showToast(error.message, "error");
    button.disabled = false;
  }
}

async function cancelSignIn(providerId, button) {
  button.disabled = true;
  try {
    const data = await api(`/api/providers/${encodeURIComponent(providerId)}/login/cancel`, { method: "POST" });
    state.providers = data.providers;
    signInCodes.delete(providerId);
    renderProviders();
  } catch (error) {
    showToast(error.message, "error");
    button.disabled = false;
  }
}

async function signOutProvider(provider, button) {
  const note =
    provider.id === "claude"
      ? "Tus agentes de Claude no podrán trabajar hasta que vuelvas a iniciar sesión. El Claude Code que uses aparte en este equipo no cambia."
      : `Tus agentes de ${provider.label} no podrán trabajar hasta que vuelvas a iniciar sesión.`;
  if (!(await confirmAction(`¿Cerrar la sesión de ${provider.label}?`, note, "Cerrar sesión"))) return;
  button.disabled = true;
  try {
    const data = await api(`/api/providers/${encodeURIComponent(provider.id)}/logout`, { method: "POST" });
    state.providers = data.providers;
    state.models.delete(provider.id);
    renderProviders();
    showToast(`Cerraste la sesión de ${provider.label}.`);
  } catch (error) {
    showToast(error.message, "error");
    button.disabled = false;
  }
}

/** En la pantalla de inicio: invita a conectar Claude mientras ningún proveedor con IA esté listo. */
function renderConnectCallout() {
  const box = $("#connect-callout");
  if (!box) return;
  const claude = state.providers.find((provider) => provider.id === "claude");
  const ready = state.providers.some((provider) => provider.id !== "demo" && provider.available && provider.loggedIn === true);
  box.hidden = !claude?.canSignIn || ready || claude.loggedIn !== false;
  if (box.hidden) return;
  const waiting = Boolean(claude.signIn);
  $("#connect-text").textContent = waiting
    ? "Esperando que entres con tu cuenta de Claude en el navegador…"
    : "Para que tus agentes usen IA, conecta tu cuenta de Claude. Se abre el navegador y entras con tu cuenta, sin claves.";
  $("#connect-claude").textContent = waiting ? "Ver el inicio de sesión" : "Iniciar sesión con Claude";
}

async function connectClaude() {
  const claude = state.providers.find((provider) => provider.id === "claude");
  openSettings();
  if (!claude?.signIn) await startSignIn("claude", null);
}

async function refreshProviders() {
  const button = $("#refresh-providers");
  button.disabled = true;
  try {
    const data = await api("/api/providers/refresh", { method: "POST" });
    state.providers = data.providers;
    state.models.clear();
    renderProviders();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

// ---------- ficha del agente: Detalles, Biblioteca y Computadora ----------

const DEFAULT_VOICE = { name: "", rate: 1, lang: "auto", autoRead: false };
const VOICE_LANGS = [
  ["auto", "Automático (según el texto)"],
  ["es-CL", "Español (Chile)"],
  ["es-ES", "Español (España)"],
  ["es-MX", "Español (México)"],
  ["es-AR", "Español (Argentina)"],
  ["es-US", "Español (EE. UU.)"],
  ["en-US", "Inglés (EE. UU.)"],
  ["en-GB", "Inglés (Reino Unido)"],
  ["pt-BR", "Portugués (Brasil)"],
  ["fr-FR", "Francés"],
  ["de-DE", "Alemán"],
  ["it-IT", "Italiano"],
];
const details = { agentId: null, tab: "info", root: "agent", path: "", library: null, loading: false, request: 0, uploading: false };

function openDetails(agentId = state.currentId, tab = "info") {
  closeContextMenu();
  const agent = findAgent(agentId);
  if (!agent) return;
  if (details.agentId !== agent.id) {
    details.root = "agent";
    details.path = "";
    details.library = null;
  }
  details.agentId = agent.id;
  selectTab(tab);
  renderDetails();
  openDialog($("#details-dialog"));
}

function renderDetailsIfOpen() {
  if ($("#details-dialog").open) renderDetails();
}

function renderDetails() {
  const agent = findAgent(details.agentId);
  if (!agent) {
    closeDialog($("#details-dialog"));
    return;
  }
  const avatar = $("#details-avatar");
  const key = `${agent.id}:${agent.avatar}:${agent.main}`;
  if (avatar.dataset.key !== key) {
    avatar.replaceChildren(blobAvatar(agent));
    avatar.dataset.key = key;
  }
  avatar.disabled = Boolean(agent.main);
  avatar.title = agent.main ? agent.name : "Cambiar figura y color";
  $("#details-name").textContent = agent.name;
  const parts = [agent.role || (agent.main ? "Bot principal" : "Asistente general"), providerLabel(agent.provider)];
  if (agent.model) parts.push(agent.model);
  if (agent.project) parts.push(agent.project);
  $("#details-meta").textContent = parts.filter(Boolean).join(" · ");
  if (details.tab === "info") renderDetailsInfo(agent);
  else if (details.tab === "library") renderLibrary(agent);
  else renderComputer(agent);
}

function selectTab(tab, { focus = false } = {}) {
  details.tab = tab;
  for (const button of document.querySelectorAll("#details-dialog [role='tab']")) {
    const selected = button.dataset.tab === tab;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    if (selected && focus) button.focus();
  }
  $("#panel-info").hidden = tab !== "info";
  $("#panel-library").hidden = tab !== "library";
  $("#panel-computer").hidden = tab !== "computer";
}

function onTabKeydown(event) {
  const tabs = [...document.querySelectorAll("#details-dialog [role='tab']")];
  const index = tabs.indexOf(event.target);
  if (index < 0) return;
  const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
  let next = step === undefined ? null : (index + step + tabs.length) % tabs.length;
  if (event.key === "Home") next = 0;
  if (event.key === "End") next = tabs.length - 1;
  if (next === null) return;
  event.preventDefault();
  showTab(tabs[next].dataset.tab, { focus: true });
}

function showTab(tab, { focus = false } = {}) {
  // La biblioteca se vuelve a leer cada vez que se abre: los agentes crean archivos todo el tiempo.
  if (tab === "library") details.library = null;
  selectTab(tab, { focus });
  renderDetails();
}

function renderDetailsInfo(agent) {
  const routines = state.routines.filter((routine) => routine.agentId === agent.id);
  $("#details-routines").replaceChildren(...routines.map(miniRoutine));
  $("#details-routines-empty").hidden = routines.length > 0;
  renderVoiceSettings(agent);
  const instructions = agent.instructions?.trim();
  $("#details-role").textContent = instructions
    ? instructions.length > 240
      ? `${instructions.slice(0, 240).trimEnd()}…`
      : instructions
    : agent.main
      ? "Arma y coordina tus equipos de agentes."
      : "Sin instrucciones permanentes: hace lo que le pidas en el chat.";
  $("#details-edit").textContent = agent.main ? "Preferencias y modelo" : "Instrucciones y modelo";
  $("#details-pause").textContent = agent.paused ? "Reanudar la cola" : "Pausar la cola";
  $("#details-delete").hidden = Boolean(agent.main);
}

function miniRoutine(routine) {
  const item = document.createElement("li");
  item.className = "mini-routine";
  item.dataset.enabled = String(routine.enabled);
  const open = document.createElement("button");
  open.type = "button";
  open.className = "mini-routine-open";
  open.title = "Ver y editar en Rutinas";
  const name = document.createElement("span");
  name.className = "mini-routine-name";
  name.textContent = routine.name;
  const meta = document.createElement("span");
  meta.className = "mini-routine-meta";
  const when = routine.running
    ? "en curso…"
    : routine.enabled
      ? routine.nextRunAt
        ? `próxima: ${formatWhen(routine.nextRunAt)}`
        : "sin próxima ejecución"
      : "en pausa";
  meta.textContent = [routine.description, when].filter(Boolean).join(" · ");
  open.append(icon("clock"), name, meta);
  open.addEventListener("click", () => openRoutines(routine.agentId));
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "switch";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-checked", String(routine.enabled));
  toggle.setAttribute("aria-label", routine.enabled ? `Pausar «${routine.name}»` : `Activar «${routine.name}»`);
  toggle.title = routine.enabled ? "Activa" : "En pausa";
  toggle.addEventListener("click", () => void routineRequest(`/api/routines/${encodeURIComponent(routine.id)}`, "PATCH", { enabled: !routine.enabled }));
  item.append(open, toggle);
  return item;
}

function renderVoiceSettings(agent) {
  const voice = { ...DEFAULT_VOICE, ...(agent.voice ?? {}) };
  $("#voice-unsupported").hidden = Boolean(Synth);
  const lang = voice.lang === "auto" ? speechLanguage() : voice.lang;
  const select = $("#voice-name");
  const key = `${agent.id}|${voices.length}|${lang}|${voice.name}`;
  if (select.dataset.key !== key && document.activeElement !== select) {
    const base = lang.split("-")[0].toLowerCase();
    const list = sortVoices(
      voices.filter((item) => normalizeLang(item.lang).split("-")[0] === base),
      lang,
    );
    if (voice.name && !list.some((item) => item.name === voice.name)) {
      list.unshift(voices.find((item) => item.name === voice.name) ?? { name: voice.name, lang: "" });
    }
    const options = [new Option(Synth ? "Automática (la mejor para el idioma)" : "No disponible en este navegador", "")];
    for (const item of list) options.push(new Option(voiceLabel(item), item.name));
    select.replaceChildren(...options);
    select.value = voice.name;
    select.dataset.key = key;
  }
  select.disabled = !Synth;
  const rate = $("#voice-rate");
  if (document.activeElement !== rate) rate.value = String(voice.rate);
  $("#voice-rate-value").textContent = formatRate(Number(rate.value));
  const langSelect = $("#voice-lang");
  const langKey = `${agent.id}|${voice.lang}`;
  if (langSelect.dataset.key !== langKey && document.activeElement !== langSelect) {
    const entries = VOICE_LANGS.some(([value]) => value === voice.lang) ? VOICE_LANGS : [...VOICE_LANGS, [voice.lang, voice.lang]];
    langSelect.replaceChildren(...entries.map(([value, label]) => new Option(label, value)));
    langSelect.value = voice.lang;
    langSelect.dataset.key = langKey;
  }
  const auto = $("#voice-auto");
  auto.setAttribute("aria-checked", String(voice.autoRead));
  auto.disabled = !Synth;
  $("#voice-test").disabled = !Synth;
}

function formatRate(value) {
  return `${(Number.isFinite(value) ? value : 1).toLocaleString("es", { minimumFractionDigits: 1, maximumFractionDigits: 2 })}×`;
}

function voiceLabel(voice) {
  const name = String(voice.name)
    .replace(/^Microsoft\s+/i, "")
    .replace(/^Google\s+/i, "Google ")
    .replace(/\s+-\s+[^-]+$/, "");
  return voice.lang ? `${name} · ${voice.lang}` : name;
}

/** Cambia el chat de voz del agente: se ve enseguida y el servidor lo guarda. */
async function saveVoice(patch) {
  const agent = findAgent(details.agentId);
  if (!agent) return;
  agent.voice = { ...DEFAULT_VOICE, ...(agent.voice ?? {}), ...patch };
  renderDetailsIfOpen();
  await patchAgent(agent.id, { voice: patch });
}

function onVoiceLangChange(value) {
  const agent = findAgent(details.agentId);
  const current = agent?.voice?.name ? voices.find((item) => item.name === agent.voice.name) : null;
  const target = value === "auto" ? speechLanguage() : value;
  // Una voz elegida para otro idioma ya no sirve: se vuelve a la automática.
  const keepVoice = current && normalizeLang(current.lang).split("-")[0] === target.split("-")[0].toLowerCase();
  void saveVoice(keepVoice ? { lang: value } : { lang: value, name: "" });
}

function testVoice() {
  const agent = findAgent(details.agentId);
  if (!agent || !Synth) return;
  primeSpeech();
  if (speech.current?.messageId === "voice-test") {
    stopSpeaking();
    return;
  }
  const lang = agent.voice?.lang && agent.voice.lang !== "auto" ? agent.voice.lang : speechLanguage();
  const sample = lang.startsWith("en")
    ? `Hi, I'm ${agent.name}. This is how I sound when I read my answers.`
    : lang.startsWith("pt")
      ? `Olá, sou ${agent.name}. É assim que eu falo quando leio as minhas respostas.`
      : lang.startsWith("fr")
        ? `Bonjour, je suis ${agent.name}. Voici ma voix quand je lis mes réponses.`
        : lang.startsWith("de")
          ? `Hallo, ich bin ${agent.name}. So klinge ich, wenn ich meine Antworten vorlese.`
          : lang.startsWith("it")
            ? `Ciao, sono ${agent.name}. Questa è la mia voce quando leggo le risposte.`
            : `Hola, soy ${agent.name}. Así sueno cuando leo mis respuestas.`;
  speak(sample, agent, { messageId: "voice-test" });
}

// Biblioteca: archivos de su carpeta o de la compartida.

function libraryUrl(agentId, root, path, file = false) {
  const base = `/api/agents/${encodeURIComponent(agentId)}/library${file ? "/file" : ""}`;
  return `${base}?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`;
}

function renderLibrary(agent) {
  const data = details.library;
  if (!details.loading && (!data || data.agentId !== agent.id || data.root !== details.root || data.path !== details.path)) {
    void loadLibrary(agent.id, details.root, details.path);
    return;
  }
  renderLibraryView();
}

async function loadLibrary(agentId, root, path) {
  const request = ++details.request;
  details.loading = true;
  details.root = root;
  details.path = path;
  renderLibraryView();
  let data;
  try {
    data = { ...(await api(libraryUrl(agentId, root, path))), agentId };
  } catch (error) {
    if (request !== details.request) return;
    if (error.status === 404 && path) {
      // La carpeta ya no existe: se vuelve a la raíz.
      details.loading = false;
      void loadLibrary(agentId, root, "");
      return;
    }
    data = { agentId, root, path, entries: [], truncated: false, error: error.message };
  }
  if (request !== details.request) return;
  details.library = data;
  details.loading = false;
  renderLibraryView();
}

function renderLibraryView() {
  const agent = findAgent(details.agentId);
  if (!agent || details.tab !== "library") return;
  for (const radio of document.querySelectorAll('input[name="library-root"]')) radio.checked = radio.value === details.root;
  const upload = $("#library-upload");
  upload.hidden = details.root !== "agent";
  upload.disabled = details.uploading;
  upload.textContent = details.uploading ? "Subiendo…" : "Subir archivo";
  const crumbs = $("#library-crumbs");
  const parts = details.path ? details.path.split("/") : [];
  const nodes = [crumbButton(details.root === "shared" ? "Compartida" : "Su carpeta", "", parts.length === 0)];
  parts.forEach((part, index) => {
    const separator = document.createElement("span");
    separator.className = "crumb-sep";
    separator.textContent = "›";
    separator.setAttribute("aria-hidden", "true");
    nodes.push(separator, crumbButton(part, parts.slice(0, index + 1).join("/"), index === parts.length - 1));
  });
  crumbs.replaceChildren(...nodes);
  const list = $("#library-list");
  const note = $("#library-note");
  const data = details.library;
  const fresh = data && data.agentId === agent.id && data.root === details.root && data.path === details.path;
  if (!fresh) {
    list.replaceChildren();
    note.hidden = false;
    note.textContent = "Cargando…";
    return;
  }
  list.replaceChildren(...data.entries.map((entry) => libraryItem(agent, entry)));
  note.hidden = false;
  if (data.error) note.textContent = data.error;
  else if (!data.entries.length)
    note.textContent = details.path
      ? "Esta carpeta está vacía."
      : details.root === "shared"
        ? "La carpeta compartida está vacía. Lo que dejen ahí tus agentes aparecerá aquí."
        : "Todavía no hay archivos. Lo que cree en su carpeta aparecerá aquí.";
  else if (data.truncated) note.textContent = `Se muestran los primeros ${data.entries.length} elementos.`;
  else note.hidden = true;
}

function crumbButton(label, path, current) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "crumb";
  button.textContent = label;
  if (current) button.setAttribute("aria-current", "location");
  // El de la carpeta actual vuelve a leerla.
  button.addEventListener("click", () => void loadLibrary(details.agentId, details.root, path));
  return button;
}

function libraryItem(agent, entry) {
  const item = document.createElement("li");
  item.className = "library-item";
  const main = document.createElement(entry.dir ? "button" : "a");
  main.className = "library-open";
  if (entry.dir) {
    main.type = "button";
    main.addEventListener("click", () => void loadLibrary(agent.id, details.root, entry.path));
  } else {
    main.href = libraryUrl(agent.id, details.root, entry.path, true);
    main.target = "_blank";
    main.rel = "noopener";
  }
  const name = document.createElement("span");
  name.className = "library-name";
  name.textContent = entry.name;
  const meta = document.createElement("span");
  meta.className = "library-meta";
  meta.textContent = entry.dir ? "Carpeta" : `${formatSize(entry.size)} · ${formatTime(entry.modifiedAt)}`;
  main.title = entry.dir ? `Abrir la carpeta «${entry.name}»` : `Abrir «${entry.name}»`;
  main.append(icon(entry.dir ? "folder" : "file"), name, meta);
  item.append(main);
  if (!entry.dir) {
    const download = document.createElement("a");
    download.className = "library-download";
    download.href = `${libraryUrl(agent.id, details.root, entry.path, true)}&download=1`;
    download.setAttribute("download", entry.name);
    download.title = `Descargar «${entry.name}»`;
    download.setAttribute("aria-label", download.title);
    download.append(icon("download"));
    item.append(download);
  }
  return item;
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes || 0} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toLocaleString("es", { maximumFractionDigits: value < 10 ? 1 : 0 })} ${units[unit]}`;
}

async function uploadToLibrary(files) {
  const agentId = details.agentId;
  if (!agentId || !files.length) return;
  details.uploading = true;
  renderLibraryView();
  let saved = 0;
  for (const file of files) {
    if (file.size > MAX_UPLOAD_BYTES) {
      showToast(`«${file.name}» supera los 25 MB.`, "error");
      continue;
    }
    if (file.size === 0) {
      showToast(`«${file.name}» está vacío.`, "error");
      continue;
    }
    try {
      await uploadFile(agentId, file);
      saved += 1;
    } catch (error) {
      if (error.status !== 401) showToast(`No se pudo subir «${file.name}»: ${error.message}`, "error");
    }
  }
  details.uploading = false;
  if (saved) showToast(saved === 1 ? "Archivo guardado en «adjuntos»." : `${saved} archivos guardados en «adjuntos».`);
  if (details.agentId === agentId) await loadLibrary(agentId, "agent", saved ? "adjuntos" : details.path);
}

// Computadora: dónde trabaja y con qué acceso.

function renderComputer(agent) {
  $("#computer-workspace").textContent = agent.workspace || "—";
  $("#computer-shared").textContent = state.paths?.shared ?? "—";
  const local = isThisComputer();
  for (const button of document.querySelectorAll("#panel-computer [data-local-only]")) button.hidden = !local;
  $("#computer-remote").hidden = local;
  const full = Boolean(state.settings.fullAccess);
  let text = full
    ? "Acceso total para todos (lo activaste en Ajustes): ejecuta comandos y usa todo el equipo sin pedir permiso."
    : agent.access === "total"
      ? "Acceso total: ejecuta comandos y usa todo el equipo sin pedir permiso."
      : "Solo su carpeta: escribe en su carpeta y en la compartida, con sandbox.";
  if (!full && agent.access !== "total" && state.platform === "win32" && agent.provider === "claude") {
    text += " En Windows, así no tiene terminal: trabaja con archivos, la web y sus compañeros.";
  }
  $("#computer-access").textContent = `${text} Los conectores de tu cuenta de Claude (servidores, bancos, brókeres) siguen fuera de su alcance.`;
  $("#computer-change").textContent = full ? "Abrir Ajustes" : "Cambiar el acceso";
}

async function openFolder(root) {
  const agentId = details.agentId;
  if (!agentId) return;
  try {
    await api(`/api/agents/${encodeURIComponent(agentId)}/open-folder`, { method: "POST", body: { root } });
    showToast("Abrí la carpeta en el explorador.");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast("Ruta copiada.");
  } catch {
    showToast("No se pudo copiar: selecciona la ruta y cópiala a mano.", "error");
  }
}

// ---------- lectura en voz alta ----------

let voices = [];
/** Lo que se está leyendo: el mensaje, cuántos trozos faltan y un número que invalida lo que se canceló. */
const speech = { current: null, pending: 0, token: 0, primed: false };
/** Respuestas a lo que dijiste con el botón de voz: se leen aunque «Leer sus respuestas» esté apagado. */
let voiceReply = null;

const LANGUAGE_WORDS = {
  es: "el la los las del al es son pero muy también cuando hola gracias y lo su sus hay una un con por en qué cómo más esto eso puedo quieres tienes".split(" "),
  en: "the and is are you that this with for have was not but what can will your from about hello thanks it of to in on we they be if or an".split(" "),
  pt: "o os um uma com em mais muito também quando olá obrigado obrigada e é são mas seu sua há não você isso então já do da dos das na ao".split(" "),
};
const LANGUAGE_SETS = Object.fromEntries(Object.entries(LANGUAGE_WORDS).map(([lang, words]) => [lang, new Set(words)]));

function loadVoices() {
  if (!Synth) return;
  try {
    voices = Synth.getVoices() ?? [];
  } catch {
    voices = [];
  }
  renderDetailsIfOpen();
}

function normalizeLang(value) {
  return String(value || "")
    .replace(/_/g, "-")
    .toLowerCase();
}

/** Idioma de un texto, por sus palabras más comunes. Ante la duda, el español del navegador. */
function detectLanguage(text) {
  const words = text.slice(0, 3000).toLowerCase().split(/[^\p{L}]+/u);
  let best = "es";
  let bestScore = 0;
  for (const [lang, set] of Object.entries(LANGUAGE_SETS)) {
    let score = 0;
    for (const word of words) if (set.has(word)) score += 1;
    if (score > bestScore) {
      best = lang;
      bestScore = score;
    }
  }
  return best === "en" ? "en-US" : best === "pt" ? "pt-BR" : speechLanguage();
}

function voiceScore(voice, lang) {
  const wanted = lang.toLowerCase();
  const own = normalizeLang(voice.lang);
  let score = 0;
  if (own === wanted) score += 8;
  // Sin voz de Chile, mejor una latinoamericana que una de España.
  else if (wanted.startsWith("es-") && wanted !== "es-es" && own !== "es-es") score += 2;
  if (/natural|neural|online|premium|enhanced|mejorada/i.test(voice.name)) score += 4;
  if (voice.default) score += 1;
  return score;
}

function sortVoices(list, lang) {
  return [...list].sort((a, b) => voiceScore(b, lang) - voiceScore(a, lang) || String(a.name).localeCompare(String(b.name)));
}

function pickVoice(name, lang) {
  if (!voices.length) loadVoices();
  if (name) {
    const chosen = voices.find((voice) => voice.name === name);
    if (chosen) return chosen;
  }
  const base = lang.toLowerCase().split("-")[0];
  return sortVoices(
    voices.filter((voice) => normalizeLang(voice.lang).split("-")[0] === base),
    lang,
  )[0] ?? null;
}

/** El texto de un mensaje tal como se lee: sin código, enlaces ni marcas de Markdown. */
function speakableText(text) {
  return String(text)
    .replace(/```[\s\S]*?(?:```|$)/g, "\n")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/!?\[([^\]\n]+)\]\((?:https?:\/\/|\/)[^\s)]+\)/g, "$1")
    .replace(/https?:\/\/[^\s<>"')\]]+/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/(^|[^\p{L}\d])[*_]([^*_\n]+)[*_](?=[^\p{L}\d]|$)/gu, "$1$2")
    .replace(/\|/g, " ")
    .replace(/\p{Extended_Pictographic}️?/gu, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** Trozos cortos (por frases): los navegadores cortan las lecturas muy largas. */
function chunkText(text, max = 220) {
  const pieces = text.match(/[^]*?(?:[.!?…;:]+(?=\s|$)|\n+|$)/gu) ?? [];
  const chunks = [];
  let current = "";
  for (const piece of pieces) {
    let clean = piece.replace(/\s+/g, " ").trim();
    if (!clean) continue;
    // Un título o un punto de una lista termina en un salto de línea: se le da la pausa de un punto.
    if (/\n\s*$/.test(piece) && !/[.!?…;:,]$/.test(clean)) clean += ".";
    if (current && current.length + clean.length + 1 > max) {
      chunks.push(current);
      current = "";
    }
    if (clean.length <= max) {
      current = current ? `${current} ${clean}` : clean;
      continue;
    }
    for (const word of clean.split(" ")) {
      if (current && current.length + word.length + 1 > max) {
        chunks.push(current);
        current = "";
      }
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Algunos navegadores (Safari) solo dejan hablar después de un toque: se «despierta» la voz con el primero. */
function primeSpeech() {
  if (!Synth || speech.primed) return;
  speech.primed = true;
  try {
    const utterance = new SpeechSynthesisUtterance(" ");
    utterance.volume = 0;
    Synth.speak(utterance);
  } catch {
    // Sin voz: no pasa nada.
  }
}

function stopSpeaking() {
  if (!Synth) return;
  const active = speech.current !== null || speech.pending > 0 || Synth.speaking || Synth.pending;
  speech.token += 1;
  speech.pending = 0;
  speech.current = null;
  if (active) Synth.cancel();
  updateSpeakButtons();
}

/** Lee un texto con la voz del agente. Con `queue`, espera a que termine lo que se está leyendo. */
function speak(text, agent, { messageId = null, queue = false } = {}) {
  if (!Synth) return false;
  const clean = speakableText(text);
  if (!clean) return false;
  const busy = speech.pending > 0 || Synth.speaking || Synth.pending;
  if (!queue && busy) stopSpeaking();
  const token = speech.token;
  const settings = { ...DEFAULT_VOICE, ...(agent?.voice ?? {}) };
  const lang = settings.lang !== "auto" ? settings.lang : detectLanguage(clean);
  const voice = pickVoice(settings.name, lang);
  const job = { messageId, agentId: agent?.id ?? null };
  const utterances = chunkText(clean).map((chunk) => {
    const utterance = new SpeechSynthesisUtterance(chunk);
    utterance.lang = voice?.lang || lang;
    if (voice) utterance.voice = voice;
    utterance.rate = settings.rate;
    utterance.onstart = () => {
      if (token !== speech.token) return;
      speech.current = job;
      updateSpeakButtons();
    };
    const done = () => {
      if (token !== speech.token) return;
      speech.pending = Math.max(0, speech.pending - 1);
      if (speech.pending === 0) {
        speech.current = null;
        updateSpeakButtons();
      }
    };
    utterance.onend = done;
    utterance.onerror = done;
    return utterance;
  });
  if (!utterances.length) return false;
  speech.pending += utterances.length;
  speech.current ??= job;
  updateSpeakButtons();
  const start = () => {
    if (token !== speech.token) return;
    for (const utterance of utterances) Synth.speak(utterance);
  };
  // Chrome y Edge a veces no hablan si se pide justo después de cancelar.
  if (!queue && busy) setTimeout(start, 80);
  else start();
  return true;
}

function updateSpeakButtons() {
  for (const button of document.querySelectorAll(".speak-button")) {
    const active = speech.current?.messageId === button.dataset.id;
    if (button.getAttribute("aria-pressed") !== String(active)) setSpeakButton(button, active);
  }
  const test = $("#voice-test");
  if (test) test.textContent = speech.current?.messageId === "voice-test" ? "Detener" : "Probar voz";
}

function toggleSpeakMessage(agentId, messageId) {
  primeSpeech();
  if (speech.current?.messageId === messageId) {
    stopSpeaking();
    return;
  }
  const message = (state.messages.get(agentId) ?? []).find((item) => item.id === messageId);
  if (!message || !speak(message.text, findAgent(agentId), { messageId })) showToast("No hay nada que leer en ese mensaje.");
}

/** Lee sola una respuesta recién terminada si el agente lo tiene activado o si le hablaste con el botón de voz. */
function maybeAutoRead(agentId, message) {
  if (!Synth || agentId !== state.currentId || document.hidden || dictation || !message.text?.trim()) return;
  const agent = findAgent(agentId);
  if (!agent) return;
  const replying =
    voiceReply?.agentId === agentId &&
    Date.now() - voiceReply.startedAt < 15 * 60_000 &&
    (!voiceReply.until || Date.now() < voiceReply.until);
  if (!agent.voice?.autoRead && !replying) return;
  speak(message.text, agent, { messageId: message.id, queue: true });
}

/** Cuando el agente termina el turno que empezó tu mensaje de voz, se dejan de leer sus respuestas. */
function noteVoiceTurn() {
  if (!voiceReply) return;
  const agent = findAgent(voiceReply.agentId);
  if (!agent || Date.now() - voiceReply.startedAt > 15 * 60_000) {
    voiceReply = null;
    return;
  }
  if (agent.state === "working") {
    voiceReply.sawWorking = true;
    voiceReply.until = null;
  } else if (voiceReply.sawWorking && !voiceReply.until && agent.state !== "queued") {
    voiceReply.until = Date.now() + 4_000;
  }
}

// ---------- uso del plan ----------

let usageTicker = null;

function usageEntries() {
  return state.usage.filter((entry) => entry.windows?.length || entry.error);
}

function renderUsage() {
  const button = $("#usage-button");
  const entries = usageEntries();
  button.hidden = entries.length === 0;
  if (!entries.length) {
    closeUsage();
    return;
  }
  const primary = entries.find((entry) => entry.provider === "claude" && entry.windows.length) ?? entries.find((entry) => entry.windows.length) ?? null;
  const window = primary?.windows[0] ?? null;
  const percent = window ? window.percent : null;
  $("#usage-ring-value").setAttribute("stroke-dasharray", `${percent ?? 0} 100`);
  button.dataset.level = percent === null ? "unknown" : percent >= 90 ? "high" : percent >= 75 ? "mid" : "low";
  $("#usage-number").textContent = percent === null ? "!" : String(percent);
  const label = window
    ? `Uso de ${primary.label}: ${percent}% (${window.label.toLowerCase()})${window.resetsAt ? `, se reinicia en ${formatCountdown(window.resetsAt - Date.now())}` : ""}`
    : "Uso del plan: no se pudo leer";
  button.title = label;
  button.setAttribute("aria-label", label);
  if (!$("#usage-popover").hidden) renderUsagePopover();
}

function renderUsagePopover() {
  const list = $("#usage-list");
  list.replaceChildren();
  for (const entry of usageEntries()) {
    const block = document.createElement("div");
    block.className = "usage-provider";
    const title = document.createElement("div");
    title.className = "usage-provider-title";
    title.textContent = entry.plan ? `${entry.label} · ${planLabel(entry.plan)}` : entry.label;
    block.append(title);
    for (const window of entry.windows) {
      const row = document.createElement("div");
      row.className = "usage-window";
      const top = document.createElement("div");
      top.className = "usage-row";
      const name = document.createElement("span");
      name.textContent = window.label;
      const value = document.createElement("strong");
      value.textContent = `${window.percent}%`;
      top.append(name, value);
      const bar = document.createElement("div");
      bar.className = "usage-bar";
      bar.dataset.level = window.percent >= 90 ? "high" : window.percent >= 75 ? "mid" : "low";
      const fill = document.createElement("span");
      fill.style.width = `${window.percent}%`;
      bar.append(fill);
      row.append(top, bar);
      if (window.resetsAt) {
        const reset = document.createElement("div");
        reset.className = "usage-reset";
        reset.textContent = `Se reinicia en ${formatCountdown(window.resetsAt - Date.now())}`;
        row.append(reset);
      }
      block.append(row);
    }
    if (entry.error) {
      const problem = document.createElement("p");
      problem.className = "usage-error";
      problem.textContent = entry.error;
      block.append(problem);
    }
    list.append(block);
  }
  const updated = Math.max(0, ...state.usage.map((entry) => entry.updatedAt || 0));
  $("#usage-foot").textContent = `${updated ? `Actualizado ${formatAgo(updated)}. ` : ""}Es el uso de toda tu cuenta, también fuera de ClosedBot.`;
}

function planLabel(plan) {
  const known = { max: "Max", pro: "Pro", team: "Team", enterprise: "Enterprise", free: "Gratis", plus: "Plus" };
  const value = String(plan);
  return known[value.toLowerCase()] ?? value.replace(/_/g, " ").replace(/^\p{L}/u, (letter) => letter.toUpperCase());
}

function formatCountdown(ms) {
  if (!Number.isFinite(ms) || ms < 60_000) return "menos de 1 min";
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return hours ? `${days} d ${hours} h` : `${days} d`;
  if (hours > 0) return rest ? `${hours} h ${rest} min` : `${hours} h`;
  return `${rest} min`;
}

function formatAgo(timestamp) {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return "recién";
  if (diff < 3_600_000) return `hace ${Math.floor(diff / 60_000)} min`;
  if (diff < 86_400_000) return `hace ${Math.floor(diff / 3_600_000)} h`;
  return formatTime(timestamp);
}

function toggleUsage() {
  if ($("#usage-popover").hidden) openUsage();
  else closeUsage();
}

function openUsage() {
  closeContextMenu();
  const popover = $("#usage-popover");
  popover.hidden = false;
  $("#usage-button").setAttribute("aria-expanded", "true");
  renderUsagePopover();
  clearInterval(usageTicker);
  usageTicker = setInterval(renderUsagePopover, 30_000);
  void refreshUsage();
}

function closeUsage() {
  const popover = $("#usage-popover");
  if (popover.hidden) return;
  popover.hidden = true;
  $("#usage-button").setAttribute("aria-expanded", "false");
  clearInterval(usageTicker);
  usageTicker = null;
}

async function refreshUsage() {
  const button = $("#usage-refresh");
  button.classList.add("spinning");
  button.disabled = true;
  try {
    const result = await api("/api/usage/refresh", { method: "POST" });
    state.usage = result.usage ?? [];
    renderUsage();
  } catch (error) {
    if (error.status !== 401) showToast(error.message, "error");
  } finally {
    button.classList.remove("spinning");
    button.disabled = false;
  }
}

// ---------- utilidades de interfaz ----------

function openDialog(dialog) {
  if (!dialog.open) dialog.showModal();
}

function closeDialog(dialog) {
  if (dialog.open) dialog.close();
}

function confirmAction(title, text, okLabel, tone = "danger") {
  const dialog = $("#confirm-dialog");
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  $("#confirm-ok").textContent = okLabel;
  $("#confirm-ok").className = `button ${tone}`;
  dialog.returnValue = "";
  openDialog(dialog);
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true });
  });
}

function showToast(message, tone = "info") {
  const toast = $("#toast");
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(
    () => {
      toast.hidden = true;
    },
    tone === "error" ? 6_000 : 3_500,
  );
}

function bindUi() {
  $("#login-form").addEventListener("submit", login);
  $("#new-agent").addEventListener("click", () => openCreateDialog());
  $("#empty-talk").addEventListener("click", openMainAgent);
  $("#bot-card").addEventListener("click", openMainAgent);
  $("#search-toggle").addEventListener("click", () => toggleSearch());
  $("#search-input").addEventListener("input", (event) => {
    state.search = event.target.value;
    renderSidebar();
  });
  $("#search-input").addEventListener("keydown", (event) => {
    if (event.key === "Escape") toggleSearch(false);
  });
  $("#open-settings").addEventListener("click", () => openSettings());
  $("#open-profile").addEventListener("click", () => openSettings({ focusName: true }));
  $("#open-routines").addEventListener("click", () => openRoutines());
  $("#settings-close").addEventListener("click", () => closeDialog($("#settings-dialog")));
  $("#names-form").addEventListener("submit", saveNames);
  $("#refresh-providers").addEventListener("click", refreshProviders);
  $("#full-access").addEventListener("change", () => void toggleFullAccess());
  $("#connect-claude").addEventListener("click", () => void connectClaude());
  $("#logout").addEventListener("click", logout);
  $("#back").addEventListener("click", goBack);
  $("#details-button").addEventListener("click", () => openDetails(state.currentId));

  // Menús contextuales: se cierran al tocar fuera, al cambiar el tamaño o al desplazar la lista.
  bindSidebarMenus();
  for (const menu of [$("#context-menu"), $("#context-submenu")]) menu.addEventListener("keydown", onMenuKeydown);
  document.addEventListener(
    "pointerdown",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (menuState && !target?.closest("#context-menu, #context-submenu")) closeContextMenu();
      if (!$("#usage-popover").hidden && !target?.closest("#usage-popover, #usage-button")) closeUsage();
      primeSpeech();
    },
    true,
  );
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!$("#usage-popover").hidden) {
      closeUsage();
      $("#usage-button").focus();
    }
  });
  window.addEventListener("resize", () => closeContextMenu());
  window.addEventListener("blur", () => closeContextMenu());
  document.addEventListener(
    "scroll",
    (event) => {
      if (menuState && !(event.target instanceof Element && event.target.closest("#context-menu, #context-submenu"))) closeContextMenu();
    },
    true,
  );

  // Crear agente (figura, color y nombre) y cuadro de nombre.
  $("#create-form").addEventListener("submit", saveCreate);
  $("#create-cancel").addEventListener("click", () => closeDialog($("#create-dialog")));
  $("#shape-grid").addEventListener("keydown", (event) => onPickerKeydown(event, "shape"));
  $("#color-row").addEventListener("keydown", (event) => onPickerKeydown(event, "color"));

  // Ficha del agente.
  const detailsDialog = $("#details-dialog");
  $("#details-close").addEventListener("click", () => closeDialog(detailsDialog));
  detailsDialog.addEventListener("click", (event) => {
    // Clic en el fondo oscuro (fuera del panel): se cierra.
    if (event.target === detailsDialog) closeDialog(detailsDialog);
  });
  detailsDialog.addEventListener("close", () => {
    if (speech.current?.messageId === "voice-test") stopSpeaking();
  });
  $("#details-avatar").addEventListener("click", () => openCreateDialog({ agentId: details.agentId }));
  for (const tab of document.querySelectorAll("#details-dialog [role='tab']")) {
    tab.addEventListener("click", () => showTab(tab.dataset.tab));
    tab.addEventListener("keydown", onTabKeydown);
  }
  $("#details-new-routine").addEventListener("click", () => openRoutines(details.agentId));
  $("#details-edit").addEventListener("click", () => void agentAction("edit", details.agentId));
  $("#details-pause").addEventListener("click", () => void agentAction("pause", details.agentId));
  $("#details-reset").addEventListener("click", () => void agentAction("reset", details.agentId));
  $("#details-delete").addEventListener("click", () => void agentAction("delete", details.agentId));
  $("#voice-name").addEventListener("change", (event) => void saveVoice({ name: event.target.value }));
  $("#voice-rate").addEventListener("input", (event) => {
    $("#voice-rate-value").textContent = formatRate(Number(event.target.value));
  });
  $("#voice-rate").addEventListener("change", (event) => void saveVoice({ rate: Number(event.target.value) }));
  $("#voice-lang").addEventListener("change", (event) => onVoiceLangChange(event.target.value));
  $("#voice-auto").addEventListener("click", () => {
    primeSpeech();
    const agent = findAgent(details.agentId);
    if (agent) void saveVoice({ autoRead: !agent.voice?.autoRead });
  });
  $("#voice-test").addEventListener("click", testVoice);
  for (const radio of document.querySelectorAll('input[name="library-root"]')) {
    radio.addEventListener("change", () => {
      if (radio.checked) void loadLibrary(details.agentId, radio.value, "");
    });
  }
  $("#library-upload").addEventListener("click", () => $("#library-file").click());
  $("#library-file").addEventListener("change", (event) => {
    const files = [...event.target.files];
    event.target.value = "";
    void uploadToLibrary(files);
  });
  $("#open-workspace").addEventListener("click", () => void openFolder("agent"));
  $("#open-shared").addEventListener("click", () => void openFolder("shared"));
  $("#copy-workspace").addEventListener("click", () => void copyText($("#computer-workspace").textContent));
  $("#copy-shared").addEventListener("click", () => void copyText($("#computer-shared").textContent));
  $("#computer-change").addEventListener("click", () => {
    if (state.settings.fullAccess) {
      closeDialog(detailsDialog);
      openSettings();
    } else {
      void agentAction("edit", details.agentId);
    }
  });

  // Uso del plan.
  $("#usage-button").addEventListener("click", toggleUsage);
  $("#usage-refresh").addEventListener("click", () => void refreshUsage());

  // Voces para leer en voz alta (algunos navegadores las cargan tarde).
  if (Synth) {
    loadVoices();
    Synth.addEventListener?.("voiceschanged", loadVoices);
    setTimeout(loadVoices, 600);
  }
  $("#queue-toggle").addEventListener("click", () => {
    state.queueOpen = !state.queueOpen;
    renderQueue();
  });
  $("#load-more").addEventListener("click", loadOlder);

  const input = $("#composer-input");
  $("#composer").addEventListener("submit", onComposerSubmit);
  input.addEventListener("input", () => {
    autosize(input);
    saveDraft();
    updateActionButton();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !coarsePointer) {
      event.preventDefault();
      void sendMessage();
    }
  });
  input.addEventListener("paste", (event) => {
    const files = event.clipboardData?.files;
    if (files?.length) {
      event.preventDefault();
      void addFiles(files);
    }
  });
  $("#attach").addEventListener("click", () => $("#file-input").click());
  $("#file-input").addEventListener("change", (event) => {
    const files = [...event.target.files];
    event.target.value = "";
    void addFiles(files);
  });
  const conversation = $("#conversation");
  conversation.addEventListener("dragover", (event) => {
    if (event.dataTransfer?.types?.includes("Files")) event.preventDefault();
  });
  conversation.addEventListener("drop", (event) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    void addFiles(event.dataTransfer.files);
  });
  $("#dictate").addEventListener("click", () => toggleDictation("dictate"));
  updateDictateButton();

  const form = $("#agent-form");
  form.addEventListener("submit", saveAgent);
  $("#agent-cancel").addEventListener("click", () => closeDialog($("#agent-dialog")));
  form.elements.provider.addEventListener("change", () => {
    updateProviderHint();
    updateAccessWarning();
    void refreshModelOptions();
  });
  form.elements.model.addEventListener("change", () => refreshEffortOptions());
  for (const radio of form.querySelectorAll('input[name="access"]')) radio.addEventListener("change", updateAccessWarning);

  buildDayPicker();
  const routineForm = $("#routine-form");
  routineForm.addEventListener("submit", saveRoutine);
  for (const radio of routineForm.querySelectorAll('input[name="kind"]')) radio.addEventListener("change", updateRoutineKind);
  $("#routines-close").addEventListener("click", () => closeDialog($("#routines-dialog")));

  window.addEventListener("hashchange", () => void route());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || $("#app").hidden) return;
    if (!events || events.readyState === EventSource.CLOSED) connectEvents();
    renderSidebar();
    if (state.currentId) scheduleMarkRead(state.currentId, 0);
  });
}

void boot();
