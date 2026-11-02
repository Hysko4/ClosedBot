import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Store } from "../src/db.js";
import { SETTINGS_META } from "../src/service.js";

const CLI = fileURLToPath(new URL("../src/cli/access.js", import.meta.url));

function run(dataDir: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, CLOSEDBOT_DATA_DIR: dataDir };
  delete env.CUADRILLA_DATA_DIR;
  return new Promise((resolve) => {
    execFile(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], { env }, (error, stdout, stderr) => {
      resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

function stored(dataDir: string): Record<string, unknown> {
  const store = new Store(join(dataDir, "closedbot.db"));
  try {
    return JSON.parse(store.getMeta(SETTINGS_META) ?? "{}") as Record<string, unknown>;
  } finally {
    store.close();
  }
}

test("acceso de los agentes desde la consola: total, carpeta y «solo si no se eligió»", async () => {
  const dir = mkdtempSync(join(tmpdir(), "closedbot-acceso-"));
  try {
    const dataDir = join(dir, "datos");
    // Con los nombres ya guardados en Ajustes: se conservan.
    mkdirSync(dataDir, { recursive: true });
    const store = new Store(join(dataDir, "closedbot.db"));
    try {
      store.setMeta(SETTINGS_META, JSON.stringify({ botName: "Robi", userName: "Jona" }));
    } finally {
      store.close();
    }

    const first = await run(dataDir, ["total", "--if-unset"]);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /todos los agentes trabajan con acceso total/);
    assert.deepEqual(stored(dataDir), { botName: "Robi", userName: "Jona", fullAccess: true });

    // Si la persona lo apaga después en Ajustes, el instalador no lo vuelve a encender.
    const off = await run(dataDir, ["carpeta"]);
    assert.equal(off.code, 0, off.stderr);
    assert.equal(stored(dataDir).fullAccess, false);
    const again = await run(dataDir, ["total", "--if-unset"]);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /ya estaba elegido/);
    assert.equal(stored(dataDir).fullAccess, false);

    const wrong = await run(dataDir, ["todo"]);
    assert.notEqual(wrong.code, 0);
    assert.match(wrong.stderr, /Uso: npm run access/);
    const unknown = await run(dataDir, ["total", "--forzar"]);
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.stderr, /Opción desconocida: --forzar/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
