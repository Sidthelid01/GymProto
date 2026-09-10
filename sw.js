/* Gym Rank service worker.
   Deliberately version-agnostic: it reads the build number out of the page
   itself rather than hard-coding one, so this file never needs replacing.
   Upload it once and forget it.

   Strategy: serve the cached copy instantly, fetch a fresh one in the
   background, and if the build number changed, tell the page so it can
   offer a reload. Fast launch, works offline, still picks up updates. */

const CACHE = "gymrank";
const buildOf = (html) => (html.match(/name="build" content="([^"]+)"/) || [])[1] || "";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Anything off-site (Open Food Facts, for one) goes straight to the network.
  if (url.origin !== self.location.origin) return;

  const isDoc =
    req.mode === "navigate" ||
    url.pathname.endsWith("/") ||
    url.pathname.endsWith("index.html");
  if (!isDoc) return;

  const key = self.registration.scope;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(key);
      const cachedText = cached ? await cached.clone().text() : "";

      const fromNetwork = fetch(req, { cache: "no-store" })
        .then(async (res) => {
          if (!res || !res.ok) return null;
          const text = await res.clone().text();
          await cache.put(
            key,
            new Response(text, { headers: { "Content-Type": "text/html; charset=utf-8" } })
          );
          const next = buildOf(text);
          if (cachedText && next && next !== buildOf(cachedText)) {
            const clients = await self.clients.matchAll({ includeUncontrolled: true });
            clients.forEach((c) => c.postMessage({ type: "update", build: next }));
          }
          return res;
        })
        .catch(() => null);

      if (cached) {
        event.waitUntil(fromNetwork);
        return cached;
      }
      return (await fromNetwork) || new Response("Offline", { status: 503 });
    })()
  );
});
