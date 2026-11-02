import { createHash, randomBytes, randomInt, scrypt as scryptCallback, type ScryptOptions, timingSafeEqual } from "node:crypto";
import type { Store } from "./db.js";

export const SESSION_COOKIE = "cuadrilla_sesion";
export const PASSWORD_META = "password_hash";
export const MIN_PASSWORD_LENGTH = 10;

/** Un código de acceso de un solo uso (el que usa el acceso directo de Windows) vale este tiempo. */
export const LOGIN_CODE_TTL_MS = 2 * 60_000;
const MAX_LOGIN_CODES = 20;

const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;

function scrypt(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/** Hash con scrypt y sal aleatoria: `scrypt$N$r$p$sal$hash`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
  return ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4] ?? "", "base64url");
  const expected = Buffer.from(parts[5] ?? "", "base64url");
  if (!n || !r || !p || !Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (n > 1 << 20 || r > 32 || p > 16 || expected.length < 16 || salt.length < 8) return false;
  const actual = await scrypt(password.normalize("NFKC"), salt, expected.length, { N: n, r, p, maxmem: 256 * 1024 * 1024 });
  return timingSafeEqual(expected, actual);
}

export function validateNewPassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  if (password.length > 1_024) return "La contraseña es demasiado larga.";
  return null;
}

/** Contraseña aleatoria fácil de teclear en el teléfono (4 grupos de 5, unos 99 bits). */
export function generatePassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const groups: string[] = [];
  for (let group = 0; group < 4; group += 1) {
    let chunk = "";
    for (let index = 0; index < 5; index += 1) chunk += alphabet[randomInt(alphabet.length)];
    groups.push(chunk);
  }
  return groups.join("-");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type LoginResult =
  | { ok: true; token: string; maxAgeSeconds: number }
  | { ok: false; reason: "invalid" | "locked" | "unconfigured"; retryAfterSeconds?: number };

export interface AuthOptions {
  store: Store;
  sessionDays: number;
  /** Contraseña por variable de entorno; solo se usa si no hay una guardada con `npm run password`. */
  envPassword?: string | null;
  now?: () => number;
}

/** Contraseña única del dueño, sesiones en SQLite y freno de intentos fallidos. */
export class Auth {
  readonly #store: Store;
  readonly #sessionMs: number;
  readonly #now: () => number;
  readonly #envHash: Promise<string> | null;
  readonly #limiter: LoginLimiter;
  /** Códigos de un solo uso pendientes: hash → vencimiento. Solo en memoria. */
  readonly #codes = new Map<string, number>();

  constructor(options: AuthOptions) {
    this.#store = options.store;
    this.#sessionMs = options.sessionDays * 24 * 60 * 60 * 1_000;
    this.#now = options.now ?? Date.now;
    const envPassword = options.envPassword?.trim() ? options.envPassword : null;
    this.#envHash = envPassword ? hashPassword(envPassword) : null;
    this.#limiter = new LoginLimiter(this.#now);
  }

  async isConfigured(): Promise<boolean> {
    return (await this.#passwordHash()) !== null;
  }

  async login(password: unknown, clientKey: string, userAgent: string | null): Promise<LoginResult> {
    const blocked = this.#limiter.blockedFor(clientKey);
    if (blocked > 0) return { ok: false, reason: "locked", retryAfterSeconds: Math.ceil(blocked / 1_000) };
    const stored = await this.#passwordHash();
    if (!stored) return { ok: false, reason: "unconfigured" };
    const valid = typeof password === "string" && password.length <= 1_024 && (await verifyPassword(password, stored));
    if (!valid) {
      this.#limiter.fail(clientKey);
      return { ok: false, reason: "invalid" };
    }
    this.#limiter.succeed(clientKey);
    return this.#createSession(userAgent);
  }

  /**
   * Crea un código de un solo uso que abre sesión sin contraseña. Solo lo pide el lanzador de escritorio,
   * con el token de control, para abrir la ventana de la app ya dentro.
   */
  createLoginCode(): string {
    const now = this.#now();
    for (const [hash, expiresAt] of this.#codes) if (expiresAt <= now) this.#codes.delete(hash);
    while (this.#codes.size >= MAX_LOGIN_CODES) {
      const oldest = this.#codes.keys().next().value;
      if (oldest === undefined) break;
      this.#codes.delete(oldest);
    }
    const code = randomBytes(32).toString("base64url");
    this.#codes.set(hashToken(code), now + LOGIN_CODE_TTL_MS);
    return code;
  }

  redeemLoginCode(code: unknown, clientKey: string, userAgent: string | null): LoginResult {
    const blocked = this.#limiter.blockedFor(clientKey);
    if (blocked > 0) return { ok: false, reason: "locked", retryAfterSeconds: Math.ceil(blocked / 1_000) };
    const hash = typeof code === "string" && code.length <= 200 ? hashToken(code) : null;
    const expiresAt = hash ? this.#codes.get(hash) : undefined;
    if (hash) this.#codes.delete(hash);
    if (!expiresAt || expiresAt <= this.#now()) {
      this.#limiter.fail(clientKey);
      return { ok: false, reason: "invalid" };
    }
    this.#limiter.succeed(clientKey);
    return this.#createSession(userAgent);
  }

  #createSession(userAgent: string | null): LoginResult {
    const token = randomBytes(32).toString("base64url");
    const now = this.#now();
    this.#store.purgeExpiredSessions(now);
    this.#store.insertSession(hashToken(token), now + this.#sessionMs, userAgent ? userAgent.slice(0, 300) : null);
    return { ok: true, token, maxAgeSeconds: Math.floor(this.#sessionMs / 1_000) };
  }

  validate(token: string | undefined | null): boolean {
    if (!token || token.length > 200) return false;
    const session = this.#store.getSession(hashToken(token));
    return session !== null && session.expiresAt > this.#now();
  }

  logout(token: string | undefined | null): void {
    if (token) this.#store.deleteSession(hashToken(token));
  }

  async #passwordHash(): Promise<string | null> {
    return this.#store.getMeta(PASSWORD_META) ?? (this.#envHash ? await this.#envHash : null);
  }
}

/** Máximo 10 fallos por cliente y 30 en total cada 15 minutos. */
export class LoginLimiter {
  static readonly WINDOW_MS = 15 * 60 * 1_000;
  static readonly PER_CLIENT = 10;
  static readonly GLOBAL = 30;
  readonly #failures = new Map<string, number[]>();
  #global: number[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  blockedFor(clientKey: string): number {
    const now = this.now();
    const local = this.#recent(this.#failures.get(clientKey) ?? [], now);
    this.#global = this.#recent(this.#global, now);
    const waits: number[] = [];
    if (local.length >= LoginLimiter.PER_CLIENT) waits.push((local[0] ?? now) + LoginLimiter.WINDOW_MS - now);
    if (this.#global.length >= LoginLimiter.GLOBAL) waits.push((this.#global[0] ?? now) + LoginLimiter.WINDOW_MS - now);
    return waits.length ? Math.max(...waits) : 0;
  }

  fail(clientKey: string): void {
    const now = this.now();
    const local = this.#recent(this.#failures.get(clientKey) ?? [], now);
    local.push(now);
    this.#failures.set(clientKey, local);
    this.#global.push(now);
    if (this.#failures.size > 1_000) {
      for (const [key, times] of this.#failures) if (!this.#recent(times, now).length) this.#failures.delete(key);
    }
  }

  succeed(clientKey: string): void {
    this.#failures.delete(clientKey);
  }

  #recent(times: number[], now: number): number[] {
    return times.filter((time) => now - time < LoginLimiter.WINDOW_MS);
  }
}

export function serializeSessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return [`${SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeSeconds}`, secure ? "Secure" : null]
    .filter(Boolean)
    .join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  return serializeSessionCookie("", 0, secure);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}
