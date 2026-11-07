import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../src/db.js";
import { PROGRESS_META, TEAM_PROGRESS_META } from "../src/service.js";
import { parseReportProgressArgs, TEAM_DYNAMIC_TOOLS } from "../src/team.js";
import { createHarness, type Harness, tempDir, waitFor } from "./helpers.js";

async function talk(h: Harness, agentId: string, text: string): Promise<void> {
  const { message } = h.service.sendUserMessage(agentId, text);
  await waitFor(() => h.store.getMessage(message.id)?.status === "completed", 8_000, `respuesta a ${text}`);
  await waitFor(() => h.service.getAgent(agentId).state === "idle", 8_000, "libre");
}

test("report_progress: está entre las herramientas de todos y acota el porcentaje", () => {
  assert.ok(TEAM_DYNAMIC_TOOLS.tools.some((tool) => tool.name === "report_progress"));
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
