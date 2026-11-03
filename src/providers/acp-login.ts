// Inicio de sesión de un agente ACP sin comando propio para entrar (Antigravity, el de Gemini): lo arranca,
// le pide `authenticate` con el método indicado, que abre el navegador para entrar con la cuenta, y termina
// (código 0) cuando la sesión queda guardada. Uso: node acp-login.js <método> <programa> [argumentos…]
// Con CLOSEDBOT_AGENT_TEMP, el agente usa una carpeta temporal propia dentro de esa, que se borra al final.

import { spawn } from "node:child_process";
import { makePrivateTemp, removePrivateTemp, withTemp } from "./antigravity.js";
import { JsonLineDecoder } from "./jsonl.js";
import { isRecord, type RpcMessage } from "./protocol.js";
import { spawnTarget, stopProcessTree } from "./spawn.js";

const [method, command, ...args] = process.argv.slice(2);
if (!method || !command) {
  process.stderr.write("Uso: acp-login <método> <programa> [argumentos…]\n");
  process.exit(2);
}

const tempRoot = process.env.CLOSEDBOT_AGENT_TEMP;
const temp = tempRoot ? makePrivateTemp(tempRoot) : null;
const env = { ...process.env };
delete env.CLOSEDBOT_AGENT_TEMP;
const target = spawnTarget(command, args);
const child = spawn(target.file, target.args, {
  stdio: ["pipe", "pipe", "pipe"],
  shell: target.shell,
  windowsHide: true,
  env: temp ? withTemp(env, temp) : env,
});
// Los avisos sueltos que el agente escriba por stdout se ignoran.
const decoder = new JsonLineDecoder({ onInvalidLine: () => undefined });
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
let nextId = 1;

// Lo que el agente escribe por stderr (por ejemplo, la página para entrar) se pasa tal cual: la app
// muestra el enlace si el navegador no se abrió solo.
child.stderr.on("data", (chunk: Buffer) => process.stdout.write(chunk));
child.stdout.on("data", (chunk: Buffer) => {
  let messages: RpcMessage[] = [];
  try {
    messages = decoder.push(chunk);
  } catch {
    return;
  }
  for (const message of messages) {
    if ("method" in message) {
      // No prestamos archivos ni terminal; tampoco hay nada que aprobar mientras se inicia sesión.
      if ("id" in message && message.id !== undefined) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "No disponible al iniciar sesión." } })}\n`);
      }
      continue;
    }
    const entry = pending.get(Number(message.id));
    if (!entry) continue;
    pending.delete(Number(message.id));
    if (message.error && isRecord(message.error)) entry.reject(new Error(String(message.error.message ?? "error desconocido")));
    else entry.resolve(message.result);
  }
});

function call(name: string, params: unknown): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: name, params })}\n`);
  });
}

let finishing = false;
let exited = false;

/** Cierra el agente, espera a que termine (para poder borrar su carpeta temporal) y sale. */
function finish(code: number, message?: string): void {
  if (finishing) return;
  finishing = true;
  if (message) process.stderr.write(`${message}\n`);
  const done = () => {
    if (temp) removePrivateTemp(temp, 1);
    process.exit(code);
  };
  if (exited) return done();
  child.once("exit", () => setTimeout(done, 200));
  stopProcessTree(child);
  setTimeout(done, 5_000).unref();
}

child.once("error", (error) => {
  exited = true;
  finish(1, `Login failed: No pude abrir ${command}: ${error.message}`);
});
child.once("exit", (code) => {
  exited = true;
  for (const entry of pending.values()) entry.reject(new Error(`el programa terminó (código ${code ?? "?"})`));
  pending.clear();
});
// Si alguien cancela el inicio de sesión desde la app, se cierra también el agente.
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => finish(1));

try {
  await call("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "closedbot", title: "ClosedBot", version: "login" },
  });
  await call("authenticate", { methodId: method });
  process.stdout.write("Sesión iniciada.\n");
  finish(0);
} catch (error) {
  // «Login failed:» lo quita la app, que antepone su propio «No se pudo iniciar sesión».
  finish(1, `Login failed: ${error instanceof Error ? error.message : String(error)}`);
}
