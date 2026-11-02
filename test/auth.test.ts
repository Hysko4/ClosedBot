import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  Auth,
  generatePassword,
  hashPassword,
  LoginLimiter,
  PASSWORD_META,
  readCookie,
  serializeSessionCookie,
  validateNewPassword,
  verifyPassword,
} from "../src/auth.js";
import { Store } from "../src/db.js";
import { tempDir } from "./helpers.js";

test("hashPassword y verifyPassword", async () => {
  const hash = await hashPassword("una contraseña larga");
  assert.match(hash, /^scrypt\$32768\$8\$1\$/);
  assert.equal(await verifyPassword("una contraseña larga", hash), true);
  assert.equal(await verifyPassword("otra contraseña", hash), false);
  assert.equal(await verifyPassword("x", "basura"), false);
});

test("generatePassword produce 4 grupos válidos", () => {
  const password = generatePassword();
  assert.match(password, /^[a-z2-9]{5}(-[a-z2-9]{5}){3}$/);
  assert.equal(validateNewPassword(password), null);
  assert.match(validateNewPassword("corta") ?? "", /al menos/);
});

test("Auth inicia y cierra sesiones", async () => {
  const temp = tempDir();
  const store = new Store(join(temp.path, "db.sqlite"));
  try {
    const auth = new Auth({ store, sessionDays: 1 });
    assert.equal(await auth.isConfigured(), false);
    assert.deepEqual(await auth.login("lo que sea", "ip", null), { ok: false, reason: "unconfigured" });
    store.setMeta(PASSWORD_META, await hashPassword("correcta-y-larga"));
    const bad = await auth.login("incorrecta", "ip", null);
    assert.equal(bad.ok, false);
    const good = await auth.login("correcta-y-larga", "ip", "navegador");
    assert.ok(good.ok);
    if (!good.ok) return;
    assert.equal(auth.validate(good.token), true);
    assert.equal(auth.validate("inventado"), false);
    auth.logout(good.token);
    assert.equal(auth.validate(good.token), false);
  } finally {
    store.close();
    temp.cleanup();
  }
});

test("Auth usa CLOSEDBOT_PASSWORD solo si no hay una guardada", async () => {
  const temp = tempDir();
  const store = new Store(join(temp.path, "db.sqlite"));
  try {
    const auth = new Auth({ store, sessionDays: 1, envPassword: "desde-el-entorno" });
    assert.ok((await auth.login("desde-el-entorno", "ip", null)).ok);
    store.setMeta(PASSWORD_META, await hashPassword("guardada-con-npm"));
    assert.equal((await auth.login("desde-el-entorno", "ip", null)).ok, false);
    assert.ok((await auth.login("guardada-con-npm", "ip", null)).ok);
  } finally {
    store.close();
    temp.cleanup();
  }
});

test("LoginLimiter bloquea tras 10 fallos y libera al pasar la ventana", () => {
  let now = 1_000_000;
  const limiter = new LoginLimiter(() => now);
  for (let index = 0; index < 10; index += 1) limiter.fail("a");
  assert.ok(limiter.blockedFor("a") > 0);
  assert.equal(limiter.blockedFor("b"), 0);
  now += LoginLimiter.WINDOW_MS + 1;
  assert.equal(limiter.blockedFor("a"), 0);
});

test("cookies de sesión", () => {
  const cookie = serializeSessionCookie("abc", 60, true);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  assert.equal(readCookie("x=1; cuadrilla_sesion=abc; y=2", "cuadrilla_sesion"), "abc");
  assert.equal(readCookie(undefined, "cuadrilla_sesion"), undefined);
});
