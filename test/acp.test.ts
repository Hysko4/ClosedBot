import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { effortVariant, groupModelVariants, mergeSessionModels, modelChoices, NO_MODELS, resolveModel } from "../src/providers/acp-models.js";
import { AcpClient, type AcpClientOptions, isInside } from "../src/providers/acp.js";
import { DemoAgentClient } from "../src/providers/demo.js";
import type { ProviderStatus } from "../src/service.js";
import { createHarness, tempDir, waitFor } from "./helpers.js";

const fixture = fileURLToPath(new URL("../../test/fixtures/fake-acp.mjs", import.meta.url));

const PROVIDERS: ProviderStatus[] = [
  { id: "claude", label: "Claude", available: true, loggedIn: null, detail: "prueba" },
  { id: "grok", label: "Grok", available: true, loggedIn: true, detail: "prueba" },
  { id: "demo", label: "Demo", available: true, loggedIn: true, detail: "prueba" },
];

function readLog(path: string): Array<Record<string, unknown> & { params?: Record<string, unknown> }> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Servicio real con Grok = el agente ACP falso y el resto con la demo. */
async function acpHarness(options: { env?: NodeJS.ProcessEnv; client?: Partial<AcpClientOptions>; dir?: string; log?: string } = {}) {
  chmodSync(fixture, 0o755);
  const temp = options.dir ? { path: options.dir, cleanup: () => undefined } : tempDir("closedbot-acp-");
  const log = options.log ?? join(temp.path, "acp.jsonl");
  // En Windows un .mjs no se ejecuta solo: se envuelve en un .cmd que llama a node (como Gemini CLI).
  let command = fixture;
  if (process.platform === "win32") {
    command = join(temp.path, "fake-acp.cmd");
    writeFileSync(command, `@"${process.execPath}" "${fixture}" %*\r\n`);
  }
  const clients: AcpClient[] = [];
  const h = await createHarness({
    dir: temp.path,
    keepDir: true,
    detectProviders: async () => PROVIDERS,
    createClient: (provider) => {
      if (provider !== "grok") return new DemoAgentClient({ wordDelayMs: 0 });
      const client = new AcpClient({
        provider: "grok",
        label: "Grok",
        command,
        args: [],
        env: { ...process.env, FAKE_ACP_LOG: log, ...options.env },
        authMethods: ["cached_token"],
        ...options.client,
      });
      clients.push(client);
      return client;
    },
  });
  return {
    h,
    log,
    dir: temp.path,
    clients,
    close: async (keep = false) => {
      await h.close();
      if (!keep) temp.cleanup();
    },
  };
}

function assistantText(h: Awaited<ReturnType<typeof acpHarness>>["h"], agentId: string, after = 0): string {
  return h.service
    .listMessages(agentId)
    .filter((message) => message.role === "assistant" && message.createdAt >= after)
    .map((message) => message.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

test("ACP: turno con texto, comando negado sin acceso total y herramientas del equipo por el puente MCP", async () => {
  const { h, log, close } = await acpHarness();
  try {
    h.service.createAgent({ name: "Ana", provider: "demo" });
    const grokky = h.service.createAgent({ name: "Grokky", provider: "grok", model: "fake-mini", effort: "low" });
    const first = h.service.sendUserMessage(grokky.id, "hola @comando @herramienta @intruso");
    await waitFor(() => h.store.getMessage(first.message.id)?.status === "completed", 15_000, "turno de ACP");

    assert.equal(
      assistantText(h, grokky.id),
      "Hola desde ACP. Comando: no. Equipo: Ana, Grokky. Otra: rechazada. Intruso: rechazado.",
    );
    const messages = h.service.listMessages(grokky.id);
    assert.ok(messages.some((item) => item.role === "activity" && item.text === "Ejecutar ls (no se hizo): ls -la"), "el comando negado no dice «Ejecutó»");
    assert.ok(!messages.some((item) => /pensamiento interno|Iniciando/.test(item.text)), "los pensamientos y avisos sueltos no llegan al chat");

    const requests = readLog(log);
    const init = requests.find((item) => item.method === "initialize");
    assert.equal(init?.params?.protocolVersion, 1);
    assert.deepEqual(init?.params?.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
    const session = requests.find((item) => item.method === "session/new");
    assert.equal(session?.params?.cwd, grokky.workspace);
    const servers = session?.params?.mcpServers as Array<{ name: string; command: string; env: Array<{ name: string; value: string }> }>;
    assert.equal(servers[0]?.name, "closedbot");
    assert.equal(servers[0]?.command, process.execPath);
    assert.ok(!servers[0]?.env.some((entry) => /KEY|TOKEN_?$|PASSWORD/i.test(entry.name) && entry.name !== "CLOSEDBOT_BRIDGE_TOKEN" && entry.name !== "CLOSEDBOT_BRIDGE_KEY"));
    // El modelo y el razonamiento se eligen con las opciones de la sesión antes del primer mensaje.
    const options = requests.filter((item) => item.method === "session/set_config_option").map((item) => [item.params?.configId, item.params?.value]);
    assert.deepEqual(options, [
      ["model", "fake-mini"],
      ["reasoning_effort", "low"],
    ]);
    const prompts = () => requests.filter((item) => item.method === "session/prompt");
    const firstPrompt = (prompts()[0]?.params?.prompt as Array<{ text: string }>)[0]?.text ?? "";
    assert.match(firstPrompt, /<instrucciones_de_closedbot>/);
    assert.match(firstPrompt, /Grokky/);
    assert.ok(requests.some((item) => item.method === "session/request_permission" || item.result !== undefined), "respondió el permiso");

    // El segundo mensaje no repite las instrucciones ni vuelve a elegir el modelo.
    const second = h.service.sendUserMessage(grokky.id, "otra vez");
    await waitFor(() => h.store.getMessage(second.message.id)?.status === "completed", 10_000, "segundo turno");
    const again = readLog(log);
    const secondPrompt = (again.filter((item) => item.method === "session/prompt")[1]?.params?.prompt as Array<{ text: string }>)[0]?.text ?? "";
    assert.ok(!secondPrompt.includes("<instrucciones_de_closedbot>"));
    assert.equal(again.filter((item) => item.method === "session/new").length, 1);
    assert.equal(again.filter((item) => item.method === "session/set_config_option").length, 2);
  } finally {
    await close();
  }
});

test("ACP: con acceso total se permite todo; sin él, editar solo dentro de sus carpetas", async () => {
  const { h, close } = await acpHarness();
  try {
    const total = h.service.createAgent({ name: "Total", provider: "grok", access: "total" });
    const one = h.service.sendUserMessage(total.id, "@comando @editar @fuera");
    await waitFor(() => h.store.getMessage(one.message.id)?.status === "completed", 15_000, "turno con acceso total");
    assert.equal(assistantText(h, total.id), "Hola desde ACP. Comando: si. Edición: si.");
    const activity = h.service.listMessages(total.id).filter((item) => item.role === "activity").map((item) => item.text);
    assert.ok(activity.includes("Ejecutó: ls -la"));
    assert.ok(activity.some((text) => text.startsWith("Modificó: ") && text.endsWith("fuera.txt")));

    const folder = h.service.createAgent({ name: "Carpeta", provider: "grok" });
    const inside = h.service.sendUserMessage(folder.id, "@editar");
    await waitFor(() => h.store.getMessage(inside.message.id)?.status === "completed", 15_000, "edición dentro");
    const outside = h.service.sendUserMessage(folder.id, "@editar @fuera");
    await waitFor(() => h.store.getMessage(outside.message.id)?.status === "completed", 15_000, "edición fuera");
    assert.equal(assistantText(h, folder.id), "Hola desde ACP. Edición: si. Hola desde ACP. Edición: no.");
  } finally {
    await close();
  }
});

test("ACP: Detener cancela el turno, aunque el agente no conteste", async () => {
  const { h, log, close } = await acpHarness({ client: { cancelGraceMs: 300 } });
  try {
    const grokky = h.service.createAgent({ name: "Grokky", provider: "grok" });
    const waiting = h.service.sendUserMessage(grokky.id, "@espera");
    await waitFor(() => h.events.some((event) => event.type === "delta" && event.agentId === grokky.id), 10_000, "empieza a responder");
    assert.equal(await h.service.interrupt(grokky.id), true);
    await waitFor(() => h.store.getMessage(waiting.message.id)?.status === "interrupted", 5_000, "turno interrumpido");
    assert.ok(readLog(log).some((item) => item.method === "session/cancel" && item.id === undefined));

    const deaf = h.service.sendUserMessage(grokky.id, "@sordo");
    await waitFor(() => h.service.getAgent(grokky.id).state === "working" && readLog(log).filter((item) => item.method === "session/prompt").length === 2, 10_000, "trabajando");
    assert.equal(await h.service.interrupt(grokky.id), true);
    await waitFor(() => h.store.getMessage(deaf.message.id)?.status === "interrupted", 5_000, "se da por interrumpido");
    assert.equal(h.service.getAgent(grokky.id).state, "idle");
  } finally {
    await close();
  }
});

test("ACP: usa la sesión guardada si hace falta y, si no hay, pide iniciarla en Ajustes", async () => {
  const saved = await acpHarness({ env: { FAKE_ACP_AUTH: "required" } });
  try {
    const grokky = saved.h.service.createAgent({ name: "Grokky", provider: "grok" });
    const { message } = saved.h.service.sendUserMessage(grokky.id, "hola");
    await waitFor(() => saved.h.store.getMessage(message.id)?.status === "completed", 15_000, "turno tras autenticar");
    const auth = readLog(saved.log).filter((item) => item.method === "authenticate");
    assert.deepEqual(
      auth.map((item) => item.params?.methodId),
      ["cached_token"],
    );
  } finally {
    await saved.close();
  }

  const cases: Array<[NodeJS.ProcessEnv, Partial<AcpClientOptions>]> = [
    [{ FAKE_ACP_AUTH: "never" }, {}],
    [{ FAKE_ACP_AUTH: "required" }, { authMethods: [] }],
  ];
  for (const [env, client] of cases) {
    const signedOut = await acpHarness({ env, client });
    try {
      const grokky = signedOut.h.service.createAgent({ name: "Grokky", provider: "grok" });
      const { message } = signedOut.h.service.sendUserMessage(grokky.id, "hola");
      await waitFor(() => signedOut.h.store.getMessage(message.id)?.status === "failed", 15_000, "turno sin sesión");
      const notice = signedOut.h.service.listMessages(grokky.id).find((item) => item.role === "notice");
      assert.match(notice?.text ?? "", /Grok no tiene la sesión iniciada: entra en Ajustes y pulsa «Iniciar sesión»/);
      const asked = readLog(signedOut.log).filter((item) => item.method === "authenticate").length;
      assert.equal(asked, client.authMethods ? 0 : 1, "sin método guardado no intenta autenticar");
    } finally {
      await signedOut.close();
    }
  }
});

test("ACP: cada proceso usa su carpeta temporal y, si el agente pide entrar por el navegador, se corta enseguida", async () => {
  const outer = tempDir("closedbot-acp-tmp-");
  const tempRoot = join(outer.path, "tmp");
  const signInPrompt = /open the following link to authenticate/i;
  try {
    // Con sesión: el agente arranca con su propia carpeta temporal, que se borra al cerrarlo.
    const ok = await acpHarness({ client: { tempRoot, signInPrompt } });
    let used = "";
    try {
      const grokky = ok.h.service.createAgent({ name: "Grokky", provider: "grok" });
      const { message } = ok.h.service.sendUserMessage(grokky.id, "hola");
      await waitFor(() => ok.h.store.getMessage(message.id)?.status === "completed", 15_000, "turno");
      const start = readLog(ok.log).find((item) => item.method === "_arranque");
      used = String(start?.temp ?? "");
      assert.ok(used.startsWith(join(tempRoot, "agente-")), used);
      assert.equal(start?.tmp, used);
      assert.equal(start?.tmpdir, used);
      assert.ok(existsSync(used));
    } finally {
      await ok.close();
    }
    await waitFor(() => !existsSync(used), 5_000, "carpeta temporal borrada");

    // Sin sesión: Antigravity escribe el enlace para entrar y espera hasta 5 minutos; aquí se corta enseguida.
    const signedOut = await acpHarness({ env: { FAKE_ACP_AUTH: "link" }, client: { tempRoot, signInPrompt } });
    try {
      const grokky = signedOut.h.service.createAgent({ name: "Grokky", provider: "grok" });
      const started = Date.now();
      const { message } = signedOut.h.service.sendUserMessage(grokky.id, "hola");
      await waitFor(() => signedOut.h.store.getMessage(message.id)?.status === "failed", 15_000, "turno sin sesión");
      assert.ok(Date.now() - started < 10_000, "no espera los 2 minutos de la sesión");
      const notices = signedOut.h.service
        .listMessages(grokky.id)
        .filter((item) => item.role === "notice")
        .map((item) => item.text);
      assert.deepEqual(notices, ["Grok no tiene la sesión iniciada: entra en Ajustes y pulsa «Iniciar sesión»."]);
      assert.equal(readLog(signedOut.log).filter((item) => item.method === "authenticate").length, 0, "no intenta autenticar");
    } finally {
      await signedOut.close();
    }
    await waitFor(() => readdirSync(tempRoot).length === 0, 5_000, "sin carpetas temporales");
  } finally {
    outer.cleanup();
  }
});

test("ACP: lista los modelos sin gastar mensajes y retoma la conversación tras reiniciar la app", async () => {
  for (const noResume of [false, true]) {
    const first = await acpHarness({ env: noResume ? { FAKE_ACP_NO_RESUME: "1" } : {} });
    const { dir, log } = first;
    let grokkyId = "";
    try {
      const models = await first.h.service.listModels("grok");
      assert.deepEqual(models, [
        { model: "fake-pro", displayName: "Fake Pro", isDefault: true, efforts: ["high", "low"] },
        { model: "fake-mini", displayName: "Fake Mini", isDefault: false, efforts: [] },
      ]);
      const probe = readLog(log).find((item) => item.method === "session/new");
      assert.match(String(probe?.params?.cwd), /closedbot-grok-modelos/);
      assert.ok(!readLog(log).some((item) => item.method === "session/prompt"), "listar modelos no manda mensajes");

      const grokky = first.h.service.createAgent({ name: "Grokky", provider: "grok" });
      grokkyId = grokky.id;
      const { message } = first.h.service.sendUserMessage(grokky.id, "hola");
      await waitFor(() => first.h.store.getMessage(message.id)?.status === "completed", 15_000, "primer turno");
    } finally {
      await first.close(true);
    }

    const second = await acpHarness({ dir, log, env: noResume ? { FAKE_ACP_NO_RESUME: "1" } : {} });
    try {
      const threadId = second.h.service.getAgent(grokkyId).threadId;
      const before = Date.now();
      const { message } = second.h.service.sendUserMessage(grokkyId, "¿te acuerdas?");
      await waitFor(() => second.h.store.getMessage(message.id)?.status === "completed", 15_000, "turno tras reiniciar");
      const requests = readLog(log);
      const method = noResume ? "session/load" : "session/resume";
      assert.equal(requests.filter((item) => item.method === method && item.params?.sessionId === threadId).length, 1, method);
      assert.equal(second.h.service.getAgent(grokkyId).threadId, threadId, "sigue en la misma conversación");
      // Lo que «load» repite ya está en ClosedBot: no se vuelve a mostrar.
      assert.equal(assistantText(second.h, grokkyId, before), "Hola desde ACP.");
      // Las instrucciones vuelven a ir en el primer mensaje del proceso nuevo.
      const last = requests.filter((item) => item.method === "session/prompt").at(-1);
      assert.match((last?.params?.prompt as Array<{ text: string }>)[0]?.text ?? "", /<instrucciones_de_closedbot>/);
    } finally {
      await second.close();
    }
  }
});

test("ACP: Gemini por Antigravity, con «Modelo» y «Esfuerzo» por separado (como OpenBot)", async () => {
  const { h, log, close } = await acpHarness({ env: { FAKE_ACP_MODELS: "antigravity" } });
  try {
    // Los modelos de las opciones de la sesión, con los niveles de «thinking_level»; nada de «Gemini 4 Argon (Medium)».
    const models = await h.service.listModels("grok");
    const levels = ["low", "medium", "high"];
    assert.deepEqual(models, [
      {
        model: "gemini-4-argon",
        displayName: "Gemini 4 Argon",
        isDefault: false,
        efforts: levels,
        variants: { low: "gemini-4-argon-low", medium: "gemini-4-argon-medium", high: "gemini-4-argon-high" },
      },
      {
        model: "gemini-3.8-flash",
        displayName: "Gemini 3.8 Flash",
        isDefault: true,
        efforts: levels,
        variants: { low: "gemini-3.8-flash-low", medium: "gemini-3.8-flash-medium", high: "gemini-3.8-flash-high" },
      },
    ]);

    const turn = async (input: Parameters<typeof h.service.createAgent>[0]) => {
      const agent = h.service.createAgent(input);
      const { message } = h.service.sendUserMessage(agent.id, "hola");
      await waitFor(() => h.store.getMessage(message.id)?.status === "completed", 15_000, `turno de ${input.name}`);
    };
    await turn({ name: "Argon", provider: "grok", model: "gemini-4-argon", effort: "high" });
    // Solo el esfuerzo: el modelo predeterminado con ese nivel.
    await turn({ name: "Rápido", provider: "grok", effort: "low" });
    // Lo guardado con la 0.6.1 (la variante «(Low)» como modelo) se traduce a modelo + nivel.
    await turn({ name: "Antiguo", provider: "grok", model: "gemini-4-argon-low" });

    const chosen = readLog(log)
      .filter((item) => item.method === "session/set_config_option")
      .map((item) => [item.params?.configId, item.params?.value]);
    assert.deepEqual(chosen, [
      ["model", "gemini-4-argon"],
      ["thinking_level", "high"],
      ["thinking_level", "low"],
      ["model", "gemini-4-argon"],
      ["thinking_level", "low"],
    ]);
    assert.ok(!readLog(log).some((item) => item.method === "session/set_model"));
  } finally {
    await close();
  }
});

test("ACP: modelos de la lista vieja, de las opciones de la sesión (agrupadas) y variantes por nivel", () => {
  assert.deepEqual(effortVariant("Gemini 3 Pro (High)"), { base: "Gemini 3 Pro", effort: "high" });
  assert.deepEqual(effortVariant("GPT-OSS 120B (Extra-High)"), { base: "GPT-OSS 120B", effort: "xhigh" });
  assert.equal(effortVariant("Claude Sonnet 4.5 (Thinking)"), null);
  assert.equal(effortVariant("Gemini 3 Flash"), null);

  // Opciones en grupos; una sesión retomada no cambia el modelo predeterminado.
  const grouped = {
    configOptions: [
      {
        id: "modelo",
        category: "model",
        currentValue: "b",
        options: [
          { group: "g1", name: "Gemini", options: [{ value: "a", name: "Modelo A" }] },
          { group: "g2", name: "Otros", options: [{ value: "b", name: "Modelo B" }] },
        ],
      },
      { id: "esfuerzo", category: "thought_level", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
    ],
  };
  const merged = mergeSessionModels(NO_MODELS, grouped);
  assert.deepEqual(merged.options.map((entry) => entry.modelId), ["a", "b"]);
  assert.deepEqual(merged.levels, ["low", "high"]);
  assert.equal(merged.optionCurrent, "b");
  const resumed = mergeSessionModels(merged, { configOptions: [{ ...grouped.configOptions[0], currentValue: "a" }] }, { current: false });
  assert.equal(resumed.optionCurrent, "b");
  assert.deepEqual(resumed.levels, ["low", "high"], "lo que no trae la respuesta queda como estaba");
  const options = modelChoices(resumed);
  assert.equal(options.current, "b");
  assert.deepEqual(options.choices.map((choice) => [choice.modelId, choice.efforts]), [
    ["a", ["low", "high"]],
    ["b", ["low", "high"]],
  ]);
  assert.deepEqual(resolveModel(options.choices, options.current, "a", "high"), { model: "a", effort: "high" });
  assert.deepEqual(resolveModel(options.choices, options.current, "", "low"), { model: null, effort: "low" });

  // Como Grok: la lista vieja trae los niveles de cada modelo, así que manda ella aunque haya opciones.
  const grok = mergeSessionModels(merged, {
    models: { availableModels: [{ modelId: "g", name: "Grok", _meta: { reasoningEfforts: ["low"] } }], currentModelId: "g" },
  });
  assert.deepEqual(modelChoices(grok), { choices: [{ modelId: "g", name: "Grok", efforts: ["low"], variants: {}, levelsAsModels: false }], current: "g" });
  assert.deepEqual(resolveModel(modelChoices(grok).choices, "g", "g", "low"), { model: "g", effort: "low" });

  // Sin opciones de sesión, las variantes por nivel se juntan; el modelo sin nivel es el predeterminado del grupo.
  const choices = groupModelVariants([
    { modelId: "pro", name: "Gemini 3 Pro", efforts: [] },
    { modelId: "pro-high", name: "Gemini 3 Pro (High)", efforts: [] },
    { modelId: "pro-high-2", name: "Gemini 3 Pro (High)", efforts: [] },
  ]);
  assert.deepEqual(choices, [
    { modelId: "pro", name: "Gemini 3 Pro", efforts: ["high"], variants: { high: "pro-high" }, levelsAsModels: true },
    { modelId: "pro-high-2", name: "Gemini 3 Pro (High)", efforts: [], variants: {}, levelsAsModels: false },
  ]);
  assert.deepEqual(resolveModel(choices, null, "pro", "high"), { model: "pro-high", effort: null });
  assert.deepEqual(resolveModel(choices, null, "pro", ""), { model: "pro", effort: null });
  assert.deepEqual(resolveModel(choices, "pro", "", "high"), { model: "pro-high", effort: null });
  assert.deepEqual(resolveModel(choices, "pro", "", ""), { model: null, effort: null });
});

test("ACP: rutas dentro de las carpetas del agente", () => {
  assert.equal(isInside("/datos/agentes/ana", "/datos/agentes/ana/notas/a.txt"), true);
  assert.equal(isInside("/datos/agentes/ana", "/datos/agentes/ana"), true);
  assert.equal(isInside("/datos/agentes/ana", "/datos/agentes/ana-2/a.txt"), false);
  assert.equal(isInside("/datos/agentes/ana", "/datos/agentes/ana/../beto/a.txt"), false);
  assert.equal(isInside("/datos/agentes/ana", "/etc/passwd"), false);
});

test("ACP: el inicio de sesión de Antigravity usa una carpeta temporal propia y la borra al terminar", async () => {
  chmodSync(fixture, 0o755);
  const temp = tempDir("closedbot-acp-login-");
  try {
    const script = fileURLToPath(new URL("../src/providers/acp-login.js", import.meta.url));
    const tempRoot = join(temp.path, "tmp");
    let command = fixture;
    if (process.platform === "win32") {
      command = join(temp.path, "fake-acp.cmd");
      writeFileSync(command, `@"${process.execPath}" "${fixture}" %*\r\n`);
    }
    const run = (method: string, log: string) =>
      spawnSync(process.execPath, [script, method, command], {
        encoding: "utf8",
        env: { ...process.env, FAKE_ACP_LOG: log, CLOSEDBOT_AGENT_TEMP: tempRoot },
        timeout: 20_000,
      });
    const ok = run("cached_token", join(temp.path, "ok.jsonl"));
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /Sesión iniciada\./);
    const start = readLog(join(temp.path, "ok.jsonl")).find((item) => item.method === "_arranque");
    assert.ok(String(start?.temp ?? "").startsWith(join(tempRoot, "agente-")), String(start?.temp));
    assert.ok(!("CLOSEDBOT_AGENT_TEMP" in (start ?? {})));
    assert.deepEqual(readdirSync(tempRoot), [], "la carpeta temporal se borró");

    // Si la cuenta no sirve, se explica en una línea que la app muestra tal cual.
    const failed = run("oauth-personal", join(temp.path, "mal.jsonl"));
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /^Login failed: Authentication required$/m);
    assert.deepEqual(readdirSync(tempRoot), []);
  } finally {
    temp.cleanup();
  }
});
