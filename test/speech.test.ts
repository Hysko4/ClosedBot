import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { cleanTranscript, decodeWav, type SpeechModel, SpeechEngine, SpeechError, type SpeechStatus } from "../src/speech.js";
import { tempDir } from "./helpers.js";
import { makeWav, silentWav, toneWav } from "./wav.js";

const ARCHIVE = Buffer.from("archivo comprimido de prueba con el modelo");

function fakeModel(overrides: Partial<SpeechModel> = {}): SpeechModel {
  return {
    id: "prueba",
    label: "Modelo de prueba",
    url: "https://example.invalid/modelo.tar.bz2",
    bytes: ARCHIVE.length,
    sha256: createHash("sha256").update(ARCHIVE).digest("hex"),
    dir: "modelo-prueba",
    files: { encoder: "encoder.onnx", decoder: "decoder.onnx", joiner: "joiner.onnx", tokens: "tokens.txt" },
    ...overrides,
  };
}

function fakeFetch(body: Buffer = ARCHIVE, status = 200): typeof fetch {
  return (async () => {
    // Llega en dos partes, como una descarga de verdad.
    const half = Math.floor(body.length / 2);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(body.subarray(0, half)));
        controller.enqueue(new Uint8Array(body.subarray(half)));
        controller.close();
      },
    });
    return new Response(stream, { status, headers: { "content-length": String(body.length) } });
  }) as typeof fetch;
}

/** Imita a tar: deja la carpeta del modelo (con sus audios de ejemplo) dentro del destino. */
function fakeExtract(model: SpeechModel, seen: string[] = []) {
  return async (archive: string, destination: string) => {
    seen.push(destination);
    assert.deepEqual(readFileSync(archive), ARCHIVE);
    const dir = join(destination, model.dir);
    mkdirSync(join(dir, "test_wavs"), { recursive: true });
    for (const name of Object.values(model.files)) writeFileSync(join(dir, name), "datos");
    writeFileSync(join(dir, "test_wavs", "0.wav"), "audio");
  };
}

test("decodeWav: PCM de 16 bits, varios canales, flotante, 8/24/32 bits y formato extensible", () => {
  const mono = decodeWav(makeWav([[0.5], [-0.5], [0]], 22_050));
  assert.equal(mono.sampleRate, 22_050);
  assert.equal(mono.samples.length, 3);
  assert.ok(Math.abs((mono.samples[0] ?? 0) - 0.5) < 0.001);
  assert.ok(Math.abs((mono.samples[1] ?? 0) + 0.5) < 0.001);

  // Dos canales se mezclan en uno (promedio).
  const stereo = decodeWav(makeWav([[0.5, -0.5], [0.4, 0.2]], 48_000));
  assert.equal(stereo.samples.length, 2);
  assert.ok(Math.abs(stereo.samples[0] ?? 1) < 0.001);
  assert.ok(Math.abs((stereo.samples[1] ?? 0) - 0.3) < 0.001);

  for (const format of [{ float: true, bits: 32 }, { bits: 8 }, { bits: 24 }, { bits: 32 }, { bits: 16, extensible: true }, { float: true, bits: 32, extensible: true }]) {
    const decoded = decodeWav(makeWav([[0.25], [-0.75]], 16_000, format));
    assert.equal(decoded.samples.length, 2, JSON.stringify(format));
    assert.ok(Math.abs((decoded.samples[0] ?? 0) - 0.25) < 0.01, JSON.stringify(format));
    assert.ok(Math.abs((decoded.samples[1] ?? 0) + 0.75) < 0.01, JSON.stringify(format));
  }
});

test("decodeWav: rechaza lo que no es un WAV PCM", () => {
  const invalid = (buffer: Buffer) => assert.throws(() => decodeWav(buffer), (error: unknown) => error instanceof SpeechError && error.status === 400);
  invalid(Buffer.from("esto no es audio"));
  invalid(Buffer.alloc(60));
  const mp3ish = makeWav([[0.1], [0.2]]);
  mp3ish.writeUInt16LE(85, 20); // formato 85 = MP3
  invalid(mp3ish);
  const weirdRate = makeWav([[0.1], [0.2]], 4_000);
  invalid(weirdRate);
});

test("cleanTranscript quita espacios de más", () => {
  assert.equal(cleanTranscript("  Hola,   ¿cómo\n estás?  "), "Hola, ¿cómo estás?");
  assert.equal(cleanTranscript(""), "");
});

test("SpeechEngine: descarga, comprueba el SHA-256, descomprime aparte y queda listo", async () => {
  const temp = tempDir();
  try {
    const model = fakeModel();
    const destinations: string[] = [];
    const engine = new SpeechEngine({ dir: temp.path, model, fetch: fakeFetch(), extract: fakeExtract(model, destinations) });
    const states: SpeechStatus[] = [];
    engine.on("status", (status: SpeechStatus) => states.push(status));
    assert.equal(engine.status().state, "missing");
    assert.equal(engine.status().model, "Modelo de prueba");

    // Dos pedidos a la vez comparten la misma descarga.
    await Promise.all([engine.install(), engine.install()]);
    assert.equal(engine.status().state, "ready");
    assert.deepEqual(
      [...new Set(states.map((status) => status.state))],
      ["downloading", "extracting", "ready"],
    );
    const dir = join(temp.path, "modelos", model.dir);
    for (const name of Object.values(model.files)) assert.ok(existsSync(join(dir, name)), name);
    // Se descomprimió en una carpeta aparte que después se borró, igual que el archivo descargado.
    assert.equal(destinations.length, 1);
    assert.ok(destinations[0]?.includes(".instalando-"));
    assert.deepEqual(readdirSync(join(temp.path, "modelos")), [model.dir]);
    assert.deepEqual(readdirSync(join(temp.path, "descargas")), []);
    assert.equal(existsSync(join(dir, "test_wavs")), false);

    // Otro motor sobre la misma carpeta lo encuentra listo sin descargar nada.
    const again = new SpeechEngine({ dir: temp.path, model, fetch: (() => assert.fail("no debía descargar")) as typeof fetch });
    assert.equal(again.status().state, "ready");
    await again.install();
  } finally {
    temp.cleanup();
  }
});

test("SpeechEngine: un archivo distinto del publicado no se instala", async () => {
  const temp = tempDir();
  try {
    const model = fakeModel();
    const tampered = Buffer.from(ARCHIVE);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    const engine = new SpeechEngine({ dir: temp.path, model, fetch: fakeFetch(tampered), extract: () => assert.fail("no debía descomprimir") });
    await assert.rejects(engine.install(), /SHA-256/);
    const status = engine.status();
    assert.equal(status.state, "error");
    assert.match(status.error ?? "", /no coincide con el publicado/);
    assert.deepEqual(readdirSync(join(temp.path, "descargas")), []);

    // Un tamaño distinto también se rechaza, y un servidor caído da un error claro.
    const short = new SpeechEngine({ dir: temp.path, model, fetch: fakeFetch(ARCHIVE.subarray(1)), extract: () => assert.fail("no") });
    await assert.rejects(short.install(), /bytes/);
    const down = new SpeechEngine({ dir: temp.path, model, fetch: fakeFetch(ARCHIVE, 404), extract: () => assert.fail("no") });
    await assert.rejects(down.install(), /404/);
    assert.equal(down.status().state, "error");
  } finally {
    temp.cleanup();
  }
});

test("SpeechEngine: si falla la descompresión no queda un modelo a medias", async () => {
  const temp = tempDir();
  try {
    const model = fakeModel();
    const engine = new SpeechEngine({
      dir: temp.path,
      model,
      fetch: fakeFetch(),
      extract: async (_archive, destination) => {
        // Deja algo a medias y falla, como un corte a mitad.
        mkdirSync(join(destination, model.dir), { recursive: true });
        writeFileSync(join(destination, model.dir, model.files.encoder), "a medias");
        throw new Error("disco lleno");
      },
    });
    await assert.rejects(engine.install(), /disco lleno/);
    assert.equal(engine.status().state, "error");
    assert.deepEqual(readdirSync(join(temp.path, "modelos")), []);
    assert.deepEqual(readdirSync(join(temp.path, "descargas")), []);

    // Restos de una instalación cortada se limpian al volver a intentarlo, y esta vez funciona.
    mkdirSync(join(temp.path, "modelos", ".instalando-123", model.dir), { recursive: true });
    const retry = new SpeechEngine({ dir: temp.path, model, fetch: fakeFetch(), extract: fakeExtract(model) });
    await retry.install();
    assert.equal(retry.status().state, "ready");
    assert.deepEqual(readdirSync(join(temp.path, "modelos")), [model.dir]);
  } finally {
    temp.cleanup();
  }
});

test("SpeechEngine: transcribe en orden, limpia el texto y valida el audio", async () => {
  const temp = tempDir();
  try {
    const model = fakeModel();
    const calls: Array<{ length: number; rate: number }> = [];
    const engine = new SpeechEngine({
      dir: temp.path,
      model,
      fetch: fakeFetch(),
      extract: fakeExtract(model),
      recognize: async (samples, rate) => {
        calls.push({ length: samples.length, rate });
        await new Promise((resolve) => setTimeout(resolve, calls.length === 1 ? 30 : 0));
        return `  trozo   ${calls.length} `;
      },
    });
    // Sin el modelo: 409, para que la ventana ofrezca descargarlo.
    assert.throws(
      () => engine.transcribe(toneWav(1)),
      (error: unknown) => error instanceof SpeechError && error.status === 409,
    );
    await engine.install();

    // El primero tarda más, pero cada uno recibe su propio texto.
    const [first, second] = await Promise.all([engine.transcribe(toneWav(1)), engine.transcribe(toneWav(0.5, 48_000))]);
    assert.equal(first, "trozo 1");
    assert.equal(second, "trozo 2");
    assert.deepEqual(calls, [
      { length: 16_000, rate: 16_000 },
      { length: 24_000, rate: 48_000 },
    ]);

    // Muy corto: vacío sin llamar al reconocimiento. Demasiado largo: 413.
    assert.equal(await engine.transcribe(toneWav(0.1)), "");
    assert.equal(calls.length, 2);
    assert.throws(
      () => engine.transcribe(silentWav(361, 8_000)),
      (error: unknown) => error instanceof SpeechError && error.status === 413,
    );
    // Un fallo del reconocimiento no traba a los siguientes.
    let fail = true;
    const flaky = new SpeechEngine({
      dir: temp.path,
      model,
      recognize: async () => {
        if (fail) {
          fail = false;
          throw new Error("se cayó");
        }
        return "de nuevo bien";
      },
    });
    await assert.rejects(flaky.transcribe(toneWav(1)), /se cayó/);
    assert.equal(await flaky.transcribe(toneWav(1)), "de nuevo bien");

    await engine.stop();
    assert.throws(
      () => engine.transcribe(toneWav(1)),
      (error: unknown) => error instanceof SpeechError && error.status === 503,
    );
    await assert.rejects(engine.install(), (error: unknown) => error instanceof SpeechError && error.status === 503);
  } finally {
    temp.cleanup();
  }
});

test("SpeechEngine: si borran el modelo con la app abierta vuelve a ofrecer la descarga", async () => {
  const temp = tempDir();
  try {
    const model = fakeModel();
    const engine = new SpeechEngine({ dir: temp.path, model, fetch: fakeFetch(), extract: fakeExtract(model), recognize: async () => "hola" });
    await engine.install();
    assert.equal(engine.status().state, "ready");
    writeFileSync(join(temp.path, "modelos", model.dir, model.files.tokens), "");
    assert.equal(engine.status().state, "missing");
  } finally {
    temp.cleanup();
  }
});
