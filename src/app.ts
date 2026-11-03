import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream, mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { type Auth, clearSessionCookie, hashToken, type LoginResult, readCookie, SESSION_COOKIE, serializeSessionCookie } from "./auth.js";
import { isProviderId } from "./providers/client.js";
import { isRecord } from "./providers/protocol.js";
import type { VoiceSettings } from "./db.js";
import { type AgentInput, type AgentService, type LibraryRoot, MAX_UPLOAD_BYTES, ServiceError, type ServiceEvent, VERSION } from "./service.js";
import { MAX_SPEECH_BYTES, type SpeechEngine, SpeechError, type SpeechStatus } from "./speech.js";
import { type LocalVoices, LocalVoicesError, type LocalVoicesStatus } from "./voices.js";

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
  /** Dictado local (reconocimiento de voz en este equipo). Sin él, las rutas /api/speech responden 503. */
  speech?: SpeechEngine | null;
  /** Voces locales para leer en voz alta (Supertonic). Sin ellas, las rutas /api/voices responden 503. */
  voices?: LocalVoices | null;
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

/** Archivos de la biblioteca que se pueden ver en el navegador; el resto se descarga. Nunca HTML, SVG ni scripts. */
const LIBRARY_INLINE: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".json": "text/plain; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
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
    sections: service.listSections(),
    channels: service.listChannels(),
    deletedChannels: service.listDeletedChannels(),
    usage: service.usage(),
    paths: { shared: options.sharedDir, workspaces: options.workspacesDir },
    maxHops: options.maxHops,
    platform: process.platform,
  }));

  route("GET", "/api/settings", () => ({ settings: service.getSettings() }));

  route("PATCH", "/api/settings", async (ctx) => {
    const body = await readJson(ctx.req);
    return { settings: service.updateSettings({ botName: body.botName, userName: body.userName, fullAccess: body.fullAccess }) };
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

  // «Instalar» en Ajustes: npm o el instalador oficial del proveedor, en este equipo y para este usuario.
  route("POST", "/api/providers/:id/install", (ctx) => ({ providers: service.startInstall(param(ctx, 0)) }));

  route("POST", "/api/providers/:id/install/cancel", (ctx) => ({ providers: service.cancelInstall(param(ctx, 0)) }));

  route("GET", "/api/models", async (ctx) => {
    const provider = ctx.url.searchParams.get("provider");
    if (!isProviderId(provider)) throw new HttpError(400, "Proveedor inválido.");
    return { models: await service.listModels(provider) };
  });

  // ---------- agentes ----------

  route("GET", "/api/agents", () => ({ agents: service.listAgents() }));

  route("POST", "/api/agents", async (ctx) => {
    const body = await readJson(ctx.req);
    ctx.res.statusCode = 201;
    // greet: lo creó el usuario con el «+», así que el agente se presenta con un primer mensaje.
    return { agent: service.createAgent(agentInput(body, true) as AgentInput, { greet: body.greet === true }) };
  });

  route("GET", "/api/agents/:id", (ctx) => ({ agent: service.getAgent(param(ctx, 0)) }));

  route("PATCH", "/api/agents/:id", async (ctx) => {
    const body = await readJson(ctx.req);
    return { agent: service.updateAgent(param(ctx, 0), agentInput(body, false)) };
  });

  route("DELETE", "/api/agents/:id", async (ctx) => {
    // ?stop=1: si está trabajando, primero se detiene su turno.
    await service.deleteAgent(param(ctx, 0), { stop: ctx.url.searchParams.get("stop") === "1" });
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

  route("POST", "/api/agents/:id/unread", (ctx) => ({ agent: service.markUnread(param(ctx, 0)) }));

  route("POST", "/api/read-all", () => ({ changed: service.markAllRead() }));

  // ---------- biblioteca y carpetas ----------

  route("GET", "/api/agents/:id/library", (ctx) =>
    service.listLibrary(param(ctx, 0), libraryRoot(ctx.url.searchParams.get("root")), ctx.url.searchParams.get("path") ?? ""),
  );

  route("GET", "/api/agents/:id/library/file", async (ctx) => {
    const file = service.libraryFile(param(ctx, 0), libraryRoot(ctx.url.searchParams.get("root")), ctx.url.searchParams.get("path") ?? "");
    const ext = extname(file.name).toLowerCase();
    const type = LIBRARY_INLINE[ext];
    const inline = Boolean(type) && ctx.url.searchParams.get("download") !== "1";
    const res = ctx.res;
    res.statusCode = 200;
    res.setHeader("content-type", inline ? (type as string) : "application/octet-stream");
    res.setHeader("content-length", String(file.size));
    res.setHeader("content-disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    // Un archivo que escribió un agente nunca corre con los permisos de la app (sin scripts ni acceso a la API).
    res.setHeader(
      "content-security-policy",
      ext === ".pdf" ? "default-src 'none'; object-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'" : "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
    );
    res.setHeader("cache-control", "private, no-store");
    await new Promise<void>((resolveStream, reject) => {
      const stream = createReadStream(file.path);
      stream.once("error", reject);
      res.once("close", () => {
        stream.destroy();
        resolveStream();
      });
      stream.once("end", resolveStream);
      stream.pipe(res);
    });
    return NO_CONTENT;
  });

  // Abre la carpeta en el explorador de archivos, solo si la petición viene de este mismo equipo.
  route("POST", "/api/agents/:id/open-folder", async (ctx) => {
    const body = await readJson(ctx.req);
    if (!isLocalRequest(ctx.req)) throw new HttpError(403, "La carpeta solo se puede abrir desde el propio equipo donde corre ClosedBot.");
    const dir = service.libraryBase(param(ctx, 0), libraryRoot(typeof body.root === "string" ? body.root : null));
    mkdirSync(dir, { recursive: true });
    openFolder(dir, log);
    return { opened: true, path: dir };
  });

  // ---------- secciones de la barra lateral ----------

  route("GET", "/api/sections", () => ({ sections: service.listSections() }));

  route("POST", "/api/sections", async (ctx) => {
    const body = await readJson(ctx.req);
    ctx.res.statusCode = 201;
    return { sections: service.createSection(body.name) };
  });

  route("POST", "/api/sections/rename", async (ctx) => {
    const body = await readJson(ctx.req);
    return { sections: service.renameSection(body.from, body.to) };
  });

  route("POST", "/api/sections/delete", async (ctx) => {
    const body = await readJson(ctx.req);
    return { sections: service.deleteSection(body.name) };
  });

  // ---------- uso del plan ----------

  // ---------- canales ----------

  route("GET", "/api/channels", () => ({ channels: service.listChannels(), deleted: service.listDeletedChannels() }));

  route("POST", "/api/channels", async (ctx) => {
    const body = await readJson(ctx.req);
    ctx.res.statusCode = 201;
    return { channel: service.createChannel({ name: body.name, topic: body.topic, memberIds: body.memberIds, leadId: body.leadId }) };
  });

  route("GET", "/api/channels/:id", (ctx) => ({ channel: service.getChannel(param(ctx, 0)) }));

  route("PATCH", "/api/channels/:id", async (ctx) => {
    const body = await readJson(ctx.req);
    const patch: Record<string, unknown> = {};
    for (const key of ["name", "topic", "memberIds", "leadId"]) if (key in body) patch[key] = body[key];
    return { channel: service.updateChannel(param(ctx, 0), patch) };
  });

  // Eliminar lo mueve a «Canales eliminados»; desde allí se restaura o se borra para siempre.
  route("DELETE", "/api/channels/:id", (ctx) => ({ channel: service.deleteChannel(param(ctx, 0)) }));

  route("POST", "/api/channels/:id/restore", (ctx) => ({ channel: service.restoreChannel(param(ctx, 0)) }));

  route("DELETE", "/api/channels/:id/permanent", (ctx) => {
    service.purgeChannel(param(ctx, 0));
    return { ok: true };
  });

  route("GET", "/api/channels/:id/messages", (ctx) => {
    const limit = clampInt(ctx.url.searchParams.get("limit"), 100, 1, 500);
    const before = clampInt(ctx.url.searchParams.get("before"), 0, 0, Number.MAX_SAFE_INTEGER);
    const messages = service.listChannelMessages(param(ctx, 0), limit + 1, before || undefined);
    const hasMore = messages.length > limit;
    return { messages: hasMore ? messages.slice(1) : messages, hasMore };
  });

  route("POST", "/api/channels/:id/messages", async (ctx) => {
    const body = await readJson(ctx.req);
    if (typeof body.text !== "string") throw new HttpError(400, "Falta el texto del mensaje.");
    ctx.res.statusCode = 202;
    return service.sendChannelMessage(param(ctx, 0), body.text);
  });

  route("POST", "/api/channels/:id/read", (ctx) => ({ channel: service.markChannelRead(param(ctx, 0)) }));

  route("POST", "/api/channels/:id/unread", (ctx) => ({ channel: service.markChannelUnread(param(ctx, 0)) }));

  route("POST", "/api/channels/:id/interrupt", async (ctx) => ({ interrupted: await service.interruptChannel(param(ctx, 0)) }));

  route("GET", "/api/usage", () => ({ usage: service.usage() }));

  route("POST", "/api/usage/refresh", async () => ({ usage: await service.refreshUsage(false) }));

  // ---------- dictado local ----------

  const speech = options.speech ?? null;
  const requireSpeech = (): SpeechEngine => {
    if (!speech) throw new HttpError(503, "El dictado local no está disponible en este servidor.");
    return speech;
  };

  route("GET", "/api/speech", () => ({ speech: speech?.status() ?? null }));

  // Descarga el modelo (una sola vez). El avance llega por el flujo de eventos («speech»).
  route("POST", "/api/speech/install", (ctx) => {
    const engine = requireSpeech();
    engine.install().catch(() => undefined);
    ctx.res.statusCode = 202;
    return { speech: engine.status() };
  });

  // La persona empezó a hablar: se carga el modelo mientras tanto.
  route("POST", "/api/speech/prepare", () => {
    requireSpeech().prepare();
    return NO_CONTENT;
  });

  route("POST", "/api/speech/transcribe", async (ctx) => {
    const engine = requireSpeech();
    const data = await readBody(ctx.req, MAX_SPEECH_BYTES, MAX_SPEECH_BYTES);
    return { text: await engine.transcribe(data) };
  });

  // ---------- voces locales para leer en voz alta ----------

  const localVoices = options.voices ?? null;
  const requireVoices = (): LocalVoices => {
    if (!localVoices) throw new HttpError(503, "Las voces de este PC no están disponibles en este servidor.");
    return localVoices;
  };

  route("GET", "/api/voices", () => ({ voices: localVoices?.status() ?? null }));

  // Descarga el modelo (una sola vez). El avance llega por el flujo de eventos («voices»).
  route("POST", "/api/voices/install", (ctx) => {
    const engine = requireVoices();
    engine.install().catch(() => undefined);
    ctx.res.statusCode = 202;
    return { voices: engine.status() };
  });

  // Lee una frase: responde un WAV.
  route("POST", "/api/voices/speak", async (ctx) => {
    const engine = requireVoices();
    const body = await readJson(ctx.req);
    const wav = await engine.speak({ text: body.text, voice: body.voice, speed: body.speed, lang: body.lang });
    const res = ctx.res;
    res.statusCode = 200;
    res.setHeader("content-type", "audio/wav");
    res.setHeader("content-length", String(wav.length));
    res.setHeader("cache-control", "private, no-store");
    res.end(wav);
    return NO_CONTENT;
  });

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
    const send = (
      event:
        | ServiceEvent
        | { type: "hello"; [key: string]: unknown }
        | { type: "speech"; speech: SpeechStatus }
        | { type: "voices"; voices: LocalVoicesStatus },
    ) => {
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
      sections: service.listSections(),
      channels: service.listChannels(),
      deletedChannels: service.listDeletedChannels(),
      usage: service.usage(),
      speech: speech?.status() ?? null,
      voices: localVoices?.status() ?? null,
    });
    const listener = (event: ServiceEvent) => send(event);
    service.on("event", listener);
    const speechListener = (status: SpeechStatus) => send({ type: "speech", speech: status });
    speech?.on("status", speechListener);
    const voicesListener = (status: LocalVoicesStatus) => send({ type: "voices", voices: status });
    localVoices?.on("status", voicesListener);
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
      speech?.off("status", speechListener);
      localVoices?.off("status", voicesListener);
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
      const known = error instanceof HttpError || error instanceof ServiceError || error instanceof SpeechError || error instanceof LocalVoicesError;
      const status = known ? error.status : 500;
      if (status >= 500 && !known) {
        log("error", `${req.method} ${url.pathname}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      }
      if (res.headersSent) {
        res.end();
        return;
      }
      const message = known ? error.message : "Error interno del servidor.";
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
  if (body.avatar !== undefined) {
    if (typeof body.avatar !== "number") throw new HttpError(400, "El campo avatar debe ser un número.");
    input.avatar = body.avatar;
  }
  for (const key of ["pinned", "hidden"] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") throw new HttpError(400, `El campo ${key} debe ser true o false.`);
    input[key] = value;
  }
  if (body.voice !== undefined) {
    if (!isRecord(body.voice)) throw new HttpError(400, "El campo voice debe ser un objeto.");
    input.voice = body.voice as Partial<VoiceSettings>;
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

function libraryRoot(value: string | null): LibraryRoot {
  if (value === null || value === "" || value === "agent") return "agent";
  if (value === "shared") return "shared";
  throw new HttpError(400, "La raíz debe ser «agent» o «shared».");
}

/** La petición viene de este mismo equipo (no reenviada por `tailscale serve` ni por otro proxy). */
function isLocalRequest(req: IncomingMessage): boolean {
  return isLoopback(req.socket.remoteAddress) && !header(req, "x-forwarded-for") && !header(req, "x-forwarded-host");
}

function openFolder(dir: string, log: (level: "info" | "warn" | "error", message: string) => void): void {
  const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const child = spawn(command, [dir], { detached: true, stdio: "ignore" });
    child.once("error", (error) => log("warn", `No se pudo abrir la carpeta: ${error.message}`));
    child.unref();
  } catch (error) {
    log("warn", `No se pudo abrir la carpeta: ${error instanceof Error ? error.message : String(error)}`);
  }
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
