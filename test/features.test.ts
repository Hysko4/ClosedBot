import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Store } from "../src/db.js";
import { MAX_ROUTINES_PER_AGENT, ServiceError } from "../src/service.js";
import { createHarness, tempDir, waitFor } from "./helpers.js";

test("preguntas: el agente pregunta con opciones y la respuesta le llega como mensaje", async () => {
  const h = await createHarness();
  try {
    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    h.service.sendUserMessage(ana.id, "/pregunta ¿Pizza o sushi? | Pizza | Sushi");
    const decision = await waitFor(
      () => h.service.listMessages(ana.id).find((message) => message.role === "decision"),
      5_000,
      "tarjeta de decisión",
    );
    assert.equal(decision.text, "¿Pizza o sushi?");
    assert.deepEqual(decision.payload, {
      options: [
        { label: "Pizza", detail: "" },
        { label: "Sushi", detail: "" },
      ],
      recommended: 0,
      answer: null,
      answeredAt: null,
    });
    await waitFor(() => h.service.getAgent(ana.id).state === "idle", 5_000, "turno terminado");
    const asked = h.service.getAgent(ana.id);
    assert.equal(asked.preview, "Pregunta: ¿Pizza o sushi?", "la lista muestra la pregunta pendiente");
    assert.equal(asked.unread, true);
    assert.equal(
      h.service.listMessages(ana.id).some((message) => message.role === "activity"),
      false,
      "las herramientas de ClosedBot no dejan líneas de actividad repetidas",
    );

    assert.throws(() => h.service.answerDecision(ana.id, decision.id, 5), (error: unknown) => error instanceof ServiceError && error.status === 400);
    const answer = h.service.answerDecision(ana.id, decision.id, 1);
    assert.equal(answer.decision.payload?.answer, 1);
    assert.equal(answer.message.text, "B. Sushi");
    assert.match(answer.delivery.text, /eligió la opción B, «Sushi»/);
    assert.equal(h.service.getAgent(ana.id).unread, false, "responder marca la conversación como leída");
    await waitFor(() => h.store.getMessage(answer.message.id)?.status === "completed", 5_000, "respuesta procesada");
    const replies = h.service.listMessages(ana.id).filter((message) => message.role === "assistant");
    assert.match(replies.at(-1)?.text ?? "", /Respuesta del usuario a tu pregunta/);
    assert.throws(() => h.service.answerDecision(ana.id, decision.id, 0), (error: unknown) => error instanceof ServiceError && error.status === 409);

    const beto = h.service.createAgent({ name: "Beto", provider: "demo" });
    assert.throws(() => h.service.answerDecision(beto.id, decision.id, 0), (error: unknown) => error instanceof ServiceError && error.status === 404);
  } finally {
    await h.close();
  }
});

test("no leídos: se marcan con cada respuesta y se limpian al abrir la conversación", async () => {
  const h = await createHarness();
  try {
    const ana = h.service.createAgent({ name: "Ana", provider: "demo", project: "  Creación   de juegos " });
    assert.equal(ana.project, "Creación de juegos");
    assert.equal(ana.unread, false);
    const first = h.service.sendUserMessage(ana.id, "Hola").message;
    await waitFor(() => h.store.getMessage(first.id)?.status === "completed", 5_000, "primera respuesta");
    await waitFor(() => h.service.getAgent(ana.id).state === "idle", 5_000, "libre");
    assert.equal(h.service.getAgent(ana.id).unread, true);
    assert.equal(h.service.markRead(ana.id).unread, false);
    const second = h.service.sendUserMessage(ana.id, "Otra vez").message;
    await waitFor(() => h.store.getMessage(second.id)?.status === "completed", 5_000, "segunda respuesta");
    await waitFor(() => h.service.getAgent(ana.id).unread, 5_000, "vuelve a no leído");
    assert.equal(h.service.updateAgent(ana.id, { project: "" }).project, "");
  } finally {
    await h.close();
  }
});

test("rutinas: el agente crea una, corre a su hora y no se acumula", async () => {
  const h = await createHarness();
  try {
    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    const created = h.service.sendUserMessage(ana.id, "/rutina 09:00 Resumen diario").message;
    await waitFor(() => h.store.getMessage(created.id)?.status === "completed", 5_000, "rutina creada");
    const [routine] = h.service.listRoutines(ana.id);
    assert.ok(routine);
    assert.equal(routine.name, "Resumen diario");
    assert.deepEqual(routine.schedule, { times: ["09:00"] });
    assert.equal(routine.description, "todos los días a las 09:00");
    assert.equal(routine.agentName, "Ana");
    assert.ok((routine.nextRunAt ?? 0) > Date.now());
    const activity = h.service.listMessages(ana.id).find((message) => message.role === "activity");
    assert.equal(activity?.text, "Creó la rutina «Resumen diario» · todos los días a las 09:00");
    assert.ok(h.events.some((event) => event.type === "routines" && event.routines.length === 1));

    // Llega la hora.
    const now = Date.now();
    h.store.updateRoutine(routine.id, { nextRunAt: now - 1_000 });
    h.service.checkRoutines(now);
    const run = await waitFor(() => h.service.listMessages(ana.id).find((message) => message.role === "routine"), 5_000, "ejecución");
    assert.equal(run.text, "Resumen diario");
    await waitFor(() => h.store.getMessage(run.id)?.status === "completed", 5_000, "rutina atendida");
    const reply = h.service.listMessages(ana.id).filter((message) => message.role === "assistant").at(-1);
    assert.match(reply?.text ?? "", /Rutina programada «Resumen diario»/);
    const after = h.service.listRoutines(ana.id)[0];
    assert.ok((after?.nextRunAt ?? 0) > now, "programa la siguiente");
    assert.ok(after?.lastDeliveryId);

    // Con el agente en pausa la ejecución queda en cola, y la siguiente no se acumula.
    h.service.setPaused(ana.id, true);
    h.store.updateRoutine(routine.id, { nextRunAt: Date.now() - 1_000 });
    h.service.checkRoutines();
    h.store.updateRoutine(routine.id, { nextRunAt: Date.now() - 1_000 });
    h.service.checkRoutines();
    const runs = () => h.service.listMessages(ana.id).filter((message) => message.role === "routine");
    assert.equal(runs().length, 2);
    assert.equal(h.service.listRoutines(ana.id)[0]?.running, true);
    assert.throws(() => h.service.runRoutineNow(routine.id), (error: unknown) => error instanceof ServiceError && error.status === 409);
    h.service.setPaused(ana.id, false);
    await waitFor(() => runs().every((message) => message.status === "completed"), 5_000, "cola de rutinas vacía");

    // Si la app estuvo cerrada más de 2 horas, se salta y se avisa.
    h.store.updateRoutine(routine.id, { nextRunAt: Date.now() - 3 * 60 * 60_000 });
    h.service.checkRoutines();
    assert.equal(runs().length, 2);
    assert.ok(h.service.listMessages(ana.id).some((message) => message.role === "notice" && /no corrió/.test(message.text)));

    // A mano, apagar, encender y borrar.
    h.service.runRoutineNow(routine.id);
    assert.equal(runs().length, 3);
    assert.equal(runs().at(-1)?.payload?.manual, true);
    assert.equal(h.service.setRoutineEnabled(routine.id, false).nextRunAt, null);
    assert.ok((h.service.setRoutineEnabled(routine.id, true).nextRunAt ?? 0) > Date.now());
    h.service.deleteRoutine(routine.id);
    assert.equal(h.service.listRoutines().length, 0);
  } finally {
    await h.close();
  }
});

test("rutinas: validan el horario, tienen tope y se borran con su agente", async () => {
  const h = await createHarness();
  try {
    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    assert.throws(
      () => h.service.createRoutine(ana.id, { name: "Mal", prompt: "x", times: ["25:00"] }),
      (error: unknown) => error instanceof ServiceError && error.status === 400 && /Hora inválida/.test(error.message),
    );
    assert.throws(() => h.service.createRoutine(ana.id, { name: "", prompt: "x", everyMinutes: 60 }), /name/);
    const weekly = h.service.createRoutine(ana.id, { name: "Semanal", prompt: "Revisa", times: ["08:00"], days: [1, 2, 3, 4, 5] });
    assert.equal(weekly.description, "de lunes a viernes a las 08:00");
    assert.match(h.service.listMessages(ana.id).at(-1)?.text ?? "", /^Creaste la rutina «Semanal»/);
    for (let index = 1; index < MAX_ROUTINES_PER_AGENT; index += 1) {
      h.service.createRoutine(ana.id, { name: `R${index}`, prompt: "x", everyMinutes: 60 });
    }
    assert.throws(
      () => h.service.createRoutine(ana.id, { name: "Una más", prompt: "x", everyMinutes: 60 }),
      (error: unknown) => error instanceof ServiceError && error.status === 409,
    );
    await h.service.deleteAgent(ana.id);
    assert.equal(h.service.listRoutines().length, 0);
  } finally {
    await h.close();
  }
});

test("ajustes: nombres del asistente y del usuario", async () => {
  const h = await createHarness();
  try {
    assert.deepEqual(h.service.getSettings(), { botName: "ClosedBot", userName: "", fullAccess: false });
    assert.deepEqual(h.service.updateSettings({ userName: "  Jonathan  " }), { botName: "ClosedBot", userName: "Jonathan", fullAccess: false });
    assert.deepEqual(h.service.updateSettings({ botName: "Mi Bot" }), { botName: "Mi Bot", userName: "Jonathan", fullAccess: false });
    assert.equal(h.service.updateSettings({ botName: "" }).botName, "ClosedBot");
    assert.throws(() => h.service.updateSettings({ userName: "x".repeat(41) }), /40 caracteres/);
    assert.ok(h.events.some((event) => event.type === "settings"));
  } finally {
    await h.close();
  }
});

test("adjuntos: se guardan con un nombre seguro dentro de la carpeta del agente", async () => {
  const h = await createHarness();
  try {
    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    const first = h.service.saveAttachment(ana.id, "../../etc/passwd", Buffer.from("uno"));
    assert.equal(first.name, "passwd");
    assert.equal(first.relativePath, "adjuntos/passwd");
    assert.equal(first.path, join(ana.workspace, "adjuntos", "passwd"));
    assert.equal(readFileSync(first.path, "utf8"), "uno");
    assert.equal(h.service.saveAttachment(ana.id, "C:\\Temp\\passwd", Buffer.from("dos")).name, "passwd-2");
    assert.equal(h.service.saveAttachment(ana.id, "informe final.pdf", Buffer.from("x")).name, "informe final.pdf");
    assert.equal(h.service.saveAttachment(ana.id, "informe final.pdf", Buffer.from("x")).name, "informe final-2.pdf");
    assert.equal(h.service.saveAttachment(ana.id, ".claude", Buffer.from("x")).name, "claude", "sin archivos ocultos");
    assert.equal(h.service.saveAttachment(ana.id, "CON.txt", Buffer.from("x")).name, "_CON.txt");
    assert.equal(h.service.saveAttachment(ana.id, 'a<b>:"c|?*.txt', Buffer.from("x")).name, "a_b___c___.txt");
    assert.equal(h.service.saveAttachment(ana.id, "", Buffer.from("x")).name, "archivo");
    assert.throws(() => h.service.saveAttachment(ana.id, "vacio.txt", Buffer.alloc(0)), /vacío/);
    assert.ok(!existsSync(join(h.dir, "etc")));
  } finally {
    await h.close();
  }
});

test("Store: una base de la versión 0.1 se actualiza sin perder datos", () => {
  const temp = tempDir();
  try {
    const path = join(temp.path, "closedbot.db");
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL DEFAULT '',
        provider TEXT NOT NULL, model TEXT, effort TEXT, access TEXT NOT NULL DEFAULT 'carpeta', workspace TEXT NOT NULL, thread_id TEXT,
        paused INTEGER NOT NULL DEFAULT 0, preview TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        role TEXT NOT NULL, from_agent_id TEXT, to_agent_ids TEXT NOT NULL DEFAULT '[]', reply_to TEXT, text TEXT NOT NULL, status TEXT NOT NULL,
        turn_id TEXT, delivery_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO meta VALUES ('schema_version', '1');
      INSERT INTO agents (id, name, provider, workspace, preview, created_at, updated_at) VALUES ('a1', 'Ana', 'demo', '/tmp/ana', 'hola', 1, 1);
      INSERT INTO agents (id, name, provider, workspace, created_at, updated_at) VALUES ('a2', 'Beto', 'demo', '/tmp/beto', 2, 2);
      INSERT INTO messages (id, agent_id, role, text, status, created_at, updated_at) VALUES ('m1', 'a1', 'assistant', 'Hola', 'completed', 5, 5);
    `);
    old.close();
    const store = new Store(path);
    try {
      const agent = store.getAgent("a1");
      assert.equal(agent?.name, "Ana");
      assert.equal(agent?.preview, "hola");
      assert.equal(agent?.project, "");
      assert.equal(agent?.readAt, 0);
      assert.equal(agent?.lastAt, 5);
      assert.deepEqual(
        store.listAgents().map((item) => item.avatar),
        [0, 1],
        "avatares distintos por orden de creación",
      );
      const carla = store.createAgent({
        name: "Carla",
        role: "",
        instructions: "",
        provider: "demo",
        model: null,
        effort: null,
        access: "carpeta",
        workspace: "/tmp/carla",
      });
      assert.equal(carla.avatar, 2);
      assert.equal(store.getMessage("m1")?.payload, null);
      assert.equal(store.getMeta("schema_version"), "3");
      assert.deepEqual(store.listRoutines(), []);
    } finally {
      store.close();
    }
  } finally {
    temp.cleanup();
  }
});
