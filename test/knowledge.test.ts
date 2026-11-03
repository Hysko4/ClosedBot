import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  composeSkill,
  INSTRUCTIONS_MAX,
  listSkills,
  migrateInstructions,
  parseSkill,
  readInstructions,
  skillDir,
  writeInstructions,
} from "../src/agent-files.js";
import { Store } from "../src/db.js";
import { cleanMemory, describeMemories, MEMORY_LIMITS, searchMemories } from "../src/memories.js";
import type { AgentClient } from "../src/providers/client.js";
import { DemoAgentClient } from "../src/providers/demo.js";
import { type AlertEvent, ServiceError } from "../src/service.js";
import { createHarness, type Harness, tempDir, waitFor } from "./helpers.js";

/** Demo que anota lo que recibe cada hilo al abrirse (thread/start y thread/resume). */
function recordingClient(opened: Array<{ method: string; instructions: string }>): () => AgentClient {
  return () => {
    const client = new DemoAgentClient({ wordDelayMs: 0 });
    const request = client.request.bind(client);
    client.request = (async (method: string, params: unknown) => {
      if (method === "thread/start" || method === "thread/resume") {
        opened.push({ method, instructions: String((params as { developerInstructions?: string }).developerInstructions ?? "") });
      }
      return request(method, params);
    }) as AgentClient["request"];
    return client;
  };
}

async function talk(h: Harness, agentId: string, text: string): Promise<string> {
  const { message, delivery } = h.service.sendUserMessage(agentId, text);
  await waitFor(() => {
    const status = h.store.getMessage(message.id)?.status;
    return status === "completed" || status === "failed";
  }, 5_000, `respuesta a «${text.slice(0, 40)}»`);
  return h.service
    .listMessages(agentId)
    .filter((item) => item.role === "assistant" && item.deliveryId === delivery.id)
    .map((item) => item.text)
    .join("\n");
}

const memory = (id: string, text: string, always = false, at = 1) => ({ id, agentId: "a", text, always, createdBy: "user" as const, createdAt: at, updatedAt: at });

test("AGENTS.md: se lee limpio, se guarda entero, vacío se borra y al migrar no pisa uno distinto", () => {
  const temp = tempDir();
  try {
    const dir = join(temp.path, "ana");
    assert.equal(readInstructions(dir), null);
    writeInstructions(dir, "﻿Primero\r\nSegundo\r\n\r\n");
    assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), "Primero\nSegundo\n");
    assert.equal(readInstructions(dir), "Primero\nSegundo");
    writeInstructions(dir, "x".repeat(INSTRUCTIONS_MAX + 50));
    assert.equal(readInstructions(dir)?.length, INSTRUCTIONS_MAX);
    writeInstructions(dir, "   ");
    assert.equal(existsSync(join(dir, "AGENTS.md")), false);

    // Migración: sin archivo, se crea; con uno igual, nada; con uno distinto, se aparta y manda lo guardado.
    assert.equal(migrateInstructions(dir, "Revisa el sitio."), "Revisa el sitio.");
    assert.equal(readInstructions(dir), "Revisa el sitio.");
    writeFileSync(join(dir, "AGENTS.md"), "Notas del proyecto que escribió el agente.");
    assert.equal(migrateInstructions(dir, "Revisa el sitio."), "Revisa el sitio.");
    assert.equal(readFileSync(join(dir, "AGENTS.anterior.md"), "utf8"), "Notas del proyecto que escribió el agente.");
    // Sin instrucciones guardadas, el que ya estaba pasa a ser el suyo.
    const other = join(temp.path, "beto");
    mkdirSync(other);
    writeFileSync(join(other, "AGENTS.md"), "Usa TypeScript.");
    assert.equal(migrateInstructions(other, ""), "Usa TypeScript.");
  } finally {
    temp.cleanup();
  }
});

test("habilidades: encabezado, primer párrafo, orden, repetidas y carpetas fuera de lugar", () => {
  assert.deepEqual(parseSkill('---\nname: "Resumen: del día"\ndescription: >\n  Arma el resumen\n  de la mañana.\n---\n# Pasos\n1. Lee.', "x"), {
    name: "Resumen: del día",
    description: "Arma el resumen de la mañana.",
    body: "# Pasos\n1. Lee.",
  });
  assert.deepEqual(parseSkill("# Facturas\n\nCómo emitir una factura.\n\n1. Abre…", "facturas"), {
    name: "facturas",
    description: "Facturas",
    body: "# Facturas\n\nCómo emitir una factura.\n\n1. Abre…",
  });
  const composed = composeSkill("Correo: respuestas", "Responde correos #urgente", "1. Lee.\r\n2. Responde.");
  assert.deepEqual(parseSkill(composed, "x"), { name: "Correo: respuestas", description: "Responde correos #urgente", body: "1. Lee.\n2. Responde." });

  const temp = tempDir();
  try {
    const ws = join(temp.path, "ana");
    for (const [root, folder, text] of [
      [".agents/skills", "zeta", composeSkill("Zeta", "Última", "Pasos")],
      [".claude/skills", "alfa", composeSkill("Alfa", "Primera", "Pasos")],
      [".claude/skills", "zeta-copia", composeSkill("zeta", "Repetida", "Pasos")],
      [".agents/skills", "sin-archivo", null],
    ] as const) {
      mkdirSync(join(ws, ...root.split("/"), folder), { recursive: true });
      if (text) writeFileSync(join(ws, ...root.split("/"), folder, "SKILL.md"), text);
    }
    assert.deepEqual(
      listSkills(ws).map((skill) => [skill.id, skill.name, skill.description, skill.file]),
      [
        [".claude/skills/alfa", "Alfa", "Primera", ".claude/skills/alfa/SKILL.md"],
        [".agents/skills/zeta", "Zeta", "Última", ".agents/skills/zeta/SKILL.md"],
      ],
    );
    for (const bad of ["../x", ".agents/skills/..", ".agents/skills/.oculta", "otra/zeta", ".agents/skills/a\\b", ".agents/skills"]) {
      assert.throws(() => skillDir(ws, bad), /no es válida/, bad);
    }
    assert.equal(skillDir(ws, ".agents/skills/zeta"), join(ws, ".agents", "skills", "zeta"));
  } finally {
    temp.cleanup();
  }
});

test("recuerdos: limpieza, búsqueda sin tildes y lo que va en las instrucciones", () => {
  assert.equal(cleanMemory("  Prefiere\t respuestas   cortas \r\n\r\n\r\n y en español "), "Prefiere respuestas cortas \n\n y en español");
  assert.throws(() => cleanMemory("   "), /Escribe qué debe recordar/);
  assert.throws(() => cleanMemory("x".repeat(MEMORY_LIMITS.text + 1)), /hasta/);
  const memories = [
    memory("1", "Su cliente principal es Acme y factura los lunes.", false, 1),
    memory("2", "Prefiere las respuestas cortas.", true, 2),
    memory("3", "La programación del sitio usa Astro.", false, 3),
  ];
  assert.deepEqual(searchMemories(memories, "facturación de Acme").map((item) => item.id), ["1"]);
  assert.deepEqual(searchMemories(memories, "programa").map((item) => item.id), ["3"]);
  assert.deepEqual(searchMemories(memories, "que con para"), []);
  assert.equal(
    describeMemories(memories),
    "<recuerdos_siempre>\n- Prefiere las respuestas cortas.\n</recuerdos_siempre>\nAdemás tienes 2 recuerdos que se usan solo si hace falta: búscalos con search_memories cuando el tema pueda tenerlos (preferencias, datos del usuario, decisiones anteriores).",
  );
  assert.equal(describeMemories([]), null);
  // Si los de «siempre» no caben, van los más nuevos y el resto se busca.
  const big = Array.from({ length: 12 }, (_, index) => memory(`b${index}`, `${index} ${"x".repeat(990)}`, true, index));
  const text = describeMemories(big) ?? "";
  assert.equal((text.match(/^- /gm) ?? []).length, 8);
  assert.match(text, /^- 11 /m);
  assert.doesNotMatch(text, /^- 3 /m);
  assert.match(text, /Además tienes 4 recuerdos/);
});

test("instrucciones en AGENTS.md: al crear, al editar desde la ficha, cuando las cambia el agente y con conflicto", async () => {
  const opened: Array<{ method: string; instructions: string }> = [];
  const h = await createHarness({ createClient: recordingClient(opened) });
  try {
    const ana = h.service.createAgent({ name: "Ana", provider: "demo", role: "Investigadora", description: "Busca precios y los compara.", instructions: "Compara precios." });
    assert.equal(readFileSync(join(ana.workspace, "AGENTS.md"), "utf8"), "Compara precios.\n");
    await talk(h, ana.id, "hola");
    const first = opened.at(-1)?.instructions ?? "";
    assert.match(first, /"titulo": "Investigadora"/);
    assert.match(first, /"descripcion": "Busca precios y los compara\."/);
    assert.match(first, /<instrucciones archivo="AGENTS\.md">\nCompara precios\.\n<\/instrucciones>/);

    // Sin cambios, el hilo no se reabre.
    const count = opened.length;
    await talk(h, ana.id, "¿sigues?");
    assert.equal(opened.length, count);

    // El agente edita su archivo: la lista lo ve y su próximo mensaje lo usa.
    writeFileSync(join(ana.workspace, "AGENTS.md"), "Compara precios en pesos chilenos.\r\n");
    assert.equal(h.service.getInstructions(ana.id).text, "Compara precios en pesos chilenos.");
    assert.equal(h.service.getAgent(ana.id).instructions, "Compara precios en pesos chilenos.");
    await talk(h, ana.id, "otra");
    assert.equal(opened.at(-1)?.method, "thread/resume");
    assert.match(opened.at(-1)?.instructions ?? "", /Compara precios en pesos chilenos\./);

    // Desde la ficha: con la versión vieja como base, no se pisa lo que cambió el agente.
    writeFileSync(join(ana.workspace, "AGENTS.md"), "Versión del agente.");
    assert.throws(
      () => h.service.saveInstructions(ana.id, "Versión del usuario.", "Compara precios en pesos chilenos."),
      (error: unknown) => error instanceof ServiceError && error.status === 409,
    );
    h.service.saveInstructions(ana.id, "Versión del usuario.", "Versión del agente.");
    assert.equal(readFileSync(join(ana.workspace, "AGENTS.md"), "utf8"), "Versión del usuario.\n");

    // En la lista solo va el comienzo; las completas, aparte.
    const long = `${"Paso. ".repeat(200)}fin`;
    h.service.updateAgent(ana.id, { instructions: long });
    const view = h.service.getAgent(ana.id);
    assert.equal(view.instructionsLength, long.length);
    assert.ok(view.instructions.length < 410 && view.instructions.endsWith("…"));
    assert.equal(h.service.getInstructions(ana.id).text, long);

    // Un agente nuevo con el nombre de uno eliminado no hereda su carpeta.
    await h.service.deleteAgent(ana.id);
    const again = h.service.createAgent({ name: "Ana", provider: "demo" });
    assert.notEqual(again.workspace, ana.workspace);
    assert.equal(h.service.getInstructions(again.id).text, "");
  } finally {
    await h.close();
  }
});

test("0.7.0: las instrucciones guardadas en la base pasan a AGENTS.md al arrancar, una sola vez", async () => {
  const temp = tempDir();
  try {
    const store = new Store(join(temp.path, "closedbot.db"));
    const workspace = join(temp.path, "agentes", "ana");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "AGENTS.md"), "Archivo viejo del proyecto.");
    store.createAgent({ name: "Ana", role: "", instructions: "Revisa el sitio cada día.", provider: "demo", model: null, effort: null, access: "carpeta", workspace });
    store.close();
    const h = await createHarness({ dir: temp.path, keepDir: true });
    try {
      assert.equal(readFileSync(join(workspace, "AGENTS.md"), "utf8"), "Revisa el sitio cada día.\n");
      assert.equal(readFileSync(join(workspace, "AGENTS.anterior.md"), "utf8"), "Archivo viejo del proyecto.");
      // Ya migrado: borrar el archivo deja al agente sin instrucciones (el archivo manda).
      writeInstructions(workspace, "");
      assert.equal(h.service.getInstructions(h.service.listAgents()[0]?.id ?? "").text, "");
    } finally {
      await h.close();
    }
    const again = await createHarness({ dir: temp.path, keepDir: true });
    try {
      assert.equal(existsSync(join(workspace, "AGENTS.md")), false, "no se vuelve a migrar");
    } finally {
      await again.close();
    }
  } finally {
    temp.cleanup();
  }
});

test("recuerdos: el agente los guarda y busca, los de «siempre» van en sus instrucciones y hay un máximo", async () => {
  const opened: Array<{ method: string; instructions: string }> = [];
  const h = await createHarness({ createClient: recordingClient(opened) });
  try {
    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    const reply = await talk(h, ana.id, "/recuerda siempre Prefiere respuestas cortas\n/recuerda Su cliente es Acme");
    assert.match(reply, /Lo guardé en mis recuerdos \(lo uso siempre\): «Prefiere respuestas cortas»/);
    const saved = h.service.listMemories(ana.id);
    assert.deepEqual(
      saved.map((item) => [item.text, item.always, item.createdBy]),
      [
        ["Prefiere respuestas cortas", true, "agent"],
        ["Su cliente es Acme", false, "agent"],
      ],
    );
    assert.ok(h.service.listMessages(ana.id).some((item) => item.role === "activity" && item.text === "Guardó un recuerdo: «Prefiere respuestas cortas»"));
    assert.ok(h.events.some((event) => event.type === "memories" && event.agentId === ana.id));

    // Su próximo mensaje ya lo trae (se reabre el hilo); el otro lo busca.
    const search = await talk(h, ana.id, "/busca cliente");
    assert.match(opened.at(-1)?.instructions ?? "", /<recuerdos_siempre>\n- Prefiere respuestas cortas\.?\n<\/recuerdos_siempre>\nAdemás tienes 1 recuerdo que se usa solo si hace falta/);
    assert.match(search, /Su cliente es Acme/);

    // Repetido: no se duplica.
    h.service.createMemory(ana.id, { text: "su cliente es acme" });
    assert.equal(h.service.listMemories(ana.id).length, 2);

    // Cada agente ve solo los suyos.
    const beto = h.service.createAgent({ name: "Beto", provider: "demo" });
    assert.equal(h.service.listMemories(beto.id).length, 0);
    const other = h.service.listMemories(ana.id)[0]?.id ?? "";
    const forget = await talk(h, beto.id, `/busca cliente`);
    assert.match(forget, /No encontré recuerdos/);
    assert.ok(other);

    // Desde la ficha: cambiar a «siempre», editar y borrar.
    const [short, client] = h.service.listMemories(ana.id);
    h.service.updateMemory(client?.id ?? "", { always: true, text: "Su cliente principal es Acme." });
    h.service.deleteMemory(short?.id ?? "");
    assert.deepEqual(
      h.service.listMemories(ana.id).map((item) => [item.text, item.always]),
      [["Su cliente principal es Acme.", true]],
    );
    assert.throws(() => h.service.updateMemory(short?.id ?? "", { always: false }), /ya no existe/);

    for (let index = h.service.listMemories(ana.id).length; index < MEMORY_LIMITS.perAgent; index += 1) h.service.createMemory(ana.id, { text: `Dato ${index}` });
    assert.throws(() => h.service.createMemory(ana.id, { text: "Uno más" }), /ya tiene 64 recuerdos/);
    // Se borran con el agente.
    await h.service.deleteAgent(ana.id);
    assert.equal(h.store.countMemories(ana.id), 0);
  } finally {
    await h.close();
  }
});

test("habilidades desde la ficha: crear, apagar (sale de sus instrucciones), editar y eliminar", async () => {
  const opened: Array<{ method: string; instructions: string }> = [];
  const h = await createHarness({ createClient: recordingClient(opened) });
  try {
    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    const skill = h.service.createSkill(ana.id, { name: "Resumen del día", description: "Arma el resumen de la mañana.", body: "1. Lee el correo.\n2. Resume." });
    assert.equal(skill.id, ".agents/skills/resumen-del-dia");
    assert.equal(skill.enabled, true);
    assert.throws(() => h.service.createSkill(ana.id, { name: "resumen del día", body: "x" }), /ya tiene una habilidad/);
    await talk(h, ana.id, "hola");
    assert.match(opened.at(-1)?.instructions ?? "", /- «Resumen del día»: Arma el resumen de la mañana\. \(\.agents\/skills\/resumen-del-dia\/SKILL\.md\)/);

    h.service.setSkillEnabled(ana.id, skill.id, false);
    assert.equal(h.service.listSkills(ana.id)[0]?.enabled, false);
    await talk(h, ana.id, "sigue");
    assert.doesNotMatch(opened.at(-1)?.instructions ?? "", /Resumen del día/);

    const { text } = h.service.getSkill(ana.id, skill.id);
    h.service.saveSkill(ana.id, skill.id, text.replace("Arma el resumen de la mañana.", "Resumen breve."));
    assert.equal(h.service.listSkills(ana.id)[0]?.description, "Resumen breve.");
    assert.throws(() => h.service.saveSkill(ana.id, "../../x", "hola"), /no es válida/);

    h.service.deleteSkill(ana.id, skill.id);
    assert.deepEqual(h.service.listSkills(ana.id), []);
    assert.deepEqual(h.store.getAgent(ana.id)?.skillsOff, []);
    assert.equal(existsSync(join(ana.workspace, ".agents", "skills", "resumen-del-dia")), false);
  } finally {
    await h.close();
  }
});

test("Avisarme: Claude Bot avisa todo y los demás solo cuando necesitan al usuario; con «Nada», nunca", async () => {
  const h = await createHarness({ mainAgent: true });
  try {
    const alerts = () => h.events.filter((event): event is AlertEvent => event.type === "alert");
    const mainId = h.service.mainAgentId() as string;
    assert.equal(h.service.getAgent(mainId).notify, "all");
    await talk(h, mainId, "hola");
    assert.deepEqual(
      alerts().map((alert) => [alert.agentId, alert.kind, alert.title]),
      [[mainId, "reply", "Claude Bot"]],
    );

    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    assert.equal(ana.notify, "needs");
    h.events.length = 0;
    await talk(h, ana.id, "hola");
    assert.deepEqual(alerts(), [], "una respuesta no avisa con «Solo cuando me necesite»");
    await talk(h, ana.id, "/pregunta ¿Seguimos? | Sí | No");
    assert.deepEqual(
      alerts().map((alert) => [alert.kind, alert.body]),
      [["question", "Pregunta: ¿Seguimos?"]],
    );

    h.service.updateAgent(ana.id, { notify: "none" });
    h.events.length = 0;
    await talk(h, ana.id, "/pregunta ¿Otra vez? | Sí | No");
    assert.deepEqual(alerts(), []);
    h.service.updateAgent(ana.id, { notify: "all" });
    await talk(h, ana.id, "chao");
    assert.equal(alerts()[0]?.kind, "reply");
    assert.match(alerts()[0]?.body ?? "", /Modo demo/);
    h.service.updateAgent(ana.id, { notify: null });
    assert.equal(h.service.getAgent(ana.id).notify, "needs");
    assert.throws(() => h.service.updateAgent(ana.id, { notify: "a veces" as never }), /all, needs o none/);
  } finally {
    await h.close();
  }
});

test("rutinas: historial con lo que respondió cada vez, también las que se corren a mano", async () => {
  const h = await createHarness();
  try {
    const ana = h.service.createAgent({ name: "Ana", provider: "demo" });
    const routine = h.service.createRoutine(ana.id, { name: "Resumen", prompt: "Resume el día.", times: ["09:00"] });
    assert.deepEqual(h.service.routineRuns(routine.id), []);
    h.service.runRoutineNow(routine.id);
    await waitFor(() => h.service.routineRuns(routine.id)[0]?.status === "completed", 5_000, "rutina terminada");
    const [run] = h.service.routineRuns(routine.id);
    assert.equal(run?.manual, true);
    assert.match(run?.reply ?? "", /Rutina programada «Resumen»/);
    assert.ok(run?.finishedAt);
    assert.throws(() => h.service.routineRuns("nada"), /no encontrada/i);
  } finally {
    await h.close();
  }
});

test("Claude Bot ve la descripción de cada agente y puede ponerla al crearlo o ajustarlo", async () => {
  const h = await createHarness({ mainAgent: true });
  try {
    const mainId = h.service.mainAgentId() as string;
    await talk(h, mainId, "/crear Directora | Coordina el equipo | Juegos");
    const directora = h.store.findAgentByName("Directora");
    assert.ok(directora);
    h.service.updateAgent(directora.id, { description: "Reparte el trabajo y revisa las entregas." });
    const list = await talk(h, mainId, "/equipo");
    assert.match(list, /"descripcion":"Reparte el trabajo y revisa las entregas\."/);
  } finally {
    await h.close();
  }
});
