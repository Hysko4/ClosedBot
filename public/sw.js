// Service worker de ClosedBot: permite instalar la app y abrirla sin red.
// Nunca guarda en caché la API (/api/): los mensajes siempre vienen del servidor.
const CACHE = "closedbot-v26";
const SHELL = ["/", "/index.html", "/app.js", "/office.js", "/styles.css", "/pcm-capture.js", "/manifest.webmanifest", "/icons/icon.svg", "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  // Primero la red (para recibir actualizaciones al instante); la caché solo sin conexión.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((cached) => cached ?? (request.mode === "navigate" ? caches.match("/index.html") : Response.error())),
      ),
  );
});

// Avisos («Avisarme» de cada agente): al tocarlos se abre ClosedBot en esa conversación.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url ?? "/", self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (!open) return self.clients.openWindow(target.href);
      await open.focus();
      open.postMessage({ type: "open", hash: target.hash });
      return undefined;
    }),
  );
});
