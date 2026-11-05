// ClosedBot — interfaz web (sin dependencias ni paso de compilación).

import { createOffice } from "./office.js";

const $ = (selector) => document.querySelector(selector);
const SVG_NS = "http://www.w3.org/2000/svg";
const LETTERS = "ABCD";
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
const AudioCtx = window.AudioContext || window.webkitAudioContext || null;
/** Grabar el micrófono para el dictado en este PC (el navegador solo lo permite en localhost o https). */
const CanRecord = Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia && AudioCtx);
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
/** Los avatares elegidos a mano se guardan como 10000 + figura × 100 + color (los automáticos son 0, 1, 2…). */
const AVATAR_CUSTOM_BASE = 10_000;
const LONG_PRESS_MS = 500;
const COLLAPSED_KEY = "closedbot:secciones-plegadas";
const MAX_CHANNEL_MEMBERS = 12;

const state = {
  agents: [],
  providers: [],
  routines: [],
  settings: { botName: "ClosedBot", userName: "", fullAccess: false },
  paths: null,
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
  localVoices: null, // voces de este PC (Supertonic 3): { state, sizeMb, progress, error, source, voices, languages } o null
  showHidden: false,
  keepUnread: new Set(), // «Marcar como no leído» en la conversación abierta: sigue así hasta que vuelvas a entrar
  collapsed: loadCollapsed(),
  channels: [], // canales activos
  deletedChannels: [], // «Canales eliminados»
  currentChannelId: null, // canal abierto (entonces currentId es null)
  selection: null, // «Seleccionar varios»: ids de los agentes marcados, o null si no se está seleccionando
};

const elements = new Map(); // id de mensaje -> elemento del DOM (solo el agente abierto)
const dirty = new Set();
const answering = new Set(); // tarjetas de decisión con la respuesta en camino
let renderScheduled = false;
let events = null;
let reconnectTimer = null;
let toastTimer = null;
let readTimer = null;
let routinesFilter = null;
let recognition = null;
let dictation = null; // { engine: "browser" | "local", mode: "dictate" | "voice", agentId, cancelled, … }
/** Código de inicio de sesión que se está escribiendo, por proveedor (sobrevive a los repintados). */
const signInCodes = new Map();
/** La Oficina: los agentes trabajando en un dibujo (#/oficina). */
let office = null;
/** PixelLab: { configured, missing, drawing } (los personajes de la Oficina). */
let pixelLab = null;
let lastCharacters = "";

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
    // Al tocar un aviso del sistema («Avisarme»), el service worker pide abrir esa conversación.
    navigator.serviceWorker.addEventListener("message", (event) => {
      const hash = event.data?.type === "open" ? event.data.hash : null;
      if (typeof hash === "string" && /^#\/[ac]\/[^/?#]+$/.test(hash)) location.hash = hash;
    });
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
  state.platform = data.platform ?? "";
  state.sections = data.sections ?? [];
  state.usage = data.usage ?? [];
  state.channels = data.channels ?? [];
  state.deletedChannels = data.deletedChannels ?? [];
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
      if (event.channels) state.channels = event.channels;
      if (event.deletedChannels) state.deletedChannels = event.deletedChannels;
      applySpeechStatus(event.speech ?? null);
      applyLocalVoices(event.voices ?? null, { quiet: true });
      renderIdentity();
      renderPermissions();
      renderSidebar();
      renderProviders();
      renderRoutinesIfOpen();
      renderUsage();
      renderDetailsIfOpen();
      renderDeletedChannelsIfOpen();
      // Tras reconectar pudimos perder eventos: recargamos la conversación abierta.
      if (state.currentChannelId && !findChannel(state.currentChannelId)) void navigate(null);
      else if (convKey()) void loadConversation(convKey(), { keepScroll: true });
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
    case "channels":
      state.channels = event.channels;
      if (event.deleted) state.deletedChannels = event.deleted;
      renderSidebar();
      renderDeletedChannelsIfOpen();
      if ($("#channel-dialog").open && editingChannelId && !findChannel(editingChannelId)) closeDialog($("#channel-dialog"));
      if (state.currentChannelId) {
        // Lo eliminaron (desde otro dispositivo o desde el menú): se vuelve a la lista.
        if (!findChannel(state.currentChannelId)) {
          void navigate(null);
          break;
        }
        renderHeader();
        renderChannelIntro();
        updateWorkingIndicator();
        updateActionButton();
        if (findChannel(state.currentChannelId)?.unread) scheduleMarkRead(convKey());
      }
      break;
    case "usage":
      state.usage = event.usage;
      renderUsage();
      break;
    case "speech":
      applySpeechStatus(event.speech);
      break;
    case "voices":
      applyLocalVoices(event.voices);
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
      // La copia que recibe cada agente de un encargo en un canal no se muestra: ahí se ve «Ana → Beto».
      if (event.message.channelId && event.message.role === "teammate") break;
      upsertMessage(messageKey(event.agentId, event.message), event.message);
      break;
    case "delta":
      applyDelta(event.channelId ? `c:${event.channelId}` : event.agentId, event.messageId, event.delta);
      break;
    case "notice":
      if (!event.agentId || event.agentId !== state.currentId) showToast(event.message, event.level === "error" ? "error" : "info");
      break;
    case "alert":
      void showAlert(event);
      break;
    case "memories":
      if (details.agentId === event.agentId) {
        details.memories = { agentId: event.agentId, items: event.memories };
        renderDetailsIfOpen();
      }
      break;
    case "skills":
      if (details.agentId === event.agentId) {
        details.skills = { agentId: event.agentId, items: event.skills };
        renderDetailsIfOpen();
      }
      break;
    default:
      break;
  }
  office?.handle(event);
  if (event.type === "agents") {
    // Cambió el personaje de alguien (se empezó a dibujar, quedó listo o falló): se actualiza lo de PixelLab.
    const characters = state.agents.map((agent) => `${agent.id}:${agent.character?.status ?? ""}:${agent.character?.version ?? 0}`).join(",");
    if (characters !== lastCharacters) {
      lastCharacters = characters;
      if (office?.visible || $("#settings-dialog").open) void refreshPixelLab();
      if ($("#create-dialog").open && createState.agentId) renderCreateCharacter(findAgent(createState.agentId));
    }
  }
}

// ---------- navegación ----------

/** Qué está abierto según la dirección: #/a/<agente> o #/c/<canal>. */
function currentRoute() {
  if (/^#\/oficina\/?$/.test(location.hash)) return { kind: "office" };
  const agent = location.hash.match(/^#\/a\/([^/?#]+)/);
  if (agent) return { kind: "agent", id: decodeURIComponent(agent[1]) };
  const channel = location.hash.match(/^#\/c\/([^/?#]+)/);
  if (channel) return { kind: "channel", id: decodeURIComponent(channel[1]) };
  return null;
}

async function navigate(agentId) {
  const target = agentId ? `#/a/${encodeURIComponent(agentId)}` : "#/";
  if (location.hash === target) return route();
  state.navigatedInApp = true;
  location.hash = target;
}

async function navigateChannel(channelId) {
  const target = `#/c/${encodeURIComponent(channelId)}`;
  if (location.hash === target) return route();
  state.navigatedInApp = true;
  location.hash = target;
}

async function route() {
  const target = currentRoute();
  const agent = target?.kind === "agent" ? findAgent(target.id) : null;
  const channel = target?.kind === "channel" ? findChannel(target.id) : null;
  closeContextMenu();
  hideMentionMenu();
  const inOffice = target?.kind === "office";
  document.body.classList.toggle("in-office", inOffice);
  $("#open-office").setAttribute("aria-current", inOffice ? "page" : "false");
  if (inOffice) {
    if (convKey()) {
      stopDictation({ cancel: true });
      stopSpeaking();
    }
    closeDialog($("#details-dialog"));
    state.currentId = null;
    state.currentChannelId = null;
    document.body.classList.remove("in-channel");
    elements.clear();
    document.body.classList.add("show-chat");
    $("#conversation").hidden = true;
    $("#chat-empty").hidden = true;
    renderSidebar();
    office.show();
    void refreshPixelLab();
    return;
  }
  office.hide();
  if (!agent && !channel) {
    if (convKey()) {
      stopDictation({ cancel: true });
      stopSpeaking();
    }
    closeDialog($("#details-dialog"));
    state.currentId = null;
    state.currentChannelId = null;
    document.body.classList.remove("in-channel");
    elements.clear();
    document.body.classList.remove("show-chat");
    $("#conversation").hidden = true;
    $("#chat-empty").hidden = false;
    renderSidebar();
    return;
  }
  const key = agent ? agent.id : `c:${channel.id}`;
  const changed = convKey() !== key;
  if (changed) {
    stopDictation({ cancel: true });
    stopSpeaking();
    closeDialog($("#details-dialog"));
    // Volver a entrar a una conversación marcada como no leída la marca como leída.
    state.keepUnread.delete(key);
  }
  state.currentId = agent ? agent.id : null;
  state.currentChannelId = channel ? channel.id : null;
  document.body.classList.add("show-chat");
  document.body.classList.toggle("in-channel", Boolean(channel));
  // En un canal no se adjuntan archivos ni hay cola propia: cada agente tiene la suya.
  $("#attach").hidden = Boolean(channel);
  $("#chat-empty").hidden = true;
  $("#conversation").hidden = false;
  renderSidebar();
  renderHeader();
  if (changed) {
    restoreDraft();
    renderAttachments();
    renderQueue();
    await loadConversation(key);
    if (!coarsePointer) $("#composer-input").focus();
  }
  scheduleMarkRead(key, 0);
}

function goBack() {
  if (state.navigatedInApp && history.length > 1) history.back();
  else location.replace("#/");
}

/** Avisa al servidor de que el usuario ya vio la conversación (o el canal) abierta. */
function scheduleMarkRead(key = convKey(), delay = 700) {
  clearTimeout(readTimer);
  readTimer = setTimeout(() => {
    if (!key || key !== convKey() || document.hidden || state.keepUnread.has(key)) return;
    const channelId = channelIdOf(key);
    if (channelId) {
      if (!findChannel(channelId)?.unread) return;
      api(`/api/channels/${encodeURIComponent(channelId)}/read`, { method: "POST" }).catch(() => undefined);
      return;
    }
    if (!findAgent(key)?.unread) return;
    api(`/api/agents/${encodeURIComponent(key)}/read`, { method: "POST" }).catch(() => undefined);
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
  image: ["M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2z", "M4.5 16.5l4.3-4.3a1.5 1.5 0 0 1 2.1 0l5.6 5.6", "M13.8 14.6l1.7-1.7a1.5 1.5 0 0 1 2.1 0l1.9 1.9", "M15 7.8a1.3 1.3 0 1 0 0 2.6a1.3 1.3 0 1 0 0-2.6"],
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
  hash: ["M10 4.5L8 19.5", "M16 4.5l-2 15", "M5 9h14.5", "M4.5 15H19"],
  restore: ["M5 12a7 7 0 1 0 2.1-5", "M5 4.5V9h4.5"],
  select: ["M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16", "M8.6 12.3l2.3 2.3 4.6-4.9"],
  dash: ["M7.5 12h9"],
  cpu: ["M8 6.5h8a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 16V8A1.5 1.5 0 0 1 8 6.5z", "M10 10h4v4h-4z", "M10 4v2.5M14 4v2.5M10 17.5V20M14 17.5V20M4 10h2.5M4 14h2.5M17.5 10H20M17.5 14H20"],
  book: ["M12 6.8C10.2 5.5 7.7 4.8 4.5 4.8v12.6c3.2 0 5.7.7 7.5 2 1.8-1.3 4.3-2 7.5-2V4.8c-3.2 0-5.7.7-7.5 2z", "M12 6.8v12.6"],
  bookmark: ["M7 4.5h10v15l-5-3.6-5 3.6z"],
  bell: ["M5.5 17h13l-1.6-2V11a4.9 4.9 0 0 0-9.8 0v4z", "M10.2 19.6a1.9 1.9 0 0 0 3.6 0"],
  sliders: ["M4.5 7h9M17.5 7h2", "M15.5 5v4", "M4.5 12h2M10.5 12h9", "M8.5 10v4", "M4.5 17h7M15.5 17h4", "M13.5 15v4"],
  shield: ["M12 3.8l7 2.7v5.2c0 4.2-2.9 7.3-7 8.5-4.1-1.2-7-4.3-7-8.5V6.5z", "M9.2 12l2 2 3.8-3.9"],
  arrowUp: ["M12 18.5V5.8", "M6.8 11L12 5.8 17.2 11"],
  arrowDown: ["M12 5.5v12.7", "M6.8 13l5.2 5.2 5.2-5.2"],
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
  pruneSelection();
  renderSelectBar();
  // Claude Bot va en la tarjeta de arriba; la lista muestra los equipos.
  const team = state.agents.filter((agent) => !agent.main);
  const query = fold(state.search.trim());
  if (query) {
    // Buscando: todos los que coinciden, también los ocultos.
    const found = team.filter((agent) => matchesSearch(agent, query));
    const channels = sortedChannels().filter((channel) => fold(`${channel.name} ${channel.topic}`).includes(query));
    if (channels.length) container.append(sidebarGroup({ title: "Canales", agents: [], rows: channels.map(channelRow) }));
    if (found.length) container.append(sidebarGroup({ title: channels.length ? "Agentes" : "Resultados", agents: found }));
    if (!found.length && !channels.length) container.append(sidebarNote("Ningún agente ni canal coincide con la búsqueda."));
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
  container.append(channelsGroup());
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

function matchesSearch(agent, query) {
  return fold(`${agent.name} ${agent.role} ${agent.project}`).includes(query);
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

/** Un grupo de la barra lateral (Fijados, Canales, una sección, Sin asignar, Ocultos). Con `key` se puede plegar. */
function sidebarGroup({ key = null, title, agents, section = null, empty = "", rows = null, channels = false }) {
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
    if (channels) head.dataset.channels = "true";
    const label = document.createElement("span");
    label.className = "group-label";
    label.textContent = title;
    head.append(label, icon("chevron", "group-chevron"));
    head.addEventListener("click", () => toggleGroup(key));
    heading.append(head);
  } else {
    const label = document.createElement("span");
    label.className = "group-label";
    label.textContent = title;
    heading.append(label);
  }
  // Seleccionando: una casilla marca (o desmarca) a todos los del grupo, también si está plegado.
  if (state.selection && agents.length) heading.append(groupCheck(title, agents));
  group.append(heading);
  if (collapsed) return group;
  const items = rows ?? agents.map(agentRow);
  if (items.length) {
    const list = document.createElement("ul");
    list.className = "agent-list";
    for (const item of items) list.append(item);
    group.append(list);
  } else if (empty) {
    group.append(typeof empty === "string" ? sidebarNote(empty, "group-empty") : empty);
  }
  return group;
}

/** «Canales»: conversaciones con varios agentes. Sin canales, una invitación a crear el primero. */
function channelsGroup() {
  const channels = sortedChannels();
  let empty = "";
  if (!channels.length) {
    empty = document.createElement("button");
    empty.type = "button";
    empty.className = "group-empty group-action";
    empty.append(icon("plus"), "Nuevo canal");
    empty.title = "Un chat con varios agentes: el encargado responde y reparte el trabajo";
    empty.addEventListener("click", () => openChannelDialog());
  }
  return sidebarGroup({ key: "\0channels", title: "Canales", agents: [], rows: channels.map(channelRow), channels: true, empty });
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
  const selecting = Boolean(state.selection);
  const selected = selecting && state.selection.has(agent.id);
  if (selecting) {
    item.dataset.selecting = "true";
    button.setAttribute("aria-pressed", String(selected));
  }
  button.addEventListener("click", (event) => {
    // Seleccionando, el clic marca o desmarca. Ctrl+clic y Mayús+clic empiezan a seleccionar, como en el explorador.
    if (state.selection || event.ctrlKey || event.metaKey || event.shiftKey) selectFromClick(agent.id, event);
    else navigate(agent.id);
  });

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
  if (isUnread(agent)) button.classList.add("unread");
  if (selecting) {
    mark.dataset.kind = "check";
    if (selected) mark.append(icon("check"));
  } else if (isUnread(agent)) {
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
  const count = state.agents.filter(isUnread).length + state.channels.filter(isChannelUnread).length;
  document.title = count ? `(${count}) ClosedBot` : "ClosedBot";
}

function stateLabel(agent) {
  return { working: "Trabajando", queued: "Con mensajes en cola", paused: "En pausa", idle: "Libre" }[agent.state] ?? "";
}

function providerLabel(provider) {
  return { claude: "Claude", codex: "Codex", grok: "Grok", gemini: "Gemini", local: "Qwen local", demo: "Demo" }[provider] ?? provider;
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
  const channel = currentChannel();
  if (channel) {
    renderChannelHeader(channel);
    return;
  }
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
  stateNode.dataset.tone = "";
  $("#details-button").title = `Ficha de ${agent.name}: rutinas, voz, archivos y carpeta`;
  $("#details-button").setAttribute("aria-controls", "details-dialog");
  updatePlaceholder();
}

function renderChannelHeader(channel) {
  const avatar = $("#chat-avatar");
  if (avatar.dataset.key !== "channel") {
    avatar.replaceChildren(channelGlyph());
    avatar.dataset.key = "channel";
  }
  $("#chat-name").textContent = channel.name;
  const working = channel.working.map(agentName);
  const members = channelMembers(channel);
  const label = working.length
    ? working.length === 1
      ? `${working[0]} trabajando…`
      : `${working.length} trabajando…`
    : `${members.length} ${members.length === 1 ? "agente" : "agentes"}`;
  const stateNode = $("#chat-state");
  stateNode.textContent = label;
  stateNode.hidden = false;
  stateNode.dataset.tone = working.length ? "" : "muted";
  $("#details-button").title = `Canal ${channel.name}: ${members.map((agent) => agent.name).join(", ") || "sin agentes"}. Toca para editarlo.`;
  $("#details-button").setAttribute("aria-controls", "channel-dialog");
  updatePlaceholder();
}

function hasPendingDecision(agentId) {
  return (state.messages.get(agentId) ?? []).some((message) => message.role === "decision" && !Number.isInteger(message.payload?.answer));
}

function updatePlaceholder() {
  const channel = currentChannel();
  if (channel) {
    const lead = findAgent(channel.leadId);
    // En pantallas angostas, corto: la presentación del canal ya explica el @.
    const narrow = coarsePointer || window.innerWidth < 700;
    $("#composer-input").placeholder =
      lead && !narrow ? `Escribe en ${channel.name} (responde ${lead.name}; @ para elegir)` : `Escribe en ${channel.name}…`;
    return;
  }
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

/** Carga la conversación con un agente o, si la clave es «c:<id>», la de un canal. */
async function loadConversation(key, { keepScroll = false } = {}) {
  const channelId = channelIdOf(key);
  try {
    const [messages, queue] = await Promise.all([
      api(channelId ? `/api/channels/${encodeURIComponent(channelId)}/messages?limit=100` : `/api/agents/${encodeURIComponent(key)}/messages?limit=100`),
      channelId ? Promise.resolve(null) : api(`/api/agents/${encodeURIComponent(key)}/queue`),
    ]);
    if (convKey() !== key) return;
    const scroller = $("#messages");
    const atBottom = isNearBottom(scroller);
    state.messages.set(key, messages.messages);
    state.hasMore.set(key, messages.hasMore);
    if (queue) state.queues.set(key, queue.queue);
    renderAllMessages();
    renderQueue();
    updatePlaceholder();
    if (!keepScroll || atBottom) scrollToBottom(true);
  } catch (error) {
    if (error.status !== 401) showToast(error.message, "error");
  }
}

async function loadOlder() {
  const key = convKey();
  if (!key) return;
  const channelId = channelIdOf(key);
  const list = state.messages.get(key) ?? [];
  const oldest = list.find((message) => typeof message.seq === "number");
  if (!oldest) return;
  const button = $("#load-more");
  button.disabled = true;
  try {
    const base = channelId ? `/api/channels/${encodeURIComponent(channelId)}` : `/api/agents/${encodeURIComponent(key)}`;
    const data = await api(`${base}/messages?limit=100&before=${oldest.seq}`);
    if (convKey() !== key) return;
    const scroller = $("#messages");
    const previousHeight = scroller.scrollHeight;
    const known = new Set(list.map((message) => message.id));
    state.messages.set(key, [...data.messages.filter((message) => !known.has(message.id)), ...list]);
    state.hasMore.set(key, data.hasMore);
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
  for (const message of state.messages.get(convKey()) ?? []) {
    const node = buildMessage(message);
    elements.set(message.id, node);
    container.append(node);
  }
  $("#load-more").hidden = !state.hasMore.get(convKey());
  renderMainIntro();
  renderChannelIntro();
  updateWorkingIndicator();
}

function upsertMessage(target, message) {
  // Lo de un canal va al canal aunque se avise con el id del agente (por ejemplo, al contestar una pregunta).
  const agentId = message?.channelId ? `c:${message.channelId}` : target;
  const list = state.messages.get(agentId);
  let finished = false;
  if (list) {
    const index = list.findIndex((item) => item.id === message.id);
    const before = index >= 0 ? list[index].status : null;
    if (index >= 0) list[index] = { ...list[index], ...message };
    else list.push(message);
    finished = message.role === "assistant" && message.status === "completed" && before !== "completed";
  }
  if (agentId !== convKey() || !list) return;
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
  if (!$("#channel-intro").hidden) renderChannelIntro();
  updateWorkingIndicator();
  if (message.role === "decision") {
    updatePlaceholder();
    renderBotCard();
  }
  if (atBottom || (!existing && message.role === "user")) scrollToBottom();
}

function refreshMessage(agentId, messageId) {
  if (agentId !== convKey()) return;
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
  if (agentId !== convKey()) return;
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
  const list = state.messages.get(convKey()) ?? [];
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
    if (kind === "channel-created") {
      const channel = findChannel(message.payload.channelId);
      const name = channel?.name ?? message.text.match(/«(.+?)»/)?.[1] ?? "un canal";
      const link = document.createElement(channel ? "button" : "span");
      link.className = "what";
      link.textContent = name;
      if (channel) {
        link.type = "button";
        link.title = `Abrir el canal ${name}`;
        link.addEventListener("click", () => navigateChannel(channel.id));
      }
      node.append(icon("hash"), "Creó el canal", link);
      const members = message.payload.members ?? [];
      if (members.length) node.append(`· ${members.join(", ")}`);
      return node;
    }
    // La pizarra que lleva Claude Bot: se despliega para leerla.
    if (kind === "board-updated") {
      node.classList.add("msg-board");
      const board = typeof message.payload.board === "string" ? message.payload.board : "";
      if (!board) {
        node.append(icon("pin"), message.text);
        return node;
      }
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.append(icon("pin"), message.text);
      const text = document.createElement("div");
      text.className = "board-text md";
      renderMarkdown(board, text);
      details.append(summary, text);
      node.append(details);
      return node;
    }
    // Una imagen que generó el agente (quedó en la carpeta compartida): se ve en miniatura.
    if (kind === "image" && typeof message.payload.path === "string") {
      node.classList.add("msg-image");
      const line = document.createElement("div");
      line.className = "msg-image-line";
      line.append(icon("image"), "Generó una imagen");
      if (message.channelId) line.prepend(whoLabel(message.agentId));
      node.append(line, imageStrip(message.agentId, [message.payload.path]));
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
      if (message.channelId) node.prepend(whoLabel(message.agentId));
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
    if (message.channelId) node.prepend(whoLabel(message.agentId));
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
    // En un canal se dice de quién es el aviso, salvo que ya lo nombre.
    const who = message.channelId ? agentName(message.agentId) : "";
    node.textContent = who && !message.text.includes(who) ? `${who}: ${message.text}` : message.text;
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
      renderUserMessage(message, bubble);
      if (message.channelId) {
        // En un canal: a quién le llegó (el encargado o los que nombraste con @).
        const to = Array.isArray(message.payload?.to) ? message.payload.to.map(agentName) : [];
        meta.textContent = to.length ? `${message.payload?.decisionId ? "Respuesta para" : "Para"} ${to.join(", ")}` : "";
      } else {
        meta.textContent = userStatus(message.status);
      }
      break;
    case "assistant":
      node.className = message.channelId ? "msg msg-assistant msg-member" : "msg msg-assistant";
      if (!message.text && message.status === "streaming") bubble.append(thinkingDots());
      else renderMarkdown(message.text, bubble);
      if (message.status === "streaming" && message.text) bubble.classList.add("typing");
      meta.textContent = assistantStatus(message.status);
      if (message.channelId) label = agentName(message.agentId);
      break;
    case "teammate":
      node.className = "msg msg-teammate";
      label = `${message.replyTo ? "Respuesta de" : "Mensaje de"} ${agentName(message.fromAgentId)}`;
      renderMarkdown(message.text, bubble);
      // Las imágenes que generó quien escribe, en miniatura.
      if (Array.isArray(message.payload?.images) && message.payload.images.length) {
        bubble.append(imageStrip(message.agentId, message.payload.images.filter((path) => typeof path === "string")));
      }
      meta.textContent = teammateStatus(message.status);
      break;
    case "notice":
      if (message.channelId) {
        // Un encargo entre agentes del canal: «Ana → Beto».
        node.className = "msg msg-handoff";
        label = `${agentName(message.agentId)} → ${message.toAgentIds.map(agentName).join(", ")}`;
      } else {
        node.className = "msg msg-outgoing";
        label = `${message.replyTo ? "Respuesta para" : "Enviado a"} ${message.toAgentIds.map(agentName).join(", ")}`;
      }
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
  if (node.classList.contains("msg-member")) {
    const avatar = document.createElement("span");
    avatar.className = "msg-avatar";
    avatar.setAttribute("aria-hidden", "true");
    const author = findAgent(message.agentId);
    if (author) avatar.append(blobAvatar(author));
    node.append(avatar);
  }
  node.append(bubble, meta);
  if (message.role === "assistant" && message.status === "completed" && canReadAloud() && message.text.trim()) node.append(messageTools(message));
  return node;
}

/** Miniaturas de imágenes de la carpeta compartida: cada una se abre en grande en otra pestaña. */
function imageStrip(agentId, paths) {
  const strip = document.createElement("div");
  strip.className = "image-strip";
  for (const path of paths.slice(0, 12)) {
    const name = path.split("/").pop() || "imagen";
    const link = document.createElement("a");
    link.className = "image-thumb";
    link.href = libraryUrl(agentId, "shared", path, true);
    link.target = "_blank";
    link.rel = "noopener";
    link.title = name;
    const image = document.createElement("img");
    image.src = link.href;
    image.alt = name;
    image.loading = "lazy";
    image.decoding = "async";
    // Si el archivo ya no está (lo borraron o lo movieron), queda su nombre.
    image.addEventListener(
      "error",
      () => {
        link.classList.add("missing");
        link.replaceChildren(name);
      },
      { once: true },
    );
    link.append(image);
    strip.append(link);
  }
  return strip;
}

/** «Ana» al principio de una línea de actividad de un canal. */
function whoLabel(agentId) {
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = agentName(agentId);
  return who;
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
  button.addEventListener("click", () => toggleSpeakMessage(messageKey(message.agentId, message), message.id));
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
  if (message.channelId) {
    const from = document.createElement("p");
    from.className = "decision-from";
    from.textContent = `Pregunta de ${agentName(message.agentId)}`;
    card.append(from);
  }
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
  const key = messageKey(message.agentId, message);
  refreshMessage(key, message.id);
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
    refreshMessage(key, message.id);
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
  const list = state.messages.get(convKey()) ?? [];
  const channel = currentChannel();
  const streamingBy = (agentId) =>
    list.some((message) => message.role === "assistant" && message.status === "streaming" && (!agentId || message.agentId === agentId));
  // En un canal: los miembros que trabajan y todavía no escribieron nada.
  const thinking = channel ? channel.working.filter((agentId) => !streamingBy(agentId)) : [];
  const show = channel ? thinking.length > 0 : findAgent(state.currentId)?.state === "working" && !streamingBy(null);
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
  let who = indicator.querySelector(".msg-label");
  if (channel) {
    if (!who) {
      who = document.createElement("div");
      who.className = "msg-label";
      indicator.querySelector(".bubble").prepend(who);
    }
    who.textContent = thinking.map(agentName).join(", ");
  } else {
    who?.remove();
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

function appendChatImage(href, label, target) {
  const anchor = link(href, "");
  anchor.className = "chat-image";
  const image = document.createElement("img");
  image.src = href;
  image.alt = label || "Imagen";
  image.loading = "lazy";
  image.referrerPolicy = "no-referrer";
  image.addEventListener("error", () => {
    image.hidden = true;
    anchor.append("No se pudo cargar la imagen. Abrir archivo.");
  }, { once: true });
  anchor.append(image);
  target.append(anchor);
}

function renderUserMessage(message, target) {
  target.replaceChildren();
  let attachments = false;
  let pending = [];
  const flush = () => {
    if (!pending.length) return;
    const text = document.createElement("span");
    text.className = "user-message-text";
    text.textContent = pending.join("\n");
    target.append(text);
    pending = [];
  };
  for (const line of message.text.split("\n")) {
    if (/^Adjunté est(?:e archivo|os archivos) en tu carpeta:$/.test(line)) {
      attachments = true;
      pending.push(line);
      continue;
    }
    const match = attachments && line.match(/^- (adjuntos\/[^\r\n]+\.(?:png|jpe?g|gif|webp|avif))$/i);
    if (match) {
      flush();
      appendChatImage(libraryUrl(message.agentId, "agent", match[1], true), match[1].slice(9), target);
    } else {
      if (attachments && line && !line.startsWith("- ")) attachments = false;
      pending.push(line);
    }
  }
  flush();
}

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
    const picture = line.trim().match(/^!\[([^\]\n]*)\]\((?:<([^>\n]+)>|([^\n]+))\)$/);
    const pictureUrl = picture && chatImageUrl(picture[2] ?? picture[3]);
    if (pictureUrl) {
      reset();
      appendChatImage(pictureUrl, picture[1] || "Imagen generada", target);
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

/** Solo imágenes de la biblioteca autenticada; convierte enlaces file antiguos sin exponer el disco. */
function chatImageUrl(value) {
  try {
    const url = new URL(value.trim(), location.origin);
    if (url.protocol === "file:") {
      if (url.hostname) return null;
      const path = decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:\/)/, "$1").replaceAll("\\", "/");
      const agent = state.agents.find((item) => item.id === state.currentId);
      const roots = [["shared", state.paths?.shared], ["agent", agent?.workspace]];
      for (const [root, directory] of roots) {
        if (!directory) continue;
        const base = directory.replaceAll("\\", "/").replace(/\/$/, "") + "/";
        const windows = /^[A-Za-z]:\//.test(base);
        if ((windows ? path.toLowerCase() : path).startsWith(windows ? base.toLowerCase() : base)) {
          const relative = path.slice(base.length);
          if (/\.(png|jpe?g|webp|gif|avif)$/i.test(relative)) return libraryUrl(state.currentId, root, relative, true);
        }
      }
      return null;
    }
    if (url.origin !== location.origin || !/^\/api\/agents\/[^/]+\/library\/file$/.test(url.pathname)) return null;
    if (!["agent", "shared"].includes(url.searchParams.get("root"))) return null;
    if (!/\.(png|jpe?g|webp|gif|avif)$/i.test(url.searchParams.get("path") ?? "")) return null;
    if (url.searchParams.get("download") === "1") return null;
    if (url.searchParams.get("root") === "agent") {
      const id = decodeURIComponent(url.pathname.split("/")[3]);
      const agent = state.agents.find((item) => item.id === id);
      const directory = agent?.workspace?.replaceAll("\\", "/").replace(/\/$/, "").split("/").pop();
      const path = url.searchParams.get("path").replaceAll("\\", "/");
      const prefix = directory && `agentes/${directory}/`;
      if (prefix && path.startsWith(prefix)) url.searchParams.set("path", path.slice(prefix.length));
    }
    return url.pathname + url.search;
  } catch {
    return null;
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
  const queue = state.currentChannelId ? [] : (state.queues.get(state.currentId) ?? []);
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
  const key = convKey();
  if (!key) return;
  try {
    const value = $("#composer-input").value;
    if (value) localStorage.setItem(draftKey(key), value);
    else localStorage.removeItem(draftKey(key));
  } catch {
    // Sin almacenamiento local: no pasa nada.
  }
}

function restoreDraft() {
  let value = "";
  try {
    value = localStorage.getItem(draftKey(convKey())) ?? "";
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
  if (state.currentChannelId) return [];
  return state.attachments.get(state.currentId) ?? [];
}

/** Modo del botón morado: enviar, hablar (dictado que se envía solo) o detener al agente. */
function updateActionButton() {
  const button = $("#send");
  const channel = currentChannel();
  const agent = channel ? null : findAgent(state.currentId);
  const working = channel ? channel.working.length > 0 : agent?.state === "working";
  const text = $("#composer-input").value.trim();
  const files = currentAttachments();
  const ready = files.some((file) => file.status === "ready");
  const uploading = files.some((file) => file.status === "uploading");
  const voiceActive = dictation?.mode === "voice";
  let mode = "send";
  if (voiceActive) mode = "voice";
  else if (text || ready || uploading) mode = "send";
  else if (working) mode = "stop";
  else if (dictationAvailable()) mode = "voice";
  button.dataset.mode = mode;
  const label = {
    send: "Enviar",
    voice: voiceActive ? "Terminar y enviar" : "Hablar y enviar al terminar",
    stop: channel ? "Detener a los agentes del canal" : `Detener a ${agent?.name ?? "el agente"}`,
  }[mode];
  button.setAttribute("aria-label", label);
  button.title = label;
  button.setAttribute("aria-pressed", String(voiceActive));
  button.disabled = !(agent || channel) || (mode === "send" && (uploading || (!text && !ready))) || (voiceActive && dictation.finishing);
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
  const channel = currentChannel();
  if (channel) {
    await sendChannelMessage(channel, input);
    return;
  }
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

/** Mensaje en un canal: lo atiende el encargado, o los que nombres con @. */
async function sendChannelMessage(channel, input) {
  const original = input.value;
  const text = original.trim();
  if (!text) return;
  hideMentionMenu();
  stopDictation({ cancel: true });
  stopSpeaking();
  const key = `c:${channel.id}`;
  state.keepUnread.delete(key);
  const button = $("#send");
  button.disabled = true;
  try {
    const result = await api(`/api/channels/${encodeURIComponent(channel.id)}/messages`, { method: "POST", body: { text } });
    if (convKey() === key && input.value === original) {
      input.value = "";
      autosize(input);
      saveDraft();
    }
    upsertMessage(key, result.message);
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
    if (file.status === "ready" && /\.(png|jpe?g|gif|webp|avif)$/i.test(file.relativePath ?? "")) {
      const preview = document.createElement("img");
      preview.src = libraryUrl(file.agentId, "agent", file.relativePath, true);
      preview.alt = file.name;
      preview.className = "attachment-preview";
      chip.append(preview);
    }
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
  if (state.currentChannelId) {
    showToast("En un canal no se adjuntan archivos: envíaselos a un agente desde su conversación.");
    return;
  }
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
  const lang = findAgent(convKey())?.voice?.lang;
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
  if (!convKey()) return;
  if (useLocalDictation()) await startLocalDictation(mode);
  else if (Recognition) startBrowserDictation(mode);
}

// ---------- dictado: qué motor se usa ----------

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

/** Siempre en automático: este PC si ya tiene el reconocimiento (o el del navegador no sirve aquí), si no, el navegador. */
function useLocalDictation() {
  if (!localDictationPossible()) return false;
  if (!Recognition) return true;
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
  primeAudio();
  const input = $("#composer-input");
  const rec = new Recognition();
  rec.lang = dictationLanguage();
  rec.interimResults = true;
  rec.continuous = mode === "dictate";
  rec.maxAlternatives = 1;
  const base = input.value && !/\s$/.test(input.value) ? `${input.value} ` : input.value;
  const session = { engine: "browser", mode, base, final: "", agentId: convKey(), cancelled: false, failed: false };
  rec.onresult = (event) => {
    if (dictation !== session) return;
    let interim = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (result.isFinal) session.final += result[0].transcript;
      else interim += result[0].transcript;
    }
    if (convKey() !== session.agentId) return;
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
    if (session.failed && !session.cancelled && convKey() === session.agentId) {
      showToast("El dictado del navegador no funciona aquí: uso el de este PC.");
      void startLocalDictation(session.mode);
      return;
    }
    if (session.mode === "voice" && !session.cancelled && convKey() === session.agentId && input.value.trim()) {
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
  if (!state.speech || !convKey() || dictation) return;
  if (state.speech.state !== "ready") {
    await ensureLocalModel();
    return;
  }
  stopSpeaking();
  primeAudio();
  const session = {
    engine: "local",
    mode,
    agentId: convKey(),
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
  if (convKey() !== session.agentId) return;
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
    if (session.sendAfter && !session.cancelled && convKey() === session.agentId && input.value.trim()) {
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

// ---------- voces para leer en voz alta (Ajustes) ----------

/** Ajustes → Voces para leer en voz alta: las 10 de OpenBot (Supertonic 3), que leen en este PC. */
function renderTtsSettings() {
  const list = $("#tts-settings");
  if (!list) return;
  const item = localVoicesItem();
  list.replaceChildren(...(item ? [item] : []));
  list.hidden = !item;
  $("#tts-title").hidden = !item;
}

// ---------- voces de OpenBot (Supertonic 3): leen en este PC ----------

const LOCAL_PREFIX = "local:";

function isLocalVoice(name) {
  return String(name ?? "").startsWith(LOCAL_PREFIX);
}

function localVoicesReady() {
  return state.localVoices?.state === "ready" && Boolean(AudioCtx);
}

/** Las voces de este PC que leen ese idioma (Supertonic habla 31). */
function localVoicesFor(lang) {
  if (!localVoicesReady()) return [];
  const base = String(lang).split("-")[0].toLowerCase();
  return state.localVoices.languages?.includes(base) ? state.localVoices.voices : [];
}

/** Se puede leer en voz alta: las voces de OpenBot están listas y este navegador puede tocar su audio. */
function canReadAloud() {
  return localVoicesReady();
}

function applyLocalVoices(status, { quiet = false } = {}) {
  const previous = state.localVoices?.state ?? null;
  const couldRead = canReadAloud();
  state.localVoices = status ?? null;
  const next = state.localVoices?.state ?? null;
  if (!quiet && previous && next && previous !== next) {
    if (next === "ready" && previous === "downloading") {
      showToast("Ya están las voces: elige una en la ficha del agente, en «Chat de voz».");
    } else if (next === "error") {
      showToast(state.localVoices.error ?? "No se pudieron descargar las voces.", "error");
    }
  }
  // Con las voces listas aparece el botón para leer cada respuesta (al conectar se recarga la conversación igual).
  if (!quiet && couldRead !== canReadAloud() && convKey()) {
    const scroller = $("#messages");
    const top = scroller.scrollTop;
    renderAllMessages();
    scroller.scrollTop = top;
  }
  if ($("#settings-dialog")?.open) renderTtsSettings();
  renderDetailsIfOpen();
}

async function installLocalVoices(button = null) {
  if (button) button.disabled = true;
  try {
    const result = await api("/api/voices/install", { method: "POST" });
    applyLocalVoices(result.voices);
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    if (button) button.disabled = false;
  }
}

function localVoicesProgressText(status) {
  return `Descargando las voces: ${Math.floor((status.progress ?? 0) * 100)} % de ${status.sizeMb} MB`;
}

/** Qué son las voces, para quien todavía no las tiene. */
function localVoicesOfferText(status) {
  return `Las 10 voces de OpenBot. Se descargan una vez (${status.sizeMb} MB) y después leen sin internet.`;
}

/** Ajustes → Voces para leer en voz alta. */
function localVoicesItem() {
  const status = state.localVoices;
  if (!status) return null;
  const item = document.createElement("li");
  item.className = "provider";
  const title = document.createElement("div");
  title.className = "title";
  const name = document.createElement("span");
  name.textContent = "Voces de OpenBot";
  const badge = document.createElement("span");
  badge.className = "state";
  const detail = document.createElement("div");
  detail.className = "detail";
  let action = null;
  if (status.state === "ready") {
    badge.textContent = "Listas";
    badge.dataset.tone = "ok";
    detail.textContent = "5 de mujer y 5 de hombre. Leen sin internet.";
  } else if (status.state === "downloading") {
    badge.textContent = `${Math.floor((status.progress ?? 0) * 100)} %`;
    badge.dataset.tone = "warn";
    detail.textContent = `${localVoicesProgressText(status)}. Puedes seguir usando ClosedBot mientras tanto.`;
  } else {
    badge.textContent = status.state === "error" ? "Falló" : "Sin descargar";
    badge.dataset.tone = status.state === "error" ? "bad" : "warn";
    detail.textContent = status.state === "error" && status.error ? status.error : localVoicesOfferText(status);
    action = smallButton(status.state === "error" ? "Reintentar" : "Descargar", "primary");
    action.addEventListener("click", () => void installLocalVoices(action));
  }
  if (!AudioCtx) detail.textContent = "Este navegador no puede tocar el audio de las voces.";
  title.append(name, badge);
  item.append(title, detail);
  if (action && AudioCtx) item.append(actionRow(action));
  return item;
}

/** En la ficha del agente: ofrece descargar las voces (o muestra cómo va la descarga). */
function renderLocalVoicesOffer() {
  const box = $("#voice-local");
  if (!box) return;
  const status = state.localVoices;
  const show = Boolean(status) && Boolean(AudioCtx) && status.state !== "ready";
  box.hidden = !show;
  if (!show) return;
  const downloading = status.state === "downloading";
  $("#voice-local-text").textContent = downloading
    ? `${localVoicesProgressText(status)}…`
    : status.state === "error" && status.error
      ? status.error
      : localVoicesOfferText(status);
  const button = $("#voice-local-download");
  button.hidden = downloading;
  button.textContent = status.state === "error" ? "Reintentar" : "Descargar";
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
      openDetails(agent.id, "profile");
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
      await deleteAgents([agent.id]);
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

// ---------- seleccionar varios agentes y eliminarlos juntos ----------

let selectionAnchor = null; // desde dónde marca Mayús+clic
let selectionBusy = false; // eliminando los marcados

/** Se puede marcar a cualquier agente menos Claude Bot. */
function selectableAgent(id) {
  const agent = id ? findAgent(id) : null;
  return agent && !agent.main ? agent : null;
}

/** Entra al modo de selección (o suma a lo ya marcado) con esos agentes marcados. */
function startSelection(ids = []) {
  closeContextMenu();
  closeUsage();
  state.selection ??= new Set();
  for (const id of ids) if (selectableAgent(id)) state.selection.add(id);
  if (ids.length === 1) selectionAnchor = ids[0];
  renderSidebar();
}

function endSelection() {
  if (!state.selection || selectionBusy) return;
  state.selection = null;
  selectionAnchor = null;
  renderSidebar();
}

function toggleSelected(id) {
  if (!selectableAgent(id)) return;
  state.selection ??= new Set();
  if (state.selection.has(id)) state.selection.delete(id);
  else state.selection.add(id);
  selectionAnchor = id;
  renderSidebar();
}

/** Los agentes que se ven en la lista, en orden. */
function shownAgentIds() {
  return [...$("#agent-groups").querySelectorAll(".agent-item[data-id]")].map((item) => item.dataset.id);
}

function selectFromClick(id, event) {
  if (selectionBusy || !selectableAgent(id)) return;
  if (!state.selection) {
    // Ctrl+clic o Mayús+clic sin estar seleccionando: el agente abierto cuenta como marcado.
    const current = selectableAgent(state.currentId) && shownAgentIds().includes(state.currentId) ? state.currentId : null;
    state.selection = new Set(current ? [current] : []);
    selectionAnchor = current;
  }
  const order = shownAgentIds();
  const from = event.shiftKey && selectionAnchor ? order.indexOf(selectionAnchor) : -1;
  const to = order.indexOf(id);
  if (from >= 0 && to >= 0) {
    // Mayús+clic: marca todos los que hay entre el último marcado y este.
    for (const other of order.slice(Math.min(from, to), Math.max(from, to) + 1)) state.selection.add(other);
    renderSidebar();
    return;
  }
  toggleSelected(id);
}

/** Lo que marca «Todos»: los agentes de la lista (buscando, los que coinciden). */
function listedAgents() {
  const team = state.agents.filter((agent) => !agent.main);
  const query = fold(state.search.trim());
  return query ? team.filter((agent) => matchesSearch(agent, query)) : team;
}

function toggleSelectAll() {
  if (!state.selection || selectionBusy) return;
  const listed = listedAgents();
  const all = listed.every((agent) => state.selection.has(agent.id));
  for (const agent of listed) {
    if (all) state.selection.delete(agent.id);
    else state.selection.add(agent.id);
  }
  renderSidebar();
}

/** Quita de lo marcado a los agentes que ya no están (los eliminaron desde otro lado). */
function pruneSelection() {
  if (!state.selection) return;
  for (const id of state.selection) if (!selectableAgent(id)) state.selection.delete(id);
}

function renderSelectBar() {
  const selecting = Boolean(state.selection);
  $("#select-bar").hidden = !selecting;
  $(".sidebar-footer").hidden = selecting;
  if (!selecting) return;
  const count = state.selection.size;
  $("#select-count").textContent = selectionBusy ? "Eliminando…" : count ? `${count} ${count === 1 ? "seleccionado" : "seleccionados"}` : "Elige agentes";
  const listed = listedAgents();
  $("#select-all").textContent = listed.length && listed.every((agent) => state.selection.has(agent.id)) ? "Ninguno" : "Todos";
  $("#select-all").disabled = selectionBusy || !listed.length;
  $("#select-delete").disabled = selectionBusy || !count;
  $("#select-cancel").disabled = selectionBusy;
}

/** Casilla del título de un grupo: marca a todos los del grupo, o los desmarca si ya estaban todos. */
function groupCheck(title, agents) {
  const ids = agents.map((agent) => agent.id);
  const marked = ids.filter((id) => state.selection.has(id)).length;
  const all = marked === ids.length;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "group-check";
  button.dataset.state = all ? "all" : marked ? "some" : "none";
  const label = `${all ? "Desmarcar" : "Marcar"} a todos los de «${title}»`;
  button.title = label;
  button.setAttribute("aria-label", label);
  const circle = document.createElement("span");
  circle.className = "check-circle";
  if (all) circle.append(icon("check"));
  else if (marked) circle.append(icon("dash"));
  button.append(circle);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (selectionBusy) return;
    for (const id of ids) {
      if (all) state.selection.delete(id);
      else state.selection.add(id);
    }
    renderSidebar();
  });
  return button;
}

/** «Ana, Beto y Carla»; con muchos, «Ana, Beto, … y 3 más». */
function joinNames(names, max = 6) {
  const shown = names.length > max ? [...names.slice(0, max - 1), `${names.length - max + 1} más`] : names;
  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} y ${shown[shown.length - 1]}` : (shown[0] ?? "");
}

/** Lo que queda en este navegador de un agente eliminado. */
function forgetAgent(id) {
  state.messages.delete(id);
  state.attachments.delete(id);
  state.keepUnread.delete(id);
  state.agents = state.agents.filter((item) => item.id !== id);
  state.selection?.delete(id);
  if (details.agentId === id) closeDialog($("#details-dialog"));
}

/**
 * Elimina uno o varios agentes con una sola confirmación. Al que está trabajando se le detiene
 * el turno, y un canal que se queda sin miembros pasa a «Canales eliminados».
 */
async function deleteAgents(ids) {
  closeContextMenu();
  if (selectionBusy) return;
  const agents = [...new Set(ids)].map((id) => selectableAgent(id)).filter(Boolean);
  if (!agents.length) return;
  const one = agents.length === 1 ? agents[0] : null;
  const doomed = new Set(agents.map((agent) => agent.id));
  const working = agents.filter((agent) => agent.state === "working");
  const emptied = state.channels.filter((channel) => channel.memberIds.length && channel.memberIds.every((id) => doomed.has(id)));
  const text = [
    one ? "Se borran el agente, su historial, su cola y sus rutinas." : `${joinNames(agents.map((agent) => agent.name))}, con su historial y sus rutinas.`,
  ];
  if (working.length) {
    const names = joinNames(working.map((agent) => agent.name));
    text.push(one ? "Está trabajando: se detiene." : working.length === 1 ? `${names} está trabajando: se detiene.` : `${names} están trabajando: se detienen.`);
  }
  // Un canal cuyos miembros se eliminan todos queda vacío: pasa a «Canales eliminados».
  if (emptied.length === 1) text.push(`El canal «${emptied[0].name}» pasa a «Canales eliminados».`);
  else if (emptied.length) text.push(`Los canales ${joinNames(emptied.map((channel) => `«${channel.name}»`))} pasan a «Canales eliminados».`);
  text.push(one ? "Su carpeta de trabajo queda en el equipo por si la necesitas." : "Sus archivos se quedan en sus carpetas.");
  if (!(await confirmAction(one ? `¿Eliminar a ${one.name}?` : `¿Eliminar ${agents.length} agentes?`, text.join(" "), "Eliminar"))) return;

  selectionBusy = true;
  renderSelectBar();
  if (working.length) showToast(one || working.length === 1 ? `Deteniendo a ${working[0].name}…` : "Deteniendo a los que están trabajando…");
  const gone = new Set();
  const failures = [];
  const closedChannels = new Set();
  try {
    for (const agent of agents) {
      try {
        await api(`/api/agents/${encodeURIComponent(agent.id)}?stop=1`, { method: "DELETE" });
        gone.add(agent.id);
      } catch (error) {
        // Si ya no existe (lo eliminaron desde otro lado), también está listo.
        if (error.status === 404) gone.add(agent.id);
        else failures.push(`${agent.name}: ${error.message}`);
      }
      if (gone.has(agent.id)) forgetAgent(agent.id);
    }
    for (const channel of emptied) {
      if (!channel.memberIds.every((id) => gone.has(id))) continue;
      try {
        const result = await api(`/api/channels/${encodeURIComponent(channel.id)}`, { method: "DELETE" });
        replaceChannel(result.channel);
        closedChannels.add(channel.id);
      } catch (error) {
        failures.push(`«${channel.name}»: ${error.message}`);
      }
    }
  } finally {
    selectionBusy = false;
  }
  // Con todo eliminado se termina la selección; si algo falló, queda marcado para reintentar.
  if (state.selection && !failures.length) {
    state.selection = null;
    selectionAnchor = null;
  }
  if (gone.has(state.currentId) || closedChannels.has(state.currentChannelId)) await navigate(null);
  else renderSidebar();
  if (failures.length) showToast(`No se pudo eliminar ${failures.join(" · ")}`, "error");
  else if (!one) showToast(`Se eliminaron ${gone.size} agentes.`);
}

// ---------- canales ----------

let editingChannelId = null;
let mention = null; // lista de @ abierta: { start, end, options, index }

/** Clave de lo abierto: el id del agente o «c:<id>» si es un canal. */
function convKey() {
  return state.currentChannelId ? `c:${state.currentChannelId}` : state.currentId;
}

/** Dónde va un mensaje: la conversación del agente o, si es de un canal, ese canal. */
function messageKey(agentId, message) {
  return message?.channelId ? `c:${message.channelId}` : agentId;
}

function channelIdOf(key) {
  return typeof key === "string" && key.startsWith("c:") ? key.slice(2) : null;
}

function findChannel(id) {
  return state.channels.find((channel) => channel.id === id) ?? null;
}

function currentChannel() {
  return state.currentChannelId ? findChannel(state.currentChannelId) : null;
}

function channelMembers(channel) {
  return channel.memberIds.map(findAgent).filter(Boolean);
}

function sortedChannels() {
  return [...state.channels].sort((a, b) => a.name.localeCompare(b.name, "es", { sensitivity: "base" }));
}

/** El canal abierto en una ventana visible no cuenta como no leído, salvo que lo marcaras así. */
function isChannelUnread(channel) {
  if (!channel.unread) return false;
  if (state.keepUnread.has(`c:${channel.id}`)) return true;
  return !(channel.id === state.currentChannelId && !document.hidden);
}

function channelGlyph(className = "channel-glyph") {
  const glyph = document.createElement("span");
  glyph.className = className;
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = "#";
  return glyph;
}

function memberSummary(members) {
  if (!members.length) return "Sin agentes";
  const names = members.map((agent) => agent.name);
  return names.length <= 3 ? names.join(", ") : `${names.slice(0, 2).join(", ")} y ${names.length - 2} más`;
}

function channelRow(channel) {
  const item = document.createElement("li");
  item.className = "agent-item channel-item";
  item.dataset.channel = channel.id;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "agent-row";
  button.setAttribute("aria-current", String(channel.id === state.currentChannelId));
  button.addEventListener("click", () => navigateChannel(channel.id));

  const members = channelMembers(channel);
  const texts = document.createElement("span");
  texts.className = "texts";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = channel.name;
  const preview = document.createElement("span");
  preview.className = "preview";
  const working = channel.working.map(agentName);
  if (working.length) {
    preview.textContent = working.length === 1 ? `${working[0]} está trabajando…` : `${working.length} agentes trabajando…`;
    preview.dataset.tone = "working";
  } else {
    preview.textContent = channel.preview || channel.topic || memberSummary(members);
  }
  texts.append(name, preview);

  const mark = document.createElement("span");
  mark.className = "mark";
  if (isChannelUnread(channel)) {
    mark.dataset.kind = "unread";
    mark.title = "Mensajes nuevos";
    button.classList.add("unread");
  } else if (working.length) {
    mark.dataset.kind = "working";
    mark.title = "Trabajando";
  }
  button.append(channelGlyph("channel-glyph row-glyph"), texts, mark);
  button.title = [channel.name, memberSummary(members)].join(" · ");

  const more = document.createElement("button");
  more.type = "button";
  more.className = "row-more";
  more.title = "Más opciones";
  more.setAttribute("aria-label", `Opciones del canal ${channel.name}`);
  more.setAttribute("aria-haspopup", "menu");
  more.append(icon("more", "dots"));
  more.addEventListener("click", (event) => {
    event.stopPropagation();
    openContextMenu(channelMenuItems(channel.id), { anchor: more, source: more });
  });
  item.append(button, more);
  return item;
}

/** Presentación del canal mientras no tiene mensajes: quién está y cómo se reparte. */
function renderChannelIntro() {
  const intro = $("#channel-intro");
  const channel = currentChannel();
  const key = convKey();
  const show = Boolean(channel) && !(state.messages.get(key) ?? []).length && !state.hasMore.get(key);
  intro.hidden = !show;
  if (!show) return;
  const lead = findAgent(channel.leadId);
  $("#channel-intro-title").textContent = channel.name;
  $("#channel-intro-topic").textContent = channel.topic;
  $("#channel-intro-topic").hidden = !channel.topic;
  $("#channel-intro-text").textContent = lead
    ? `En el canal: ${memberSummary(channelMembers(channel))}. Lo que escribas lo responde ${lead.name}, el encargado, que reparte el trabajo. Con @Nombre le hablas a uno solo y con @todos, a todos.`
    : "Este canal no tiene agentes: agrégalos tocando su nombre arriba.";
}

function replaceChannel(channel) {
  if (!channel) return;
  if (channel.deletedAt) {
    state.channels = state.channels.filter((item) => item.id !== channel.id);
    state.deletedChannels = [channel, ...state.deletedChannels.filter((item) => item.id !== channel.id)];
  } else {
    state.deletedChannels = state.deletedChannels.filter((item) => item.id !== channel.id);
    const index = state.channels.findIndex((item) => item.id === channel.id);
    if (index >= 0) state.channels[index] = channel;
    else state.channels.push(channel);
  }
  renderSidebar();
  if (channel.id === state.currentChannelId) {
    renderHeader();
    renderChannelIntro();
  }
}

async function setChannelUnread(channelId, unread) {
  const key = `c:${channelId}`;
  // Antes de pedirlo: el aviso del servidor puede llegar antes que la respuesta.
  if (unread) state.keepUnread.add(key);
  else state.keepUnread.delete(key);
  try {
    const result = await api(`/api/channels/${encodeURIComponent(channelId)}/${unread ? "unread" : "read"}`, { method: "POST" });
    replaceChannel(result.channel);
  } catch (error) {
    if (unread) state.keepUnread.delete(key);
    showToast(error.message, "error");
  }
}

async function deleteChannel(channelId) {
  const channel = findChannel(channelId);
  if (!channel) return;
  const ok = await confirmAction(
    "Eliminar canal",
    `«${channel.name}» pasa a «Canales eliminados»: desde ahí lo restauras o lo borras para siempre. Lo que esperaba turno en el canal se cancela.`,
    "Eliminar",
  );
  if (!ok) return;
  try {
    const result = await api(`/api/channels/${encodeURIComponent(channel.id)}`, { method: "DELETE" });
    replaceChannel(result.channel);
    if (state.currentChannelId === channel.id) void navigate(null);
    showToast(`«${channel.name}» quedó en «Canales eliminados» (clic derecho en la barra lateral).`);
  } catch (error) {
    showToast(error.message, "error");
  }
}

function openChannelDialog(channelId = null) {
  const channel = channelId ? findChannel(channelId) : null;
  editingChannelId = channel?.id ?? null;
  const form = $("#channel-form");
  form.reset();
  $("#channel-dialog-title").textContent = channel ? "Editar canal" : "Nuevo canal";
  $("#channel-save").textContent = channel ? "Guardar" : "Crear canal";
  $("#channel-delete").hidden = !channel;
  $("#channel-error").textContent = "";
  form.elements.name.value = channel?.name ?? "";
  form.elements.topic.value = channel?.topic ?? "";
  renderChannelMembers(channel ? channel.memberIds : [], channel?.leadId ?? null);
  openDialog($("#channel-dialog"));
  if (!coarsePointer || !channel) form.elements.name.focus();
}

/** Agentes que se pueden sumar: Claude Bot primero y después el resto, con los ocultos al final. */
function channelCandidates() {
  const main = mainAgent();
  const rest = state.agents
    .filter((agent) => !agent.main)
    .sort(
      (a, b) =>
        Number(a.hidden) - Number(b.hidden) ||
        a.project.localeCompare(b.project, "es", { sensitivity: "base" }) ||
        a.name.localeCompare(b.name, "es", { sensitivity: "base" }),
    );
  return main ? [main, ...rest] : rest;
}

function renderChannelMembers(selected, leadId) {
  const box = $("#channel-members");
  box.replaceChildren();
  const chosen = new Set(selected);
  const candidates = channelCandidates();
  for (const agent of candidates) {
    const label = document.createElement("label");
    label.className = "member-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.name = "member";
    input.value = agent.id;
    input.checked = chosen.has(agent.id);
    input.addEventListener("change", () => updateLeadOptions());
    const texts = document.createElement("span");
    texts.className = "member-texts";
    const name = document.createElement("span");
    name.className = "member-name";
    name.textContent = agent.name;
    const role = document.createElement("span");
    role.className = "member-role";
    role.textContent = agent.main ? "Bot principal" : agent.role || agent.project || providerLabel(agent.provider);
    texts.append(name, role);
    label.append(input, blobAvatar(agent), texts);
    box.append(label);
  }
  if (!candidates.length) box.append(sidebarNote("Todavía no tienes agentes: crea uno con el botón +.", "muted small"));
  updateLeadOptions(leadId);
}

function selectedMembers() {
  return [...document.querySelectorAll('#channel-members input[name="member"]:checked')].map((input) => input.value);
}

function updateLeadOptions(preferred) {
  const select = $("#channel-lead");
  const wanted = preferred !== undefined ? preferred : select.value;
  const members = selectedMembers();
  select.replaceChildren();
  for (const id of members) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = agentName(id);
    select.append(option);
  }
  if (!members.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "Primero elige los agentes";
    select.append(option);
  }
  select.disabled = !members.length;
  select.value = members.includes(wanted) ? wanted : (members[0] ?? "");
  const count = $("#channel-count");
  count.textContent = members.length ? `${members.length} de ${MAX_CHANNEL_MEMBERS}` : "";
  count.dataset.tone = members.length > MAX_CHANNEL_MEMBERS ? "warn" : "";
}

async function saveChannel(event) {
  event.preventDefault();
  const form = $("#channel-form");
  const error = $("#channel-error");
  error.textContent = "";
  const name = form.elements.name.value.trim();
  const memberIds = selectedMembers();
  if (!name) {
    error.textContent = "Ponle un nombre al canal.";
    form.elements.name.focus();
    return;
  }
  if (!memberIds.length) {
    error.textContent = "Elige al menos un agente.";
    return;
  }
  if (memberIds.length > MAX_CHANNEL_MEMBERS) {
    error.textContent = `Un canal admite hasta ${MAX_CHANNEL_MEMBERS} agentes.`;
    return;
  }
  const body = { name, topic: form.elements.topic.value.trim(), memberIds, leadId: $("#channel-lead").value || null };
  const editing = editingChannelId;
  const button = $("#channel-save");
  button.disabled = true;
  try {
    const result = editing
      ? await api(`/api/channels/${encodeURIComponent(editing)}`, { method: "PATCH", body })
      : await api("/api/channels", { method: "POST", body });
    replaceChannel(result.channel);
    closeDialog($("#channel-dialog"));
    if (!editing) void navigateChannel(result.channel.id);
  } catch (failure) {
    error.textContent = failure.message;
  } finally {
    button.disabled = false;
  }
}

function openDeletedChannels() {
  renderDeletedChannels();
  openDialog($("#deleted-channels-dialog"));
}

function renderDeletedChannelsIfOpen() {
  if ($("#deleted-channels-dialog").open) renderDeletedChannels();
}

function renderDeletedChannels() {
  const list = $("#deleted-channels-list");
  list.replaceChildren();
  const deleted = [...state.deletedChannels].sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0));
  $("#deleted-channels-empty").hidden = deleted.length > 0;
  for (const channel of deleted) {
    const item = document.createElement("li");
    item.className = "deleted-item";
    const texts = document.createElement("div");
    texts.className = "deleted-texts";
    const name = document.createElement("span");
    name.className = "deleted-name";
    name.textContent = channel.name;
    const meta = document.createElement("span");
    meta.className = "deleted-meta";
    meta.textContent = `Eliminado ${formatWhen(channel.deletedAt)} · ${memberSummary(channelMembers(channel))}`;
    texts.append(name, meta);
    const actions = document.createElement("div");
    actions.className = "deleted-actions";
    const restore = smallButton("Restaurar", "ghost");
    restore.addEventListener("click", () => void restoreChannel(channel.id, restore));
    const purge = smallButton("Borrar para siempre", "danger-soft");
    purge.addEventListener("click", () => void purgeChannel(channel.id, purge));
    actions.append(restore, purge);
    item.append(channelGlyph("channel-glyph row-glyph"), texts, actions);
    list.append(item);
  }
}

async function restoreChannel(channelId, button) {
  button.disabled = true;
  try {
    const result = await api(`/api/channels/${encodeURIComponent(channelId)}/restore`, { method: "POST" });
    replaceChannel(result.channel);
    renderDeletedChannels();
    showToast(`Restauraste «${result.channel.name}».`);
  } catch (error) {
    button.disabled = false;
    showToast(error.message, "error");
  }
}

async function purgeChannel(channelId, button) {
  const channel = state.deletedChannels.find((item) => item.id === channelId);
  if (!channel) return;
  const ok = await confirmAction(
    "Borrar para siempre",
    `Se borra «${channel.name}» con todos sus mensajes. No se puede deshacer.`,
    "Borrar para siempre",
  );
  if (!ok) return;
  button.disabled = true;
  try {
    await api(`/api/channels/${encodeURIComponent(channelId)}/permanent`, { method: "DELETE" });
    state.deletedChannels = state.deletedChannels.filter((item) => item.id !== channelId);
    renderDeletedChannels();
    showToast(`Borraste «${channel.name}» para siempre.`);
  } catch (error) {
    button.disabled = false;
    showToast(error.message, "error");
  }
}

// ---------- @ en los canales ----------

/** Con «@» recién escrito en un canal, muestra a los miembros que coinciden. */
function updateMentionMenu() {
  const channel = currentChannel();
  const input = $("#composer-input");
  if (!channel || input.selectionStart !== input.selectionEnd) {
    hideMentionMenu();
    return;
  }
  const before = input.value.slice(0, input.selectionStart);
  const match = /(^|[\s(¿¡"'])@([^\s@]{0,40})$/u.exec(before);
  if (!match) {
    hideMentionMenu();
    return;
  }
  const query = fold(match[2]);
  const options = [
    ...channelMembers(channel).map((agent) => ({
      insert: agent.name,
      label: agent.name,
      detail: agent.id === channel.leadId ? "Encargado" : agent.role,
      agent,
    })),
    { insert: "todos", label: "todos", detail: "Todos los del canal", agent: null },
  ].filter((option) => fold(option.label).startsWith(query) || (query.length > 1 && fold(option.label).includes(query)));
  if (!options.length) {
    hideMentionMenu();
    return;
  }
  const start = before.length - match[2].length - 1;
  const index = mention && mention.start === start ? Math.min(mention.index, options.length - 1) : 0;
  mention = { start, end: input.selectionStart, options, index };
  renderMentionMenu();
}

function renderMentionMenu() {
  const menu = $("#mention-menu");
  menu.replaceChildren();
  mention.options.forEach((option, index) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "mention-option";
    item.id = `mention-${index}`;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(index === mention.index));
    item.tabIndex = -1;
    item.append(option.agent ? blobAvatar(option.agent) : channelGlyph("channel-glyph mention-glyph"));
    const name = document.createElement("span");
    name.className = "mention-name";
    name.textContent = `@${option.label}`;
    item.append(name);
    if (option.detail) {
      const detail = document.createElement("span");
      detail.className = "mention-detail";
      detail.textContent = option.detail;
      item.append(detail);
    }
    // Que tocar la opción no le quite el foco al cuadro de texto.
    item.addEventListener("pointerdown", (event) => event.preventDefault());
    item.addEventListener("click", () => applyMention(index));
    menu.append(item);
  });
  menu.hidden = false;
  menu.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}

function hideMentionMenu() {
  mention = null;
  const menu = $("#mention-menu");
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  menu.replaceChildren();
}

function applyMention(index = mention?.index ?? 0) {
  if (!mention) return;
  const option = mention.options[index];
  if (!option) return;
  const input = $("#composer-input");
  const after = input.value.slice(mention.end);
  const insert = `@${option.insert}${/^\s/.test(after) ? "" : " "}`;
  input.value = input.value.slice(0, mention.start) + insert + after;
  const caret = mention.start + insert.length;
  hideMentionMenu();
  input.focus();
  input.setSelectionRange(caret, caret);
  autosize(input);
  saveDraft();
  updateActionButton();
}

/** Flechas, Enter, Tab y Escape mientras está abierta la lista de @. Devuelve true si la usó. */
function onMentionKeydown(event) {
  if (!mention || $("#mention-menu").hidden || event.isComposing) return false;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    mention.index = (mention.index + step + mention.options.length) % mention.options.length;
    renderMentionMenu();
    return true;
  }
  if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
    event.preventDefault();
    applyMention();
    return true;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    hideMentionMenu();
    return true;
  }
  return false;
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
    state.selection
      ? { label: state.selection.has(agent.id) ? "Desmarcar" : "Marcar", icon: "select", run: () => toggleSelected(agent.id) }
      : { label: "Seleccionar varios", icon: "select", run: () => startSelection([agent.id]) },
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
    { label: "Nuevo canal", icon: "hash", run: () => openChannelDialog() },
    { label: "Nueva sección", icon: "section", run: () => newSection() },
    "-",
    { label: deletedChannelsLabel(), icon: "restore", run: () => openDeletedChannels() },
    {
      label: "Marcar todo como leído",
      icon: "allRead",
      disabled: !state.agents.some((agent) => agent.unread) && !state.channels.some((channel) => channel.unread),
      run: () => markAllRead(),
    },
    state.selection
      ? { label: "Terminar de seleccionar", icon: "close", run: () => endSelection() }
      : { label: "Seleccionar agentes", icon: "select", disabled: !state.agents.some((agent) => !agent.main), run: () => startSelection() },
  ];
}

/** Menú del título «Canales». */
function channelsMenuItems() {
  return [
    { label: "Nuevo canal", icon: "hash", run: () => openChannelDialog() },
    { label: deletedChannelsLabel(), icon: "restore", run: () => openDeletedChannels() },
  ];
}

function deletedChannelsLabel() {
  return state.deletedChannels.length ? `Canales eliminados (${state.deletedChannels.length})` : "Canales eliminados";
}

function channelMenuItems(channelId) {
  const channel = findChannel(channelId);
  if (!channel) return [];
  return [
    { label: "Editar canal", icon: "pencil", run: () => openChannelDialog(channel.id) },
    channel.unread
      ? { label: "Marcar como leído", icon: "check", run: () => setChannelUnread(channel.id, false) }
      : { label: "Marcar como no leído", icon: "unread", run: () => setChannelUnread(channel.id, true) },
    "-",
    { label: "Eliminar canal", icon: "trash", danger: true, run: () => deleteChannel(channel.id) },
  ];
}

function sectionMenuItems(name) {
  const agents = sectionAgents(name);
  return [
    { label: "Nuevo agente aquí", icon: "plus", run: () => openCreateDialog({ project: name }) },
    { label: "Cambiar nombre de la sección", icon: "pencil", run: () => renameSection(name) },
    "-",
    ...(agents.length ? [{ label: "Seleccionar sus agentes", icon: "select", run: () => startSelection(agents.map((agent) => agent.id)) }] : []),
    { label: "Eliminar sección", icon: "trash", danger: true, run: () => deleteSection(name) },
  ];
}

/** Los agentes que se ven bajo la sección (los fijados y los ocultos van en su propio grupo). */
function sectionAgents(name) {
  const key = name.toLowerCase();
  return state.agents.filter((agent) => !agent.main && !agent.hidden && !agent.pinned && agent.project.toLowerCase() === key);
}

/** Qué menú corresponde a lo que se tocó en la barra lateral (o nada, si es un campo o un botón de arriba). */
function sidebarMenuFor(target) {
  if (!(target instanceof Element)) return null;
  if (target.closest("input, textarea, select, .sidebar-footer, .search-box, .sidebar-tools, .select-bar")) return null;
  const channelItem = target.closest(".channel-item");
  if (channelItem) {
    const id = channelItem.dataset.channel;
    return findChannel(id) ? { items: channelMenuItems(id), anchor: channelItem.querySelector(".row-more") ?? channelItem } : null;
  }
  const row = target.closest(".agent-item");
  if (row) return findAgent(row.dataset.id) ? { items: agentMenuItems(row.dataset.id), anchor: row.querySelector(".row-more") ?? row } : null;
  if (target.closest("#bot-card")) {
    const main = mainAgent();
    return main ? { items: agentMenuItems(main.id), anchor: $("#bot-card") } : null;
  }
  const head = target.closest(".group-head[data-section]");
  if (head) return { items: sectionMenuItems(head.dataset.section), anchor: head };
  const channelsHead = target.closest(".group-head[data-channels], .group-action");
  if (channelsHead) return { items: channelsMenuItems(), anchor: channelsHead };
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
  const channel = currentChannel();
  if (channel) {
    try {
      await api(`/api/channels/${encodeURIComponent(channel.id)}/interrupt`, { method: "POST" });
    } catch (error) {
      showToast(error.message, "error");
    }
    return;
  }
  const agent = findAgent(state.currentId);
  if (!agent) return;
  try {
    await api(`/api/agents/${encodeURIComponent(agent.id)}/interrupt`, { method: "POST" });
  } catch (error) {
    showToast(error.message, "error");
  }
}

// ---------- proveedor, modelo y razonamiento (ficha → Modelo) ----------

/** Proveedor para un agente nuevo: el primero con IA instalado y con sesión; si no hay, Claude (pedirá entrar). */
function preferredProvider() {
  return state.providers.find((provider) => provider.id !== "demo" && provider.available && provider.loggedIn !== false)?.id ?? "claude";
}

function fillProviders(form, selected) {
  const select = form.elements.provider;
  select.replaceChildren();
  const preferred = selected ?? preferredProvider();
  for (const provider of state.providers) {
    // Demo no usa IA y no se ofrece: solo figura en un agente que ya lo tenía.
    if (provider.id === "demo" && selected !== "demo") continue;
    const option = document.createElement("option");
    option.value = provider.id;
    const suffix = !provider.available ? " (no instalado)" : provider.loggedIn === false ? " (sin sesión)" : "";
    option.textContent = `${provider.label}${suffix}`;
    select.append(option);
  }
  select.value = preferred;
  updateProviderHint(form);
}

function updateProviderHint(form) {
  const provider = state.providers.find((item) => item.id === form.elements.provider.value);
  const hint = $("#provider-hint");
  hint.textContent = provider && (!provider.available || provider.loggedIn === false) ? (provider.detail ?? "") : "";
  hint.dataset.tone = hint.textContent ? "warn" : "";
}

async function refreshModelOptions(form, model = "", effort = "") {
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
  // Un modelo guardado que es una variante de nivel («Gemini 4 Argon (Medium)») se muestra como modelo + esfuerzo.
  const owner = variantOwner(models, model);
  if (owner) {
    effort ||= Object.entries(owner.variants).find(([, id]) => id === model)?.[0] ?? "";
    model = owner.model;
  }
  if (model && !models.some((entry) => entry.model === model)) modelSelect.append(new Option(model, model));
  modelSelect.value = model;
  modelSelect.disabled = false;
  refreshEffortOptions(form, effort);
}

/** El modelo de la lista que tiene ese id como una de sus variantes de nivel (si no es ya uno de la lista). */
function variantOwner(models, model) {
  if (!model || models.some((entry) => entry.model === model)) return null;
  return models.find((entry) => Object.values(entry.variants ?? {}).includes(model)) ?? null;
}

const EFFORT_LABELS = { none: "Ninguno", minimal: "Mínimo", low: "Bajo", medium: "Medio", high: "Alto", xhigh: "Muy alto", max: "Máximo" };

/** Nombre del modelo del agente para mostrar («Gemini 4 Argon · Alto»), si la lista de su proveedor ya llegó. */
function modelLabel(agent) {
  if (!agent.model) return "";
  const models = state.models.get(agent.provider) ?? [];
  const owner = variantOwner(models, agent.model);
  const entry = owner ?? models.find((item) => item.model === agent.model);
  if (!entry) return agent.model;
  const effort = agent.effort || (owner ? Object.entries(owner.variants).find(([, id]) => id === agent.model)?.[0] : "");
  const name = entry.displayName || entry.model;
  return effort && entry.efforts?.includes(effort) ? `${name} · ${EFFORT_LABELS[effort] ?? effort}` : name;
}

function refreshEffortOptions(form, effort = "") {
  const models = state.models.get(form.elements.provider.value) ?? [];
  const selected = models.find((entry) => entry.model === form.elements.model.value) ?? models.find((entry) => entry.isDefault) ?? models[0];
  const efforts = selected?.efforts ?? [];
  const select = form.elements.effort;
  select.replaceChildren(new Option("Predeterminado", ""));
  for (const value of efforts) select.append(new Option(EFFORT_LABELS[value] ?? value, value));
  if (effort && !efforts.includes(effort)) select.append(new Option(effort, effort));
  select.value = effort;
  select.disabled = efforts.length === 0 && !effort;
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
  $("#create-look").value = agent?.appearance ?? "";
  $("#create-error").textContent = "";
  renderCreateCharacter(agent);
  renderCreatePickers();
  openDialog($("#create-dialog"));
  if (!coarsePointer) name.focus();
}

/** En «Apariencia» de un agente: su personaje de PixelLab y, si PixelLab está conectado, volver a dibujarlo. */
function renderCreateCharacter(agent) {
  const row = $("#create-character");
  const character = agent?.character ?? null;
  if (!agent || !pixelLab?.configured) {
    row.hidden = true;
    return;
  }
  row.hidden = false;
  const label = {
    drawing: "PixelLab está dibujando su personaje…",
    ready: "Su personaje de PixelLab está listo.",
    failed: `No se pudo dibujar: ${character?.error ?? "error de PixelLab"}`,
  }[character?.status] ?? "Aún no tiene personaje de PixelLab.";
  $("#create-character-text").textContent = label;
  const redo = $("#create-character-redo");
  redo.hidden = character?.status === "drawing";
  redo.textContent = character?.status === "ready" ? "Dibujar de nuevo" : "Dibujarlo";
}

async function redrawCharacter() {
  const agentId = createState.agentId;
  if (!agentId) return;
  const button = $("#create-character-redo");
  button.disabled = true;
  try {
    await api(`/api/agents/${encodeURIComponent(agentId)}/character`, { method: "POST" });
    $("#create-character-text").textContent = "PixelLab está dibujando su personaje…";
    button.hidden = true;
  } catch (problem) {
    $("#create-error").textContent = problem.message;
  } finally {
    button.disabled = false;
  }
}

// ---------- la Oficina y PixelLab ----------

function openOffice() {
  closeContextMenu();
  if (location.hash === "#/oficina") return void route();
  state.navigatedInApp = true;
  location.hash = "#/oficina";
}

async function refreshPixelLab() {
  try {
    pixelLab = (await api("/api/pixellab")).pixelLab;
  } catch {
    return;
  }
  renderPixelLab();
}

/** Ajustes («Personajes de la Oficina») y el botón de la Oficina para dibujar los que faltan. */
function renderPixelLab() {
  const configured = Boolean(pixelLab?.configured);
  $("#pixellab-connect").hidden = configured;
  $("#pixellab-connected").hidden = !configured;
  const draw = $("#office-draw");
  const status = $("#office-status");
  const drawing = pixelLab?.drawing?.length ?? 0;
  const missing = pixelLab?.missing ?? 0;
  if (!pixelLab) draw.hidden = true;
  else if (!configured) {
    draw.hidden = false;
    draw.textContent = "Conectar PixelLab";
  } else {
    draw.hidden = drawing > 0 || missing === 0;
    draw.textContent = missing === 1 ? "Dibujar el personaje que falta" : `Dibujar ${missing} personajes`;
  }
  if (drawing) {
    const names = pixelLab.drawing.map((id) => findAgent(id)?.name).filter(Boolean);
    status.textContent = names.length === 1 ? `PixelLab está dibujando a ${names[0]}…` : `PixelLab está dibujando ${drawing} personajes…`;
  } else status.textContent = "";
}

async function connectPixelLab(event) {
  event.preventDefault();
  const input = $("#pixellab-token");
  const error = $("#pixellab-error");
  const button = $("#pixellab-save");
  error.textContent = "";
  if (!input.value.trim()) {
    error.textContent = "Pega el token de tu cuenta de PixelLab.";
    input.focus();
    return;
  }
  button.disabled = true;
  button.textContent = "Comprobando…";
  try {
    pixelLab = (await api("/api/pixellab", { method: "PUT", body: { token: input.value } })).pixelLab;
    input.value = "";
    renderPixelLab();
    showToast("PixelLab quedó conectado.", "info");
  } catch (problem) {
    error.textContent = problem.message;
  } finally {
    button.disabled = false;
    button.textContent = "Conectar";
  }
}

async function disconnectPixelLab() {
  const ok = await confirmAction("¿Quitar PixelLab?", "Los personajes que ya tienen se quedan; los agentes nuevos usarán el que dibuja ClosedBot.", "Quitar");
  if (!ok) return;
  try {
    pixelLab = (await api("/api/pixellab", { method: "DELETE" })).pixelLab;
    renderPixelLab();
  } catch (problem) {
    showToast(problem.message, "error");
  }
}

async function drawMissingCharacters() {
  if (!pixelLab?.configured) {
    openSettings();
    $("#pixellab-token").focus();
    return;
  }
  const button = $("#office-draw");
  button.disabled = true;
  try {
    const result = await api("/api/office/characters", { method: "POST", body: {} });
    pixelLab = result.pixelLab;
    renderPixelLab();
  } catch (problem) {
    showToast(problem.message, "error");
  } finally {
    button.disabled = false;
  }
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
  const appearance = $("#create-look").value.trim();
  const button = $("#create-save");
  button.disabled = true;
  try {
    if (createState.agentId) {
      const before = findAgent(createState.agentId);
      // Un aspecto nuevo se vuelve a dibujar con PixelLab: solo se envía si cambió.
      const body = { name, avatar, ...(appearance !== (before?.appearance ?? "") ? { appearance } : {}) };
      const result = await api(`/api/agents/${encodeURIComponent(createState.agentId)}`, { method: "PATCH", body });
      closeDialog($("#create-dialog"));
      replaceAgent(result.agent);
    } else {
      // greet: como lo creaste tú, se presenta con un primer mensaje (los que arma Claude Bot no).
      const body = { name, avatar, appearance, project: createState.project, provider: preferredProvider(), greet: true };
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
  renderPermissions();
  renderTtsSettings();
  $("#pixellab-error").textContent = "";
  renderPixelLab();
  void refreshPixelLab();
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
    if (provider.id === "demo") continue; // No usa IA: no se muestra.
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
    // Lo que respondió el proveedor la última vez que no se pudo entrar.
    if (provider.problem && !provider.signIn && !provider.install) {
      const problem = document.createElement("div");
      problem.className = "detail problem";
      problem.textContent = provider.problem;
      item.append(problem);
    }
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
    // Antigravity (Gemini) no tiene cómo cerrar la sesión: no se ofrece.
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
  gemini: "Se descarga Antigravity, el programa oficial de Google para usar Gemini (desde dl.google.com; ocupa unos 200 MB), en la carpeta de ClosedBot. Después entras con tu cuenta de Google.",
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

// ---------- ficha del agente: ajustes por secciones, como OpenBot ----------

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
const PAGE_TITLES = {
  profile: "Perfil",
  brain: "Modelo",
  instructions: "Instrucciones",
  memories: "Recuerdos",
  skills: "Habilidades",
  files: "Archivos",
  routines: "Rutinas",
  voice: "Chat de voz",
  folders: "Carpetas",
  access: "Acceso",
  advanced: "Avanzado",
  notify: "Avisarme",
};
const NOTIFY_LABELS = { all: "Toda la actividad", needs: "Solo cuando me necesite", none: "Nada" };
const MEMORY_MAX = 64;

const details = {
  agentId: null,
  /** Subpantalla abierta; null = la lista de ajustes. */
  page: null,
  root: "agent",
  path: "",
  library: null,
  loading: false,
  request: 0,
  uploading: false,
  /** Recuerdos y habilidades del agente abierto: { agentId, items }. */
  memories: null,
  skills: null,
  /** Instrucciones como se leyeron de AGENTS.md: { agentId, base, loading, error }. */
  instructions: null,
  /** Habilidad que se está editando: "new" o su id. */
  skillEditing: null,
  /** Recuerdo que se está editando en su lugar (mientras tanto la lista no se repinta). */
  memoryEditing: null,
  /** Rutinas con el historial abierto y lo que se leyó de cada una. */
  openRuns: new Set(),
  runs: new Map(),
};

function openDetails(agentId = state.currentId, page = null) {
  closeContextMenu();
  const agent = findAgent(agentId);
  if (!agent) return;
  if (details.agentId !== agent.id) {
    details.root = "agent";
    details.path = "";
    details.library = null;
    details.memories = null;
    details.skills = null;
    details.instructions = null;
    details.skillEditing = null;
    details.memoryEditing = null;
    details.openRuns.clear();
    details.runs.clear();
  }
  details.agentId = agent.id;
  showPage(page, { focus: false });
  openDialog($("#details-dialog"));
  void loadMemories(agent.id);
  void loadSkills(agent.id);
}

/** Cambia de subpantalla (null = la lista de ajustes). Las que se editan se llenan al entrar, no al refrescar. */
function showPage(page, { focus = true } = {}) {
  const previous = details.page;
  details.page = page;
  const agent = findAgent(details.agentId);
  if (page === "files") details.library = null;
  if (page === "instructions") details.instructions = null;
  if (page === "skills") details.skillEditing = null;
  if (page === "profile" && agent) fillProfileForm(agent);
  if (page === "brain" && agent) void fillBrainForm(agent);
  if (page === "memories") {
    details.memoryEditing = null;
    resetMemoryForm();
  }
  $("#details-home").hidden = page !== null;
  $("#details-sub").hidden = page === null;
  for (const node of document.querySelectorAll("#details-sub .page")) node.hidden = node.dataset.page !== page;
  $("#page-title").textContent = page ? (PAGE_TITLES[page] ?? "") : "";
  renderDetails();
  if (page) $("#page-body").scrollTop = 0;
  if (!focus) return;
  if (page) $("#page-title").focus({ preventScroll: true });
  else document.querySelector(`#details-groups [data-page="${previous}"]`)?.focus({ preventScroll: true });
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
  renderDetailsHeader(agent);
  if (details.page === null) renderSettingsHome(agent);
  else renderPage(agent);
}

function renderDetailsHeader(agent) {
  const avatar = $("#details-avatar");
  const key = `${agent.id}:${agent.avatar}:${agent.main}`;
  if (avatar.dataset.key !== key) {
    avatar.replaceChildren(blobAvatar(agent));
    avatar.dataset.key = key;
  }
  avatar.disabled = Boolean(agent.main);
  avatar.title = agent.main ? agent.name : "Cambiar figura y color";
  $("#details-name").textContent = agent.name;
  $("#details-title").textContent = agent.role || (agent.main ? "Bot principal" : "Asistente general");
  const description = $("#details-description");
  description.textContent = agent.description || "Agrega una descripción";
  description.dataset.empty = String(!agent.description);
}

function renderSettingsHome(agent) {
  for (const row of document.querySelectorAll("#details-groups .row-icon:empty")) row.append(icon(row.dataset.icon));
  $("#row-brain").textContent = [providerLabel(agent.provider), modelLabel(agent) || "Predeterminado"].join(" · ");
  $("#row-instructions").textContent = agent.instructions ? agent.instructions.replace(/\s+/g, " ").slice(0, 80) : "Sin instrucciones";
  const memories = details.memories?.agentId === agent.id ? details.memories.items : null;
  $("#row-memories").textContent = memories === null ? "" : memories.length ? String(memories.length) : "Ninguno";
  const skills = details.skills?.agentId === agent.id ? details.skills.items : null;
  $("#row-skills").textContent = skills === null ? "" : skills.length ? String(skills.filter((skill) => skill.enabled).length) : "Ninguna";
  const routines = state.routines.filter((routine) => routine.agentId === agent.id);
  const active = routines.filter((routine) => routine.enabled).length;
  $("#row-routines").textContent = routines.length ? (active === routines.length ? String(active) : `${active} de ${routines.length} activas`) : "Ninguna";
  const voice = { ...DEFAULT_VOICE, ...(agent.voice ?? {}) };
  $("#row-voice").textContent = voice.autoRead ? "Lee sus respuestas" : "";
  const full = Boolean(state.settings.fullAccess);
  $("#row-access-button").hidden = full;
  $("#row-access").textContent = agent.access === "total" ? "Acceso total" : "Solo su carpeta";
  $("#row-advanced").textContent = agent.paused ? "Cola en pausa" : "";
  $("#row-notify").textContent = NOTIFY_LABELS[agent.notify] ?? "";
  $("#details-delete").hidden = Boolean(agent.main);
}

function renderPage(agent) {
  switch (details.page) {
    case "profile":
      updateDescriptionCount();
      break;
    case "instructions":
      renderInstructionsPage(agent);
      break;
    case "memories":
      renderMemories(agent);
      break;
    case "skills":
      renderSkills(agent);
      break;
    case "files":
      renderLibrary(agent);
      break;
    case "routines":
      renderDetailsRoutines(agent);
      break;
    case "voice":
      renderVoiceSettings(agent);
      break;
    case "folders":
      renderFolders(agent);
      break;
    case "access":
      renderAccessPage(agent);
      break;
    case "advanced":
      $("#details-pause").setAttribute("aria-checked", String(agent.paused));
      break;
    case "notify":
      renderNotifyPage(agent);
      break;
    default:
      break;
  }
}

// Perfil: nombre, título, descripción y sección.

function fillProfileForm(agent) {
  const form = $("#profile-form");
  form.elements.name.value = agent.name;
  form.elements.role.value = agent.role;
  form.elements.role.placeholder = agent.main ? "Ej.: Bot principal: arma y coordina mis equipos" : "Ej.: Investigadora de mercado";
  form.elements.description.value = agent.description ?? "";
  form.elements.project.value = agent.project;
  $("#profile-project").hidden = Boolean(agent.main);
  $("#project-options").replaceChildren(...allSections().map((section) => new Option(section, section)));
  $("#profile-error").textContent = "";
  updateDescriptionCount();
}

function updateDescriptionCount() {
  const length = $("#profile-form").elements.description.value.length;
  $("#description-count").textContent = length > 1500 ? `${length} / 2000` : "";
}

async function saveProfile(event) {
  event.preventDefault();
  const agent = findAgent(details.agentId);
  if (!agent) return;
  const form = $("#profile-form");
  const error = $("#profile-error");
  error.textContent = "";
  const name = form.elements.name.value.trim();
  if (!name) {
    error.textContent = "Ponle un nombre al agente.";
    form.elements.name.focus();
    return;
  }
  const body = {
    name,
    role: form.elements.role.value,
    description: form.elements.description.value,
    ...(agent.main ? {} : { project: form.elements.project.value }),
  };
  const button = $("#profile-save");
  button.disabled = true;
  try {
    const result = await api(`/api/agents/${encodeURIComponent(agent.id)}`, { method: "PATCH", body });
    replaceAgent(result.agent);
    showPage(null);
  } catch (problem) {
    error.textContent = problem.message;
  } finally {
    button.disabled = false;
  }
}

// Cerebro: proveedor, modelo y razonamiento.

async function fillBrainForm(agent) {
  const form = $("#brain-form");
  $("#brain-error").textContent = "";
  fillProviders(form, agent.provider);
  await refreshModelOptions(form, agent.model ?? "", agent.effort ?? "");
}

async function saveBrain(event) {
  event.preventDefault();
  const agent = findAgent(details.agentId);
  if (!agent) return;
  const form = $("#brain-form");
  const provider = form.elements.provider.value;
  if (provider !== agent.provider) {
    const ok = await confirmAction(
      `¿Cambiar a ${providerLabel(provider)}?`,
      `Su próxima respuesta empieza una conversación nueva: no recordará lo que hablaron. Sus instrucciones, recuerdos, habilidades y archivos se mantienen.`,
      "Cambiar",
      "primary",
    );
    if (!ok) return;
  }
  const button = $("#brain-save");
  button.disabled = true;
  try {
    const result = await api(`/api/agents/${encodeURIComponent(agent.id)}`, {
      method: "PATCH",
      body: { provider, model: form.elements.model.value || null, effort: form.elements.effort.value || null },
    });
    replaceAgent(result.agent);
    showPage(null);
  } catch (problem) {
    $("#brain-error").textContent = problem.message;
  } finally {
    button.disabled = false;
  }
}

// Sabe → Instrucciones: su AGENTS.md (el agente también lo edita).

function renderInstructionsPage(agent) {
  const current = details.instructions;
  if (!current || current.agentId !== agent.id) {
    void loadInstructions(agent.id);
    return;
  }
  $("#instructions-lead").textContent = agent.main
    ? "Tus preferencias para armar equipos. Están en el archivo AGENTS.md de su carpeta."
    : "Están en el archivo AGENTS.md de su carpeta: el agente también puede cambiarlas si se lo pides.";
  const editor = $("#instructions-text");
  editor.disabled = current.loading;
  editor.placeholder = current.loading
    ? "Cargando…"
    : agent.main
      ? "Ej.: equipos de 3 agentes como máximo; usa Sonnet para tareas simples; escríbeme siempre en español."
      : "Cómo quieres que trabaje, qué debe priorizar, qué entrega y cuándo pedir ayuda…";
  $("#instructions-error").textContent = current.error ?? "";
  updateInstructionsCount();
}

async function loadInstructions(agentId) {
  details.instructions = { agentId, base: "", loading: true, error: null };
  $("#instructions-text").value = "";
  renderDetailsIfOpen();
  try {
    const data = await api(`/api/agents/${encodeURIComponent(agentId)}/instructions`);
    if (details.instructions?.agentId !== agentId) return;
    details.instructions = { agentId, base: data.text, loading: false, error: null };
    $("#instructions-text").value = data.text;
  } catch (error) {
    if (details.instructions?.agentId !== agentId) return;
    details.instructions = { agentId, base: "", loading: false, error: error.message };
  }
  renderDetailsIfOpen();
}

function updateInstructionsCount() {
  const length = $("#instructions-text").value.length;
  $("#instructions-count").textContent = `${length.toLocaleString("es")} / 32.000`;
}

async function saveInstructions({ force = false } = {}) {
  const agent = findAgent(details.agentId);
  const current = details.instructions;
  if (!agent || !current || current.loading) return;
  const text = $("#instructions-text").value;
  const button = $("#instructions-save");
  button.disabled = true;
  $("#instructions-error").textContent = "";
  try {
    const result = await api(`/api/agents/${encodeURIComponent(agent.id)}/instructions`, {
      method: "PUT",
      body: force ? { text } : { text, base: current.base },
    });
    replaceAgent(result.agent);
    details.instructions = { ...current, base: text.trim() };
    showToast("Instrucciones guardadas: las usa desde su próximo mensaje.");
  } catch (error) {
    if (error.status === 409) {
      const ok = await confirmAction(
        `${agent.name} cambió sus instrucciones`,
        "Mientras editabas, el agente cambió su AGENTS.md. ¿Guardar tu versión de todos modos? Se pierde lo que cambió él.",
        "Guardar la mía",
        "primary",
      );
      if (ok) {
        button.disabled = false;
        await saveInstructions({ force: true });
        return;
      }
    } else {
      $("#instructions-error").textContent = error.message;
    }
  } finally {
    button.disabled = false;
  }
}

// Sabe → Recuerdos.

async function loadMemories(agentId) {
  try {
    const data = await api(`/api/agents/${encodeURIComponent(agentId)}/memories`);
    if (details.agentId !== agentId) return;
    details.memories = { agentId, items: data.memories };
    renderDetailsIfOpen();
  } catch {
    // Sin recuerdos que mostrar: la fila queda sin número.
  }
}

function resetMemoryForm() {
  const form = $("#memory-form");
  form.reset();
  $("#memory-error").textContent = "";
}

function renderMemories(agent) {
  const items = details.memories?.agentId === agent.id ? details.memories.items : [];
  $("#memories-count").textContent = items.length ? `${items.length} de ${MEMORY_MAX}` : "";
  const full = items.length >= MEMORY_MAX;
  $("#memory-save").disabled = full;
  const error = $("#memory-error");
  if (full) error.textContent = `Ya tiene ${MEMORY_MAX} recuerdos: borra alguno para guardar otro.`;
  else if (error.dataset.full === "true") error.textContent = "";
  error.dataset.full = String(full);
  if (details.memoryEditing && items.some((memory) => memory.id === details.memoryEditing)) return;
  details.memoryEditing = null;
  const always = items.filter((memory) => memory.always);
  const relevant = items.filter((memory) => !memory.always);
  $("#memories-always").replaceChildren(...always.map((memory) => memoryItem(agent, memory)));
  $("#memories-relevant").replaceChildren(...relevant.map((memory) => memoryItem(agent, memory)));
  $("#memories-always-empty").hidden = always.length > 0;
  $("#memories-relevant-empty").hidden = relevant.length > 0;
}

function memoryItem(agent, memory) {
  const item = document.createElement("li");
  item.className = "item";
  const body = document.createElement("div");
  body.className = "item-body";
  const text = document.createElement("p");
  text.className = "item-text";
  text.textContent = memory.text;
  const meta = document.createElement("p");
  meta.className = "item-meta";
  meta.textContent = `${memory.createdBy === "agent" ? `Lo guardó ${agent.name}` : "Lo guardaste tú"} · ${formatTime(memory.createdAt)}`;
  body.append(text, meta);
  const actions = document.createElement("div");
  actions.className = "item-actions";
  actions.append(
    iconButton(memory.always ? "arrowDown" : "arrowUp", memory.always ? "Usar solo si hace falta" : "Usar siempre", () => void patchMemory(memory.id, { always: !memory.always })),
    iconButton("pencil", "Editar", () => editMemory(item, memory)),
    iconButton("trash", "Borrar", () => void removeMemory(memory)),
  );
  item.append(body, actions);
  return item;
}

function iconButton(name, label, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-button";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(icon(name));
  button.addEventListener("click", onClick);
  return button;
}

/** Edita el texto de un recuerdo en su lugar. */
function editMemory(item, memory) {
  const form = document.createElement("form");
  form.className = "item-edit";
  const input = document.createElement("textarea");
  input.rows = 3;
  input.maxLength = 1000;
  input.value = memory.text;
  input.setAttribute("aria-label", "Recuerdo");
  const row = document.createElement("div");
  row.className = "page-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "button ghost small";
  cancel.textContent = "Cancelar";
  cancel.addEventListener("click", () => {
    details.memoryEditing = null;
    renderDetailsIfOpen();
  });
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "button primary small";
  save.textContent = "Guardar";
  row.append(cancel, save);
  form.append(input, row);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void patchMemory(memory.id, { text: input.value });
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) form.requestSubmit();
  });
  details.memoryEditing = memory.id;
  item.replaceChildren(form);
  input.focus();
}

async function saveMemory(event) {
  event.preventDefault();
  const agentId = details.agentId;
  const form = $("#memory-form");
  const text = form.elements.text.value.trim();
  if (!text) {
    form.elements.text.focus();
    return;
  }
  $("#memory-error").textContent = "";
  try {
    await api(`/api/agents/${encodeURIComponent(agentId)}/memories`, { method: "POST", body: { text, always: form.elements.always.checked } });
    form.reset();
    await loadMemories(agentId);
  } catch (error) {
    $("#memory-error").textContent = error.message;
  }
}

async function patchMemory(id, body) {
  try {
    await api(`/api/memories/${encodeURIComponent(id)}`, { method: "PATCH", body });
    if (details.memoryEditing === id) details.memoryEditing = null;
    await loadMemories(details.agentId);
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function removeMemory(memory) {
  const ok = await confirmAction("¿Borrar este recuerdo?", memory.text.length > 160 ? `${memory.text.slice(0, 160)}…` : memory.text, "Borrar");
  if (!ok) return;
  try {
    await api(`/api/memories/${encodeURIComponent(memory.id)}`, { method: "DELETE" });
    await loadMemories(details.agentId);
  } catch (error) {
    showToast(error.message, "error");
  }
}

// Sabe → Habilidades: carpetas con un SKILL.md en la carpeta del agente.

async function loadSkills(agentId) {
  try {
    const data = await api(`/api/agents/${encodeURIComponent(agentId)}/skills`);
    if (details.agentId !== agentId) return;
    details.skills = { agentId, items: data.skills };
    renderDetailsIfOpen();
  } catch {
    // Sin habilidades que mostrar.
  }
}

function renderSkills(agent) {
  const items = details.skills?.agentId === agent.id ? details.skills.items : [];
  const editing = details.skillEditing;
  $("#skills-list").replaceChildren(...items.map((skill) => skillItem(agent, skill)));
  $("#skills-list").hidden = Boolean(editing);
  $("#skills-empty").hidden = items.length > 0 || Boolean(editing);
  $("#skill-actions").hidden = Boolean(editing);
  $("#skill-form").hidden = !editing;
}

function skillItem(agent, skill) {
  const item = document.createElement("li");
  item.className = "item";
  item.dataset.enabled = String(skill.enabled);
  const body = document.createElement("div");
  body.className = "item-body";
  const name = document.createElement("p");
  name.className = "item-name";
  name.textContent = skill.name;
  const text = document.createElement("p");
  text.className = "item-meta";
  text.textContent = skill.description || skill.file;
  body.append(name, text);
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "switch";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-checked", String(skill.enabled));
  toggle.setAttribute("aria-label", skill.enabled ? `Apagar «${skill.name}»` : `Encender «${skill.name}»`);
  toggle.addEventListener("click", () => void setSkillEnabled(agent.id, skill, !skill.enabled));
  const actions = document.createElement("div");
  actions.className = "item-actions";
  actions.append(
    iconButton("pencil", "Editar", () => void editSkill(agent.id, skill)),
    iconButton("trash", "Eliminar", () => void removeSkill(agent.id, skill)),
    toggle,
  );
  item.append(body, actions);
  return item;
}

function skillUrl(agentId, skillId) {
  return `/api/agents/${encodeURIComponent(agentId)}/skill?id=${encodeURIComponent(skillId)}`;
}

function newSkill() {
  details.skillEditing = "new";
  const form = $("#skill-form");
  form.reset();
  $("#skill-form-title").textContent = "Nueva habilidad";
  $("#skill-fields").hidden = false;
  $("#skill-raw").hidden = true;
  $("#skill-error").textContent = "";
  renderDetailsIfOpen();
  form.elements.name.focus();
}

async function editSkill(agentId, skill) {
  try {
    const data = await api(skillUrl(agentId, skill.id));
    details.skillEditing = skill.id;
    const form = $("#skill-form");
    form.reset();
    $("#skill-form-title").textContent = skill.name;
    $("#skill-fields").hidden = true;
    $("#skill-raw").hidden = false;
    form.elements.text.value = data.text;
    $("#skill-error").textContent = "";
    renderDetailsIfOpen();
    form.elements.text.focus();
  } catch (error) {
    showToast(error.message, "error");
  }
}

function closeSkillForm() {
  details.skillEditing = null;
  renderDetailsIfOpen();
}

async function saveSkill(event) {
  event.preventDefault();
  const agentId = details.agentId;
  const form = $("#skill-form");
  const editing = details.skillEditing;
  $("#skill-error").textContent = "";
  const button = $("#skill-save");
  button.disabled = true;
  try {
    if (editing === "new") {
      await api(`/api/agents/${encodeURIComponent(agentId)}/skills`, {
        method: "POST",
        body: { name: form.elements.name.value, description: form.elements.description.value, body: form.elements.body.value },
      });
    } else {
      await api(skillUrl(agentId, editing), { method: "PUT", body: { text: form.elements.text.value } });
    }
    details.skillEditing = null;
    await loadSkills(agentId);
    showToast("Habilidad guardada: la usa desde su próximo mensaje.");
  } catch (error) {
    $("#skill-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function setSkillEnabled(agentId, skill, enabled) {
  try {
    await api(skillUrl(agentId, skill.id), { method: "PATCH", body: { enabled } });
    await loadSkills(agentId);
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function removeSkill(agentId, skill) {
  const ok = await confirmAction(`¿Eliminar «${skill.name}»?`, `Se borra su carpeta (${skill.id}) con todo lo que tenga.`, "Eliminar");
  if (!ok) return;
  try {
    await api(skillUrl(agentId, skill.id), { method: "DELETE" });
    await loadSkills(agentId);
  } catch (error) {
    showToast(error.message, "error");
  }
}

// Hace → Rutinas: con «Probar ahora» e historial.

function renderDetailsRoutines(agent) {
  const routines = state.routines.filter((routine) => routine.agentId === agent.id);
  $("#details-routines").replaceChildren(...routines.map((routine) => detailsRoutine(routine)));
  $("#details-routines-empty").hidden = routines.length > 0;
}

function detailsRoutine(routine) {
  const item = document.createElement("li");
  item.className = "item routine-item";
  item.dataset.enabled = String(routine.enabled);
  const body = document.createElement("div");
  body.className = "item-body";
  const name = document.createElement("p");
  name.className = "item-name";
  name.textContent = routine.name;
  const meta = document.createElement("p");
  meta.className = "item-meta";
  const when = routine.running
    ? "en curso…"
    : routine.enabled
      ? routine.nextRunAt
        ? `próxima: ${formatWhen(routine.nextRunAt)}`
        : "sin próxima ejecución"
      : "en pausa";
  meta.textContent = [routine.description, when].filter(Boolean).join(" · ");
  const prompt = document.createElement("p");
  prompt.className = "item-text small-text";
  prompt.textContent = routine.prompt;
  body.append(name, meta, prompt);
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "switch";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-checked", String(routine.enabled));
  toggle.setAttribute("aria-label", routine.enabled ? `Pausar «${routine.name}»` : `Activar «${routine.name}»`);
  toggle.addEventListener("click", () => void routineRequest(`/api/routines/${encodeURIComponent(routine.id)}`, "PATCH", { enabled: !routine.enabled }));
  const head = document.createElement("div");
  head.className = "item-head";
  head.append(body, toggle);
  const actions = document.createElement("div");
  actions.className = "item-buttons";
  const run = document.createElement("button");
  run.type = "button";
  run.className = "button ghost small";
  run.textContent = routine.running ? "En curso…" : "Probar ahora";
  run.disabled = routine.running;
  run.addEventListener("click", async () => {
    if (await routineRequest(`/api/routines/${encodeURIComponent(routine.id)}/run`, "POST")) {
      details.openRuns.add(routine.id);
      void loadRuns(routine.id);
      showToast(`«${routine.name}» quedó en su cola.`);
    }
  });
  const open = details.openRuns.has(routine.id);
  const history = document.createElement("button");
  history.type = "button";
  history.className = "button ghost small";
  history.textContent = open ? "Ocultar historial" : "Historial";
  history.setAttribute("aria-expanded", String(open));
  history.addEventListener("click", () => {
    if (details.openRuns.has(routine.id)) details.openRuns.delete(routine.id);
    else {
      details.openRuns.add(routine.id);
      void loadRuns(routine.id);
    }
    renderDetailsIfOpen();
  });
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "button danger-soft small";
  remove.textContent = "Eliminar";
  remove.addEventListener("click", async () => {
    const ok = await confirmAction(`¿Eliminar la rutina «${routine.name}»?`, "Deja de ejecutarse. Lo que ya hizo queda en la conversación.", "Eliminar");
    if (ok) await routineRequest(`/api/routines/${encodeURIComponent(routine.id)}`, "DELETE");
  });
  actions.append(run, history, remove);
  item.append(head, actions);
  if (open) item.append(routineHistory(routine));
  return item;
}

async function loadRuns(routineId) {
  try {
    const data = await api(`/api/routines/${encodeURIComponent(routineId)}/runs`);
    details.runs.set(routineId, data.runs);
  } catch (error) {
    details.runs.set(routineId, { error: error.message });
  }
  renderDetailsIfOpen();
}

const RUN_STATUS = {
  queued: "En cola",
  starting: "Empezando…",
  running: "En curso…",
  completed: "Terminó",
  failed: "Falló",
  interrupted: "Se detuvo",
  cancelled: "Cancelada",
  missing: "Sin datos",
};

function routineHistory(routine) {
  const list = document.createElement("ul");
  list.className = "run-list";
  const runs = details.runs.get(routine.id);
  const note = (text) => {
    const item = document.createElement("li");
    item.className = "run-empty";
    item.textContent = text;
    return item;
  };
  if (!runs) list.append(note("Cargando…"));
  else if (runs.error) list.append(note(runs.error));
  else if (!runs.length) list.append(note("Todavía no ha corrido."));
  else {
    for (const run of runs) {
      const item = document.createElement("li");
      item.className = "run";
      item.dataset.status = run.status;
      const head = document.createElement("p");
      head.className = "run-head";
      head.textContent = `${formatWhen(run.at)} · ${RUN_STATUS[run.status] ?? run.status}${run.manual ? " · a mano" : ""}`;
      item.append(head);
      const detail = run.error || run.reply;
      if (detail) {
        const text = document.createElement("p");
        text.className = "run-text";
        text.textContent = detail;
        item.append(text);
      }
      list.append(item);
    }
  }
  return list;
}

// Hace → Chat de voz.

function renderVoiceSettings(agent) {
  const voice = { ...DEFAULT_VOICE, ...(agent.voice ?? {}) };
  const lang = voice.lang === "auto" ? speechLanguage() : voice.lang;
  const local = localVoicesFor(lang);
  const canSpeak = local.length > 0;
  $("#voice-unsupported").hidden = Boolean(AudioCtx);
  const select = $("#voice-name");
  const key = `${agent.id}|${lang}|${voice.name}|${local.length}`;
  if (select.dataset.key !== key && document.activeElement !== select) {
    select.replaceChildren(new Option("Automática", ""), ...local.map((item) => new Option(item.label, `${LOCAL_PREFIX}${item.id}`)));
    // Una voz de Edge elegida antes ya no se usa: queda «Automática».
    select.value = local.some((item) => `${LOCAL_PREFIX}${item.id}` === voice.name) ? voice.name : "";
    select.dataset.key = key;
  }
  select.disabled = !canSpeak;
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
  auto.disabled = !canSpeak;
  $("#voice-test").disabled = !canSpeak;
  renderLocalVoicesOffer();
}

function formatRate(value) {
  return `${(Number.isFinite(value) ? value : 1).toLocaleString("es", { minimumFractionDigits: 1, maximumFractionDigits: 2 })}×`;
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
  // Las voces de OpenBot leen todos estos idiomas: la elegida se queda. Una de Edge de antes vuelve a «Automática».
  void saveVoice(isLocalVoice(agent?.voice?.name) ? { lang: value } : { lang: value, name: "" });
}

function testVoice() {
  const agent = findAgent(details.agentId);
  if (!agent || !canReadAloud()) return;
  primeAudio();
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

// Sabe → Archivos: su carpeta o la compartida.

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
  if (!agent || details.page !== "files") return;
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

// Reglas → Carpetas y Acceso.

function renderFolders(agent) {
  $("#computer-workspace").textContent = agent.workspace || "—";
  $("#computer-shared").textContent = state.paths?.shared ?? "—";
  const local = isThisComputer();
  for (const button of document.querySelectorAll('#details-sub .page[data-page="folders"] [data-local-only]')) button.hidden = !local;
  $("#computer-remote").hidden = local;
}

function renderAccessPage(agent) {
  const form = $("#access-form");
  if (document.activeElement?.name !== "access") form.elements.access.value = agent.access;
  $("#access-warning").hidden = agent.access !== "total";
  $("#access-hint").hidden = !(state.platform === "win32" && agent.provider === "claude" && agent.access === "carpeta");
}

async function changeAccess(value) {
  const agent = findAgent(details.agentId);
  if (!agent || value === agent.access) return;
  if (value === "total") {
    const ok = await confirmAction(
      `¿Dar acceso total a ${agent.name}?`,
      "Podrá ejecutar comandos, instalar programas y borrar o leer cualquier archivo del equipo sin preguntarte. Los conectores de tu cuenta de Claude siguen fuera de su alcance.",
      "Dar acceso total",
    );
    if (!ok) {
      renderDetailsIfOpen();
      return;
    }
  }
  await patchAgent(agent.id, { access: value });
  renderDetailsIfOpen();
}

// Reglas → Avisarme.

function renderNotifyPage(agent) {
  const form = $("#notify-form");
  form.elements.notify.value = agent.notify;
  const status = $("#notify-status");
  const enable = $("#notify-enable");
  enable.hidden = true;
  if (!("Notification" in window) || !window.isSecureContext) {
    status.textContent = "Este navegador no muestra avisos. Ábrelo en la app de escritorio de ClosedBot.";
  } else if (Notification.permission === "granted") {
    status.textContent = "En este equipo aparecen mientras ClosedBot esté abierta, aunque esté minimizada.";
  } else if (Notification.permission === "denied") {
    status.textContent = "Los avisos están bloqueados en este navegador: permítelos en la configuración del sitio.";
  } else {
    status.textContent = "Para verlos en este equipo, permite los avisos.";
    enable.hidden = false;
  }
}

async function enableNotifications() {
  if (!("Notification" in window)) return;
  try {
    await Notification.requestPermission();
  } catch {
    // Algunos navegadores viejos usan una función con callback: no importa, se vuelve a mirar el permiso.
  }
  renderDetailsIfOpen();
  if (Notification.permission === "granted") showToast("Listo: los avisos aparecerán en este equipo.");
}

/** Un aviso del servidor («Avisarme»): se muestra en el sistema si ClosedBot no está a la vista o es otra conversación. */
async function showAlert(alert) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const key = alert.channelId ? `c:${alert.channelId}` : alert.agentId;
  const looking = document.visibilityState === "visible" && document.hasFocus();
  if (looking && convKey() === key) return;
  if (looking && alert.kind === "reply") return;
  const hash = alert.channelId ? `#/c/${encodeURIComponent(alert.channelId)}` : `#/a/${encodeURIComponent(alert.agentId)}`;
  const options = { body: alert.body, tag: `closedbot:${key}`, icon: "/icons/icon-192.png", data: { url: `/${hash}` } };
  try {
    const registration = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (registration) {
      await registration.showNotification(alert.title, options);
      return;
    }
    const notification = new Notification(alert.title, options);
    notification.onclick = () => {
      window.focus();
      location.hash = hash;
      notification.close();
    };
  } catch {
    // Sin permiso o sin soporte: el aviso de no leído de la barra lateral sigue ahí.
  }
}

async function setNotify(value) {
  const agent = findAgent(details.agentId);
  if (!agent || value === agent.notify) return;
  await patchAgent(agent.id, { notify: value });
  renderDetailsIfOpen();
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

/** Lo que se está leyendo (`current`) y lo que espera su turno (`queue`); `token` invalida lo que se canceló. */
const speech = {
  current: null,
  queue: [],
  token: 0,
  /** El AudioContext, la parte que suena y las descargas en curso. */
  audio: null,
  source: null,
  abort: null,
};
/** Respuestas a lo que dijiste con el botón de voz: se leen aunque «Leer sus respuestas» esté apagado. */
let voiceReply = null;

const LANGUAGE_WORDS = {
  es: "el la los las del al es son pero muy también cuando hola gracias y lo su sus hay una un con por en qué cómo más esto eso puedo quieres tienes".split(" "),
  en: "the and is are you that this with for have was not but what can will your from about hello thanks it of to in on we they be if or an".split(" "),
  pt: "o os um uma com em mais muito também quando olá obrigado obrigada e é são mas seu sua há não você isso então já do da dos das na ao".split(" "),
};
const LANGUAGE_SETS = Object.fromEntries(Object.entries(LANGUAGE_WORDS).map(([lang, words]) => [lang, new Set(words)]));

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

/** La voz elegida o, en «Automática», la primera (`{ local: "F1" }`). null si no hay voces para ese idioma. */
function pickVoice(name, lang) {
  const local = localVoicesFor(lang);
  if (!local.length) return null;
  const id = isLocalVoice(name) ? name.slice(LOCAL_PREFIX.length) : "";
  return { local: local.some((item) => item.id === id) ? id : local[0].id };
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

/** El audio solo suena si se activó con un toque (Safari, Chrome): se crea o se despierta aquí. */
function primeAudio() {
  if (!AudioCtx || !localVoicesReady()) return;
  try {
    speech.audio ??= new AudioCtx();
    if (speech.audio.state === "suspended") void speech.audio.resume().catch(() => undefined);
  } catch {
    // Sin audio: se avisa al leer.
  }
}

function stopSpeaking() {
  speech.token += 1;
  speech.queue = [];
  speech.current = null;
  stopLocalAudio();
  updateSpeakButtons();
}

function stopLocalAudio() {
  speech.abort?.abort();
  speech.abort = null;
  const source = speech.source;
  speech.source = null;
  if (!source) return;
  source.onended = null;
  try {
    source.stop();
  } catch {
    // Ya había terminado.
  }
}

/**
 * Lee un texto con la voz del agente. Con `queue`, espera a que termine lo que se está leyendo.
 * Devuelve false si no había nada que leer o las voces no están listas.
 */
function speak(text, agent, { messageId = null, queue = false, quiet = false } = {}) {
  if (!canReadAloud()) return false;
  const clean = speakableText(text);
  if (!clean) return false;
  const settings = { ...DEFAULT_VOICE, ...(agent?.voice ?? {}) };
  const lang = settings.lang !== "auto" ? settings.lang : detectLanguage(clean);
  const voice = pickVoice(settings.name, lang);
  if (!voice) {
    if (!quiet) showToast("Las voces no leen ese idioma.");
    return true;
  }
  const job = { messageId, agentId: agent?.id ?? null, text: clean, rate: settings.rate, lang, voice };
  if (!queue && (speech.current || speech.queue.length)) stopSpeaking();
  speech.queue.push(job);
  if (speech.current) updateSpeakButtons();
  else nextSpeech();
  return true;
}

/** Empieza lo siguiente de la cola (o nada, si se vació). */
function nextSpeech() {
  const job = speech.queue.shift() ?? null;
  speech.current = job;
  updateSpeakButtons();
  if (!job) return;
  const token = speech.token;
  playSpeech(job, token, () => {
    if (token === speech.token && speech.current === job) nextSpeech();
  });
}

/** Lee en partes: pide cada una al servidor (que la genera en este PC) y la toca mientras se genera la siguiente. */
function playSpeech(job, token, finish) {
  primeAudio();
  const context = speech.audio;
  if (!context) {
    showToast("Este navegador no puede tocar el audio de las voces.", "error");
    finish();
    return;
  }
  const parts = localChunks(job.text);
  const controller = new AbortController();
  speech.abort = controller;
  const load = (text) => fetchLocalAudio(text, job, controller.signal).then((data) => context.decodeAudioData(data));
  let index = 0;
  let next = parts.length ? load(parts[0]) : null;
  next?.catch(() => undefined);
  const playNext = async () => {
    if (token !== speech.token) return;
    if (!next) {
      finish();
      return;
    }
    let buffer;
    try {
      buffer = await next;
    } catch (error) {
      if (token !== speech.token) return;
      showToast(`No se pudo leer en voz alta: ${error.message}`, "error");
      finish();
      return;
    }
    if (token !== speech.token) return;
    index += 1;
    next = index < parts.length ? load(parts[index]) : null;
    next?.catch(() => undefined);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.onended = () => {
      if (speech.source === source) speech.source = null;
      void playNext();
    };
    speech.source = source;
    source.start();
  };
  void playNext();
}

async function fetchLocalAudio(text, job, signal) {
  let response;
  try {
    response = await fetch("/api/voices/speak", {
      method: "POST",
      headers: { "x-cuadrilla": "1", "content-type": "application/json" },
      body: JSON.stringify({ text, voice: job.voice.local, speed: job.rate, lang: job.lang }),
      credentials: "same-origin",
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ApiError("No hay conexión con el servidor.", 0);
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) showLogin();
    throw new ApiError(data.error || `Error ${response.status}`, response.status);
  }
  return response.arrayBuffer();
}

/**
 * Partes para las voces de este PC, como OpenBot: la primera corta (de 40 a 80 letras, para que empiece a sonar
 * enseguida) y cada una de las siguientes hasta el triple de la anterior, con un máximo de 400.
 */
function localChunks(text) {
  const prepared = String(text)
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    // Un título o un punto de una lista termina en un salto de línea: se lee como una frase.
    .map((line) => (/[.!?…:;,]$/.test(line) ? line : `${line}.`))
    .join(" ");
  const parts = [];
  let current = "";
  let limit = 80;
  const flush = () => {
    if (!current) return;
    parts.push(current);
    limit = Math.min(400, Math.max(80, current.length * 3));
    current = "";
  };
  for (const sentence of splitSentences(prepared)) {
    let rest = sentence;
    while (rest) {
      if (current && current.length + 1 + rest.length > limit) flush();
      if ((current ? current.length + 1 : 0) + rest.length <= limit) {
        current = current ? `${current} ${rest}` : rest;
        rest = "";
      } else {
        const cut = cutPoint(rest, limit);
        current = rest.slice(0, cut).trim();
        rest = rest.slice(cut).trim();
        flush();
      }
      if (!parts.length && current.length >= 40) flush();
    }
  }
  flush();
  return parts;
}

function splitSentences(text) {
  if (typeof Intl.Segmenter === "function") {
    return [...new Intl.Segmenter("es", { granularity: "sentence" }).segment(text)].map((item) => item.segment.trim()).filter(Boolean);
  }
  return (text.match(/[^]*?(?:[.!?…;:]+(?=\s|$)|$)/gu) ?? []).map((item) => item.trim()).filter(Boolean);
}

/** Dónde cortar una frase demasiado larga: en una coma o, si no, en un espacio antes del límite. */
function cutPoint(text, limit) {
  const head = text.slice(0, limit + 1);
  const comma = head.lastIndexOf(", ");
  if (comma >= limit / 2) return comma + 1;
  const space = head.lastIndexOf(" ");
  return space > 0 ? space : limit;
}

function updateSpeakButtons() {
  for (const button of document.querySelectorAll(".speak-button")) {
    const active = speech.current?.messageId === button.dataset.id;
    if (button.getAttribute("aria-pressed") !== String(active)) setSpeakButton(button, active);
  }
  const test = $("#voice-test");
  if (test) test.textContent = speech.current?.messageId === "voice-test" ? "Detener" : "Probar voz";
}

function toggleSpeakMessage(key, messageId) {
  primeAudio();
  if (speech.current?.messageId === messageId) {
    stopSpeaking();
    return;
  }
  const message = (state.messages.get(key) ?? []).find((item) => item.id === messageId);
  // En un canal, cada respuesta se lee con la voz de quien la escribió.
  if (message && speak(message.text, findAgent(message.agentId), { messageId })) return;
  showToast(canReadAloud() ? "No hay nada que leer en ese mensaje." : "Las voces todavía no están listas: descárgalas en Ajustes.");
}

/** Lee sola una respuesta recién terminada si el agente lo tiene activado o si le hablaste con el botón de voz. */
function maybeAutoRead(agentId, message) {
  if (!canReadAloud() || agentId !== state.currentId || document.hidden || dictation || !message.text?.trim()) return;
  const agent = findAgent(agentId);
  if (!agent) return;
  const replying =
    voiceReply?.agentId === agentId &&
    Date.now() - voiceReply.startedAt < 15 * 60_000 &&
    (!voiceReply.until || Date.now() < voiceReply.until);
  if (!agent.voice?.autoRead && !replying) return;
  speak(message.text, agent, { messageId: message.id, queue: true, quiet: true });
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
/** Desde cuándo una lectura del uso se marca como vieja en el detalle. */
const USAGE_STALE_MS = 20 * 60_000;

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
    // Una lectura vieja (Gemini solo se lee cuando un agente lo está usando): se dice de cuándo es.
    if (entry.updatedAt && Date.now() - entry.updatedAt > USAGE_STALE_MS) {
      const stale = document.createElement("div");
      stale.className = "usage-stale";
      stale.textContent = `Leído ${formatAgo(entry.updatedAt)}${entry.provider === "gemini" ? " · se actualiza cuando un agente usa Gemini" : ""}`;
      block.append(stale);
    }
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
  $("#usage-foot").textContent = `${updated ? `Actualizado ${formatAgo(updated)}. ` : ""}Es el uso de cada cuenta, también fuera de ClosedBot.`;
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
  $("#select-cancel").addEventListener("click", () => endSelection());
  $("#select-all").addEventListener("click", () => toggleSelectAll());
  $("#select-delete").addEventListener("click", () => void deleteAgents([...(state.selection ?? [])]));
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
  $("#open-office").addEventListener("click", openOffice);
  $("#office-back").addEventListener("click", goBack);
  $("#office-draw").addEventListener("click", () => void drawMissingCharacters());
  $("#pixellab-form").addEventListener("submit", connectPixelLab);
  $("#pixellab-remove").addEventListener("click", () => void disconnectPixelLab());
  $("#create-character-redo").addEventListener("click", () => void redrawCharacter());
  office = createOffice({
    root: $("#office"),
    agents: () => state.agents,
    channels: () => state.channels,
    colorOf: (agent) => (agent.main ? "#d97757" : avatarParts(agent)[1]),
    openAgent: (id) => void navigate(id),
    openChannel: (id) => void navigateChannel(id),
    imageUrl: (agentId, path) => libraryUrl(agentId, "shared", path, true),
    renderMarkdown: (text, target) => renderMarkdown(text, target),
    api,
  });
  $("#settings-close").addEventListener("click", () => closeDialog($("#settings-dialog")));
  $("#names-form").addEventListener("submit", saveNames);
  $("#refresh-providers").addEventListener("click", refreshProviders);
  $("#full-access").addEventListener("change", () => void toggleFullAccess());
  $("#connect-claude").addEventListener("click", () => void connectClaude());
  $("#logout").addEventListener("click", logout);
  $("#back").addEventListener("click", goBack);
  $("#details-button").addEventListener("click", () => {
    if (state.currentChannelId) openChannelDialog(state.currentChannelId);
    else openDetails(state.currentId);
  });

  // Canales: crear o editar, y «Canales eliminados».
  $("#channel-form").addEventListener("submit", saveChannel);
  $("#channel-cancel").addEventListener("click", () => closeDialog($("#channel-dialog")));
  $("#channel-delete").addEventListener("click", () => {
    const id = editingChannelId;
    closeDialog($("#channel-dialog"));
    if (id) void deleteChannel(id);
  });
  $("#deleted-channels-close").addEventListener("click", () => closeDialog($("#deleted-channels-dialog")));

  // Menús contextuales: se cierran al tocar fuera, al cambiar el tamaño o al desplazar la lista.
  bindSidebarMenus();
  for (const menu of [$("#context-menu"), $("#context-submenu")]) menu.addEventListener("keydown", onMenuKeydown);
  document.addEventListener(
    "pointerdown",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (menuState && !target?.closest("#context-menu, #context-submenu")) closeContextMenu();
      if (!$("#usage-popover").hidden && !target?.closest("#usage-popover, #usage-button")) closeUsage();
      primeAudio();
    },
    true,
  );
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!$("#usage-popover").hidden) {
      closeUsage();
      $("#usage-button").focus();
      return;
    }
    // Esc termina la selección, salvo que se esté escribiendo o haya un diálogo abierto.
    const target = event.target instanceof Element ? event.target : null;
    if (state.selection && !document.querySelector("dialog[open]") && !target?.closest("input, textarea, select, [contenteditable]")) endSelection();
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

  // Ficha del agente: lista de ajustes y subpantallas.
  const detailsDialog = $("#details-dialog");
  for (const button of detailsDialog.querySelectorAll(".details-close")) button.addEventListener("click", () => closeDialog(detailsDialog));
  detailsDialog.addEventListener("click", (event) => {
    // Clic en el fondo oscuro (fuera del panel): se cierra.
    if (event.target === detailsDialog) closeDialog(detailsDialog);
  });
  detailsDialog.addEventListener("cancel", (event) => {
    // Esc en una subpantalla vuelve a la lista; en la lista, cierra.
    if (details.page === null) return;
    event.preventDefault();
    showPage(null);
  });
  detailsDialog.addEventListener("close", () => {
    if (speech.current?.messageId === "voice-test") stopSpeaking();
  });
  $("#details-avatar").addEventListener("click", () => openCreateDialog({ agentId: details.agentId }));
  $("#details-profile").addEventListener("click", () => showPage("profile"));
  for (const row of document.querySelectorAll("#details-groups [data-page]")) row.addEventListener("click", () => showPage(row.dataset.page));
  $("#details-back").addEventListener("click", () => showPage(null));

  const profileForm = $("#profile-form");
  profileForm.addEventListener("submit", saveProfile);
  profileForm.elements.description.addEventListener("input", updateDescriptionCount);

  const brainForm = $("#brain-form");
  brainForm.addEventListener("submit", saveBrain);
  brainForm.elements.provider.addEventListener("change", () => {
    updateProviderHint(brainForm);
    void refreshModelOptions(brainForm);
  });
  brainForm.elements.model.addEventListener("change", () => refreshEffortOptions(brainForm));

  $("#instructions-text").addEventListener("input", updateInstructionsCount);
  $("#instructions-text").addEventListener("keydown", (event) => {
    if (event.key === "s" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void saveInstructions();
    }
  });
  $("#instructions-save").addEventListener("click", () => void saveInstructions());

  $("#memory-form").addEventListener("submit", saveMemory);
  $("#skill-new").addEventListener("click", newSkill);
  $("#skill-cancel").addEventListener("click", closeSkillForm);
  $("#skill-form").addEventListener("submit", saveSkill);

  $("#details-new-routine").addEventListener("click", () => openRoutines(details.agentId));
  $("#details-pause").addEventListener("click", () => void agentAction("pause", details.agentId));
  $("#details-reset").addEventListener("click", () => void agentAction("reset", details.agentId));
  $("#details-delete").addEventListener("click", () => void agentAction("delete", details.agentId));
  for (const radio of document.querySelectorAll('#access-form input[name="access"]')) {
    radio.addEventListener("change", () => {
      if (radio.checked) void changeAccess(radio.value);
    });
  }
  for (const radio of document.querySelectorAll('#notify-form input[name="notify"]')) {
    radio.addEventListener("change", () => {
      if (radio.checked) void setNotify(radio.value);
    });
  }
  $("#notify-enable").addEventListener("click", () => void enableNotifications());

  $("#voice-name").addEventListener("change", (event) => void saveVoice({ name: event.target.value }));
  $("#voice-rate").addEventListener("input", (event) => {
    $("#voice-rate-value").textContent = formatRate(Number(event.target.value));
  });
  $("#voice-rate").addEventListener("change", (event) => void saveVoice({ rate: Number(event.target.value) }));
  $("#voice-lang").addEventListener("change", (event) => onVoiceLangChange(event.target.value));
  $("#voice-auto").addEventListener("click", () => {
    primeAudio();
    const agent = findAgent(details.agentId);
    if (agent) void saveVoice({ autoRead: !agent.voice?.autoRead });
  });
  $("#voice-test").addEventListener("click", testVoice);
  $("#voice-local-download").addEventListener("click", (event) => void installLocalVoices(event.currentTarget));
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

  // Uso del plan.
  $("#usage-button").addEventListener("click", toggleUsage);
  $("#usage-refresh").addEventListener("click", () => void refreshUsage());

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
    updateMentionMenu();
  });
  // En un canal, «@» muestra a los miembros para nombrar a uno.
  input.addEventListener("click", updateMentionMenu);
  input.addEventListener("keyup", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "Home" || event.key === "End") updateMentionMenu();
  });
  input.addEventListener("blur", () => setTimeout(() => {
    if (document.activeElement !== input) hideMentionMenu();
  }, 120));
  input.addEventListener("keydown", (event) => {
    if (onMentionKeydown(event)) return;
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
    if (convKey()) scheduleMarkRead(convKey(), 0);
  });
}

void boot();
