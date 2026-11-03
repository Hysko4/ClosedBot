import assert from "node:assert/strict";
import { test } from "node:test";
import { buildInstructions, MAIN_AGENT_GUIDE } from "../src/instructions.js";
import { MAIN_AGENT_NAME, MAIN_AGENT_ROLE, MAX_AGENTS_PER_TURN, ServiceError } from "../src/service.js";
import { createHarness, tempDir, waitFor, type Harness } from "./helpers.js";

/** Envía un mensaje a un agente, espera a que termine ese turno y devuelve su respuesta. */
async function talk(h: Harness, agentId: string, text: string): Promise<string> {
  const { message, delivery } = h.service.sendUserMessage(agentId, text);
  await waitFor(() => {
    const status = h.store.getMessage(message.id)?.status;
    return status === "completed" || status === "failed";
  }, 5_000, `respuesta a «${text.slice(0, 40)}»`);
  const replies = h.service.listMessages(agentId).filter((item) => item.role === "assistant" && item.deliveryId === delivery.id);
  return replies.map((item) => item.text).join("\n");
}

test("Claude Bot: se crea al arrancar, sigue siendo el mismo al reiniciar y no se puede eliminar", async () => {
  const temp = tempDir();
  try {
    let h = await createHarness({ dir: temp.path, keepDir: true, mainAgent: true });
    const mainId = h.service.mainAgentId();
    assert.ok(mainId);
    const main = h.service.getAgent(mainId);
    assert.equal(main.name, MAIN_AGENT_NAME);
    assert.equal(main.role, MAIN_AGENT_ROLE);
    assert.equal(main.provider, "claude");
    assert.equal(main.access, "carpeta");
    assert.equal(main.project, "");
    assert.equal(main.main, true);
    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    assert.equal(ana.main, false);

    await assert.rejects(h.service.deleteAgent(mainId), (error: unknown) => error instanceof ServiceError && error.status === 409);
    // Se puede renombrar: sigue siendo el principal porque se reconoce por su id.
    h.service.updateAgent(mainId, { name: "Mi Bot" });
    await h.close();

    h = await createHarness({ dir: temp.path, keepDir: true, mainAgent: true });
    assert.equal(h.service.mainAgentId(), mainId);
    assert.deepEqual(
      h.service.listAgents().map((agent) => [agent.name, agent.main]),
      [
        ["Mi Bot", true],
        ["Ana", false],
      ],
    );
    await h.close();
  } finally {
    temp.cleanup();
  }
});

test("Claude Bot: si ya había un agente con ese nombre, lo adopta en vez de duplicarlo", async () => {
  const temp = tempDir();
  try {
    let h = await createHarness({ dir: temp.path, keepDir: true });
    assert.equal(h.service.mainAgentId(), null, "sin la opción no hay bot principal");
    const mine = h.service.createAgent({ name: "claude bot", role: "Mi asistente", provider: "claude" });
    await h.close();

    h = await createHarness({ dir: temp.path, keepDir: true, mainAgent: true });
    assert.equal(h.service.mainAgentId(), mine.id);
    assert.equal(h.service.listAgents().length, 1);
    assert.equal(h.service.getAgent(mine.id).role, "Mi asistente", "conserva lo que el usuario le puso");
    await h.close();
  } finally {
    temp.cleanup();
  }
});

test("Claude Bot arma un equipo: crea los agentes en un proyecto, los ajusta y le pasa el encargo al líder", async () => {
  const h = await createHarness({ mainAgent: true });
  try {
    const mainId = h.service.mainAgentId() as string;
    const reply = await talk(
      h,
      mainId,
      [
        "/crear Directora | Coordina el equipo | Creación de Juegos",
        "/crear Programador | Escribe el código | Creación de Juegos",
        "@Directora: Primer encargo: arma el plan del juego.",
      ].join("\n"),
    );
    assert.match(reply, /Creé a Directora en «Creación de Juegos»/);
    assert.match(reply, /Creé a Programador en «Creación de Juegos»/);

    const directora = h.store.findAgentByName("Directora");
    const programador = h.store.findAgentByName("Programador");
    assert.ok(directora && programador);
    assert.equal(directora.project, "Creación de Juegos");
    assert.equal(directora.role, "Coordina el equipo");
    assert.match(directora.instructions, /Coordina el equipo/);
    assert.equal(directora.provider, "claude", "por defecto, el mismo proveedor que Claude Bot");
    assert.equal(directora.access, "carpeta", "el bot no puede dar más acceso");

    const created = h.service.listMessages(mainId).filter((item) => item.role === "activity");
    assert.deepEqual(
      created.map((item) => [item.text, item.payload?.kind, item.payload?.agentId]),
      [
        ["Creó el agente «Directora» · Creación de Juegos", "agent-created", directora.id],
        ["Creó el agente «Programador» · Creación de Juegos", "agent-created", programador.id],
      ],
    );
    // El líder ve quién lo creó y recibe el encargo como mensaje de un compañero.
    await waitFor(
      () => h.service.listMessages(directora.id).some((item) => item.role === "teammate" && /Primer encargo/.test(item.text)),
      5_000,
      "encargo al líder",
    );
    const notice = h.service.listMessages(directora.id).find((item) => item.role === "notice");
    assert.equal(notice?.text, `${MAIN_AGENT_NAME} creó este agente para el proyecto «Creación de Juegos».`);
    assert.equal(h.service.getAgent(programador.id).unread, true, "el agente nuevo aparece como no leído");

    // Ajustes: cambia solo lo pedido y lo deja anotado en las dos conversaciones.
    const adjusted = await talk(h, mainId, "/ajustar Programador | Programa el juego en Godot");
    assert.match(adjusted, /Le cambié el rol a Programador/);
    assert.equal(h.service.getAgent(programador.id).role, "Programa el juego en Godot");
    assert.equal(h.service.getAgent(programador.id).project, "Creación de Juegos");
    assert.ok(h.service.listMessages(mainId).some((item) => item.text === "Ajustó a «Programador»: rol" && item.payload?.kind === "agent-updated"));
    assert.ok(h.service.listMessages(programador.id).some((item) => item.text === `${MAIN_AGENT_NAME} ajustó este agente: rol.`));

    // Nombres repetidos y cambios sobre sí mismo: error claro para el bot, sin efectos.
    const duplicate = await talk(h, mainId, "/crear directora | Otra | Otro proyecto");
    assert.match(duplicate, /No pude crear a directora: Ya existe un agente llamado «directora»\. Elige otro nombre, o ajusta ese agente con update_agent\./);
    const self = await talk(h, mainId, `/ajustar ${MAIN_AGENT_NAME} | Otro rol`);
    assert.match(self, /No puedes cambiarte a ti mismo/);
    assert.equal(h.service.getAgent(mainId).role, MAIN_AGENT_ROLE);
    assert.equal(h.service.listAgents().length, 3);
  } finally {
    await h.close();
  }
});

test("Claude Bot crea el canal del equipo: con el líder de encargado, sin incluirse y sin repetirlo", async () => {
  const h = await createHarness({ mainAgent: true });
  try {
    const mainId = h.service.mainAgentId() as string;
    const reply = await talk(
      h,
      mainId,
      [
        "/crear Directora | Coordina el equipo | Creación de Juegos",
        "/crear Programador | Escribe el código | Creación de Juegos",
        "/canal Creación de Juegos | Directora | Programador, Directora",
      ].join("\n"),
    );
    assert.match(reply, /Creé el canal «Creación de Juegos»\./);
    const directora = h.store.findAgentByName("Directora");
    const programador = h.store.findAgentByName("Programador");
    assert.ok(directora && programador);
    const channels = h.service.listChannels();
    assert.equal(channels.length, 1);
    const channel = channels[0]!;
    assert.equal(channel.name, "Creación de Juegos");
    assert.equal(channel.leadId, directora.id, "el líder queda de encargado");
    assert.deepEqual(channel.memberIds, [programador.id, directora.id]);
    const activity = h.service.listMessages(mainId).find((item) => item.payload?.kind === "channel-created");
    assert.equal(activity?.text, "Creó el canal «Creación de Juegos» · Programador, Directora");
    assert.equal(activity?.payload?.channelId, channel.id);

    // list_agents le muestra los canales que ya hay, para no repetirlos.
    const seen = JSON.parse(/Compañeros: (\{.*\})/.exec(await talk(h, mainId, "/equipo"))?.[1] ?? "{}");
    assert.deepEqual(seen.canales, [{ nombre: "Creación de Juegos", encargado: "Directora", miembros: ["Programador", "Directora"] }]);

    // Errores claros para el bot, sin crear nada: repetido, él mismo como miembro, encargado de fuera y un agente que no existe.
    const again = await talk(h, mainId, "/canal Creación de Juegos | Directora | Directora, Programador");
    assert.match(again, /Ya existe un canal llamado «Creación de Juegos»\. Si es el de este equipo, no hace falta otro/);
    const self = await talk(h, mainId, `/canal Otro | Directora | Directora, ${MAIN_AGENT_NAME}`);
    assert.match(self, /No te incluyas en el canal/);
    const outsider = await talk(h, mainId, "/canal Otro | Directora | Programador");
    assert.match(outsider, /Directora no está entre los miembros/);
    const unknown = await talk(h, mainId, "/canal Otro | | Nadie");
    assert.match(unknown, /No existe el agente «Nadie»/);
    assert.equal(h.service.listChannels().length, 1);

    // Sin encargado, queda el primero; y otro agente no puede crear canales.
    await talk(h, mainId, "/canal Revisión | | Programador, Directora");
    assert.equal(h.service.listChannels().find((item) => item.name === "Revisión")?.leadId, programador.id);
    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    const refused = await talk(h, ana.id, "/canal Intrusos | | Ana");
    assert.match(refused, /No pude crear el canal «Intrusos»: Solo el bot principal puede crear o cambiar agentes y crear canales/);
    assert.equal(h.service.listChannels().length, 2);
  } finally {
    await h.close();
  }
});

test("solo el bot principal crea agentes, y tiene un tope por pedido", async () => {
  const h = await createHarness({ mainAgent: true });
  try {
    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    const refused = await talk(h, ana.id, "/crear Intruso | Rol | Proyecto\n/ajustar Claude Bot | Otro rol");
    assert.match(refused, /No pude crear a Intruso: Solo el bot principal puede crear o cambiar agentes/);
    assert.match(refused, /No pude ajustar a Claude Bot: Solo el bot principal/);
    assert.equal(h.store.findAgentByName("Intruso"), null);

    const mainId = h.service.mainAgentId() as string;
    const lines = Array.from({ length: MAX_AGENTS_PER_TURN + 1 }, (_, index) => `/crear Agente ${index + 1} | Rol | Grande`);
    const reply = await talk(h, mainId, lines.join("\n"));
    assert.match(reply, new RegExp(`No pude crear a Agente ${MAX_AGENTS_PER_TURN + 1}: Ya creaste ${MAX_AGENTS_PER_TURN} agentes en este turno`));
    assert.equal(h.service.listAgents().filter((agent) => agent.project === "Grande").length, MAX_AGENTS_PER_TURN);
    // En el turno siguiente puede seguir.
    await talk(h, mainId, `/crear Agente ${MAX_AGENTS_PER_TURN + 1} | Rol | Grande`);
    assert.equal(h.service.listAgents().filter((agent) => agent.project === "Grande").length, MAX_AGENTS_PER_TURN + 1);
  } finally {
    await h.close();
  }
});

test("list_agents muestra proyecto y bot principal; las instrucciones solo las ve Claude Bot", async () => {
  const h = await createHarness({ mainAgent: true });
  try {
    const mainId = h.service.mainAgentId() as string;
    const ana = h.service.createAgent({ name: "Ana", provider: "demo", project: "Web", instructions: "Revisa el sitio cada día." });
    const parse = (reply: string) => JSON.parse(/Compañeros: (\{.*\})/.exec(reply)?.[1] ?? "{}").agentes as Array<Record<string, unknown>>;

    const fromAna = parse(await talk(h, ana.id, "/equipo"));
    const mainSeenByAna = fromAna.find((agent) => agent.id === mainId);
    assert.equal(mainSeenByAna?.botPrincipal, true);
    assert.equal(fromAna.find((agent) => agent.id === ana.id)?.proyecto, "Web");
    assert.ok(fromAna.every((agent) => agent.instrucciones === undefined));

    const fromMain = parse(await talk(h, mainId, "/equipo"));
    const anaSeenByMain = fromMain.find((agent) => agent.id === ana.id);
    assert.equal(anaSeenByMain?.instrucciones, "Revisa el sitio cada día.");
    assert.equal(anaSeenByMain?.modelo, "predeterminado");
  } finally {
    await h.close();
  }
});

test("instrucciones: solo el bot principal recibe la guía para armar equipos", () => {
  const agent = {
    id: "a",
    name: "Claude Bot",
    role: MAIN_AGENT_ROLE,
    instructions: "Usa Sonnet para tareas simples.",
    provider: "claude" as const,
    model: null,
    effort: null,
    access: "carpeta" as const,
    workspace: "/tmp/claude-bot",
    threadId: null,
    paused: false,
    preview: "",
    project: "",
    avatar: 0,
    pinned: false,
    hidden: false,
    voice: { name: "", rate: 1, lang: "auto", autoRead: false },
    readAt: 0,
    lastAt: 0,
    createdAt: 0,
    updatedAt: 0,
  };
  const main = buildInstructions(agent, "/tmp/compartida", "Jonathan", { main: true });
  assert.ok(main.includes(MAIN_AGENT_GUIDE));
  assert.match(main, /preferencias del usuario para armar sus equipos/);
  assert.match(main, /Usa Sonnet para tareas simples/);
  const regular = buildInstructions({ ...agent, name: "Ana" }, "/tmp/compartida");
  assert.ok(!regular.includes("create_agent"));
  assert.match(regular, /encargo permanente/);
});
