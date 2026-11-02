import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { generatePassword, hashPassword, PASSWORD_META, validateNewPassword } from "../auth.js";
import { prepareConfig, setting } from "../config.js";
import { Store } from "../db.js";

/**
 * Crea o cambia la contraseña de ClosedBot y cierra todas las sesiones abiertas.
 *   npm run password                 → la pide dos veces (sin mostrarla)
 *   npm run password -- --generate   → genera una segura y la muestra una sola vez
 *   CLOSEDBOT_NEW_PASSWORD=… npm run password → sin preguntas (para scripts)
 *
 * Para el instalador de escritorio:
 *   --if-missing      no hace nada si ya hay una contraseña
 *   --save <archivo>  con --generate, la guarda en ese archivo en vez de mostrarla
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  if (args.has("--help") || args.has("-h")) {
    console.log("Uso: npm run password [-- --generate [--save archivo]] [--if-missing]");
    return;
  }
  const saveIndex = argv.indexOf("--save");
  const saveTo = saveIndex >= 0 ? argv[saveIndex + 1] : undefined;
  if (saveIndex >= 0 && (!saveTo || saveTo.startsWith("--"))) throw new Error("Falta el archivo después de --save.");
  if (saveTo && !args.has("--generate")) throw new Error("--save solo se usa junto con --generate.");
  // Si los datos siguen en la carpeta de cuando la app se llamaba Cuadrilla, se mudan antes de abrirlos.
  const { config } = prepareConfig(process.env, (_level, message) => console.log(message));
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(config.dataDir, 0o700);
  } catch {
    // Carpeta de otro usuario: se deja como está.
  }

  if (args.has("--if-missing")) {
    if (setting(process.env, "PASSWORD")) {
      console.log("ClosedBot usa la contraseña de la variable CLOSEDBOT_PASSWORD; no cambio nada.");
      return;
    }
    const existing = new Store(config.dbPath);
    try {
      if (existing.getMeta(PASSWORD_META)) {
        console.log("ClosedBot ya tiene contraseña; no la cambio.");
        return;
      }
    } finally {
      existing.close();
    }
  }

  let password: string;
  let show = false;
  if (args.has("--generate")) {
    password = generatePassword();
    show = true;
  } else if (setting(process.env, "NEW_PASSWORD")) {
    password = setting(process.env, "NEW_PASSWORD") ?? "";
  } else if (process.stdin.isTTY) {
    password = await promptHidden("Nueva contraseña: ");
    const repeat = await promptHidden("Repítela: ");
    if (password !== repeat) throw new Error("Las contraseñas no coinciden.");
  } else {
    password = await readFirstLine();
  }

  const problem = validateNewPassword(password);
  if (problem) throw new Error(problem);
  const hash = await hashPassword(password);
  const store = new Store(config.dbPath);
  try {
    store.setMeta(PASSWORD_META, hash);
    store.deleteAllSessions();
  } finally {
    store.close();
  }
  if (show && saveTo) {
    const file = resolve(saveTo);
    writeFileSync(
      file,
      `Contraseña de ClosedBot: ${password}\r\n\r\nLa necesitas para entrar desde otro dispositivo (por ejemplo, el teléfono).\r\nEn este equipo, el acceso directo de ClosedBot entra solo.\r\n`,
      { mode: 0o600 },
    );
    console.log(`Creé una contraseña nueva y la guardé en ${file}.`);
  } else if (show) {
    console.log(`\nTu contraseña de ClosedBot es:\n\n    ${password}\n\nGuárdala en tu gestor de contraseñas: no se volverá a mostrar.`);
  }
  console.log(`Contraseña guardada en ${config.dbPath}. Se cerraron las sesiones abiertas.`);
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    process.stdout.write(question);
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    let value = "";
    const finish = (error?: Error) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u0003" || char === "\u0004") return finish(new Error("Cancelado."));
        if (char === "\u007f" || char === "\b") value = [...value].slice(0, -1).join("");
        else if (char >= " ") value += char;
      }
    };
    input.on("data", onData);
  });
}

function readFirstLine(): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin });
    let done = false;
    rl.once("line", (line) => {
      done = true;
      rl.close();
      resolve(line);
    });
    rl.once("close", () => {
      if (!done) resolve("");
    });
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
