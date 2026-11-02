// ClosedBot — interfaz web (sin dependencias ni paso de compilación).

const $ = (selector) => document.querySelector(selector);
const SVG_NS = "http://www.w3.org/2000/svg";
const LETTERS = "ABCD";
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;

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
let dictation = null; // { mode: "dictate" | "voice", base, final, agentId, cancelled }
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
  $("#login").hidden = true;
  $("#app").hidden = false;
  renderIdentity();
  renderSidebar();
  renderProviders();
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
      renderIdentity();
      renderPermissions();
      renderSidebar();
      renderProviders();
      renderRoutinesIfOpen();
      // Tras reconectar pudimos perder eventos: recargamos la conversación abierta.
      if (state.currentId) void loadConversation(state.currentId, { keepScroll: true });
      break;
    case "agents":
      state.agents = event.agents;
      renderSidebar();
      renderHeader();
      updateWorkingIndicator();
      updateActionButton();
      if (state.currentId && !findAgent(state.currentId)) void navigate(null);
      else if (state.currentId && findAgent(state.currentId)?.unread) scheduleMarkRead(state.currentId);
      break;
    case "providers":
      state.providers = event.providers;
      renderProviders();
      break;
    case "routines":
      state.routines = event.routines;
      renderRoutinesIfOpen();
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
  closeMenu();
  if (!agent) {
    if (state.currentId) stopDictation({ cancel: true });
    state.currentId = null;
    elements.clear();
    document.body.classList.remove("show-chat");
    $("#conversation").hidden = true;
    $("#chat-empty").hidden = false;
    renderSidebar();
    return;
  }
  const changed = state.currentId !== agent.id;
  if (changed) stopDictation({ cancel: true });
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
    if (!agent?.unread || agentId !== state.currentId || document.hidden) return;
    api(`/api/agents/${encodeURIComponent(agentId)}/read`, { method: "POST" }).catch(() => undefined);
  }, delay);
}

// ---------- avatares ----------

const BLOB_COLORS = ["#8b5cf6", "#e5484d", "#4cbb73", "#ef9f3a", "#6f6f6f", "#3b82f6", "#e0609d", "#22b3a3", "#c9a227", "#a07cf0"];

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

/** Avatar estable de un agente: sale del número que le dio el servidor al crearlo (o de su id). Claude Bot usa la mascota. */
function blobAvatar(agent) {
  if (agent?.main) return drawBlob(MASCOT, "#f2f2f2");
  const index = Number.isInteger(agent.avatar) ? agent.avatar : hashString(agent.id ?? String(agent));
  const [shape, color] =
    AVATAR_SEQUENCE[index] ?? [index % BLOB_SHAPES.length, BLOB_COLORS[Math.floor(index / BLOB_SHAPES.length) % BLOB_COLORS.length]];
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
};

function icon(name) {
  const svg = svgElement("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" });
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

/** El agente abierto en una ventana visible no cuenta como no leído. */
function isUnread(agent) {
  return Boolean(agent.unread) && !(agent.id === state.currentId && !document.hidden);
}

function fold(text) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function renderSidebar() {
  const container = $("#agent-groups");
  container.replaceChildren();
  renderBotCard();
  // Claude Bot va en la tarjeta de arriba; la lista muestra los equipos.
  const team = state.agents.filter((agent) => !agent.main);
  const empty = team.length === 0;
  $("#sidebar-empty").hidden = !empty;
  $("#first-team").hidden = !mainAgent();
  $("#first-agent").className = mainAgent() ? "button ghost" : "button primary";
  const query = fold(state.search.trim());
  const visible = team.filter((agent) => !query || fold(`${agent.name} ${agent.role} ${agent.project}`).includes(query));
  const groups = new Map();
  for (const agent of visible) {
    const key = agent.project || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(agent);
  }
  const onlyUngrouped = groups.size === 1 && groups.has("");
  for (const [project, agents] of groups) {
    const section = document.createElement("section");
    const title = document.createElement("h2");
    title.className = "group-title";
    title.textContent = project || (onlyUngrouped ? "Tu equipo" : "General");
    const list = document.createElement("ul");
    list.className = "agent-list";
    for (const agent of agents) list.append(agentRow(agent));
    section.append(title, list);
    container.append(section);
  }
  if (query && !visible.length && !empty) {
    const none = document.createElement("p");
    none.className = "sidebar-empty";
    none.textContent = "Ningún agente coincide con la búsqueda.";
    container.append(none);
  }
  updateTitle();
}

function agentRow(agent) {
  const item = document.createElement("li");
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
  } else if (agent.state === "working") {
    mark.dataset.kind = "working";
    mark.title = "Trabajando";
  } else if (agent.queued > 0) {
    mark.dataset.kind = "queued";
    mark.title = `${agent.queued} en cola`;
  }
  button.append(blobAvatar(agent), texts, mark);
  button.title = [agent.name, agent.role].filter(Boolean).join(" · ");
  item.append(button);
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
  return { claude: "Claude", codex: "Codex", demo: "Demo" }[provider] ?? provider;
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
  if (avatar.dataset.agent !== agent.id) {
    avatar.replaceChildren(blobAvatar(agent));
    avatar.dataset.agent = agent.id;
  }
  $("#chat-name").textContent = agent.name;
  const label =
    agent.state === "working" ? "trabajando…" : agent.state === "paused" ? "en pausa" : agent.queued > 0 ? `${agent.queued} en cola` : "";
  const stateNode = $("#chat-state");
  stateNode.textContent = label;
  stateNode.hidden = !label;
  const parts = [agent.role || "Asistente general", providerLabel(agent.provider)];
  if (agent.model) parts.push(agent.model);
  if (agent.access === "total" || state.settings.fullAccess) parts.push("acceso total");
  if (agent.project) parts.push(agent.project);
  $("#chat-meta").textContent = parts.filter(Boolean).join(" · ");
  const pause = document.querySelector('#agent-menu [data-action="pause"]');
  pause.textContent = agent.paused ? "Reanudar la cola" : "Pausar la cola";
  // Claude Bot no se elimina: se puede empezar de cero.
  document.querySelector('#agent-menu [data-action="delete"]').hidden = Boolean(agent.main);
  document.querySelector('#agent-menu [data-action="edit"]').textContent = agent.main ? `Editar a ${agent.name}` : "Editar agente";
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
  if (list) {
    const index = list.findIndex((item) => item.id === message.id);
    if (index >= 0) list[index] = { ...list[index], ...message };
    else list.push(message);
  }
  if (agentId !== state.currentId || !list) return;
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
  return node;
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
  else if (Recognition) mode = "voice";
  button.dataset.mode = mode;
  const label = {
    send: "Enviar",
    voice: voiceActive ? "Terminar y enviar" : "Hablar y enviar al terminar",
    stop: `Detener a ${agent?.name ?? "el agente"}`,
  }[mode];
  button.setAttribute("aria-label", label);
  button.title = label;
  button.setAttribute("aria-pressed", String(voiceActive));
  button.disabled = !agent || (mode === "send" && (uploading || (!text && !ready)));
}

function onComposerSubmit(event) {
  event.preventDefault();
  const mode = $("#send").dataset.mode;
  if (mode === "stop") void stopAgent();
  else if (mode === "voice") toggleDictation("voice");
  else void sendMessage();
}

async function sendMessage() {
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

function toggleDictation(mode) {
  if (dictation) {
    stopDictation();
    return;
  }
  startDictation(mode);
}

/** mode «dictate» escribe en el cuadro; «voice» además envía el mensaje al terminar de hablar. */
function startDictation(mode) {
  if (!Recognition || !state.currentId) return;
  const input = $("#composer-input");
  const rec = new Recognition();
  rec.lang = speechLanguage();
  rec.interimResults = true;
  rec.continuous = mode === "dictate";
  rec.maxAlternatives = 1;
  const base = input.value && !/\s$/.test(input.value) ? `${input.value} ` : input.value;
  const session = { mode, base, final: "", agentId: state.currentId, cancelled: false };
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
    const messages = {
      "not-allowed": "Permite el uso del micrófono para dictar.",
      "service-not-allowed": "El navegador no permite el dictado aquí.",
      "audio-capture": "No se encontró un micrófono.",
      network: "El dictado necesita conexión a internet (lo procesa el servicio de voz del navegador).",
      "language-not-supported": "El dictado no está disponible en español en este navegador.",
    };
    if (event.error === "no-speech" || event.error === "aborted") return;
    showToast(messages[event.error] ?? `El dictado falló (${event.error}).`, "error");
  };
  rec.onend = () => {
    if (dictation !== session) return;
    dictation = null;
    recognition = null;
    updateDictationUi();
    saveDraft();
    if (session.mode === "voice" && !session.cancelled && state.currentId === session.agentId && input.value.trim()) void sendMessage();
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

function stopDictation({ cancel = false } = {}) {
  if (!dictation || !recognition) return;
  if (cancel) dictation.cancelled = true;
  try {
    recognition.stop();
  } catch {
    // Ya estaba detenido.
  }
}

function updateDictationUi() {
  const button = $("#dictate");
  const active = dictation?.mode === "dictate";
  button.setAttribute("aria-pressed", String(active));
  button.title = active ? "Dejar de dictar" : "Dictar";
  updateActionButton();
}

// ---------- acciones del agente ----------

function toggleMenu() {
  const menu = $("#agent-menu");
  const open = menu.hidden;
  menu.hidden = !open;
  $("#agent-menu-button").setAttribute("aria-expanded", String(open));
}

function closeMenu() {
  $("#agent-menu").hidden = true;
  $("#agent-menu-button").setAttribute("aria-expanded", "false");
}

async function agentAction(action) {
  closeMenu();
  const agent = findAgent(state.currentId);
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
      renderAllMessages();
      renderQueue();
      updatePlaceholder();
    } else if (action === "delete") {
      const ok = await confirmAction(
        `¿Eliminar a ${agent.name}?`,
        "Se borran el agente, su historial, su cola y sus rutinas. Su carpeta de trabajo queda en el equipo por si la necesitas.",
        "Eliminar",
      );
      if (!ok) return;
      await api(path, { method: "DELETE" });
      state.messages.delete(agent.id);
      state.attachments.delete(agent.id);
      await navigate(null);
    }
  } catch (error) {
    showToast(error.message, "error");
  }
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
  const projects = [...new Set(state.agents.filter((item) => !item.main).map((item) => item.project).filter(Boolean))];
  $("#project-options").replaceChildren(...projects.map((project) => new Option(project, project)));
  fillProviders(agent?.provider);
  updateAccessWarning();
  openDialog($("#agent-dialog"));
  await refreshModelOptions(agent?.model ?? "", agent?.effort ?? "");
  if (!coarsePointer) form.elements.name.focus();
}

function fillProviders(selected) {
  const select = $("#agent-form").elements.provider;
  select.replaceChildren();
  const preferred =
    selected ?? state.providers.find((provider) => provider.id !== "demo" && provider.available && provider.loggedIn !== false)?.id ?? "demo";
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
    if (provider.signIn) {
      status.textContent = "Esperando al navegador…";
      status.dataset.tone = "warn";
    } else if (!provider.available) {
      status.textContent = "No disponible";
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
    // Mientras se espera al navegador, las instrucciones del inicio de sesión reemplazan al «Sin sesión…».
    if (provider.signIn) item.append(title);
    else item.append(title, detail);
    const signIn = renderSignIn(provider);
    if (signIn) item.append(signIn);
    list.append(item);
  }
  if (focusKey) list.querySelector(`[data-focus-key="${focusKey}"]`)?.focus();
}

/** Botones para iniciar o cerrar sesión con la cuenta del proveedor (lo hace su propio CLI, como en OpenBot). */
function renderSignIn(provider) {
  if (!provider.canSignIn && !provider.signIn) return null;
  const box = document.createElement("div");
  box.className = "signin";
  const pending = provider.signIn;
  if (pending) {
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
    const logout = smallButton(`Cerrar sesión de ${provider.label}`, "danger-soft");
    logout.addEventListener("click", () => void signOutProvider(provider, logout));
    box.append(actionRow(logout));
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
  return provider.id === "codex" ? "Iniciar sesión con ChatGPT" : `Iniciar sesión con ${provider.label}`;
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

// ---------- utilidades de interfaz ----------

function openDialog(dialog) {
  if (!dialog.open) dialog.showModal();
}

function closeDialog(dialog) {
  if (dialog.open) dialog.close();
}

function confirmAction(title, text, okLabel) {
  const dialog = $("#confirm-dialog");
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  $("#confirm-ok").textContent = okLabel;
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
  $("#new-agent").addEventListener("click", () => openAgentDialog());
  $("#first-agent").addEventListener("click", () => openAgentDialog());
  $("#first-team").addEventListener("click", openMainAgent);
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
  $("#agent-menu-button").addEventListener("click", (event) => {
    event.stopPropagation();
    toggleMenu();
  });
  $("#agent-menu").addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action) void agentAction(action);
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#agent-menu")) closeMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu();
  });
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
  if (Recognition) {
    $("#dictate").hidden = false;
    $("#dictate").addEventListener("click", () => toggleDictation("dictate"));
  }

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
