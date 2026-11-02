import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/app.js";
import { Auth, hashPassword, PASSWORD_META } from "../src/auth.js";
import { createHarness, waitFor } from "./helpers.js";

const publicDir = fileURLToPath(new URL("../../public", import.meta.url));
const PASSWORD = "contraseña-de-prueba";

async function startServer() {
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
    assert.match(await index.text(), /Cuadrilla/);
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
