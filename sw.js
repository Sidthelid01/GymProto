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

self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      // Drop any config.js cached by an older version of this worker.
      try {
        const cache = await caches.open(CACHE);
        for (const req of await cache.keys()) {
          if (new URL(req.url).pathname.endsWith("config.js")) await cache.delete(req);
        }
      } catch { /* nothing to clear */ }
      await self.clients.claim();
    })()
  )
);

self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Exercise demo images: cache them the first time they're viewed so they
  // still work in a basement gym. Opaque responses cache fine for images.
  if (url.hostname === "raw.githubusercontent.com") {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE + "-img");
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res) cache.put(req, res.clone());
          return res;
        } catch {
          return new Response("", { status: 504 });
        }
      })()
    );
    return;
  }

  // Other off-site calls (Open Food Facts, the Anthropic API) always go to the network.
  if (url.origin !== self.location.origin) return;

  const isDoc =
    req.mode === "navigate" ||
    url.pathname.endsWith("/") ||
    url.pathname.endsWith("index.html");

  if (isDoc) {
    // An explicit query (?v=30) means "give me the real thing" — bypass the
    // cache entirely, so there is always a way to force a fresh copy.
    if (url.search) {
      event.respondWith(
        fetch(req, { cache: "no-store" })
          .then(async (res) => {
            if (res && res.ok) {
              const text = await res.clone().text();
              const cache = await caches.open(CACHE);
              await cache.put(self.registration.scope, new Response(text, {
                headers: { "Content-Type": "text/html; charset=utf-8" },
              }));
            }
            return res;
          })
          .catch(async () => (await caches.open(CACHE)).match(self.registration.scope))
      );
      return;
    }

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

  // config.js must never be served stale — a cached blank copy would leave the
  // app permanently unable to see credentials that have since been filled in.
  if (url.pathname.endsWith("config.js")) {
    event.respondWith(
      fetch(req, { cache: "no-store" }).catch(async () => {
        const cache = await caches.open(CACHE);
        return (await cache.match(req)) || new Response("", {
          status: 200, headers: { "Content-Type": "text/javascript" },
        });
      })
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
