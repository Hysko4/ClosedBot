import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type AddressInfo, connect } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type AppOptions, createApp } from "../src/app.js";
import { Auth, hashPassword, PASSWORD_META } from "../src/auth.js";
import { ElevenLabs } from "../src/elevenlabs.js";
import { type SpeechModel, SpeechEngine } from "../src/speech.js";
import { AUDIO, fakeElevenLabs, GOOD_KEY } from "./fake-elevenlabs.js";
import { createHarness, type Harness, tempDir, waitFor } from "./helpers.js";
import { toneWav } from "./wav.js";

const publicDir = fileURLToPath(new URL("../../public", import.meta.url));
const PASSWORD = "contraseña-de-prueba";

async function startServer(
  extra: Partial<AppOptions> | ((h: Harness) => Partial<AppOptions>) = {},
  harness: Parameters<typeof createHarness>[0] = {},
) {
  const h = await createHarness(harness);
  h.store.setMeta(PASSWORD_META, await hashPassword(PASSWORD));
  const auth = new Auth({ store: h.store, sessionDays: 1 });
  const app = createApp({
    service: h.service,
    auth,
    publicDir,
    sharedDir: "/srv/compartida",
    workspacesDir: "/srv/agentes",
    maxHops: 6,
    secureCookies: "auto",
    ...(typeof extra === "function" ? extra(h) : extra),
  });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  let cookie = "";
  const call = async (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string>; auth?: boolean } = {}) => {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (init.method && init.method !== "GET" && headers["x-cuadrilla"] === undefined) headers["x-cuadrilla"] = "1";
    if (init.body !== undefined && headers["content-type"] === undefined) headers["content-type"] = "application/json";
    if (cookie && init.auth !== false) headers.cookie = cookie;
    const response = await fetch(base + path, {
      method: init.method ?? "GET",
      headers,
      body:
        init.body === undefined
          ? undefined
          : typeof init.body === "string" || init.body instanceof Uint8Array
            ? (init.body as string | Uint8Array<ArrayBuffer>)
            : JSON.stringify(init.body),
    });
    const text = await response.text();
    return { response, status: response.status, json: text ? (JSON.parse(text) as Record<string, any>) : null };
  };
  const login = async () => {
    const result = await call("/api/login", { method: "POST", body: { password: PASSWORD } });
    cookie = (result.response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    return result;
  };
  return {
    h,
    base,
    call,
    login,
    useCookie(value: string) {
      cookie = value;
    },
    get cookie() {
      return cookie;
    },
    close: async () => {
      app.closeStreams();
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
      await h.close();
    },
  };
}

test("HTTP: archivos estáticos con cabeceras de seguridad y sin salir de public/", async () => {
  const s = await startServer();
  try {
    const index = await fetch(`${s.base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get("content-type") ?? "", /text\/html/);
    assert.match(index.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.equal(index.headers.get("x-frame-options"), "DENY");
    assert.match(await index.text(), /ClosedBot/);
    const manifest = await fetch(`${s.base}/manifest.webmanifest`);
    assert.match(manifest.headers.get("content-type") ?? "", /manifest\+json/);
    for (const path of ["/..%2fpackage.json", "/%2e%2e/%2e%2e/etc/passwd", "/icons/../../package.json"]) {
      const response = await fetch(s.base + path);
      assert.ok([400, 404].includes(response.status), `${path} → ${response.status}`);
    }
    const etag = index.headers.get("etag") ?? "";
    const cached = await fetch(`${s.base}/`, { headers: { "if-none-match": etag } });
    assert.equal(cached.status, 304);
  } finally {
    await s.close();
  }
});

test("HTTP: login, CSRF y sesión", async () => {
  const s = await startServer();
  try {
    assert.equal((await s.call("/api/state")).status, 401);
    assert.equal((await s.call("/api/session")).json?.authenticated, false);
    const noHeader = await s.call("/api/login", { method: "POST", body: { password: PASSWORD }, headers: { "x-cuadrilla": "" } });
    assert.equal(noHeader.status, 403);
    const wrong = await s.call("/api/login", { method: "POST", body: { password: "otra-cosa-larga" } });
    assert.equal(wrong.status, 401);
    const ok = await s.login();
    assert.equal(ok.status, 200);
    const setCookie = ok.response.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.doesNotMatch(setCookie, /Secure/, "sin HTTPS no marca Secure");
    const state = await s.call("/api/state");
    assert.equal(state.status, 200);
    assert.equal(state.json?.providers.length, 3);
    const foreign = await s.call("/api/agents", {
      method: "POST",
      body: { name: "Ana", provider: "demo" },
      headers: { origin: "https://malicioso.example" },
    });
    assert.equal(foreign.status, 403);
    const notJson = await s.call("/api/agents", { method: "POST", body: "name=Ana", headers: { "content-type": "text/plain" } });
    assert.equal(notJson.status, 415);
    const big = await s.call("/api/agents", { method: "POST", body: { name: "x".repeat(3 * 1024 * 1024), provider: "demo" } });
    assert.equal(big.status, 413);
    const logout = await s.call("/api/logout", { method: "POST" });
    assert.equal(logout.status, 200);
    assert.equal((await s.call("/api/state")).status, 401);
  } finally {
    await s.close();
  }
});

/**
 * Envía `size` bytes por un socket TCP, de a trozos, y anota si el servidor cerró la conexión antes de que el
 * cliente terminara de enviar. Ese cierre deja datos sin leer y el sistema lo convierte en un RST: en Windows el
 * cliente pierde entonces la respuesta 413.
 */
function rawPost(base: string, cookie: string, size: number, declareLength: boolean) {
  const { hostname, port } = new URL(base);
  return new Promise<{ response: string; cutEarly: boolean }>((resolve) => {
    const socket = connect(Number(port), hostname);
    let response = "";
    let sending = true;
    let cutEarly = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (response += chunk));
    socket.on("end", () => {
      if (sending) cutEarly = true;
    });
    socket.on("error", () => {
      if (sending) cutEarly = true;
    });
    socket.on("close", () => resolve({ response, cutEarly }));
    const head = [
      "POST /api/agents HTTP/1.1",
      `Host: ${hostname}:${port}`,
      "Content-Type: application/json",
      "X-Cuadrilla: 1",
      `Cookie: ${cookie}`,
      "Connection: close",
      declareLength ? `Content-Length: ${size}` : "Transfer-Encoding: chunked",
      "",
      "",
    ].join("\r\n");
    const write = (data: string | Buffer) => new Promise<void>((done) => socket.write(data, () => done()));
    void (async () => {
      await write(head);
      const piece = Buffer.alloc(64 * 1024, "x");
      for (let sent = 0; sent < size && !socket.destroyed; sent += piece.length) {
        await write(declareLength ? piece : Buffer.concat([Buffer.from(`${piece.length.toString(16)}\r\n`), piece, Buffer.from("\r\n")]));
        await new Promise((next) => setImmediate(next));
      }
      if (!declareLength && !socket.destroyed) await write("0\r\n\r\n");
      sending = false;
    })();
  });
}

test("HTTP: un cuerpo demasiado grande recibe 413 sin cortar la conexión", async () => {
  const s = await startServer();
  try {
    await s.login();
    for (const declareLength of [true, false]) {
      const label = declareLength ? "con content-length" : "por partes (chunked)";
      const result = await rawPost(s.base, s.cookie, 3 * 1024 * 1024, declareLength);
      assert.equal(result.cutEarly, false, `${label}: el servidor lee el resto del cuerpo antes de cerrar`);
      assert.match(result.response, /^HTTP\/1\.1 413 /, label);
      assert.match(result.response, /demasiado grande/, label);
    }
    assert.equal((await s.call("/api/state")).status, 200, "el servidor sigue atendiendo");
  } finally {
    await s.close();
  }
});

test("HTTP: detrás de tailscale serve marca la cookie como Secure", async () => {
  const s = await startServer();
  try {
    const result = await s.call("/api/login", { method: "POST", body: { password: PASSWORD }, headers: { "x-forwarded-proto": "https" } });
    assert.match(result.response.headers.get("set-cookie") ?? "", /Secure/);
  } finally {
    await s.close();
  }
});

test("HTTP: crear agente, conversar y recibir eventos en vivo", async () => {
  const s = await startServer();
  try {
    await s.login();
    const created = await s.call("/api/agents", {
      method: "POST",
      body: { name: "Ana", role: "Investigadora", provider: "demo", access: "carpeta" },
    });
    assert.equal(created.status, 201);
    const agent = created.json?.agent as { id: string; name: string };
    assert.equal(agent.name, "Ana");
    const invalid = await s.call("/api/agents", { method: "POST", body: { name: "Beto", provider: "demo", access: "root" } });
    assert.equal(invalid.status, 400);

    const controller = new AbortController();
    const stream = await fetch(`${s.base}/api/events`, { headers: { cookie: s.cookie }, signal: controller.signal });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
    const events: Array<Record<string, any>> = [];
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let index = buffer.indexOf("\n\n");
          while (index >= 0) {
            const chunk = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            for (const line of chunk.split("\n")) if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
            index = buffer.indexOf("\n\n");
          }
        }
      } catch {
        // abortado al final de la prueba
      }
    })();
    await waitFor(() => events.some((event) => event.type === "hello"), 3_000, "hello");

    const sent = await s.call(`/api/agents/${agent.id}/messages`, { method: "POST", body: { text: "Hola por HTTP" } });
    assert.equal(sent.status, 202);
    await waitFor(() => events.some((event) => event.type === "delta" && event.agentId === agent.id), 3_000, "deltas");
    await waitFor(
      () => events.some((event) => event.type === "message" && event.message.role === "assistant" && event.message.status === "completed"),
      3_000,
      "mensaje completo",
    );
    const history = await s.call(`/api/agents/${agent.id}/messages?limit=50`);
    assert.equal(history.status, 200);
    const roles = (history.json?.messages as Array<{ role: string }>).map((message) => message.role);
    assert.deepEqual(roles, ["user", "assistant"]);
    assert.equal(history.json?.hasMore, false);

    const models = await s.call("/api/models?provider=demo");
    assert.equal(models.json?.models[0].model, "demo");
    const queue = await s.call(`/api/agents/${agent.id}/queue`);
    assert.deepEqual(queue.json?.queue, []);
    const renamed = await s.call(`/api/agents/${agent.id}`, { method: "PATCH", body: { name: "Ana María" } });
    assert.equal(renamed.json?.agent.name, "Ana María");
    const paused = await s.call(`/api/agents/${agent.id}/pause`, { method: "POST", body: { paused: true } });
    assert.equal(paused.json?.agent.state, "paused");
    const missing = await s.call("/api/agents/no-existe");
    assert.equal(missing.status, 404);
    const removed = await s.call(`/api/agents/${agent.id}`, { method: "DELETE" });
    assert.equal(removed.status, 204);

    controller.abort();
    await pump;
  } finally {
    await s.close();
  }
});

const CONTROL_TOKEN = "token-de-control-de-prueba-con-32-caracteres-o-mas";

test("HTTP: Claude Bot llega marcado como principal y no se puede eliminar", async () => {
  const s = await startServer({}, { mainAgent: true });
  try {
    await s.login();
    const state = await s.call("/api/state");
    const agents = state.json?.agents as Array<{ id: string; name: string; main: boolean }>;
    assert.deepEqual(
      agents.map((agent) => [agent.name, agent.main]),
      [["Claude Bot", true]],
    );
    const main = agents[0] as { id: string };
    const removed = await s.call(`/api/agents/${main.id}`, { method: "DELETE" });
    assert.equal(removed.status, 409);
    assert.match(String(removed.json?.error), /bot principal/);
    const renamed = await s.call(`/api/agents/${main.id}`, { method: "PATCH", body: { name: "Mi Bot" } });
    assert.equal(renamed.json?.agent.main, true);
  } finally {
    await s.close();
  }
});

test("HTTP: sin token de control no existen las rutas del lanzador", async () => {
  const s = await startServer();
  try {
    assert.equal((await s.call("/api/control/login-link", { method: "POST" })).status, 404);
    assert.equal((await s.call("/api/control/shutdown", { method: "POST" })).status, 404);
  } finally {
    await s.close();
  }
});

test("HTTP: el lanzador abre sesión con un código de un solo uso y apaga la app", async () => {
  let shutdowns = 0;
  const s = await startServer({ controlToken: CONTROL_TOKEN, onShutdown: () => (shutdowns += 1) });
  try {
    const control = { "x-cuadrilla-control": CONTROL_TOKEN };
    assert.equal((await s.call("/api/control/login-link", { method: "POST" })).status, 403, "sin token");
    assert.equal((await s.call("/api/control/login-link", { method: "POST", headers: { "x-cuadrilla-control": "otro" } })).status, 403);
    const proxied = await s.call("/api/control/login-link", { method: "POST", headers: { ...control, "x-forwarded-for": "100.64.0.9" } });
    assert.equal(proxied.status, 403, "no a través de tailscale serve");
    const link = await s.call("/api/control/login-link", { method: "POST", headers: control });
    assert.equal(link.status, 200);
    const path = String(link.json?.path);
    assert.match(path, /^\/\?acceso=[\w-]{40,}$/);
    const code = new URL(path, s.base).searchParams.get("acceso");

    assert.equal((await s.call("/api/login/code", { method: "POST", body: { code: "inventado" } })).status, 401);
    const redeemed = await s.call("/api/login/code", { method: "POST", body: { code } });
    assert.equal(redeemed.status, 200);
    s.useCookie((redeemed.response.headers.get("set-cookie") ?? "").split(";")[0] ?? "");
    assert.equal((await s.call("/api/state")).status, 200, "con la cookie del código");
    assert.equal((await s.call("/api/login/code", { method: "POST", body: { code } })).status, 401, "un solo uso");

    assert.equal(shutdowns, 0);
    const off = await s.call("/api/control/shutdown", { method: "POST", headers: control });
    assert.equal(off.status, 200);
    await waitFor(() => shutdowns === 1, 2_000, "orden de cierre");
  } finally {
    await s.close();
  }
});

test("HTTP: preguntas, rutinas, ajustes, adjuntos y leídos", async () => {
  const s = await startServer();
  try {
    await s.login();
    const index = await fetch(`${s.base}/`);
    assert.match(index.headers.get("permissions-policy") ?? "", /microphone=\(self\)/);
    const created = await s.call("/api/agents", { method: "POST", body: { name: "Ana", provider: "demo", project: "Juegos" } });
    const agent = created.json?.agent as { id: string; workspace: string; project: string };
    assert.equal(agent.project, "Juegos");

    // Pregunta con opciones.
    await s.call(`/api/agents/${agent.id}/messages`, { method: "POST", body: { text: "/pregunta" } });
    const decision = await waitFor(
      () => s.h.service.listMessages(agent.id).find((message) => message.role === "decision"),
      5_000,
      "tarjeta",
    );
    const answered = await s.call(`/api/agents/${agent.id}/decisions/${decision.id}`, { method: "POST", body: { choice: 0 } });
    assert.equal(answered.status, 200);
    assert.equal(answered.json?.message.text, "A. Seguir probando");
    assert.equal((await s.call(`/api/agents/${agent.id}/decisions/${decision.id}`, { method: "POST", body: { choice: 1 } })).status, 409);
    assert.equal((await s.call(`/api/agents/${agent.id}/decisions/${decision.id}`, { method: "POST", body: {} })).status, 409);
    await waitFor(() => s.h.service.getAgent(agent.id).state === "idle" && s.h.service.getAgent(agent.id).unread, 5_000, "respuesta sin leer");
    const read = await s.call(`/api/agents/${agent.id}/read`, { method: "POST" });
    assert.equal(read.json?.agent.unread, false);

    // Rutinas.
    const bad = await s.call("/api/routines", { method: "POST", body: { agentId: agent.id, name: "X", prompt: "Y", times: ["7"] } });
    assert.equal(bad.status, 400);
    const routine = await s.call("/api/routines", {
      method: "POST",
      body: { agentId: agent.id, name: "Correo", prompt: "Revisa el correo", times: ["07:30"], days: [1, 2, 3, 4, 5] },
    });
    assert.equal(routine.status, 201);
    const routineId = routine.json?.routine.id as string;
    assert.equal(routine.json?.routine.description, "de lunes a viernes a las 07:30");
    assert.equal((await s.call("/api/routines")).json?.routines.length, 1);
    const state = await s.call("/api/state");
    assert.equal(state.json?.routines.length, 1);
    assert.deepEqual(state.json?.settings, { botName: "ClosedBot", userName: "", fullAccess: false });
    const paused = await s.call(`/api/routines/${routineId}`, { method: "PATCH", body: { enabled: false } });
    assert.equal(paused.json?.routine.enabled, false);
    const ran = await s.call(`/api/routines/${routineId}/run`, { method: "POST" });
    assert.equal(ran.status, 200);
    assert.equal((await s.call(`/api/routines/${routineId}`, { method: "DELETE" })).status, 204);
    assert.equal((await s.call(`/api/routines/${routineId}`, { method: "DELETE" })).status, 404);

    // Ajustes.
    const settings = await s.call("/api/settings", { method: "PATCH", body: { userName: "Jonathan" } });
    assert.deepEqual(settings.json?.settings, { botName: "ClosedBot", userName: "Jonathan", fullAccess: false });
    assert.equal((await s.call("/api/settings", { method: "PATCH", body: { botName: 5 } })).status, 400);
    const full = await s.call("/api/settings", { method: "PATCH", body: { fullAccess: true } });
    assert.deepEqual(full.json?.settings, { botName: "ClosedBot", userName: "Jonathan", fullAccess: true });
    assert.equal((await s.call("/api/settings", { method: "PATCH", body: { fullAccess: "sí" } })).status, 400);
    const names = await s.call("/api/settings", { method: "PATCH", body: { userName: "Jona" } });
    assert.equal(names.json?.settings.fullAccess, true, "guardar los nombres no apaga el acceso total");

    // Adjuntos.
    const upload = await s.call(`/api/agents/${agent.id}/files?name=${encodeURIComponent("../../notas.txt")}`, {
      method: "POST",
      body: "hola adjunto",
      headers: { "content-type": "application/octet-stream" },
    });
    assert.equal(upload.status, 201);
    assert.equal(upload.json?.file.name, "notas.txt");
    assert.equal(readFileSync(join(agent.workspace, "adjuntos", "notas.txt"), "utf8"), "hola adjunto");
    const missing = await s.call("/api/agents/no-existe/files?name=x.txt", {
      method: "POST",
      body: "x",
      headers: { "content-type": "application/octet-stream" },
    });
    assert.equal(missing.status, 404);
  } finally {
    await s.close();
  }
});

test("HTTP: inicio de sesión de los proveedores, con sesión y cabecera CSRF", async () => {
  const s = await startServer();
  try {
    const anonymous = await s.call("/api/providers/claude/login", { method: "POST", auth: false });
    assert.equal(anonymous.status, 401);
    await s.login();
    const noHeader = await s.call("/api/providers/claude/login", { method: "POST", headers: { "x-cuadrilla": "" } });
    assert.equal(noHeader.status, 403);
    const demo = await s.call("/api/providers/demo/login", { method: "POST" });
    assert.equal(demo.status, 400);
    // El servicio de pruebas no sabe iniciar sesión: lo dice en vez de fallar.
    const claude = await s.call("/api/providers/claude/login", { method: "POST" });
    assert.equal(claude.status, 409);
    assert.match(String(claude.json?.error), /no se puede iniciar sesión en Claude/);
    const code = await s.call("/api/providers/claude/login/code", { method: "POST", body: { code: "codigo#estado" } });
    assert.equal(code.status, 409);
    const cancel = await s.call("/api/providers/claude/login/cancel", { method: "POST" });
    assert.equal(cancel.status, 200);
    assert.ok(Array.isArray(cancel.json?.providers));
    const logout = await s.call("/api/providers/codex/logout", { method: "POST" });
    assert.equal(logout.status, 409);
    // «Instalar»: Claude viene con la app; el servicio de pruebas no sabe instalar los demás.
    assert.equal((await s.call("/api/providers/claude/install", { method: "POST" })).status, 400);
    const grok = await s.call("/api/providers/grok/install", { method: "POST" });
    assert.equal(grok.status, 409);
    assert.match(String(grok.json?.error), /no se puede instalar Grok/);
    assert.equal((await s.call("/api/providers/gemini/install/cancel", { method: "POST" })).status, 200);
    assert.equal((await s.call("/api/providers/grok/install", { method: "POST", headers: { "x-cuadrilla": "" } })).status, 403);
    // Modelos: Grok y Gemini son proveedores válidos (sin instalar, la lista viene vacía).
    const models = await s.call("/api/models?provider=gemini");
    assert.equal(models.status, 200);
    assert.deepEqual(models.json?.models, []);
    assert.equal((await s.call("/api/models?provider=otro")).status, 400);
  } finally {
    await s.close();
  }
});

test("HTTP: agente simple con saludo, menú de la barra, secciones, biblioteca y uso", async () => {
  const server = await startServer();
  try {
    await server.login();
    server.h.service.updateSettings({ userName: "Jonathan" });
    const created = await server.call("/api/agents", { method: "POST", body: { name: "d", provider: "demo", avatar: 10_409, greet: true } });
    assert.equal(created.status, 201);
    const agent = created.json?.agent;
    assert.equal(agent.avatar, 10_409);
    assert.equal(agent.pinned, false);
    await waitFor(() => server.h.service.listMessages(agent.id).some((message) => message.role === "assistant" && message.status === "completed"), 5_000, "saludo");
    const messages = await server.call(`/api/agents/${agent.id}/messages`);
    assert.deepEqual(
      messages.json?.messages.map((message: { role: string }) => message.role),
      ["activity", "assistant"],
    );
    assert.match(messages.json?.messages[1].text, /^¡Hola, Jonathan! Soy d/);

    // Menú de la barra lateral.
    assert.equal((await server.call(`/api/agents/${agent.id}`, { method: "PATCH", body: { pinned: true, hidden: true } })).json?.agent.hidden, true);
    assert.equal((await server.call(`/api/agents/${agent.id}`, { method: "PATCH", body: { pinned: "sí" } })).status, 400);
    assert.equal((await server.call(`/api/agents/${agent.id}/unread`, { method: "POST" })).json?.agent.unread, true);
    assert.equal((await server.call("/api/read-all", { method: "POST" })).json?.changed, 1);
    const voice = await server.call(`/api/agents/${agent.id}`, { method: "PATCH", body: { voice: { rate: 1.5, lang: "es-CL" } } });
    assert.deepEqual(voice.json?.agent.voice, { name: "", rate: 1.5, lang: "es-CL", autoRead: false, engine: "system", elevenVoice: "", elevenName: "" });

    // Secciones.
    assert.deepEqual((await server.call("/api/sections", { method: "POST", body: { name: "Correo" } })).json?.sections, ["Correo"]);
    assert.equal((await server.call("/api/sections", { method: "POST", body: { name: "correo" } })).status, 409);
    assert.deepEqual((await server.call("/api/sections/rename", { method: "POST", body: { from: "Correo", to: "Correo y agenda" } })).json?.sections, ["Correo y agenda"]);
    assert.deepEqual((await server.call("/api/sections/delete", { method: "POST", body: { name: "Correo y agenda" } })).json?.sections, []);
    const state = await server.call("/api/state");
    assert.deepEqual(state.json?.sections, []);
    assert.deepEqual(state.json?.usage, []);

    // Biblioteca: lista, ve archivos seguros en el navegador y descarga el resto, siempre sin scripts.
    writeFileSync(join(agent.workspace, "nota.txt"), "hola");
    writeFileSync(join(agent.workspace, "pagina.html"), "<script>alert(1)</script>");
    const library = await server.call(`/api/agents/${agent.id}/library?root=agent`);
    assert.deepEqual(
      library.json?.entries.map((entry: { name: string }) => entry.name),
      ["nota.txt", "pagina.html"],
    );
    const text = await fetch(`${server.base}/api/agents/${agent.id}/library/file?path=nota.txt`, { headers: { cookie: server.cookie } });
    assert.equal(text.status, 200);
    assert.equal(await text.text(), "hola");
    assert.equal(text.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.match(text.headers.get("content-disposition") ?? "", /^inline/);
    assert.match(text.headers.get("content-security-policy") ?? "", /^sandbox/);
    const html = await fetch(`${server.base}/api/agents/${agent.id}/library/file?path=pagina.html`, { headers: { cookie: server.cookie } });
    await html.arrayBuffer();
    assert.equal(html.headers.get("content-type"), "application/octet-stream");
    assert.match(html.headers.get("content-disposition") ?? "", /^attachment; filename\*=UTF-8''pagina\.html/);
    assert.equal((await server.call(`/api/agents/${agent.id}/library/file?path=../../etc/passwd`)).status, 400);
    assert.equal((await server.call(`/api/agents/${agent.id}/library?root=otra`)).status, 400);
    const anonymous = await fetch(`${server.base}/api/agents/${agent.id}/library/file?path=nota.txt`);
    assert.equal(anonymous.status, 401);
    await anonymous.arrayBuffer();

    // Abrir la carpeta solo desde el propio equipo (no a través de tailscale serve).
    const forwarded = await server.call(`/api/agents/${agent.id}/open-folder`, {
      method: "POST",
      body: { root: "agent" },
      headers: { "x-forwarded-for": "100.64.0.7" },
    });
    assert.equal(forwarded.status, 403);

    // Uso del plan.
    assert.deepEqual((await server.call("/api/usage")).json?.usage, []);
    assert.equal((await server.call("/api/usage/refresh", { method: "POST" })).status, 200);
  } finally {
    await server.close();
  }
});

test("HTTP: dictado local (estado, descarga, transcripción y avisos por el flujo de eventos)", async () => {
  // Sin motor de dictado: la ventana lo sabe (speech: null) y las acciones responden 503.
  const without = await startServer();
  try {
    await without.login();
    assert.deepEqual((await without.call("/api/speech")).json, { speech: null });
    assert.equal((await without.call("/api/speech/install", { method: "POST" })).status, 503);
    assert.equal((await without.call("/api/speech/prepare", { method: "POST" })).status, 503);
    const none = await without.call("/api/speech/transcribe", { method: "POST", body: toneWav(1), headers: { "content-type": "audio/wav" } });
    assert.equal(none.status, 503);
  } finally {
    await without.close();
  }

  const temp = tempDir();
  const archive = Buffer.from("modelo de prueba");
  const model: SpeechModel = {
    id: "prueba",
    label: "Modelo de prueba",
    url: "https://example.invalid/modelo.tar.bz2",
    bytes: archive.length,
    sha256: createHash("sha256").update(archive).digest("hex"),
    dir: "modelo",
    files: { encoder: "e.onnx", decoder: "d.onnx", joiner: "j.onnx", tokens: "tokens.txt" },
  };
  let releaseDownload: () => void = () => undefined;
  const downloadGate = new Promise<void>((resolve) => {
    releaseDownload = resolve;
  });
  const heard: number[] = [];
  const speech = new SpeechEngine({
    dir: temp.path,
    model,
    fetch: (async () => {
      await downloadGate;
      return new Response(archive, { status: 200 });
    }) as typeof fetch,
    extract: async (_archive, destination) => {
      mkdirSync(join(destination, model.dir), { recursive: true });
      for (const name of Object.values(model.files)) writeFileSync(join(destination, model.dir, name), "x");
    },
    recognize: async (samples, rate) => {
      heard.push(samples.length / rate);
      return " Hola, ¿qué tal? ";
    },
  });
  const s = await startServer({ speech });
  const controller = new AbortController();
  try {
    // Sin sesión ni cabecera anti-CSRF, nada.
    assert.equal((await s.call("/api/speech")).status, 401);
    await s.login();
    assert.equal((await s.call("/api/speech/install", { method: "POST", headers: { "x-cuadrilla": "" } })).status, 403);

    const stream = await fetch(`${s.base}/api/events`, { headers: { cookie: s.cookie }, signal: controller.signal });
    const events: Array<Record<string, any>> = [];
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          let index = buffer.indexOf("\n\n");
          while (index >= 0) {
            for (const line of buffer.slice(0, index).split("\n")) if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
            buffer = buffer.slice(index + 2);
            index = buffer.indexOf("\n\n");
          }
        }
      } catch {
        // abortado al final de la prueba
      }
    })();
    const hello = await waitFor(() => events.find((event) => event.type === "hello"), 3_000, "hello");
    assert.equal(hello.speech.state, "missing");
    assert.equal(hello.speech.model, "Modelo de prueba");

    const status = await s.call("/api/speech");
    assert.equal(status.json?.speech.state, "missing");
    assert.equal(status.json?.speech.sizeMb, 0);

    // Sin el modelo, transcribir responde 409 para que la ventana ofrezca descargarlo.
    const early = await s.call("/api/speech/transcribe", { method: "POST", body: toneWav(1), headers: { "content-type": "audio/wav" } });
    assert.equal(early.status, 409);

    // La descarga responde enseguida (202) y el avance llega por el flujo de eventos.
    const install = await s.call("/api/speech/install", { method: "POST" });
    assert.equal(install.status, 202);
    assert.equal(install.json?.speech.state, "downloading");
    releaseDownload();
    await waitFor(() => events.some((event) => event.type === "speech" && event.speech.state === "ready"), 3_000, "dictado listo");
    assert.ok(events.some((event) => event.type === "speech" && event.speech.state === "extracting"));
    assert.equal((await s.call("/api/speech/prepare", { method: "POST" })).status, 204);

    // Un trozo de audio de verdad (WAV binario) vuelve como texto limpio.
    const wav = toneWav(1.5, 48_000);
    const response = await fetch(`${s.base}/api/speech/transcribe`, {
      method: "POST",
      headers: { cookie: s.cookie, "x-cuadrilla": "1", "content-type": "audio/wav" },
      body: wav,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: "Hola, ¿qué tal?" });
    assert.deepEqual(heard, [1.5]);

    // Lo que no es WAV: 400.
    const junk = await s.call("/api/speech/transcribe", { method: "POST", body: "no es audio", headers: { "content-type": "audio/wav" } });
    assert.equal(junk.status, 400);
    assert.match(String(junk.json?.error), /WAV/);
  } finally {
    controller.abort();
    await s.close();
    await speech.stop();
    temp.cleanup();
  }
});

test("HTTP: canales (crear, escribir, leer, eliminar, restaurar y borrar para siempre)", async () => {
  const s = await startServer();
  try {
    await s.login();
    const ana = (await s.call("/api/agents", { method: "POST", body: { name: "Ana", provider: "demo" } })).json?.agent as { id: string };
    const created = await s.call("/api/channels", { method: "POST", body: { name: "#Ventas", topic: "Precios", memberIds: [ana.id] } });
    assert.equal(created.status, 201);
    const channel = created.json?.channel as { id: string; name: string; leadId: string };
    assert.equal(channel.name, "Ventas");
    assert.equal(channel.leadId, ana.id);
    const duplicate = await s.call("/api/channels", { method: "POST", body: { name: "ventas", memberIds: [ana.id] } });
    assert.equal(duplicate.status, 409);
    const empty = await s.call("/api/channels", { method: "POST", body: { name: "Vacío", memberIds: [] } });
    assert.equal(empty.status, 400);
    const state = await s.call("/api/state");
    assert.equal(state.json?.channels[0].id, channel.id);

    const sent = await s.call(`/api/channels/${channel.id}/messages`, { method: "POST", body: { text: "hola canal" } });
    assert.equal(sent.status, 202);
    assert.deepEqual(sent.json?.recipients, [{ id: ana.id, name: "Ana" }]);
    const noText = await s.call(`/api/channels/${channel.id}/messages`, { method: "POST", body: {} });
    assert.equal(noText.status, 400);
    await waitFor(
      () => s.h.service.listChannelMessages(channel.id).some((message) => message.role === "assistant" && message.status === "completed"),
      5_000,
      "respuesta en el canal",
    );
    const history = await s.call(`/api/channels/${channel.id}/messages?limit=1`);
    assert.equal(history.json?.messages.length, 1);
    assert.equal(history.json?.messages[0].role, "assistant");
    assert.equal(history.json?.hasMore, true);
    const agentHistory = await s.call(`/api/agents/${ana.id}/messages`);
    assert.deepEqual(agentHistory.json?.messages, [], "lo del canal no aparece en la conversación privada");

    const renamed = await s.call(`/api/channels/${channel.id}`, { method: "PATCH", body: { name: "Ventas 2026", ignored: true } });
    assert.equal(renamed.json?.channel.name, "Ventas 2026");
    assert.equal((await s.call(`/api/channels/${channel.id}/read`, { method: "POST" })).json?.channel.unread, false);
    assert.equal((await s.call(`/api/channels/${channel.id}/unread`, { method: "POST" })).json?.channel.unread, true);
    assert.equal((await s.call(`/api/channels/${channel.id}/interrupt`, { method: "POST" })).json?.interrupted, false);

    const notYet = await s.call(`/api/channels/${channel.id}/permanent`, { method: "DELETE" });
    assert.equal(notYet.status, 409);
    const removed = await s.call(`/api/channels/${channel.id}`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.ok(removed.json?.channel.deletedAt);
    const lists = await s.call("/api/channels");
    assert.deepEqual(lists.json?.channels, []);
    assert.equal(lists.json?.deleted[0].id, channel.id);
    const restored = await s.call(`/api/channels/${channel.id}/restore`, { method: "POST" });
    assert.equal(restored.json?.channel.deletedAt, null);
    await s.call(`/api/channels/${channel.id}`, { method: "DELETE" });
    const purged = await s.call(`/api/channels/${channel.id}/permanent`, { method: "DELETE" });
    assert.equal(purged.status, 200);
    assert.equal((await s.call(`/api/channels/${channel.id}`)).status, 404);
    const noCsrf = await s.call("/api/channels", { method: "POST", body: { name: "Sin CSRF", memberIds: [ana.id] }, headers: { "x-cuadrilla": "" } });
    assert.equal(noCsrf.status, 403);
  } finally {
    await s.close();
  }
});

test("HTTP: voces de ElevenLabs (clave que no vuelve, audio en camino y errores que no cierran la sesión)", async () => {
  // Sin ElevenLabs en el servidor: 503, no 401.
  const without = await startServer();
  try {
    await without.login();
    assert.equal((await without.call("/api/voices/elevenlabs")).status, 503);
    assert.equal((await without.call("/api/tts", { method: "POST", body: { voiceId: "premadeAna0001", text: "Hola" } })).status, 503);
  } finally {
    await without.close();
  }

  const fake = fakeElevenLabs();
  const s = await startServer((h) => ({ elevenLabs: new ElevenLabs({ store: h.store, fetch: fake.fetch }) }));
  try {
    assert.equal((await s.call("/api/voices/elevenlabs")).status, 401, "hace falta la sesión");
    await s.login();
    assert.equal((await s.call("/api/voices/elevenlabs", { method: "PUT", body: { key: GOOD_KEY }, headers: { "x-cuadrilla": "" } })).status, 403);
    assert.equal((await s.call("/api/voices/elevenlabs")).json?.elevenlabs.configured, false);
    const tooEarly = await s.call("/api/tts", { method: "POST", body: { voiceId: "premadeAna0001", text: "Hola" } });
    assert.equal(tooEarly.status, 409);

    const bad = await s.call("/api/voices/elevenlabs", { method: "PUT", body: { key: "sk_malo00123456789abcdef0123456789abcdef" } });
    assert.equal(bad.status, 400);
    assert.match(bad.json?.error, /rechazó la clave/);

    const saved = await s.call("/api/voices/elevenlabs", { method: "PUT", body: { key: GOOD_KEY } });
    assert.equal(saved.status, 200);
    assert.equal(saved.json?.elevenlabs.configured, true);
    assert.equal(saved.json?.elevenlabs.voices.length, 3);
    for (const path of ["/api/voices/elevenlabs", "/api/voices/elevenlabs?refresh=1", "/api/state"]) {
      const response = await s.call(path);
      assert.equal(response.status, 200);
      assert.ok(!JSON.stringify(response.json).includes(GOOD_KEY), `la clave no sale por ${path}`);
    }

    const audio = await fetch(`${s.base}/api/tts`, {
      method: "POST",
      headers: { "x-cuadrilla": "1", "content-type": "application/json", cookie: s.cookie },
      body: JSON.stringify({ voiceId: "premadeAna0001", text: "Hola, soy Ana." }),
    });
    assert.equal(audio.status, 200);
    assert.equal(audio.headers.get("content-type"), "audio/mpeg");
    assert.equal(audio.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(new Uint8Array(await audio.arrayBuffer()), AUDIO);
    assert.deepEqual(fake.calls.at(-1)?.body, { text: "Hola, soy Ana.", model_id: "eleven_flash_v2_5" });

    assert.equal((await s.call("/api/tts", { method: "POST", body: { voiceId: "../x", text: "Hola" } })).status, 400);
    assert.equal((await s.call("/api/tts", { method: "POST", body: { voiceId: "premadeAna0001", text: "" } })).status, 400);
    // ElevenLabs responde 401 cuando se acaban los caracteres: aquí llega como 402 y la sesión sigue abierta.
    const quota = await s.call("/api/tts", { method: "POST", body: { voiceId: "sinCaracteres", text: "Hola" } });
    assert.equal(quota.status, 402);
    assert.equal((await s.call("/api/session")).json?.authenticated, true);

    const csp = (await fetch(`${s.base}/`)).headers.get("content-security-policy") ?? "";
    assert.match(csp, /media-src 'self' blob: data:/);

    const removed = await s.call("/api/voices/elevenlabs", { method: "PUT", body: { key: "" } });
    assert.equal(removed.json?.elevenlabs.configured, false);
  } finally {
    await s.close();
  }
});
