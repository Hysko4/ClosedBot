import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { type Auth, clearSessionCookie, hashToken, type LoginResult, readCookie, SESSION_COOKIE, serializeSessionCookie } from "./auth.js";
import { isRecord } from "./providers/protocol.js";
import { type AgentInput, type AgentService, MAX_UPLOAD_BYTES, ServiceError, type ServiceEvent, VERSION } from "./service.js";

export interface AppOptions {
  service: AgentService;
  auth: Auth;
  publicDir: string;
  sharedDir: string;
  workspacesDir: string;
  maxHops: number;
  secureCookies: "auto" | "always" | "never";
  /**
   * Token del lanzador de escritorio: con él, y solo desde este equipo, se pide un código de acceso de un solo uso
   * o se apaga la app. Sin token, esas rutas no existen.
   */
  controlToken?: string | null;
  /** Se llama tras responder a /api/control/shutdown. */
  onShutdown?: () => void;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

export interface App {
  server: Server;
  /** Cierra los flujos de eventos abiertos (para apagar sin esperar a los clientes). */
  closeStreams(): void;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Context {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: string[];
  token: string | undefined;
}

type Handler = (ctx: Context) => Promise<unknown> | unknown;

const JSON_LIMIT = 2 * 1024 * 1024;
/** De un cuerpo demasiado grande se lee y descarta hasta esta cantidad antes de responder 413; más allá se corta. */
const DISCARD_LIMIT = 16 * 1024 * 1024;
const SSE_BUFFER_LIMIT = 4 * 1024 * 1024;
const NO_CONTENT = Symbol("no-content");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function createApp(options: AppOptions): App {
  const { service, auth } = options;
  const publicDir = resolve(options.publicDir);
  const streams = new Map<ServerResponse, string>();
  const log = options.log ?? (() => undefined);

  const routes: Array<{ method: string; pattern: RegExp; handler: Handler; public?: boolean }> = [];
  const route = (method: string, path: string, handler: Handler, isPublic = false) => {
    const pattern = new RegExp(`^${path.replace(/:[a-zA-Z]+/g, "([^/]+)")}$`);
    routes.push({ method, pattern, handler, public: isPublic });
  };

  // ---------- sesión ----------

  route("GET", "/api/health", () => ({ ok: true, version: VERSION }), true);

  route("GET", "/api/session", (ctx) => ({ authenticated: auth.validate(ctx.token), version: VERSION }), true);

  const finishLogin = (ctx: Context, result: LoginResult, invalidMessage: string) => {
    if (!result.ok) {
      if (result.reason === "locked") {
        ctx.res.setHeader("retry-after", String(result.retryAfterSeconds ?? 900));
        throw new HttpError(429, `Demasiados intentos fallidos. Espera ${Math.ceil((result.retryAfterSeconds ?? 900) / 60)} min.`);
      }
      if (result.reason === "unconfigured") throw new HttpError(503, "Falta crear la contraseña: ejecuta «npm run password» en el servidor.");
      throw new HttpError(401, invalidMessage);
    }
    ctx.res.setHeader("set-cookie", serializeSessionCookie(result.token, result.maxAgeSeconds, secureRequest(ctx.req, options.secureCookies)));
    return { authenticated: true };
  };

  route(
    "POST",
    "/api/login",
    async (ctx) => {
      const body = await readJson(ctx.req);
      return finishLogin(ctx, await auth.login(body.password, clientKey(ctx.req), header(ctx.req, "user-agent")), "Contraseña incorrecta.");
    },
    true,
  );

  route(
    "POST",
    "/api/login/code",
    async (ctx) => {
      const body = await readJson(ctx.req);
      const result = auth.redeemLoginCode(body.code, clientKey(ctx.req), header(ctx.req, "user-agent"));
      return finishLogin(ctx, result, "El enlace de acceso venció o ya se usó. Entra con tu contraseña.");
    },
    true,
  );

  // ---------- control del lanzador de escritorio ----------

  /** Solo el lanzador local (mismo equipo, sin proxy) con el token que le pasó al servidor al arrancarlo. */
  const requireControl = (req: IncomingMessage) => {
    const expected = options.controlToken;
    if (!expected) throw new HttpError(404, "Ruta no encontrada.");
    const proxied = header(req, "x-forwarded-for") || header(req, "x-forwarded-host") || header(req, "forwarded");
    if (!isLoopback(req.socket.remoteAddress) || proxied) throw new HttpError(403, "Solo disponible desde este equipo.");
    const given = createHash("sha256").update(header(req, "x-cuadrilla-control") ?? "").digest();
    if (!timingSafeEqual(given, createHash("sha256").update(expected).digest())) throw new HttpError(403, "Token de control inválido.");
  };

  route(
    "POST",
    "/api/control/login-link",
    (ctx) => {
      requireControl(ctx.req);
      return { path: `/?acceso=${encodeURIComponent(auth.createLoginCode())}` };
    },
    true,
  );

  route(
    "POST",
    "/api/control/shutdown",
    (ctx) => {
      requireControl(ctx.req);
      ctx.res.once("finish", () => options.onShutdown?.());
      return { ok: true };
    },
    true,
  );

  route(
    "POST",
    "/api/logout",
    (ctx) => {
      auth.logout(ctx.token);
      if (ctx.token) closeStreamsFor(hashToken(ctx.token));
      ctx.res.setHeader("set-cookie", clearSessionCookie(secureRequest(ctx.req, options.secureCookies)));
      return { authenticated: false };
    },
    true,
  );

  // ---------- estado ----------

  route("GET", "/api/state", () => ({
    version: VERSION,
    agents: service.listAgents(),
    providers: service.providers(),
    routines: service.listRoutines(),
    settings: service.getSettings(),
    paths: { shared: options.sharedDir, workspaces: options.workspacesDir },
    maxHops: options.maxHops,
    platform: process.platform,
  }));

  route("GET", "/api/settings", () => ({ settings: service.getSettings() }));

  route("PATCH", "/api/settings", async (ctx) => {
    const body = await readJson(ctx.req);
    return { settings: service.updateSettings({ botName: body.botName, userName: body.userName }) };
  });

  route("POST", "/api/providers/refresh", async () => ({ providers: await service.refreshProviders() }));

  // Inicio de sesión con la cuenta del proveedor: su CLI abre el navegador en este equipo.
  route("POST", "/api/providers/:id/login", (ctx) => ({ providers: service.startSignIn(param(ctx, 0)) }));

  route("POST", "/api/providers/:id/login/code", async (ctx) => {
    const body = await readJson(ctx.req);
    service.submitSignInCode(param(ctx, 0), body.code);
    return { providers: service.providers() };
  });

  route("POST", "/api/providers/:id/login/cancel", (ctx) => ({ providers: service.cancelSignIn(param(ctx, 0)) }));

  route("POST", "/api/providers/:id/logout", async (ctx) => ({ providers: await service.signOut(param(ctx, 0)) }));

  route("GET", "/api/models", async (ctx) => {
    const provider = ctx.url.searchParams.get("provider");
    if (provider !== "claude" && provider !== "codex" && provider !== "demo") throw new HttpError(400, "Proveedor inválido.");
    return { models: await service.listModels(provider) };
  });

  // ---------- agentes ----------

  route("GET", "/api/agents", () => ({ agents: service.listAgents() }));

  route("POST", "/api/agents", async (ctx) => {
    const body = await readJson(ctx.req);
    ctx.res.statusCode = 201;
    return { agent: service.createAgent(agentInput(body, true) as AgentInput) };
  });

  route("GET", "/api/agents/:id", (ctx) => ({ agent: service.getAgent(param(ctx, 0)) }));

  route("PATCH", "/api/agents/:id", async (ctx) => {
    const body = await readJson(ctx.req);
    return { agent: service.updateAgent(param(ctx, 0), agentInput(body, false)) };
  });

  route("DELETE", "/api/agents/:id", async (ctx) => {
    await service.deleteAgent(param(ctx, 0));
    return NO_CONTENT;
  });

  route("POST", "/api/agents/:id/reset", async (ctx) => ({ agent: await service.resetConversation(param(ctx, 0)) }));

  route("POST", "/api/agents/:id/pause", async (ctx) => {
    const body = await readJson(ctx.req);
    if (typeof body.paused !== "boolean") throw new HttpError(400, "Indica paused: true o false.");
    return { agent: service.setPaused(param(ctx, 0), body.paused) };
  });

  route("POST", "/api/agents/:id/interrupt", async (ctx) => ({ interrupted: await service.interrupt(param(ctx, 0)) }));

  route("GET", "/api/agents/:id/messages", (ctx) => {
    const limit = clampInt(ctx.url.searchParams.get("limit"), 100, 1, 500);
    const before = clampInt(ctx.url.searchParams.get("before"), 0, 0, Number.MAX_SAFE_INTEGER);
    const messages = service.listMessages(param(ctx, 0), limit + 1, before || undefined);
    const hasMore = messages.length > limit;
    return { messages: hasMore ? messages.slice(1) : messages, hasMore };
  });

  route("POST", "/api/agents/:id/messages", async (ctx) => {
    const body = await readJson(ctx.req);
    if (typeof body.text !== "string") throw new HttpError(400, "Falta el texto del mensaje.");
    ctx.res.statusCode = 202;
    return service.sendUserMessage(param(ctx, 0), body.text);
  });

  route("POST", "/api/agents/:id/read", (ctx) => ({ agent: service.markRead(param(ctx, 0)) }));

  route("POST", "/api/agents/:id/decisions/:messageId", async (ctx) => {
    const body = await readJson(ctx.req);
    const { decision, message } = service.answerDecision(param(ctx, 0), param(ctx, 1), body.choice);
    return { decision, message };
  });

  route("POST", "/api/agents/:id/files", async (ctx) => {
    const agentId = param(ctx, 0);
    service.getAgent(agentId);
    const name = ctx.url.searchParams.get("name") ?? "";
    const data = await readBody(ctx.req, MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES);
    ctx.res.statusCode = 201;
    return { file: service.saveAttachment(agentId, name, data) };
  });

  route("GET", "/api/agents/:id/queue", (ctx) => ({ queue: service.listQueue(param(ctx, 0)) }));

  route("DELETE", "/api/agents/:id/queue/:deliveryId", (ctx) => {
    service.cancelQueued(param(ctx, 0), param(ctx, 1));
    return NO_CONTENT;
  });

  // ---------- rutinas ----------

  route("GET", "/api/routines", () => ({ routines: service.listRoutines() }));

  route("POST", "/api/routines", async (ctx) => {
    const body = await readJson(ctx.req);
    if (typeof body.agentId !== "string" || !body.agentId) throw new HttpError(400, "Indica el agente de la rutina.");
    ctx.res.statusCode = 201;
    return {
      routine: service.createRoutine(body.agentId, {
        name: body.name,
        prompt: body.prompt,
        times: body.times,
        days: body.days,
        everyMinutes: body.everyMinutes,
      }),
    };
  });

  route("PATCH", "/api/routines/:id", async (ctx) => {
    const body = await readJson(ctx.req);
    if (typeof body.enabled !== "boolean") throw new HttpError(400, "Indica enabled: true o false.");
    return { routine: service.setRoutineEnabled(param(ctx, 0), body.enabled) };
  });

  route("DELETE", "/api/routines/:id", (ctx) => {
    service.deleteRoutine(param(ctx, 0));
    return NO_CONTENT;
  });

  route("POST", "/api/routines/:id/run", (ctx) => ({ routine: service.runRoutineNow(param(ctx, 0)) }));

  // ---------- eventos en vivo (SSE) ----------

  route("GET", "/api/events", (ctx) => {
    openEventStream(ctx);
    return NO_CONTENT;
  });

  function openEventStream(ctx: Context): void {
    const { res } = ctx;
    const tokenHash = hashToken(ctx.token ?? "");
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 3000\n\n");
    const send = (event: ServiceEvent | { type: "hello"; [key: string]: unknown }) => {
      if (res.writableEnded) return;
      if (res.writableLength > SSE_BUFFER_LIMIT) {
        // Cliente demasiado lento: se corta y, al reconectar, recarga el estado completo.
        res.end();
        return;
      }
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    send({
      type: "hello",
      version: VERSION,
      agents: service.listAgents(),
      providers: service.providers(),
      routines: service.listRoutines(),
      settings: service.getSettings(),
    });
    const listener = (event: ServiceEvent) => send(event);
    service.on("event", listener);
    const heartbeat = setInterval(() => {
      if (!auth.validate(ctx.token)) {
        res.end();
        return;
      }
      res.write(": ping\n\n");
    }, 25_000);
    streams.set(res, tokenHash);
    const cleanup = () => {
      clearInterval(heartbeat);
      service.off("event", listener);
      streams.delete(res);
    };
    res.once("close", cleanup);
  }

  function closeStreamsFor(tokenHash: string): void {
    for (const [res, hash] of streams) if (hash === tokenHash) res.end();
  }

  // ---------- despacho ----------

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    res.setHeader("cache-control", "no-store");
    const method = req.method ?? "GET";
    const matches = routes.filter((entry) => entry.pattern.test(url.pathname));
    if (!matches.length) throw new HttpError(404, "Ruta no encontrada.");
    const entry = matches.find((candidate) => candidate.method === method);
    if (!entry) {
      res.setHeader("allow", matches.map((candidate) => candidate.method).join(", "));
      throw new HttpError(405, "Método no permitido.");
    }
    if (method !== "GET" && method !== "HEAD") {
      // Defensa CSRF: un formulario o página ajena no puede añadir esta cabecera sin CORS.
      if (header(req, "x-cuadrilla") !== "1") throw new HttpError(403, "Falta la cabecera x-cuadrilla.");
      if (!sameOrigin(req)) throw new HttpError(403, "Origen no permitido.");
    }
    const token = readCookie(header(req, "cookie") ?? undefined, SESSION_COOKIE);
    if (!entry.public && !auth.validate(token)) throw new HttpError(401, "Inicia sesión.");
    const params = (entry.pattern.exec(url.pathname) ?? []).slice(1).map((value) => safeDecode(value));
    const result = await entry.handler({ req, res, url, params, token });
    if (result === NO_CONTENT) {
      if (!res.headersSent) {
        res.statusCode = 204;
        res.end();
      }
      return;
    }
    sendJson(res, res.statusCode && res.statusCode !== 200 ? res.statusCode : 200, result);
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Método no permitido.");
    const pathname = safeDecode(url.pathname === "/" ? "/index.html" : url.pathname);
    if (pathname.includes("\0")) throw new HttpError(400, "Ruta inválida.");
    const file = resolve(publicDir, `.${pathname}`);
    if (!file.startsWith(publicDir + sep)) throw new HttpError(404, "No encontrado.");
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw new HttpError(404, "No encontrado.");
    const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    res.setHeader("etag", etag);
    res.setHeader("cache-control", "no-cache");
    res.setHeader("content-type", MIME[extname(file).toLowerCase()] ?? "application/octet-stream");
    if (header(req, "if-none-match") === etag) {
      res.statusCode = 304;
      res.end();
      return;
    }
    res.setHeader("content-length", String(info.size));
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    await new Promise<void>((resolveStream, reject) => {
      const stream = createReadStream(file);
      stream.once("error", reject);
      res.once("close", () => {
        stream.destroy();
        resolveStream();
      });
      stream.once("end", resolveStream);
      stream.pipe(res);
    });
  }

  const server = createServer((req, res) => {
    setSecurityHeaders(res);
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://closedbot.local");
    } catch {
      sendJson(res, 400, { error: "URL inválida." });
      return;
    }
    const work = url.pathname.startsWith("/api/") ? handleApi(req, res, url) : serveStatic(req, res, url);
    work.catch((error: unknown) => {
      const status = error instanceof HttpError || error instanceof ServiceError ? error.status : 500;
      if (status >= 500 && !(error instanceof HttpError) && !(error instanceof ServiceError)) {
        log("error", `${req.method} ${url.pathname}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      }
      if (res.headersSent) {
        res.end();
        return;
      }
      const message = error instanceof HttpError || error instanceof ServiceError ? error.message : "Error interno del servidor.";
      if (status === 413 && !req.complete) res.setHeader("connection", "close");
      sendJson(res, status, { error: message });
    });
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 0; // el flujo SSE es indefinido; el cuerpo JSON se limita por tamaño
  server.keepAliveTimeout = 65_000;

  return {
    server,
    closeStreams() {
      for (const res of streams.keys()) res.end();
      streams.clear();
    },
  };
}

// ---------- utilidades HTTP ----------

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("content-security-policy", CSP);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("cross-origin-opener-policy", "same-origin");
  res.setHeader("cross-origin-resource-policy", "same-origin");
  // El micrófono solo para el dictado por voz de la propia app.
  res.setHeader("permissions-policy", "camera=(), microphone=(self), geolocation=(), payment=(), usb=()");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body ?? {});
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", String(Buffer.byteLength(payload)));
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = header(req, "content-type") ?? "";
  if (!/^application\/json\b/i.test(type)) throw new HttpError(415, "Envía el cuerpo como JSON.");
  const body = await readBody(req, JSON_LIMIT);
  if (!body.length) return {};
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "JSON inválido.");
  }
  if (!isRecord(value)) throw new HttpError(400, "Se esperaba un objeto JSON.");
  return value;
}

/**
 * Lee el cuerpo entero. Si pasa de `limit`, sigue leyendo y descartando el resto, y solo al final rechaza con 413:
 * si el servidor respondiera y cerrara con datos sin leer, el sistema cortaría con un RST y el cliente (sobre todo en
 * Windows) perdería la respuesta. Lo que pase de `discardLimit` ya no se lee y la conexión se cierra.
 */
function readBody(req: IncomingMessage, limit: number, discardLimit = DISCARD_LIMIT): Promise<Buffer> {
  const tooLarge = () => new HttpError(413, "La solicitud es demasiado grande.");
  if (Number(header(req, "content-length") ?? "0") > discardLimit) return Promise.reject(tooLarge());
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (error: HttpError | null) => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onInterrupted);
      req.off("close", onInterrupted);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks));
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > discardLimit) finish(tooLarge());
      else if (size <= limit) chunks.push(chunk);
    };
    const onEnd = () => finish(size > limit ? tooLarge() : null);
    const onInterrupted = () => finish(new HttpError(400, "La solicitud se interrumpió."));
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onInterrupted);
    req.on("close", onInterrupted);
  });
}

function agentInput(body: Record<string, unknown>, creating: boolean): Partial<AgentInput> {
  const input: Partial<AgentInput> = {};
  const text = (key: string): string | undefined => {
    const value = body[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw new HttpError(400, `El campo ${key} debe ser texto.`);
    return value;
  };
  const optional = (key: string): string | null | undefined => {
    const value = body[key];
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== "string") throw new HttpError(400, `El campo ${key} debe ser texto.`);
    return value;
  };
  const name = text("name");
  if (name !== undefined) input.name = name;
  const role = text("role");
  if (role !== undefined) input.role = role;
  const instructions = text("instructions");
  if (instructions !== undefined) input.instructions = instructions;
  const provider = text("provider");
  if (provider !== undefined) input.provider = provider as AgentInput["provider"];
  const model = optional("model");
  if (model !== undefined) input.model = model;
  const effort = optional("effort");
  if (effort !== undefined) input.effort = effort;
  const project = text("project");
  if (project !== undefined) input.project = project;
  const access = text("access");
  if (access !== undefined) {
    if (access !== "carpeta" && access !== "total") throw new HttpError(400, "El acceso debe ser «carpeta» o «total».");
    input.access = access;
  }
  if (creating && (input.name === undefined || input.provider === undefined)) {
    throw new HttpError(400, "Indica al menos el nombre y el proveedor.");
  }
  return input;
}

function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** Clave para limitar intentos: la IP real que reenvía `tailscale serve` (solo si llega por loopback). */
function clientKey(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? "desconocido";
  const forwarded = header(req, "x-forwarded-for");
  if (forwarded && isLoopback(remote)) return forwarded.split(",")[0]?.trim() || remote;
  return remote;
}

function secureRequest(req: IncomingMessage, mode: "auto" | "always" | "never"): boolean {
  if (mode !== "auto") return mode === "always";
  if ("encrypted" in req.socket && req.socket.encrypted) return true;
  return isLoopback(req.socket.remoteAddress) && header(req, "x-forwarded-proto") === "https";
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = header(req, "origin");
  if (!origin) return true;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const candidates = [header(req, "host"), header(req, "x-forwarded-host")].filter((value): value is string => Boolean(value));
  return candidates.some((candidate) => candidate.toLowerCase() === host.toLowerCase());
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "Ruta inválida.");
  }
}

function param(ctx: Context, index: number): string {
  const value = ctx.params[index];
  if (!value) throw new HttpError(400, "Falta un parámetro en la ruta.");
  return value;
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
