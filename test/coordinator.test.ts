import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../src/db.js";
import { imageExtension, saveGeneratedImage, withImages } from "../src/images.js";
import { buildInstructions, MAIN_AGENT_GUIDE } from "../src/instructions.js";
import type { AgentClient, ProviderId } from "../src/providers/client.js";
import { DemoAgentClient, demoPng } from "../src/providers/demo.js";
import { BOARD_META, USAGE_META, imagePathsInText, imagePathsOf } from "../src/service.js";
import { createHarness, type Harness, TEST_PROVIDERS, tempDir, waitFor } from "./helpers.js";

interface Turn {
  agent: string;
  text: string;
}

/** Demo que anota lo que recibe cada agente en cada turno; con `script` se cambia lo que recibe. */
function scripted(harness: () => Harness, turns: Turn[], script?: (agent: string, text: string) => string | null): (provider: ProviderId) => AgentClient {
  return () => {
    const client = new DemoAgentClient({ wordDelayMs: 0 });
    const request = client.request.bind(client);
    client.request = (async (method: string, params: unknown) => {
      if (method === "turn/start") {
        const turn = params as { threadId: string; input: Array<{ text: string }> };
        const agent = harness().store.listAgents().find((item) => item.threadId === turn.threadId)?.name ?? "?";
        const text = turn.input[0]?.text ?? "";
        turns.push({ agent, text });
        const changed = script?.(agent, text);
        if (typeof changed === "string" && turn.input[0]) turn.input[0].text = changed;
      }
      return request(method, params);
    }) as AgentClient["request"];
    return client;
  };
}

function repliesTo(h: Harness, agentId: string, deliveryId: string | null): string {
  return h.service
    .listMessages(agentId)
    .filter((item) => item.role === "assistant" && item.deliveryId === deliveryId)
    .map((item) => item.text)
    .join("\n");
}

/** Envía un mensaje, espera a que termine ese turno y devuelve la respuesta. */
async function talk(h: Harness, agentId: string, text: string): Promise<string> {
  const { message, delivery } = h.service.sendUserMessage(agentId, text);
  await waitFor(() => {
    const status = h.store.getMessage(message.id)?.status;
    return status === "completed" || status === "failed";
  }, 5_000, `respuesta a «${text.slice(0, 40)}»`);
  return repliesTo(h, agentId, delivery.id);
}

function inputsOf(turns: Turn[], agent: string): string[] {
  return turns.filter((turn) => turn.agent === agent).map((turn) => turn.text);
}

async function allIdle(h: Harness): Promise<void> {
  await waitFor(() => h.service.listAgents().every((agent) => agent.state === "idle"), 8_000, "todos libres");
}

test("Claude Bot lee la ficha completa de un agente, ve el uso de cada cuenta y lleva la pizarra", async () => {
  const temp = tempDir();
  // El uso del plan que quedó guardado de la última lectura.
  const saved = new Store(join(temp.path, "closedbot.db"));
  saved.setMeta(
    USAGE_META,
    JSON.stringify([{ provider: "codex", plan: "plus", windows: [{ id: "five_hour", label: "5 horas", percent: 82, resetsAt: null }], updatedAt: Date.now() }]),
  );
  saved.close();
  const turns: Turn[] = [];
  let h!: Harness;
  h = await createHarness({ dir: temp.path, mainAgent: true, createClient: scripted(() => h, turns) });
  try {
    const mainId = h.service.mainAgentId() as string;
    const ana = h.service.createAgent({ name: "Ana", role: "Ilustradora", description: "Dibuja personajes", provider: "demo", instructions: "Dibuja en pixel art." });
    await talk(h, ana.id, "/recuerda siempre El usuario prefiere colores pastel");

    let reply = await talk(h, mainId, "/ficha Ana");
    const card = JSON.parse(/Ficha de Ana: (\{.*\})$/m.exec(reply)?.[1] ?? "{}") as Record<string, unknown>;
    assert.equal(card.nombre, "Ana");
    assert.equal(card.titulo, "Ilustradora");
    assert.equal(card.descripcion, "Dibuja personajes");
    assert.equal(card.proveedor, "Demo");
    assert.equal(card.estado, "libre");
    assert.match(String(card.instrucciones), /Dibuja en pixel art\./);
    assert.deepEqual(card.recuerdos, [{ texto: "El usuario prefiere colores pastel", siempre: true }]);
    assert.ok(Array.isArray(card.habilidades));
    const recent = card.loUltimo as Array<{ de: string; texto: string }>;
    assert.deepEqual(
      recent.map((item) => item.de),
      ["Usuario", "Ana"],
    );
    reply = await talk(h, mainId, "/ficha Zoe");
    assert.match(reply, /No pude leer la ficha de Zoe: No existe el agente «Zoe»/);

    // La pizarra: queda a la vista en su chat y va con lo que Claude Bot les escribe a los agentes.
    reply = await talk(h, mainId, "/pizarra Objetivo: juego de memoria. Ana hace el arte.");
    assert.match(reply, /Actualicé la pizarra\./);
    assert.equal(h.store.getMeta(BOARD_META), "Objetivo: juego de memoria. Ana hace el arte.");
    const updated = h.service.listMessages(mainId).filter((item) => item.payload?.kind === "board-updated");
    assert.deepEqual(
      updated.map((item) => [item.role, item.text, item.payload?.board]),
      [["activity", "Actualizó la pizarra", "Objetivo: juego de memoria. Ana hace el arte."]],
    );
    reply = await talk(h, mainId, "/equipo");
    const team = JSON.parse(/Compañeros: (\{.*\})$/m.exec(reply)?.[1] ?? "{}") as Record<string, unknown>;
    assert.equal(team.pizarra, "Objetivo: juego de memoria. Ana hace el arte.");
    const usage = team.usoDelPlan as Array<{ proveedor: string; plan: string; ventanas: Array<{ nombre: string; usado: string }> }>;
    assert.deepEqual(
      usage.map((entry) => [entry.proveedor, entry.plan, entry.ventanas.map((window) => [window.nombre, window.usado])]),
      [["Codex", "plus", [["5 horas", "82 %"]]]],
    );
    assert.equal(team.rondaAbierta, undefined, "las rondas ya no existen");

    await talk(h, mainId, "@Ana: Empieza con las cartas");
    const handoff = await waitFor(() => inputsOf(turns, "Ana").find((text) => text.includes("Empieza con las cartas")), 5_000, "encargo a Ana");
    assert.match(
      handoff,
      /^Mensaje de tu compañero Claude Bot \(id [^)]+\)\.\n[\s\S]*\nPizarra del trabajo \(la lleva Claude Bot\):\n<pizarra>\nObjetivo: juego de memoria\. Ana hace el arte\.\n<\/pizarra>\n--- mensaje ---\nEmpieza con las cartas$/,
    );
    await allIdle(h);
    // Lo que se escriben los demás agentes no lleva la pizarra.
    const beto = h.service.createAgent({ name: "Beto", provider: "demo" });
    await talk(h, ana.id, "@Beto: Revisa las cartas");
    const toBeto = await waitFor(() => inputsOf(turns, "Beto").find((text) => text.includes("Revisa las cartas")), 5_000, "mensaje a Beto");
    assert.doesNotMatch(toBeto, /<pizarra>/);

    // Los demás agentes no pueden leer fichas, escribir la pizarra ni ver el uso del plan.
    reply = await talk(h, ana.id, "/pizarra Otra cosa");
    assert.match(reply, /No pude escribir la pizarra: Solo el bot principal puede leer fichas y llevar la pizarra/);
    reply = await talk(h, ana.id, "/ficha Beto");
    assert.match(reply, /No pude leer la ficha de Beto: Solo el bot principal/);
    reply = await talk(h, ana.id, "/equipo");
    assert.doesNotMatch(reply, /usoDelPlan|pizarra/);
    assert.equal(h.store.getMeta(BOARD_META), "Objetivo: juego de memoria. Ana hace el arte.");
    await waitFor(() => h.service.getAgent(beto.id).state === "idle", 5_000, "Beto libre");

    // El bot principal con otro nombre: la pizarra lo dice también.
    h.store.setMeta(BOARD_META, "Decide Claude Bot; Ana hace el arte.");
    h.service.updateAgent(mainId, { name: "Codex Bot" });
    assert.equal(h.store.getMeta(BOARD_META), "Decide Codex Bot; Ana hace el arte.");
    h.service.updateAgent(mainId, { name: "Claude Bot" });

    // Borrarla.
    reply = await talk(h, mainId, "/pizarra");
    assert.match(reply, /Actualicé la pizarra\./);
    assert.equal(h.store.getMeta(BOARD_META), "");
    assert.equal(h.service.listMessages(mainId).filter((item) => item.payload?.kind === "board-updated").pop()?.text, "Borró la pizarra");
  } finally {
    await h.close();
    temp.cleanup();
  }
});

test("Claude Bot le cambia el proveedor a un agente: solo si está libre y si ese proveedor está listo", async () => {
  const h = await createHarness({
    mainAgent: true,
    detectProviders: async () => [...TEST_PROVIDERS, { id: "grok", label: "Grok", available: false, loggedIn: null, detail: "prueba" }],
  });
  try {
    const mainId = h.service.mainAgentId() as string;
    const ana = h.service.createAgent({ name: "Ana", role: "Ilustradora", provider: "demo", model: "demo" }, { greet: false });
    await talk(h, ana.id, "Hola");
    assert.ok(h.store.getAgent(ana.id)?.threadId, "ya tiene su conversación");

    let reply = await talk(h, mainId, "/proveedor Ana | codex");
    assert.match(reply, /Le cambié el proveedor a Ana: ahora usa codex\./);
    const record = h.store.getAgent(ana.id);
    assert.equal(record?.provider, "codex");
    assert.equal(record?.threadId, null, "empieza una conversación nueva");
    assert.equal(record?.model, null, "con el modelo por defecto del proveedor nuevo");
    const notices = h.service.listMessages(ana.id).filter((item) => item.role === "notice").map((item) => item.text);
    assert.ok(notices.includes("Claude Bot cambió el proveedor a Codex: la próxima respuesta empieza una conversación nueva."), notices.join("\n"));
    assert.ok(notices.includes("Claude Bot ajustó este agente: proveedor."));
    const activity = h.service.listMessages(mainId).filter((item) => item.payload?.kind === "agent-updated").pop();
    assert.equal(activity?.text, "Ajustó a «Ana»: proveedor");
    // Sigue trabajando con el proveedor nuevo (en las pruebas, todos son la demo).
    assert.match(await talk(h, ana.id, "¿Sigues ahí?"), /Modo demo/);

    // Un proveedor que no está disponible, uno que no existe, a sí mismo o mientras trabaja: no.
    reply = await talk(h, mainId, "/proveedor Ana | grok");
    assert.match(reply, /No pude cambiarle el proveedor a Ana: Grok no está disponible en este equipo: elige otro de proveedoresListos\./);
    reply = await talk(h, mainId, "/proveedor Ana | gpt");
    assert.match(reply, /`provider` debe ser claude, codex, grok, gemini o local\./);
    reply = await talk(h, mainId, "/proveedor Claude Bot | codex");
    assert.match(reply, /No puedes cambiarte a ti mismo/);
    h.service.sendUserMessage(ana.id, "/lento Cuéntame una historia larga");
    await waitFor(() => h.service.getAgent(ana.id).state === "working", 5_000, "Ana trabajando");
    reply = await talk(h, mainId, "/proveedor Ana | claude");
    assert.match(reply, /Ana está trabajando: cámbiale el proveedor cuando termine su turno\./);
    assert.equal(h.store.getAgent(ana.id)?.provider, "codex");
    await h.service.interrupt(ana.id);
  } finally {
    await h.close();
  }
});

test("Claude Bot trabaja en cadena: cuando él encarga, la cuenta de reenvíos vuelve a empezar, y hay un tope de encargos por pedido", async () => {
  const turns: Turn[] = [];
  // Cuando a Claude Bot le vuelve una entrega, encarga el paso siguiente.
  const next: Record<string, string> = { Ana: "@Beto: Paso 2", Beto: "@Cata: Paso 3", Cata: "@Ana: Paso 4" };
  let h!: Harness;
  h = await createHarness({
    mainAgent: true,
    // Con 2 reenvíos, sin volver a empezar la cuenta la cadena se cortaría en el segundo encargo.
    maxHops: 2,
    mainMaxSteps: 3,
    createClient: scripted(
      () => h,
      turns,
      (agent, text) => {
        if (agent !== "Claude Bot") return null;
        const from = /^Respuesta de tu compañero (\S+) /m.exec(text)?.[1];
        return from && next[from] ? next[from] : null;
      },
    ),
  });
  try {
    const mainId = h.service.mainAgentId() as string;
    for (const name of ["Ana", "Beto", "Cata"]) h.service.createAgent({ name, provider: "demo" }, { greet: false });
    await talk(h, mainId, "@Ana: Paso 1");
    await waitFor(() => inputsOf(turns, "Cata").some((text) => text.endsWith("Paso 3")), 8_000, "tercer encargo");
    const last = await waitFor(
      () => h.service.listMessages(mainId).find((item) => item.role === "assistant" && item.status === "completed" && item.text.includes("No pude escribirle a Ana")),
      8_000,
      "el cuarto encargo, rechazado",
    );
    assert.match(last.text, /Ya hiciste 3 encargos seguidos en este pedido, el máximo\. Cuéntale al usuario cómo va el trabajo y qué falta/);
    await allIdle(h);
    assert.ok(inputsOf(turns, "Beto").some((text) => text.endsWith("Paso 2")));
    assert.ok(!inputsOf(turns, "Ana").some((text) => text.includes("Paso 4")), "el cuarto no llegó");
    const steps = h.store
      .listAgents()
      .flatMap((agent) => h.store.listMessages(agent.id))
      .filter((item) => item.role === "teammate" && item.deliveryId)
      .map((item) => {
        const delivery = h.store.getDelivery(item.deliveryId as string);
        return [item.text.split("\n")[0], delivery?.hops, delivery?.steps];
      });
    assert.deepEqual(
      steps.filter(([text]) => typeof text === "string" && text.startsWith("Paso")).sort(),
      [
        ["Paso 1", 1, 1],
        ["Paso 2", 1, 2],
        ["Paso 3", 1, 3],
      ],
    );

    // Un mensaje nuevo del usuario es otro pedido: la cuenta empieza de cero.
    await talk(h, mainId, "@Ana: Otra cosa");
    await waitFor(() => inputsOf(turns, "Ana").some((text) => text.endsWith("Otra cosa")), 5_000, "encargo del pedido nuevo");
    await allIdle(h);
  } finally {
    await h.close();
  }
});

test("Las imágenes que genera un agente quedan en la carpeta compartida, se ven en su chat y le llegan a quien las pidió", async () => {
  const h = await createHarness({ mainAgent: true });
  try {
    const mainId = h.service.mainAgentId() as string;
    const ana = h.service.createAgent({ name: "Ana Ilustradora", provider: "demo" }, { greet: false });
    await talk(h, mainId, "@Ana Ilustradora: /imagen la portada del juego");
    const delivered = await waitFor(
      () => h.service.listMessages(mainId).find((item) => item.role === "teammate" && item.fromAgentId === ana.id),
      5_000,
      "la entrega de Ana",
    );
    const activity = h.service.listMessages(ana.id).find((item) => item.payload?.kind === "image");
    assert.ok(activity, "en su chat se ve la imagen");
    const path = String(activity.payload?.path);
    assert.match(path, /^imagenes\/ana-ilustradora\/imagen-\d{8}-\d{6}\.png$/);
    assert.equal(activity.text, `Generó una imagen: ${path}`);
    const file = join(h.dir, "compartida", ...path.split("/"));
    assert.ok(existsSync(file));
    assert.equal(imageExtension(readFileSync(file)), ".png");
    // A Claude Bot le llega con la ruta completa (para abrirla) y en miniatura en su chat.
    assert.deepEqual(delivered.payload?.images, [path]);
    assert.ok(delivered.text.endsWith(`Imagen generada, ya en la carpeta compartida:\n- ${file}`), delivered.text);
    const reply = await waitFor(
      () =>
        h.service
          .listMessages(mainId)
          .find((item) => item.role === "assistant" && item.status === "completed" && item.text.includes("recibí el mensaje de mi compañero")),
      5_000,
      "Claude Bot recibe la entrega",
    );
    assert.match(reply.text, /Imagen generada, ya en la carpeta compartida/);
    assert.equal(h.service.libraryFile(mainId, "shared", path).size, statSync(file).size, "la interfaz la puede mostrar");

    // Si se la pide el usuario directamente, queda igual en la carpeta compartida (con otro nombre).
    await allIdle(h);
    await talk(h, ana.id, "/imagen un gato\n/imagen un perro");
    const paths = h.service
      .listMessages(ana.id)
      .filter((item) => item.payload?.kind === "image")
      .map((item) => String(item.payload?.path));
    assert.equal(paths.length, 3);
    assert.equal(new Set(paths).size, 3, "cada una con su nombre");
    for (const item of paths) assert.ok(existsSync(join(h.dir, "compartida", ...item.split("/"))));
  } finally {
    await h.close();
  }
});

test("Imágenes: se copian desde donde las dejó Codex o se decodifican; lo que no es imagen no se guarda", () => {
  const temp = tempDir();
  try {
    const shared = join(temp.path, "compartida");
    const codex = join(temp.path, "codex", "generated_images", "hilo-1");
    mkdirSync(codex, { recursive: true });
    const source = join(codex, "Portada final.png");
    writeFileSync(source, demoPng(3));
    const first = saveGeneratedImage({ sharedDir: shared, folder: "ana", savedPath: source, result: null });
    assert.deepEqual(first, { path: join(shared, "imagenes", "ana", "Portada-final.png"), relativePath: "imagenes/ana/Portada-final.png" });
    const second = saveGeneratedImage({ sharedDir: shared, folder: "ana", savedPath: source, result: null });
    assert.equal(second?.relativePath, "imagenes/ana/Portada-final-2.png");
    assert.deepEqual(readFileSync(second?.path as string), readFileSync(source));

    // Sin el archivo, se usa la imagen en base64 (también como data URL).
    const now = new Date(2026, 10, 5, 20, 15, 30);
    const decoded = saveGeneratedImage({ sharedDir: shared, folder: "ana", savedPath: join(codex, "no-existe.png"), result: demoPng(1).toString("base64"), now });
    assert.equal(decoded?.relativePath, "imagenes/ana/imagen-20261105-201530.png");
    const dataUrl = saveGeneratedImage({ sharedDir: shared, folder: "ana", savedPath: null, result: `data:image/png;base64,${demoPng(2).toString("base64")}`, now });
    assert.equal(dataUrl?.relativePath, "imagenes/ana/imagen-20261105-201530-2.png");

    // Lo que no es una imagen.
    assert.equal(saveGeneratedImage({ sharedDir: shared, folder: "ana", savedPath: null, result: Buffer.from("hola, no soy una imagen de verdad").toString("base64") }), null);
    assert.equal(saveGeneratedImage({ sharedDir: shared, folder: "ana", savedPath: null, result: "no es base64 ¿?" }), null);
    const text = join(codex, "nota.txt");
    writeFileSync(text, "texto");
    assert.equal(saveGeneratedImage({ sharedDir: shared, folder: "ana", savedPath: text, result: null }), null);

    assert.equal(withImages("Listo", []), "Listo");
    assert.equal(withImages("", [{ path: "/c/a.png" }]), "Imagen generada, ya en la carpeta compartida:\n- /c/a.png");
    assert.equal(withImages("Listo.", [{ path: "/c/a.png" }, { path: "/c/b.png" }]), "Listo.\n\nImágenes generadas, ya en la carpeta compartida:\n- /c/a.png\n- /c/b.png");
  } finally {
    temp.cleanup();
  }
});

test("La guía de Claude Bot: un solo cerebro que elige el proveedor de cada parte; a Codex se le cuenta lo de las imágenes", () => {
  assert.match(MAIN_AGENT_GUIDE, /el único cerebro del equipo/);
  assert.match(MAIN_AGENT_GUIDE, /Claude no genera imágenes: encárgaselas a un agente de Codex/);
  assert.match(MAIN_AGENT_GUIDE, /QA: revisa un agente con un proveedor distinto del que hizo el trabajo/);
  assert.match(MAIN_AGENT_GUIDE, /cámbiale el proveedor con update_agent/);
  assert.doesNotMatch(MAIN_AGENT_GUIDE, /start_round|ronda|Que opinen todos/);
  const agent = {
    id: "a",
    name: "Ana",
    role: "Ilustradora",
    description: "",
    instructions: "",
    provider: "codex" as const,
    model: null,
    effort: null,
    access: "carpeta" as const,
    workspace: "/tmp/ana",
    threadId: null,
    paused: false,
    preview: "",
    project: "",
    avatar: 0,
    pinned: false,
    hidden: false,
    voice: { name: "", rate: 1, lang: "auto", autoRead: false },
    notify: "" as const,
    skillsOff: [],
    appearance: "",
    character: null,
    readAt: 0,
    lastAt: 0,
    createdAt: 0,
    updatedAt: 0,
  };
  assert.match(buildInstructions(agent, "/tmp/compartida"), /Si generas una imagen, ClosedBot la copia sola a \/tmp\/compartida\/imagenes/);
  assert.doesNotMatch(buildInstructions({ ...agent, provider: "claude" }, "/tmp/compartida"), /Si generas una imagen/);
});

test("Las imágenes que un agente hace o nombra (Gemini, Grok, Claude) también se ven en el chat", async () => {
  assert.deepEqual(imagePathsInText("Listo: D:\\4FTER\\arte\\fondo.png y /tmp/x/a.webp (también D:\\4FTER\\arte\\fondo.png)."), [
    "D:\\4FTER\\arte\\fondo.png",
    "/tmp/x/a.webp",
  ]);
  assert.deepEqual(imagePathsInText("Sin imágenes: notas.md, foto.png.txt"), []);
  assert.deepEqual(imagePathsOf({ type: "fileChange", changes: [{ path: "D:\\a\\b.PNG" }, { path: "D:\\a\\c.md" }] }), ["D:\\a\\b.PNG"]);
  assert.deepEqual(imagePathsOf({ type: "toolCall", tool: "Write", input: { file_path: "/w/arte.jpg" } }), ["/w/arte.jpg"]);

  const h = await createHarness();
  try {
    const ana = h.service.createAgent({ name: "Ana Arte", provider: "demo" }, { greet: false });
    const file = join(h.service.getAgent(ana.id).workspace, "lamina.png");
    writeFileSync(file, demoPng());
    await talk(h, ana.id, `Mira ${file} por favor`);
    const shown = await waitFor(() => h.service.listMessages(ana.id).find((item) => item.payload?.kind === "image"), 5_000, "la imagen en su chat");
    assert.equal(shown.payload?.path, "imagenes/ana-arte/lamina.png");
    assert.ok(existsSync(join(h.dir, "compartida", "imagenes", "ana-arte", "lamina.png")));
  } finally {
    await h.close();
  }
});
