// Derivado de OpenBot v0.1.11 (src/backend/jsonl.ts), Copyright 2026 Norbert Bodziony,
// con licencia Apache-2.0 (ver licenses/OPENBOT-APACHE-2.0.txt y NOTICE).
// Modificado para ClosedBot: mensajes de error, límite de tamaño de línea y modo tolerante (líneas sueltas).

import { StringDecoder } from "node:string_decoder";
import { isRpcMessage, type RpcMessage } from "./protocol.js";

/** Tamaño máximo aceptado para una línea JSON (protege la memoria ante salidas anómalas). */
const MAX_LINE_BYTES = 32 * 1024 * 1024;

export interface JsonLineOptions {
  /**
   * Si se indica, una línea que no es JSON-RPC se pasa aquí y se sigue con las demás, en vez de lanzar
   * un error (algunos agentes escriben avisos sueltos por stdout).
   */
  onInvalidLine?: (line: string, error: Error) => void;
}

export class JsonLineDecoder {
  readonly #decoder = new StringDecoder("utf8");
  readonly #onInvalidLine: JsonLineOptions["onInvalidLine"];
  #buffer = "";

  constructor(options: JsonLineOptions = {}) {
    this.#onInvalidLine = options.onInvalidLine;
  }

  push(chunk: Uint8Array | string): RpcMessage[] {
    this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.write(Buffer.from(chunk));
    if (this.#buffer.length > MAX_LINE_BYTES && !this.#buffer.includes("\n")) {
      this.#buffer = "";
      throw new Error("El proveedor envió una línea JSON demasiado grande.");
    }
    return this.#drainCompleteLines();
  }

  end(chunk?: Uint8Array | string): RpcMessage[] {
    if (chunk) {
      this.#buffer += typeof chunk === "string" ? chunk : this.#decoder.write(Buffer.from(chunk));
    }
    this.#buffer += this.#decoder.end();
    const messages = this.#drainCompleteLines();
    const trailing = this.#buffer.trim();
    this.#buffer = "";
    if (trailing) this.#collect(messages, trailing);
    return messages;
  }

  #drainCompleteLines(): RpcMessage[] {
    const messages: RpcMessage[] = [];
    let newlineIndex = this.#buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.#buffer.slice(0, newlineIndex).trim();
      this.#buffer = this.#buffer.slice(newlineIndex + 1);
      if (line) this.#collect(messages, line);
      newlineIndex = this.#buffer.indexOf("\n");
    }
    return messages;
  }

  #collect(messages: RpcMessage[], line: string): void {
    if (!this.#onInvalidLine) {
      messages.push(this.#parseLine(line));
      return;
    }
    try {
      messages.push(this.#parseLine(line));
    } catch (error) {
      this.#onInvalidLine(line, error instanceof Error ? error : new Error(String(error)));
    }
  }

  #parseLine(line: string): RpcMessage {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`JSON inválido del proveedor: ${String(error)}`);
    }
    if (!isRpcMessage(parsed)) throw new Error("Mensaje JSON-RPC inválido del proveedor.");
    return parsed;
  }
}
