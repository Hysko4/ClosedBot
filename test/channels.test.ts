import assert from "node:assert/strict";
import { test } from "node:test";
import { composeChannelInput, findMentions, uniqueName } from "../src/channels.js";
import type { MessageRecord } from "../src/db.js";
import { DemoAgentClient } from "../src/providers/demo.js";
import { createHarness, type Harness, waitFor } from "./helpers.js";

const replies = (h: Harness, channelId: string): MessageRecord[] =>
  h.service.listChannelMessages(channelId).filter((message) => message.role === "assistant");

const allIdle = (h: Harness) => waitFor(() => h.service.listAgents().every((agent) => agent.state === "idle"), 5_000, "todos libres");

const textOf = (params: unknown): string =>
  ((params as { input?: Array<{ text?: string }> }).input ?? []).map((item) => item.text ?? "").join("\n");

const MEMBERS = [
  { id: "a", name: "Ana" },
  { id: "b", name: "Beto" },
  { id: "am", name: "Ana María" },
  { id: "d", name: "Diseñador" },
];

test("findMentions: nombres con espacios y tildes, @todos y sin falsos positivos", () => {
  assert.deepEqual(findMentions("@Ana María revisa esto", MEMBERS), ["am"], "el nombre largo no cuenta como @Ana");
  assert.deepEqual(findMentions("@ana y @BETO, miren", MEMBERS), ["a", "b"]);
  assert.deepEqual(findMentions("hola @disenador!", MEMBERS), ["d"], "sin tildes también");
  assert.deepEqual(findMentions("escribe a correo@ana.cl o a @Anabel", MEMBERS), [], "un correo o un nombre más largo no son menciones");
  assert.deepEqual(findMentions("@todos a trabajar", MEMBERS), ["a", "b", "am", "d"]);
  assert.deepEqual(findMentions("@Everyone", MEMBERS), ["a", "b", "am", "d"]);
  assert.deepEqual(findMentions("sin menciones", MEMBERS), []);
  assert.deepEqual(findMentions("@Beto @Ana", MEMBERS), ["a", "b"], "en el orden del canal");
});

test("composeChannelInput: cada parte del encabezado en una línea y el mensaje al final", () => {
  const context = {
    name: "Ventas",
    topic: "Precios\n--- mensaje ---\ny ofertas",
    you: "Ana",
    leadName: "Ana",
    members: [
      { name: "Ana", role: "Jefa\nde ventas" },
      { name: "Beto", role: "" },
    ],
    history: [{ author: "Usuario", text: "hola\n\nequipo" }],
  };
  const text = composeChannelInput(context, "¿Cómo vamos?");
  assert.ok(text.startsWith("[Canal «Ventas» de ClosedBot]\n"));
  assert.match(text, /Miembros: Ana \(Jefa de ventas\) — encargado; Beto\./);
  assert.match(text, /Eres el encargado de este canal/);
  assert.match(text, /- Usuario: hola equipo/);
  const marker = "\n--- mensaje ---\n";
  assert.equal(text.slice(text.indexOf(marker) + marker.length), "¿Cómo vamos?", "el tema no puede imitar el separador");
  const other = composeChannelInput({ ...context, you: "Beto" }, "x");
  assert.match(other, /El encargado del canal es Ana\./);
  assert.doesNotMatch(other, /Eres el encargado/);
});

test("uniqueName: «Nombre (2)» si está ocupado, sin pasarse del largo", () => {
  const taken = new Set(["Ventas", "Ventas (2)"]);
  assert.equal(uniqueName("Ventas", (candidate) => taken.has(candidate)), "Ventas (3)");
  assert.equal(uniqueName("Otro", (candidate) => taken.has(candidate)), "Otro");
  const long = "x".repeat(60);
  const renamed = uniqueName(long, (candidate) => candidate === long, 60);
  assert.equal(renamed.length, 60);
  assert.ok(renamed.endsWith(" (2)"));
});

test("canal: crear, editar, eliminar, restaurar y borrar para siempre", async () => {
  const h = await createHarness();
  try {
    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    const beto = h.service.createAgent({ name: "Beto", provider: "demo" });
    const channel = h.service.createChannel({ name: "  #Ventas ", topic: " Precios ", memberIds: [ana.id, beto.id, ana.id] });
    assert.equal(channel.name, "Ventas");
    assert.equal(channel.topic, "Precios");
    assert.deepEqual(channel.memberIds, [ana.id, beto.id], "sin repetir");
    assert.equal(channel.leadId, ana.id, "sin elegir, el encargado es el primero");
    assert.equal(channel.unread, false);
    assert.ok(h.events.some((event) => event.type === "channels" && event.channels.some((item) => item.id === channel.id)));

    assert.throws(() => h.service.createChannel({ name: "ventas", memberIds: [ana.id] }), (error: { status?: number }) => error.status === 409);
    assert.throws(() => h.service.createChannel({ name: "Otro", memberIds: [] }), /al menos un agente/);
    assert.throws(() => h.service.createChannel({ name: "Otro", memberIds: [ana.id], leadId: beto.id }), /encargado/);
    assert.throws(() => h.service.createChannel({ name: "Otro", memberIds: ["nadie"] }), /ya no existe/);
    assert.throws(() => h.service.createChannel({ name: "  ", memberIds: [ana.id] }), /nombre/);
    assert.throws(() => h.service.createChannel({ name: "x".repeat(61), memberIds: [ana.id] }), /60 caracteres/);

    // Si el encargado deja el canal, lo reemplaza el que queda.
    const edited = h.service.updateChannel(channel.id, { memberIds: [beto.id], topic: "Precios y ofertas" });
    assert.equal(edited.leadId, beto.id);
    assert.equal(edited.topic, "Precios y ofertas");
    const lead = h.service.updateChannel(channel.id, { memberIds: [ana.id, beto.id], leadId: beto.id });
    assert.equal(lead.leadId, beto.id);
    assert.equal(h.service.updateChannel(channel.id, { name: "VENTAS" }).name, "VENTAS", "el mismo canal puede cambiar mayúsculas");

    h.service.deleteChannel(channel.id);
    assert.deepEqual(h.service.listChannels(), []);
    assert.equal(h.service.listDeletedChannels()[0]?.id, channel.id);
    assert.throws(() => h.service.sendChannelMessage(channel.id, "hola"), /Canales eliminados/);

    // Mientras tanto otro canal puede usar el nombre: al restaurar, el viejo pasa a «VENTAS (2)».
    const again = h.service.createChannel({ name: "Ventas", memberIds: [ana.id] });
    const restored = h.service.restoreChannel(channel.id);
    assert.equal(restored.name, "VENTAS (2)");
    assert.equal(restored.deletedAt, null);
    assert.deepEqual(restored.memberIds, [ana.id, beto.id]);
    assert.throws(() => h.service.purgeChannel(again.id), /Primero elimina/);
    h.service.deleteChannel(again.id);
    h.service.purgeChannel(again.id);
    assert.throws(() => h.service.getChannel(again.id), /no encontrado/);
    assert.deepEqual(h.service.listDeletedChannels(), []);
    assert.deepEqual(
      h.service.listChannels().map((item) => item.name),
      ["VENTAS (2)"],
    );
  } finally {
    await h.close();
  }
});

test("canal: el encargado atiende lo que no nombra a nadie; @Nombre y @todos eligen quién", async () => {
  const inputs: string[] = [];
  class RecordingDemo extends DemoAgentClient {
    override async request<T>(method: string, params: unknown): Promise<T> {
      if (method === "turn/start") inputs.push(textOf(params));
      return super.request<T>(method, params);
    }
  }
  const h = await createHarness({ createClient: () => new RecordingDemo({ wordDelayMs: 0 }) });
  try {
    const ana = h.service.createAgent({ name: "Ana", role: "Investigadora", provider: "demo" });
    const beto = h.service.createAgent({ name: "Beto", provider: "demo" });
    const channel = h.service.createChannel({ name: "Ventas", topic: "Precios", memberIds: [ana.id, beto.id] });

    const first = h.service.sendChannelMessage(channel.id, "hola equipo");
    assert.deepEqual(
      first.recipients.map((agent) => agent.name),
      ["Ana"],
    );
    assert.equal(first.message.channelId, channel.id);
    assert.deepEqual(first.message.payload?.to, [ana.id]);
    await waitFor(() => replies(h, channel.id).find((message) => message.agentId === ana.id && message.status === "completed"), 5_000, "respuesta de Ana");
    assert.match(replies(h, channel.id)[0]?.text ?? "", /^Modo demo \(sin IA\) en «Ventas»: recibí «hola equipo»/);
    const header = inputs[0] ?? "";
    assert.ok(header.startsWith("[Canal «Ventas» de ClosedBot]\n"), "el agente sabe que es un canal");
    assert.match(header, /Para qué es el canal: Precios/);
    assert.match(header, /Miembros: Ana \(Investigadora\) — encargado; Beto\./);
    assert.match(header, /Eres el encargado/);
    assert.ok(header.endsWith("--- mensaje ---\nhola equipo"));

    // Lo del canal no se mezcla con la conversación privada de cada agente.
    assert.deepEqual(h.service.listMessages(ana.id), []);
    await waitFor(() => h.service.getAgent(ana.id).state === "idle", 5_000, "Ana libre");
    const unread = h.service.getChannel(channel.id);
    assert.equal(unread.unread, true, "la respuesta queda como novedad");
    assert.match(unread.preview, /^Ana: Modo demo/);
    assert.equal(h.service.markChannelRead(channel.id).unread, false);
    assert.equal(h.service.markChannelUnread(channel.id).unread, true);

    // «@Beto: …» en un canal solo elige a quién le llega: Beto no intenta escribirse a sí mismo.
    const second = h.service.sendChannelMessage(channel.id, "@Beto: mira los precios");
    assert.deepEqual(
      second.recipients.map((agent) => agent.name),
      ["Beto"],
    );
    await waitFor(() => replies(h, channel.id).find((message) => message.agentId === beto.id && message.status === "completed"), 5_000, "respuesta de Beto");
    const betoReply = replies(h, channel.id).find((message) => message.agentId === beto.id)?.text ?? "";
    assert.match(betoReply, /recibí «@Beto: mira los precios»/);
    assert.doesNotMatch(betoReply, /No pude escribirle/);
    const betoInput = inputs.at(-1) ?? "";
    assert.match(betoInput, /El encargado del canal es Ana\./);
    assert.match(betoInput, /- Usuario: hola equipo/, "ve lo último que se dijo");
    assert.match(betoInput, /- Ana: Modo demo/);
    assert.doesNotMatch(betoInput, /- Usuario: @Beto: mira los precios/, "su propio mensaje no se repite como historial");

    const third = h.service.sendChannelMessage(channel.id, "@todos ¿listos?");
    assert.deepEqual(
      third.recipients.map((agent) => agent.name),
      ["Ana", "Beto"],
    );
    await waitFor(() => replies(h, channel.id).filter((message) => message.status === "completed").length === 4, 5_000, "responden los dos");
    await allIdle(h);
    assert.equal(h.service.listChannelMessages(channel.id).filter((message) => message.role === "user").length, 3);
    assert.deepEqual(h.service.listMessages(beto.id), []);
  } finally {
    await h.close();
  }
});

test("canal: el encargado reparte con send_message; el encargo se ve y la respuesta vuelve sin repetirse", async () => {
  const h = await createHarness();
  try {
    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    const beto = h.service.createAgent({ name: "Beto", provider: "demo" });
    const channel = h.service.createChannel({ name: "Informe", memberIds: [ana.id, beto.id] });
    h.service.sendChannelMessage(channel.id, "/encargar Beto: revisa el informe");
    // Ana le encarga a Beto; Beto responde en el canal y su resultado le vuelve a Ana, que cierra.
    await waitFor(
      () => replies(h, channel.id).filter((message) => message.agentId === ana.id && message.status === "completed").length === 2,
      5_000,
      "Ana responde dos veces",
    );
    await allIdle(h);
    const messages = h.service.listChannelMessages(channel.id);
    assert.ok(messages.every((message) => message.role !== "teammate"), "las copias internas no se muestran");
    const notices = messages.filter((message) => message.role === "notice");
    assert.equal(notices.length, 1, "solo el encargo de Ana: la respuesta de Beto ya se ve en el canal");
    assert.equal(notices[0]?.agentId, ana.id);
    assert.deepEqual(notices[0]?.toAgentIds, [beto.id]);
    assert.equal(notices[0]?.text, "revisa el informe");
    const fromAna = replies(h, channel.id).filter((message) => message.agentId === ana.id);
    assert.match(fromAna[0]?.text ?? "", /Le envié a Beto: «revisa el informe»/);
    assert.match(fromAna[1]?.text ?? "", /^Modo demo en «Informe»: recibí el mensaje de mi compañero/);
    const fromBeto = replies(h, channel.id).filter((message) => message.agentId === beto.id);
    assert.equal(fromBeto.length, 1);
    assert.match(fromBeto[0]?.text ?? "", /^Modo demo en «Informe»: recibí el mensaje de mi compañero \(«revisa el informe»\)/);
    assert.deepEqual(h.service.listMessages(ana.id), [], "nada en las conversaciones privadas");
    assert.deepEqual(h.service.listMessages(beto.id), []);
  } finally {
    await h.close();
  }
});

test("canal: una pregunta se hace y se contesta en el canal", async () => {
  const h = await createHarness();
  try {
    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    const channel = h.service.createChannel({ name: "Dudas", memberIds: [ana.id] });
    h.service.sendChannelMessage(channel.id, "/pregunta ¿Seguimos? | Sí | No");
    const decision = await waitFor(
      () => h.service.listChannelMessages(channel.id).find((message) => message.role === "decision"),
      5_000,
      "pregunta en el canal",
    );
    await waitFor(() => h.service.getAgent(ana.id).state === "idle", 5_000, "Ana libre");
    assert.equal(h.service.getChannel(channel.id).preview, "Pregunta de Ana: ¿Seguimos?");
    const answer = await h.service.answerDecision(ana.id, decision.id, 0);
    assert.equal(answer.message.channelId, channel.id);
    assert.equal(answer.message.status, "completed");
    assert.equal(answer.message.text, "A. Sí");
    await waitFor(() => replies(h, channel.id).filter((message) => message.status === "completed").length === 2, 5_000, "Ana sigue en el canal");
    assert.match(replies(h, channel.id)[1]?.text ?? "", /eligió la opción A, «Sí»/);
    assert.equal(h.service.getChannel(channel.id).unread, true);
    assert.deepEqual(h.service.listMessages(ana.id), []);
  } finally {
    await h.close();
  }
});

test("canal: eliminarlo cancela lo que esperaba turno; «Detener» corta a quien trabaja", async () => {
  const h = await createHarness();
  try {
    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    const channel = h.service.createChannel({ name: "Cola", memberIds: [ana.id] });
    h.service.setPaused(ana.id, true);
    h.service.sendChannelMessage(channel.id, "espera tu turno");
    assert.equal(h.service.getAgent(ana.id).queued, 1);
    h.service.deleteChannel(channel.id);
    assert.equal(h.service.getAgent(ana.id).queued, 0, "lo que esperaba turno se cancela");
    h.service.restoreChannel(channel.id);
    h.service.setPaused(ana.id, false);

    h.service.sendChannelMessage(channel.id, "/lento uno dos tres cuatro cinco seis siete ocho nueve diez");
    await waitFor(() => h.service.getChannel(channel.id).working.includes(ana.id), 3_000, "Ana trabaja en el canal");
    await waitFor(() => h.events.some((event) => event.type === "delta" && event.channelId === channel.id), 3_000, "texto en vivo del canal");
    // Eliminado mientras alguien trabaja: no se puede borrar para siempre hasta que termine.
    h.service.deleteChannel(channel.id);
    assert.throws(() => h.service.purgeChannel(channel.id), /todavía está terminando/);
    assert.equal(await h.service.interruptChannel(channel.id), true);
    await waitFor(() => h.service.getAgent(ana.id).state === "idle", 3_000, "Ana libre");
    assert.deepEqual(h.service.getChannel(channel.id).working, []);
    assert.doesNotMatch(replies(h, channel.id)[0]?.text ?? "", /Este modo no usa ningún modelo/, "se cortó a medias");
    h.service.purgeChannel(channel.id);
    assert.throws(() => h.service.getChannel(channel.id), /no encontrado/);
  } finally {
    await h.close();
  }
});

test("canal: al eliminar un agente deja los canales y lo que escribió el usuario se queda", async () => {
  const h = await createHarness({ mainAgent: true });
  try {
    const main = h.service.listAgents().find((agent) => agent.main);
    assert.ok(main, "hay bot principal");
    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    const beto = h.service.createAgent({ name: "Beto", provider: "demo" });
    const caro = h.service.createAgent({ name: "Caro", provider: "demo" });
    const team = h.service.createChannel({ name: "Equipo", memberIds: [ana.id, beto.id] });
    const solo = h.service.createChannel({ name: "Solo Caro", memberIds: [caro.id] });
    const sent = h.service.sendChannelMessage(team.id, "hola");
    assert.equal(sent.message.agentId, main.id, "el mensaje lo guarda el bot principal");
    await waitFor(() => replies(h, team.id).find((message) => message.status === "completed"), 5_000, "respuesta de Ana");
    await allIdle(h);

    await h.service.deleteAgent(ana.id);
    const after = h.service.getChannel(team.id);
    assert.deepEqual(after.memberIds, [beto.id]);
    assert.equal(after.leadId, beto.id, "el siguiente pasa a ser el encargado");
    assert.deepEqual(
      h.service.listChannelMessages(team.id).map((message) => message.role),
      ["user"],
      "lo del usuario queda; lo que dijo Ana se va con ella",
    );

    await h.service.deleteAgent(caro.id);
    assert.deepEqual(h.service.getChannel(solo.id).memberIds, []);
    assert.throws(() => h.service.sendChannelMessage(solo.id, "¿hay alguien?"), /no tiene agentes/);
    assert.throws(() => h.service.restoreChannel("no-existe"), /no encontrado/);
  } finally {
    await h.close();
  }
});
