import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { redactDiagnostic } from "./codex.js";
import { type CliCommand, spawnTarget, stopProcessTree } from "./spawn.js";

export type SignInProvider = "claude" | "codex" | "grok" | "gemini";

/** Lo que hace el programa: iniciar sesión (abre el navegador) o instalar el proveedor. */
export type FlowAction = "signIn" | "install";

/** Inicio de sesión en curso, tal como lo ve la interfaz. */
export interface SignInView {
  startedAt: string;
  /**
   * Página para iniciar sesión que imprimió el programa, por si el navegador no se abrió solo. La de
   * Claude termina mostrando un código que se pega en la app.
   */
  url: string | null;
  /** El programa espera que se pegue un código. */
  acceptsCode: boolean;
}

export interface SignInResult {
  ok: boolean;
  /** Lo canceló la persona (o lo reemplazó otro inicio de sesión). */
  cancelled: boolean;
  /** Por qué falló, para mostrarlo; null si salió bien o se canceló. */
  message: string | null;
}

interface Pending {
  child: ChildProcess;
  view: SignInView;
  stdout: string;
  stderr: string;
  timer: NodeJS.Timeout | null;
  cancelled: boolean;
  settled: boolean;
}

type SignInEvents = {
  /** Empezó un inicio de sesión o apareció su página. */
  change: [provider: SignInProvider];
  settled: [provider: SignInProvider, result: SignInResult];
};

export const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
/** Textos de cada tipo de flujo. */
const TEXTS: Record<FlowAction, { spawn: string; timeout: string; failed: string; cut: string; code: string }> = {
  signIn: {
    spawn: "No pude abrir el programa de inicio de sesión",
    timeout: "Se acabó el tiempo para iniciar sesión",
    failed: "No se pudo iniciar sesión",
    cut: "El inicio de sesión se cortó",
    code: "El inicio de sesión terminó con el código",
  },
  install: {
    spawn: "No pude abrir el instalador",
    timeout: "La instalación tardó demasiado",
    failed: "No se pudo instalar",
    cut: "La instalación se cortó",
    code: "La instalación terminó con el código",
  },
};
const OUTPUT_LIMIT = 64 * 1024;
/** Lo que se tarda en llegar la última salida después de que el programa termina. */
const EXIT_FLUSH_MS = 500;

/**
 * Inicios de sesión de los proveedores, como los hace OpenBot: la app ejecuta el comando de inicio de
 * sesión del propio CLI (`claude auth login --claudeai`, `codex login`, `grok login`), que abre el
 * navegador para entrar con la cuenta y guarda la sesión al volver. Hay como mucho uno por proveedor.
 * Con `action: "install"` lleva igual las instalaciones (npm o el instalador oficial).
 */
export class SignInFlows extends EventEmitter<SignInEvents> {
  readonly #pending = new Map<SignInProvider, Pending>();
  readonly #timeoutMs: number;
  readonly #action: FlowAction;

  constructor(options: { timeoutMs?: number; action?: FlowAction } = {}) {
    super();
    this.#timeoutMs = options.timeoutMs ?? SIGN_IN_TIMEOUT_MS;
    this.#action = options.action ?? "signIn";
  }

  view(provider: SignInProvider): SignInView | null {
    return this.#pending.get(provider)?.view ?? null;
  }

  /** Empieza un inicio de sesión; si ya había uno de ese proveedor, lo reemplaza. */
  start(provider: SignInProvider, command: CliCommand, options: { acceptsCode: boolean }): SignInView {
    this.cancel(provider);
    const target = spawnTarget(command.command, command.args);
    const child = spawn(target.file, target.args, {
      env: command.env ?? process.env,
      shell: target.shell,
      windowsHide: true,
      // Sin terminal: Claude Code abre el navegador y espera la vuelta en localhost, o un código pegado por stdin.
      stdio: [options.acceptsCode ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const pending: Pending = {
      child,
      view: { startedAt: new Date().toISOString(), url: null, acceptsCode: options.acceptsCode },
      stdout: "",
      stderr: "",
      timer: null,
      cancelled: false,
      settled: false,
    };
    this.#pending.set(provider, pending);

    const onOutput = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      if (pending[stream].length < OUTPUT_LIMIT) pending[stream] += chunk.toString("utf8");
      // Una instalación no tiene página para entrar (npm imprime enlaces que no vienen al caso).
      if (pending.view.url || pending.settled || this.#action === "install") return;
      const url = findSignInUrl(pending[stream]);
      if (!url) return;
      pending.view = { ...pending.view, url };
      this.emit("change", provider);
    };
    child.stdout?.on("data", onOutput("stdout"));
    child.stderr?.on("data", onOutput("stderr"));
    // Si el programa ya terminó, escribirle un código da EPIPE: no debe tumbar la app.
    child.stdin?.on("error", () => undefined);

    child.once("error", (error) => {
      this.#settle(provider, pending, { ok: false, cancelled: false, message: `${TEXTS[this.#action].spawn}: ${error.message}` });
    });
    child.once("exit", (code, signal) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (pending.cancelled) {
          this.#settle(provider, pending, { ok: false, cancelled: true, message: null });
        } else if (code === 0) {
          this.#settle(provider, pending, { ok: true, cancelled: false, message: null });
        } else {
          this.#settle(provider, pending, { ok: false, cancelled: false, message: failureMessage(pending, code, signal, this.#action) });
        }
      };
      // La salida puede llegar justo después; si el navegador heredó la salida, «close» no llega nunca.
      child.once("close", finish);
      setTimeout(finish, EXIT_FLUSH_MS).unref();
    });

    pending.timer = setTimeout(() => {
      if (pending.settled) return;
      pending.cancelled = true;
      stopProcessTree(child);
      this.#settle(provider, pending, {
        ok: false,
        cancelled: false,
        message: `${TEXTS[this.#action].timeout} (${Math.round(this.#timeoutMs / 60_000)} minutos). Vuelve a intentarlo.`,
      });
    }, this.#timeoutMs);
    pending.timer.unref();

    this.emit("change", provider);
    return pending.view;
  }

  /** Pasa al programa el código que mostró la página de inicio de sesión. Es una credencial: no se guarda ni se registra. */
  submitCode(provider: SignInProvider, code: string): void {
    const pending = this.#pending.get(provider);
    const stdin = pending?.child.stdin;
    if (!pending || pending.settled || !pending.view.acceptsCode || !stdin || stdin.destroyed || !stdin.writable) {
      throw new Error("No hay un inicio de sesión esperando un código. Vuelve a pulsar «Iniciar sesión».");
    }
    stdin.write(`${code}\n`);
  }

  cancel(provider: SignInProvider): boolean {
    const pending = this.#pending.get(provider);
    if (!pending) return false;
    pending.cancelled = true;
    stopProcessTree(pending.child);
    this.#settle(provider, pending, { ok: false, cancelled: true, message: null });
    return true;
  }

  stopAll(): void {
    for (const provider of [...this.#pending.keys()]) this.cancel(provider);
  }

  #settle(provider: SignInProvider, pending: Pending, result: SignInResult): void {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.timer) clearTimeout(pending.timer);
    pending.child.stdin?.destroy();
    if (this.#pending.get(provider) === pending) this.#pending.delete(provider);
    this.emit("settled", provider, result);
  }
}

/**
 * La primera dirección https que imprimió el programa. Claude Code la escribe como «If the browser didn't
 * open, visit: …», a veces dentro de un enlace de terminal (OSC 8), que aquí se descarta.
 */
export function findSignInUrl(output: string): string | null {
  const linked = [...output.matchAll(/\x1b\]8;[^;\x07\x1b]*;(https:\/\/[^\x07\x1b]+)/g)].map((match) => match[1] ?? "");
  const written = [...plainText(output).matchAll(/https:\/\/[^\s"'<>\x00-\x1f]+/g)].map((match) => match[0]);
  for (const candidate of [...linked, ...written]) {
    try {
      const url = new URL(candidate);
      if (url.protocol === "https:" && !url.username && !url.password) return url.toString();
    } catch {
      // No era una dirección válida.
    }
  }
  return null;
}

/** Quita los códigos de color y los enlaces de terminal. */
function plainText(output: string): string {
  return output.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, " ").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

/** Por qué falló, en una línea: lo que el programa escribió en stderr (por ejemplo «Login failed: …»). */
function failureMessage(
  output: { stdout: string; stderr: string },
  code: number | null,
  signal: NodeJS.Signals | null,
  action: FlowAction = "signIn",
): string {
  const lines = (text: string) =>
    plainText(text)
      .split(/\r?\n/)
      // El aviso «Paste code here if prompted >» no lleva salto de línea: lo que sigue va en la misma.
      .map((line) => line.replace(/Paste code here if prompted >\s*/gi, "").trim())
      .filter((line) => line && !/^Opening browser|didn't open, visit:|did not open, navigate|^https?:\/\//i.test(line))
      // De npm: el aviso del registro completo y las novedades no explican nada.
      .filter((line) => !/complete log of this run|^npm (?:notice|warn)\b/i.test(line));
  const errors = lines(output.stderr);
  const candidates = errors.length ? errors : lines(output.stdout);
  const failed =
    candidates.find((line) => /login failed/i.test(line)) ??
    // npm escribe «npm error code EACCES» y más abajo el detalle, «npm error Error: EACCES: permission denied…».
    candidates.find((line) => /^(?:npm (?:error|ERR!) )?Error: /i.test(line)) ??
    candidates.find((line) => /error|failed|denied/i.test(line)) ??
    candidates.at(-1);
  const clean = failed?.replace(/^Login failed:\s*/i, "").replace(/^npm (?:error|ERR!)\s+/i, "");
  const detail = clean ? redactDiagnostic(clean).slice(0, 300) : null;
  const texts = TEXTS[action];
  if (detail) return `${texts.failed}: ${detail}`;
  return signal ? `${texts.cut} (${signal}).` : `${texts.code} ${code ?? "?"}.`;
}
