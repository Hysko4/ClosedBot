import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import {
  ANTIGRAVITY,
  antigravityArgs,
  antigravityBuild,
  antigravityEnv,
  antigravityProgram,
  cleanStaleTemps,
  installAntigravity,
  makePrivateTemp,
} from "../src/providers/antigravity.js";
import { tempDir } from "./helpers.js";

/** Un .zip mínimo (sin comprimir) con estos archivos. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const nameBytes = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    central.push(header, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** Un fetch que entrega estos bytes en trozos y anota qué se pidió. */
function fakeFetch(body: Buffer, requested: string[] = []): typeof fetch {
  return (async (url: string | URL) => {
    requested.push(String(url));
    const chunks = [body.subarray(0, Math.floor(body.length / 2)), body.subarray(Math.floor(body.length / 2))];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-length": String(body.length) } });
  }) as typeof fetch;
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

test("Antigravity: los datos del registro de ACP para cada sistema", () => {
  assert.equal(ANTIGRAVITY.version, "1.4.5");
  const windows = antigravityBuild("win32", "x64");
  assert.equal(windows?.archive, "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.5-windows-x86_64.zip");
  assert.equal(windows?.cmd, "./agy_acp_server.exe");
  assert.match(windows?.sha256 ?? "", /^[0-9a-f]{64}$/);
  assert.equal(antigravityBuild("linux", "x64")?.cmd, "./agy_acp_server.par");
  assert.equal(antigravityBuild("freebsd", "x64"), null);
  assert.deepEqual(antigravityArgs("win32", "x64"), []);
  assert.deepEqual(antigravityArgs("linux", "x64"), ["--uid="]);
  assert.equal(antigravityProgram("win32"), "agy_acp_server.exe");
  assert.equal(antigravityProgram("darwin"), "agy_acp_server.par");
  // Para chatear, nunca abre el navegador por su cuenta; para entrar, sí.
  assert.deepEqual(antigravityEnv({ PATH: "/bin" }, { chat: true }), { PATH: "/bin", AGY_ACP_FORCE_FILE_STORAGE: "1", BROWSER: "true" });
  assert.deepEqual(antigravityEnv({ PATH: "/bin" }, { chat: false }), { PATH: "/bin", AGY_ACP_FORCE_FILE_STORAGE: "1" });
});

test("Antigravity: «Instalar» descarga el .zip de Google, comprueba su SHA-256 y lo deja listo", async () => {
  const temp = tempDir("closedbot-agy-");
  try {
    const dir = join(temp.path, "programas");
    const archive = zip({ "agy_acp_server.par": "#!/bin/sh\necho hola\n", "LEEME.txt": "otro archivo" });
    const build = { archive: "https://dl.google.com/prueba/agy.zip", cmd: "./agy_acp_server.par", args: [], sha256: sha256(archive) };
    const requested: string[] = [];
    const progress: number[] = [];
    const program = await installAntigravity({
      dir,
      platform: "linux",
      build,
      version: "9.9.9",
      fetch: fakeFetch(archive, requested),
      onProgress: (received, total) => progress.push(received / (total ?? 1)),
    });
    assert.deepEqual(requested, [build.archive]);
    assert.equal(progress.at(-1), 1);
    assert.equal(program, join(dir, "antigravity", "9.9.9", "agy_acp_server.par"));
    assert.ok(statSync(program).mode & 0o100, "se puede ejecutar");
    assert.ok(existsSync(join(dir, "antigravity", "9.9.9", "LEEME.txt")));
    // Sin restos: ni la descarga ni la carpeta a medias.
    assert.deepEqual(readdirSync(join(dir, "descargas")), []);
    assert.deepEqual(readdirSync(join(dir, "antigravity")), ["9.9.9"]);

    // Un archivo distinto del publicado no se instala, y lo que ya estaba sigue igual.
    await assert.rejects(
      installAntigravity({ dir, platform: "linux", build: { ...build, sha256: "0".repeat(64) }, version: "9.9.9", fetch: fakeFetch(archive) }),
      /no coincide con el que publica Google \(SHA-256 distinto\)/,
    );
    assert.ok(existsSync(program));
    assert.deepEqual(readdirSync(join(dir, "descargas")), []);

    // Si al .zip le falta el programa, se dice y no queda nada a medias.
    const empty = zip({ "otro.txt": "x" });
    await assert.rejects(
      installAntigravity({ dir, platform: "linux", build: { ...build, sha256: sha256(empty) }, version: "9.9.10", fetch: fakeFetch(empty) }),
      /al archivo le falta agy_acp_server\.par/,
    );
    assert.deepEqual(readdirSync(join(dir, "antigravity")), ["9.9.9"]);

    // Google responde con un error.
    const failing = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    await assert.rejects(installAntigravity({ dir, platform: "linux", build, fetch: failing }), /el servidor de Google respondió 404/);
    await assert.rejects(installAntigravity({ dir, platform: "freebsd", arch: "x64" }), /no publica Antigravity para este sistema/);
  } finally {
    temp.cleanup();
  }
});

test("Antigravity: el instalador de Ajustes explica cómo se usa", () => {
  const script = fileURLToPath(new URL("../src/providers/install-antigravity.js", import.meta.url));
  const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Uso: install-antigravity <carpeta>/);
});

test("Antigravity: carpetas temporales propias y limpieza de las que quedaron", () => {
  const temp = tempDir("closedbot-agy-tmp-");
  try {
    const root = join(temp.path, "tmp");
    const first = makePrivateTemp(root);
    const second = makePrivateTemp(root);
    assert.notEqual(first, second);
    writeFileSync(join(first, "descomprimido.bin"), "x");
    mkdirSync(join(root, "otra-cosa"));
    cleanStaleTemps(root);
    assert.ok(!existsSync(first) && !existsSync(second), "se borran las carpetas de los procesos");
    assert.ok(existsSync(join(root, "otra-cosa")), "lo demás no se toca");
    cleanStaleTemps(join(temp.path, "no-existe"));
  } finally {
    temp.cleanup();
  }
});
