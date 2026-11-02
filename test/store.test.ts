import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../src/db.js";
import { tempDir } from "./helpers.js";

function withStore(run: (store: Store) => void): void {
  const temp = tempDir();
  const store = new Store(join(temp.path, "db.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
    temp.cleanup();
  }
}

const agentInput = (name: string) => ({
  name,
  role: "",
  instructions: "",
  provider: "demo" as const,
  model: null,
  effort: null,
  access: "carpeta" as const,
  workspace: `/tmp/${name}`,
});

test("Store crea agentes con nombre único sin distinguir mayúsculas", () => {
  withStore((store) => {
    const ana = store.createAgent(agentInput("Ana"));
    assert.equal(store.findAgentByName("ana")?.id, ana.id);
    assert.throws(() => store.createAgent(agentInput("ANA")));
    const updated = store.updateAgent(ana.id, { role: "Investigadora", paused: true });
    assert.equal(updated.role, "Investigadora");
    assert.equal(updated.paused, true);
  });
});

test("Store encola entregas en orden y respeta la clave de idempotencia", () => {
  withStore((store) => {
    const agent = store.createAgent(agentInput("Beto"));
    const first = store.insertMessage({ agentId: agent.id, role: "user", text: "uno", status: "queued" });
    const second = store.insertMessage({ agentId: agent.id, role: "user", text: "dos", status: "queued" });
    const a = store.enqueueDelivery({ agentId: agent.id, messageId: first.id, senderKind: "user", text: "uno" });
    store.enqueueDelivery({ agentId: agent.id, messageId: second.id, senderKind: "user", text: "dos", idempotencyKey: "k1" });
    const again = store.enqueueDelivery({ agentId: agent.id, messageId: second.id, senderKind: "user", text: "dos", idempotencyKey: "k1" });
    assert.equal(again.created, false);
    assert.equal(store.countQueued(agent.id), 2);
    assert.equal(store.nextQueued(agent.id)?.id, a.delivery.id);
    store.updateDelivery(a.delivery.id, { status: "running" });
    const reconciled = store.reconcileUnfinished();
    assert.equal(reconciled.length, 1);
    assert.equal(store.getDelivery(a.delivery.id)?.status, "interrupted");
    assert.equal(store.cancelQueuedForAgent(agent.id), 1);
    assert.equal(store.countQueued(agent.id), 0);
  });
});

test("Store pagina mensajes del más antiguo al más nuevo", () => {
  withStore((store) => {
    const agent = store.createAgent(agentInput("Caro"));
    for (let index = 0; index < 5; index += 1) store.insertMessage({ agentId: agent.id, role: "user", text: `m${index}`, status: "completed" });
    const last = store.listMessages(agent.id, 2);
    assert.deepEqual(last.map((message) => message.text), ["m3", "m4"]);
    const before = store.listMessages(agent.id, 2, last[0]?.seq);
    assert.deepEqual(before.map((message) => message.text), ["m1", "m2"]);
  });
});

test("Store guarda sesiones y borra las vencidas", () => {
  withStore((store) => {
    store.insertSession("a", Date.now() + 60_000, null);
    store.insertSession("b", Date.now() - 1, "test");
    store.purgeExpiredSessions();
    assert.ok(store.getSession("a"));
    assert.equal(store.getSession("b"), null);
    store.deleteAllSessions();
    assert.equal(store.getSession("a"), null);
  });
});
