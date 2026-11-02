import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import type { MessageRecord } from "../src/db.js";
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
