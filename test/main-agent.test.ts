import assert from "node:assert/strict";
import { test } from "node:test";
import { buildInstructions, MAIN_AGENT_GUIDE } from "../src/instructions.js";
import type { AgentClient } from "../src/providers/client.js";
import { DemoAgentClient } from "../src/providers/demo.js";
import { DELETE_AGENTS_CARD, MAIN_AGENT_NAME, MAIN_AGENT_ROLE, MAX_AGENTS_PER_TURN, ServiceError } from "../src/service.js";
import { parseCreateAgentArgs, parseDeleteAgentsArgs, parseUpdateAgentArgs } from "../src/team.js";
import { createHarness, tempDir, waitFor, type Harness } from "./helpers.js";

/** Demo que guarda lo que recibe en cada turno (para ver la nota de ClosedBot); con `fail`, el próximo turno no empieza. */
function recordingClient(inputs: string[], fail: { next: boolean } = { next: false }): () => AgentClient {
  return () => {
    const client = new DemoAgentClient({ wordDelayMs: 0 });
    const request = client.request.bind(client);
    client.request = (async (method: string, params: unknown) => {
      if (method === "turn/start") {
        inputs.push((params as { input: Array<{ text: string }> }).input[0]?.text ?? "");
        if (fail.next) {
          fail.next = false;
          throw new Error("falla de prueba");
        }
      }
      return request(method, params);
    }) as AgentClient["request"];
    return client;
  };
}

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
    assert.match(refused, /No pude crear el canal «Intrusos»: Solo el bot principal puede crear, cambiar o eliminar agentes y crear canales/);
    assert.equal(h.service.listChannels().length, 2);
  } finally {
    await h.close();
  }
});

test("Claude Bot se entera de lo que cambia el usuario en agentes y canales, y no de lo que hizo él", async () => {
  const inputs: string[] = [];
  const h = await createHarness({ mainAgent: true, createClient: recordingClient(inputs) });
  try {
    const mainId = h.service.mainAgentId() as string;
    const last = () => inputs[inputs.length - 1] ?? "";

    // Conversación nueva: cómo está todo.
    await talk(h, mainId, "hola");
    assert.equal(last(), "[ClosedBot · así están ahora los agentes y canales del usuario; esto manda sobre lo que recuerdes de la conversación]\n- No hay otros agentes ni canales.\n\nhola");
    // Sin cambios no hay nota.
    await talk(h, mainId, "¿sigues?");
    assert.equal(last(), "¿sigues?");

    // Lo que hace él mismo con sus herramientas ya lo sabe.
    await talk(
      h,
      mainId,
      [
        "/crear Directora | Coordina el equipo | Creación de Juegos",
        "/crear Programador | Escribe el código | Creación de Juegos",
        "/canal Creación de Juegos | Directora | Directora, Programador",
        "/ajustar Programador | Programa el juego",
      ].join("\n"),
    );
    await talk(h, mainId, "¿listo?");
    assert.equal(last(), "¿listo?");

    // El usuario elimina el equipo desde la barra lateral (los agentes y su canal vacío) y crea a otra agente.
    const directora = h.store.findAgentByName("Directora");
    const programador = h.store.findAgentByName("Programador");
    assert.ok(directora && programador);
    const channel = h.service.listChannels()[0];
    assert.ok(channel);
    await h.service.deleteAgent(directora.id, { stop: true });
    await h.service.deleteAgent(programador.id, { stop: true });
    h.service.deleteChannel(channel.id);
    const ana = h.service.createAgent({ name: "Ana", role: "Investiga", provider: "demo", project: "Investigación" });
    const reply = await talk(h, mainId, "crea nuevamente un equipo para creacion de juegos");
    assert.equal(
      last(),
      [
        "[ClosedBot · cambios que hizo el usuario en sus agentes y canales desde tu último mensaje; esto manda sobre lo que recuerdes]",
        "- Eliminó a «Directora» y «Programador» (de la sección «Creación de Juegos»).",
        "- Creó a «Ana» (Investiga) en la sección «Investigación».",
        "- Eliminó el canal «Creación de Juegos»: quedó en «Canales eliminados» y ya no se usa.",
        "",
        "crea nuevamente un equipo para creacion de juegos",
      ].join("\n"),
    );
    assert.match(reply, /ClosedBot me contó cómo están tus agentes:\n- Eliminó a «Directora» y «Programador»/);
    // En la conversación se ve solo lo que escribió el usuario.
    const shown = h.service.listMessages(mainId).filter((item) => item.role === "user");
    assert.equal(shown[shown.length - 1]?.text, "crea nuevamente un equipo para creacion de juegos");

    // Nombre, sección renombrada, rol, instrucciones, modelo, pausa y un canal nuevo.
    const beto = h.service.createAgent({ name: "Beto", provider: "demo", project: "Investigación" });
    await talk(h, mainId, "ok");
    h.service.renameSection("Investigación", "Estudios");
    h.service.updateAgent(ana.id, { name: "Ana María", role: "Investiga mercados", instructions: "Compara precios.", model: "rápido" });
    h.service.setPaused(beto.id, true);
    h.service.createChannel({ name: "Estudios", memberIds: [ana.id, beto.id], leadId: ana.id });
    await talk(h, mainId, "¿qué cambió?");
    assert.deepEqual(last().split("\n").slice(1, -2), [
      "- Cambió el nombre de «Ana» a «Ana María».",
      "- Cambió el rol de «Ana María»: «Investiga mercados».",
      "- Cambió las instrucciones de «Ana María» (léelas con list_agents).",
      "- Cambió el modelo de «Ana María» a rápido.",
      "- Pausó la cola de «Beto»: no atiende mensajes hasta que la reanude.",
      "- Cambió el nombre de la sección «Investigación» a «Estudios» (con «Ana María» y «Beto»).",
      "- Creó el canal «Estudios» («Ana María» y «Beto»; encargado: «Ana María»).",
    ]);

    // «Empezar de cero»: en la conversación nueva se le cuenta todo otra vez.
    await h.service.resetConversation(mainId);
    await talk(h, mainId, "hola de nuevo");
    assert.equal(
      last(),
      [
        "[ClosedBot · así están ahora los agentes y canales del usuario; esto manda sobre lo que recuerdes de la conversación]",
        "- Sección «Estudios»: «Ana María» (Investiga mercados; Demo), «Beto» (Demo; cola en pausa).",
        "- Canales: «Estudios» («Ana María» y «Beto»; encargado: «Ana María»).",
        "- En «Canales eliminados»: «Creación de Juegos».",
        "",
        "hola de nuevo",
      ].join("\n"),
    );
    // Los demás agentes no reciben la nota.
    await talk(h, ana.id, "hola Ana");
    assert.equal(last(), "hola Ana");
  } finally {
    await h.close();
  }
});

test("si el turno de Claude Bot no llega a empezar, lo que cambió se le cuenta en el siguiente", async () => {
  const inputs: string[] = [];
  const fail = { next: false };
  const h = await createHarness({ mainAgent: true, createClient: recordingClient(inputs, fail) });
  try {
    const mainId = h.service.mainAgentId() as string;
    await talk(h, mainId, "hola");
    h.service.createAgent({ name: "Ana", role: "Investiga", provider: "demo" });
    fail.next = true;
    await talk(h, mainId, "primero");
    assert.match(inputs[inputs.length - 1] ?? "", /- Creó a «Ana» \(Investiga\) sin sección\.\n\nprimero$/);
    assert.equal(h.service.listMessages(mainId).filter((item) => item.role === "user").pop()?.status, "failed");
    await talk(h, mainId, "segundo");
    assert.match(inputs[inputs.length - 1] ?? "", /- Creó a «Ana» \(Investiga\) sin sección\.\n\nsegundo$/);
    await talk(h, mainId, "tercero");
    assert.equal(inputs[inputs.length - 1], "tercero");
  } finally {
    await h.close();
  }
});

test("solo el bot principal crea agentes, y tiene un tope por pedido", async () => {
  const h = await createHarness({ mainAgent: true });
  try {
    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    const refused = await talk(h, ana.id, "/crear Intruso | Rol | Proyecto\n/ajustar Claude Bot | Otro rol");
    assert.match(refused, /No pude crear a Intruso: Solo el bot principal puede crear, cambiar o eliminar agentes/);
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

test("Claude Bot elimina agentes: deja una tarjeta para confirmar y, al tocar «Eliminar», los elimina", async () => {
  const inputs: string[] = [];
  const h = await createHarness({ mainAgent: true, createClient: recordingClient(inputs) });
  try {
    const mainId = h.service.mainAgentId() as string;
    await talk(
      h,
      mainId,
      [
        "/crear Directora | Coordina el equipo | Creación de Juegos",
        "/crear Programador | Escribe el código | Creación de Juegos",
        "/crear Artista | Dibuja los personajes | Creación de Juegos",
        "/canal Creación de Juegos | Directora | Directora, Programador",
        "/canal Arte | Artista | Artista, Directora",
      ].join("\n"),
    );
    const directora = h.store.findAgentByName("Directora");
    const programador = h.store.findAgentByName("Programador");
    const artista = h.store.findAgentByName("Artista");
    assert.ok(directora && programador && artista);

    // Pedirlo no elimina nada todavía: deja la tarjeta para que el usuario lo confirme.
    const reply = await talk(h, mainId, "/eliminar Directora, programador, Directora");
    assert.match(reply, /Te dejé la tarjeta para eliminar a Directora, programador/);
    assert.ok(h.store.getAgent(directora.id) && h.store.getAgent(programador.id));
    const card = h.service.listMessages(mainId).filter((item) => item.role === "decision").at(-1);
    assert.ok(card);
    assert.equal(card.text, "¿Eliminar a «Directora» y «Programador»?");
    assert.equal(card.payload?.kind, DELETE_AGENTS_CARD);
    assert.deepEqual(card.payload?.agentIds, [directora.id, programador.id]);
    assert.deepEqual(card.payload?.options, [
      {
        label: "Eliminar",
        detail: "Se borran con su historial, su cola y sus rutinas; sus archivos quedan en sus carpetas. El canal «Creación de Juegos» pasa a «Canales eliminados».",
      },
      { label: "Cancelar", detail: "No se elimina a nadie." },
    ]);
    assert.equal(card.payload?.recommended, null, "no se recomienda eliminar");
    assert.equal(h.service.getAgent(mainId).preview, "Pregunta: ¿Eliminar a «Directora» y «Programador»?");

    // Al que está trabajando se le detiene el turno.
    h.service.sendUserMessage(programador.id, "/lento escribe un informe largo para el equipo");
    await waitFor(() => h.service.getAgent(programador.id).state === "working", 5_000, "Programador trabajando");
    const answer = await h.service.answerDecision(mainId, card.id, 0);
    assert.equal(answer.decision.payload?.answer, 0);
    assert.equal(answer.message.text, "A. Eliminar");
    assert.equal(
      answer.delivery.text,
      "El usuario confirmó y ClosedBot eliminó a «Directora» y «Programador», con su historial, su cola y sus rutinas (sus archivos siguen en sus carpetas). El canal «Creación de Juegos» pasó a «Canales eliminados». Confírmaselo al usuario en una línea y sigue con lo que quede de su pedido.",
    );
    assert.equal(h.store.getAgent(directora.id), null);
    assert.equal(h.store.getAgent(programador.id), null);
    assert.deepEqual(
      h.service.listDeletedChannels().map((channel) => channel.name),
      ["Creación de Juegos"],
      "el canal que quedó vacío pasa a «Canales eliminados»",
    );
    const arte = h.service.listChannels().find((channel) => channel.name === "Arte");
    assert.deepEqual([arte?.memberIds, arte?.leadId], [[artista.id], artista.id], "el otro canal sigue con los que quedan");
    const activity = h.service.listMessages(mainId).find((item) => item.payload?.kind === "agents-deleted");
    assert.equal(activity?.text, "Eliminó a «Directora» y «Programador»");
    assert.deepEqual(activity?.payload?.channels, ["Creación de Juegos"]);

    // Claude Bot recibe el resultado tal cual: no se le cuenta después como un cambio del usuario.
    await waitFor(() => h.store.getMessage(answer.message.id)?.status === "completed", 5_000, "Claude Bot recibe el resultado");
    assert.ok(inputs.includes(answer.delivery.text), inputs.at(-1));
    await assert.rejects(h.service.answerDecision(mainId, card.id, 0), (error: unknown) => error instanceof ServiceError && error.status === 409);

    // «Cancelar» no elimina a nadie.
    await talk(h, mainId, "/eliminar Artista");
    const second = h.service.listMessages(mainId).filter((item) => item.role === "decision").at(-1);
    assert.ok(second && second.id !== card.id);
    assert.equal(second.text, "¿Eliminar a «Artista»?");
    assert.equal(
      (second.payload?.options as Array<{ detail: string }>)[0]?.detail,
      "Se borra con su historial, su cola y sus rutinas; sus archivos quedan en su carpeta. El canal «Arte» pasa a «Canales eliminados».",
    );
    const cancelled = await h.service.answerDecision(mainId, second.id, 1);
    assert.equal(cancelled.message.text, "B. Cancelar");
    assert.match(cancelled.delivery.text, /tocó «Cancelar» en la tarjeta para eliminar a «Artista»: no se eliminó a nadie/);
    assert.ok(h.store.getAgent(artista.id));
    await waitFor(() => h.store.getMessage(cancelled.message.id)?.status === "completed", 5_000, "Claude Bot recibe que se canceló");
    assert.equal(inputs.at(-1), cancelled.delivery.text);
  } finally {
    await h.close();
  }
});

test("Claude Bot no se elimina a sí mismo, otro agente no puede eliminar y lo que ya no existe se avisa", async () => {
  const h = await createHarness({ mainAgent: true });
  try {
    const mainId = h.service.mainAgentId() as string;
    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    const beto = h.service.createAgent({ name: "Beto", provider: "demo" });
    const cards = () => h.service.listMessages(mainId).filter((item) => item.role === "decision");

    assert.match(await talk(h, mainId, `/eliminar Ana, ${MAIN_AGENT_NAME}`), /No puedes eliminarte a ti mismo/);
    assert.match(await talk(h, mainId, "/eliminar Nadie"), /No existe el agente «Nadie»/);
    assert.equal(cards().length, 0, "sin tarjeta si algo no cuadra");
    const refused = await talk(h, ana.id, "/eliminar Beto");
    assert.match(refused, /Solo el bot principal puede crear, cambiar o eliminar agentes/);
    assert.equal(h.service.listMessages(ana.id).filter((item) => item.role === "decision").length, 0);

    // Si el usuario eliminó a uno antes de confirmar, se elimina al resto y se le cuenta.
    await talk(h, mainId, "/eliminar Ana, Beto");
    const card = cards().at(-1);
    assert.ok(card);
    await h.service.deleteAgent(beto.id);
    const answer = await h.service.answerDecision(mainId, card.id, 0);
    assert.equal(h.store.getAgent(ana.id), null);
    assert.match(answer.delivery.text, /eliminó a «Ana», con su historial.*«Beto» ya no existía\./);
    assert.equal(h.service.listMessages(mainId).find((item) => item.payload?.kind === "agents-deleted")?.text, "Eliminó a «Ana»");
    assert.ok(h.store.getAgent(mainId), "Claude Bot sigue");
  } finally {
    await h.close();
  }
});

test("delete_agents y el proveedor local: lo que entiende Claude Bot", () => {
  assert.deepEqual(parseDeleteAgentsArgs({ agents: [" Ana ", "ana", "Beto"] }), { agents: ["Ana", "Beto"] });
  assert.deepEqual(parseDeleteAgentsArgs({ agents: "Ana" }), { agents: ["Ana"] });
  assert.throws(() => parseDeleteAgentsArgs({ agents: [] }), /lista con los ids o nombres/);
  assert.throws(() => parseDeleteAgentsArgs({}), /lista con los ids o nombres/);
  // Qwen local también se puede elegir (estaba en la lista de proveedores, pero se rechazaba).
  assert.equal(parseCreateAgentArgs({ name: "Qwen", role: "Ayuda", instructions: "Ayuda.", project: "Local", provider: "local" }).provider, "local");
  assert.equal(parseUpdateAgentArgs({ agent: "Qwen", provider: "local" }).provider, "local");
  assert.throws(() => parseUpdateAgentArgs({ agent: "Qwen", provider: "otro" }), /claude, codex, grok, gemini o local/);
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
    description: "",
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
    notify: "" as const,
    skillsOff: [],
    appearance: "",
    character: null,
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
