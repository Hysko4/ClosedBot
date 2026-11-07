import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync, deflateSync } from "node:zlib";
import { createApp } from "../src/app.js";
import { Auth, hashPassword, PASSWORD_META } from "../src/auth.js";
import { characterDescription, characterFrames, OFFICE_ART_SIZE, PixelLabClient, PixelLabError, pngSize, readZip } from "../src/office.js";
import { PIXELLAB_TOKEN_META, ServiceError } from "../src/service.js";
import { createHarness, type Harness, waitFor } from "./helpers.js";

const publicDir = fileURLToPath(new URL("../../public", import.meta.url));
const PASSWORD = "contraseña-de-prueba";
const TOKEN = "token-bueno";

// ---------- PNG y ZIP de prueba ----------

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** PNG transparente de verdad; `seed` cambia un píxel para distinguir cuadros. */
function png(width = 4, height = 4, seed = 0): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  raw[1] = seed & 0xff;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([signature, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** ZIP mínimo con entradas «stored» o «deflate» (como los que entrega PixelLab). */
function zip(entries: Array<[string, Buffer, ("store" | "deflate")?]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data, mode = "deflate"] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const body = mode === "deflate" ? deflateRawSync(data) : data;
    const method = mode === "deflate" ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** El ZIP de un personaje como lo arma PixelLab: 4 vistas y el caminar de 6 cuadros en cada dirección. */
function characterZip(): Buffer {
  const entries: Array<[string, Buffer, ("store" | "deflate")?]> = [["metadata.json", Buffer.from("{}"), "store"]];
  for (const dir of ["south", "west", "east", "north"]) entries.push([`rotations/${dir}.png`, png(4, 4, dir.length), "store"]);
  for (const dir of ["south", "west", "east", "north"]) {
    // Desordenados a propósito: se ordenan por número.
    for (const frame of [3, 0, 5, 1, 4, 2]) entries.push([`animations/walking-1a2b/${dir}/frame_${String(frame).padStart(3, "0")}.png`, png(4, 4, frame)]);
  }
  entries.push(["animations/idle-9z/south/frame_000.png", png(4, 4, 99)]);
  return zip(entries);
}

// ---------- PixelLab de prueba ----------

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  token: string | null;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Imita la API v2 de PixelLab: trabajos que tardan una consulta y un ZIP que la primera vez responde 423. */
function fakePixelLab(options: { createStatus?: number; animateStatus?: number } = {}) {
  const calls: Call[] = [];
  const polled = new Set<string>();
  const zipped = new Set<string>();
  let created = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? null;
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const path = url.pathname.replace(/^\/v2/, "");
    calls.push({ method, path, body, token });
    if (token !== TOKEN) return json(401, { detail: "Invalid API token" });
    if (method === "GET" && path === "/balance") return json(200, { credits: { type: "usd", usd: 4.2 } });
    if (method === "POST" && path === "/create-character-with-4-directions") {
      if (options.createStatus) return json(options.createStatus, { detail: "Not enough credits" });
      created += 1;
      return json(200, { character_id: `pj-${created}`, background_job_id: `crear-${created}` });
    }
    if (method === "POST" && path === "/animate-character") {
      if (options.animateStatus) return json(options.animateStatus, { detail: [{ msg: "template not available" }] });
      return json(200, { background_job_ids: [`caminar-${body?.character_id}-a`, `caminar-${body?.character_id}-b`] });
    }
    const job = /^\/background-jobs\/(.+)$/.exec(path);
    if (method === "GET" && job) {
      const id = decodeURIComponent(job[1]!);
      if (!polled.has(id)) {
        polled.add(id);
        return json(200, { id, status: "processing" });
      }
      return json(200, { id, status: "completed", last_response: {} });
    }
    const character = /^\/characters\/(.+)\/zip$/.exec(path);
    if (method === "GET" && character) {
      if (!zipped.has(character[1]!)) {
        zipped.add(character[1]!);
        return json(423, { detail: "Character is still being generated" });
      }
      return new Response(new Uint8Array(characterZip()), { status: 200, headers: { "content-type": "application/zip" } });
    }
    return json(404, { detail: "Not found" });
  }) as typeof fetch;
  return { fetch: fetcher, calls, creates: () => calls.filter((call) => call.path === "/create-character-with-4-directions") };
}

async function connected(fake: ReturnType<typeof fakePixelLab>, extra: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  const h = await createHarness({ pixelLab: { fetch: fake.fetch, pollMs: 1 }, ...extra });
  await h.service.setPixelLabToken(TOKEN);
  return h;
}

// ---------- pruebas ----------

test("ZIP de PixelLab: lee entradas stored y deflate, y saca las vistas y el caminar en orden", () => {
  const files = readZip(characterZip());
  assert.equal(files.get("metadata.json")?.toString(), "{}");
  assert.equal(files.size, 1 + 4 + 24 + 1);
  const frames = characterFrames(files);
  assert.deepEqual(Object.keys(frames.rotations).sort(), ["east", "north", "south", "west"]);
  assert.deepEqual(Object.keys(frames.walk).sort(), ["east", "north", "south", "west"], "elige la animación de caminar, no la otra");
  assert.equal(frames.walk.south?.length, 6);
  // Ordenados por número de cuadro (el píxel marcado es el número).
  assert.deepEqual(
    frames.walk.south?.map((frame) => frame.equals(png(4, 4, 0)) ? 0 : [1, 2, 3, 4, 5].find((n) => frame.equals(png(4, 4, n)))),
    [0, 1, 2, 3, 4, 5],
  );
  assert.throws(() => readZip(Buffer.from("esto no es un zip, solo texto suelto")), /dañado/);
  assert.throws(() => readZip(characterZip(), { maxEntries: 5 }), /demasiados/);
  assert.throws(() => readZip(characterZip(), { maxBytes: 200 }), /demasiado grande/);
});

test("PixelLab: describe al personaje con su aspecto o, si no hay, con su rol", () => {
  assert.equal(characterDescription({ id: "a", name: "Ana", role: "Ilustradora", appearance: "  pelo  rojo,\nchaleco verde " }), "pelo rojo, chaleco verde");
  assert.equal(characterDescription({ id: "b", name: "Beto", role: "Programador", appearance: "" }), "office worker: Programador");
  assert.equal(characterDescription({ id: "c", name: "Cata", role: "", appearance: "" }), "friendly office worker");
  assert.equal(characterDescription({ id: "d", name: "Dani", role: "", appearance: "x".repeat(500) }).length, 300);
});

test("PixelLab: el cliente manda el token y explica los errores en español", async () => {
  const fake = fakePixelLab();
  const good = new PixelLabClient(TOKEN, { fetch: fake.fetch, pollMs: 1 });
  assert.deepEqual(await good.balance(), { credits: { type: "usd", usd: 4.2 } });
  assert.equal(fake.calls[0]?.token, TOKEN);
  const created = await good.createCharacter("young woman, red hair");
  assert.deepEqual(created, { characterId: "pj-1", jobId: "crear-1", images: {} });
  const request = fake.calls.at(-1)!;
  assert.equal(request.body?.description, "young woman, red hair");
  assert.deepEqual(request.body?.image_size, { width: 64, height: 64 });
  assert.deepEqual(await good.animateWalk("pj-1"), ["caminar-pj-1-a", "caminar-pj-1-b"]);
  assert.equal(fake.calls.at(-1)?.body?.action_description, "walking");
  await good.waitJob("crear-1");
  assert.equal(fake.calls.filter((call) => call.path === "/background-jobs/crear-1").length, 2, "consulta hasta que termina");
  assert.ok((await good.characterZip("pj-1")).length > 100, "reintenta mientras responde 423");

  const bad = new PixelLabClient("otro", { fetch: fake.fetch });
  await assert.rejects(bad.balance(), (error: unknown) => error instanceof PixelLabError && error.status === 401 && /no aceptó el token/.test(error.message));
  const broke = new PixelLabClient(TOKEN, { fetch: fakePixelLab({ createStatus: 402 }).fetch });
  await assert.rejects(broke.createCharacter("x"), /Se acabaron los créditos de PixelLab/);
  const offline = new PixelLabClient(TOKEN, {
    fetch: (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch,
  });
  await assert.rejects(offline.balance(), /No se pudo conectar con PixelLab/);
});

test("Oficina: sin PixelLab no se dibuja nada; el token se comprueba antes de guardarlo", async () => {
  const fake = fakePixelLab();
  const h = await createHarness({ pixelLab: { fetch: fake.fetch, pollMs: 1 } });
  try {
    const ana = h.service.createAgent({ name: "Ana", role: "Ilustradora", provider: "demo", appearance: "young woman, curly red hair" }, { greet: false });
    assert.equal(ana.appearance, "young woman, curly red hair");
    assert.equal(ana.character, null, "sin token no se pide el personaje");
    assert.deepEqual(h.service.pixelLabStatus(), { configured: false, missing: 1, drawing: [] });
    assert.throws(() => h.service.drawCharacters(), (error: unknown) => error instanceof ServiceError && error.status === 409);

    await assert.rejects(h.service.setPixelLabToken("otro"), (error: unknown) => error instanceof ServiceError && error.status === 400);
    await assert.rejects(h.service.setPixelLabToken("con espacios"), (error: unknown) => error instanceof ServiceError && error.status === 400);
    assert.equal(h.store.getMeta(PIXELLAB_TOKEN_META) ?? "", "", "un token rechazado no se guarda");
    assert.equal(fake.creates().length, 0);

    const status = await h.service.setPixelLabToken(` ${TOKEN} `);
    assert.equal(status.configured, true);
    assert.equal(h.store.getMeta(PIXELLAB_TOKEN_META), TOKEN);
    // El token no viaja a la interfaz.
    assert.ok(!JSON.stringify(h.service.officeSnapshot()).includes(TOKEN));
    assert.ok(!JSON.stringify(h.service.listAgents()).includes(TOKEN));
    assert.ok(!h.events.some((event) => JSON.stringify(event).includes(TOKEN)));

    // Los que faltaban se dibujan cuando el usuario lo pide.
    assert.equal(h.service.drawCharacters(), 1);
    await waitFor(() => h.service.getAgent(ana.id).character?.status === "ready", 5_000, "personaje de Ana");
    assert.equal(fake.creates()[0]?.body?.description, "young woman, curly red hair");

    assert.equal((await h.service.setPixelLabToken(null)).configured, false);
    assert.equal(h.service.getAgent(ana.id).character?.status, "ready", "quitar PixelLab no borra los personajes");
  } finally {
    await h.close();
  }
});

test("Oficina: cada agente nuevo recibe su personaje y se vuelve a dibujar si cambia su aspecto", async () => {
  const fake = fakePixelLab();
  const h = await connected(fake);
  try {
    const ana = h.service.createAgent({ name: "Ana", role: "Ilustradora", provider: "demo", appearance: "young woman, curly red hair" }, { greet: false });
    assert.equal(ana.character?.status, "drawing");
    assert.deepEqual(h.service.pixelLabStatus().drawing, [ana.id]);
    const beto = h.service.createAgent({ name: "Beto", role: "Programador", provider: "demo" }, { greet: false });
    await waitFor(() => h.service.getAgent(ana.id).character?.status === "ready" && h.service.getAgent(beto.id).character?.status === "ready", 5_000, "dos personajes");
    assert.deepEqual(
      fake.creates().map((call) => call.body?.description),
      ["young woman, curly red hair", "office worker: Programador"],
      "de a uno, cada uno con su descripción",
    );
    assert.deepEqual(h.service.pixelLabStatus(), { configured: true, missing: 0, drawing: [] });

    const manifest = h.service.characterManifest(ana.id);
    assert.equal(manifest.version, 1);
    assert.equal(manifest.size, 64);
    assert.deepEqual(manifest.rotations, { south: "south.png", west: "west.png", east: "east.png", north: "north.png" });
    assert.deepEqual(manifest.walk.east, [0, 1, 2, 3, 4, 5].map((index) => `walk-east-${index}.png`));
    assert.ok(readFileSync(h.service.characterFile(ana.id, "walk-east-5.png")).equals(png(4, 4, 5)));
    for (const name of ["manifest.json", "../beto/south.png", "SOUTH.png", "south.png/../x.png"]) {
      assert.throws(() => h.service.characterFile(ana.id, name), (error: unknown) => error instanceof ServiceError && error.status === 404, name);
    }

    // Cambiar otra cosa no gasta créditos; cambiar el aspecto sí lo vuelve a dibujar.
    h.service.updateAgent(ana.id, { role: "Artista" });
    h.service.updateAgent(ana.id, { appearance: "young woman, curly red hair" });
    assert.equal(fake.creates().length, 2);
    h.service.updateAgent(ana.id, { appearance: "young woman, short blue hair, round glasses" });
    assert.equal(h.service.getAgent(ana.id).character?.status, "drawing");
    await waitFor(() => h.service.getAgent(ana.id).character?.version === 2, 5_000, "segundo dibujo");
    assert.equal(fake.creates().at(-1)?.body?.description, "young woman, short blue hair, round glasses");
    assert.equal(h.service.characterManifest(ana.id).version, 2);

    // Redibujar a pedido (el botón de la ficha).
    assert.equal(h.service.drawCharacters([beto.id]), 1);
    await waitFor(() => h.service.getAgent(beto.id).character?.version === 2, 5_000, "Beto otra vez");

    // Al eliminarlo se borran sus cuadros.
    const folder = join(h.dir, "oficina", "personajes", beto.id);
    assert.ok(existsSync(folder));
    await h.service.deleteAgent(beto.id);
    assert.ok(!existsSync(folder));
  } finally {
    await h.close();
  }
});

test("Oficina: sin el caminar igual queda el personaje; sin créditos se avisa una vez y no se insiste", async () => {
  const noWalk = fakePixelLab({ animateStatus: 422 });
  const h = await connected(noWalk);
  try {
    const ana = h.service.createAgent({ name: "Ana", role: "Ilustradora", provider: "demo" }, { greet: false });
    await waitFor(() => h.service.getAgent(ana.id).character?.status === "ready", 5_000, "personaje sin caminar");
    const manifest = h.service.characterManifest(ana.id);
    assert.equal(manifest.rotations.south, "south.png");
  } finally {
    await h.close();
  }

  const broke = fakePixelLab({ createStatus: 402 });
  const g = await connected(broke);
  try {
    const ids = ["Ana", "Beto", "Cata"].map((name) => g.service.createAgent({ name, role: "Prueba", provider: "demo" }, { greet: false }).id);
    await waitFor(() => ids.every((id) => g.service.getAgent(id).character?.status === "failed"), 5_000, "fallan los tres");
    assert.equal(broke.creates().length, 1, "después del primero no se insiste");
    assert.match(g.service.getAgent(ids[0]!).character?.error ?? "", /Se acabaron los créditos/);
    const notices = g.events.filter((event) => event.type === "notice" && /Personaje de/.test(event.message));
    assert.equal(notices.length, 1, "un solo aviso");
    assert.throws(() => g.service.characterManifest(ids[0]!), (error: unknown) => error instanceof ServiceError && error.status === 404);
    assert.equal(g.service.pixelLabStatus().missing, 3);
  } finally {
    await g.close();
  }
});

test("Oficina: Claude Bot le da el aspecto a los agentes que crea y lo puede cambiar", async () => {
  const h = await createHarness({ mainAgent: true });
  try {
    const mainId = h.service.mainAgentId() as string;
    const { message } = h.service.sendUserMessage(mainId, "/crear Ana | Ilustradora | Juegos | young woman, curly red hair, green sweater");
    await waitFor(() => h.store.getMessage(message.id)?.status === "completed", 5_000, "crear");
    const ana = h.store.findAgentByName("Ana");
    assert.equal(ana?.appearance, "young woman, curly red hair, green sweater");

    const again = h.service.sendUserMessage(mainId, "/ajustar Ana | | old man with a white beard");
    await waitFor(() => h.store.getMessage(again.message.id)?.status === "completed", 5_000, "ajustar");
    assert.equal(h.store.findAgentByName("Ana")?.appearance, "old man with a white beard");
    assert.ok(h.service.listMessages(mainId).some((item) => item.text === "Ajustó a «Ana»: aspecto"));
  } finally {
    await h.close();
  }
});

test("Oficina: el arte en alta resolución se baja una vez y se descarta si no es el dibujo esperado", async () => {
  const requested: string[] = [];
  const big = png(OFFICE_ART_SIZE.width, OFFICE_ART_SIZE.height);
  assert.deepEqual(pngSize(big), OFFICE_ART_SIZE);
  const artFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith("/chico.png")) return new Response(new Uint8Array(png(64, 64)), { status: 200 });
    return new Response(new Uint8Array(big), { status: 200 });
  }) as typeof fetch;

  const h = await createHarness({ officeArt: { sources: { salon: "https://arte.test/salon.png", sala: "https://arte.test/sala.png" }, fetch: artFetch } });
  try {
    assert.equal(h.service.officeSnapshot().art.hd, false);
    await waitFor(() => h.events.some((event) => event.type === "office"), 5_000, "arte listo");
    const snapshot = h.service.officeSnapshot();
    assert.equal(snapshot.art.hd, true);
    assert.ok(snapshot.art.version > 0);
    assert.ok(readFileSync(h.service.officeArtFile("salon")!).equals(big));
    assert.equal(h.service.officeArtFile("jefe"), null, "lo que no se baja sale de la app");
    assert.equal(requested.length, 2, "una vez");
  } finally {
    await h.close();
  }

  requested.length = 0;
  const g = await createHarness({ officeArt: { sources: { salon: "https://arte.test/chico.png" }, fetch: artFetch } });
  try {
    g.service.officeSnapshot();
    await waitFor(() => requested.length === 1, 5_000, "intento");
    await new Promise((resolve) => setTimeout(resolve, 50));
    g.service.officeSnapshot();
    assert.equal(requested.length, 1, "no reintenta enseguida");
    assert.equal(g.service.officeSnapshot().art.hd, false);
    assert.equal(g.service.officeArtFile("salon"), null);
  } finally {
    await g.close();
  }
});

test("Oficina HTTP: la foto del momento, el arte con caché, PixelLab y los cuadros de cada personaje", async () => {
  const fake = fakePixelLab();
  const h = await createHarness({ mainAgent: true, pixelLab: { fetch: fake.fetch, pollMs: 1 } });
  h.store.setMeta(PASSWORD_META, await hashPassword(PASSWORD));
  const app = createApp({
    service: h.service,
    auth: new Auth({ store: h.store, sessionDays: 1 }),
    publicDir,
    sharedDir: join(h.dir, "compartida"),
    workspacesDir: join(h.dir, "agentes"),
    maxHops: 6,
    secureCookies: "never",
  });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  let cookie = "";
  const call = async (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { cookie, ...(init.headers ?? {}) };
    if (init.method && init.method !== "GET") headers["x-cuadrilla"] = "1";
    if (init.body !== undefined) headers["content-type"] = "application/json";
    return fetch(base + path, { method: init.method ?? "GET", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  };
  try {
    assert.equal((await call("/api/office")).status, 401, "con sesión");
    const login = await call("/api/login", { method: "POST", body: { password: PASSWORD } });
    cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    const snapshot = (await (await call("/api/office")).json()) as Record<string, any>;
    assert.equal(snapshot.board, "");
    assert.deepEqual(snapshot.images, []);
    assert.deepEqual(snapshot.pixelLab, { configured: false, missing: 1, drawing: [] });

    // El arte que trae la app, con etag.
    const art = await call("/api/office/art/salon?v=0");
    assert.equal(art.status, 200);
    assert.equal(art.headers.get("content-type"), "image/webp");
    assert.ok(Buffer.from(await art.arrayBuffer()).equals(readFileSync(join(publicDir, "office", "salon.webp"))));
    const etag = art.headers.get("etag") ?? "";
    assert.ok(etag);
    assert.equal((await call("/api/office/art/salon?v=0", { headers: { "if-none-match": etag } })).status, 304);
    for (const name of ["nada", "..%2Fapp.js", "salon.webp"]) assert.equal((await call(`/api/office/art/${name}`)).status, 404, name);

    // PixelLab.
    assert.equal((await call("/api/office/characters", { method: "POST", body: {} })).status, 409);
    assert.equal((await call("/api/pixellab", { method: "PUT", body: { token: "" } })).status, 400);
    const rejected = await call("/api/pixellab", { method: "PUT", body: { token: "otro" } });
    assert.equal(rejected.status, 400, "un token malo no es un error de sesión");
    assert.match(((await rejected.json()) as { error: string }).error, /no aceptó ese token/);
    const saved = (await (await call("/api/pixellab", { method: "PUT", body: { token: TOKEN } })).json()) as Record<string, any>;
    assert.equal(saved.pixelLab.configured, true);
    assert.ok(!JSON.stringify(saved).includes(TOKEN));

    const mainId = h.service.mainAgentId() as string;
    assert.equal((await call(`/api/agents/${mainId}/character`)).status, 404, "aún sin personaje");
    const queued = (await (await call("/api/office/characters", { method: "POST", body: {} })).json()) as Record<string, any>;
    assert.equal(queued.queued, 1);
    await waitFor(() => h.service.getAgent(mainId).character?.status === "ready", 5_000, "personaje de Claude Bot");
    const manifest = (await (await call(`/api/agents/${mainId}/character`)).json()) as Record<string, any>;
    assert.equal(manifest.rotations.south, "south.png");
    const frame = await call(`/api/agents/${mainId}/character/walk-south-0.png`);
    assert.equal(frame.status, 200);
    assert.equal(frame.headers.get("content-type"), "image/png");
    assert.ok(Buffer.from(await frame.arrayBuffer()).equals(png(4, 4, 0)));
    for (const name of ["manifest.json", "..%2F..%2Fclosedbot.db", "nada.png"]) {
      assert.equal((await call(`/api/agents/${mainId}/character/${name}`)).status, 404, name);
    }
    assert.equal((await call("/api/agents/nadie/character/south.png")).status, 404);

    // Volver a dibujarlo desde la ficha.
    assert.deepEqual(await (await call(`/api/agents/${mainId}/character`, { method: "POST" })).json(), { queued: 1 });
    await waitFor(() => h.service.getAgent(mainId).character?.version === 2, 5_000, "redibujado");

    assert.equal(((await (await call("/api/pixellab", { method: "DELETE" })).json()) as Record<string, any>).pixelLab.configured, false);
  } finally {
    app.closeStreams();
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    await h.close();
  }
});

test("Oficina (interfaz): la escena llena el espacio que hay, también en un monitor vertical, y con muchos equipos se desplaza", async () => {
  type Arrangement = {
    fill: boolean;
    cols: number;
    rows: number;
    scale: number;
    worldW: number;
    worldH: number;
    ox: number;
    oy: number;
    slots: Array<{ x: number; y: number }>;
  };
  const office = (await import(new URL("../../public/office.js", import.meta.url).href)) as {
    arrangeOffice: (input: { count: number; slotW: number; slotH: number; width: number; height: number }) => Arrangement;
  };
  // El lugar de una plataforma de 2×2 (hasta 4 agentes) con su tarjeta: como lo calcula la Oficina.
  const slot = { slotW: 416, slotH: 419 };
  const arrange = (count: number, width: number, height: number) => office.arrangeOffice({ count, ...slot, width, height });
  const fits = (a: Arrangement, width: number, height: number) =>
    a.worldW * a.scale <= width + 0.5 && a.worldH * a.scale <= height + 0.5 && a.ox >= -0.5 && a.oy >= 0;

  // Como en la captura: Claude Bot y un equipo en 800×861. Antes quedaban arriba a escala 0,58 y el resto vacío.
  const yours = arrange(2, 799, 861);
  assert.equal(yours.fill, true);
  assert.ok(yours.scale > 0.95, `más grandes: ${yours.scale}`);
  assert.ok(fits(yours, 799, 861));
  assert.ok(yours.worldH * yours.scale >= 861 * 0.99, "usa todo el alto");
  assert.ok(Math.abs(yours.slots[1]!.x - yours.slots[0]!.x) > 300 && yours.slots[1]!.y > yours.slots[0]!.y, "en diagonal: usa también el ancho");

  // Monitor vertical (1080×1920): una columna en zigzag que llena el alto.
  const tall = arrange(4, 812, 1866);
  assert.deepEqual([tall.fill, tall.cols, tall.rows], [true, 1, 4]);
  assert.ok(tall.scale > 1, `${tall.scale}`);
  assert.ok(tall.worldH * tall.scale >= 1866 * 0.99 && fits(tall, 812, 1866));

  // Pantalla ancha: una fila, alternando arriba y abajo.
  const wide = arrange(3, 1652, 1026);
  assert.deepEqual([wide.fill, wide.cols, wide.rows], [true, 3, 1]);
  assert.ok(wide.slots[1]!.y > wide.slots[0]!.y, "la del medio va más abajo");
  assert.ok(fits(wide, 1652, 1026));

  // Una sola plataforma: centrada y más grande, hasta un tope.
  const alone = arrange(1, 1012, 528);
  assert.ok(alone.fill && Math.abs(alone.ox - (1012 - alone.worldW * alone.scale) / 2) < 0.5);
  assert.equal(arrange(1, 3000, 3000).scale, 1.8);

  // Muchos equipos: llenan el ancho como antes (hasta 3 columnas) y la Oficina se desplaza.
  const many = arrange(10, 1012, 766);
  assert.deepEqual([many.fill, many.cols, many.oy], [false, 3, 0]);
  assert.ok(Math.abs(many.scale - 1012 / (416 * 3 + 416 * 0.32)) < 1e-9);
  const phone = arrange(3, 390, 612);
  assert.deepEqual([phone.fill, phone.cols], [false, 1], "en el teléfono, una columna que se desplaza");

  // En cualquier tamaño: si cabe, todo queda dentro de la pantalla y ningún lugar pisa a otro.
  for (const width of [320, 480, 800, 1012, 1400, 1900]) {
    for (const height of [360, 600, 861, 1200, 1866]) {
      for (let count = 1; count <= 9; count += 1) {
        const a = arrange(count, width, height);
        assert.equal(a.slots.length, count);
        if (a.fill) assert.ok(fits(a, width, height), `${count} en ${width}×${height}`);
        for (let i = 0; i < count; i += 1) {
          for (let j = i + 1; j < count; j += 1) {
            const p = a.slots[i]!;
            const q = a.slots[j]!;
            assert.ok(Math.abs(p.x - q.x) >= slot.slotW - 1e-6 || Math.abs(p.y - q.y) >= slot.slotH - 1e-6, `${count} en ${width}×${height}: ${i} y ${j} se pisan`);
          }
        }
      }
    }
  }
});

test("Oficina (interfaz): el encabezado dice solo «Oficina», sin el resumen ni el botón «Nuevo agente»", () => {
  const html = readFileSync(join(publicDir, "index.html"), "utf8");
  const header = html.match(/<header class="office-header">([\s\S]*?)<\/header>/)?.[1] ?? "";
  assert.match(header, /<div class="office-heading">\s*<h2 class="office-title">Oficina<\/h2>\s*<\/div>/);
  assert.doesNotMatch(html, /office-status/);
  // Crear un agente sigue en el «+» de cada tarjeta y en el clic derecho, no arriba.
  assert.doesNotMatch(header, /data-office-action="create"|Nuevo agente|office-new/);
  const script = readFileSync(join(publicDir, "office.js"), "utf8");
  assert.doesNotMatch(script, /office-status|preguntas? para ti|todos libres/);
});

test("Oficina (interfaz): el canal de un equipo se abre abajo y el chat de abajo usa todo el ancho", () => {
  const script = readFileSync(join(publicDir, "app.js"), "utf8");
  // La ruta del canal abajo existe y la usan la tarjeta, la plataforma y «Abrir el chat del equipo».
  assert.match(script, /#\\\/oficina\\\/c\\\//);
  assert.match(script, /openChannel: openChannelInOffice/);
  assert.match(script, /function openChannelInOffice\(channelId\) \{\s*if \(!wideLayout\(\)\) return void navigateChannel\(channelId\);/);
  const css = readFileSync(join(publicDir, "styles.css"), "utf8");
  assert.match(css, /body\.office-docked \.thread,\s*body\.office-docked \.queue-bar,\s*body\.office-docked \.composer \{\s*max-width: none;\s*\}/);
  const office = readFileSync(join(publicDir, "office.js"), "utf8");
  assert.match(office, /selectTeam\(channelId\)/);
});

test("Oficina (interfaz): una plataforma por grupo con un escritorio por integrante, y el resto en «Sin grupo»", async () => {
  const office = (await import(new URL("../../public/office.js", import.meta.url).href)) as {
    planOffice: (input: unknown) => { panels: Array<Record<string, any>>; home: Map<string, string> };
    platformSeats: (ids: string[]) => Array<{ i: number; j: number }>;
    platformSide: (count: number) => number;
    boardLines: (text: string) => string[];
    activityIcon: (text: string, payload?: unknown) => string;
  };
  const agents = ["main", "ana", "beto", "cata", "dani", "eli"].map((id) => ({ id }));
  const channels = [
    { id: "juegos", name: "Creación de Juegos", memberIds: ["ana", "beto", "cata", "main"], leadId: "beto" },
    { id: "mkt", name: "Marketing", memberIds: ["dani", "ana"], leadId: "ana" },
  ];
  const { panels, home } = office.planOffice({ agents, channels, mainId: "main" });
  assert.deepEqual(
    panels.map((panel) => [panel.title, panel.seats.map((seat: { agentId: string }) => seat.agentId)]),
    [
      ["Claude Bot", ["main"]],
      ["Creación de Juegos", ["beto", "ana", "cata"]],
      ["Marketing", ["ana", "dani"]],
      ["Sin grupo", ["eli"]],
    ],
    "Claude Bot en el salón, el encargado primero",
  );
  assert.equal(home.get("ana"), "mkt", "su sala es la que encarga");
  assert.equal(home.get("cata"), "juegos");
  assert.equal(home.has("main"), false);
  assert.equal(home.has("eli"), false);

  // Un escritorio por integrante: la plataforma crece con el equipo y nadie comparte celda.
  for (let n = 1; n <= 16; n += 1) {
    const seats = office.platformSeats(Array.from({ length: n }, (_, index) => `a${index}`));
    const side = office.platformSide(n);
    assert.equal(seats.length, n);
    assert.ok(side * side >= n, `${n} caben en ${side}×${side}`);
    assert.equal(new Set(seats.map((seat) => `${seat.i},${seat.j}`)).size, n, `${n}: celdas repetidas`);
    assert.ok(seats.every((seat) => seat.i < side && seat.j < side));
  }
  assert.equal(office.platformSide(1), 2);
  assert.equal(office.platformSide(9), 3);

  assert.deepEqual(office.boardLines("## Objetivo\n- **Ana**: cartas\n\n1) Probar\n"), ["Objetivo", "• Ana: cartas", "1) Probar"]);
  assert.equal(office.activityIcon("Ejecutó: npm test"), "terminal");
  assert.equal(office.activityIcon("Actualizó la pizarra", { kind: "board-updated" }), "board");
});

test("Oficina: el «?» queda hasta que respondes la pregunta, tocando una opción o escribiéndole", async () => {
  const h = await createHarness();
  try {
    const dani = h.service.createAgent({ name: "Dani", role: "Redactora", provider: "demo" }, { greet: false });
    const beto = h.service.createAgent({ name: "Beto", role: "Programador", provider: "demo" }, { greet: false });
    const asking = () => h.service.officeSnapshot().asking;
    h.service.sendUserMessage(dani.id, "/pregunta [¿Qué tono usamos? | Divertido | Serio]");
    h.service.sendUserMessage(beto.id, "/pregunta [¿En qué lenguaje? | TypeScript | Python]");
    await waitFor(() => asking().length === 2, 5_000, "dos preguntas");

    // Le escribes a Dani en vez de tocar una opción.
    h.service.sendUserMessage(dani.id, "Mejor uno neutro");
    assert.deepEqual(asking(), [beto.id]);

    // Beto: tocas una opción.
    const decision = h.service.listMessages(beto.id).filter((item) => item.role === "decision").at(-1)!;
    await h.service.answerDecision(beto.id, decision.id, 0);
    assert.deepEqual(asking(), []);
  } finally {
    await h.close();
  }
});

test("Oficina: arrastrar a un agente lo cambia de equipo, con su sección, y el canal vacío pasa a «Canales eliminados»", async () => {
  const h = await createHarness({ mainAgent: true });
  try {
    const s = h.service;
    const mainId = s.listAgents().find((agent) => agent.main)!.id;
    const make = (name: string, project: string) => s.createAgent({ name, role: "Prueba", provider: "demo", project }, { greet: false });
    const ana = make("Ana", "Creación de Juegos");
    const beto = make("Beto", "Creación de Juegos");
    const dani = make("Dani", "Marketing");
    const eli = make("Eli", "");
    const fer = make("Fer", "Investigación");
    const juegos = s.createChannel({ name: "Creación de Juegos", memberIds: [ana.id, beto.id, mainId], leadId: ana.id });
    const mkt = s.createChannel({ name: "Marketing", memberIds: [dani.id], leadId: dani.id });
    const channel = (id: string) => s.getChannel(id);

    // De un equipo a otro: deja el de origen (con un nuevo encargado que no es Claude Bot) y su sección sigue al equipo.
    let move = s.moveAgentToTeam(ana.id, { from: juegos.id, to: mkt.id });
    assert.deepEqual(channel(mkt.id).memberIds, [dani.id, ana.id]);
    assert.equal(channel(mkt.id).leadId, dani.id, "el encargado del destino no cambia");
    assert.deepEqual(channel(juegos.id).memberIds, [beto.id, mainId]);
    assert.equal(channel(juegos.id).leadId, beto.id, "el nuevo encargado es un agente, no Claude Bot");
    assert.equal(move.agent.project, "Marketing");
    assert.equal(move.team?.id, mkt.id);
    assert.deepEqual(move.left, ["Creación de Juegos"]);
    assert.deepEqual(move.archived, []);

    // Desde «Sin grupo» y sin sección: entra al equipo y toma su sección.
    move = s.moveAgentToTeam(eli.id, { from: null, to: juegos.id });
    assert.ok(channel(juegos.id).memberIds.includes(eli.id));
    assert.equal(move.agent.project, "Creación de Juegos");

    // Una sección propia (que no es la del equipo) no se toca.
    move = s.moveAgentToTeam(fer.id, { to: mkt.id });
    assert.equal(move.agent.project, "Investigación");

    // A un equipo nuevo, con él de encargado: el de origen se queda sin agentes y pasa a «Canales eliminados».
    move = s.moveAgentToTeam(dani.id, { from: mkt.id, name: "Ventas" });
    assert.equal(move.team?.name, "Ventas");
    assert.deepEqual(move.team?.memberIds, [dani.id]);
    assert.equal(move.team?.leadId, dani.id);
    assert.equal(move.agent.project, "Ventas");
    assert.deepEqual(move.archived, []);
    s.moveAgentToTeam(ana.id, { from: mkt.id, to: move.team!.id });
    move = s.moveAgentToTeam(fer.id, { from: mkt.id, to: juegos.id });
    assert.deepEqual(move.archived, ["Marketing"]);
    assert.ok(s.listDeletedChannels().some((item) => item.id === mkt.id), "Marketing quedó vacío");
    assert.deepEqual(s.listDeletedChannels().find((item) => item.id === mkt.id)?.memberIds, [fer.id], "al restaurarlo vuelve con él");

    // A «Sin grupo»: deja todos sus equipos y la sección que venía del equipo.
    s.moveAgentToTeam(beto.id, { from: juegos.id, to: s.listChannels().find((item) => item.name === "Ventas")!.id });
    s.updateChannel(juegos.id, { memberIds: [beto.id, eli.id, mainId] });
    move = s.moveAgentToTeam(beto.id, { from: juegos.id, to: null });
    assert.equal(move.team, null);
    assert.equal(s.listChannels().filter((item) => item.memberIds.includes(beto.id)).length, 0);
    assert.equal(move.agent.project, "", "su sección era la del equipo");
    assert.deepEqual(move.left.sort(), ["Creación de Juegos", "Ventas"]);

    // Lo que no se puede.
    assert.throws(() => s.moveAgentToTeam(mainId, { to: juegos.id }), (error: unknown) => error instanceof ServiceError && error.status === 409 && /salón/.test(error.message));
    assert.throws(() => s.moveAgentToTeam(eli.id, { to: mkt.id }), /Canales eliminados/);
    assert.throws(() => s.moveAgentToTeam(eli.id, { name: "Creación de Juegos" }), /Ya existe/);
    assert.throws(() => s.moveAgentToTeam(eli.id, { to: "nada" }), (error: unknown) => error instanceof ServiceError && error.status === 404);
    const crowd = Array.from({ length: 11 }, (_, index) => make(`Extra ${index}`, "").id);
    const full = s.createChannel({ name: "Lleno", memberIds: [...crowd, eli.id] });
    assert.throws(() => s.moveAgentToTeam(fer.id, { to: full.id }), /12 agentes/);
    // Soltarlo en su mismo equipo no cambia nada.
    const same = s.moveAgentToTeam(eli.id, { from: full.id, to: full.id });
    assert.deepEqual(same.left, []);
    assert.equal(channel(full.id).memberIds.length, 12);
  } finally {
    await h.close();
  }
});

test("Oficina HTTP: POST /api/agents/:id/team mueve al agente y responde los errores en español", async () => {
  const h = await createHarness({ mainAgent: true });
  h.store.setMeta(PASSWORD_META, await hashPassword(PASSWORD));
  const app = createApp({ service: h.service, auth: new Auth({ store: h.store, sessionDays: 1 }), publicDir, sharedDir: join(h.dir, "compartida"), workspacesDir: join(h.dir, "agentes"), maxHops: 6, secureCookies: "never" });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  try {
    let cookie = "";
    const call = (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: "POST", headers: { cookie, "x-cuadrilla": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
    const login = await call("/api/login", { password: PASSWORD });
    cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const ana = h.service.createAgent({ name: "Ana", role: "Prueba", provider: "demo" }, { greet: false });
    const response = await call(`/api/agents/${ana.id}/team`, { name: "Arte" });
    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, any>;
    assert.equal(body.team.name, "Arte");
    assert.equal(body.agent.project, "Arte");
    const mainId = h.service.listAgents().find((agent) => agent.main)!.id;
    const refused = await call(`/api/agents/${mainId}/team`, { to: body.team.id });
    assert.equal(refused.status, 409);
    assert.match(((await refused.json()) as Record<string, any>).error, /Claude Bot/);
  } finally {
    app.closeStreams();
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    await h.close();
  }
});

test("Oficina (interfaz): el robot se sienta en el equipo donde lo dejaste y el aviso de soltar dice qué pasará", async () => {
  const office = (await import(new URL("../../public/office.js", import.meta.url).href)) as {
    planOffice: (input: unknown) => { panels: Array<Record<string, any>>; home: Map<string, string> };
    dropVerdict: (name: string, from: unknown, target: unknown) => { ok: boolean; text: string };
  };
  const agents = ["main", "ana", "beto", "dani"].map((id) => ({ id }));
  const channels = [
    { id: "juegos", name: "Creación de Juegos", memberIds: ["ana", "beto"], leadId: "beto" },
    { id: "mkt", name: "Marketing", memberIds: ["dani", "ana"], leadId: "dani" },
  ];
  assert.equal(office.planOffice({ agents, channels, mainId: "main" }).home.get("ana"), "juegos", "sin preferencia: el primer equipo donde está");
  const prefer = new Map([
    ["ana", "mkt"],
    ["beto", "mkt"],
    ["main", "juegos"],
  ]);
  const { home } = office.planOffice({ agents, channels, mainId: "main", prefer });
  assert.equal(home.get("ana"), "mkt", "manda el equipo donde lo dejaste");
  assert.equal(home.get("beto"), "juegos", "una preferencia de un equipo que ya no es el suyo no cuenta");
  assert.equal(home.has("main"), false, "Claude Bot sigue en su salón");

  const hall = { id: "hall", kind: "hall", title: "Claude Bot", channelId: null };
  const juegos = { id: "c:juegos", kind: "room", title: "Creación de Juegos", channelId: "juegos", members: 2 };
  const full = { id: "c:lleno", kind: "room", title: "Lleno", channelId: "lleno", members: 12 };
  const loose = { id: "loose", kind: "room", title: "Sin grupo", channelId: null };
  const ghost = { id: "new", kind: "new", title: "Nuevo equipo", channelId: null };
  assert.deepEqual(office.dropVerdict("Eli", loose, juegos), { ok: true, text: "Mover a Eli a «Creación de Juegos»" });
  assert.deepEqual(office.dropVerdict("Eli", loose, ghost), { ok: true, text: "Armar un equipo nuevo con Eli" });
  assert.deepEqual(office.dropVerdict("Ana", juegos, loose), { ok: true, text: "Sacar a Ana de «Creación de Juegos»" });
  assert.deepEqual(office.dropVerdict("Ana", juegos, juegos), { ok: false, text: "Ya está en «Creación de Juegos»" });
  assert.deepEqual(office.dropVerdict("Eli", loose, loose), { ok: false, text: "Ya está sin grupo" });
  assert.deepEqual(office.dropVerdict("Eli", loose, hall), { ok: false, text: "Ese es el salón de Claude Bot" });
  assert.deepEqual(office.dropVerdict("Eli", loose, full), { ok: false, text: "«Lleno» ya tiene 12 agentes" });
  assert.equal(office.dropVerdict("Eli", loose, null).ok, false);
});

test("Oficina (interfaz): una plataforma con un solo agente toma su color; un equipo de varios, el del equipo", async () => {
  const office = (await import(new URL("../../public/office.js", import.meta.url).href)) as {
    platformColor: (spec: unknown, agentColor: (id: string) => string | null) => string;
  };
  const colors: Record<string, string> = { ana: "#e5484d", beto: "#4cbb73" };
  const agentColor = (id: string) => colors[id] ?? null;
  const seat = (agentId: string) => ({ agentId, kind: "desk", i: 0, j: 0 });
  const solo = { kind: "room", channelId: null, seats: [seat("ana")] };
  assert.equal(office.platformColor(solo, agentColor), "#e5484d", "«Sin grupo» con un agente rojo: roja");
  const soloTeam = { kind: "room", channelId: "arte", seats: [seat("beto")] };
  assert.equal(office.platformColor(soloTeam, agentColor), "#4cbb73", "un equipo de uno: el color de su agente");
  const team = { kind: "room", channelId: "arte", seats: [seat("ana"), seat("beto")] };
  const teamColor = office.platformColor(team, agentColor);
  assert.ok(teamColor !== "#e5484d" && teamColor !== "#4cbb73", "un equipo de varios: el color del equipo");
  assert.equal(office.platformColor({ ...team, seats: [seat("beto"), seat("ana")] }, agentColor), teamColor, "fijo por canal");
  const loose = { kind: "room", channelId: null, seats: [seat("ana"), seat("beto")] };
  assert.equal(office.platformColor(loose, agentColor), "#b9bfd4", "«Sin grupo» con varios: neutro");
  assert.equal(office.platformColor({ kind: "hall", channelId: null, seats: [seat("main")] }, agentColor), "#8fa8ff", "el salón no cambia");
});
