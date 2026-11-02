import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { verifyPassword } from "../src/auth.js";
import { Store } from "../src/db.js";

const CLI = fileURLToPath(new URL("../src/cli/password.js", import.meta.url));

function run(dataDir: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, CUADRILLA_DATA_DIR: dataDir };
  delete env.CUADRILLA_PASSWORD;
  delete env.CUADRILLA_NEW_PASSWORD;
  return new Promise((resolve) => {
    execFile(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, ...args], { env }, (error, stdout, stderr) => {
      resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

test("contraseña para el instalador: la crea una sola vez y la guarda en un archivo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cuadrilla-cli-"));
  try {
    const dataDir = join(dir, "datos");
    const file = join(dir, "CONTRASENA-CUADRILLA.txt");

    const first = await run(dataDir, ["--generate", "--if-missing", "--save", file]);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /la guardé en/);
    const saved = readFileSync(file, "utf8");
    const password = /Contraseña de Cuadrilla: (\S+)/.exec(saved)?.[1];
    assert.ok(password, "el archivo trae la contraseña");
    assert.ok(!first.stdout.includes(password), "no la muestra en la consola");
    const store = new Store(join(dataDir, "cuadrilla.db"));
    try {
      const hash = store.getMeta("password_hash");
      assert.ok(hash);
      assert.equal(await verifyPassword(password, hash), true);
    } finally {
      store.close();
    }

    const again = await run(dataDir, ["--generate", "--if-missing", "--save", join(dir, "otra.txt")]);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /ya tiene contraseña/);
    assert.equal(existsSync(join(dir, "otra.txt")), false, "no crea otra");
    assert.equal(readFileSync(file, "utf8"), saved);

    const wrong = await run(dataDir, ["--save", file]);
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /solo se usa junto con --generate/);
    const missing = await run(dataDir, ["--generate", "--save"]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /Falta el archivo/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
