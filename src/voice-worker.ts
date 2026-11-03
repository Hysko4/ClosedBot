// Proceso aparte de las voces locales: carga sherpa-onnx con Supertonic 3 y genera el audio de cada trozo de
// texto que le manda el servidor. Si algo del módulo nativo falla, solo se cae este proceso, nunca la app.

import { createRequire } from "node:module";

interface Tts {
  sampleRate: number;
  numSpeakers: number;
  generate(request: Record<string, unknown>): { samples: Float32Array; sampleRate: number };
}

const require = createRequire(import.meta.url);
let tts: Tts | null = null;

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
      const sherpa = require("sherpa-onnx-node") as { OfflineTts: new (config: unknown) => Tts };
      tts = new sherpa.OfflineTts(data.config);
      send({ type: "ready", ms: Date.now() - started, sampleRate: tts.sampleRate, speakers: tts.numSpeakers });
    } catch (error) {
      send({ type: "error", message: errorText(error) });
    }
    return;
  }
  if (data.type === "generate") {
    const id = data.id;
    try {
      if (!tts) throw new Error("el modelo no está cargado");
      const options = { sid: Number(data.sid) || 0, speed: Number(data.speed) || 1 };
      const audio = tts.generate({
        text: String(data.text ?? ""),
        ...options,
        // Una copia propia del audio: se puede mandar al servidor sin depender de la memoria del módulo nativo.
        enableExternalBuffer: false,
        // Sin el idioma en «extra», Supertonic lee todo como inglés.
        generationConfig: { ...options, numSteps: Number(data.numSteps) || 8, extra: { lang: String(data.lang ?? "es") } },
      });
      send({ type: "result", id, samples: audio.samples, sampleRate: audio.sampleRate });
    } catch (error) {
      send({ type: "error", id, message: errorText(error) });
    }
  }
});

// Sin el servidor no tiene sentido seguir: se cierra con él.
process.on("disconnect", () => process.exit(0));
