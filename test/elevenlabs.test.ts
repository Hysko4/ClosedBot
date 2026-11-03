import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Store, toVoice } from "../src/db.js";
import { ElevenLabs, ElevenLabsError, MAX_TTS_CHARS } from "../src/elevenlabs.js";
import { AUDIO, BAD_KEY, fakeElevenLabs, GOOD_KEY, NO_USER_KEY } from "./fake-elevenlabs.js";
import { tempDir } from "./helpers.js";

function setup() {
  const dir = tempDir();
  const store = new Store(join(dir.path, "closedbot.db"));
  const fake = fakeElevenLabs();
  const eleven = new ElevenLabs({ store, fetch: fake.fetch, baseUrl: "https://api.elevenlabs.test" });
  return {
    store,
    fake,
    eleven,
    close: () => {
      store.close();
      dir.cleanup();
    },
  };
}

async function rejectsWith(promise: Promise<unknown>, status: number, message?: RegExp) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ElevenLabsError, `ElevenLabsError, no ${String(error)}`);
    assert.equal(error.status, status, error.message);
    if (message) assert.match(error.message, message);
    return true;
  });
}

test("ElevenLabs: sin clave no hace nada y una clave mala no se guarda", async () => {
  const t = setup();
  try {
    assert.deepEqual(await t.eleven.status(), { configured: false, model: "eleven_flash_v2_5", voices: [], usage: null, error: null });
    await rejectsWith(t.eleven.synthesize("premadeAna0001", "Hola"), 409, /clave/);
    await rejectsWith(t.eleven.configure({ key: "corta" }), 400, /no parece una clave/);
    await rejectsWith(t.eleven.configure({ key: 42 }), 400);
    // Con buena forma pero rechazada por ElevenLabs: 400 (nunca 401, que cerraría la sesión de ClosedBot).
    await rejectsWith(t.eleven.configure({ key: BAD_KEY }), 400, /rechazó la clave/);
    assert.equal(t.store.getMeta("elevenlabs"), null, "no se guardó nada");
    assert.equal(t.eleven.configured, false);
    assert.equal(t.fake.calls.length, 2, "sólo se probó la clave con buena forma (voces y uso)");
  } finally {
    t.close();
  }
});

test("ElevenLabs: con clave, voces propias primero, uso del mes y la clave nunca sale", async () => {
  const t = setup();
  try {
    const status = await t.eleven.configure({ key: `  ${GOOD_KEY}\n` });
    assert.equal(status.configured, true);
    assert.equal(status.error, null);
    assert.deepEqual(
      status.voices.map((voice) => voice.id),
      ["miVozClonada01", "premadeAna0001", "premadeZeta01"],
      "las tuyas primero y las demás por nombre; ids raros fuera",
    );
    assert.deepEqual(status.voices[2], {
      id: "premadeZeta01",
      name: "Zeta",
      category: "premade",
      gender: "male",
      accent: "american",
      description: "",
      previewUrl: "https://example.com/z.mp3",
    });
    assert.equal(status.voices[0]?.description, "La mía");
    assert.deepEqual(status.usage, { used: 1234, limit: 10_000, tier: "free" });
    assert.ok(!JSON.stringify(status).includes(GOOD_KEY), "la clave no vuelve a la interfaz");
    assert.equal(JSON.parse(t.store.getMeta("elevenlabs") ?? "{}").key, GOOD_KEY, "se guardó sin espacios");
    for (const call of t.fake.calls) assert.equal(call.key, GOOD_KEY);

    // Se guarda 10 minutos; con refresh se vuelve a pedir.
    const before = t.fake.calls.length;
    await t.eleven.status();
    assert.equal(t.fake.calls.length, before);
    await t.eleven.status({ refresh: true });
    assert.equal(t.fake.calls.length, before + 2);

    // Cambiar sólo el modelo no vuelve a probar la clave.
    const flash = await t.eleven.configure({ model: "eleven_multilingual_v2" });
    assert.equal(flash.model, "eleven_multilingual_v2");
    assert.equal(t.fake.calls.length, before + 2);
    await rejectsWith(t.eleven.configure({ model: "eleven_v9" }), 400);

    // Una clave nueva rechazada no reemplaza a la buena.
    await rejectsWith(t.eleven.configure({ key: BAD_KEY }), 400);
    assert.equal(JSON.parse(t.store.getMeta("elevenlabs") ?? "{}").key, GOOD_KEY);

    // Quitarla.
    const removed = await t.eleven.configure({ key: "" });
    assert.equal(removed.configured, false);
    assert.equal(t.eleven.configured, false);
    assert.equal(JSON.parse(t.store.getMeta("elevenlabs") ?? "{}").key, "");
  } finally {
    t.close();
  }
});

test("ElevenLabs: una clave sin permiso para ver el uso igual sirve", async () => {
  const t = setup();
  try {
    const status = await t.eleven.configure({ key: NO_USER_KEY });
    assert.equal(status.configured, true);
    assert.equal(status.voices.length, 3);
    assert.equal(status.usage, null);
  } finally {
    t.close();
  }
});

test("ElevenLabs: leer un texto valida la voz y el texto y traduce los errores (nunca 401)", async () => {
  const t = setup();
  try {
    await t.eleven.configure({ key: GOOD_KEY, model: "eleven_multilingual_v2" });
    const response = await t.eleven.synthesize("premadeAna0001", "  Hola, ¿cómo estás?  ");
    assert.equal(response.headers.get("content-type"), "audio/mpeg");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), AUDIO);
    const call = t.fake.calls.at(-1);
    assert.equal(call?.url, "/v1/text-to-speech/premadeAna0001/stream?output_format=mp3_44100_128");
    assert.equal(call?.method, "POST");
    assert.equal(call?.key, GOOD_KEY);
    assert.deepEqual(call?.body, { text: "Hola, ¿cómo estás?", model_id: "eleven_multilingual_v2" });

    await rejectsWith(t.eleven.synthesize("../voices", "Hola"), 400, /voz/);
    await rejectsWith(t.eleven.synthesize(7, "Hola"), 400);
    await rejectsWith(t.eleven.synthesize("premadeAna0001", "   "), 400, /texto/);
    await rejectsWith(t.eleven.synthesize("premadeAna0001", "a".repeat(MAX_TTS_CHARS + 1)), 400, /caracteres/);
    await rejectsWith(t.eleven.synthesize("vozBorrada", "Hola"), 404, /ya no está/);
    await rejectsWith(t.eleven.synthesize("sinCaracteres", "Hola"), 402, /caracteres de tu plan/);
    await rejectsWith(t.eleven.synthesize("ocupada", "Hola"), 429);
    await rejectsWith(t.eleven.synthesize("rota", "Hola"), 502, /boom/);

    const controller = new AbortController();
    controller.abort();
    await rejectsWith(t.eleven.synthesize("premadeAna0001", "Hola", controller.signal), 499);
  } finally {
    t.close();
  }
});

test("ElevenLabs: sin internet o con la clave revocada, el estado lo dice sin romperse", async () => {
  const dir = tempDir();
  const store = new Store(join(dir.path, "closedbot.db"));
  let offline = false;
  const fake = fakeElevenLabs();
  const eleven = new ElevenLabs({
    store,
    fetch: async (input, init) => {
      if (offline) throw new TypeError("fetch failed");
      return fake.fetch(input, init);
    },
  });
  try {
    await eleven.configure({ key: GOOD_KEY });
    offline = true;
    const status = await eleven.status({ refresh: true });
    assert.equal(status.configured, true);
    assert.equal(status.voices.length, 3, "se conservan las voces que ya se conocían");
    assert.match(status.error ?? "", /No se pudo conectar con ElevenLabs/);
    await rejectsWith(eleven.synthesize("premadeAna0001", "Hola"), 502, /conexión/);
  } finally {
    store.close();
    dir.cleanup();
  }
});

test("voz por agente: el motor y la voz de ElevenLabs se guardan limpios", () => {
  assert.deepEqual(toVoice(undefined), { name: "", rate: 1, lang: "auto", autoRead: false, engine: "system", elevenVoice: "", elevenName: "" });
  assert.deepEqual(toVoice(JSON.stringify({ engine: "elevenlabs", elevenVoice: "premadeAna0001", elevenName: " Ana ", rate: 1.2 })), {
    name: "",
    rate: 1.2,
    lang: "auto",
    autoRead: false,
    engine: "elevenlabs",
    elevenVoice: "premadeAna0001",
    elevenName: "Ana",
  });
  const bad = toVoice({ engine: "loquendo", elevenVoice: "a/b", elevenName: "x".repeat(200) });
  assert.equal(bad.engine, "system");
  assert.equal(bad.elevenVoice, "");
  assert.equal(bad.elevenName.length, 80);
  // Lo guardado por la 0.5 (sin los campos nuevos) sigue funcionando.
  assert.equal(toVoice(JSON.stringify({ name: "Microsoft Catalina Online (Natural) - Spanish (Chile)", rate: 1, lang: "es-CL", autoRead: true })).engine, "system");
});
