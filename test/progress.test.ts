import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../src/db.js";
import { PROGRESS_META } from "../src/service.js";
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
