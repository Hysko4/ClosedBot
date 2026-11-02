import { mkdirSync } from "node:fs";
import { prepareConfig } from "../config.js";
import { Store } from "../db.js";
import { SETTINGS_META } from "../service.js";

const USAGE = `Uso: npm run access -- total|carpeta [--if-unset]
  total       todos los agentes trabajan con acceso total: ejecutan comandos sin pedir permiso
  carpeta     cada agente vuelve a su propio nivel de acceso
  --if-unset  no cambia nada si el acceso ya se eligió (en Ajustes o antes)`;

/**
 * Elige el acceso de los agentes sin abrir la app; es lo mismo que el interruptor de Ajustes.
 * El instalador de escritorio lo usa con la app cerrada. Con la app abierta, el cambio vale para
 * los agentes que arranquen después, y Ajustes lo muestra al recargar.
 */
function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const modes = argv.filter((arg) => !arg.startsWith("--"));
  const options = argv.filter((arg) => arg.startsWith("--"));
  const mode = modes[0];
  if (modes.length !== 1 || (mode !== "total" && mode !== "carpeta")) throw new Error(USAGE);
  const unknown = options.filter((option) => option !== "--if-unset");
  if (unknown.length > 0) throw new Error(`Opción desconocida: ${unknown.join(" ")}\n${USAGE}`);

  // Si los datos siguen en la carpeta de cuando la app se llamaba Cuadrilla, se mudan antes de abrirlos.
  const { config } = prepareConfig(process.env, (_level, message) => console.log(message));
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const store = new Store(config.dbPath);
  try {
    const stored = readStored(store.getMeta(SETTINGS_META));
    if (options.includes("--if-unset") && typeof stored.fullAccess === "boolean") {
      const current = stored.fullAccess ? "acceso total para todos" : "cada agente con su nivel";
      console.log(`El acceso de los agentes ya estaba elegido (${current}); no lo cambio.`);
      return;
    }
    stored.fullAccess = mode === "total";
    store.setMeta(SETTINGS_META, JSON.stringify(stored));
  } finally {
    store.close();
  }
  console.log(
    mode === "total"
      ? "Listo: todos los agentes trabajan con acceso total (ejecutan comandos sin pedir permiso)."
      : "Listo: cada agente vuelve a su propio nivel de acceso.",
  );
}

function readStored(raw: string | null): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

try {
  main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
