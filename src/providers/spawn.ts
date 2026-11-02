import { type ChildProcess, execFile } from "node:child_process";

/** Un programa con argumentos fijos de la app (nunca texto del usuario) y su entorno. */
export interface CliCommand {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

export interface CliResult {
  /** Código de salida; null si no llegó a terminar (no arrancó o se cortó por tiempo). */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** El programa no se pudo ejecutar (por ejemplo, no existe). */
  error: Error | null;
}

/**
 * Cómo lanzar un programa. En Windows, lo que instala npm (codex, claude) son archivos .cmd que solo
 * arrancan a través de cmd.exe: para ellos se arma la línea completa, sin pasar los argumentos aparte,
 * así Node no avisa DEP0190. Los .exe y el resto de sistemas arrancan directamente.
 */
export function spawnTarget(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { file: string; args: string[]; shell: boolean } {
  if (platform !== "win32" || /\.(exe|com)$/i.test(command)) return { file: command, args, shell: false };
  return { file: [command, ...args].map(quoteForCmd).join(" "), args: [], shell: true };
}

function quoteForCmd(value: string): string {
  return /^[\w\-.:\\/=@]+$/.test(value) ? value : `"${value.replace(/"/g, '""')}"`;
}

/** Ejecuta un programa corto y devuelve su salida, sin lanzar errores. */
export function runCli(command: CliCommand, timeoutMs: number, maxBuffer = 256 * 1024): Promise<CliResult> {
  const target = spawnTarget(command.command, command.args);
  return new Promise((resolve) => {
    execFile(
      target.file,
      target.args,
      { env: command.env ?? process.env, timeout: timeoutMs, windowsHide: true, shell: target.shell, maxBuffer, encoding: "utf8" },
      (error, stdout, stderr) => {
        const failure = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        const exitCode = failure ? (typeof failure.code === "number" ? failure.code : null) : 0;
        resolve({
          code: exitCode,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          timedOut: Boolean(failure?.killed),
          error: failure && typeof failure.code !== "number" && !failure.killed ? failure : null,
        });
      },
    );
  });
}

/** Detiene un proceso y, en Windows, también los que abrió (cmd.exe deja vivo al programa si solo se corta él). */
export function stopProcessTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    });
    return;
  }
  child.kill("SIGTERM");
}
