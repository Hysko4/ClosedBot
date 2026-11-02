import assert from "node:assert/strict";
import { test } from "node:test";
import { JsonLineDecoder } from "../src/providers/jsonl.js";
import { parseSendMessageArgs } from "../src/team.js";

test("JsonLineDecoder une trozos y separa líneas", () => {
  const decoder = new JsonLineDecoder();
  assert.deepEqual(decoder.push('{"method":"a","par'), []);
  const messages = decoder.push('ams":{}}\n{"id":1,"result":{}}\n{"method":"b"}');
  assert.equal(messages.length, 2);
  assert.deepEqual(decoder.end(), [{ method: "b" }]);
});

test("JsonLineDecoder respeta caracteres UTF-8 partidos entre trozos", () => {
  const decoder = new JsonLineDecoder();
  const bytes = Buffer.from('{"method":"ñandú"}\n', "utf8");
  const first = decoder.push(bytes.subarray(0, 13));
  const second = decoder.push(bytes.subarray(13));
  assert.deepEqual([...first, ...second], [{ method: "ñandú" }]);
});

test("JsonLineDecoder rechaza JSON inválido", () => {
  const decoder = new JsonLineDecoder();
  assert.throws(() => decoder.push("no es json\n"), /JSON inválido/);
});

test("parseSendMessageArgs acepta nombres sueltos y alias", () => {
  assert.deepEqual(parseSendMessageArgs({ to: "Ana", text: "hola" }), { to: ["Ana"], text: "hola", replyToMessageId: null });
  assert.deepEqual(parseSendMessageArgs({ recipientAgentIds: ["x"], text: "t", replyToMessageId: "m" }).to, ["x"]);
  assert.throws(() => parseSendMessageArgs({ to: [], text: "x" }), /lista/);
  assert.throws(() => parseSendMessageArgs({ to: ["a"], text: "  " }), /obligatorio/);
});
