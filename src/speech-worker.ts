// Proceso aparte del dictado local: carga sherpa-onnx con el modelo y reconoce los trozos de audio
// que le manda el servidor. Si algo del módulo nativo falla, solo se cae este proceso, nunca la app.

import { createRequire } from "node:module";

interface Recognizer {
  createStream(): { acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void };
  decode(stream: unknown): void;
  getResult(stream: unknown): { text?: string };
}

const require = createRequire(import.meta.url);
let recognizer: Recognizer | null = null;

function send(message: Record<string, unknown>): void {
  process.send?.(message);
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

process.on("message", (message: unknown) => {
  if (typeof message !== "object" || message === null) return;
  const data = message as Record<string, unknown>;
  if (data.type === "load") {
    const started = Date.now();
    try {
      const sherpa = require("sherpa-onnx-node") as { OfflineRecognizer: new (config: unknown) => Recognizer };
      recognizer = new sherpa.OfflineRecognizer(data.config);
      send({ type: "ready", ms: Date.now() - started });
    } catch (error) {
      send({ type: "error", message: errorText(error) });
    }
    return;
  }
  if (data.type === "transcribe") {
    const id = data.id;
    try {
      if (!recognizer) throw new Error("el modelo no está cargado");
      if (!(data.samples instanceof Float32Array) || typeof data.sampleRate !== "number") throw new Error("audio inválido");
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples: data.samples, sampleRate: data.sampleRate });
      recognizer.decode(stream);
      send({ type: "result", id, text: recognizer.getResult(stream).text ?? "" });
    } catch (error) {
      send({ type: "error", id, message: errorText(error) });
    }
  }
});

// Sin el servidor no tiene sentido seguir: se cierra con él.
process.on("disconnect", () => process.exit(0));
