// Cuadrilla — interfaz web (sin dependencias ni paso de compilación).

const $ = (selector) => document.querySelector(selector);

const state = {
  agents: [],
  providers: [],
  paths: null,
  version: "",
  maxHops: 0,
  platform: "",
  currentId: null,
  messages: new Map(), // agentId -> array de mensajes en orden
  hasMore: new Map(),
  queues: new Map(),
  unread: new Set(),
  models: new Map(), // proveedor -> modelos
  queueOpen: false,
  navigatedInApp: false,
};

const elements = new Map(); // id de mensaje -> elemento del DOM (solo el agente abierto)
const dirty = new Set();
let renderScheduled = false;
let events = null;
let reconnectTimer = null;
let toastTimer = null;
let editingAgentId = null;

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
  if (response.status === 401 && path !== "/api/login") {
    showLogin();
    throw new ApiError(data.error || "Inicia sesión.", 401);
  }
  if (!response.ok) throw new ApiError(data.error || `Error ${response.status}`, response.status);
  return data;
}

// ---------- arranque y sesión ----------

async function boot() {
  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }
  bindUi();
  let session = null;
  try {
    session = await api("/api/session");
  } catch {
    session = null;
  }
  $("#boot").hidden = true;
  if (session?.authenticated) await enterApp();
  else showLogin();
}

function showLogin() {
  if (events) {
    events.close();
    events = null;
  }
  clearTimeout(reconnectTimer);
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
  state.paths = data.paths;
  state.version = data.version;
  state.maxHops = data.maxHops;
  state.platform = data.platform ?? "";
  $("#login").hidden = true;
  $("#app").hidden = false;
  renderSidebar();
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
  const label = { live: "En vivo", connecting: "Conectando…", offline: "Sin conexión" }[value];
  const node = $("#connection");
  node.dataset.state = value;
  node.textContent = label;
}

function handleEvent(event) {
  switch (event.type) {
    case "hello":
      state.agents = event.agents;
      state.providers = event.providers;
      renderSidebar();
      // Tras reconectar pudimos perder eventos: recargamos la conversación abierta.
      if (state.currentId) void loadConversation(state.currentId, { keepScroll: true });
      break;
    case "agents":
      state.agents = event.agents;
      renderSidebar();
      renderHeader();
      updateWorkingIndicator();
      if (state.currentId && !findAgent(state.currentId)) void navigate(null);
      break;
    case "providers":
      state.providers = event.providers;
      renderProviders();
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
    state.currentId = null;
    elements.clear();
    document.body.classList.remove("show-chat");
    $("#conversation").hidden = true;
    $("#chat-empty").hidden = false;
    renderSidebar();
    return;
  }
  const changed = state.currentId !== agent.id;
  state.currentId = agent.id;
  state.unread.delete(agent.id);
  document.body.classList.add("show-chat");
  $("#chat-empty").hidden = true;
  $("#conversation").hidden = false;
  renderSidebar();
  renderHeader();
  if (changed) {
    restoreDraft();
    await loadConversation(agent.id);
    if (!coarsePointer) $("#composer-input").focus();
  }
}

function goBack() {
  if (state.navigatedInApp && history.length > 1) history.back();
  else location.replace("#/");
}

// ---------- barra lateral ----------

function findAgent(id) {
  return state.agents.find((agent) => agent.id === id) ?? null;
}

function agentName(id) {
  return findAgent(id)?.name ?? "un agente eliminado";
}

function renderSidebar() {
  const list = $("#agent-list");
  list.replaceChildren();
  $("#sidebar-empty").hidden = state.agents.length > 0;
  for (const agent of state.agents) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "agent-item";
    button.setAttribute("aria-current", String(agent.id === state.currentId));
    button.addEventListener("click", () => navigate(agent.id));

    const body = document.createElement("div");
    const nameLine = document.createElement("div");
    nameLine.className = "name-line";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = agent.name;
    nameLine.append(name, providerBadge(agent.provider));
    const preview = document.createElement("div");
    preview.className = "preview";
    preview.textContent = agentSubtitle(agent);
    body.append(nameLine, preview);

    const side = document.createElement("div");
    side.className = "side";
    const dot = document.createElement("span");
    dot.className = "status-dot";
    dot.dataset.state = agent.state;
    dot.title = stateLabel(agent);
    side.append(dot);
    if (agent.queued > 0) {
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = `${agent.queued} en cola`;
      side.append(count);
    }
    if (state.unread.has(agent.id)) {
      const unread = document.createElement("span");
      unread.className = "unread";
      unread.title = "Mensajes nuevos";
      side.append(unread);
    }
    button.append(avatar(agent.name), body, side);
    item.append(button);
    list.append(item);
  }
  document.title = state.unread.size ? `(${state.unread.size}) Cuadrilla` : "Cuadrilla";
}

function agentSubtitle(agent) {
  if (agent.state === "working") return "Trabajando…";
  if (agent.state === "paused") return "Cola en pausa";
  return agent.preview || agent.role || "Sin mensajes todavía";
}

function stateLabel(agent) {
  return { working: "Trabajando", queued: "Con mensajes en cola", paused: "En pausa", idle: "Libre" }[agent.state] ?? "";
}

function providerBadge(provider) {
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.dataset.provider = provider;
  badge.textContent = { claude: "Claude", codex: "Codex", demo: "Demo" }[provider] ?? provider;
  return badge;
}

function avatar(name) {
  const node = document.createElement("div");
  node.className = "avatar";
  node.setAttribute("aria-hidden", "true");
  node.textContent = initials(name);
  node.style.setProperty("--avatar", avatarColor(name));
  return node;
}

function initials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

function avatarColor(name) {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.codePointAt(0)) % 360;
  return `hsl(${hash} 52% 46%)`;
}

// ---------- conversación ----------

function renderHeader() {
  const agent = findAgent(state.currentId);
  if (!agent) return;
  const avatarNode = $("#chat-avatar");
  avatarNode.textContent = initials(agent.name);
  avatarNode.style.setProperty("--avatar", avatarColor(agent.name));
  $("#chat-name").textContent = agent.name;
  const parts = [agent.role || "Asistente general", { claude: "Claude", codex: "Codex", demo: "Demo" }[agent.provider]];
  if (agent.model) parts.push(agent.model);
  if (agent.access === "total") parts.push("acceso total");
  parts.push(stateLabel(agent).toLowerCase());
  $("#chat-meta").textContent = parts.filter(Boolean).join(" · ");
  $("#stop").hidden = agent.state !== "working";
  const pause = document.querySelector('#agent-menu [data-action="pause"]');
  pause.textContent = agent.paused ? "Reanudar la cola" : "Pausar la cola";
  $("#composer-input").placeholder = `Escribe a ${agent.name}…`;
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
  updateWorkingIndicator();
}

function upsertMessage(agentId, message) {
  const list = state.messages.get(agentId);
  if (list) {
    const index = list.findIndex((item) => item.id === message.id);
    if (index >= 0) list[index] = { ...list[index], ...message };
    else list.push(message);
  }
  const notable =
    (message.role === "assistant" && message.status === "completed" && message.text.trim()) ||
    (message.role === "teammate" && message.status === "queued");
  if (notable && (agentId !== state.currentId || document.hidden)) {
    if (agentId !== state.currentId) {
      state.unread.add(agentId);
      renderSidebar();
    }
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
  updateWorkingIndicator();
  if (atBottom || (!existing && message.role === "user")) scrollToBottom();
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
  const node = document.createElement("div");
  node.dataset.id = message.id;
  node.dataset.status = message.status;
  const time = formatTime(message.createdAt);

  if (message.role === "activity") {
    node.className = "msg msg-activity";
    node.textContent = `⚙ ${message.text}`;
    node.title = time;
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
      meta.textContent = [time, userStatus(message.status)].filter(Boolean).join(" · ");
      break;
    case "assistant":
      node.className = "msg msg-assistant";
      if (!message.text && message.status === "streaming") bubble.append(thinkingDots());
      else renderMarkdown(message.text, bubble);
      if (message.status === "streaming" && message.text) bubble.classList.add("typing");
      meta.textContent = [time, assistantStatus(message.status)].filter(Boolean).join(" · ");
      break;
    case "teammate":
      node.className = "msg msg-teammate";
      label = `${message.replyTo ? "Respuesta de" : "Mensaje de"} ${agentName(message.fromAgentId)}`;
      renderMarkdown(message.text, bubble);
      meta.textContent = [time, teammateStatus(message.status)].filter(Boolean).join(" · ");
      break;
    case "notice":
      node.className = "msg msg-outgoing";
      label = `${message.replyTo ? "Respuesta para" : "Enviado a"} ${message.toAgentIds.map(agentName).join(", ")}`;
      renderMarkdown(message.text, bubble);
      meta.textContent = time;
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
  bubble.classList.add("md");
  node.append(bubble, meta);
  return node;
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

function formatTime(timestamp) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? date.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString("es", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
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
  $("#queue-summary").textContent =
    waiting.length === 1 ? "1 mensaje esperando turno" : `${waiting.length} mensajes esperando turno`;
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
}

function autosize(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight + 2, window.innerHeight * 0.4)}px`;
}

async function sendMessage(event) {
  event?.preventDefault();
  const input = $("#composer-input");
  const original = input.value;
  const text = original.trim();
  if (!text || !state.currentId) return;
  const agentId = state.currentId;
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
    upsertMessage(agentId, result.message);
    scrollToBottom();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
    if (!coarsePointer) input.focus();
  }
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
    } else if (action === "pause") {
      await api(`${path}/pause`, { method: "POST", body: { paused: !agent.paused } });
      showToast(agent.paused ? "Cola reanudada." : "Cola en pausa: los mensajes nuevos esperarán.");
    } else if (action === "reset") {
      const ok = await confirmAction(
        "¿Empezar de cero?",
        `Se borra el historial de ${agent.name} y su cola, y empieza una conversación nueva. Los archivos de su carpeta no se tocan.`,
        "Empezar de cero",
      );
      if (!ok) return;
      await api(`${path}/reset`, { method: "POST" });
      state.messages.set(agent.id, []);
      state.hasMore.set(agent.id, false);
      renderAllMessages();
      renderQueue();
    } else if (action === "delete") {
      const ok = await confirmAction(
        `¿Eliminar a ${agent.name}?`,
        "Se borran el agente, su historial y su cola. Su carpeta de trabajo queda en el servidor por si la necesitas.",
        "Eliminar",
      );
      if (!ok) return;
      await api(path, { method: "DELETE" });
      state.messages.delete(agent.id);
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
  form.elements.name.value = agent?.name ?? "";
  form.elements.role.value = agent?.role ?? "";
  form.elements.instructions.value = agent?.instructions ?? "";
  form.elements.access.value = agent?.access ?? "carpeta";
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
  $("#access-warning").hidden = form.elements.access.value !== "total";
  $("#access-hint").hidden = !(state.platform === "win32" && form.elements.provider.value === "claude" && form.elements.access.value === "carpeta");
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
  const body = {
    name,
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

// ---------- ajustes ----------

function openSettings() {
  renderProviders();
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
  $("#version").textContent = `Cuadrilla ${state.version} · límite de ${state.maxHops} reenvíos seguidos entre agentes.`;
  openDialog($("#settings-dialog"));
}

function renderProviders() {
  const list = $("#provider-list");
  if (!list) return;
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
    if (!provider.available) {
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
    item.append(title, detail);
    list.append(item);
  }
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
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, tone === "error" ? 6_000 : 3_500);
}

function bindUi() {
  $("#login-form").addEventListener("submit", login);
  $("#new-agent").addEventListener("click", () => openAgentDialog());
  $("#first-agent").addEventListener("click", () => openAgentDialog());
  $("#open-settings").addEventListener("click", openSettings);
  $("#settings-close").addEventListener("click", () => closeDialog($("#settings-dialog")));
  $("#refresh-providers").addEventListener("click", refreshProviders);
  $("#logout").addEventListener("click", logout);
  $("#back").addEventListener("click", goBack);
  $("#stop").addEventListener("click", stopAgent);
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
  $("#composer").addEventListener("submit", sendMessage);
  input.addEventListener("input", () => {
    autosize(input);
    saveDraft();
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !coarsePointer) {
      event.preventDefault();
      void sendMessage();
    }
  });

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

  window.addEventListener("hashchange", () => void route());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden || $("#app").hidden) return;
    if (!events || events.readyState === EventSource.CLOSED) connectEvents();
    if (state.currentId) {
      state.unread.delete(state.currentId);
      renderSidebar();
    }
  });
}

void boot();
