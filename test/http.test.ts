import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { type AddressInfo, connect } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type AppOptions, createApp } from "../src/app.js";
import { Auth, hashPassword, PASSWORD_META } from "../src/auth.js";
import { createHarness, waitFor } from "./helpers.js";

const publicDir = fileURLToPath(new URL("../../public", import.meta.url));
const PASSWORD = "contraseña-de-prueba";

async function startServer(extra: Partial<AppOptions> = {}) {
  const h = await createHarness();
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
    ...extra,
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
      body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
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
    assert.deepEqual(state.json?.settings, { botName: "ClosedBot", userName: "" });
    const paused = await s.call(`/api/routines/${routineId}`, { method: "PATCH", body: { enabled: false } });
    assert.equal(paused.json?.routine.enabled, false);
    const ran = await s.call(`/api/routines/${routineId}/run`, { method: "POST" });
    assert.equal(ran.status, 200);
    assert.equal((await s.call(`/api/routines/${routineId}`, { method: "DELETE" })).status, 204);
    assert.equal((await s.call(`/api/routines/${routineId}`, { method: "DELETE" })).status, 404);

    // Ajustes.
    const settings = await s.call("/api/settings", { method: "PATCH", body: { userName: "Jonathan" } });
    assert.deepEqual(settings.json?.settings, { botName: "ClosedBot", userName: "Jonathan" });
    assert.equal((await s.call("/api/settings", { method: "PATCH", body: { botName: 5 } })).status, 400);

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
  } finally {
    await s.close();
  }
});
