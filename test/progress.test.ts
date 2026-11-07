import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../src/db.js";
import { PROGRESS_META, TEAM_PROGRESS_META } from "../src/service.js";
import type { MessageRecord } from "../src/db.js";
import { checklistPercent, checklistStep, parseChecklistArgs, parseReportProgressArgs, TEAM_DYNAMIC_TOOLS } from "../src/team.js";
import { createHarness, type Harness, tempDir, waitFor } from "./helpers.js";

async function talk(h: Harness, agentId: string, text: string): Promise<void> {
  const { message } = h.service.sendUserMessage(agentId, text);
  await waitFor(() => h.store.getMessage(message.id)?.status === "completed", 8_000, `respuesta a ${text}`);
  await waitFor(() => h.service.getAgent(agentId).state === "idle", 8_000, "libre");
}

test("report_progress (de antes de la 0.9.13): ya no se ofrece, pero un hilo viejo la puede pedir y acota el porcentaje", () => {
  assert.ok(!TEAM_DYNAMIC_TOOLS.tools.some((tool) => (tool.name as string) === "report_progress"));
  assert.deepEqual(parseReportProgressArgs({ percent: 140, step: "  armando   el índice " }), { percent: 100, step: "armando el índice" });
  assert.deepEqual(parseReportProgressArgs({ percent: "45 %" }), { percent: 45, step: "" });
  assert.equal(parseReportProgressArgs({ percent: -3 }).percent, 0);
  assert.throws(() => parseReportProgressArgs({ percent: "mucho" }), /0 a 100/);
});

test("el agente informa su avance: se ve en su ficha, en list_agents, sobrevive al reinicio y vuelve a cero con un encargo nuevo", async () => {
  const temp = tempDir();
  let h = await createHarness({ dir: temp.path, keepDir: true });
  try {
    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    assert.equal(h.service.getAgent(ana.id).progress, null);
    await talk(h, ana.id, "/avance 40 escribiendo el borrador");
    const progress = h.service.getAgent(ana.id).progress;
    assert.equal(progress?.percent, 40);
    assert.equal(progress?.step, "escribiendo el borrador");
    assert.ok(h.events.some((event) => event.type === "agents" && event.agents.some((agent) => agent.id === ana.id && agent.progress?.percent === 40)));

    // Otro agente ve el avance en list_agents.
    const beto = h.service.createAgent({ name: "Beto", provider: "demo" });
    await talk(h, beto.id, "/equipo");
    const reply = h.service.listMessages(beto.id).filter((item) => item.role === "assistant").at(-1)?.text ?? "";
    assert.match(reply, /40 % · escribiendo el borrador/);

    // Un mensaje nuevo a mitad de tarea no la reinicia.
    await talk(h, ana.id, "¿cómo vas?");
    assert.equal(h.service.getAgent(ana.id).progress?.percent, 40);
    await talk(h, ana.id, "/avance 100 entregado");
    assert.equal(h.service.getAgent(ana.id).progress?.percent, 100);
    await h.close();

    const saved = new Store(join(temp.path, "closedbot.db"));
    assert.match(saved.getMeta(PROGRESS_META) ?? "", /"percent":100/);
    saved.close();
    h = await createHarness({ dir: temp.path, keepDir: true });
    assert.equal(h.service.getAgent(ana.id).progress?.percent, 100, "sigue después de reiniciar");

    // Terminada la tarea, un encargo nuevo del usuario la deja en cero.
    await talk(h, ana.id, "otra tarea");
    assert.equal(h.service.getAgent(ana.id).progress, null);

    // Al eliminar el agente se borra su avance.
    await talk(h, ana.id, "/avance 10 empezando");
    await h.service.deleteAgent(ana.id);
    assert.doesNotMatch(h.store.getMeta(PROGRESS_META) ?? "", new RegExp(ana.id));
  } finally {
    await h.close();
    temp.cleanup();
  }
});

test("el avance de un equipo cuenta a todo el equipo y no retrocede: quien terminó sigue contando y quien se suma no lo baja", async () => {
  const temp = tempDir();
  let h = await createHarness({ dir: temp.path, keepDir: true });
  try {
    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    const beto = h.service.createAgent({ name: "Beto", provider: "demo" });
    const caro = h.service.createAgent({ name: "Caro", provider: "demo" });
    await talk(h, ana.id, "/avance 100 entregado");
    await talk(h, beto.id, "/avance 20 empezando");
    const team = h.service.createChannel({ name: "Equipo", memberIds: [ana.id, beto.id, caro.id], leadId: ana.id });
    const view = () => h.service.getChannel(team.id).progress;
    const progress = () => view()?.percent ?? null;
    // Sin registro todavía (datos de antes de la 0.9.12): lo que se ve, contando a todo el equipo (Caro, 0).
    assert.equal(progress(), 40);
    assert.equal(view()?.done, false);

    // Caro empieza con 0: ya se contaba, así que no baja (antes saltaba de 60 a 40).
    await talk(h, caro.id, "/avance 0 leyendo");
    assert.equal(progress(), 40);
    assert.ok(h.events.some((event) => event.type === "channels" && event.channels.some((channel) => channel.id === team.id && channel.progress?.percent === 40)));
    // Ana recibe otro encargo fuera del canal: su barra vuelve a cero, pero en el equipo sigue contando su 100.
    await talk(h, ana.id, "otra tarea");
    assert.equal(h.service.getAgent(ana.id).progress, null);
    assert.equal(progress(), 40);
    // Beto vuelve a estimar menos: el equipo no retrocede.
    await talk(h, beto.id, "/avance 10 rehaciendo");
    assert.equal(progress(), 40);
    await talk(h, beto.id, "/avance 90 casi");
    assert.equal(progress(), 63);
    await talk(h, beto.id, "/avance 100 listo");
    await talk(h, caro.id, "/avance 100 listo");
    assert.equal(progress(), 100);
    assert.equal(view()?.done, true);

    // Terminado el trabajo (y nadie trabajando), el próximo informe empieza otro.
    await talk(h, beto.id, "/avance 30 otra cosa");
    assert.equal(progress(), 10);
    assert.equal(view()?.done, false);
    await h.close();
    const saved = new Store(join(temp.path, "closedbot.db"));
    assert.match(saved.getMeta(TEAM_PROGRESS_META) ?? "", new RegExp(`"${team.id}":\\{"percent":10`));
    saved.close();
    h = await createHarness({ dir: temp.path, keepDir: true });
    assert.equal(progress(), 10, "sigue después de reiniciar");
    await talk(h, beto.id, "/avance 5 me equivoqué");
    assert.equal(progress(), 10);

    // Si los que informaron terminaron, el equipo queda «listo» aunque otro no haya informado (la Oficina
    // lo muestra así cuando nadie sigue trabajando).
    const dani = h.service.createAgent({ name: "Dani", provider: "demo" });
    const eli = h.service.createAgent({ name: "Eli", provider: "demo" });
    const pair = h.service.createChannel({ name: "Pareja", memberIds: [dani.id, eli.id], leadId: dani.id });
    await talk(h, dani.id, "/avance 100 hecho");
    assert.deepEqual(
      { percent: h.service.getChannel(pair.id).progress?.percent, done: h.service.getChannel(pair.id).progress?.done },
      { percent: 50, done: true },
    );

    // El encargado ya había terminado y le llega un encargo nuevo del usuario en el canal: el equipo empieza de nuevo.
    await talk(h, ana.id, "/avance 100 entregado");
    h.service.sendChannelMessage(team.id, "Ahora hagan la portada");
    await waitFor(() => progress() === null, 8_000, "el equipo empieza otro trabajo");
    await waitFor(() => h.service.getAgent(ana.id).state === "idle", 8_000, "libre");
    await talk(h, caro.id, "/avance 30 bocetos");
    assert.equal(progress(), 10);
  } finally {
    await h.close();
    temp.cleanup();
  }
});

type ChecklistView = { agentId: string; name: string; title: string; steps: Array<{ text: string; status: string }> };
const listsOf = (message: MessageRecord | undefined): ChecklistView[] => (message?.payload?.lists as ChecklistView[] | undefined) ?? [];

test("update_checklist: está entre las herramientas de todos y acepta la lista como la piden o en texto", () => {
  assert.ok(TEAM_DYNAMIC_TOOLS.tools.some((tool) => tool.name === "update_checklist"));
  const parsed = parseChecklistArgs({
    title: "  Informe  ",
    steps: [
      { text: " Buscar   datos ", status: "done" },
      { text: "Escribir", status: "in_progress" },
      { text: "Revisar", status: "pendiente" },
    ],
  });
  assert.deepEqual(parsed, {
    title: "Informe",
    steps: [
      { text: "Buscar datos", status: "done" },
      { text: "Escribir", status: "in_progress" },
      { text: "Revisar", status: "pending" },
    ],
    newTask: false,
  });
  const text = parseChecklistArgs({ steps: "✓ uno\n✱ dos\n○ tres\n- [x] cuatro", new_task: true });
  assert.deepEqual(
    text.steps.map((step) => `${step.status}:${step.text}`),
    ["done:uno", "in_progress:dos", "pending:tres", "done:cuatro"],
  );
  assert.equal(text.newTask, true);
  assert.equal(checklistPercent(parsed.steps), 33);
  assert.equal(checklistStep(parsed.steps), "Escribir");
  assert.throws(() => parseChecklistArgs({ steps: [] }), /lista de pasos/);
  assert.throws(() => parseChecklistArgs({ steps: Array.from({ length: 21 }, (_, index) => ({ text: `p${index}`, status: "pending" })) }), /hasta 20/);
  assert.throws(() => parseChecklistArgs({ steps: [{ text: "  ", status: "done" }] }), /no tiene texto/);
});

test("la lista de tareas de un agente: una tarjeta en su chat que se actualiza en su lugar y da su avance; una terminada deja paso a otra", async () => {
  const h = await createHarness();
  try {
    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    const cards = () => h.service.listMessages(ana.id).filter((message) => message.role === "checklist");
    await talk(h, ana.id, "/lista Informe | ✱ Buscar datos | ○ Escribir | ○ Revisar");
    assert.equal(cards().length, 1);
    assert.deepEqual(
      listsOf(cards()[0])[0]?.steps.map((step) => step.status),
      ["in_progress", "pending", "pending"],
    );
    assert.deepEqual(h.service.getAgent(ana.id).progress && { percent: h.service.getAgent(ana.id).progress?.percent, step: h.service.getAgent(ana.id).progress?.step }, {
      percent: 0,
      step: "Buscar datos",
    });

    await talk(h, ana.id, "/lista Informe | ✓ Buscar datos | ✱ Escribir | ○ Revisar");
    assert.equal(cards().length, 1, "se actualiza la misma tarjeta");
    assert.equal(cards()[0]?.text, "Informe\n✓ Buscar datos\n✱ Escribir\n○ Revisar");
    assert.equal(h.service.getAgent(ana.id).progress?.percent, 33);
    const id = cards()[0]?.id;
    assert.ok(h.events.some((event) => event.type === "message" && event.message.id === id && listsOf(event.message)[0]?.steps[1]?.status === "in_progress"));

    await talk(h, ana.id, "/lista Informe | ✓ Buscar datos | ✓ Escribir | ✓ Revisar");
    assert.equal(cards().length, 1);
    assert.equal(h.service.getAgent(ana.id).progress?.percent, 100);
    // La misma lista terminada otra vez no abre otra tarjeta; la de otra tarea, sí.
    await talk(h, ana.id, "/lista Informe | ✓ Buscar datos | ✓ Escribir | ✓ Revisar");
    assert.equal(cards().length, 1);
    await talk(h, ana.id, "/lista Correo | ✱ Redactar | ○ Enviar");
    assert.equal(cards().length, 2);
    // A mitad de una tarea, «new_task» deja la anterior como estaba.
    await talk(h, ana.id, "/lista-nueva Llamada | ✱ Marcar");
    assert.equal(cards().length, 3);
    assert.equal(listsOf(cards()[1])[0]?.title, "Correo");
    assert.equal(listsOf(cards()[2])[0]?.title, "Llamada");
  } finally {
    await h.close();
  }
});

test("la lista de tareas de un equipo: en su canal, una sola tarjeta junta las de todos (en el orden del equipo)", async () => {
  const h = await createHarness();
  try {
    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    const beto = h.service.createAgent({ name: "Beto", provider: "demo" });
    const channel = h.service.createChannel({ name: "Equipo", memberIds: [ana.id, beto.id], leadId: ana.id });
    const cards = () => h.service.listChannelMessages(channel.id).filter((message) => message.role === "checklist");
    const idle = () => [ana.id, beto.id].every((id) => h.service.getAgent(id).state === "idle");
    // Beto informa primero; en la tarjeta va después de Ana, que es la primera del equipo.
    h.service.sendChannelMessage(channel.id, "/encargar Beto: /lista Datos | ✱ Buscar\n/lista Plan | ✓ Repartir | ✱ Juntar");
    await waitFor(() => listsOf(cards()[0]).length === 2 && idle(), 8_000, "las dos listas en la tarjeta del equipo");
    assert.equal(cards().length, 1);
    assert.deepEqual(
      listsOf(cards()[0]).map((list) => `${list.name}:${list.title}`),
      ["Ana:Plan", "Beto:Datos"],
    );
    assert.match(cards()[0]?.text ?? "", /^Tareas del equipo «Equipo»\n\nAna · Plan\n✓ Repartir\n✱ Juntar\n\nBeto · Datos\n✱ Buscar$/);
    assert.equal(h.service.listMessages(ana.id).filter((message) => message.role === "checklist").length, 0, "no va al chat privado");

    // Terminan los dos: la tarjeta queda como estaba y el trabajo siguiente abre otra.
    h.service.sendChannelMessage(channel.id, "/encargar Beto: /lista Datos | ✓ Buscar\n/lista Plan | ✓ Repartir | ✓ Juntar");
    await waitFor(() => listsOf(cards()[0]).every((list) => list.steps.every((step) => step.status === "done")) && idle(), 8_000, "todo hecho");
    assert.equal(cards().length, 1);
    assert.equal(h.service.getChannel(channel.id).progress?.percent, 100);
    h.service.sendChannelMessage(channel.id, "/lista Portada | ✱ Bocetos");
    await waitFor(() => cards().length === 2 && idle(), 8_000, "otra tarjeta para el trabajo nuevo");
    assert.deepEqual(
      listsOf(cards()[1]).map((list) => list.title),
      ["Portada"],
    );
  } finally {
    await h.close();
  }
});
