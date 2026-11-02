import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { test } from "node:test";
import { loadConfig, prepareConfig, setting } from "../src/config.js";
import { Store } from "../src/db.js";
import { tempDir } from "./helpers.js";

test("configuración: CLOSEDBOT_* y, por compatibilidad, CUADRILLA_*", () => {
  assert.equal(setting({ CLOSEDBOT_PORT: "1", CUADRILLA_PORT: "2" }, "PORT"), "1");
  assert.equal(setting({ CUADRILLA_PORT: "2" }, "PORT"), "2");
  assert.equal(setting({}, "PORT"), undefined);
  const temp = tempDir("closedbot-config-");
  try {
    const config = loadConfig({ CUADRILLA_PORT: "9000", CLOSEDBOT_DETECT: "0" }, temp.path, temp.path);
    assert.equal(config.port, 9000);
    assert.equal(config.detectProviders, false);
    assert.equal(config.dataDir, join(temp.path, ".closedbot"));
    assert.equal(config.dbPath, join(temp.path, ".closedbot", "closedbot.db"));
    assert.equal(config.claudeConfigDir, join(temp.path, ".closedbot", "claude"));
    assert.equal(config.legacyDataDir, null);
    assert.throws(() => loadConfig({ CLOSEDBOT_PORT: "abc" }, temp.path, temp.path), /CLOSEDBOT_PORT/);
  } finally {
    temp.cleanup();
  }
});

test("configuración: los datos de ~/.cuadrilla pasan a ~/.closedbot una sola vez", () => {
  const temp = tempDir("closedbot-config-");
  try {
    const legacy = join(temp.path, ".cuadrilla");
    mkdirSync(join(legacy, "agentes", "ana"), { recursive: true });
    writeFileSync(join(legacy, "cuadrilla.db"), "");

    const before = loadConfig({}, temp.path, temp.path);
    assert.equal(before.dataDir, legacy, "mientras no se mude, se usa la carpeta de antes");
    assert.equal(before.legacyDataDir, legacy);
    assert.equal(before.dbPath, join(legacy, "cuadrilla.db"));

    const logs: string[] = [];
    const { config, movedFrom } = prepareConfig({}, (_level, message) => logs.push(message), temp.path);
    assert.equal(movedFrom, legacy);
    assert.equal(config.dataDir, join(temp.path, ".closedbot"));
    assert.equal(config.dbPath, join(temp.path, ".closedbot", "cuadrilla.db"), "conserva su base de datos");
    assert.equal(config.legacyDataDir, null);
    assert.ok(existsSync(join(config.dataDir, "agentes", "ana")));
    assert.equal(existsSync(legacy), false);
    assert.match(logs.join("\n"), /Moví los datos/);

    // Ya mudada: no hay nada más que hacer.
    assert.equal(prepareConfig({}, () => undefined, temp.path).movedFrom, null);

    // Con una carpeta elegida a mano nunca se muda nada.
    mkdirSync(legacy);
    const explicit = prepareConfig({ CLOSEDBOT_DATA_DIR: join(temp.path, "otra") }, () => undefined, temp.path);
    assert.equal(explicit.movedFrom, null);
    assert.equal(explicit.config.dataDir, join(temp.path, "otra"));
    assert.ok(existsSync(legacy));
  } finally {
    temp.cleanup();
  }
});

test("Store: al mudar los datos, los agentes apuntan a su carpeta nueva", () => {
  const temp = tempDir("closedbot-config-");
  try {
    const store = new Store(join(temp.path, "closedbot.db"));
    try {
      const base = { role: "", instructions: "", provider: "demo" as const, model: null, effort: null, access: "carpeta" as const };
      const old = `${sep}casa${sep}.cuadrilla${sep}`;
      store.createAgent({ ...base, name: "Ana", workspace: `${old}agentes${sep}ana` });
      store.createAgent({ ...base, name: "Beto", workspace: `${sep}otra${sep}beto` });
      assert.equal(store.moveWorkspaces(old, `${sep}casa${sep}.closedbot${sep}`), 1);
      const workspaces = store.listAgents().map((agent) => agent.workspace);
      assert.deepEqual(workspaces, [`${sep}casa${sep}.closedbot${sep}agentes${sep}ana`, `${sep}otra${sep}beto`]);
      assert.equal(store.moveWorkspaces(old, `${sep}casa${sep}.closedbot${sep}`), 0, "la segunda vez no cambia nada");
    } finally {
      store.close();
    }
  } finally {
    temp.cleanup();
  }
});
