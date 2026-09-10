/* Gym Rank service worker.

   Version-agnostic on purpose: it reads the build number out of the page
   rather than carrying one, so this file rarely needs replacing.

   Install  — pre-cache the shell immediately, so the very first visit is
              enough to make the app work offline.
   Fetch    — serve from cache, refresh in the background, and tell the page
              when the build number changes so it can offer a reload. */

const CACHE = "gymrank";
const buildOf = (html) => (html.match(/name="build" content="([^"]+)"/) || [])[1] || "";
const SHELL = ["./", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Individually, so one missing icon can't fail the whole install.
      await Promise.all(
        SHELL.map((u) =>
          fetch(new Request(u, { cache: "reload" }))
            .then((r) => (r.ok ? cache.put(u === "./" ? self.registration.scope : u, r) : null))
            .catch(() => null)
        )
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Off-site calls (Open Food Facts, the Anthropic API) always go to the network.
  if (url.origin !== self.location.origin) return;

  const isDoc =
    req.mode === "navigate" ||
    url.pathname.endsWith("/") ||
    url.pathname.endsWith("index.html");

  if (isDoc) {
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
    return;
  }

  // Everything else same-origin: cache first, then fill the cache behind it.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        return new Response("", { status: 504 });
      }
    })()
  );
});
