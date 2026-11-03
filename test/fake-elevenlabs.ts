// Un ElevenLabs de mentira para las pruebas: responde como la API real, sin salir a internet.

export const GOOD_KEY = "sk_bueno0123456789abcdef0123456789abcdef";
/** Clave sin permiso para ver el uso del mes (las voces sí). */
export const NO_USER_KEY = "sk_sinuso0123456789abcdef0123456789abcde";
export const BAD_KEY = "sk_malo00123456789abcdef0123456789abcdef";
export const AUDIO = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]);

export interface FakeCall {
  url: string;
  method: string;
  key: string | null;
  body: unknown;
}

export function fakeElevenLabs() {
  const calls: FakeCall[] = [];
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    const key = headers.get("xi-api-key");
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : null;
    calls.push({ url: url.pathname + url.search, method: init.method ?? "GET", key, body });
    if (init.signal?.aborted) throw new DOMException("cancelado", "AbortError");
    if (key !== GOOD_KEY && key !== NO_USER_KEY) return json(401, { detail: { status: "invalid_api_key", message: "Invalid API key" } });
    if (url.pathname === "/v1/voices") {
      return json(200, {
        voices: [
          { voice_id: "premadeZeta01", name: "Zeta", category: "premade", labels: { gender: "male", accent: "american" }, preview_url: "https://example.com/z.mp3" },
          { voice_id: "premadeAna0001", name: "Ana", category: "premade", labels: { gender: "female", accent: "british" } },
          { voice_id: "miVozClonada01", name: "Mi voz", category: "cloned", labels: { accent: "chilean" }, description: "La mía" },
          { voice_id: "../../malo", name: "Rara", category: "premade" },
          { name: "Sin id" },
        ],
      });
    }
    if (url.pathname === "/v1/user/subscription") {
      if (key === NO_USER_KEY) return json(401, { detail: { status: "missing_permissions", message: "The API key you used is missing the permission user_read" } });
      return json(200, { tier: "free", character_count: 1234, character_limit: 10_000 });
    }
    const tts = /^\/v1\/text-to-speech\/([^/]+)\/stream$/.exec(url.pathname);
    if (tts && init.method === "POST") {
      const voice = tts[1];
      if (voice === "vozBorrada") return json(404, { detail: { status: "voice_not_found", message: "A voice with that ID was not found" } });
      // ElevenLabs avisa «sin caracteres» con un 401: la app no debe tomarlo por sesión vencida.
      if (voice === "sinCaracteres") return json(401, { detail: { status: "quota_exceeded", message: "This request exceeds your quota." } });
      if (voice === "ocupada") return json(429, { detail: { status: "too_many_concurrent_requests", message: "Too many" } });
      if (voice === "rota") return json(500, { detail: "boom" });
      return new Response(AUDIO, { status: 200, headers: { "content-type": "audio/mpeg" } });
    }
    return json(404, { detail: "Not Found" });
  };
  return { fetch, calls };
}
