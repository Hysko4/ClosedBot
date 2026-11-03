import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  encodeWav,
  type LocalVoiceModel,
  LocalVoices,
  type LocalVoicesStatus,
  openBotVoiceDirs,
  SUPERTONIC_3,
  type SynthesisRequest,
  supertonicConfig,
} from "../src/voices.js";
import { tempDir } from "./helpers.js";

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

const CONTENTS: Record<string, Buffer> = {
  "dp.onnx": Buffer.from("duración"),
  "te.onnx": Buffer.from("codificador de texto"),
  "ve.onnx": Buffer.from("estimador"),
  "vo.onnx": Buffer.from("vocoder"),
  "tts.json": Buffer.from("{}"),
  "ui.bin": Buffer.from("índice"),
  "voice.bin": Buffer.from("estilos de voz"),
  LICENSE: Buffer.from("licencia"),
};
const file = (name: string) => ({ name, bytes: CONTENTS[name]!.length, sha256: sha256(CONTENTS[name]!) });

const MODEL: LocalVoiceModel = {
  id: "prueba",
  label: "Voces de prueba",
  baseUrl: "https://example.invalid/voces/rev/",
  dir: "voces-prueba",
  files: {
    durationPredictor: file("dp.onnx"),
    textEncoder: file("te.onnx"),
    vectorEstimator: file("ve.onnx"),
    vocoder: file("vo.onnx"),
    ttsJson: file("tts.json"),
    unicodeIndexer: file("ui.bin"),
    voiceStyle: file("voice.bin"),
  },
  extra: [file("LICENSE")],
  voices: [
    { id: "F1", sid: 0, label: "Voz femenina 1" },
    { id: "M1", sid: 5, label: "Voz masculina 1" },
  ],
  languages: ["es", "en"],
  numSteps: 8,
};

function writeModel(dir: string, model = MODEL): void {
  mkdirSync(dir, { recursive: true });
  for (const entry of [...Object.values(model.files), ...model.extra]) writeFileSync(join(dir, entry.name), CONTENTS[entry.name]!);
}

/** Un fetch que entrega los archivos del modelo y anota qué se pidió. */
function fakeFetch(requested: string[] = [], override: Record<string, Buffer | number> = {}): typeof fetch {
  return (async (url: string | URL) => {
    const href = String(url);
    requested.push(href);
    const name = href.slice(href.lastIndexOf("/") + 1);
    const value = override[name] ?? CONTENTS[name];
    if (typeof value === "number") return new Response("no", { status: value });
    if (!value) return new Response("no", { status: 404 });
    return new Response(new Uint8Array(value), { status: 200 });
  }) as typeof fetch;
}

test("Voces de este PC: Supertonic 3 con los archivos, voces e idiomas que fija OpenBot", () => {
  assert.match(SUPERTONIC_3.baseUrl, /^https:\/\/huggingface\.co\/csukuangfj2\/sherpa-onnx-supertonic-3-tts-int8-2026-05-11\/resolve\/[0-9a-f]{40}\/$/);
  const files = [...Object.values(SUPERTONIC_3.files), ...SUPERTONIC_3.extra];
  assert.equal(files.length, 8);
  assert.equal(
    files.reduce((sum, entry) => sum + entry.bytes, 0),
    145_296_838,
  );
  for (const entry of files) assert.match(entry.sha256, /^[0-9a-f]{64}$/, entry.name);
  assert.deepEqual(
    SUPERTONIC_3.voices.map((voice) => `${voice.id}=${voice.sid}`),
    ["F1=0", "F2=1", "F3=2", "F4=3", "F5=4", "M1=5", "M2=6", "M3=7", "M4=8", "M5=9"],
  );
  assert.equal(SUPERTONIC_3.languages.length, 31);
  assert.ok(SUPERTONIC_3.languages.includes("es"));

  const config = supertonicConfig(SUPERTONIC_3, "/modelos/st");
  const model = config.model as Record<string, unknown>;
  assert.deepEqual(model.supertonic, {
    durationPredictor: join("/modelos/st", "duration_predictor.int8.onnx"),
    textEncoder: join("/modelos/st", "text_encoder.int8.onnx"),
    vectorEstimator: join("/modelos/st", "vector_estimator.int8.onnx"),
    vocoder: join("/modelos/st", "vocoder.int8.onnx"),
    ttsJson: join("/modelos/st", "tts.json"),
    unicodeIndexer: join("/modelos/st", "unicode_indexer.bin"),
    voiceStyle: join("/modelos/st", "voice.bin"),
  });
  assert.equal(model.provider, "cpu");
  assert.equal(config.maxNumSentences, 1);

  // Donde las deja OpenBot en cada sistema.
  assert.deepEqual(openBotVoiceDirs(SUPERTONIC_3, { APPDATA: "C:\\Users\\ana\\AppData\\Roaming" }, "win32"), [
    join("C:\\Users\\ana\\AppData\\Roaming", "OpenBot", "runtimes", "supertonic-3-int8"),
  ]);
  assert.deepEqual(openBotVoiceDirs(SUPERTONIC_3, { HOME: "/Users/ana" }, "darwin"), [
    join("/Users/ana", "Library", "Application Support", "OpenBot", "runtimes", "supertonic-3-int8"),
  ]);
  assert.deepEqual(openBotVoiceDirs(SUPERTONIC_3, { HOME: "/home/ana" }, "linux"), [join("/home/ana", ".config", "OpenBot", "runtimes", "supertonic-3-int8")]);
});

test("Voces de este PC: usa la copia de OpenBot y lee en WAV con la voz, la velocidad y el idioma pedidos", async () => {
  const temp = tempDir("closedbot-voces-");
  const heard: SynthesisRequest[] = [];
  const synthesize = async (request: SynthesisRequest) => {
    heard.push(request);
    return { samples: new Float32Array([0, 0.5, -0.5, 2, -2]), sampleRate: 44_100 };
  };
  try {
    const openbot = join(temp.path, "OpenBot", "runtimes", "voces-prueba");
    const voices = new LocalVoices({ dir: join(temp.path, "voz"), model: MODEL, shared: [openbot], synthesize });

    // Sin modelo: se ofrece la descarga y leer responde 409.
    const missing: LocalVoicesStatus = voices.status();
    assert.equal(missing.state, "missing");
    assert.equal(missing.source, null);
    assert.deepEqual(missing.voices, [
      { id: "F1", label: "Voz femenina 1" },
      { id: "M1", label: "Voz masculina 1" },
    ]);
    assert.deepEqual(missing.languages, ["es", "en"]);
    await assert.rejects(voices.speak({ text: "hola" }), (error: Error & { status?: number }) => error.status === 409);

    // OpenBot ya lo bajó (aunque sea con la app abierta): se usa tal cual, sin descargar nada.
    writeModel(openbot);
    assert.deepEqual([voices.status().state, voices.status().source], ["ready", "openbot"]);

    const wav = await voices.speak({ text: "  Hola,\n¿qué tal?  ", voice: "M1", speed: 3, lang: "es-CL" });
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.toString("ascii", 8, 12), "WAVE");
    assert.equal(wav.readUInt16LE(22), 1, "mono");
    assert.equal(wav.readUInt32LE(24), 44_100);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.readUInt32LE(40), 10, "5 muestras de 16 bits");
    assert.deepEqual(
      [0, 1, 2, 3, 4].map((index) => wav.readInt16LE(44 + index * 2)),
      [0, 16_384, -16_384, 32_767, -32_768],
    );
    assert.deepEqual(heard[0], { text: "Hola, ¿qué tal?", sid: 5, speed: 2, lang: "es", numSteps: 8 });

    // Voz desconocida: la primera; idioma que no habla: español; velocidad inválida: normal.
    await voices.speak({ text: "otra", voice: "Z9", speed: "rápido", lang: "zh-CN" });
    assert.deepEqual(heard[1], { text: "otra", sid: 0, speed: 1, lang: "es", numSteps: 8 });
    await voices.speak({ text: "hello", lang: "en" });
    assert.equal(heard[2]?.lang, "en");

    await assert.rejects(voices.speak({ text: "   " }), (error: Error & { status?: number }) => error.status === 400);
    await assert.rejects(voices.speak({ text: "a".repeat(1_001) }), (error: Error & { status?: number }) => error.status === 413);

    // Si OpenBot la borra, se vuelve a ofrecer la descarga.
    for (const name of readdirSync(openbot)) writeFileSync(join(openbot, name), "");
    assert.equal(voices.status().state, "missing");
    await voices.stop();
  } finally {
    temp.cleanup();
  }
});

test("Voces de este PC: «Descargar» baja cada archivo, comprueba su SHA-256 y solo deja el modelo completo", async () => {
  const temp = tempDir("closedbot-voces-");
  try {
    const dir = join(temp.path, "voz");
    const requested: string[] = [];
    const voices = new LocalVoices({ dir, model: MODEL, fetch: fakeFetch(requested), synthesize: async () => ({ samples: new Float32Array(1), sampleRate: 44_100 }) });
    const events: LocalVoicesStatus[] = [];
    voices.on("status", (status: LocalVoicesStatus) => events.push(status));
    await voices.install();
    assert.deepEqual(
      requested,
      [...Object.values(MODEL.files), ...MODEL.extra].map((entry) => `${MODEL.baseUrl}${entry.name}`),
    );
    assert.equal(events[0]?.state, "downloading");
    assert.equal(events.at(-1)?.state, "ready");
    assert.deepEqual([voices.status().state, voices.status().source], ["ready", "closedbot"]);
    assert.deepEqual(readdirSync(join(dir, "voces")), ["voces-prueba"], "sin restos de la descarga");
    assert.deepEqual(readdirSync(join(dir, "voces", "voces-prueba")).sort(), Object.keys(CONTENTS).sort());

    // Un archivo distinto del publicado: no queda nada a medias y se puede reintentar.
    const other = tempDir("closedbot-voces-");
    try {
      const bad = new LocalVoices({ dir: other.path, model: MODEL, fetch: fakeFetch([], { "ve.onnx": Buffer.from("ESTIMADOR") }) });
      await assert.rejects(bad.install(), /ve\.onnx no coincide con el publicado \(SHA-256 distinto\)/);
      assert.equal(bad.status().state, "error");
      assert.match(String(bad.status().error), /No se pudieron descargar las voces/);
      assert.deepEqual(readdirSync(join(other.path, "voces")), []);

      const failing = new LocalVoices({ dir: other.path, model: MODEL, fetch: fakeFetch([], { "tts.json": 404 }) });
      await assert.rejects(failing.install(), /el servidor respondió 404/);
      const longer = new LocalVoices({ dir: other.path, model: MODEL, fetch: fakeFetch([], { "ui.bin": Buffer.from("índice y algo más") }) });
      await assert.rejects(longer.install(), /ui\.bin es más grande de lo publicado/);
      assert.deepEqual(readdirSync(join(other.path, "voces")), []);

      // Una descarga cortada de antes (la app se cerró a mitad) se limpia al empezar otra.
      mkdirSync(join(other.path, "voces", ".descargando-123"), { recursive: true });
      const again = new LocalVoices({ dir: other.path, model: MODEL, fetch: fakeFetch() });
      await again.install();
      assert.deepEqual(readdirSync(join(other.path, "voces")), ["voces-prueba"]);
    } finally {
      other.cleanup();
    }
    await voices.stop();
  } finally {
    temp.cleanup();
  }
});

test("Voces de este PC: el proceso de las voces avisa si no puede cargar el modelo (sin caerse)", async (t) => {
  const script = fileURLToPath(new URL("../src/voice-worker.js", import.meta.url));
  if (!existsSync(script)) return t.skip("sin el proceso compilado");
  const child = fork(script, [], { serialization: "advanced", stdio: ["ignore", "ignore", "ignore", "ipc"] });
  try {
    const reply = new Promise<Record<string, unknown>>((resolve) => child.once("message", (message) => resolve(message as Record<string, unknown>)));
    child.send({ type: "load", config: supertonicConfig(SUPERTONIC_3, join(tmpdir(), `closedbot-voces-no-existe-${process.pid}`)) });
    const message = await Promise.race([
      reply,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("el proceso de las voces no respondió")), 20_000).unref()),
    ]);
    assert.equal(message.type, "error");
    assert.ok(child.exitCode === null, "sigue vivo");
  } finally {
    child.kill();
  }
});

test("encodeWav: PCM de 16 bits recortado a [-1, 1]", () => {
  const wav = encodeWav(new Float32Array([1, -1, 0.25]), 22_050);
  assert.equal(wav.length, 44 + 6);
  assert.equal(wav.readUInt32LE(4), 36 + 6);
  assert.equal(wav.readUInt32LE(28), 44_100, "bytes por segundo");
  assert.deepEqual([wav.readInt16LE(44), wav.readInt16LE(46), wav.readInt16LE(48)], [32_767, -32_768, 8_192]);
});
