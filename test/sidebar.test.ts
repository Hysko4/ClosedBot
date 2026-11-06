import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AVATAR_CUSTOM_BASE } from "../src/db.js";
import { composeGreeting, GREETING_MARKER } from "../src/instructions.js";
import type { ProviderId } from "../src/providers/client.js";
import { DemoAgentClient } from "../src/providers/demo.js";
import { parseUsage, ServiceError } from "../src/service.js";
import { createHarness, tempDir, waitFor } from "./helpers.js";

test("agente creado a mano: figura y color elegidos, y los automáticos siguen su propia numeración", async () => {
  const h = await createHarness();
  try {
    const first = h.service.createAgent({ name: "Uno", provider: "demo" });
    const chosen = h.service.createAgent({ name: "Dos", provider: "demo", avatar: AVATAR_CUSTOM_BASE + 3 * 100 + 9 });
    const third = h.service.createAgent({ name: "Tres", provider: "demo" });
    assert.equal(first.avatar, 0);
    assert.equal(chosen.avatar, AVATAR_CUSTOM_BASE + 309);
    assert.equal(third.avatar, 1, "el avatar elegido no corre la numeración automática");
    assert.throws(() => h.service.createAgent({ name: "Cuatro", provider: "demo", avatar: -1 }), ServiceError);
    assert.equal(h.service.updateAgent(first.id, { avatar: AVATAR_CUSTOM_BASE + 1 }).avatar, AVATAR_CUSTOM_BASE + 1);
  } finally {
    await h.close();
  }
});

test("saludo inicial: solo en los agentes que crea el usuario, con el pedido oculto", async () => {
  const h = await createHarness({ mainAgent: true });
  try {
    h.service.updateSettings({ userName: "Jonathan" });
    h.service.createAgent({ name: "Directora", provider: "demo", role: "Coordina", project: "Creación de Juegos" });
    const d = h.service.createAgent({ name: "d", provider: "demo" }, { greet: true });
    const reply = await waitFor(
      () => h.service.listMessages(d.id).find((message) => message.role === "assistant" && message.status === "completed"),
      5_000,
      "saludo",
    );
    assert.match(reply.text, /^¡Hola, Jonathan! Soy d, recién llegado/);
    assert.match(reply.text, /Creación de Juegos/);
    const messages = h.service.listMessages(d.id);
    assert.deepEqual(
      messages.map((message) => message.role),
      ["activity", "assistant"],
      "no hay burbuja del usuario: el pedido va oculto",
    );
    assert.equal(messages[0]?.payload?.kind, "greeting");
    assert.ok(!messages.some((message) => message.text.includes(GREETING_MARKER)));
    assert.equal(h.service.getAgent(d.id).preview.startsWith("¡Hola, Jonathan!"), true);

    // Sin `greet` (como los que crea Claude Bot) no hay saludo.
    const silent = h.service.createAgent({ name: "Silencioso", provider: "demo" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(h.service.listMessages(silent.id), []);
  } finally {
    await h.close();
  }
});

test("saludo inicial: la cola nunca muestra el pedido oculto", async () => {
  const h = await createHarness();
  try {
    const agent = h.service.createAgent({ name: "Pausado", provider: "demo" });
    h.service.setPaused(agent.id, true);
    // Con la cola en pausa, el saludo espera y se puede ver en la cola.
    const other = h.service.createAgent({ name: "Nuevo", provider: "demo" }, { greet: false });
    h.service.setPaused(other.id, true);
    const greeted = h.service.createAgent({ name: "Saludador", provider: "demo" }, { greet: true });
    h.service.setPaused(greeted.id, true);
    const queue = h.service.listQueue(greeted.id);
    assert.deepEqual(
      queue.map((delivery) => [delivery.status, delivery.text]),
      [["queued", "Saludo inicial"]],
    );
    const queueEvents = h.events.filter((event) => event.type === "queue" && event.agentId === greeted.id);
    assert.ok(queueEvents.length > 0);
    for (const event of queueEvents) {
      if (event.type === "queue") for (const delivery of event.queue) assert.equal(delivery.text.includes(GREETING_MARKER), false);
    }
  } finally {
    await h.close();
  }
});

test("composeGreeting menciona el equipo por secciones y pide no usar herramientas", () => {
  const text = composeGreeting({ name: "d" }, "Jonathan", [
    { name: "Directora", role: "Coordina el equipo", project: "Creación de Juegos" },
    { name: "Ana", role: "", project: "" },
  ]);
  assert.ok(text.startsWith(GREETING_MARKER));
  assert.match(text, /Te llamas «d»/);
  assert.match(text, /El usuario se llama «Jonathan»/);
  assert.match(text, /Sección «Creación de Juegos»: Directora \(Coordina el equipo\)/);
  assert.match(text, /Sin sección: Ana/);
  assert.match(text, /No uses herramientas/);
  assert.match(composeGreeting({ name: "x" }, "", []), /Todavía no tiene otros agentes/);
});

test("barra lateral: fijar, ocultar, no leído y marcar todo como leído", async () => {
  const h = await createHarness();
  try {
    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    const beto = h.service.createAgent({ name: "Beto", provider: "demo" });
    assert.equal(ana.pinned, false);
    assert.equal(ana.hidden, false);
    assert.equal(h.service.updateAgent(ana.id, { pinned: true }).pinned, true);
    assert.equal(h.service.updateAgent(beto.id, { hidden: true }).hidden, true);

    // «Marcar como no leído» funciona aunque no haya mensajes.
    assert.equal(h.service.getAgent(ana.id).unread, false);
    assert.equal(h.service.markUnread(ana.id).unread, true);
    assert.equal(h.service.markUnread(beto.id).unread, true);
    assert.equal(h.service.markAllRead(), 2);
    assert.equal(h.service.getAgent(ana.id).unread, false);
    assert.equal(h.service.getAgent(beto.id).unread, false);
    assert.equal(h.service.markAllRead(), 0);
  } finally {
    await h.close();
  }
});

test("voz por agente: se guarda limpia y lo que no sirve vuelve al valor por defecto", async () => {
  const h = await createHarness();
  try {
    const agent = h.service.createAgent({ name: "Voz", provider: "demo" });
    assert.deepEqual(agent.voice, { name: "", rate: 1, lang: "auto", autoRead: false });
    const updated = h.service.updateAgent(agent.id, { voice: { name: "Microsoft Catalina Online (Natural) - Spanish (Chile)", rate: 1.25, lang: "es-CL", autoRead: true } });
    assert.deepEqual(updated.voice, { name: "Microsoft Catalina Online (Natural) - Spanish (Chile)", rate: 1.25, lang: "es-CL", autoRead: true });
    const partial = h.service.updateAgent(agent.id, { voice: { rate: 9 } as never });
    assert.equal(partial.voice.rate, 1, "velocidad fuera de rango");
    assert.equal(partial.voice.lang, "es-CL", "lo que no cambia se conserva");
    assert.equal(h.service.updateAgent(agent.id, { voice: { lang: "<script>" } as never }).voice.lang, "auto");
    // Lo que guardó la 0.6.0 con ElevenLabs (ya no existe) se descarta sin romper nada.
    const old = h.service.updateAgent(agent.id, { voice: { engine: "elevenlabs", elevenVoice: "21m00Tcm4TlvDq8ikWAM" } as never });
    assert.deepEqual(Object.keys(old.voice).sort(), ["autoRead", "lang", "name", "rate"]);
  } finally {
    await h.close();
  }
});

test("secciones: crear vacías, renombrar moviendo a sus agentes y eliminar sin borrar agentes", async () => {
  const h = await createHarness({ mainAgent: true });
  try {
    const ana = h.service.createAgent({ name: "Ana", provider: "demo", project: "Juegos" });
    assert.deepEqual(h.service.createSection("Correo"), ["Correo"]);
    assert.throws(() => h.service.createSection("correo"), (error: unknown) => error instanceof ServiceError && error.status === 409);
    assert.throws(() => h.service.createSection("juegos"), (error: unknown) => error instanceof ServiceError && error.status === 409, "también las que salen de los agentes");
    assert.throws(() => h.service.createSection("  "), ServiceError);

    assert.deepEqual(h.service.renameSection("Juegos", "Creación de Juegos"), ["Correo"]);
    assert.equal(h.service.getAgent(ana.id).project, "Creación de Juegos");
    assert.deepEqual(h.service.renameSection("Correo", "Correo y agenda"), ["Correo y agenda"]);
    h.service.updateAgent(ana.id, { project: "Correo y agenda" });
    assert.deepEqual(h.service.deleteSection("Correo y agenda"), []);
    assert.equal(h.service.getAgent(ana.id).project, "", "pasa a «Sin asignar»");
    assert.equal(h.service.listAgents().length, 2);
    // Una que ya no existe (p. ej. se borraron todos sus agentes) no es un error: no queda nada que hacer.
    assert.deepEqual(h.service.deleteSection("No existe"), h.service.listSections());
    assert.ok(h.events.some((event) => event.type === "sections"));
  } finally {
    await h.close();
  }
});

test("biblioteca: lista carpetas y archivos sin salir de la raíz", async () => {
  const h = await createHarness();
  try {
    const agent = h.service.createAgent({ name: "Lector", provider: "demo" });
    mkdirSync(join(agent.workspace, "informes"), { recursive: true });
    writeFileSync(join(agent.workspace, "informes", "marzo.md"), "# Marzo");
    writeFileSync(join(agent.workspace, "notas.txt"), "hola");
    writeFileSync(join(agent.workspace, ".oculto"), "no");
    const root = h.service.listLibrary(agent.id, "agent", "");
    assert.deepEqual(
      root.entries.map((entry) => [entry.name, entry.dir, entry.path]),
      [
        ["informes", true, "informes"],
        ["notas.txt", false, "notas.txt"],
      ],
    );
    assert.equal(root.entries[1]?.size, 4);
    assert.deepEqual(
      h.service.listLibrary(agent.id, "agent", "informes").entries.map((entry) => entry.path),
      ["informes/marzo.md"],
    );
    const file = h.service.libraryFile(agent.id, "agent", "informes/marzo.md");
    assert.equal(file.name, "marzo.md");
    assert.equal(file.size, 7);

    for (const bad of ["../", "informes/../../x", "..\\..\\x", "C:", "/etc/passwd"]) {
      assert.throws(() => h.service.libraryFile(agent.id, "agent", bad), ServiceError, bad);
    }
    // Un enlace simbólico que sale de la carpeta no deja leer lo de afuera.
    writeFileSync(join(h.dir, "secreto.txt"), "clave");
    try {
      symlinkSync(join(h.dir, "secreto.txt"), join(agent.workspace, "atajo.txt"));
      assert.throws(() => h.service.libraryFile(agent.id, "agent", "atajo.txt"), ServiceError);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
    // La compartida se lista aunque esté vacía; una carpeta que no existe da 404.
    assert.deepEqual(h.service.listLibrary(agent.id, "shared", "").entries, []);
    assert.throws(() => h.service.listLibrary(agent.id, "agent", "no-existe"), (error: unknown) => error instanceof ServiceError && error.status === 404);
  } finally {
    await h.close();
  }
});

test("uso del plan: se normaliza la respuesta de Claude y la de Codex", () => {
  const claude = parseUsage("claude", {
    rateLimits: {
      available: true,
      plan: "max",
      windows: [
        { id: "five_hour", usedPercent: 30.4, resetsAt: "2026-11-03T05:00:00Z" },
        { id: "seven_day", usedPercent: 62, resetsAt: "2026-11-05T07:00:00Z" },
        { id: "model:Fable", label: "Semanal · Fable", usedPercent: 12, resetsAt: null },
      ],
    },
  });
  assert.ok(claude);
  assert.equal(claude.plan, "max");
  assert.deepEqual(
    claude.windows.map((window) => [window.label, window.percent]),
    [
      ["Semanal", 62],
      ["5 horas", 30],
      ["Semanal · Fable", 12],
    ],
  );
  assert.equal(claude.windows[0]?.resetsAt, Date.parse("2026-11-05T07:00:00Z"));
  assert.equal(parseUsage("claude", { rateLimits: { available: false, windows: [] } }), null);

  const codex = parseUsage("codex", {
    rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1_793_700_000 }, secondary: { usedPercent: 75, windowDurationMins: 10_080 } },
  });
  assert.deepEqual(
    codex?.windows.map((window) => [window.label, window.percent, window.resetsAt]),
    [
      ["Semanal", 75, null],
      ["5 horas", 40, 1_793_700_000_000],
    ],
  );
  // Codex viejo: «faltan N segundos» se convierte en la fecha del reinicio.
  const before = Date.now();
  const relative = parseUsage("codex", { rateLimits: { primary: { used_percent: 10, window_minutes: 300, resets_in_seconds: 3600 } } });
  const resetsAt = relative?.windows[0]?.resetsAt ?? 0;
  assert.ok(resetsAt >= before + 3_600_000 && resetsAt <= Date.now() + 3_600_000);
});

test("uso del plan: el servicio lo lee de todos los proveedores con sesión, lo emite y lo guarda", async () => {
  const PERCENT: Record<string, number> = { claude: 62, codex: 40, grok: 51, gemini: 4 };
  class UsageClient extends DemoAgentClient {
    calls = 0;
    constructor(readonly kind: ProviderId) {
      super({ wordDelayMs: 0 });
    }
    override async request<T>(method: string, params: unknown): Promise<T> {
      if (method === "account/rateLimits/read") {
        this.calls += 1;
        const plan = this.kind === "codex" ? { planType: "plus" } : { plan: "pro" };
        return { rateLimits: { available: true, ...plan, windows: [{ id: "seven_day", usedPercent: PERCENT[this.kind], resetsAt: null }] } } as T;
      }
      return super.request<T>(method, params);
    }
  }
  const clients: UsageClient[] = [];
  const createClient = (provider: ProviderId) => {
    const client = new UsageClient(provider);
    clients.push(client);
    return client;
  };
  const last = (provider: ProviderId) => clients.filter((client) => client.kind === provider).pop();
  // Sin sesión confirmada (p. ej. con CLOSEDBOT_DETECT=0) no se lee nada ni se arranca Claude.
  const unconfirmed = await createHarness({ createClient });
  try {
    assert.deepEqual(await unconfirmed.service.refreshUsage(true), []);
    assert.equal(clients.length, 0);
  } finally {
    await unconfirmed.close();
  }
  const temp = tempDir();
  const providers = (["claude", "codex", "grok", "gemini", "demo"] as const).map((id) => ({ id, label: id, available: true, loggedIn: true, detail: "prueba" }));
  let h = await createHarness({ dir: temp.path, keepDir: true, createClient, detectProviders: async () => providers });
  try {
    const usage = await h.service.refreshUsage(true);
    assert.deepEqual(
      usage.map((entry) => [entry.provider, entry.plan, entry.windows[0]?.percent]),
      [
        ["claude", "pro", 62],
        ["codex", "plus", 40],
        ["grok", "pro", 51],
      ],
      "Gemini no se lee si Antigravity no está en marcha",
    );
    assert.equal(last("gemini"), undefined, "no se abre Antigravity solo para leer el uso");
    assert.equal(last("codex")?.running, false, "Codex se abrió para leer y se cerró");
    assert.equal(last("grok")?.running, false, "Grok también");
    assert.ok(h.events.some((event) => event.type === "usage"));
    // Sin `force`, una segunda lectura enseguida devuelve lo guardado.
    await h.service.refreshUsage(false);
    assert.equal(last("claude")?.calls, 1);

    // Con un agente de Gemini y otro de Codex trabajando, sus procesos siguen abiertos: se leen y no se cierran.
    for (const provider of ["gemini", "codex"] as const) {
      const agent = h.service.createAgent({ name: `Con ${provider}`, provider });
      const { message } = h.service.sendUserMessage(agent.id, "hola");
      await waitFor(() => h.store.getMessage(message.id)?.status === "completed", 5_000, `turno con ${provider}`);
    }
    const all = await h.service.refreshUsage(true);
    assert.deepEqual(
      all.map((entry) => entry.provider),
      ["claude", "codex", "grok", "gemini"],
    );
    assert.equal(last("gemini")?.running, true);
    assert.equal(last("codex")?.running, true);
    // Codex avisa que cambió el uso al terminar un turno: se toma sin volver a preguntar.
    last("codex")?.emit("notification", {
      method: "account/rateLimits/updated",
      params: { rateLimits: { primary: { usedPercent: 45, windowDurationMins: 300, resetsAt: 1_793_700_000 } } },
    });
    assert.deepEqual(
      h.service.usage().find((entry) => entry.provider === "codex")?.windows.map((window) => [window.label, window.percent]),
      [
        ["Semanal", 40],
        ["5 horas", 45],
      ],
    );
    await h.close();

    // Al volver a abrir la app se ve la última lectura (Gemini incluido) mientras se vuelve a leer.
    h = await createHarness({ dir: temp.path, keepDir: true, createClient, detectProviders: async () => providers });
    assert.deepEqual(
      h.service.usage().map((entry) => [entry.provider, entry.windows.map((window) => window.percent)]),
      [
        ["claude", [62]],
        ["codex", [40, 45]],
        ["grok", [51]],
        ["gemini", [4]],
      ],
    );
  } finally {
    await h.close();
    temp.cleanup();
  }
});
