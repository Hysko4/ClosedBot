import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { AVATAR_CUSTOM_BASE, type MessageRecord } from "../src/db.js";
import { NEW_THREAD_NOTICE } from "../src/service.js";
import { createHarness, tempDir, waitFor } from "./helpers.js";

const assistantTexts = (messages: MessageRecord[]) => messages.filter((message) => message.role === "assistant").map((message) => message.text);

test("un mensaje del usuario se transmite y se completa", async () => {
  const h = await createHarness();
  try {
    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    assert.ok(existsSync(ana.workspace), "crea la carpeta del agente");
    const { message } = h.service.sendUserMessage(ana.id, "Hola equipo");
    await waitFor(() => h.store.getMessage(message.id)?.status === "completed", 5_000, "mensaje completado");
    const messages = h.service.listMessages(ana.id);
    const reply = assistantTexts(messages)[0] ?? "";
    assert.match(reply, /recibí «Hola equipo»/);
    assert.ok(h.events.some((event) => event.type === "delta"), "emite deltas en vivo");
    assert.equal(h.service.getAgent(ana.id).state, "idle");
    assert.ok(h.service.getAgent(ana.id).threadId, "guarda el hilo para reanudar");
  } finally {
    await h.close();
  }
});

test("los mensajes se atienden en cola, uno por vez y en orden", async () => {
  const h = await createHarness();
  try {
    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    const sent = ["uno", "dos", "tres"].map((text) => h.service.sendUserMessage(ana.id, text).message);
    await waitFor(() => sent.every((message) => h.store.getMessage(message.id)?.status === "completed"), 5_000, "cola vacía");
    const replies = assistantTexts(h.service.listMessages(ana.id));
    assert.equal(replies.length, 3);
    assert.match(replies[0] ?? "", /«uno»/);
    assert.match(replies[2] ?? "", /«tres»/);
  } finally {
    await h.close();
  }
});

test("un agente le escribe a otro y recibe su respuesta automáticamente", async () => {
  const h = await createHarness();
  try {
    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    const beto = h.service.createAgent({ name: "Beto", provider: "demo" });
    h.service.sendUserMessage(ana.id, "@Beto: revisa el informe");
    // Beto recibe el mensaje de Ana, contesta, y su respuesta vuelve a Ana.
    await waitFor(
      () => h.service.listMessages(ana.id).some((message) => message.role === "teammate" && message.fromAgentId === beto.id && message.status === "completed"),
      5_000,
      "respuesta de Beto en Ana",
    );
    const betoMessages = h.service.listMessages(beto.id);
    const incoming = betoMessages.find((message) => message.role === "teammate");
    assert.equal(incoming?.fromAgentId, ana.id);
    assert.equal(incoming?.text, "revisa el informe");
    const anaMessages = h.service.listMessages(ana.id);
    const outgoing = anaMessages.find((message) => message.role === "notice" && message.toAgentIds.includes(beto.id));
    assert.ok(outgoing, "Ana ve el mensaje enviado");
    const reply = anaMessages.find((message) => message.role === "teammate" && message.fromAgentId === beto.id);
    assert.equal(reply?.replyTo, incoming?.id, "la respuesta apunta al mensaje original");
    await waitFor(() => h.service.listAgents().every((agent) => agent.state === "idle"), 5_000, "todos libres");
  } finally {
    await h.close();
  }
});

test("el límite de reenvíos corta bucles entre agentes", async () => {
  const h = await createHarness({ maxHops: 1 });
  try {
    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    const beto = h.service.createAgent({ name: "Beto", provider: "demo" });
    h.service.sendUserMessage(ana.id, "@Beto: @Ana: ping");
    await waitFor(
      () => assistantTexts(h.service.listMessages(beto.id)).some((text) => /No pude escribirle a Ana: .*límite de 1/.test(text)),
      5_000,
      "Beto choca con el límite",
    );
    await waitFor(() => h.service.listAgents().every((agent) => agent.state === "idle"), 5_000, "todos libres");
  } finally {
    await h.close();
  }
});

test("un destinatario inexistente devuelve un error claro a la herramienta", async () => {
  const h = await createHarness();
  try {
    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    const { message } = h.service.sendUserMessage(ana.id, "@Nadie: hola");
    await waitFor(() => h.store.getMessage(message.id)?.status === "completed", 5_000, "turno terminado");
    assert.match(assistantTexts(h.service.listMessages(ana.id))[0] ?? "", /No existe el agente «Nadie»/);
  } finally {
    await h.close();
  }
});

test("cancelar en cola, pausar y detener", async () => {
  const h = await createHarness();
  try {
    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    h.service.setPaused(ana.id, true);
    const first = h.service.sendUserMessage(ana.id, "/lento uno dos tres cuatro cinco seis siete ocho");
    const second = h.service.sendUserMessage(ana.id, "segundo");
    assert.equal(h.service.getAgent(ana.id).state, "paused");
    h.service.cancelQueued(ana.id, second.delivery.id);
    assert.equal(h.store.getMessage(second.message.id)?.status, "cancelled");
    h.service.setPaused(ana.id, false);
    await waitFor(() => h.service.getAgent(ana.id).state === "working", 2_000, "empieza a trabajar");
    await waitFor(() => h.events.some((event) => event.type === "delta" && event.agentId === ana.id), 2_000, "primer delta");
    assert.equal(await h.service.interrupt(ana.id), true);
    await waitFor(() => h.store.getMessage(first.message.id)?.status === "interrupted", 3_000, "turno interrumpido");
    assert.equal(h.service.getAgent(ana.id).state, "idle");
  } finally {
    await h.close();
  }
});

test("eliminar a un agente que trabaja: sin «stop» se niega; con «stop» detiene su turno y no sigue su cola", async () => {
  const h = await createHarness();
  try {
    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    const beto = h.service.createAgent({ name: "Beto", provider: "demo" });
    const first = h.service.sendUserMessage(ana.id, "/lento uno dos tres cuatro cinco seis siete ocho");
    h.service.sendUserMessage(ana.id, "segundo");
    await waitFor(() => h.events.some((event) => event.type === "delta" && event.agentId === ana.id), 3_000, "primer delta");
    await assert.rejects(h.service.deleteAgent(ana.id), /Detén el turno/);
    await h.service.deleteAgent(ana.id, { stop: true });
    assert.deepEqual(
      h.service.listAgents().map((agent) => agent.id),
      [beto.id],
    );
    assert.equal(h.store.getMessage(first.message.id), null);
    // Nada de su cola arranca después: no hay turnos de un agente que ya no existe.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(h.service.getAgent(beto.id).state, "idle");
    await assert.rejects(h.service.deleteAgent(ana.id, { stop: true }), /no encontrado|No existe/i);
  } finally {
    await h.close();
  }
});

test("tras un reinicio, lo que quedó a medias se marca y la cola sigue", async () => {
  const temp = tempDir();
  try {
    const first = await createHarness({ dir: temp.path, keepDir: true });
    const ana = first.service.createAgent({ name: "Ana", provider: "demo" });
    first.service.setPaused(ana.id, true);
    const pending = first.service.sendUserMessage(ana.id, "pendiente");
    // Simula un turno que estaba en curso cuando se apagó la app.
    first.store.updateDelivery(pending.delivery.id, { status: "running" });
    const queued = first.service.sendUserMessage(ana.id, "en cola");
    first.service.setPaused(ana.id, false);
    await first.close();

    const second = await createHarness({ dir: temp.path, keepDir: true });
    try {
      assert.equal(second.store.getDelivery(pending.delivery.id)?.status, "interrupted");
      await waitFor(() => second.store.getMessage(queued.message.id)?.status === "completed", 5_000, "atiende la cola");
      assert.ok(second.service.listMessages(ana.id).some((message) => message.role === "notice" && /se reinició/.test(message.text)));
    } finally {
      await second.close();
    }
  } finally {
    temp.cleanup();
  }
});

test("cambiar de proveedor reinicia la conversación y valida nombres", async () => {
  const h = await createHarness();
  try {
    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    const { message } = h.service.sendUserMessage(ana.id, "hola");
    await waitFor(() => h.store.getMessage(message.id)?.status === "completed", 5_000, "turno");
    const updated = h.service.updateAgent(ana.id, { provider: "claude" });
    assert.equal(updated.threadId, null);
    assert.equal(updated.provider, "claude");
    assert.throws(() => h.service.createAgent({ name: "ana", provider: "demo" }), /Ya existe/);
    assert.throws(() => h.service.createAgent({ name: "  ", provider: "demo" }), /nombre/);
    const reset = await h.service.resetConversation(ana.id);
    assert.equal(reset.preview, "");
    assert.equal(h.service.listMessages(ana.id).length, 0);
    await h.service.deleteAgent(ana.id);
    assert.equal(h.service.listAgents().length, 0);
  } finally {
    await h.close();
  }
});

test("menú del agente: «Nuevo hilo» empieza otra conversación sin borrar el historial", async () => {
  const h = await createHarness();
  try {
    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    const { message } = h.service.sendUserMessage(ana.id, "hola");
    await waitFor(() => h.store.getMessage(message.id)?.status === "completed", 5_000, "turno");
    const first = h.service.getAgent(ana.id).threadId;
    assert.ok(first);
    assert.equal((await h.service.newThread(ana.id)).threadId, null);
    const messages = h.service.listMessages(ana.id);
    assert.ok(messages.some((item) => item.role === "assistant"), "el historial sigue a la vista");
    assert.equal(messages.at(-1)?.text, NEW_THREAD_NOTICE);
    await h.service.newThread(ana.id);
    assert.equal(h.service.listMessages(ana.id).filter((item) => item.text === NEW_THREAD_NOTICE).length, 1, "dos veces seguidas: un solo aviso");
    const again = h.service.sendUserMessage(ana.id, "otra vez");
    await waitFor(() => h.store.getMessage(again.message.id)?.status === "completed", 5_000, "turno del hilo nuevo");
    const second = h.service.getAgent(ana.id).threadId;
    assert.ok(second && second !== first, "otro hilo");
  } finally {
    await h.close();
  }
});

test("menú del agente: «Duplicar agente» copia lo que sabe y sus reglas, no su historial ni sus rutinas", async () => {
  const h = await createHarness({ mainAgent: true });
  try {
    const ana = h.service.createAgent({
      name: "Ana",
      provider: "demo",
      role: "Diseñadora",
      description: "Hace los niveles.",
      instructions: "Usa pixel art de 16x16.",
      model: "demo",
      effort: "high",
      access: "total",
      project: "Juegos",
      avatar: AVATAR_CUSTOM_BASE + 205,
      notify: "needs",
    });
    h.service.createMemory(ana.id, { text: "El juego se llama 4FTER.", always: true });
    h.service.createMemory(ana.id, { text: "Prefiere colores fríos." });
    const kept = h.service.createSkill(ana.id, { name: "Paleta", description: "Elige colores", body: "1. Mira la referencia." });
    const off = h.service.createSkill(ana.id, { name: "Exportar", description: "Exporta sprites", body: "1. Exporta." });
    h.service.setSkillEnabled(ana.id, off.id, false);
    // Un enlace dentro de una habilidad no se copia (podría apuntar fuera de su carpeta).
    symlinkSync(ana.workspace, join(ana.workspace, kept.id, "atajo"));
    h.service.createRoutine(ana.id, { name: "Diario", prompt: "Revisa", times: ["09:00"] });
    const { message } = h.service.sendUserMessage(ana.id, "hola");
    await waitFor(() => h.store.getMessage(message.id)?.status === "completed", 5_000, "turno");
    // Lo que el agente escribió en su AGENTS.md también se copia.
    writeFileSync(join(ana.workspace, "AGENTS.md"), "Usa pixel art de 32x32.");
    mkdirSync(join(ana.workspace, "niveles"));
    writeFileSync(join(ana.workspace, "niveles", "uno.txt"), "nivel");

    const copy = h.service.duplicateAgent(ana.id);
    assert.equal(copy.name, "Ana (copia)");
    assert.deepEqual(
      [copy.role, copy.description, copy.instructions, copy.provider, copy.model, copy.effort, copy.access, copy.project, copy.avatar, copy.notify],
      ["Diseñadora", "Hace los niveles.", "Usa pixel art de 32x32.", "demo", "demo", "high", "total", "Juegos", AVATAR_CUSTOM_BASE + 205, "needs"],
    );
    assert.notEqual(copy.workspace, ana.workspace);
    assert.deepEqual(h.service.listMemories(copy.id).map((memory) => [memory.text, memory.always]), [
      ["El juego se llama 4FTER.", true],
      ["Prefiere colores fríos.", false],
    ]);
    assert.deepEqual(h.service.listSkills(copy.id).map((skill) => [skill.name, skill.enabled]), [
      ["Exportar", false],
      ["Paleta", true],
    ]);
    assert.ok(!existsSync(join(copy.workspace, kept.id, "atajo")), "sin enlaces");
    assert.ok(lstatSync(join(ana.workspace, kept.id, "atajo")).isSymbolicLink(), "el original no se toca");
    assert.ok(!existsSync(join(copy.workspace, "niveles")), "sus archivos no se copian");
    assert.equal(h.service.listMessages(copy.id).length, 0, "sin historial");
    assert.equal(h.service.listRoutines(copy.id).length, 0, "sin rutinas");
    assert.equal(h.service.listRoutines(ana.id).length, 1);
    // La copia de una copia: «(copia 2)», no «(copia) (copia)».
    assert.equal(h.service.duplicateAgent(copy.id).name, "Ana (copia 2)");
    const main = h.service.listAgents().find((agent) => agent.main);
    assert.ok(main);
    assert.throws(() => h.service.duplicateAgent(main.id), /no se duplica/);
  } finally {
    await h.close();
  }
});
